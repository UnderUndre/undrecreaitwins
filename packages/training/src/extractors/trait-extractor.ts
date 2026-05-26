import type { PersonaTraits } from '@undrecreaitwins/shared';
import type { ParsedMessage } from '../parsers/telegram-json.js';

export function extractTraits(
  messages: ParsedMessage[],
  existingTraits?: PersonaTraits,
): PersonaTraits {
  const lockedKeys = new Set(
    (existingTraits?.manual_lock as string[]) || [],
  );

  const texts = messages.map(m => m.content);
  const allText = texts.join(' ');
  const sentences = texts.flatMap(t => t.split(/[.!?]+/).filter(s => s.trim()));
  const words = allText.split(/\s+/).filter(w => w.length > 0);
  const uniqueWords = new Set(words.map(w => w.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '')));

  const sentenceLengths = sentences.map(s => s.trim().split(/\s+/).length);
  const avgSentenceLength = sentenceLengths.length > 0
    ? sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length
    : 0;

  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
  const emojis = allText.match(emojiRegex) || [];
  const emojiDensity = allText.length > 0 ? (emojis.length / allText.length) * 1000 : 0;

  const emojiCounts = new Map<string, number>();
  for (const e of emojis) {
    emojiCounts.set(e, (emojiCounts.get(e) || 0) + 1);
  }
  const emojiTopUsed = [...emojiCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([e]) => e);

  const bigrams = extractNgrams(words, 2);
  const trigrams = extractNgrams(words, 3);
  const allNgrams = [...bigrams, ...trigrams];
  const ngramCounts = new Map<string, number>();
  for (const ng of allNgrams) {
    ngramCounts.set(ng, (ngramCounts.get(ng) || 0) + 1);
  }
  const topPhrases = [...ngramCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([phrase]) => phrase);

  const formalityScore = calculateFormality(texts);

  const timestamps = messages
    .filter(m => m.timestamp && !isNaN(m.timestamp.getTime()))
    .map(m => m.timestamp.getTime());
  const responseLatencyPattern: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const curr = timestamps[i];
    const prev = timestamps[i - 1];
    if (curr !== undefined && prev !== undefined) {
      responseLatencyPattern.push(Math.round((curr - prev) / 1000));
    }
  }

  const result: PersonaTraits = { ...existingTraits };

  if (!lockedKeys.has('avg_sentence_length')) {
    result.avg_sentence_length = Math.round(avgSentenceLength * 100) / 100;
  }
  if (!lockedKeys.has('sentence_length_distribution')) {
    result.sentence_length_distribution = sentenceLengths;
  }
  if (!lockedKeys.has('emoji_density')) {
    result.emoji_density = Math.round(emojiDensity * 100) / 100;
  }
  if (!lockedKeys.has('emoji_top_used')) {
    result.emoji_top_used = emojiTopUsed;
  }
  if (!lockedKeys.has('top_phrases')) {
    result.top_phrases = topPhrases;
  }
  if (!lockedKeys.has('formality_score')) {
    result.formality_score = formalityScore;
  }
  if (!lockedKeys.has('response_latency_pattern')) {
    result.response_latency_pattern = responseLatencyPattern;
  }
  if (!lockedKeys.has('lexicon_size')) {
    result.lexicon_size = uniqueWords.size;
  }

  return result;
}

function extractNgrams(words: string[], n: number): string[] {
  const result: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    result.push(words.slice(i, i + n).join(' ').toLowerCase());
  }
  return result;
}

function calculateFormality(texts: string[]): number {
  const formalIndicators = ['therefore', 'however', 'furthermore', 'consequently', 'regarding', 'accordingly', 'nevertheless'];
  const informalIndicators = ['lol', 'haha', 'omg', 'wtf', 'bruh', 'yep', 'nope', 'nah', 'gonna', 'wanna', 'kinda'];

  const allText = texts.join(' ').toLowerCase();
  let formalCount = 0;
  let informalCount = 0;

  for (const word of formalIndicators) {
    if (allText.includes(word)) formalCount++;
  }
  for (const word of informalIndicators) {
    if (allText.includes(word)) informalCount++;
  }

  const total = formalCount + informalCount;
  if (total === 0) return 0.5;
  return Math.round((formalCount / total) * 100) / 100;
}
