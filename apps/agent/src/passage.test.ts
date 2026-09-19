import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestPassage } from './passage.js';

/**
 * A citation's snippet has to be a span the page actually contains, because that is
 * literally what the grounding check verifies: it fetches the page and looks for a window
 * of the snippet in it. A search engine's own summary is a paraphrase and fails that,
 * which is how grounding measured 0.625 rather than the 0.95 target.
 */
const PAGE = [
  'Introduction. This page is about many things and starts with boilerplate navigation.',
  'Atlas Vector Search uses approximate nearest neighbour indexes to trade a little recall for a great deal of speed.',
  'Unrelated closing material about pricing and support contracts follows here at the end.'
].join(' ');

test('the passage comes back verbatim from the page', () => {
  const p = bestPassage(PAGE, 'approximate nearest neighbour');
  assert.ok(PAGE.includes(p), 'a snippet not present in the page cannot be verified');
});

test('it picks the part of the page the question is about', () => {
  const p = bestPassage(PAGE, 'approximate nearest neighbour recall speed');
  assert.match(p, /approximate nearest neighbour/);
});

test('it is long enough for the grounding window', () => {
  // The checker matches on a 12-token window, so a shorter snippet cannot be verified.
  const p = bestPassage(PAGE, 'vector search');
  assert.ok(p.split(/\s+/).length >= 12, `too short to verify: ${p.split(/\s+/).length} words`);
});

test('a page shorter than one window is returned whole', () => {
  const short = 'Vector search is approximate.';
  assert.equal(bestPassage(short, 'vector'), short);
});

test('a query matching nothing still returns real page text', () => {
  const p = bestPassage(PAGE, 'quantum basket weaving');
  assert.ok(p.length > 0);
  assert.ok(PAGE.includes(p));
});

test('empty input does not throw', () => {
  assert.equal(bestPassage('', 'anything'), '');
  assert.ok(bestPassage(PAGE, '').length > 0);
});

test('whitespace is collapsed so the snippet matches a re-fetched page', () => {
  const messy = 'Vector   search\n\nis   approximate and trades recall for speed in every case here.';
  const p = bestPassage(messy, 'vector search approximate');
  assert.equal(p.includes('\n'), false);
  assert.equal(/\s{2,}/.test(p), false);
});
