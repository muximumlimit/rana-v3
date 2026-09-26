import Anthropic from '@anthropic-ai/sdk';
import logger from '../util/logger.js';

let client;

export function init() {
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const PARSE_PROMPT = `Extract a JSON array of advertisers from this Meta Ad Library page.
For each advertiser, return:
- name: business display name
- facebook_page_id: numeric ID if visible
- facebook_page_url: full URL
- ad_count: number of active ads
- categories: any business category labels
- creative_snippets: first 100 chars of each ad's text, max 3
- is_whatsapp_cta: true ONLY if the ad's call-to-action BUTTON sends the user to
  WhatsApp — i.e. the button itself reads "Send WhatsApp message" / "WhatsApp" /
  "واتساب", or the ad links to wa.me or api.whatsapp.com.
  Do NOT set it true for either of these, which look similar but mean something else:
    * the ad's PLATFORMS / placement list (Facebook, Instagram, Messenger,
      Audience Network, WhatsApp). That says where the ad was SHOWN, not where the
      button goes, and it is the most common false positive here.
    * a plain "Send message" / "إرسال رسالة" button, which is Messenger or WhatsApp
      and is genuinely ambiguous.
  false if the advertiser has ads but no WhatsApp button; omit if you cannot tell.
- contact_phones: every phone number that appears in the ad's own body text, as an
  array of digit-only strings (Iraqi mobiles look like 07XXXXXXXXX or
  9647XXXXXXXXX). Advertisers here routinely publish their number in the ad copy —
  take those verbatim. Include a number from a wa.me link too. Omit the field if
  there are none. Never invent, complete or infer a number.

Return ONLY valid JSON. No prose. If no advertisers found, return [].`;

// Firecrawl markdown can contain lone/unpaired UTF-16 surrogates (broken emoji,
// truncated multi-byte chars in Arabic ad creative). JSON.stringify emits these
// as bare \uD8xx, which Anthropic's server-side JSON parser rejects with a 400
// "no low surrogate in string". Strip any surrogate code unit that isn't part of
// a valid high+low pair before sending.
function stripLoneSurrogates(str) {
  return str.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
}

// Short single-answer Haiku call (sector classification). Returns text + cost.
export async function haikuShort(prompt, maxTokens = 60) {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: stripLoneSurrogates(prompt) }],
  });
  const inputTokens = msg.usage?.input_tokens ?? 0;
  const outputTokens = msg.usage?.output_tokens ?? 0;
  return {
    text: msg.content[0]?.text || '',
    cost_usd: (inputTokens / 1_000_000) * 0.80 + (outputTokens / 1_000_000) * 4.00,
  };
}

export async function parseAdLibraryContent(markdown, html) {
  const content = markdown || html || '';
  if (!content || content.length < 100) {
    logger.warn('parseAdLibraryContent: content too short, returning empty');
    return { advertisers: [], input_tokens: 0, output_tokens: 0 };
  }

  // Trim to 80k chars to stay within token budget, then strip lone surrogates.
  const trimmed = stripLoneSurrogates(content.slice(0, 80000));

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `${PARSE_PROMPT}\n\n---\n${trimmed}`,
      },
    ],
  });

  const text = msg.content[0]?.text || '[]';
  let advertisers = [];
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    advertisers = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch (err) {
    logger.warn({ err: err.message, text: text.slice(0, 200) }, 'haiku parse failed');
    advertisers = [];
  }

  const inputTokens = msg.usage?.input_tokens ?? 0;
  const outputTokens = msg.usage?.output_tokens ?? 0;
  const cost = (inputTokens / 1_000_000) * 0.80 + (outputTokens / 1_000_000) * 4.00;

  logger.info({ advertisers: advertisers.length, inputTokens, outputTokens, cost }, 'haiku parse complete');

  return { advertisers, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost };
}
