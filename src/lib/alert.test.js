// msg-107 Fix 4: rana-v3 paged over WhatsApp ONLY (the Apify budget halt/alert), so a
// dead Whapi channel silenced the alert about the dead channel. Now: Telegram first
// (@Xstudio_alert_bot, TELEGRAM_ALERT_* — never TELEGRAM_BOT_TOKEN), WhatsApp a
// secondary copy that never counts as delivery, one alert_log row per attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.TELEGRAM_ALERT_BOT_TOKEN = 'tg-test';
process.env.TELEGRAM_ALERT_CHAT_ID = '42';
process.env.WHAPI_TOKEN = 'wh-test';
process.env.YOUSIF_PHONE = '+9647813141514';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'sk-test';

let tgUp = true, waUp = true, logUp = true;
const calls = { tg: [], wa: [], log: [] };
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('https://api.telegram.org/')) {
    calls.tg.push(JSON.parse(init.body));
    return tgUp ? new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 })
                : new Response(JSON.stringify({ ok: false, description: 'Bad Gateway' }), { status: 502 });
  }
  if (url.startsWith('https://gate.whapi.cloud/messages/text')) {
    calls.wa.push(JSON.parse(init.body));
    return waUp ? new Response(JSON.stringify({ sent: true, message: { id: 'w1' } }), { status: 200 })
                : new Response(JSON.stringify({ message: 'channel offline' }), { status: 402 });
  }
  if (url.startsWith('http://supabase.test/rest/v1/alert_log')) {
    calls.log.push({ body: JSON.parse(init.body), headers: init.headers });
    return logUp ? new Response(null, { status: 201 }) : new Response('{"message":"db down"}', { status: 500 });
  }
  throw new Error(`unexpected fetch ${url}`);
};
const reset = () => { tgUp = waUp = logUp = true; calls.tg.length = calls.wa.length = calls.log.length = 0; };

const { pageCritical } = await import('./alert.js');

test('INTENT: Telegram is the primary path — delivered only when Telegram accepts', async () => {
  reset();
  const r = await pageCritical('rana-v3 apify budget exceeded — run HALTED', 'month-to-date $5.01', { kind: 'apify_budget' });
  assert.equal(r.delivered, true);
  assert.equal(calls.tg.length, 1);
  assert.equal(calls.tg[0].chat_id, '42');
  assert.match(calls.tg[0].text, /rana-v3 apify budget exceeded/);
  assert.equal(calls.wa.length, 1, 'WhatsApp copy alongside');
  assert.equal(calls.wa[0].to, '9647813141514', 'Whapi wants no +');
});

test('INTENT: Whapi dead — the alert still lands on Telegram', async () => {
  reset(); waUp = false;
  const r = await pageCritical('rana-v3 apify budget exceeded', 'x', { kind: 'apify_budget' });
  assert.equal(r.delivered, true);
  assert.equal(r.whatsapp.sent, false);
});

test('Telegram down + WhatsApp up → UNDELIVERED (WhatsApp never counts as delivery)', async () => {
  reset(); tgUp = false;
  const r = await pageCritical('s', 'b', { kind: 'apify_budget' });
  assert.equal(r.delivered, false);
  assert.equal(r.whatsapp.sent, true);
});

test('one alert_log row per attempt, service rana-v3, with both transport results', async () => {
  reset(); tgUp = false;
  await pageCritical('subject here', 'body', { kind: 'apify_budget' });
  assert.equal(calls.log.length, 1);
  const row = calls.log[0].body;
  assert.deepEqual(
    { service: row.service, kind: row.kind, delivered: row.delivered, telegram: row.telegram, whatsapp: row.whatsapp },
    { service: 'rana-v3', kind: 'apify_budget', delivered: false, telegram: false, whatsapp: true });
  assert.match(row.reason, /Bad Gateway/);
  assert.match(row.text_head, /subject here/);
  assert.equal(calls.log[0].headers.apikey, 'sk-test');
});

test('alert_log down never breaks paging', async () => {
  reset(); logUp = false;
  const r = await pageCritical('s', 'b', { kind: 'x' });
  assert.equal(r.delivered, true);
});

test('Telegram not configured → undelivered, reason says so; still logged', async () => {
  reset();
  const saved = process.env.TELEGRAM_ALERT_BOT_TOKEN;
  delete process.env.TELEGRAM_ALERT_BOT_TOKEN;
  try {
    const r = await pageCritical('s', 'b', { kind: 'x' });
    assert.equal(r.delivered, false);
    assert.equal(calls.tg.length, 0);
    assert.equal(calls.log[0].body.reason, 'telegram not_configured');
  } finally { process.env.TELEGRAM_ALERT_BOT_TOKEN = saved; }
});

test('never TELEGRAM_BOT_TOKEN (that name is the lead-facing bot on lara-v2)', async () => {
  const src = await readFile(new URL('./alert.js', import.meta.url), 'utf8');
  assert.ok(!/TELEGRAM_BOT_TOKEN/.test(src));
});

test('INTENT: the Apify source pages through this module, not Whapi directly', async () => {
  const src = await readFile(new URL('../sources/ad-library-apify.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('gate.whapi.cloud/messages/text'), 'ad-library-apify.js still sends its own WhatsApp page');
  assert.match(src, /from '\.\.\/lib\/alert\.js'/);
});
