# rana-v3 — Signal Hunter

## Mission
Find Baghdad businesses with marketing signals (ad activity, weak content, agency-managed
but underperforming) and write them to the v2 Supabase `leads` table for Lara to contact.

## Status
- Phase 1: Meta Ad Library MVP — SHIPPED
- Phase 2: Instagram audit + Sonnet vision scoring — TODO
- Phase 3: Agency portfolio mining — TODO (needs competitor list from Yousif)
- Phase 4: Hashtag/comment scraping — TODO

## Hard rules
- Never touch rana-v2 or lara-v2 code from this repo
- Same Supabase as v2 (mamllhbxepmhsuiiknbh) — never v1
- Tag every lead row with `discovery_source` so v2 and v3 outputs are separable
- Daily cost cap: $5/day. Above that, halt and alert.

## Output contract
Every qualified lead writes to `leads` with:
- status: 'Qualified' (or 'Backlog' if borderline)
- source: 'rana-v3'
- discovery_source: one of [ad_library, ig_audit, agency_mining, hashtag]
- need_score, budget_score, switch_score, fit_score, size_score (0-100 each)
- primary_hook: which dimension drives Lara's opener
- plus all v2 columns (business_name, phone, sector, etc)
