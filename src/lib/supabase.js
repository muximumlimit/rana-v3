import { createClient } from '@supabase/supabase-js';
import logger from '../util/logger.js';
import { stripLoneSurrogates } from '../util/text.js';

let supabase;
let rest;   // { url, key } for raw-fetch writes that must be confirmed

export function init(url, key) {
  supabase = createClient(url, key);
  rest = { url, key };
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

// Confirmed enrich (msg-107 Fix 6). supabase-js .update() with no .select() returns no
// rows, so a PATCH that matched nothing still counted as leads_enriched; and
// .update().select() returns empty on Railway (rana-v2, 2026-06). Raw PATCH with
// return=representation: exactly one row back, or it throws — the caller counts only
// what resolves.
export async function enrichExisting(id, enrichFields) {
  const res = await fetch(`${rest.url}/rest/v1/leads?id=eq.${encodeURIComponent(id)}&select=id,enriched_at`, {
    method: 'PATCH',
    headers: {
      apikey: rest.key, Authorization: `Bearer ${rest.key}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify(enrichFields),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error(`enrich failed: ${body?.message || text || `HTTP ${res.status}`}`);
  const n = Array.isArray(body) ? body.length : 0;
  if (n !== 1) throw new Error(`enrich unconfirmed: ${n} row(s) came back for id ${id}`);
  logger.info({ id }, 'existing lead enriched (confirmed)');
  return body[0];
}

// The write boundary (msg-116): PostgREST hands this body to Postgres as json, and one
// unpaired surrogate half anywhere in it fails the whole insert. Every truncation upstream
// is code-point safe now; this is the backstop for the text we did not cut ourselves.
const clean = (v) => (typeof v === 'string' ? stripLoneSurrogates(v)
  : Array.isArray(v) ? v.map(clean) : v);

function buildRow(lead) {
  return Object.fromEntries(Object.entries(rawRow(lead)).map(([k, v]) => [k, clean(v)]));
}

function rawRow(lead) {
  return {
    business_name:        lead.business_name,
    normalized_name:      lead.normalized_name,
    sector:               lead.sector || null,
    phone:                lead.phone || null,
    phone_e164:           lead.phone_e164 || null,
    // Provenance copy of the ad-copy number. `phone` can later be filled or
    // replaced by other sources; this column only ever holds what the advertiser
    // published. Must be listed here — fields absent from this row are dropped.
    ad_copy_phone:        lead.ad_copy_phone || null,

    source:               'rana-v3',
    discovery_source:     lead.discovery_source,
    // Search term(s) that found it (migration 005); set on insert only, never on enrich.
    discovery_terms:      lead.discovery_terms?.length ? lead.discovery_terms : null,
    status:               lead.status,

    running_ads:          lead.running_ads ?? true,
    whatsapp_cta:         lead.whatsapp_cta ?? null,
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
