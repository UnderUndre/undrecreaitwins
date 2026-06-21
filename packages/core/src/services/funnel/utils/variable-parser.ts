export interface VariableResolutionSource {
  slots?: Record<string, any>;
  context?: Record<string, any>;
  ragMetadata?: Record<string, any>;
}

export interface VariableParserResult {
  text: string;
  unresolved: string[];
}

/**
 * Parses {{variable}} placeholders in text and replaces them with values from provided sources.
 * Resolution order: slots -> context -> ragMetadata -> fallback ([уточнить])
 */
export function parseVariables(
  text: string,
  sources: VariableResolutionSource
): VariableParserResult {
  const unresolved: string[] = [];
  const regex = /\{\{(\w+)\}\}/g;

  const resultText = text.replace(regex, (_match, varName) => {
    const value = 
      sources.slots?.[varName] ?? 
      sources.context?.[varName] ?? 
      sources.ragMetadata?.[varName];

    if (value === undefined || value === null || value === '') {
      unresolved.push(varName);
      return '[уточнить]';
    }

    return String(value);
  });

  return {
    text: resultText,
    unresolved: Array.from(new Set(unresolved))
  };
}
