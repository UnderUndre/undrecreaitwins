export type EvalMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ContainsAssertion = {
  type: 'contains';
  value: string;
  case_sensitive?: boolean;
};

export type NotContainsAssertion = {
  type: 'not_contains';
  value: string;
  case_sensitive?: boolean;
};

export type RegexAssertion = {
  type: 'regex';
  pattern: string;
  flags?: string;
};

export type MinLengthAssertion = {
  type: 'min_length';
  value: number;
};

export type MaxLengthAssertion = {
  type: 'max_length';
  value: number;
};

export type SimilarityAssertion = {
  type: 'similarity';
  expected: string;
  threshold: number;
};

export type EvalAssertion =
  | ContainsAssertion
  | NotContainsAssertion
  | RegexAssertion
  | MinLengthAssertion
  | MaxLengthAssertion
  | SimilarityAssertion;

export type EvalCase = {
  name: string;
  personaSlug: string;
  messages: EvalMessage[];
  assertions: EvalAssertion[];
};

export type EvalAssertionResult = {
  type: EvalAssertion['type'] | 'execution';
  passed: boolean;
  message: string;
  score?: number;
  threshold?: number;
};
