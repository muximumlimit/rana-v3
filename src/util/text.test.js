// msg-116 #1: 7 new leads over 4 nights (10-01..10-04) failed to insert with
// "invalid input syntax for type json". Every one had an emoji straddling UTF-16 unit
// 100 of its first ad body (🕋 🎓 🛑 🚛 📸 📍); body.slice(0, 100) kept only the high
// surrogate, JSON.stringify wrote it as a bare \ud83d…, and PostgREST hands the request
// body to Postgres as json — which rejects an unpaired surrogate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateText, stripLoneSurrogates, hasLoneSurrogate } from './text.js';

// The 6 advertisers' cut points, as the bodies read around unit 100 (verbatim chars).
const CUTS = ['ة\n🕋 1', 'ل 🎓', 'ط 🛑\n ', 'ق 🚛🚛', 'ن\n📸 #', '\n\n📍 ا'];
const atCut = (around) => {
  const emoji = [...around].find(c => c.codePointAt(0) > 0xffff);
  const i = around.indexOf(emoji);
  return 'ا'.repeat(100 - 1 - i) + around; // places the emoji's HIGH surrogate at unit 99
};

test('INTENT: the old slice produced a lone surrogate on every one of the 6 real cut points', () => {
  for (const c of CUTS) assert.ok(hasLoneSurrogate(atCut(c).slice(0, 100)), JSON.stringify(c));
});

test('INTENT: truncateText never leaves half an emoji — same 6 cut points', () => {
  for (const c of CUTS) {
    const t = truncateText(atCut(c), 100);
    assert.equal(hasLoneSurrogate(t), false, JSON.stringify(c));
    assert.ok(t.length <= 100);
  }
});

test('truncateText keeps whole emoji when they fit, and leaves short text alone', () => {
  assert.equal(truncateText('abc', 100), 'abc');
  assert.equal(truncateText('ab🕋', 4), 'ab🕋');
  assert.equal(truncateText('ab🕋', 3), 'ab');
  assert.equal(truncateText(null, 10), '');
});

test('stripLoneSurrogates drops only unpaired halves', () => {
  assert.equal(stripLoneSurrogates('a\ud83db'), 'ab');
  assert.equal(stripLoneSurrogates('a\udd4bb'), 'ab');
  assert.equal(stripLoneSurrogates('a🕋b'), 'a🕋b');
});
