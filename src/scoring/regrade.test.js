// Re-grade on sector/fit change (Yousif 2026-09-29): a backfill must never strand a lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { regradeStatus, qualify, PRE_ENRICH_STATUSES } from './dimensions.js';
import { ICP_SECTOR_VALUES } from './sector.js';

test('INTENT: a BacklogV3 lead whose fit rose is re-graded to Discovered (the 09-26 stranding)', () => {
  // معمل خزانات الوطني: budget 70, fit 0 → 60 after its sector was recovered.
  assert.equal(regradeStatus('BacklogV3', 70, 60), 'Discovered');
  assert.equal(regradeStatus('Discovered', 70, 0), 'BacklogV3', 'and down again if fit falls');
});

test('only pre-enrichment statuses are ever touched', () => {
  assert.deepEqual(PRE_ENRICH_STATUSES, ['Discovered', 'BacklogV3']);
  for (const s of ['Qualified', 'Contacted', 'Awaiting Human', 'Dropped', 'Unreachable', 'Duplicate', 'Blacklisted', 'Engaged'])
    assert.equal(regradeStatus(s, 90, 80), null, s);
});

test('regradeStatus is exactly qualify() for pre-enrichment rows', () => {
  for (const b of [0, 39, 40, 59, 60, 90]) for (const f of [0, 49, 50, 60, 80])
    assert.equal(regradeStatus('BacklogV3', b, f), qualify(b, f), `budget ${b} fit ${f}`);
});

test('INTENT: the database trigger uses the SAME ICP list as the code (no drift)', () => {
  const sql = readFileSync(new URL('../../migrations/004_regrade_on_sector_fit.sql', import.meta.url), 'utf8');
  const block = sql.match(/select array\[([\s\S]*?)\]::text\[\]/)[1];
  const inSql = new Set([...block.matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]));
  assert.deepEqual([...inSql].sort(), [...ICP_SECTOR_VALUES].sort());
});
