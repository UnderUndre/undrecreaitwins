import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '../../../..');

describe('Security Audit — Comprehensive', () => {
  describe('RLS: Row Level Security', () => {
    it('RLS SQL file exists and covers all tenant-scoped tables', () => {
      const rlsPath = join(ROOT, 'drizzle/rls/001_enable_rls.sql');
      expect(existsSync(rlsPath)).toBe(true);
      const sql = readFileSync(rlsPath, 'utf-8');

      const tables = [
        'personas',
        'conversations',
        'channel_instances',
        'training_jobs',
        'usage_events',
        'api_tokens',
        'messages',
      ];
      for (const table of tables) {
        expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      }
    });

    it('RLS policies reference app.current_tenant', () => {
      const rlsPath = join(ROOT, 'drizzle/rls/001_enable_rls.sql');
      const sql = readFileSync(rlsPath, 'utf-8');
      const policyCount = (sql.match(/CREATE POLICY/g) || []).length;
      expect(policyCount).toBeGreaterThanOrEqual(7);
      expect(sql).toContain("current_setting('app.current_tenant')");
    });

    it('messages table uses EXISTS join on parent conversation', () => {
      const rlsPath = join(ROOT, 'drizzle/rls/001_enable_rls.sql');
      const sql = readFileSync(rlsPath, 'utf-8');
      expect(sql).toContain('tenant_isolation_messages');
      expect(sql).toContain('conversations.id = messages.conversation_id');
      expect(sql).toContain("conversations.tenant_id = current_setting('app.current_tenant')");
    });
  });

  describe('Tenant context: SET LOCAL pattern', () => {
    it('db.ts uses SET LOCAL not bare SET for tenant context', () => {
      const dbPath = join(ROOT, 'packages/core/src/db.ts');
      const dbCode = readFileSync(dbPath, 'utf-8');
      expect(dbCode).toContain('SET LOCAL app.current_tenant');
      expect(dbCode).not.toMatch(/SET\s+(?!LOCAL)app\.current_tenant/);
    });

    it('SET LOCAL is inside transaction boundary', () => {
      const dbPath = join(ROOT, 'packages/core/src/db.ts');
      const dbCode = readFileSync(dbPath, 'utf-8');
      const txIdx = dbCode.indexOf('db.transaction');
      const setLocalIdx = dbCode.indexOf('SET LOCAL app.current_tenant');
      expect(txIdx).toBeGreaterThan(-1);
      expect(setLocalIdx).toBeGreaterThan(txIdx);
    });
  });

  describe('Repositories: withTenantContext enforcement', () => {
    it('persona-repository uses withTenantContext', () => {
      const code = readFileSync(join(ROOT, 'packages/core/src/services/persona-repository.ts'), 'utf-8');
      expect(code).toContain('withTenantContext');
      expect(code).toContain("import { withTenantContext } from '../db.js'");
    });

    it('channel-repository uses withTenantContext', () => {
      const code = readFileSync(join(ROOT, 'packages/core/src/services/channel-repository.ts'), 'utf-8');
      expect(code).toContain('withTenantContext');
      expect(code).toContain("import { withTenantContext } from '../db.js'");
    });

    it('chat-service uses withTenantContext', () => {
      const code = readFileSync(join(ROOT, 'packages/core/src/services/chat-service.ts'), 'utf-8');
      expect(code).toContain('withTenantContext');
      expect(code).toContain("import { withTenantContext } from '../db.js'");
    });

    it('usage-service uses withTenantContext', () => {
      const code = readFileSync(join(ROOT, 'packages/core/src/services/usage-service.ts'), 'utf-8');
      expect(code).toContain('withTenantContext');
      expect(code).toContain("import { withTenantContext } from '../db.js'");
    });

    it('all service files in services/ import withTenantContext', () => {
      const serviceDir = join(ROOT, 'packages/core/src/services');
      const files = readdirSync(serviceDir).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
      for (const file of files) {
        const code = readFileSync(join(serviceDir, file), 'utf-8');
        if (code.includes('from') && code.includes('db') && !file.includes('channel-transport') && !file.includes('channel-orchestrator')) {
          expect(code).toContain('withTenantContext');
        }
      }
    });
  });

  describe('Auth middleware', () => {
    it('validates token via sha256 hash', () => {
      const authPath = join(ROOT, 'packages/core/src/middleware/auth.ts');
      const code = readFileSync(authPath, 'utf-8');
      expect(code).toContain('createHash');
      expect(code).toContain('sha256');
    });

    it('supports gateway mode that skips auth', () => {
      const authPath = join(ROOT, 'packages/core/src/middleware/auth.ts');
      const code = readFileSync(authPath, 'utf-8');
      expect(code).toContain('TWIN_AUTH_MODE');
      expect(code).toContain('gateway');
    });

    it('checks token revocation', () => {
      const authPath = join(ROOT, 'packages/core/src/middleware/auth.ts');
      const code = readFileSync(authPath, 'utf-8');
      expect(code).toContain('revokedAt');
    });

    it('stores token hash not raw token in database lookup', () => {
      const authPath = join(ROOT, 'packages/core/src/middleware/auth.ts');
      const code = readFileSync(authPath, 'utf-8');
      expect(code).toContain('tokenHash');
      expect(code).not.toMatch(/\.where\(.*token\s*[!=]=/);
    });
  });

  describe('Error responses', () => {
    it('error handler does not leak stack traces in production fallback', () => {
      const errorPath = join(ROOT, 'packages/core/src/middleware/error-handler.ts');
      const code = readFileSync(errorPath, 'utf-8');
      expect(code).toContain('AppError');
      expect(code).toContain('Internal server error');
      expect(code).not.toContain('error.stack');
    });

    it('unhandled errors return generic message, not error.message', () => {
      const errorPath = join(ROOT, 'packages/core/src/middleware/error-handler.ts');
      const code = readFileSync(errorPath, 'utf-8');
      const lastSendMatch = code.lastIndexOf('.send(');
      expect(lastSendMatch).toBeGreaterThan(-1);
      const tail = code.slice(lastSendMatch);
      expect(tail).toContain('Internal server error');
      expect(tail).not.toContain('error.message');
    });

    it('error handler logs full error server-side', () => {
      const errorPath = join(ROOT, 'packages/core/src/middleware/error-handler.ts');
      const code = readFileSync(errorPath, 'utf-8');
      expect(code).toMatch(/request\.log\.error|log\.error/);
    });
  });

  describe('Logging redaction', () => {
    it('Pino redacts sensitive message content', () => {
      const serverPath = join(ROOT, 'packages/api/src/server.ts');
      const code = readFileSync(serverPath, 'utf-8');
      expect(code).toContain('redact');
      expect(code).toContain('req.body.messages[*].content');
    });

    it('Pino redacts bot_token in config', () => {
      const serverPath = join(ROOT, 'packages/api/src/server.ts');
      const code = readFileSync(serverPath, 'utf-8');
      expect(code).toContain('req.body.config.bot_token');
    });

    it('Pino redacts response content', () => {
      const serverPath = join(ROOT, 'packages/api/src/server.ts');
      const code = readFileSync(serverPath, 'utf-8');
      expect(code).toContain('res.body.choices[*].message.content');
    });
  });

  describe('Config column type', () => {
    it('channel_instances.config uses jsonb not text', () => {
      const modelPath = join(ROOT, 'packages/core/src/models/channel-instances.ts');
      const code = readFileSync(modelPath, 'utf-8');
      expect(code).toContain('jsonb');
      expect(code).not.toMatch(/config.*text\(/);
    });
  });

  describe('No hardcoded secrets', () => {
    it('db.ts has no hardcoded password/secret/api_key literals', () => {
      const dbPath = join(ROOT, 'packages/core/src/db.ts');
      const code = readFileSync(dbPath, 'utf-8');
      const patterns = [
        /password\s*=\s*['"][^'"]+['"]/,
        /secret\s*=\s*['"][^'"]+['"]/,
        /api_key\s*=\s*['"][^'"]+['"]/,
      ];
      for (const pattern of patterns) {
        expect(code).not.toMatch(pattern);
      }
    });

    it('auth.ts does not log raw tokens', () => {
      const authPath = join(ROOT, 'packages/core/src/middleware/auth.ts');
      const code = readFileSync(authPath, 'utf-8');
      expect(code).not.toMatch(/log\.\w+.*token\b(?!Hash)/);
      expect(code).not.toMatch(/console\.\w+.*token\b(?!Hash)/);
    });

    it('server.ts does not expose secrets in startup log', () => {
      const serverPath = join(ROOT, 'packages/api/src/server.ts');
      const code = readFileSync(serverPath, 'utf-8');
      expect(code).not.toMatch(/log.*password/i);
      expect(code).not.toMatch(/log.*secret/i);
      expect(code).not.toMatch(/log.*api_key/i);
    });
  });

  describe('Tenant middleware coverage', () => {
    it('tenant middleware is registered in server bootstrap', () => {
      const serverPath = join(ROOT, 'packages/api/src/server.ts');
      const code = readFileSync(serverPath, 'utf-8');
      expect(code).toContain('tenantPlugin');
      expect(code).toMatch(/register\(tenantPlugin\)/);
    });

    it('tenant middleware is registered before route handlers', () => {
      const serverPath = join(ROOT, 'packages/api/src/server.ts');
      const code = readFileSync(serverPath, 'utf-8');
      const tenantIdx = code.indexOf('register(tenantPlugin)');
      const authIdx = code.indexOf('register(authPlugin)');
      expect(tenantIdx).toBeGreaterThan(-1);
      expect(authIdx).toBeGreaterThan(tenantIdx);
    });

    it('tenant middleware validates tenant exists and is active', () => {
      const tenantPath = join(ROOT, 'packages/core/src/middleware/tenant.ts');
      const code = readFileSync(tenantPath, 'utf-8');
      expect(code).toContain('tenants.status');
      expect(code).toContain('active');
    });
  });
});
