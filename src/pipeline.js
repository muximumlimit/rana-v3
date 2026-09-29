import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { runSource as runMetaAdLibrary } from './sources/meta-ad-library.js';
import { runSource as runAdLibraryApify } from './sources/ad-library-apify.js';
import logger from './util/logger.js';

// In-memory run tracking
export const runs = new Map();

let targetsCache = null;

async function loadTargets() {
  if (targetsCache) return targetsCache;
  const raw = await readFile(new URL('../config/targets.json', import.meta.url), 'utf8');
  targetsCache = JSON.parse(raw);
  return targetsCache;
}

// Rotate a batch of terms per night so we don't re-scrape the same ~200 advertisers
// every run (the saturation that produced new=0). A window of TERMS_PER_NIGHT slides
// through the full list keyed on the UTC day-of-month, wrapping around — so each night
// surfaces different advertisers and Firecrawl/Claude cost stays flat (~15 terms/run).
// `day` is a continuous day number (days since the epoch), not the day of the month: a
// month-day key restarted the window on the 1st, so after a 31st the same terms ran twice.
const epochDay = () => Math.floor(Date.now() / 86_400_000);
export function rotateTerms(allTerms, perNight, day = epochDay()) {
  const n = Math.min(perNight, allTerms.length);
  if (n >= allTerms.length) return allTerms;
  const start = (day * n) % allTerms.length;
  const batch = [];
  for (let i = 0; i < n; i++) batch.push(allTerms[(start + i) % allTerms.length]);
  return batch;
}

// Factories get reserved slots (Yousif 2026-09-29): 4 of the nightly slots always go to
// factory terms, rotating WITHIN them (8 terms → each runs every 2nd night); the rest
// rotate through everything else. Running all 8 nightly would burn their unique results
// and starve the other sectors; running them in the shared window meant factory terms
// came up ~2 nights in 5, and nights without them wrote 0 factories.
export function tonightsTerms(targets, perNight, day = epochDay()) {
  const factory = targets.factory_terms || [];
  const slots = Math.min(targets.factory_slots_per_night ?? 0, factory.length, perNight);
  return [
    ...rotateTerms(factory, slots, day),
    ...rotateTerms(targets.search_terms, perNight - slots, day),
  ];
}

export async function startRun() {
  const runId = `run_${Date.now()}`;
  const runState = {
    id: runId,
    started_at: new Date().toISOString(),
    status: 'running',
    leads_new: 0,
    leads_enriched: 0,
    dropped: 0,
    dropped_hard_block: 0,
    dropped_activity_gate: 0,
    whatsapp_cta_count: 0,
    total_cost_usd: 0,
    firecrawl_errors: 0,
    firecrawl_failed: false,
    cost_cap_hit: false,
    sample_leads: [],
    error: null,
    finished_at: null,
  };

  runs.set(runId, runState);
  logger.info({ runId }, 'pipeline run started');

  // Run async — don't await
  executePipeline(runId, runState).catch(err => {
    runState.status = 'failed';
    runState.error = err.message;
    runState.finished_at = new Date().toISOString();
    logger.error({ runId, err: err.message }, 'pipeline failed');
  });

  return runId;
}

async function executePipeline(runId, runState) {
  try {
    const targets = await loadTargets();

    // Batch a rotating subset per night (env-tunable, no deploy needed to retune).
    const perNight = parseInt(process.env.TERMS_PER_NIGHT, 10) || targets.terms_per_night || 15;
    const search_terms = tonightsTerms(targets, perNight);
    const termsTotal = targets.search_terms.length + (targets.factory_terms || []).length;
    runState.terms_run = search_terms.length;
    runState.terms_total = termsTotal;
    logger.info({ runId, terms_run: search_terms.length, terms_total: termsTotal, factory_slots: targets.factory_slots_per_night ?? 0, terms: search_terms }, 'rotated term batch for tonight');

    // AD_LIBRARY_SOURCE picks the implementation. Default stays 'firecrawl' so
    // nothing changes until the flag is set; the Firecrawl + Haiku path is kept as
    // the fallback because the Apify actor is a third-party dependency that can
    // change its output shape without notice.
    const sourceName = (process.env.AD_LIBRARY_SOURCE || 'firecrawl').toLowerCase();
    const runFn = sourceName === 'apify' ? runAdLibraryApify : runMetaAdLibrary;
    runState.ad_library_source = sourceName;
    logger.info({ runId, sourceName }, 'ad library source selected');

    const result = await runFn({ ...targets, search_terms }, runState);

    runState.leads_new            = result.new_leads;
    runState.leads_enriched       = result.enriched_leads;
    runState.dropped              = result.dropped;
    runState.dropped_hard_block   = result.dropped_hard_block;
    runState.dropped_activity_gate = result.dropped_activity_gate;
    runState.whatsapp_cta_count    = result.whatsapp_cta_count ?? 0;
    runState.new_number_rate       = result.new_number_rate ?? null;
    runState.phones_found          = result.phones_found ?? 0;
    runState.phones_new            = result.phones_new ?? 0;
    runState.whapi_valid           = result.whapi_valid ?? 0;
    runState.halted                = result.halted ?? false;
    runState.halt_reason           = result.halt_reason ?? null;
    runState.total_cost_usd       = result.total_cost_usd;
    runState.firecrawl_failed     = result.firecrawl_failed;
    runState.status = 'completed';
    runState.finished_at = new Date().toISOString();

    logger.info({ runId, result }, 'pipeline run completed');
  } catch (err) {
    runState.status = 'failed';
    runState.error = err.message;
    runState.finished_at = new Date().toISOString();
    throw err;
  }
}

export function getRun(runId) {
  return runs.get(runId) ?? null;
}

export function getRecentRuns(limit = 20) {
  const all = Array.from(runs.values());
  return all.slice(-limit).reverse();
}
