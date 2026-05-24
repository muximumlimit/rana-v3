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
const ACTIVITY_MIN_ADS = 5;

export async function runSource(targets, runState) {
  const seen = new Set();
  let totalNew = 0;
  let totalEnriched = 0;
  let totalDropped = 0;
  let totalCostUsd = 0;
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
        totalDropped++;
        continue;
      }

      // Gate 2: Activity proxy — must have ≥5 active ads
      // Signals "invested in marketing," not a one-off boost post
      if ((advertiser.ad_count ?? 0) < ACTIVITY_MIN_ADS) {
        logger.debug({ name: advertiser.name, ad_count: advertiser.ad_count }, 'dropped: activity gate (ad_count < 5)');
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
      const existing = await findExisting(advertiser);
      if (existing) {
        const safeStatuses = ['Qualified', 'Backlog', 'Contacted', 'Engaged', 'Meeting Pending', 'Converted'];
        const enrichFields = {
          running_ads:       true,
          ad_count:          advertiser.ad_count ?? null,
          facebook_page_id:  advertiser.facebook_page_id ?? existing.facebook_page_id,
          facebook_page_url: advertiser.facebook_page_url ?? null,
          discovery_source:  'ad_library',
          budget_score:      budgetScore,
          fit_score:         fitScore,
          size_score:        sizeScore,
          primary_hook:      'running_ads',
          enriched_at:       new Date().toISOString(),
        };
        if (!safeStatuses.includes(existing.status)) {
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

  return {
    new_leads:        totalNew,
    enriched_leads:   totalEnriched,
    dropped:          totalDropped,
    total_cost_usd:   totalCostUsd,
    firecrawl_failed: firecrawlFailed,
  };
}
