// Apify budget on Apify's own billing cycle (msg-124 #2a, Yousif 2026-10-08).
//
// Apify bills this account on a usage cycle that runs from the 18th to the 17th
// (/users/me/limits: 2026-09-18 → 2026-10-17), with a hard $5 limit per cycle. The old
// guard summed rana_v3_runs since the 1st of the CALENDAR month and projected to the
// calendar month-end. Those are different windows: spending the cycle's money before the
// 17th still counted against "October" after the reset, so any widening of supply would
// have made rana-v3 halt itself in late October with Apify money still unspent.
//
// Source of truth, in order:
//   1. Apify /users/me/limits — the cycle bounds, what has actually been billed in it
//      (every actor run on the account, dataset events included), and the account limit.
//   2. Fallback, if that call fails: the cycle computed from APIFY_CYCLE_START_DAY (18)
//      and the sum of rana_v3_runs.apify_cost_usd inside it.
const DAY_MS = 86_400_000;
export const DEFAULT_CYCLE_START_DAY = 18;

/** The cycle containing `now`: [start of startDay, start of the next startDay). */
export function cycleBounds(now = new Date(), startDay = DEFAULT_CYCLE_START_DAY) {
  const t = new Date(now).getTime();
  const d = new Date(t);
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), startDay);
  if (t < start) start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, startDay);
  const s = new Date(start);
  const end = Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, startDay) - 1;
  return { start: new Date(start), end: new Date(end) };
}

/** Nightly runs left in the cycle, tonight included (never less than 1). */
export function nightsLeftInCycle(now, end) {
  return Math.max(1, Math.ceil((new Date(end).getTime() - new Date(now).getTime()) / DAY_MS));
}

/**
 * Pure decision.
 *   spent        billed so far this cycle
 *   tonightUsd   tonight's worst case (every call at its cap + overshoot)
 *   nightUsd     what a typical night costs — the trailing actual average when known,
 *                tonight's worst case otherwise
 *   nightsLeft   tonight included
 * halt  → tonight's worst case would cross the budget: refuse to run.
 * alert → spent + nightsLeft × nightUsd crosses the alert line: page, run anyway.
 */
export function budgetCheck({ spent, tonightUsd, nightUsd, nightsLeft, budgetUsd, alertUsd }) {
  const projected = spent + nightsLeft * (nightUsd ?? tonightUsd);
  return { halt: spent + tonightUsd > budgetUsd, alert: projected > alertUsd, projected };
}

/** Apify's own view of the cycle. Returns null on any failure — the caller falls back. */
export async function readApifyCycle(apifyFetch) {
  try {
    const res = await apifyFetch('/users/me/limits');
    if (!res.ok) return null;
    const d = (await res.json())?.data;
    const c = d?.monthlyUsageCycle;
    const spent = Number(d?.current?.monthlyUsageUsd);
    if (!c?.startAt || !c?.endAt || !Number.isFinite(spent)) return null;
    const limit = Number(d?.limits?.maxMonthlyUsageUsd);
    return { start: new Date(c.startAt), end: new Date(c.endAt), spent, limitUsd: Number.isFinite(limit) ? limit : null, basis: 'apify_limits' };
  } catch {
    return null;
  }
}
