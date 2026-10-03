// msg-107 Fix 6 (rana-v3): enrich writes were unconfirmed — supabase-js .update() with
// no .select() returns no rows, so a PATCH that matched nothing still counted as
// leads_enriched. Now a raw-fetch PATCH with return=representation (the rana-v2 writer
// pattern; supabase-js .update().select() returns empty on Railway), and only a
// confirmed row counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let reply = { status: 200, body: [{ id: 'L1', enriched_at: '2026-10-03T02:03:00Z' }] };
const seen = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('/rest/v1/leads')) {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    return new Response(reply.body == null ? null : JSON.stringify(reply.body), { status: reply.status });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const { init, enrichExisting } = await import('./supabase.js');
init('http://supabase.test', 'sk-test');

test('a confirmed enrich: PATCH by id, return=representation, resolves with the row', async () => {
  seen.length = 0; reply = { status: 200, body: [{ id: 'L1', enriched_at: '2026-10-03T02:03:00Z' }] };
  const r = await enrichExisting('L1', { running_ads: true, ad_count: 4 });
  assert.equal(r.id, 'L1');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'PATCH');
  assert.match(seen[0].url, /\/rest\/v1\/leads\?id=eq\.L1/);
  assert.match(seen[0].headers.Prefer, /return=representation/);
  assert.equal(seen[0].headers.apikey, 'sk-test');
  assert.deepEqual(seen[0].body, { running_ads: true, ad_count: 4 });
});

test('INTENT: a PATCH that matched no row is NOT an enrich — it throws "enrich unconfirmed"', async () => {
  reply = { status: 200, body: [] };
  await assert.rejects(() => enrichExisting('gone', { ad_count: 1 }), /enrich unconfirmed: 0 row/);
});

test('a DB rejection (e.g. zz_leads_no_backwards raising) throws with the reason', async () => {
  reply = { status: 400, body: { message: 'lead x: refusing Contacted -> Discovered' } };
  await assert.rejects(() => enrichExisting('x', { status: 'Discovered' }), /enrich failed: .*refusing Contacted -> Discovered/);
});

test('more than one row back is not a confirmed single enrich either', async () => {
  reply = { status: 200, body: [{ id: 'a' }, { id: 'b' }] };
  await assert.rejects(() => enrichExisting('a', { ad_count: 1 }), /enrich unconfirmed: 2 row/);
});
