import { Worker, Job } from 'bullmq';
import { db } from '../../db.js';
import { followupAttempts, followupRules, conversations } from '../../models/index.js';
import { eq, and, lte, sql } from 'drizzle-orm';
import { ReengagementScanner } from './scanner.js';
import { ReengagementGenerator } from './generator.js';
import { ReengagementDelivery } from './delivery.js';

const scanner = new ReengagementScanner();
const generator = new ReengagementGenerator();
const delivery = new ReengagementDelivery();

export class ReengagementWorker {
  private scannerWorker: Worker;
  private isProcessingAttempts = false;
  private isSweeping = false;
  
  private claimTimeoutMs = Number(process.env.TWIN_REENGAGE_CLAIM_TIMEOUT_MS) || 300000; // 5 min
  private llmTimeoutMs = Number(process.env.TWIN_REENGAGE_LLM_TIMEOUT_MS) || 30000; // 30 sec
  private workerIntervalMs = 5000;
  private sweepIntervalMs = 60000;

  constructor() {
    const redisOptions = {
      host: 'localhost',
      port: 6379,
      ...(process.env.REDIS_URL ? this.parseRedisUrl(process.env.REDIS_URL) : {})
    };

    // 1. BullMQ Worker for periodic scan
    this.scannerWorker = new Worker(
      'reengagement-scan',
      async (job: Job) => {
        const { tenantId } = job.data;
        console.log(`[ReengagementWorker] Running scan for tenant ${tenantId}`);
        await scanner.runScan(tenantId);
      },
      { connection: redisOptions }
    );

    // 2. Start attempt processing loop
    this.startAttemptLoop();

    // 3. Start stuck-processing sweep loop
    this.startSweepLoop();
  }

  private parseRedisUrl(url: string) {
    try {
      const u = new URL(url);
      return {
        host: u.hostname,
        port: parseInt(u.port, 10) || 6379,
        password: u.password,
      };
    } catch {
      return {};
    }
  }

  private startAttemptLoop() {
    setInterval(async () => {
      if (this.isProcessingAttempts) return;
      this.isProcessingAttempts = true;
      try {
        await this.processScheduledAttempts();
      } finally {
        this.isProcessingAttempts = false;
      }
    }, this.workerIntervalMs);
  }

  private startSweepLoop() {
    setInterval(async () => {
      if (this.isSweeping) return;
      this.isSweeping = true;
      try {
        await this.sweepStuckAttempts();
      } finally {
        this.isSweeping = false;
      }
    }, this.sweepIntervalMs);
  }

  private async processScheduledAttempts() {
    // Atomic scheduled -> processing claim
    // We claim N attempts at a time
    const batchSize = Number(process.env.TWIN_REENGAGE_WORKERS_BATCH) || 10;
    
    const result = await db.execute(sql`
      UPDATE ${followupAttempts}
      SET status = 'processing', claimed_at = NOW(), updated_at = NOW()
      WHERE id IN (
        SELECT id FROM ${followupAttempts}
        WHERE status = 'scheduled'
        AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);

    const attempts = Array.isArray(result) ? result : ((result as Record<string, unknown>).rows || []) as Record<string, unknown>[];

    for (const attempt of attempts) {
      try {
        await this.processAttempt(attempt);
      } catch (err: any) {
        console.error(`[ReengagementWorker] Failed to process attempt ${attempt.id}:`, err);
        await db.update(followupAttempts)
          .set({
            status: 'failed',
            failureReason: err.message,
            updatedAt: new Date()
          })
          .where(eq(followupAttempts.id, attempt.id as string));
      }
    }
  }

  private async processAttempt(attempt: Record<string, unknown>) {
    const [convo] = await db.select().from(conversations).where(eq(conversations.id, attempt.conversation_id as string)).limit(1);
    const [rule] = await db.select().from(followupRules).where(eq(followupRules.id, attempt.rule_id as string)).limit(1);

    if (!convo || !rule || !rule.isActive || convo.optedOut || convo.status === 'closed' || convo.status === 'operator_assigned') {
      await db.update(followupAttempts)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(followupAttempts.id, attempt.id as string));
      return;
    }

    const lastMessageTime = convo.lastMessageAt instanceof Date ? convo.lastMessageAt.getTime() : new Date(convo.lastMessageAt as Date).getTime();
    const scheduledTime = attempt.scheduled_at instanceof Date ? (attempt.scheduled_at as Date).getTime() : new Date(attempt.scheduled_at as string).getTime();

    if (lastMessageTime > scheduledTime) {
      await db.update(followupAttempts)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(followupAttempts.id, attempt.id as string));
      return;
    }

    await generator.generateHook(attempt.tenant_id as string, attempt.conversation_id as string, attempt.rule_id as string, this.llmTimeoutMs);

    await delivery.deliver(attempt.id as string);
  }

  private async sweepStuckAttempts() {
    const staleThreshold = new Date(Date.now() - this.claimTimeoutMs);
    
    const result = await db.update(followupAttempts)
      .set({
        status: 'failed',
        failureReason: 'worker_timeout',
        updatedAt: new Date()
      })
      .where(and(
        eq(followupAttempts.status, 'processing'),
        lte(followupAttempts.claimedAt, staleThreshold)
      ))
      .returning({ id: followupAttempts.id });

    if (result.length > 0) {
      console.log(`[ReengagementWorker] Swept ${result.length} stuck attempts`);
    }
  }

  async close() {
    await this.scannerWorker.close();
  }
}
