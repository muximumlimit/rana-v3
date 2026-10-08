// msg-124 #2d — one-off probe of candidate search terms for the 4 uncovered ICP sectors.
// One Apify call per term (count 30). Writes NOTHING to Supabase: it reads `leads` to
// tell new advertisers/phones from known ones. Run: railway run --service <rana-v3> node scripts/probe-terms-msg124.mjs <out.json>
import fs from 'fs';
import { extractPhones, apifyFetch, memoryForUrls } from '../src/sources/ad-library-apify.js';
import { isHardBlocked } from '../src/scoring/dimensions.js';

const TERMS = process.env.PROBE_TERMS ? JSON.parse(process.env.PROBE_TERMS) : [
  'اثاث بغداد', 'معرض اثاث بغداد',                 // furniture_home
  'اجهزة كهربائية بغداد', 'اجهزة منزلية بغداد',     // electronics_appliances
  'مواد بناء بغداد', 'مواد انشائية بغداد',           // construction_materials
  'سفر وسياحة بغداد', 'شركة سياحة بغداد',            // travel_tourism
];
const ACTOR = 'curious_coder~facebook-ads-library-scraper';
const url = t => `https://www.facebook.com/ads/library/?ad_type=all&country=IQ&q=${encodeURIComponent(t)}&active_status=active&media_type=all`;

async function run(term) {
  const s = await (await apifyFetch(`/acts/${ACTOR}/runs?timeout=600&memory=${memoryForUrls(1)}&maxItems=30`, {
    method: 'POST', body: JSON.stringify({ urls: [{ url: url(term) }], count: 30, 'scrapePageAds.activeStatus': 'active' }) })).json();
  const id = s.data?.id; let st = s.data?.status;
  for (let i = 0; i < 60 && ['READY', 'RUNNING'].includes(st); i++) { await new Promise(r => setTimeout(r, 10000)); st = (await (await apifyFetch(`/actor-runs/${id}`)).json()).data?.status; }
  const meta = (await (await apifyFetch(`/actor-runs/${id}`)).json()).data;
  const items = await (await apifyFetch(`/datasets/${meta.defaultDatasetId}/items?limit=1000`)).json();
  return { status: st, items: (Array.isArray(items) ? items : []).filter(x => x && x.ad_archive_id) };
}

const sb = async (q) => (await fetch(`${process.env.SUPABASE_URL}/rest/v1/${q}`, { headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } })).json();
const known = new Set(), knownPages = new Set();
for (let off = 0; ; off += 1000) {
  const rows = await sb(`leads?select=phone,phone_e164,facebook_page_id&offset=${off}&limit=1000`);
  for (const l of rows) { for (const v of [l.phone, l.phone_e164]) { const d = String(v || '').replace(/\D/g, ''); if (d.length >= 10) known.add(d.slice(-10)); } if (l.facebook_page_id) knownPages.add(String(l.facebook_page_id)); }
  if (rows.length < 1000) break;
}

const out = [];
for (const term of TERMS) {
  const { status, items } = await run(term);
  const adv = new Map();
  for (const it of items) {
    const k = String(it.page_id || it.page_name);
    const a = adv.get(k) || { name: it.page_name, page: String(it.page_id || ''), cats: it.snapshot?.page_categories || [], bodies: [], phones: new Set() };
    const body = it.snapshot?.body?.text || ''; a.bodies.push(body); for (const p of extractPhones(body)) a.phones.add(p);
    adv.set(k, a);
  }
  const list = [...adv.values()].map(a => {
    const blocked = isHardBlocked({ name: a.name, categories: a.cats, creative_snippets: a.bodies }, '');
    const newPage = !knownPages.has(a.page);
    const newPhone = [...a.phones].some(p => !known.has(p.replace(/\D/g, '').slice(-10)));
    return { name: a.name, cats: a.cats.join('/'), blocked, newPage, phone: a.phones.size > 0, newPhone };
  });
  const r = { term, status, ads: items.length, hit_cap: items.length >= 30, advertisers: list.length,
    blocked: list.filter(x => x.blocked).length,
    new_with_phone: list.filter(x => !x.blocked && x.newPage && x.newPhone).length,
    known: list.filter(x => !x.newPage).length, list };
  out.push(r);
  console.log(`${term} | ${status} | ads ${r.ads}${r.hit_cap ? ' (cap)' : ''} | adv ${r.advertisers} | blocked ${r.blocked} | known ${r.known} | NEW+phone ${r.new_with_phone}`);
}
fs.writeFileSync(process.argv[2] || 'probe-terms.json', JSON.stringify(out, null, 1), 'utf8');
const ads = out.reduce((s, r) => s + r.ads, 0);
console.log(`total ads ${ads} ≈ $${(ads * 0.00075 + out.length * 0.00005).toFixed(4)}`);
