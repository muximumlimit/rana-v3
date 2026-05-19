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

  const { data, error } = await supabase
    .from('leads')
    .select('id, business_name, status, source, facebook_page_id, normalized_name')
    .or(conditions.join(','))
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn({ err: error.message, normalized }, 'dedup query error');
    return null;
  }

  return data;
}
