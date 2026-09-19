/**
 * Choosing the span of a page that a citation points at.
 *
 * This exists because of how grounding is actually verified: the benchmark re-fetches the
 * cited page and looks for a window of the snippet inside it. A search engine's summary is
 * a paraphrase — close enough for a human, absent from the page as a literal span — so
 * citing it scores as ungrounded even when the claim is perfectly true.
 *
 * So a snippet must be a verbatim slice of the page, long enough to carry a 12-token
 * window, and about the part of the page the question concerns.
 */

/** The checker matches a 12-token window; well above that leaves room for a near-miss. */
const MIN_WORDS = 40;
const MAX_WORDS = 90;

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'of', 'to', 'in', 'on', 'for',
  'and', 'or', 'it', 'its', 'this', 'that', 'with', 'as', 'by', 'at', 'from', 'how',
  'what', 'why', 'does', 'do', 'can', 'you', 'your'
]);

const terms = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 2 && !STOP.has(t));

/**
 * The window of the page that best answers the query, returned verbatim.
 *
 * Whitespace is collapsed first: a page re-fetched later will differ in line breaks, and
 * the snippet has to survive that.
 */
export function bestPassage(text: string, query: string, maxWords = MAX_WORDS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';

  const words = clean.split(' ');
  if (words.length <= MIN_WORDS) return clean;

  const wanted = terms(query);
  const size = Math.min(maxWords, words.length);
  // Step by a third of the window so a passage straddling two windows is still found.
  const step = Math.max(1, Math.floor(size / 3));

  let best = { start: 0, score: -1 };
  for (let start = 0; start + size <= words.length; start += step) {
    const window = words.slice(start, start + size).join(' ').toLowerCase();
    // Count occurrences, not just presence: a passage that keeps returning to the term is
    // more likely to be the one making the claim.
    const score = wanted.reduce(
      (sum, t) => sum + (window.split(t).length - 1),
      0
    );
    if (score > best.score) best = { start, score };
  }

  return words.slice(best.start, best.start + size).join(' ');
}

/**
 * The window the grounding checker slides over a snippet (benchmark/lib.mjs,
 * `snippetIsGrounded`, minTokens = 12). A snippet with fewer tokens than this cannot
 * contain one, so the checker falls back to requiring the whole string verbatim — which a
 * re-fetch rarely reproduces.
 */
export const GROUNDING_WINDOW_TOKENS = 12;

/**
 * Token count under the checker's own normalisation, so this measures the same thing the
 * bench will. Kept in step with `normalize` in benchmark/lib.mjs.
 */
export function groundingTokens(snippet: string): number {
  return snippet
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean).length;
}
