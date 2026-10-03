// Meta Ad Library via the Apify actor, as an alternative to the Firecrawl +
// Haiku path in ./meta-ad-library.js. Env-gated by AD_LIBRARY_SOURCE; the
// Firecrawl source stays in place and is still the default.
//
// Why this exists (measured 2026-09-24, 15 terms, 128 ads, Iraq):
//   77.5% of advertisers print a reachable mobile in their own ad copy
//   95% of a 20-number sample were WhatsApp-valid
//   97.5% of numbers found were not already in `leads` (a FIRST-RUN rate — it decays)
//   ~$0.10/night at list rate
// The phones live in snapshot.body.text, which the Firecrawl path never sees
// because creative_snippets truncates each ad to 100 chars.
//
// What this source does NOT do, deliberately:
//   - it never writes phone_e164. Phones land in the raw `phone` column only, so
//     they cannot reach lara-v2's blast pool (crm.js:110 requires phone_e164).
//     There is no promotion path in this build.
//   - it never writes status 'Qualified'.
import { findExisting, normalizeName } from '../lib/dedup.js';
import { upsertLead, enrichExisting, getClient } from '../lib/supabase.js';
import { isHardBlocked, scoreBudget, scoreFit, scoreSize, qualify, regradeStatus } from '../scoring/dimensions.js';
import { classifySector, factoryInName } from '../scoring/sector.js';
import { haikuShort } from '../lib/claude.js';
import { pageCritical } from '../lib/alert.js';
import { pickPrimaryHook } from '../scoring/primary-hook.js';
import logger from '../util/logger.js';

const ACTOR = 'curious_coder~facebook-ads-library-scraper';
const APIFY_BASE = 'https://api.apify.com/v2';
// The Firecrawl source uses ACTIVITY_MIN_ADS=3 because Haiku reads the "N ads use
// this creative" count off the rendered page. The Apify actor gives no per-advertiser
// total: `ads_count` is always 1 (it is per-ad), and `total` is the search-wide
// result count (594 on every row). With maxItems=30/term spread over ~8-10
// advertisers we only sample 1-2 ads each, so a >=3 gate filters on a sampling
// artifact — it discarded 93% of advertisers (84 -> 6) on the first live run.
// Default 1 here: the Ad Library query is already active_status=active, so presence
// alone proves the advertiser is spending right now. Quality still gates downstream
// in qualify(), which needs budget>=60 AND fit>=50.
const ACTIVITY_MIN_ADS = parseInt(process.env.APIFY_ACTIVITY_MIN_ADS, 10) || 1;
// Haiku sector calls per run, for advertisers the category lookup and ad-copy
// keywords leave unresolved. Measured residue on the 09-24..26 backfill: see
// bridge/sector-backfill. Past the cap a lead is written with sector NULL, as before.
const SECTOR_LLM_MAX = parseInt(process.env.SECTOR_LLM_MAX, 10) || 60;

// Apify list pricing for this actor, confirmed from its pricingInfos 2026-09-24.
// `usageTotalUsd` on a run does NOT include per-event dataset charges, so budget
// against these rates rather than what the run reports.
const USD_PER_AD    = 0.00075;
const USD_PER_START = 0.00005;
const MONTHLY_BUDGET_USD = parseFloat(process.env.APIFY_MONTHLY_BUDGET_USD || '5');
const BUDGET_ALERT_USD   = parseFloat(process.env.APIFY_BUDGET_ALERT_USD   || '4');

// `count: 30` caps a whole actor CALL, not each URL in it (actor input schema; the
// per-URL cap is a separate `limitPerSource`). Measured 28-33 ads per 4-term call on
// every night 09-25..09-30: four terms were sharing ~30 ads, so a term later in a
// batch was starved, not thin. The actor overshoots its cap by up to 3 (33 on a
// 30 cap, the observed max) — budgeted on every call.
const ADS_PER_CALL = 30;
const ADS_OVERSHOOT = 3;
const TERMS_PER_BATCH = 4;

// ---------------------------------------------------------------------------
// call plan + term attribution (Yousif 2026-10-03)
// ---------------------------------------------------------------------------
// The 4-night per-term test (10-01..10-04) answered it: of the 8 factory terms only
// مصنع بغداد and معمل بغداد hit the 30-ad cap (10-02: 30 ads each; معمل بغداد alone
// gave 16 new names, 12 factory-named). The other 6 returned 0-12 ads per call —
// thin, not starved. So, permanently:
//   - `factory_solo_terms` get their OWN call with a larger allowance
//     (`factory_solo_ads`, env APIFY_FACTORY_SOLO_ADS) — exact term attribution.
//   - tonight's other factory terms share ONE batch of their own. Their measured
//     sum is <=15 ads, half of a 30 cap, so nothing in it is starved. They are never
//     mixed into a general batch: those hit the cap every night and would starve them.
//   - the general terms stay in 4-term batches, unchanged.
// There is no end date. APIFY_FACTORY_PER_TERM=false (the existing kill switch) puts
// the solo terms back into the factory batch at 30 ads — the pre-test plan exactly.
export function soloTermsTonight(targets, terms, now = new Date(), env = process.env) {
  if (env.APIFY_FACTORY_PER_TERM === 'false') return [];
  const solo = new Set(targets.factory_solo_terms || []);
  return terms.filter(t => solo.has(t));
}

export function soloAdsAllowance(targets, env = process.env) {
  const n = parseInt(env.APIFY_FACTORY_SOLO_ADS, 10) || targets.factory_solo_ads || ADS_PER_CALL;
  return Math.max(ADS_PER_CALL, n);
}

/**
 * @param terms        tonight's terms, in rotation order
 * @param soloTerms    terms that get their own call
 * @param opts.factory the factory term list — non-solo factory terms are batched apart
 * @param opts.soloAds the solo calls' allowance (actor `count`)
 * @returns [{terms, solo, ads}]  ads = the call's cap
 */
export function planCalls(terms, soloTerms = [], { factory = [], soloAds = ADS_PER_CALL } = {}) {
  const solo = new Set(soloTerms);
  const fac = new Set(factory);
  const calls = terms.filter(t => solo.has(t)).map(t => ({ terms: [t], solo: true, ads: soloAds }));
  const batch = (list) => {
    for (let i = 0; i < list.length; i += TERMS_PER_BATCH) calls.push({ terms: list.slice(i, i + TERMS_PER_BATCH), solo: false, ads: ADS_PER_CALL });
  };
  batch(terms.filter(t => !solo.has(t) && fac.has(t)));
  batch(terms.filter(t => !solo.has(t) && !fac.has(t)));
  return calls;
}

const callUsd = (c) => ((c.ads ?? ADS_PER_CALL) + ADS_OVERSHOOT) * USD_PER_AD + USD_PER_START;
// Worst case for one night: every call returns its cap plus the overshoot.
export const estimateRunUsd = (calls) => calls.reduce((s, c) => s + callUsd(c), 0);

// Month-end spend if every remaining night (tonight included) runs at tonight's
// worst case. Nights are symmetric by construction — 4 factory slots alternate the
// two halves of factory_terms, each half holding exactly one solo term — so tonight's
// plan prices every night (a test pins the symmetry).
export function projectMonthUsd({ mtd, now = new Date(), nightUsd }) {
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return mtd + (last - now.getUTCDate() + 1) * nightUsd;
}

// Which search term found an advertiser. A solo call names its term exactly, so if
// any solo call returned it, those terms are the answer. Otherwise it came only from
// 4-term batches and the honest answer is the batch: every term in it. One element =
// exact attribution.
export function termsFor(callIdxs, calls) {
  const hits = [...callIdxs].sort((a, b) => a - b).map(i => calls[i]);
  const exact = hits.filter(c => c.solo).map(c => c.terms[0]);
  return [...new Set(exact.length ? exact : hits.flatMap(c => c.terms))];
}

// Per-call yield for rana_v3_runs.metadata.per_call. hit_cap = the call returned its
// full allowance, so the term has at least that many live ads (starved by our cap);
// under the cap, Meta ran out (thin).
export function perCallStats(calls, callAds, advertisers) {
  return calls.map((c, i) => {
    const mine = advertisers.filter(a => a.calls.has(i));
    const names = (o) => mine.filter(a => a.outcome === o).map(a => a.name);
    return {
      terms: c.terms, solo: c.solo, ok: callAds[i].ok,
      allowance: c.ads ?? ADS_PER_CALL,
      ads: callAds[i].count, hit_cap: callAds[i].count >= (c.ads ?? ADS_PER_CALL),
      advertisers: mine.length,
      factory_named: mine.filter(a => a.factory_named).length,
      new: names('new'), reseen: names('reseen'),
      blocked: names('blocked').length, dropped: names('dropped').length,
    };
  });
}

// ---------------------------------------------------------------------------
// phone extraction from ad copy
// ---------------------------------------------------------------------------
const AR_DIGITS = {
  '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
  '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9',
};
const toAsciiDigits = s => String(s || '').replace(/[٠-٩۰-۹]/g, d => AR_DIGITS[d] ?? d);

// Iraqi mobiles appear as 07XXXXXXXXX, 7XXXXXXXXX or 9647XXXXXXXXX, frequently with
// space or dash separators. Dots are NOT accepted as separators because prices use
// them (`٨.٠٠٠ الف`) and would otherwise parse as numbers.
export function extractPhones(text) {
  const t = toAsciiDigits(text);
  const raw = new Set();
  for (const m of t.matchAll(/wa\.me\/(\+?\d{8,15})/gi)) raw.add(m[1]);
  for (const m of t.matchAll(/api\.whatsapp\.com\/send\?phone=(\+?\d{8,15})/gi)) raw.add(m[1]);
  for (const m of t.matchAll(/(?:\+?964[\s-]?|\b0)(7[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d)\b/g)) {
    raw.add(m[0].replace(/[\s-]/g, ''));
  }
  const out = new Set();
  for (const r of raw) {
    const d = r.replace(/\D/g, '');
    if (/^9647\d{8,9}$/.test(d))   out.add('+' + d);
    else if (/^07\d{9}$/.test(d))  out.add('+964' + d.slice(1));
    else if (/^7\d{9}$/.test(d))   out.add('+964' + d);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Apify run mechanics
// ---------------------------------------------------------------------------
const adLibraryUrl = term =>
  `https://www.facebook.com/ads/library/?ad_type=all&country=IQ&q=${encodeURIComponent(term)}&active_status=active&media_type=all`;

// The actor rejects a memory value that is not a power of two, AND requires at
// least one input URL per 512MB. Both were violated on the first attempt (3 URLs
// at 1536MB) and the whole batch failed silently. Largest valid power-of-two
// memory for n URLs is 512 * 2^floor(log2(n)).
export function memoryForUrls(n) {
  return 512 * Math.pow(2, Math.floor(Math.log2(Math.max(1, n))));
}

async function apifyFetch(path, opts = {}) {
  const res = await fetch(`${APIFY_BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.APIFY_API_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return res;
}

async function runActorBatch(terms, count = ADS_PER_CALL) {
  const memory = memoryForUrls(terms.length);
  // maxItems must not undercut `count` on a 1-URL solo call with a larger allowance.
  const maxItems = Math.max(30 * terms.length, count);
  const started = await apifyFetch(`/acts/${ACTOR}/runs?timeout=600&memory=${memory}&maxItems=${maxItems}`, {
    method: 'POST',
    body: JSON.stringify({
      urls: terms.map(t => ({ url: adLibraryUrl(t) })),
      count,
      'scrapePageAds.activeStatus': 'active',
    }),
  });
  const started_j = await started.json();
  if (!started_j.data) {
    logger.error({ terms, body: JSON.stringify(started_j).slice(0, 300) }, 'apify run failed to start');
    return { items: [], ok: false };
  }
  const runId = started_j.data.id;
  let status = started_j.data.status;
  for (let i = 0; i < 60 && ['READY', 'RUNNING'].includes(status); i++) {
    await new Promise(r => setTimeout(r, 10000));
    const p = await (await apifyFetch(`/actor-runs/${runId}`)).json();
    status = p.data?.status;
  }
  const meta = await (await apifyFetch(`/actor-runs/${runId}`)).json();
  if (status !== 'SUCCEEDED') {
    logger.error({ runId, status, terms }, 'apify run did not succeed');
    return { items: [], ok: false };
  }
  const items = await (await apifyFetch(`/datasets/${meta.data.defaultDatasetId}/items?limit=1000`)).json();
  const clean = Array.isArray(items) ? items.filter(x => x && !x.error) : [];
  logger.info({ runId, terms: terms.length, items: clean.length, memory }, 'apify batch complete');
  return { items: clean, ok: true };
}

// ---------------------------------------------------------------------------
// budget guard
// ---------------------------------------------------------------------------
async function monthToDateUsd() {
  const supabase = getClient();
  const start = new Date();
  start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('rana_v3_runs')
    .select('apify_cost_usd')
    .gte('started_at', start.toISOString())
    .eq('source', 'ad_library_apify');
  if (error) {
    logger.warn({ err: error.message }, 'month-to-date spend query failed — assuming 0');
    return 0;
  }
  return (data || []).reduce((s, r) => s + Number(r.apify_cost_usd || 0), 0);
}

// Telegram first, WhatsApp copy, one alert_log row (lib/alert.js, msg-107 Fix 4).
// The halt is also recorded in rana_v3_runs.halt_reason whatever happens here.
async function page(subject, body, kind = 'apify_budget') {
  const r = await pageCritical(subject, body, { kind });
  return r.delivered;
}

// ---------------------------------------------------------------------------
// Whapi validation — a LOOKUP. POST /contacts sends nothing to anyone.
// ---------------------------------------------------------------------------
async function whapiValidate(phones) {
  const token = process.env.WHAPI_TOKEN;
  if (!token || !phones.length) return { checked: 0, valid: new Set() };
  const cap = parseInt(process.env.RANA_V3_WHAPI_CHECK_CAP || '160', 10);
  const list = phones.slice(0, cap);
  const valid = new Set();
  for (let i = 0; i < list.length; i += 5) {
    const batch = list.slice(i, i + 5);
    await Promise.all(batch.map(async p => {
      try {
        const r = await fetch('https://gate.whapi.cloud/contacts', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contacts: [p], blocking: 'wait', force_check: false }),
        });
        if (!r.ok) return;
        const j = await r.json();
        if (j?.contacts?.[0]?.status === 'valid') valid.add(p);
      } catch { /* a failed check is simply "unknown", never a write */ }
    }));
    if (i + 5 < list.length) await new Promise(s => setTimeout(s, 10000));
  }
  logger.info({ checked: list.length, valid: valid.size }, 'whapi validation complete');
  return { checked: list.length, valid };
}

// ---------------------------------------------------------------------------
export async function runSource(targets, runState) {
  const supabase = getClient();
  const terms = targets.search_terms || [];
  const startedAt = new Date().toISOString();

  const m = {
    source: 'ad_library_apify', status: 'running', started_at: startedAt,
    terms_run: terms.length, ads_returned: 0, advertisers: 0, advertisers_with_phone: 0,
    phones_found: 0, phones_new: 0, new_rate: null, icp_allowed: 0, icp_blocked: 0,
    ctwa_advertisers: 0, whapi_checked: 0, whapi_valid: 0, leads_new: 0, leads_enriched: 0,
    apify_cost_usd: 0, month_to_date_usd: 0, projected_month_usd: 0, halt_reason: null,
  };
  // not columns — carried in metadata jsonb so no migration is needed
  m.dropped_activity_gate = 0;
  m.icp_blocked_on_stored_sector = 0;

  const soloTerms = soloTermsTonight(targets, terms);
  const calls = planCalls(terms, soloTerms, { factory: targets.factory_terms || [], soloAds: soloAdsAllowance(targets) });

  // --- budget guard, BEFORE spending anything -------------------------------
  const mtd = await monthToDateUsd();
  const day = new Date().getUTCDate();
  const daysInMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)).getUTCDate();
  const estimateThisRun = estimateRunUsd(calls);
  const projected = projectMonthUsd({ mtd, nightUsd: estimateThisRun });
  m.month_to_date_usd = Number(mtd.toFixed(4));
  m.projected_month_usd = Number(projected.toFixed(4));

  if (mtd + estimateThisRun > MONTHLY_BUDGET_USD) {
    m.status = 'halted';
    m.halt_reason = `month-to-date $${mtd.toFixed(4)} + this run ~$${estimateThisRun.toFixed(4)} would exceed APIFY_MONTHLY_BUDGET_USD $${MONTHLY_BUDGET_USD}`;
    logger.error({ mtd, estimateThisRun, MONTHLY_BUDGET_USD }, 'apify budget exceeded — refusing to run');
    await page('rana-v3 apify budget exceeded — run HALTED', m.halt_reason);
    await persist(supabase, m);
    return toResult(m);
  }
  if (projected > BUDGET_ALERT_USD) {
    await page('rana-v3 apify spend on track to exceed budget',
      `projected $${projected.toFixed(2)}/month vs alert threshold $${BUDGET_ALERT_USD} (free tier $${MONTHLY_BUDGET_USD}). month-to-date $${mtd.toFixed(4)} on day ${day}/${daysInMonth}. Run proceeding.`);
  }

  // --- fetch ----------------------------------------------------------------
  // One call per plan entry. Every item is tagged with the call that returned it:
  // the actor's items do not say which input URL they came from.
  logger.info({ calls: calls.map(c => c.terms), solo: soloTerms.length }, 'apify call plan');
  const ads = [];
  const callAds = [];
  const adCalls = new Map();   // ad_archive_id → Set(call index), across ALL calls
  for (let ci = 0; ci < calls.length; ci++) {
    const { items, ok } = await runActorBatch(calls[ci].terms, calls[ci].ads);
    callAds.push({ count: items.length, ok });
    for (const it of items) {
      if (it.ad_archive_id) (adCalls.get(it.ad_archive_id) || adCalls.set(it.ad_archive_id, new Set()).get(it.ad_archive_id)).add(ci);
      ads.push({ ...it, _call: ci });
    }
  }
  // the actor can return the same ad for overlapping terms
  const seenAd = new Set();
  const uniqueAds = ads.filter(a => {
    const k = a.ad_archive_id;
    if (!k || seenAd.has(k)) return false;
    seenAd.add(k); return true;
  });
  m.ads_returned = uniqueAds.length;
  // Billed per ad RETURNED: an ad two calls both returned is charged twice.
  m.apify_cost_usd = Number((ads.length * USD_PER_AD + calls.length * USD_PER_START).toFixed(5));

  // --- group into advertisers ----------------------------------------------
  const byAdvertiser = new Map();
  for (const it of uniqueAds) {
    const key = it.page_id || it.page_name;
    if (!key) continue;
    if (!byAdvertiser.has(key)) {
      byAdvertiser.set(key, {
        name: it.page_name || it.snapshot?.page_name || null,
        facebook_page_id: it.page_id ?? null,
        facebook_page_url: it.snapshot?.page_profile_uri ?? null,
        categories: it.snapshot?.page_categories ?? [],
        ad_count: 0,
        collation_max: 0,
        creative_snippets: [],
        bodies: [],
        phones: new Set(),
        is_whatsapp_cta: false,
        ad_start_date: null,
        calls: new Set(),       // indices into `calls` that returned any of its ads
        outcome: null,          // new | reseen | blocked | dropped — for per_call stats
      });
    }
    const a = byAdvertiser.get(key);
    for (const ci of adCalls.get(it.ad_archive_id) || []) a.calls.add(ci);
    a.ad_count++;
    // collation_count = how many ads share this creative. Combined with the number
    // of distinct ads we sampled it is the best available repeat-spend proxy.
    if (Number.isFinite(it.collation_count)) a.collation_max = Math.max(a.collation_max, it.collation_count);
    // cta_type is the authoritative CTWA signal. Do NOT infer it from the word
    // "WhatsApp" appearing on the page — that is usually publisher_platform, i.e.
    // where the ad was SHOWN, which is a different thing and ~2x more common.
    if (it.snapshot?.cta_type === 'WHATSAPP_MESSAGE') a.is_whatsapp_cta = true;
    const body = it.snapshot?.body?.text || '';
    if (body) {
      a.bodies.push(body);
      if (a.creative_snippets.length < 3) a.creative_snippets.push(body.slice(0, 100));
    }
    for (const p of extractPhones(body)) a.phones.add(p);
    if (it.start_date_formatted && !a.ad_start_date) a.ad_start_date = it.start_date_formatted.slice(0, 10);
  }
  m.advertisers = byAdvertiser.size;

  // --- gate FIRST, then measure phones on what survives ---------------------
  // Order matters: gating first means we never spend Whapi checks on advertisers
  // we are about to discard, and the reported rates describe leads we actually keep.
  const kept = [];
  for (const a of byAdvertiser.values()) {
    if (!a.name) continue;

    // ICP hard block at WRITE time. Body text is in the probe so a clinic that
    // only reveals itself in its ad copy is still caught — a cosmetic clinic must
    // never get a row, phone or not.
    const probe = { name: a.name, categories: a.categories, creative_snippets: [...a.creative_snippets, ...a.bodies] };
    if (isHardBlocked(probe, '')) {
      m.icp_blocked++;
      a.outcome = 'blocked';
      logger.info({ name: a.name }, 'ICP hard block — no row written');
      continue;
    }
    m.icp_allowed++;

    // measured across every ICP-allowed advertiser, before any activity gate
    if (a.is_whatsapp_cta) m.ctwa_advertisers++;

    a.ad_count_proxy = Math.max(a.ad_count, a.collation_max);
    if (a.ad_count_proxy < ACTIVITY_MIN_ADS) { m.dropped_activity_gate++; a.outcome = 'dropped'; continue; }

    kept.push(a);
  }

  const allPhonesSeen = [...new Set([...byAdvertiser.values()].flatMap(a => [...a.phones]))];
  const allPhones = [...new Set(kept.flatMap(a => [...a.phones]))];
  m.phones_found = allPhones.length;
  m.advertisers_with_phone = kept.filter(a => a.phones.size).length;

  const knownKeys = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('leads').select('phone, phone_e164').range(from, from + 999);
    if (error) { logger.warn({ err: error.message }, 'known-phone fetch failed'); break; }
    for (const l of data) for (const v of [l.phone_e164, l.phone]) {
      const d = String(v || '').replace(/\D/g, '');
      if (d.length >= 10) knownKeys.add(d.slice(-10));
    }
    if (data.length < 1000) break;
  }
  const isKnown = p => knownKeys.has(p.replace(/\D/g, '').slice(-10));
  const newPhones = allPhones.filter(p => !isKnown(p));
  m.phones_new = newPhones.length;
  m.new_rate = allPhones.length ? Number((newPhones.length / allPhones.length).toFixed(4)) : null;

  // --- optional Whapi validation (lookup only) ------------------------------
  const { checked, valid } = await whapiValidate(newPhones);
  m.whapi_checked = checked;
  m.whapi_valid = valid.size;

  // --- write ----------------------------------------------------------------
  const sectorVia = {};
  let sectorLlmCalls = 0, sectorLlmCost = 0;
  for (const a of kept) {
    const advertiser = {
      name: a.name, categories: a.categories, creative_snippets: a.creative_snippets,
      bodies: a.bodies,
      ad_count: a.ad_count_proxy, ad_start_date: a.ad_start_date,
      facebook_page_id: a.facebook_page_id, facebook_page_url: a.facebook_page_url,
    };
    // Classified ONCE; the same answer fills `sector` and drives fit.
    const llm = sectorLlmCalls < SECTOR_LLM_MAX
      ? async (p) => { sectorLlmCalls++; return haikuShort(p); }
      : null;
    const sec = await classifySector(advertiser, { llm });
    sectorLlmCost += sec.cost_usd || 0;
    sectorVia[sec.via ?? 'none'] = (sectorVia[sec.via ?? 'none'] || 0) + 1;

    const budgetScore = scoreBudget(advertiser);
    const fitScore    = scoreFit(advertiser, '', sec.sector);
    const sizeScore   = scoreSize(a.ad_count_proxy);
    const status      = qualify(budgetScore, fitScore);
    if (status === 'Dropped') { a.outcome = 'dropped'; continue; }

    // Raw `phone` ONLY. phone_e164 is never set by this source.
    const phones = [...a.phones];
    const rawPhone = phones.length ? phones[0].replace(/^\+/, '') : null;

    try {
      const existing = await findExisting({ name: a.name, facebook_page_id: a.facebook_page_id });

      // Second ICP gate, on the lead's STORED sector. The probe above only sees
      // what we scraped, so a lead already classified into a blocked sector could
      // still be enriched — reusing isHardBlocked on the sector string works
      // because 'beauty_clinic' tokenises to ['beauty','clinic'], both blocked.
      if (existing?.sector && isHardBlocked({ name: existing.sector, categories: [], creative_snippets: [] }, '')) {
        m.icp_blocked_on_stored_sector++;
        a.outcome = 'blocked';
        logger.info({ id: existing.id, sector: existing.sector, name: a.name }, 'existing lead is in a blocked sector — not enriched');
        continue;
      }

      if (existing) {
        const fields = {
          running_ads: true, ad_count: a.ad_count_proxy,
          facebook_page_id: a.facebook_page_id ?? existing.facebook_page_id,
          facebook_page_url: a.facebook_page_url ?? null,
          // discovery_source is deliberately NOT overwritten on enrich. It records
          // how a lead was FOUND, and clobbering it destroys provenance: a rana-v2
          // google_maps lead re-seen in the Ad Library would start reading as
          // ad_library_apify. That corruption already made an audit of this source
          // look like it had written phone_e164 six times when it had written none.
          // (The Firecrawl source in meta-ad-library.js still has this bug.)
          budget_score: budgetScore, fit_score: fitScore, size_score: sizeScore,
          primary_hook: 'running_ads', enriched_at: new Date().toISOString(),
        };
        if (a.is_whatsapp_cta) fields.whatsapp_cta = true;   // accumulating, never downgraded
        // Deliberately does NOT write `phone` onto an existing lead. findExisting()
        // does not select `phone`, so a "only fill if empty" guard would always read
        // undefined and would silently overwrite a real rana-v2 number with one
        // scraped from ad copy. New rows get the phone; existing rows keep theirs.
        if (rawPhone) logger.info({ id: existing.id, name: a.name }, 'ad-copy phone found for an existing lead — not written, existing phone preserved');
        // Re-grade Discovered AND BacklogV3 (was Discovered only): a BacklogV3 lead whose fit
        // rose was stranded there forever — stage8 only enriches Discovered.
        const regraded = regradeStatus(existing.status, budgetScore, fitScore);
        if (regraded) fields.status = regraded;
        await enrichExisting(existing.id, fields);
        m.leads_enriched++;
        a.outcome = 'reseen';
      } else {
        await upsertLead({
          business_name: a.name,
          normalized_name: normalizeName(a.name),
          sector: sec.sector,
          discovery_source: 'ad_library_apify',
          // The search term(s) that found it — one element = exact (migration 005).
          discovery_terms: termsFor(a.calls, calls),
          status,
          running_ads: true,
          whatsapp_cta: a.is_whatsapp_cta ? true : null,
          ad_count: a.ad_count_proxy,
          ad_creative_urls: a.creative_snippets.map(s => String(s).slice(0, 500)),
          ad_start_date: a.ad_start_date,
          facebook_page_id: a.facebook_page_id,
          facebook_page_url: a.facebook_page_url,
          phone: rawPhone,            // phone_e164 deliberately absent
          ad_copy_phone: rawPhone,    // provenance: survives anything later written to `phone`
          budget_score: budgetScore, fit_score: fitScore, size_score: sizeScore,
          primary_hook: pickPrimaryHook({ discovery_source: 'ad_library' }),
        });
        m.leads_new++;
        a.outcome = 'new';
      }
    } catch (err) {
      logger.error({ err: err.message, name: a.name }, 'write failed');
    }
  }

  m.status = 'success';
  m.metadata = {
    dropped_activity_gate: m.dropped_activity_gate,
    icp_blocked_on_stored_sector: m.icp_blocked_on_stored_sector,
    activity_min_ads: ACTIVITY_MIN_ADS,
    phones_seen_all_advertisers: allPhonesSeen.length,
    phones_on_kept_advertisers: allPhones.length,
    advertisers_kept: kept.length,
    whapi_valid_share: m.whapi_checked ? Number((m.whapi_valid / m.whapi_checked).toFixed(4)) : null,
    sector_via: sectorVia,                 // fb_category | ad_copy | llm | llm_unknown | llm_error | none
    sector_llm_calls: sectorLlmCalls,
    sector_llm_cost_usd: Number(sectorLlmCost.toFixed(5)),
    icp_allowed_share: m.advertisers ? Number((m.icp_allowed / m.advertisers).toFixed(4)) : null,
    ads_billed: ads.length,
    // Per-term yield: which terms are thin (under the cap) and which are starved (hit it).
    per_call: perCallStats(calls, callAds,
      [...byAdvertiser.values()].map(a => ({ name: a.name, calls: a.calls, outcome: a.outcome, factory_named: factoryInName(a.name) }))),
  };
  await persist(supabase, m);

  runState.whatsapp_cta_count = m.ctwa_advertisers;
  runState.new_number_rate    = m.new_rate;
  logger.info(m, 'ad-library-apify run complete');
  return toResult(m);
}

async function persist(supabase, m) {
  try {
    const row = { ...m, finished_at: new Date().toISOString() };
    // these live in metadata, not as columns
    delete row.dropped_activity_gate;
    delete row.icp_blocked_on_stored_sector;
    const { error } = await supabase.from('rana_v3_runs').insert([row]);
    if (error) logger.error({ err: error.message }, 'rana_v3_runs insert failed');
  } catch (e) {
    logger.error({ err: e.message }, 'rana_v3_runs insert threw');
  }
}

function toResult(m) {
  return {
    new_leads: m.leads_new,
    enriched_leads: m.leads_enriched,
    dropped: m.icp_blocked + (m.dropped_activity_gate || 0),
    dropped_hard_block: m.icp_blocked,
    dropped_activity_gate: m.dropped_activity_gate || 0,
    whatsapp_cta_count: m.ctwa_advertisers,
    new_number_rate: m.new_rate,
    phones_found: m.phones_found,
    phones_new: m.phones_new,
    whapi_checked: m.whapi_checked,
    whapi_valid: m.whapi_valid,
    total_cost_usd: m.apify_cost_usd,
    firecrawl_failed: false,
    halted: m.status === 'halted',
    halt_reason: m.halt_reason,
  };
}
