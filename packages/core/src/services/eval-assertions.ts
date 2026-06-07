import { ValidationError } from '@undrecreaitwins/shared';
import type { EvalAssertion, EvalAssertionResult } from './eval-types.js';

function maybeLower(value: string, caseSensitive?: boolean): string {
  return caseSensitive ? value : value.toLowerCase();
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function tokenVector(value: string): Map<string, number> {
  const vector = new Map<string, number>();
  for (const token of tokenize(value)) {
    vector.set(token, (vector.get(token) ?? 0) + 1);
  }
  return vector;
}

function cosineSimilarity(left: string, right: string): number {
  const leftVector = tokenVector(left);
  const rightVector = tokenVector(right);
  if (leftVector.size === 0 || rightVector.size === 0) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (const [token, count] of leftVector.entries()) {
    dot += count * (rightVector.get(token) ?? 0);
    leftMagnitude += count * count;
  }
  for (const count of rightVector.values()) {
    rightMagnitude += count * count;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function evaluateAssertions(response: string, assertions: EvalAssertion[]): EvalAssertionResult[] {
  return assertions.map((assertion) => {
    switch (assertion.type) {
      case 'contains': {
        const haystack = maybeLower(response, assertion.case_sensitive);
        const needle = maybeLower(assertion.value, assertion.case_sensitive);
        const passed = haystack.includes(needle);
        return {
          type: assertion.type,
          passed,
          message: passed
            ? `Response contains "${assertion.value}"`
            : `Expected response to contain "${assertion.value}"`,
        };
      }
      case 'not_contains': {
        const haystack = maybeLower(response, assertion.case_sensitive);
        const needle = maybeLower(assertion.value, assertion.case_sensitive);
        const passed = !haystack.includes(needle);
        return {
          type: assertion.type,
          passed,
          message: passed
            ? `Response does not contain "${assertion.value}"`
            : `Expected response not to contain "${assertion.value}"`,
        };
      }
      case 'regex': {
        let regex: RegExp;
        try {
          regex = new RegExp(assertion.pattern, assertion.flags);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid regex';
          throw new ValidationError([{ field: 'assertions.regex', message }]);
        }
        const passed = regex.test(response);
        return {
          type: assertion.type,
          passed,
          message: passed
            ? `Response matches /${assertion.pattern}/${assertion.flags ?? ''}`
            : `Expected response to match /${assertion.pattern}/${assertion.flags ?? ''}`,
        };
      }
      case 'min_length': {
        const passed = response.length >= assertion.value;
        return {
          type: assertion.type,
          passed,
          message: passed
            ? `Response length ${response.length} is at least ${assertion.value}`
            : `Expected response length ${response.length} to be at least ${assertion.value}`,
        };
      }
      case 'max_length': {
        const passed = response.length <= assertion.value;
        return {
          type: assertion.type,
          passed,
          message: passed
            ? `Response length ${response.length} is at most ${assertion.value}`
            : `Expected response length ${response.length} to be at most ${assertion.value}`,
        };
      }
      case 'similarity': {
        const score = cosineSimilarity(response, assertion.expected);
        const passed = score >= assertion.threshold;
        return {
          type: assertion.type,
          passed,
          message: passed
            ? `Similarity score ${score.toFixed(3)} meets threshold ${assertion.threshold}`
            : `Expected similarity score ${score.toFixed(3)} to meet threshold ${assertion.threshold}`,
          score,
          threshold: assertion.threshold,
        };
      }
    }
  });
}
