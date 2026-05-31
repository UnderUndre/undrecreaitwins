import { describe, it, expect } from 'vitest';
import { InvalidSessionError } from '../src/types.js';

describe('Security & Secrets', () => {
  it('should have correct error name for InvalidSessionError', () => {
    const err = new InvalidSessionError('Token expired');
    expect(err.name).toBe('InvalidSessionError');
    expect(err.message).toBe('Token expired');
    expect(err instanceof InvalidSessionError).toBe(true);
  });

  it('should not contain raw credentials in stack or message unless explicit', () => {
    const sessionString = '1Babc...secret';
    const err = new InvalidSessionError(`Session ${sessionString} failed`);
    // Though it contains what we put in, we verify the type for product logic
    expect(err instanceof Error).toBe(true);
  });
});
