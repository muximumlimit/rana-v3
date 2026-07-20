import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { runSource as runMetaAdLibrary } from './sources/meta-ad-library.js';
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
function rotateTerms(allTerms, perNight) {
  const n = Math.min(perNight, allTerms.length);
  if (n >= allTerms.length) return allTerms;
  const day = new Date().getUTCDate(); // 1..31
  const start = ((day - 1) * n) % allTerms.length;
  const batch = [];
  for (let i = 0; i < n; i++) batch.push(allTerms[(start + i) % allTerms.length]);
  return batch;
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
    const search_terms = rotateTerms(targets.search_terms, perNight);
    runState.terms_run = search_terms.length;
    runState.terms_total = targets.search_terms.length;
    logger.info({ runId, terms_run: search_terms.length, terms_total: targets.search_terms.length, terms: search_terms }, 'rotated term batch for tonight');

    const result = await runMetaAdLibrary({ ...targets, search_terms }, runState);

    runState.leads_new            = result.new_leads;
    runState.leads_enriched       = result.enriched_leads;
    runState.dropped              = result.dropped;
    runState.dropped_hard_block   = result.dropped_hard_block;
    runState.dropped_activity_gate = result.dropped_activity_gate;
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
