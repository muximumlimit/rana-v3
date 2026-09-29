-- 004 — a rana-v3 lead is re-graded whenever its sector, fit or budget changes (Yousif 2026-09-29).
--
-- Why: the 2026-09-26 sector backfill wrote `sector` on 57 BacklogV3 leads and printed
-- "BacklogV3→Discovered fit 0→60" for each — but never wrote fit_score or status. stage8 only
-- enriches `Discovered`, so all 57 were stranded with no phone. A trigger means ANY writer —
-- the nightly source, a one-off script, a hand edit — gets the same re-grade.
--
-- Rules (mirror rana-v3 src/scoring/dimensions.js):
--   * only rana-v3 rows still in a pre-enrichment status (Discovered, BacklogV3);
--   * a writer that sets `status` itself is respected (stage8 → Qualified, Unreachable, …);
--   * sector changed but fit_score not supplied → fit recomputed: 60 if the sector is ICP,
--     plus the premium bonus the row already carried (scoreFit = ICP 60 + premium 20, max 100);
--   * then qualify(): budget>=60 AND fit>=50 → Discovered; budget>=40 → BacklogV3; else Dropped.
-- The ICP list below MUST equal ICP_SECTOR_VALUES in src/scoring/sector.js — a test enforces it.

create or replace function public.rana_v3_regrade(
  old_sector text, new_sector text,
  old_fit int, new_fit int,
  budget int
) returns table (fit_score int, status text)
language sql immutable as $$
  with icp(list) as (
    select array[
      'premium_restaurant','cafe','hotel','horeca',
      'fashion_retail','jewelry',
      'factory','manufacturing','manufacturer',
      'fmcg','packaged_fmcg',
      'b2b_services',
      'automotive','automotive_showroom','auto_service',
      'furniture_home','electronics_appliances','construction_materials','travel_tourism'
    ]::text[]
  ),
  fit as (
    select case
      when new_sector is distinct from old_sector and new_fit is not distinct from old_fit then
        least(100,
          (case when new_sector = any(icp.list) then 60 else 0 end)
          + greatest(0, coalesce(old_fit, 0) - (case when old_sector = any(icp.list) then 60 else 0 end)))
      else new_fit
    end as f
    from icp
  )
  select f,
    case when coalesce(budget, 0) >= 60 and coalesce(f, 0) >= 50 then 'Discovered'
         when coalesce(budget, 0) >= 40 then 'BacklogV3'
         else 'Dropped' end
  from fit;
$$;

create or replace function public.rana_v3_regrade_trigger() returns trigger
language plpgsql as $$
declare r record;
begin
  if NEW.source is distinct from 'rana-v3' then return NEW; end if;
  if OLD.status not in ('Discovered', 'BacklogV3') then return NEW; end if;
  if NEW.status is distinct from OLD.status then return NEW; end if;   -- the writer chose a status
  if NEW.sector is not distinct from OLD.sector
     and NEW.fit_score is not distinct from OLD.fit_score
     and NEW.budget_score is not distinct from OLD.budget_score then return NEW; end if;
  select * into r from public.rana_v3_regrade(OLD.sector, NEW.sector, OLD.fit_score, NEW.fit_score, NEW.budget_score);
  NEW.fit_score := r.fit_score;
  NEW.status := r.status;
  return NEW;
end $$;

drop trigger if exists rana_v3_regrade on public.leads;
create trigger rana_v3_regrade
  before update of sector, fit_score, budget_score on public.leads
  for each row execute function public.rana_v3_regrade_trigger();
