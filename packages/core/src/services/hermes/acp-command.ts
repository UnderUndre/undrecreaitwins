export interface AcpCommandResult {
  cmd: string;
  args: string[];
}

export function parseAcpCommand(raw: string): AcpCommandResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { cmd: 'hermes', args: ['acp', '--accept-hooks'] };
  }

  const parts = shellSplit(trimmed);
  if (parts.length === 0) {
    return { cmd: 'hermes', args: ['acp', '--accept-hooks'] };
  }
  return {
    cmd: parts[0]!,
    args: parts.length > 1 ? parts.slice(1) : ['acp', '--accept-hooks'],
  };
}

function shellSplit(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
    } else if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < input.length) {
        const next = input[i + 1];
        if (next !== undefined) current += next;
        i++;
      } else {
        current += ch;
      }
    } else {
      if (ch === "'") {
        inSingle = true;
      } else if (ch === '"') {
        inDouble = true;
      } else if (/\s/.test(ch)) {
        if (current) {
          result.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }

    i++;
  }

  if (current) {
    result.push(current);
  }

  return result;
}
