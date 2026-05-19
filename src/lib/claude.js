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

Return ONLY valid JSON. No prose. If no advertisers found, return [].`;

export async function parseAdLibraryContent(markdown, html) {
  const content = markdown || html || '';
  if (!content || content.length < 100) {
    logger.warn('parseAdLibraryContent: content too short, returning empty');
    return { advertisers: [], input_tokens: 0, output_tokens: 0 };
  }

  // Trim to 80k chars to stay within token budget
  const trimmed = content.slice(0, 80000);

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
