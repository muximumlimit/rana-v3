-- Rana v3 run history. Applied 2026-09-24.
--
-- rana-v3 tracked runs in an in-memory Map (src/pipeline.js), so /stats and
-- /runs/:id reset to empty on every redeploy and there was no way to tell "never
-- ran" from "restarted". A new-number decay curve needs durable per-run rows, so
-- the ad-library-apify source writes here.

CREATE TABLE IF NOT EXISTS rana_v3_runs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at              timestamptz DEFAULT now(),
  finished_at             timestamptz,
  source                  text,          -- 'ad_library_apify' | 'ad_library_firecrawl'
  status                  text,          -- running | success | halted | failed
  halt_reason             text,

  terms_run               int,
  ads_returned            int,
  advertisers             int,
  advertisers_with_phone  int,

  phones_found            int,
  phones_new              int,
  new_rate                numeric(5,4),  -- phones_new / phones_found

  icp_allowed             int,
  icp_blocked             int,
  ctwa_advertisers        int,

  whapi_checked           int,
  whapi_valid             int,

  leads_new               int,
  leads_enriched          int,

  apify_cost_usd          numeric(8,5),
  month_to_date_usd       numeric(8,4),
  projected_month_usd     numeric(8,4),

  error_message           text,
  metadata                jsonb
);

CREATE INDEX IF NOT EXISTS idx_rana_v3_runs_started ON rana_v3_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_rana_v3_runs_source  ON rana_v3_runs(source, started_at DESC);

COMMENT ON COLUMN rana_v3_runs.new_rate IS
  'Share of discovered phone numbers not already in leads. Expected to DECAY as the table fills — the first measured run was 0.975 (155/159) against a table with almost no ad-library phones.';
