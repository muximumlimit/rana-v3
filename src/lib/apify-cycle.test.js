import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleBounds, nightsLeftInCycle, budgetCheck, readApifyCycle } from './apify-cycle.js';

const at = (s) => new Date(s);
const iso = (d) => d.toISOString();

test('cycle bounds: Apify bills this account 18th → 17th', () => {
  const c = cycleBounds(at('2026-10-08T02:00:00Z'));
  assert.equal(iso(c.start), '2026-09-18T00:00:00.000Z');
  assert.equal(iso(c.end), '2026-10-17T23:59:59.999Z');
  const n = cycleBounds(at('2026-10-18T02:00:00Z'));
  assert.equal(iso(n.start), '2026-10-18T00:00:00.000Z');
  assert.equal(iso(n.end), '2026-11-17T23:59:59.999Z');
  assert.equal(iso(cycleBounds(at('2026-10-17T23:00:00Z')).start), '2026-09-18T00:00:00.000Z', 'the 17th is the LAST day of a cycle');
  const jan = cycleBounds(at('2027-01-05T02:00:00Z'));
  assert.equal(iso(jan.start), '2026-12-18T00:00:00.000Z', 'wraps the year');
  assert.equal(iso(jan.end), '2027-01-17T23:59:59.999Z');
});

test('nights left in the cycle, tonight included', () => {
  const end = cycleBounds(at('2026-10-09T02:00:00Z')).end;
  assert.equal(nightsLeftInCycle(at('2026-10-09T02:00:00Z'), end), 9, '10-09..10-17');
  assert.equal(nightsLeftInCycle(at('2026-10-17T02:00:00Z'), end), 1);
  assert.equal(nightsLeftInCycle(at('2026-10-17T23:59:00Z'), end), 1, 'never below 1');
});

test('budgetCheck: halt on tonight\'s worst case, alert on the projection', () => {
  assert.equal(budgetCheck({ spent: 4.8, tonightUsd: 0.3, nightUsd: 0.1, nightsLeft: 2, budgetUsd: 5, alertUsd: 4 }).halt, true);
  const ok = budgetCheck({ spent: 1.0, tonightUsd: 0.3, nightUsd: 0.15, nightsLeft: 10, budgetUsd: 5, alertUsd: 4 });
  assert.deepEqual([ok.halt, ok.alert], [false, false]);
  assert.ok(Math.abs(ok.projected - 2.5) < 1e-9);
  const hot = budgetCheck({ spent: 1.0, tonightUsd: 0.3, nightUsd: 0.35, nightsLeft: 10, budgetUsd: 5, alertUsd: 4 });
  assert.deepEqual([hot.halt, hot.alert], [false, true]);
  // no trailing history → priced at tonight's worst case
  assert.ok(Math.abs(budgetCheck({ spent: 0, tonightUsd: 0.2, nightsLeft: 5, budgetUsd: 5, alertUsd: 4 }).projected - 1.0) < 1e-9);
});

// The bug this fixes (msg-124 #2a): money spent before the 17th counted against the
// calendar month after the reset, so widening made rana-v3 halt itself in late October.
test('INTENT: spending the old cycle\'s headroom before 10-17 never halts the new cycle', () => {
  // Starting state measured 2026-10-08: $1.74 spent this cycle, calendar October $0.68.
  let cycleSpent = 1.74, octSpent = 0.68, oldHalts = 0, newHalts = 0;
  for (let d = 9; d <= 31; d++) {
    const now = at(`2026-10-${String(d).padStart(2, '0')}T02:00:00Z`);
    if (d === 18) cycleSpent = 0;                       // Apify resets
    const night = d <= 17 ? 0.36 : 0.16;                // spend the headroom ($3.26 / 9 nights), then the steady rate
    const { end } = cycleBounds(now);
    if (budgetCheck({ spent: cycleSpent, tonightUsd: night, nightUsd: night, nightsLeft: nightsLeftInCycle(now, end), budgetUsd: 5, alertUsd: 4 }).halt) newHalts++;
    else cycleSpent += night;
    if (octSpent + night > 5) oldHalts++;               // the old calendar-month rule
    else octSpent += night;
  }
  assert.equal(newHalts, 0);
  assert.ok(oldHalts > 0, 'the calendar-month guard would have halted late in October');
});

test('readApifyCycle reads /users/me/limits and returns null on anything unexpected', async () => {
  const ok = (body) => async () => ({ ok: true, json: async () => body });
  const r = await readApifyCycle(ok({ data: { monthlyUsageCycle: { startAt: '2026-09-18T00:00:00.000Z', endAt: '2026-10-17T23:59:59.999Z' }, current: { monthlyUsageUsd: 1.6 }, limits: { maxMonthlyUsageUsd: 5 } } }));
  assert.equal(iso(r.start), '2026-09-18T00:00:00.000Z');
  assert.deepEqual([r.spent, r.limitUsd, r.basis], [1.6, 5, 'apify_limits']);
  assert.equal(await readApifyCycle(ok({ data: {} })), null);
  assert.equal(await readApifyCycle(async () => ({ ok: false })), null);
  assert.equal(await readApifyCycle(async () => { throw new Error('network'); }), null);
});
