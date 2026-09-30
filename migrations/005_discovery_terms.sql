-- Rana v3 — which search term found a lead (Yousif 2026-09-30). APPLIED 2026-09-30 17:26 UTC
-- (column verified in information_schema and through PostgREST).
--
-- Three times in a week a question ("did the factory terms find this?") had no answer:
-- the Apify actor's items do not say which input URL returned them, and leads only
-- recorded discovery_source. rana-v3 now tags every item with the actor call that
-- returned it and writes the term(s) on insert.
--
-- One element = exact (the term had its own call). Several = the lead came only from
-- a 4-term batch call, and those are the batch's terms. NULL = found before this
-- column existed. Written on insert only; an enrich never rewrites it.
--
-- Must be applied BEFORE the rana-v3 code that writes it is deployed: PostgREST
-- rejects an insert naming an unknown column, and the lead would be lost.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS discovery_terms text[];

COMMENT ON COLUMN leads.discovery_terms IS
  'Search term(s) whose Ad Library call returned this lead when it was first written. 1 element = exact; >1 = a shared 4-term call. NULL = before 2026-10 or not rana-v3. Insert-only.';
