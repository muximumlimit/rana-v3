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

export async function startRun() {
  const runId = `run_${Date.now()}`;
  const runState = {
    id: runId,
    started_at: new Date().toISOString(),
    status: 'running',
    leads_new: 0,
    leads_enriched: 0,
    dropped: 0,
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

    const result = await runMetaAdLibrary(targets, runState);

    runState.leads_new = result.new_leads;
    runState.leads_enriched = result.enriched_leads;
    runState.dropped = result.dropped;
    runState.total_cost_usd = result.total_cost_usd;
    runState.firecrawl_failed = result.firecrawl_failed;
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
