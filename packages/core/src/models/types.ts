import { customType } from 'drizzle-orm/pg-core';

/**
 * Custom pgvector type for Drizzle.
 * Dimensions = 1024 (BGE-M3 standard).
 */
export const vector = customType<{ data: number[] }>({
  dataType() {
    return 'vector(1024)';
  },
  toDriver(value: number[]) {
    return JSON.stringify(value);
  },
  fromDriver(value: unknown) {
    if (typeof value === 'string') {
      return JSON.parse(value) as number[];
    }
    return value as number[];
  },
});
