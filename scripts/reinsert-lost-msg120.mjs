// msg-120 #1 — re-insert the advertisers rana-v3 lost to the emoji-cut insert failure
// (10-01..10-04, result-114 "msg-116 WAVE 1" #1). One-off.
//
// Same path as runSource (src/sources/ad-library-apify.js) for these advertisers only:
// group ads → ICP hard block → activity gate → dedup → classifySector (Haiku fallback)
// → budget/fit/size → qualify → Whapi lookup (POST /contacts, sends nothing) → upsertLead.
// stage8 (rana-v2, 03:00) then does Places + the WhatsApp verify + lead_score + status,
// exactly as for any other new rana-v3 lead.
//
// Ads come from the Apify datasets of the nights each advertiser failed; all of an
// advertiser's ads across those nights are merged (deduped by ad_archive_id).
//
// Run with rana-v3's env:  railway run --service <rana-v3> -- node scripts/reinsert-lost-msg120.mjs [--write]
// Without --write it prints what it would insert and writes nothing.
import { init as initDb, upsertLead } from '../src/lib/supabase.js';
import { init as initClaude, haikuShort } from '../src/lib/claude.js';
import { findExisting, normalizeName } from '../src/lib/dedup.js';
import { isHardBlocked, scoreBudget, scoreFit, scoreSize, qualify } from '../src/scoring/dimensions.js';
import { classifySector } from '../src/scoring/sector.js';
import { pickPrimaryHook } from '../src/scoring/primary-hook.js';
import { extractPhones, whapiValidate, classifyWriteError } from '../src/sources/ad-library-apify.js';
import { truncateText } from '../src/util/text.js';

const WRITE = process.argv.includes('--write');
const ACTOR = 'curious_coder~facebook-ads-library-scraper';
const H = { Authorization: `Bearer ${process.env.APIFY_API_TOKEN}` };
const apify = async (p) => (await fetch(`https://api.apify.com/v2${p}`, { headers: H })).json();

// page_id → the advertiser as named in the run's write_failures
const LOST = {
  '273721383502207': 'شركة الرضوان العالميه',          // 10-01, 10-03
  '1258076600712907': 'معهد نوبل Nobel Institute',     // 10-02
  '718604591337277': 'لمسه منزليه للاثاث',             // 10-02
  '938438716019723': 'مطبعة وادي الرافدين',            // 10-03
  '677416785455841': 'معرض الأمير للأنارة الحديثة',     // 10-03
  '101593882732343': 'تجهيزات تازة الغذائية',          // 10-04
};

initDb(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
initClaude();

// --- collect every ad of the lost advertisers from the 10-01..10-04 runs -----------
const runs = (await apify(`/acts/${ACTOR}/runs?desc=1&limit=60`)).data.items
  .filter(r => r.startedAt >= '2026-10-01T00:00:00Z' && r.startedAt < '2026-10-05T00:00:00Z' && r.status === 'SUCCEEDED');
const byPage = new Map();   // page_id → { ads: Map(ad_archive_id → item), calls: [{terms, startedAt}] }
for (const r of runs) {
  const input = await apify(`/key-value-stores/${r.defaultKeyValueStoreId}/records/INPUT`);
  const terms = (input?.urls || []).map(u => new URL(u.url).searchParams.get('q'));
  const items = await apify(`/datasets/${r.defaultDatasetId}/items?limit=1000`);
  if (!Array.isArray(items)) { console.log('dataset gone:', r.id, r.startedAt); continue; }
  for (const it of items) {
    if (!it || it.error || !LOST[String(it.page_id)]) continue;
    const e = byPage.get(String(it.page_id)) || byPage.set(String(it.page_id), { ads: new Map(), calls: [] }).get(String(it.page_id));
    if (it.ad_archive_id && !e.ads.has(it.ad_archive_id)) e.ads.set(it.ad_archive_id, it);
    if (!e.calls.some(c => c.run === r.id)) e.calls.push({ run: r.id, terms, startedAt: r.startedAt });
  }
}

// --- group exactly as runSource does ----------------------------------------------
const advertisers = [];
for (const [pageId, e] of byPage) {
  const a = {
    name: null, facebook_page_id: pageId, facebook_page_url: null, categories: [],
    ad_count: 0, collation_max: 0, creative_snippets: [], bodies: [], phones: new Set(),
    is_whatsapp_cta: false, ad_start_date: null, calls: e.calls,
  };
  // oldest first, so snippets/start date read as the first failing night's would
  const ads = [...e.ads.values()].sort((x, y) => String(x.start_date_formatted).localeCompare(String(y.start_date_formatted)));
  for (const it of ads) {
    a.name ??= it.page_name || it.snapshot?.page_name || null;
    a.facebook_page_url ??= it.snapshot?.page_profile_uri ?? null;
    if (!a.categories.length) a.categories = it.snapshot?.page_categories ?? [];
    a.ad_count++;
    if (Number.isFinite(it.collation_count)) a.collation_max = Math.max(a.collation_max, it.collation_count);
    if (it.snapshot?.cta_type === 'WHATSAPP_MESSAGE') a.is_whatsapp_cta = true;
    const body = it.snapshot?.body?.text || '';
    if (body) {
      a.bodies.push(body);
      if (a.creative_snippets.length < 3) a.creative_snippets.push(truncateText(body, 100));
    }
    for (const p of extractPhones(body)) a.phones.add(p);
    if (it.start_date_formatted && !a.ad_start_date) a.ad_start_date = it.start_date_formatted.slice(0, 10);
  }
  advertisers.push(a);
}
const missing = Object.entries(LOST).filter(([id]) => !byPage.has(id)).map(([, n]) => n);

// discovery_terms: a single-term call names its term exactly; otherwise the batch's terms
const termsOf = (calls) => {
  const exact = calls.filter(c => c.terms.length === 1).map(c => c.terms[0]);
  return [...new Set(exact.length ? exact : calls.flatMap(c => c.terms))];
};

// --- Whapi lookup on every ad-copy phone (lookup only) ----------------------------
const allPhones = [...new Set(advertisers.flatMap(a => [...a.phones]))];
const { checked, valid } = await whapiValidate(allPhones);

// --- gate, score, write -----------------------------------------------------------
const res = { landed: 0, insert_failed: 0, write_errors: 0, skipped: [], rows: [] };
for (const a of advertisers) {
  const out = { name: a.name, page_id: a.facebook_page_id, ads: a.ad_count, nights: a.calls.map(c => c.startedAt.slice(0, 10)) };
  res.rows.push(out);
  const probe = { name: a.name, categories: a.categories, creative_snippets: [...a.creative_snippets, ...a.bodies] };
  if (isHardBlocked(probe, '')) { out.result = 'ICP hard block — not written'; continue; }
  const adCountProxy = Math.max(a.ad_count, a.collation_max);
  const existing = await findExisting({ name: a.name, facebook_page_id: a.facebook_page_id });
  if (existing) { out.result = `already in leads (${existing.id}, ${existing.status}) — not written`; continue; }

  const advertiser = { name: a.name, categories: a.categories, creative_snippets: a.creative_snippets, bodies: a.bodies,
    ad_count: adCountProxy, ad_start_date: a.ad_start_date, facebook_page_id: a.facebook_page_id, facebook_page_url: a.facebook_page_url };
  const sec = await classifySector(advertiser, { llm: (p) => haikuShort(p) });
  const budget = scoreBudget(advertiser), fit = scoreFit(advertiser, '', sec.sector), size = scoreSize(adCountProxy);
  const status = qualify(budget, fit);
  const phones = [...a.phones];
  const rawPhone = phones.length ? phones[0].replace(/^\+/, '') : null;
  Object.assign(out, { sector: sec.sector, sector_via: sec.via, budget, fit, size, status,
    phones, whapi: phones.map(p => `${p}:${valid.has(p) ? 'valid' : 'not valid/unknown'}`),
    // stage8's calcLeadScore before the Places rating bonus (rating adds up to +10)
    lead_score_before_rating: Math.round(budget * 0.4 + fit * 0.3 + size * 0.2),
    discovery_terms: termsOf(a.calls), whatsapp_cta: a.is_whatsapp_cta });
  if (status === 'Dropped') { out.result = 'Dropped by qualify — not written'; continue; }
  if (!WRITE) { out.result = 'DRY RUN — would insert'; continue; }
  try {
    await upsertLead({
      business_name: a.name, normalized_name: normalizeName(a.name), sector: sec.sector,
      discovery_source: 'ad_library_apify', discovery_terms: termsOf(a.calls), status,
      running_ads: true, whatsapp_cta: a.is_whatsapp_cta ? true : null, ad_count: adCountProxy,
      ad_creative_urls: a.creative_snippets.map(s => truncateText(s, 500)), ad_start_date: a.ad_start_date,
      facebook_page_id: a.facebook_page_id, facebook_page_url: a.facebook_page_url,
      phone: rawPhone, ad_copy_phone: rawPhone,
      budget_score: budget, fit_score: fit, size_score: size,
      primary_hook: pickPrimaryHook({ discovery_source: 'ad_library' }),
    });
    res.landed++; out.result = 'INSERTED';
  } catch (err) {
    const kind = classifyWriteError(err);
    kind === 'insert_failed' ? res.insert_failed++ : res.write_errors++;
    out.result = `${kind}: ${err.message}`;
  }
}
console.log(JSON.stringify({ write: WRITE, runs_read: runs.length, missing_payloads: missing, whapi_checked: checked, whapi_valid: valid.size,
  landed: res.landed, insert_failed: res.insert_failed, write_errors: res.write_errors, rows: res.rows }, null, 1));
