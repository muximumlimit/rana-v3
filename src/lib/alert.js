// Alert transport for rana-v3 (msg-107 Fix 4).
//
// rana-v3 used to page over WhatsApp ONLY (Whapi /messages/text). Whapi has no balance
// visibility, so a dead channel silenced the alert about the dead channel. Same rule as
// marcus-cron lib/notify.js and lara-v2 lib/alert.js: THE ALERT MUST NOT DEPEND ON ANY
// COMPONENT IT REPORTS ON.
//   - Telegram (@Xstudio_alert_bot) always; delivered = Telegram accepted it
//   - a WhatsApp copy alongside, secondary: never counts as delivery
//   - one alert_log row per attempt (migration 009, shared by all four services), so an
//     undelivered count survives a restart
// Env: TELEGRAM_ALERT_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID (never the lead-facing bot's
// variable on lara-v2). Never throws.
import logger from '../util/logger.js';

const TG_API = 'https://api.telegram.org';

async function sendTelegram(text) {
  if (!process.env.TELEGRAM_ALERT_BOT_TOKEN || !process.env.TELEGRAM_ALERT_CHAT_ID) {
    return { sent: false, reason: 'not_configured' };
  }
  try {
    const res = await fetch(`${TG_API}/bot${process.env.TELEGRAM_ALERT_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_ALERT_CHAT_ID, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) return { sent: false, status: res.status, reason: data?.description || `HTTP ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

async function sendWhatsAppCopy(text) {
  const token = process.env.WHAPI_TOKEN;
  const phone = (process.env.YOUSIF_PHONE || '').replace(/^\+/, '');   // Whapi wants no +
  if (!token || !phone) return { sent: false, reason: 'no WHAPI_TOKEN/YOUSIF_PHONE' };
  try {
    const res = await fetch('https://gate.whapi.cloud/messages/text', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: phone, body: text }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && data?.sent !== false ? { sent: true } : { sent: false, status: res.status, reason: data?.message || `HTTP ${res.status}` };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

async function logAttempt(row) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/rest/v1/alert_log`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) logger.error({ status: res.status }, 'alert_log insert failed');
  } catch (err) {
    logger.error({ err: err.message }, 'alert_log insert threw');
  }
}

/**
 * Page Yousif. Telegram always, WhatsApp copy alongside.
 * @returns {delivered, telegram, whatsapp}
 */
export async function pageCritical(subject, body = '', { kind = 'critical' } = {}) {
  const text = `🚨 ${subject}${body ? `\n\n${body}` : ''}`;
  logger.error({ subject, body, kind }, 'PAGE');
  const [telegram, whatsapp] = await Promise.all([sendTelegram(text), sendWhatsAppCopy(text)]);
  if (!telegram.sent) {
    logger.error({ kind, telegram: telegram.reason, whatsapp: whatsapp.sent ? 'sent' : whatsapp.reason }, 'PAGE UNDELIVERED on Telegram');
  }
  await logAttempt({
    service: 'rana-v3', kind, delivered: telegram.sent, telegram: telegram.sent, whatsapp: whatsapp.sent,
    reason: telegram.sent ? null : `telegram ${telegram.reason}`, text_head: text.slice(0, 200),
  });
  return { delivered: telegram.sent, telegram, whatsapp };
}
