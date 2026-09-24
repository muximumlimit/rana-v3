import { getClient } from './supabase.js';
import logger from '../util/logger.js';

export function normalizeName(name) {
  if (!name) return '';
  // strip Arabic diacritics
  return name
    .normalize('NFD')
    .replace(/[ً-ٟ]/g, '')
    .toLowerCase()
    .replace(/[^\w؀-ۿ\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function findExisting(advertiser) {
  const supabase = getClient();
  const normalized = normalizeName(advertiser.name);

  if (!normalized && !advertiser.facebook_page_id) return null;

  const conditions = [];

  if (normalized) {
    conditions.push(`normalized_name.eq.${normalized}`);
  }
  if (advertiser.facebook_page_id) {
    conditions.push(`facebook_page_id.eq.${advertiser.facebook_page_id}`);
  }
  if (advertiser.facebook_page_url) {
    conditions.push(`facebook_page_url.eq.${advertiser.facebook_page_url}`);
  }

  // `sector` is selected so callers can apply the ICP hard block to a lead's
  // STORED sector, not just to the advertiser text we scraped. Without it an
  // enrich could refresh a blocked-sector row (e.g. a lead already classified
  // beauty_clinic) because the block only ever saw the freshly scraped name.
  const { data, error } = await supabase
    .from('leads')
    .select('id, business_name, status, source, facebook_page_id, normalized_name, sector')
    .or(conditions.join(','))
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn({ err: error.message, normalized }, 'dedup query error');
    return null;
  }

  return data;
}
