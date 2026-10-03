// msg-107 Fix 5 (rana-v3): nothing alerted on a 401/403 from a provider — a revoked
// Apify/Anthropic/Whapi/Supabase key just produced a quiet night of zeros. Now the
// first 401/403 per provider per run pages on Telegram (lib/alert.js), deduped.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_ALERT_BOT_TOKEN = 'tg-test';
process.env.TELEGRAM_ALERT_CHAT_ID = '42';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.APIFY_API_TOKEN = 'apify-test';
process.env.WHAPI_TOKEN = 'wh-test';
delete process.env.SUPABASE_URL;   // no alert_log writes from this test

const pages = [];
let mode = {};
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://api.telegram.org/')) { pages.push(JSON.parse(init.body).text); return new Response('{"ok":true}', { status: 200 }); }
  if (url.startsWith('https://gate.whapi.cloud/messages/text')) return new Response('{"sent":true}', { status: 200 });
  if (url.includes('api.anthropic.com')) return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: mode.anthropic ?? 401, headers: { 'content-type': 'application/json' } });
  if (url.includes('api.apify.com')) return new Response('{"error":{"type":"user-or-token-not-found"}}', { status: mode.apify ?? 401 });
  if (url.startsWith('https://gate.whapi.cloud/contacts')) return new Response('{"error":"forbidden"}', { status: mode.whapi ?? 403 });
  throw new Error(`unexpected fetch ${url}`);
};

const { noteProviderStatus, resetProviderAuth } = await import('./provider-auth.js');
const claude = await import('./claude.js');
const apify = await import('../sources/ad-library-apify.js');
claude.init();

test('first 401 per provider per run pages once; repeats in the same run do not', async () => {
  pages.length = 0; resetProviderAuth();
  await noteProviderStatus('apify', 401, 'start run');
  await noteProviderStatus('apify', 401, 'poll');
  await noteProviderStatus('anthropic', 403);
  assert.equal(pages.length, 2);
  assert.match(pages[0], /rana-v3.*apify.*401/is);
  resetProviderAuth();
  await noteProviderStatus('apify', 401);
  assert.equal(pages.length, 3, 'a new run pages again');
});

test('other statuses never page', async () => {
  pages.length = 0; resetProviderAuth();
  for (const s of [200, 400, 404, 429, 500, undefined]) await noteProviderStatus('apify', s);
  assert.equal(pages.length, 0);
});

test('INTENT: a rejected Anthropic key pages (the classifier swallows the error, the page still goes)', async () => {
  pages.length = 0; resetProviderAuth(); mode = {};
  await assert.rejects(() => claude.haikuShort('sector?'));
  assert.equal(pages.length, 1);
  assert.match(pages[0], /anthropic/i);
});

test('INTENT: a rejected Apify token pages', async () => {
  pages.length = 0; resetProviderAuth(); mode = {};
  const r = await apify.apifyFetch('/acts/x/runs', { method: 'POST', body: '{}' });
  assert.equal(r.status, 401);
  assert.equal(pages.length, 1);
  assert.match(pages[0], /apify/i);
});

test('INTENT: a rejected Whapi token on /contacts pages once for the whole batch', async () => {
  pages.length = 0; resetProviderAuth(); mode = {};
  const { checked, valid } = await apify.whapiValidate(['+9647700000001', '+9647700000002', '+9647700000003']);
  assert.equal(checked, 3);
  assert.equal(valid.size, 0);
  assert.equal(pages.length, 1);
  assert.match(pages[0], /whapi/i);
});

test('INTENT: Whapi answers a revoked/unknown token with 404 "Channel not found", not 401 — that pages too', async () => {
  // Measured 2026-10-03 against gate.whapi.cloud with a bogus token: 404 {"error":"Channel not found"}.
  pages.length = 0; resetProviderAuth(); mode = { whapi: 404 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input).startsWith('https://gate.whapi.cloud/contacts')
    ? new Response('{"error":"Channel not found","requestId":"x"}', { status: 404 })
    : realFetch(input, init);
  try {
    await apify.whapiValidate(['+9647700000001']);
    assert.equal(pages.length, 1);
    assert.match(pages[0], /whapi.*channel not found/is);
  } finally { globalThis.fetch = realFetch; mode = {}; }
});

test('INTENT: a rejected Supabase key pages', async () => {
  pages.length = 0; resetProviderAuth();
  await noteProviderStatus('supabase', 401, 'month-to-date query');
  assert.equal(pages.length, 1);
  assert.match(pages[0], /supabase/i);
});
