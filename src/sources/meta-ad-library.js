import { scrapeAdLibraryWithRetry } from '../lib/firecrawl.js';
import { parseAdLibraryContent } from '../lib/claude.js';
import { findExisting, normalizeName } from '../lib/dedup.js';
import { upsertLead, enrichExisting } from '../lib/supabase.js';
import { isHardBlocked, scoreBudget, scoreFit, scoreSize, qualify, inferSector } from '../scoring/dimensions.js';
import { pickPrimaryHook } from '../scoring/primary-hook.js';
import logger from '../util/logger.js';

// Activity gate v1 proxy: minimum simultaneous active ads to qualify as
// "invested in marketing." Per-ad recency check (start_date) added in
// Session B when parser is extended to return individual ad dates.
// Env-tunable so threshold changes need no deploy; default 3 (was hardcoded 5,
// which dropped ~82% of discoveries).
const ACTIVITY_MIN_ADS = parseInt(process.env.ACTIVITY_MIN_ADS, 10) || 3;

// Iraqi advertisers routinely publish their mobile in the ad copy. Measured
// 2026-09-24 on an 11-ad Apify sample: 9 of 11 (82%) carried a reachable number in
// the body text — a better hit rate than Google Places gives for factories (57.7%).
// Accepts 07XXXXXXXXX / 7XXXXXXXXX / 9647XXXXXXXXX shapes and returns the first
// plausible one, digits only. Deliberately conservative: anything it is unsure
// about is dropped rather than guessed.
function firstPhone(list) {
  if (!Array.isArray(list)) return null;
  for (const raw of list) {
    const d = String(raw ?? '').replace(/\D/g, '');
    if (/^9647\d{8,9}$/.test(d)) return d;
    if (/^07\d{9}$/.test(d))     return '964' + d.slice(1);
    if (/^7\d{9}$/.test(d))      return '964' + d;
  }
  return null;
}

export async function runSource(targets, runState) {
  const seen = new Set();
  let totalNew = 0;
  let totalEnriched = 0;
  let totalDropped = 0;
  let totalDroppedHardBlock = 0;
  let totalDroppedActivityGate = 0;
  let totalCostUsd = 0;
  let totalCtwa = 0;
  let firecrawlFailed = false;

  for (const searchTerm of targets.search_terms) {
    const dailyCap = parseFloat(process.env.DAILY_COST_CAP_USD || '5');
    if (totalCostUsd >= dailyCap) {
      logger.warn({ totalCostUsd, dailyCap }, 'daily cost cap reached — stopping');
      runState.cost_cap_hit = true;
      break;
    }

    if (totalNew + totalEnriched >= targets.max_advertisers_per_run) {
      logger.info('max_advertisers_per_run reached — stopping');
      break;
    }

    logger.info({ searchTerm }, 'processing search term');

    let scraped;
    try {
      scraped = await scrapeAdLibraryWithRetry(searchTerm);
    } catch (err) {
      logger.error({ searchTerm, err: err.message }, 'firecrawl failed for term');
      firecrawlFailed = true;
      runState.firecrawl_errors = (runState.firecrawl_errors || 0) + 1;
      continue;
    }

    const { advertisers, cost_usd: parseCost } = await parseAdLibraryContent(
      scraped.markdown,
      scraped.html,
    );
    totalCostUsd += parseCost || 0;
    runState.total_cost_usd = totalCostUsd;

    if (!advertisers || advertisers.length === 0) {
      logger.info({ searchTerm }, 'no advertisers extracted');
      continue;
    }

    logger.info({ searchTerm, count: advertisers.length }, 'advertisers extracted');

    for (const advertiser of advertisers) {
      if (!advertiser.name) continue;

      // Gate 1: ICP hard block — medical, dental, beauty, salon, pharmacy
      if (isHardBlocked(advertiser, searchTerm)) {
        logger.debug({ name: advertiser.name }, 'dropped: hard block (off-ICP sector)');
        totalDroppedHardBlock++;
        totalDropped++;
        continue;
      }

      // Gate 2: Activity proxy — must have >= ACTIVITY_MIN_ADS active ads
      // Signals "invested in marketing," not a one-off boost post
      if ((advertiser.ad_count ?? 0) < ACTIVITY_MIN_ADS) {
        logger.debug({ name: advertiser.name, ad_count: advertiser.ad_count, min: ACTIVITY_MIN_ADS }, 'dropped: activity gate');
        totalDroppedActivityGate++;
        totalDropped++;
        continue;
      }

      // Dedup within this run
      const dedupeKey = normalizeName(advertiser.name);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // Score
      const budgetScore = scoreBudget(advertiser);
      const fitScore    = scoreFit(advertiser, searchTerm);
      const sizeScore   = scoreSize(advertiser.ad_count);
      const status      = qualify(budgetScore, fitScore);

      if (status === 'Dropped') {
        totalDropped++;
        continue;
      }

      // Dedup against existing leads
      // Click-to-WhatsApp: the advertiser already sells over the channel Lara uses.
      // Accumulating signal — once observed true it must never be erased by a later
      // ad set that happens to carry no WhatsApp CTA, so `false`/absent never
      // downgrades an existing true.
      const ctwa = advertiser.is_whatsapp_cta === true ? true : null;
      if (ctwa) totalCtwa++;

      const existing = await findExisting(advertiser);
      if (existing) {
        const enrichFields = {
          running_ads:       true,
          ad_count:          advertiser.ad_count ?? null,
          facebook_page_id:  advertiser.facebook_page_id ?? existing.facebook_page_id,
          facebook_page_url: advertiser.facebook_page_url ?? null,
          // discovery_source is NOT overwritten on enrich — it records how a lead
          // was FOUND. Clobbering it rewrote rana-v2 google_maps leads as
          // ad_library on re-discovery, so every attribution query by
          // discovery_source silently lied. That corruption made an audit of the
          // Apify source appear to show 6 breaches of its never-write-phone_e164
          // guarantee when it had written none. Fixed there in 13e2ba6.
          budget_score:      budgetScore,
          fit_score:         fitScore,
          size_score:        sizeScore,
          primary_hook:      'running_ads',
          enriched_at:       new Date().toISOString(),
        };
        if (ctwa) enrichFields.whatsapp_cta = true;
        // Resurrection guard: ONLY a still-raw 'Discovered' lead may have its status
        // rewritten by re-discovery. Every other status is protected — terminal states
        // (Dropped, Blacklisted, Duplicate, Closed, Unreachable, Stale) must never be
        // resurrected, and human-progress states (Replied, Hot Lead, Meeting Pending,
        // Awaiting Human, Contacted, Engaged) must never be clobbered back to Discovered.
        // This matters now that the activity gate (5->3) lets more advertisers reach dedup.
        // (Extends ee524fb's terminal-status protection.) Other fields still enrich.
        if (existing.status === 'Discovered') {
          enrichFields.status = status;
        }

        try {
          await enrichExisting(existing.id, enrichFields);
          totalEnriched++;
          runState.leads_enriched = totalEnriched;
          logger.info({ id: existing.id, business_name: existing.business_name }, 'enriched existing');
        } catch (err) {
          logger.error({ err: err.message, existing }, 'enrich failed');
        }
        continue;
      }

      // New lead
      const lead = {
        business_name:     advertiser.name,
        normalized_name:   dedupeKey,
        sector:            inferSector(advertiser),
        discovery_source:  'ad_library',
        source:            'rana-v3',
        status,
        running_ads:       true,
        ad_count:          advertiser.ad_count ?? null,
        ad_creative_urls:  (advertiser.creative_snippets ?? []).map(s => String(s).slice(0, 500)),
        facebook_page_id:  advertiser.facebook_page_id ?? null,
        facebook_page_url: advertiser.facebook_page_url ?? null,
        whatsapp_cta:      ctwa,
        // Phones published in the advertiser's own ad copy. Captured as the RAW
        // `phone` only — `phone_e164` is deliberately left null, because lara-v2's
        // pool query gates on `phone_e164 IS NOT NULL` (crm.js:110). So these are
        // banked for review and cannot reach the blast path until someone validates
        // them (Whapi) and promotes them deliberately.
        phone:             firstPhone(advertiser.contact_phones),
        ad_copy_phone:     firstPhone(advertiser.contact_phones),
        budget_score:      budgetScore,
        fit_score:         fitScore,
        size_score:        sizeScore,
        primary_hook:      pickPrimaryHook({ discovery_source: 'ad_library' }),
      };

      try {
        const saved = await upsertLead(lead);
        totalNew++;
        runState.leads_new = totalNew;
        runState.sample_leads = runState.sample_leads || [];
        if (runState.sample_leads.length < 10) runState.sample_leads.push(saved);
        logger.info({ business_name: lead.business_name, status, sector: lead.sector, ad_count: advertiser.ad_count }, 'new lead saved');
      } catch (err) {
        logger.error({ err: err.message, business_name: lead.business_name }, 'insert failed');
      }
    }
  }

  runState.firecrawl_failed = firecrawlFailed;
  runState.dropped_hard_block    = totalDroppedHardBlock;
  runState.dropped_activity_gate = totalDroppedActivityGate;
  runState.whatsapp_cta_count    = totalCtwa;

  return {
    new_leads:              totalNew,
    enriched_leads:         totalEnriched,
    dropped:                totalDropped,
    dropped_hard_block:     totalDroppedHardBlock,
    dropped_activity_gate:  totalDroppedActivityGate,
    whatsapp_cta_count:     totalCtwa,
    total_cost_usd:         totalCostUsd,
    firecrawl_failed:       firecrawlFailed,
  };
}
