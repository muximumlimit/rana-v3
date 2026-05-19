-- Rana v3 signal columns — applied 2026-05-19
-- Migrated v2 Supabase (mamllhbxepmhsuiiknbh): 49 → 72 columns

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS discovery_source text,
  ADD COLUMN IF NOT EXISTS instagram_handle text,
  ADD COLUMN IF NOT EXISTS instagram_followers int,
  ADD COLUMN IF NOT EXISTS instagram_post_count int,
  ADD COLUMN IF NOT EXISTS instagram_last_post_date date,
  ADD COLUMN IF NOT EXISTS instagram_engagement_rate numeric(6,4),
  ADD COLUMN IF NOT EXISTS content_quality_score int,
  ADD COLUMN IF NOT EXISTS content_quality_notes text,
  ADD COLUMN IF NOT EXISTS running_ads boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS ad_creative_urls text[],
  ADD COLUMN IF NOT EXISTS ad_start_date date,
  ADD COLUMN IF NOT EXISTS ad_count int,
  ADD COLUMN IF NOT EXISTS managed_by_agency boolean,
  ADD COLUMN IF NOT EXISTS suspected_agency text,
  ADD COLUMN IF NOT EXISTS agency_tenure_estimate text,
  ADD COLUMN IF NOT EXISTS need_score int,
  ADD COLUMN IF NOT EXISTS budget_score int,
  ADD COLUMN IF NOT EXISTS switch_score int,
  ADD COLUMN IF NOT EXISTS fit_score int,
  ADD COLUMN IF NOT EXISTS size_score int,
  ADD COLUMN IF NOT EXISTS primary_hook text,
  ADD COLUMN IF NOT EXISTS facebook_page_id text,
  ADD COLUMN IF NOT EXISTS facebook_page_url text;

-- Index for v3-source queries
CREATE INDEX IF NOT EXISTS idx_leads_discovery_source ON leads(discovery_source);
CREATE INDEX IF NOT EXISTS idx_leads_running_ads ON leads(running_ads) WHERE running_ads = true;

-- Backfill existing rana-v2 leads
UPDATE leads SET discovery_source = 'google_maps' WHERE source = 'rana-v2' AND discovery_source IS NULL;
