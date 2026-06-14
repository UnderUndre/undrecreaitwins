export function wrapOperatorText(text: string, maxLength = 2000): string {
  const truncated = text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
  const escaped = truncated.replace(/<\/?operator_instructions>/gi, '');
  return `<operator_instructions>\n${escaped}\n</operator_instructions>`;
}
