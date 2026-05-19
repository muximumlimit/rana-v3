import express from 'express';
import { createClient } from '@supabase/supabase-js';
import * as supabaseLib from './lib/supabase.js';
import * as claude from './lib/claude.js';
import * as pipeline from './pipeline.js';
import logger from './util/logger.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const START_TIME = Date.now();

// Init clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);
supabaseLib.init(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
claude.init();

function authCheck(req, res, next) {
  const token = req.headers['x-rana-v3-auth'];
  if (!token || token !== process.env.RANA_V3_AUTH_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// GET /health
app.get('/health', async (req, res) => {
  const envChecks = {
    supabase:    !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
    anthropic:   !!process.env.ANTHROPIC_API_KEY,
    firecrawl:   !!process.env.FIRECRAWL_API_KEY,
    auth_token:  !!process.env.RANA_V3_AUTH_TOKEN,
  };

  const recentRuns = pipeline.getRecentRuns(1);
  const lastRun = recentRuns[0] ?? null;

  res.json({
    status: 'ok',
    version: 'rana-v3.0-phase1',
    uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
    env: envChecks,
    last_run_at: lastRun?.started_at ?? null,
    last_run_status: lastRun?.status ?? null,
  });
});

// POST /run-now — start a pipeline run (async)
app.post('/run-now', authCheck, async (req, res) => {
  logger.info('/run-now triggered');
  try {
    const runId = await pipeline.startRun();
    res.json({ run_id: runId, status: 'started' });
  } catch (err) {
    logger.error({ err: err.message }, '/run-now failed');
    res.status(500).json({ error: err.message });
  }
});

// GET /stats
app.get('/stats', async (req, res) => {
  const recentRuns = pipeline.getRecentRuns(20);

  let leadsTotal = 0;
  let leadsV3 = 0;
  try {
    const { count: total } = await supabase.from('leads').select('*', { count: 'exact', head: true });
    const { count: v3 } = await supabase.from('leads').select('*', { count: 'exact', head: true })
      .eq('source', 'rana-v3');
    leadsTotal = total ?? 0;
    leadsV3 = v3 ?? 0;
  } catch (_) {}

  res.json({
    runs: recentRuns,
    leads_total: leadsTotal,
    leads_rana_v3: leadsV3,
  });
});

// GET /runs/:id
app.get('/runs/:id', (req, res) => {
  const run = pipeline.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  res.json(run);
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'rana-v3 started');
});

export default app;
