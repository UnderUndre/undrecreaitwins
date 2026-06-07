import { describe, it, expect } from 'vitest';
import { parseAcpCommand } from '../../../src/services/hermes/acp-command.js';

describe('parseAcpCommand', () => {
  it('parses bare command with default args', () => {
    const result = parseAcpCommand('hermes');
    expect(result).toEqual({ cmd: 'hermes', args: ['acp', '--accept-hooks'] });
  });

  it('parses command with args', () => {
    const result = parseAcpCommand('hermes acp --accept-hooks');
    expect(result).toEqual({ cmd: 'hermes', args: ['acp', '--accept-hooks'] });
  });

  it('parses absolute path', () => {
    const result = parseAcpCommand('/usr/local/bin/hermes acp --accept-hooks');
    expect(result).toEqual({ cmd: '/usr/local/bin/hermes', args: ['acp', '--accept-hooks'] });
  });

  it('parses wrapper command', () => {
    const result = parseAcpCommand('python -m hermes acp --accept-hooks');
    expect(result).toEqual({ cmd: 'python', args: ['-m', 'hermes', 'acp', '--accept-hooks'] });
  });

  it('returns defaults for empty string', () => {
    const result = parseAcpCommand('');
    expect(result).toEqual({ cmd: 'hermes', args: ['acp', '--accept-hooks'] });
  });

  it('handles double-quoted args', () => {
    const result = parseAcpCommand('"C:\\Program Files\\hermes" acp --accept-hooks');
    expect(result).toEqual({ cmd: 'C:\\Program Files\\hermes', args: ['acp', '--accept-hooks'] });
  });

  it('handles single-quoted args', () => {
    const result = parseAcpCommand("'/opt/hermes bin/hermes' acp --accept-hooks");
    expect(result).toEqual({ cmd: '/opt/hermes bin/hermes', args: ['acp', '--accept-hooks'] });
  });

  it('handles whitespace-only input', () => {
    const result = parseAcpCommand('   ');
    expect(result).toEqual({ cmd: 'hermes', args: ['acp', '--accept-hooks'] });
  });
});
