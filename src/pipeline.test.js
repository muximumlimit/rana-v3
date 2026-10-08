// Nightly term rotation — 4 reserved factory slots (Yousif 2026-09-29).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tonightsTerms, rotateTerms } from './pipeline.js';

const targets = JSON.parse(readFileSync(new URL('../config/targets.json', import.meta.url), 'utf8'));

// Continuous day numbers around today (2026-09-29 ≈ epoch day 20725), across a month end.
const TODAY = 20725;

test('INTENT: every night runs exactly 1 solo factory term + 8 others, 9 total, no duplicates (msg-125)', () => {
  for (let day = TODAY; day < TODAY + 62; day++) {
    const t = tonightsTerms(targets, 9, day);
    assert.equal(t.length, 9, `day ${day}`);
    assert.equal(new Set(t).size, 9, `day ${day}: duplicate term`);
    assert.equal(t.filter(x => targets.factory_terms.includes(x)).length, 1, `day ${day}: factory slots`);
  }
});

test('every factory term runs within ANY 2 consecutive nights — month ends included', () => {
  for (let day = TODAY; day < TODAY + 62; day++) {
    const two = new Set([...tonightsTerms(targets, 15, day), ...tonightsTerms(targets, 15, day + 1)]);
    for (const f of targets.factory_terms) assert.ok(two.has(f), `day ${day}-${day + 1}: ${f} missing`);
  }
});

test('the other 33 terms still all get covered (every 5 nights at 8/night), none dropped', () => {
  for (let from = TODAY; from < TODAY + 31; from++) {
    const seen = new Set();
    for (let day = from; day < from + 5; day++) tonightsTerms(targets, 9, day).forEach(t => seen.add(t));
    for (const s of targets.search_terms) assert.ok(seen.has(s), `${s} never ran in 3 nights from ${from}`);
  }
});

test('the factory list and the general list do not overlap (no term runs twice a night)', () => {
  assert.equal(targets.factory_terms.filter(f => targets.search_terms.includes(f)).length, 0);
  assert.equal(targets.factory_terms.length, 2);   // msg-125: only the 2 solo terms; the thin 4 rotate as general terms
});

test('no factory config → behaves exactly like the old single window', () => {
  const plain = { search_terms: targets.search_terms };
  assert.deepEqual(tonightsTerms(plain, 15, 7), rotateTerms(targets.search_terms, 15, 7));
});
