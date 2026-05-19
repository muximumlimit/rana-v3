import { createClient } from '@supabase/supabase-js';
import logger from '../util/logger.js';

let supabase;

export function init(url, key) {
  supabase = createClient(url, key);
}

export function getClient() {
  return supabase;
}

export async function upsertLead(lead) {
  const row = buildRow(lead);
  const { error } = await supabase
    .from('leads')
    .insert([row]);
  if (error) throw new Error(`insert failed: ${error.message}`);
  logger.info({ business_name: lead.business_name }, 'new lead inserted');
  return row;
}

export async function enrichExisting(id, enrichFields) {
  const { error } = await supabase
    .from('leads')
    .update(enrichFields)
    .eq('id', id);
  if (error) throw new Error(`enrich failed: ${error.message}`);
  logger.info({ id }, 'existing lead enriched');
}

function buildRow(lead) {
  return {
    business_name:        lead.business_name,
    normalized_name:      lead.normalized_name,
    sector:               lead.sector || null,
    phone:                lead.phone || null,
    phone_e164:           lead.phone_e164 || null,

    source:               'rana-v3',
    discovery_source:     lead.discovery_source,
    status:               lead.status,

    running_ads:          lead.running_ads ?? true,
    ad_count:             lead.ad_count ?? null,
    ad_creative_urls:     lead.ad_creative_urls ?? [],
    ad_start_date:        lead.ad_start_date ?? null,
    facebook_page_id:     lead.facebook_page_id ?? null,
    facebook_page_url:    lead.facebook_page_url ?? null,

    budget_score:         lead.budget_score ?? null,
    fit_score:            lead.fit_score ?? null,
    size_score:           lead.size_score ?? null,
    need_score:           null,
    switch_score:         null,

    primary_hook:         lead.primary_hook ?? null,
    enriched_at:          new Date().toISOString(),
    enrichment_version:   'rana-v3.0-phase1',
    enrichment_cost_usd:  lead.cost_usd ?? null,
  };
}
