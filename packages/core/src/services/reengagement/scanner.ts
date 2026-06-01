import { db } from '../../db.js';
import { conversations, followupRules, followupAttempts } from '../../models/index.js';
import { eq, and, lte, gte, or, notInArray, isNull, sql, desc } from 'drizzle-orm';
import { FollowupRule } from '@undrecreaitwins/shared';

export class ReengagementScanner {
  private batchSize = 1000;

  async runScan(tenantId: string): Promise<void> {
    const activeRules = await db.query.followupRules.findMany({
      where: and(
        eq(followupRules.tenantId, tenantId),
        eq(followupRules.isActive, true)
      )
    });

    if (activeRules.length === 0) return;

    const scheduledConversationIds = new Set<string>();

    for (const rule of activeRules) {
      await this.scanForRule(rule as unknown as FollowupRule, scheduledConversationIds);
    }
  }

  private async scanForRule(rule: FollowupRule, scheduledConversationIds: Set<string>): Promise<void> {
    const staleThreshold = new Date(Date.now() - rule.triggerStaleMinutes * 60 * 1000);
    const minIntervalThreshold = new Date(Date.now() - rule.minIntervalMinutes * 60 * 1000);

    const conditionsClause = this.evaluateConditions(rule.conditions);

    const candidates = await db
      .select({
        id: conversations.id,
        reengagementCount: conversations.reengagementCount,
        lastReengagementAt: conversations.lastReengagementAt,
      })
      .from(conversations)
      .where(and(
        eq(conversations.tenantId, rule.tenantId),
        eq(conversations.needsReengagement, true),
        eq(conversations.optedOut, false),
        notInArray(conversations.status, ['closed', 'operator_assigned']),
        lte(conversations.lastMessageAt, staleThreshold),
        or(
          isNull(conversations.lastReengagementAt),
          lte(conversations.lastReengagementAt, minIntervalThreshold)
        ),
        conditionsClause,
        // FR-012: No open attempts for this rule
        sql`NOT EXISTS (
          SELECT 1 FROM ${followupAttempts} 
          WHERE ${followupAttempts.conversationId} = ${conversations.id} 
          AND ${followupAttempts.ruleId} = ${rule.id}
          AND ${followupAttempts.status} IN ('scheduled', 'processing')
        )`
      ))
      .limit(this.batchSize);

    for (const candidate of candidates) {
      if (scheduledConversationIds.has(candidate.id)) {
        continue;
      }

      if (candidate.reengagementCount >= rule.maxAttempts) {
        continue;
      }

      const backoffMinutes = this.getBackoffMinutes(rule.backoff, candidate.reengagementCount);
      const nextAllowedTime = candidate.lastReengagementAt 
        ? new Date(candidate.lastReengagementAt.getTime() + backoffMinutes * 60 * 1000)
        : new Date(0);

      if (Date.now() < nextAllowedTime.getTime()) {
        continue;
      }

      // Schedule attempt
      const cycleIndex = candidate.reengagementCount;
      const idempotencyKey = `${candidate.id}:${rule.id}:${cycleIndex}`;

      await db.insert(followupAttempts)
        .values({
          conversationId: candidate.id,
          ruleId: rule.id,
          tenantId: rule.tenantId,
          status: 'scheduled',
          scheduledAt: new Date(),
          idempotencyKey
        })
        .onConflictDoNothing();

      scheduledConversationIds.add(candidate.id);
    }
  }

  private evaluateConditions(conditions: Record<string, any>) {
    const expressions = [];

    if (conditions.source) {
      if (typeof conditions.source === 'string') {
        expressions.push(eq(conversations.source, conditions.source));
      } else if (conditions.source.eq) {
        expressions.push(eq(conversations.source, conditions.source.eq));
      } else if (Array.isArray(conditions.source.in)) {
        expressions.push(sql`${conversations.source} IN (${sql.join(conditions.source.in)})`);
      }
    }

    if (conditions.tags && conditions.tags.contains) {
      const tag = conditions.tags.contains;
      expressions.push(sql`${conversations.tags} @> ARRAY[${tag}]::text[]`);
    }

    return expressions.length > 0 ? and(...expressions) : sql`TRUE`;
  }

  private getBackoffMinutes(backoff: number[], count: number): number {
    if (backoff.length === 0) return 0;
    const index = Math.min(count, backoff.length - 1);
    return backoff[index];
  }
}
