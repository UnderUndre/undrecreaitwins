import type { PromptTemplate } from '../types.js';
import adaptiveIntro from './adaptive-intro.json' with { type: 'json' };
import slotExtraction from './slot-extraction.json' with { type: 'json' };
import intentClassifier from './intent-classifier.json' with { type: 'json' };
import contextualRetell from './contextual-retell.json' with { type: 'json' };
import bannedWords from './banned-words.json' with { type: 'json' };
import repairPrompts from './repair-prompts.json' with { type: 'json' };
import rewriter from './rewriter.json' with { type: 'json' };
import falsePromise from './false-promise.json' with { type: 'json' };
import patternDetector from './pattern-detector.json' with { type: 'json' };

import languageGuard from './language-guard.json' with { type: 'json' };

const prompts = {
  // ...
  'adaptive-intro': adaptiveIntro as unknown as PromptTemplate,
  'slot-extraction': slotExtraction as unknown as PromptTemplate,
  'intent-classifier': intentClassifier as unknown as PromptTemplate,
  'contextual-retell': contextualRetell as unknown as PromptTemplate,
  'banned-words': bannedWords as unknown as PromptTemplate,
  'repair-prompts': repairPrompts as unknown as PromptTemplate,
  'rewriter': rewriter as unknown as PromptTemplate,
  'false-promise': falsePromise as unknown as PromptTemplate,
  'pattern-detector': patternDetector as unknown as PromptTemplate,
  'language-guard': languageGuard as unknown as PromptTemplate,
};

export default prompts;
