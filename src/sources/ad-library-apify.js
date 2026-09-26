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
import { isHardBlocked, scoreBudget, scoreFit, scoreSize, qualify, inferSector } from '../scoring/dimensions.js';
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

// Apify list pricing for this actor, confirmed from its pricingInfos 2026-09-24.
// `usageTotalUsd` on a run does NOT include per-event dataset charges, so budget
// against these rates rather than what the run reports.
const USD_PER_AD    = 0.00075;
const USD_PER_START = 0.00005;
const MONTHLY_BUDGET_USD = parseFloat(process.env.APIFY_MONTHLY_BUDGET_USD || '5');
const BUDGET_ALERT_USD   = parseFloat(process.env.APIFY_BUDGET_ALERT_USD   || '4');

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

async function runActorBatch(terms) {
  const memory = memoryForUrls(terms.length);
  const maxItems = 30 * terms.length;
  const started = await apifyFetch(`/acts/${ACTOR}/runs?timeout=600&memory=${memory}&maxItems=${maxItems}`, {
    method: 'POST',
    body: JSON.stringify({
      urls: terms.map(t => ({ url: adLibraryUrl(t) })),
      count: 30,
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

async function page(subject, body) {
  logger.error({ subject, body }, 'PAGE');
  // Telegram is the intended critical transport but its bot token is still
  // outstanding, so fall back to Whapi when this service has been given one.
  // Absent both, the halt is still recorded in rana_v3_runs.halt_reason.
  const token = process.env.WHAPI_TOKEN;
  const phone = (process.env.YOUSIF_PHONE || '').replace(/^\+/, '');
  if (!token || !phone) {
    logger.error('PAGE not delivered — no WHAPI_TOKEN/YOUSIF_PHONE configured on rana-v3');
    return false;
  }
  try {
    const r = await fetch('https://gate.whapi.cloud/messages/text', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: phone, body: `🚨 ${subject}\n\n${body}` }),
    });
    if (!r.ok) { logger.error({ status: r.status }, 'PAGE send failed'); return false; }
    return true;
  } catch (e) {
    logger.error({ err: e.message }, 'PAGE send threw');
    return false;
  }
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

  // --- budget guard, BEFORE spending anything -------------------------------
  const mtd = await monthToDateUsd();
  const day = new Date().getUTCDate();
  const daysInMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)).getUTCDate();
  const estimateThisRun = terms.length * 10 * USD_PER_AD + Math.ceil(terms.length / 4) * USD_PER_START;
  const projected = day > 0 ? ((mtd + estimateThisRun) / day) * daysInMonth : mtd;
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
  const ads = [];
  let starts = 0;
  for (let i = 0; i < terms.length; i += 4) {
    const slice = terms.slice(i, i + 4);
    const { items } = await runActorBatch(slice);
    starts++;
    ads.push(...items);
  }
  // the actor can return the same ad for overlapping terms
  const seenAd = new Set();
  const uniqueAds = ads.filter(a => {
    const k = a.ad_archive_id;
    if (!k || seenAd.has(k)) return false;
    seenAd.add(k); return true;
  });
  m.ads_returned = uniqueAds.length;
  m.apify_cost_usd = Number((uniqueAds.length * USD_PER_AD + starts * USD_PER_START).toFixed(5));

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
      });
    }
    const a = byAdvertiser.get(key);
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
      logger.info({ name: a.name }, 'ICP hard block — no row written');
      continue;
    }
    m.icp_allowed++;

    // measured across every ICP-allowed advertiser, before any activity gate
    if (a.is_whatsapp_cta) m.ctwa_advertisers++;

    a.ad_count_proxy = Math.max(a.ad_count, a.collation_max);
    if (a.ad_count_proxy < ACTIVITY_MIN_ADS) { m.dropped_activity_gate++; continue; }

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
  for (const a of kept) {
    const advertiser = {
      name: a.name, categories: a.categories, creative_snippets: a.creative_snippets,
      ad_count: a.ad_count_proxy, ad_start_date: a.ad_start_date,
      facebook_page_id: a.facebook_page_id, facebook_page_url: a.facebook_page_url,
    };
    const budgetScore = scoreBudget(advertiser);
    const fitScore    = scoreFit(advertiser, '');
    const sizeScore   = scoreSize(a.ad_count_proxy);
    const status      = qualify(budgetScore, fitScore);
    if (status === 'Dropped') continue;

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
        if (existing.status === 'Discovered') fields.status = status;
        await enrichExisting(existing.id, fields);
        m.leads_enriched++;
      } else {
        await upsertLead({
          business_name: a.name,
          normalized_name: normalizeName(a.name),
          sector: inferSector(advertiser),
          discovery_source: 'ad_library_apify',
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
    icp_allowed_share: m.advertisers ? Number((m.icp_allowed / m.advertisers).toFixed(4)) : null,
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
