const ENGLISH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could",
  "do", "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "into",
  "is", "it", "its", "may", "me", "more", "most", "my", "not", "of", "on", "or",
  "our", "please", "should", "so", "some", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "up", "us", "was", "we", "were",
  "what", "when", "where", "which", "who", "will", "with", "would", "you", "your",
]);

const CJK_STOP_WORDS = new Set(["一个", "一些", "以及", "什么", "如何", "我们", "这个", "那个", "可以", "是否", "现在"]);

export type SearchableDocument<T> = {
  item: T;
  key: string;
  title: string;
  text: string;
};

export type RankedSearchDocument<T> = SearchableDocument<T> & {
  score: number;
  excerpt: string;
  matched_terms: string[];
};

type Occurrence = { position: number; term: string };
type Passage = { start: number; end: number; score: number; matchedTerms: string[] };

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function containsHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

/** Tokenize natural-language queries without requiring a language-specific service. */
export function tokenizeSearchQuery(value: string): string[] {
  const normalized = normalize(value);
  const quotedPhrases = [
    ...normalized.matchAll(/["“]([^"”]{2,160})["”]/gu),
    ...normalized.matchAll(/`([^`]{2,160})`/gu),
  ]
    .map(match => (match[1].match(/[\p{L}\p{N}]+/gu) ?? []).join(" ").trim())
    .filter(phrase => phrase.length >= 2 && !ENGLISH_STOP_WORDS.has(phrase) && !CJK_STOP_WORDS.has(phrase));
  const runs = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const output: string[] = [...quotedPhrases];
  for (const run of runs) {
    if (containsHan(run)) {
      const segments = run.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? [];
      for (const segment of segments) {
        if (!containsHan(segment)) {
          if (segment.length >= 2 && !ENGLISH_STOP_WORDS.has(segment)) output.push(segment);
          continue;
        }
        if (segment.length >= 2 && !CJK_STOP_WORDS.has(segment)) output.push(segment);
        for (let index = 0; index + 1 < segment.length; index += 1) {
          const bigram = segment.slice(index, index + 2);
          if (!CJK_STOP_WORDS.has(bigram)) output.push(bigram);
        }
      }
      continue;
    }
    if (run.length >= 2 && !ENGLISH_STOP_WORDS.has(run)) output.push(run);
  }
  return [...new Set(output)].slice(0, 64);
}

function collectOccurrences(text: string, terms: string[], maximumPerTerm = 96): Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (const term of terms) {
    let cursor = 0;
    let count = 0;
    while (cursor < text.length && count < maximumPerTerm) {
      const position = text.indexOf(term, cursor);
      if (position < 0) break;
      occurrences.push({ position, term });
      cursor = position + Math.max(1, term.length);
      count += 1;
    }
  }
  return occurrences.sort((left, right) => left.position - right.position || left.term.localeCompare(right.term));
}

function bestPassage(
  text: string,
  terms: string[],
  weights: Map<string, number>,
  windowChars: number,
): Passage | null {
  const occurrences = collectOccurrences(text, terms);
  if (occurrences.length === 0) return null;
  const counts = new Map<string, number>();
  let left = 0;
  let coverage = 0;
  let repetition = 0;
  let best: Passage | null = null;

  for (let right = 0; right < occurrences.length; right += 1) {
    const current = occurrences[right];
    const weight = weights.get(current.term) ?? 1;
    const previous = counts.get(current.term) ?? 0;
    counts.set(current.term, previous + 1);
    if (previous === 0) coverage += weight;
    if (previous < 3) repetition += weight * 0.08;

    while (current.position - occurrences[left].position > windowChars) {
      const removed = occurrences[left];
      const removedWeight = weights.get(removed.term) ?? 1;
      const before = counts.get(removed.term) ?? 0;
      if (before <= 1) {
        counts.delete(removed.term);
        coverage -= removedWeight;
      } else {
        counts.set(removed.term, before - 1);
      }
      if (before <= 3) repetition -= removedWeight * 0.08;
      left += 1;
    }

    const matchedTerms = [...counts.keys()];
    const densityBonus = 1 + (matchedTerms.length / Math.max(1, terms.length)) * 0.75;
    const compactness = 1 + 0.2 * (1 - Math.min(1, (current.position - occurrences[left].position) / windowChars));
    const score = (coverage + repetition) * densityBonus * compactness;
    if (best === null || score > best.score) {
      best = {
        start: occurrences[left].position,
        end: current.position + current.term.length,
        score,
        matchedTerms,
      };
    }
  }
  return best;
}

function renderExcerpt(text: string, passage: Passage, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const center = Math.floor((passage.start + passage.end) / 2);
  const start = Math.max(0, Math.min(text.length - maxChars, center - Math.floor(maxChars / 2)));
  const end = Math.min(text.length, start + maxChars);
  return `${start > 0 ? "…\n" : ""}${text.slice(start, end)}${end < text.length ? "\n…" : ""}`;
}

/**
 * Rank documents by rare-term coverage inside one local evidence window.
 * This avoids rewarding a long document merely because query words occur far
 * apart, while keeping retrieval deterministic and dependency-free.
 */
export function rankSearchDocuments<T>(
  query: string,
  documents: SearchableDocument<T>[],
  limit: number,
  excerptChars = 400,
): RankedSearchDocument<T>[] {
  const terms = tokenizeSearchQuery(query);
  if (terms.length === 0 || documents.length === 0 || limit <= 0) return [];
  const normalizedDocuments = documents.map(document => ({ ...document, normalizedText: normalize(document.text) }));
  const weights = new Map<string, number>();
  for (const term of terms) {
    const documentFrequency = normalizedDocuments.reduce(
      (total, document) => total + Number(document.normalizedText.includes(term)),
      0,
    );
    const inverseDocumentFrequency = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
    const phraseBoost = term.includes(" ") ? 2.5 : 1;
    const specificity = (1 + Math.min(term.length, 24) / 24) * phraseBoost;
    weights.set(term, inverseDocumentFrequency * specificity);
  }

  const ranked: RankedSearchDocument<T>[] = [];
  for (const document of normalizedDocuments) {
    const passage = bestPassage(document.normalizedText, terms, weights, 2_800);
    if (passage === null) continue;
    ranked.push({
      item: document.item,
      key: document.key,
      title: document.title,
      text: document.text,
      score: Number(passage.score.toFixed(6)),
      excerpt: renderExcerpt(document.text, passage, excerptChars),
      matched_terms: passage.matchedTerms,
    });
  }
  return ranked
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title) || left.key.localeCompare(right.key))
    .slice(0, limit);
}

/** Select a query-centred excerpt after a graph node has been chosen. */
export function excerptAroundSearchQuery(text: string, query: string | undefined, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const terms = tokenizeSearchQuery(query ?? "");
  if (terms.length === 0) return { text: `${text.slice(0, maxChars)}\n…`, truncated: true };
  const weights = new Map(terms.map(term => [
    term,
    (1 + Math.min(term.length, 24) / 12) * (term.includes(" ") ? 4 : 1),
  ]));
  const passage = bestPassage(normalize(text), terms, weights, Math.min(4_000, Math.max(800, maxChars)));
  if (passage === null) return { text: `${text.slice(0, maxChars)}\n…`, truncated: true };
  return { text: renderExcerpt(text, passage, maxChars), truncated: true };
}
