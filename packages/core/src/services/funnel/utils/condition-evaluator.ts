/**
 * Evaluates delivery conditions for a fragment.
 * Conditions are provided as a record of slot names and their expected values.
 * All conditions must match (AND logic).
 */
export function evaluateDeliveryCondition(
  condition: Record<string, any> | null | undefined,
  slots: Record<string, any>
): boolean {
  // No condition means it's always included
  if (!condition || Object.keys(condition).length === 0) {
    return true;
  }

  for (const [slotName, expectedValue] of Object.entries(condition)) {
    const actualValue = slots[slotName];

    // If slot is missing or value doesn't match, condition fails
    if (actualValue !== expectedValue) {
      return false;
    }
  }

  return true;
}
