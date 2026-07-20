// Unit tests for isHardBlocked — word-boundary + Arabic alef normalization.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHardBlocked } from './dimensions.js';

const adv = (name, categories = [], creative_snippets = []) => ({ name, categories, creative_snippets });

// ── Direction 1: genuinely off-ICP names MUST still block ──────────────────
const BLOCK_CASES = [
  ['Baghdad Dental Clinic', adv('Baghdad Dental Clinic')],
  ['Royal Beauty Salon', adv('Royal Beauty Salon')],
  ['spa as a category', adv('Wellness Center', ['spa'])],
  ['pharmacy', adv('Al-Shifa Pharmacy')],
  ['dermatology in creative text', adv('Glow', [], ['best dermatology in town'])],
  ['Arabic clinic عيادة', adv('عيادة الرحمة')],
  ['Arabic hospital مستشفى', adv('مستشفى بغداد التخصصي')],
  // alef normalization: list stores أسنان (U+0623); real spelling اسنان (U+0627) must still block
  ['Arabic teeth plain-alef اسنان', adv('مركز اسنان بغداد')],
];

for (const [label, a] of BLOCK_CASES) {
  test(`BLOCKS: ${label}`, () => {
    assert.equal(isHardBlocked(a, ''), true, `expected "${a.name}" to be hard-blocked`);
  });
}

test('BLOCKS: searchTerm dermatology', () => {
  assert.equal(isHardBlocked(adv('Generic Co'), 'dermatology'), true);
});

// ── Direction 2: legitimate near-misses must NOT block (the substring bug) ──
const PASS_CASES = [
  ['Spaghetti House (spa substring)', adv('Spaghetti House Baghdad', ['restaurant'])],
  ['Spazio Lounge (spa substring)', adv('Spazio Lounge', ['cafe'])],
  ['Salontex brand (salon substring)', adv('Salontex Textiles')],
  ['Beautiful Bites (beauty substring)', adv('Beautiful Bites Restaurant')],
  ['Arabic restaurant', adv('مطعم الذواقة', ['restaurant', 'مطعم'])],
  ['Arabic cafe', adv('كافيه بغداد', ['coffee'])],
  ['jewelry', adv('Baghdad Gold & Jewelry', ['jewelry', 'مجوهرات'])],
  ['factory', adv('Rashi Al-Salam Factory', ['manufacturer'])],
];

for (const [label, a] of PASS_CASES) {
  test(`PASSES: ${label}`, () => {
    assert.equal(isHardBlocked(a, ''), false, `expected "${a.name}" to NOT be hard-blocked`);
  });
}
