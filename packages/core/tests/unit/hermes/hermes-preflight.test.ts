import { describe, it, expect } from 'vitest';
import { parseProtocolVersion } from '../../../src/services/hermes/hermes-preflight.js';

describe('parseProtocolVersion', () => {
  it('extracts version from JSON with protocolVersion field', () => {
    expect(parseProtocolVersion('{"protocolVersion":1,"status":"ok"}')).toBe(1);
  });

  it('extracts version from key=value text', () => {
    expect(parseProtocolVersion('protocolVersion: 1')).toBe(1);
  });

  it('returns null for non-parseable output', () => {
    expect(parseProtocolVersion('OK')).toBeNull();
    expect(parseProtocolVersion('')).toBeNull();
  });
});
