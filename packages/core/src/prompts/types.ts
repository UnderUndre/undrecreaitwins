export interface PromptTemplate {
  system: string;
  userTemplate?: string;
  variables?: string[];
}

export type PromptKey =
  | 'adaptive-intro'
  | 'slot-extraction'
  | 'intent-classifier'
  | 'contextual-retell'
  | 'banned-words'
  | 'repair-prompts';

export type Locale = 'ru' | 'en';
