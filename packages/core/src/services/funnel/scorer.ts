import natural from 'natural';
import type { FunnelFragment, FunnelConfig } from '@undrecreaitwins/shared';

export interface ScoredFragment {
  fragment: FunnelFragment;
  score: number;
  signals: {
    exact_match: number;
    stemmed_match: number;
    synonym_match: number;
    stage_boost: number;
    next_stage_bonus: number;
    objection_boost: number;
  };
}

export class FragmentScorer {
  private stemmer = natural.PorterStemmerRu;
  private tokenizer = new natural.WordTokenizer();

  constructor(private config: FunnelConfig) {}

  public score(
    message: string,
    fragments: FunnelFragment[],
    context: {
      currentStageId?: string;
      nextStageId?: string;
      isObjectionDetected?: boolean;
    }
  ): ScoredFragment[] {
    const normalizedMessage = message.toLowerCase().trim();
    const messageTokens = this.tokenizer.tokenize(normalizedMessage) || [];
    const stemmedMessageTokens = messageTokens.map((t) => this.stemmer.stem(t));

    const weights = this.config.scoring_weights;

    return fragments.map((fragment) => {
      const signals = {
        exact_match: 0,
        stemmed_match: 0,
        synonym_match: 0,
        stage_boost: 0,
        next_stage_bonus: 0,
        objection_boost: 0,
      };

      const triggers = fragment.triggers;

      // 1. Exact Match
      if (triggers.phrases) {
        for (const phrase of triggers.phrases) {
          const phraseLower = phrase.toLowerCase().trim();
          // Use lookbehind and lookahead for non-word characters to simulate \b for Cyrillic
          // But since JS regex lookbehind is not universally supported in older envs,
          // we use a simpler approach: check if it's at start/end or surrounded by non-alphanumeric
          const pattern = `(^|[^а-яёa-z0-9])${phraseLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^а-яёa-z0-9]|$)`;
          const regex = new RegExp(pattern, 'i');
          if (regex.test(normalizedMessage)) {
            signals.exact_match = Math.max(signals.exact_match, weights.exact_match);
          }
        }
      }

      // 2. Stemmed Match
      if (triggers.phrases) {
        for (const phrase of triggers.phrases) {
          const phraseTokens = this.tokenizer.tokenize(phrase.toLowerCase()) || [];
          const stemmedPhraseTokens = phraseTokens.map((t) => this.stemmer.stem(t));
          
          if (this.containsAllTokens(stemmedMessageTokens, stemmedPhraseTokens)) {
            signals.stemmed_match = Math.max(signals.stemmed_match, weights.stemmed_match);
          }
        }
      }

      // 3. Synonym Match
      if (triggers.synonyms) {
        for (const [canonical, group] of Object.entries(triggers.synonyms)) {
          const canonicalStem = this.stemmer.stem(canonical.toLowerCase());
          const groupStems = group.map(s => this.stemmer.stem(s.toLowerCase()));
          const allStems = [canonicalStem, ...groupStems];

          if (allStems.some(s => stemmedMessageTokens.includes(s))) {
            signals.synonym_match = Math.max(signals.synonym_match, weights.synonym_match);
          }
        }
      }

      // 4. Stage Boost
      if (context.currentStageId && fragment.stageId === context.currentStageId) {
        signals.stage_boost = weights.stage_boost;
      }

      // 5. Next Stage Bonus
      if (context.nextStageId && fragment.stageId === context.nextStageId) {
        signals.next_stage_bonus = weights.next_stage_bonus;
      }

      // 6. Objection Boost
      if (context.isObjectionDetected && fragment.type === 'objection') {
        signals.objection_boost = weights.objection_boost;
      }

      const matchScore = Math.max(signals.exact_match, signals.stemmed_match, signals.synonym_match);
      const baseScore = matchScore + signals.stage_boost + signals.next_stage_bonus + signals.objection_boost;
      
      const finalScore = baseScore * (fragment.scoreWeight || 1.0);

      return {
        fragment,
        score: finalScore,
        signals,
      };
    });
  }

  private containsAllTokens(messageTokens: string[], phraseTokens: string[]): boolean {
    if (phraseTokens.length === 0) return false;
    return phraseTokens.every((pt) => messageTokens.some(mt => mt === pt));
  }
}
