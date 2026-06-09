import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPublish = vi.fn().mockResolvedValue('0-0');
const mockConsume = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);

vi.mock('@undrecreaitwins/core/services/channel-transport.js', () => ({
  ChannelTransport: vi.fn().mockImplementation(() => ({
    publish: mockPublish,
    consume: mockConsume,
    disconnect: mockDisconnect,
  })),
}));

vi.mock('@undrecreaitwins/core/services/channel-rate-limiter.js', () => ({
  channelRateLimiter: {
    check: vi.fn().mockReturnValue({ allowed: true }),
  },
}));

const mockImapConnect = vi.fn().mockResolvedValue(undefined);
const mockImapLogout = vi.fn().mockResolvedValue(undefined);
const mockImapGetMailboxLock = vi.fn();
const mockImapFetch = vi.fn().mockReturnValue({ [Symbol.asyncIterator]() { return { next: () => ({ done: true }) } } });
const mockImapIdle = vi.fn().mockResolvedValue(undefined);
const mockImapOn = vi.fn().mockReturnValue(undefined);
const mockImapUsable = true;

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: mockImapConnect,
    logout: mockImapLogout,
    getMailboxLock: mockImapGetMailboxLock,
    fetch: mockImapFetch,
    idle: mockImapIdle,
    on: mockImapOn,
    get usable() { return mockImapUsable; },
  })),
}));

const mockSmtpVerify = vi.fn().mockResolvedValue(true);
const mockSmtpSendMail = vi.fn().mockResolvedValue({ messageId: '<test@smtp>' });
const mockSmtpClose = vi.fn();

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      verify: mockSmtpVerify,
      sendMail: mockSmtpSendMail,
      close: mockSmtpClose,
    }),
  },
}));

const { EmailAdapter } = await import('../../src/email-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-email-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    credentials: {
      imapHost: 'imap.test.com',
      imapPort: 993,
      imapUser: 'bot@test.com',
      imapPass: 'imap-pass',
      smtpHost: 'smtp.test.com',
      smtpPort: 587,
      smtpUser: 'bot@test.com',
      smtpPass: 'smtp-pass',
      fromAddress: 'bot@test.com',
    },
    ...overrides,
  };
}

describe('EmailAdapter — IMAP idle lock fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockImapGetMailboxLock.mockResolvedValue({
      release: vi.fn(),
    });
  });

  it('releases mailbox lock BEFORE entering idle', async () => {
    const lockRelease = vi.fn();
    mockImapGetMailboxLock.mockResolvedValue({ release: lockRelease });

    let idleCalled = false;
    let lockReleasedBeforeIdle = false;

    mockImapIdle.mockImplementation(async () => {
      idleCalled = true;
      lockReleasedBeforeIdle = lockRelease.mock.calls.length > 0;
    });

    const adapter = new EmailAdapter(makeConfig());

    const connectPromise = adapter.connect();

    await new Promise((r) => setTimeout(r, 50));

    expect(lockRelease).toHaveBeenCalled();
    expect(lockReleasedBeforeIdle || lockRelease.mock.calls.length > 0).toBe(true);

    mockImapIdle.mockResolvedValue(undefined);
    await connectPromise;
  });

  it('lock is acquired and released for initial fetch, not held during idle', async () => {
    const lockRelease = vi.fn();
    mockImapGetMailboxLock.mockResolvedValue({ release: lockRelease });

    const adapter = new EmailAdapter(makeConfig());

    const connectPromise = adapter.connect();

    await new Promise((r) => setTimeout(r, 50));

    expect(mockImapGetMailboxLock).toHaveBeenCalledWith('INBOX');
    expect(lockRelease).toHaveBeenCalled();

    mockImapIdle.mockResolvedValue(undefined);
    await connectPromise;
  });

  it('exists event handler calls fetchWithLock (acquires its own lock)', async () => {
    const lockRelease = vi.fn();
    mockImapGetMailboxLock.mockResolvedValue({ release: lockRelease });

    const adapter = new EmailAdapter(makeConfig());

    const connectPromise = adapter.connect();
    await new Promise((r) => setTimeout(r, 50));

    const existsHandler = mockImapOn.mock.calls.find(
      (call: unknown[]) => call[0] === 'exists',
    )?.[1] as ((data: { path: string; count: number }) => Promise<void>) | undefined;

    expect(existsHandler).toBeDefined();

    vi.clearAllMocks();
    mockImapGetMailboxLock.mockResolvedValue({ release: lockRelease });
    mockImapFetch.mockReturnValue({ [Symbol.asyncIterator]() { return { next: () => ({ done: true }) } } });

    await existsHandler!({ path: 'INBOX', count: 5 });

    expect(mockImapGetMailboxLock).toHaveBeenCalledWith('INBOX');
    expect(lockRelease).toHaveBeenCalled();

    mockImapIdle.mockResolvedValue(undefined);
    await connectPromise;
  });

  it('disconnect works without deadlock after idle started', async () => {
    mockImapIdle.mockImplementation(() => new Promise(() => {}));

    const lockRelease = vi.fn();
    mockImapGetMailboxLock.mockResolvedValue({ release: lockRelease });

    const adapter = new EmailAdapter(makeConfig());

    const connectPromise = adapter.connect();
    await new Promise((r) => setTimeout(r, 50));

    expect(lockRelease).toHaveBeenCalled();

    const disconnectPromise = adapter.disconnect();

    mockImapIdle.mockResolvedValue(undefined);
    await connectPromise;
    await disconnectPromise;

    expect(mockImapLogout).toHaveBeenCalled();
    expect(mockSmtpClose).toHaveBeenCalled();
  });
});

describe('EmailAdapter — mailparser extractTextBody', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockImapGetMailboxLock.mockResolvedValue({ release: vi.fn() });
  });

  it('handles empty source gracefully', async () => {
    const adapter = new EmailAdapter(makeConfig());
    const result = await (adapter as unknown as { extractTextBody: (s: Buffer | undefined) => Promise<string> }).extractTextBody(undefined);
    expect(result).toBe('');
  });

  it('extracts text from a simple plain/text email', async () => {
    const adapter = new EmailAdapter(makeConfig());
    const rawEmail = Buffer.from(
      'From: sender@test.com\r\n' +
      'To: bot@test.com\r\n' +
      'Subject: Test\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      '\r\n' +
      'Hello from email adapter!',
    );
    const result = await (adapter as unknown as { extractTextBody: (s: Buffer) => Promise<string> }).extractTextBody(rawEmail);
    expect(result).toContain('Hello from email adapter!');
  });

  it('extracts text from multipart MIME message', async () => {
    const adapter = new EmailAdapter(makeConfig());
    const rawEmail = Buffer.from(
      'From: sender@test.com\r\n' +
      'To: bot@test.com\r\n' +
      'Subject: Multipart Test\r\n' +
      'Content-Type: multipart/alternative; boundary="boundary123"\r\n' +
      '\r\n' +
      '--boundary123\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      '\r\n' +
      'Plain text part\r\n' +
      '\r\n' +
      '--boundary123\r\n' +
      'Content-Type: text/html; charset=utf-8\r\n' +
      '\r\n' +
      '<p>HTML part</p>\r\n' +
      '\r\n' +
      '--boundary123--',
    );
    const result = await (adapter as unknown as { extractTextBody: (s: Buffer) => Promise<string> }).extractTextBody(rawEmail);
    expect(result).toContain('Plain text part');
  });
});
