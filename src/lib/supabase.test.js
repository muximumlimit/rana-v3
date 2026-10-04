// buildRow() is a whitelist: a field set by a source but not listed there is
// dropped on insert without an error. ad_copy_phone must survive to the wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('/rest/v1/leads')) {
    sent.push(JSON.parse(init.body ?? await input.text()));
    return new Response(null, { status: 201 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const { init, upsertLead } = await import('./supabase.js');
init('http://supabase.test', 'test-key');

test('ad_copy_phone reaches the inserted row alongside phone', async () => {
  sent.length = 0;
  await upsertLead({
    business_name: 'Test Advertiser', normalized_name: 'test advertiser',
    discovery_source: 'ad_library_apify', status: 'Discovered',
    phone: '9647713737067', ad_copy_phone: '9647713737067',
  });
  const row = sent.flat()[0];
  assert.equal(row.ad_copy_phone, '9647713737067');
  assert.equal(row.phone, '9647713737067');
  assert.equal(row.phone_e164, null, 'the ad-copy source still never sets phone_e164');
});

test('discovery_terms reaches the inserted row (it is a whitelist)', async () => {
  sent.length = 0;
  await upsertLead({ business_name: 'T', normalized_name: 't', discovery_source: 'ad_library_apify', status: 'Discovered', discovery_terms: ['مصنع بغداد'] });
  assert.deepEqual(sent.flat()[0].discovery_terms, ['مصنع بغداد']);
  sent.length = 0;
  await upsertLead({ business_name: 'U', normalized_name: 'u', discovery_source: 'ad_library', status: 'Discovered' });
  assert.equal(sent.flat()[0].discovery_terms, null, 'the Firecrawl source has no term → NULL');
});

test('INTENT (msg-116): nothing that reaches the wire carries a lone surrogate — the json Postgres parses is valid', async () => {
  sent.length = 0;
  const half = '\ud83d'; // the high half of 🕋 — what body.slice(0,100) left behind
  await upsertLead({
    business_name: `شركة${half}`, normalized_name: `شركه${half}`, discovery_source: 'ad_library_apify', status: 'Discovered',
    ad_creative_urls: [`الحج والعمرة${half}`, 'سليم 🕋'], discovery_terms: [`مصنع${half}`], facebook_page_url: `https://fb.com/x${half}`,
  });
  const wire = JSON.stringify(sent.flat()[0]);
  assert.equal(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(wire), false, 'no unpaired high surrogate escape');
  const row = sent.flat()[0];
  assert.deepEqual(row.ad_creative_urls, ['الحج والعمرة', 'سليم 🕋'], 'whole emoji survive; only the half is dropped');
  assert.equal(row.business_name, 'شركة');
});

test('no ad-copy number → ad_copy_phone is null, not undefined/missing', async () => {
  sent.length = 0;
  await upsertLead({ business_name: 'No Phone', normalized_name: 'no phone', discovery_source: 'ad_library_apify', status: 'Discovered' });
  const row = sent.flat()[0];
  assert.ok('ad_copy_phone' in row);
  assert.equal(row.ad_copy_phone, null);
});
