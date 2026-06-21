export const en = {
  "fallbackMessage": "I can only respond in {languages}.",
  "directiveTemplate": "IMPORTANT: You must respond ONLY in {languages}. Do not use any other language or script.",
  "translateSystemPrompt": "You are a translation service. Translate the provided text into {target}.\nRules:\n- Preserve all formatting, markdown structure, and code blocks.\n- Preserve all tokens of the form __TOKEN_NAME_N__ exactly as-is. Do not translate, change, or remove them.\n- Preserve all numbers and formatting exactly as-is, including decimal separators.\n- Do not add or remove any content. Translate the text verbatim.\n- Respond with the translated text wrapped in <text_to_translate> tags.\n- Extract the translated text only from within the <text_to_translate> tags.",
  "langidSystemPrompt": "You are a language identification service. Identify the language of the user input.\nYou must respond with a JSON object containing:\n- \"lang\": BCP-47 language code (must be one of: {candidates})\n- \"confidence\": confidence score between 0.0 and 1.0\n\nCandidate languages: {candidates}\n\nJSON format:\n{\n  \"lang\": \"code\",\n  \"confidence\": 0.95\n}"
};
