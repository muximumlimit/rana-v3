-- Rana v3 — click-to-WhatsApp flag. Applied 2026-09-24.
--
-- Measured 2026-09-24 across 5 Iraqi sector terms / 98 Ad Library cards: ~30% of
-- ad cards carry a WhatsApp CTA ("Send WhatsApp message" / "واتساب"). The CTA
-- LABEL is already in the markdown rana-v3 sends to Haiku, so capturing it costs
-- nothing extra. The destination number is NOT on the search page (wa.me appeared
-- twice in 98 cards, both from one ad's body text), so this is a flag, not a phone.
--
-- Why it matters: an advertiser running WhatsApp-CTA ads already sells over
-- WhatsApp, which is exactly the channel Lara uses. It is a buying-readiness
-- signal independent of sector.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS whatsapp_cta boolean;

-- Partial index mirrors idx_leads_running_ads — we only ever query for the true case.
CREATE INDEX IF NOT EXISTS idx_leads_whatsapp_cta ON leads(whatsapp_cta) WHERE whatsapp_cta = true;

COMMENT ON COLUMN leads.whatsapp_cta IS
  'true = at least one observed Meta ad used a click-to-WhatsApp CTA. NULL = never observed / not checked. Set by rana-v3 ad_library discovery.';
