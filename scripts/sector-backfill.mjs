// Sector backfill for ad_library_apify leads, from the Apify snapshot taken
// 2026-09-26 (bridge/sector-backfill/apify-snapshot-2026-09-26.json) — the live
// datasets expire ~7 days after each run.
//
//   node scripts/sector-backfill.mjs            DRY RUN: classify + report, writes nothing to leads
//   node scripts/sector-backfill.mjs --write    fill `sector` where it is NULL (never overwrites)
//
// Haiku answers are cached in classified-2026-09-26.json so the write uses exactly
// the answers the dry run reported. Needs SUPABASE_URL, SUPABASE_SERVICE_KEY,
// ANTHROPIC_API_KEY in env.
import fs from 'node:fs';
import { classifySector, classifySectorDeterministic, isIcpSector } from '../src/scoring/sector.js';
import { scoreFit, qualify } from '../src/scoring/dimensions.js';
import * as claude from '../src/lib/claude.js';

const WRITE = process.argv.includes('--write');
const DIR = 'C:/xstudio/bridge/sector-backfill';
const SNAP = JSON.parse(fs.readFileSync(`${DIR}/apify-snapshot-2026-09-26.json`, 'utf8'));
const CACHE_F = `${DIR}/classified-2026-09-26.json`;
const cache = fs.existsSync(CACHE_F) ? JSON.parse(fs.readFileSync(CACHE_F, 'utf8')) : {};
const SB = process.env.SUPABASE_URL, H = { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` };
claude.init();

// Same ICP list + filters as lara-v2 getOutboundLeads, to measure pool impact.
const leads = await (await fetch(`${SB}/rest/v1/leads?select=id,business_name,facebook_page_id,sector,status,budget_score,fit_score,lead_score,whatsapp_verified,v1_contacted,do_not_pitch,phone_e164,source&discovery_source=eq.ad_library_apify&created_at=gte.2026-09-24&limit=1000`, { headers: H })).json();

let llmCost = 0, llmCalls = 0;
const rows = [];
for (const l of leads) {
  const a = SNAP.advertisers[String(l.facebook_page_id)];
  if (!a) { rows.push({ l, res: { sector: null, via: 'no_snapshot' } }); continue; }
  const adv = { name: a.name ?? l.business_name, categories: a.categories, bodies: a.bodies };
  // Deterministic steps are always recomputed (so rule changes apply); only a
  // cached Haiku answer is reused, so the write matches what the dry run showed.
  let res = classifySectorDeterministic(adv);
  if (!res.sector) {
    const hit = cache[l.id];
    if (hit && String(hit.via).startsWith('llm')) res = hit;
    else {
      res = await classifySector(adv, { llm: async p => { llmCalls++; return claude.haikuShort(p); } });
      llmCost += res.cost_usd || 0;
      cache[l.id] = res;
    }
  }
  rows.push({ l, a, res });
}
fs.writeFileSync(CACHE_F, JSON.stringify(cache, null, 1));

const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const nulls = rows.filter(r => !r.l.sector);
const recovered = nulls.filter(r => r.res.sector);
console.log(`leads ${rows.length}; sector NULL today ${nulls.length}; recovered ${recovered.length}; still NULL ${nulls.length - recovered.length}`);
console.log(`  by method: ${JSON.stringify(count(nulls, r => r.res.via ?? 'unresolved'))}`);
console.log(`  Haiku this run: ${llmCalls} calls, $${llmCost.toFixed(4)} (cached answers reused: ${nulls.filter(r => r.res.via?.startsWith('llm')).length - llmCalls < 0 ? 0 : nulls.filter(r => r.res.via?.startsWith('llm')).length - llmCalls})`);

console.log('\nRecovered sector distribution (the 112 NULLs):');
const dist = count(recovered, r => r.res.sector);
for (const [s, n] of Object.entries(dist).sort((a, b) => b[1] - a[1]))
  console.log(`  ${isIcpSector(s) ? 'ICP    ' : 'non-ICP'}  ${String(n).padStart(3)}  ${s}`);
const icpN = recovered.filter(r => isIcpSector(r.res.sector)).length;
console.log(`  → ICP ${icpN}, non-ICP ${recovered.length - icpN}, unresolved ${nulls.length - recovered.length}`);

console.log('\nBy lead status (recovered ICP / recovered non-ICP / unresolved):');
for (const [st, rs] of Object.entries(Object.groupBy(nulls, r => r.l.status)))
  console.log(`  ${st.padEnd(12)} ${rs.filter(r => isIcpSector(r.res.sector)).length} / ${rs.filter(r => r.res.sector && !isIcpSector(r.res.sector)).length} / ${rs.filter(r => !r.res.sector).length}`);

// The 32 that already have a sector: does the new classifier agree?
const set = rows.filter(r => r.l.sector);
const disagree = set.filter(r => r.res.sector && r.res.sector !== r.l.sector);
console.log(`\nAlready had a sector: ${set.length}; new classifier agrees ${set.filter(r => r.res.sector === r.l.sector).length}, differs ${disagree.length}, unresolved ${set.filter(r => !r.res.sector).length} (NOT overwritten by --write)`);
// Evidence: how the OLD inferSector (pre-fb42262 regex over name + categories)
// produced the stored value, next to what the new classifier used.
const OLD = [
  ['premium_restaurant', /مطعم|restaurant|food brand|طعام/], ['cafe', /كافيه|cafe|coffee|قهوة/], ['hotel', /hotel|فندق/],
  ['fashion_retail', /fashion|بوتيك|boutique|ملابس/], ['jewelry', /jewelry|مجوهرات|ذهب/],
  ['manufacturer', /مصنع|manufacturer|factory|تصنيع|plastics|بلاستيك|cement|اسمنت|precast|مواد بناء/],
  ['packaged_fmcg', /مواد غذائية|fmcg|packaged food|haircare|beverage|personal care|consumer goods/],
  ['automotive_showroom', /سيارات|automotive|cars|auto|معرض سيارات|car showroom|voyah|toyota|kia|hyundai/],
  ['b2b_services', /distribution|توزيع|logistics|نقل|import|استيراد|export|تصدير|lab|مختبر/],
  ['real_estate', /real estate|عقار|property|developer|مطور/],
];
const oldWhy = (name, cats) => {
  const txt = [name, ...(cats ?? [])].join(' ').toLowerCase();
  for (const [s, re] of OLD) { const m = txt.match(re); if (m) return `${s} via /${m[0]}/`; }
  return 'no old match (set elsewhere)';
};
for (const r of disagree) {
  console.log(`\n  ● ${r.l.business_name}   [status ${r.l.status}${poolReadyish(r) ? ', IN SEND POOL' : ''}]`);
  console.log(`    stored: ${r.l.sector}   — old regex: ${oldWhy(r.a?.name ?? r.l.business_name, r.a?.categories)}`);
  console.log(`    new:    ${r.res.sector}   — ${r.res.via}${r.res.matched ? `: ${r.res.matched}` : ''}   ${isIcpSector(r.l.sector) && !isIcpSector(r.res.sector) ? '⚠ would LEAVE the ICP' : ''}`);
  console.log(`    FB categories: ${(r.a?.categories ?? []).join('; ') || '—'}`);
  const copy = (r.a?.bodies ?? [])[0];
  if (copy) console.log(`    ad copy: ${copy.replace(/\s+/g, ' ').slice(0, 160)}…`);
}
function poolReadyish(r) { return r.l.status === 'Qualified' && r.l.whatsapp_verified === true && r.l.phone_e164; }

// Pool impact: Qualified leads that would pass Lara's sector filter once filled.
const poolReady = r => r.l.status === 'Qualified' && r.l.whatsapp_verified === true && r.l.v1_contacted === false
  && r.l.do_not_pitch === false && (r.l.lead_score ?? 0) >= 40 && r.l.phone_e164;
const joinPool = nulls.filter(r => poolReady(r) && isIcpSector(r.res.sector));
console.log(`\nSend-pool impact of filling NULLs: +${joinPool.length} lead(s) would enter Lara's pool`);
for (const r of joinPool) console.log(`  + ${r.l.business_name} → ${r.res.sector}`);

// Fit impact: the new shared fit vs the stored fit (drives Discovered vs BacklogV3 on FUTURE runs).
const fitRows = rows.filter(r => r.a);
const moved = fitRows.map(r => {
  const nf = scoreFit({ name: r.a.name, categories: r.a.categories, bodies: r.a.bodies }, '', r.res.sector);
  return { r, old: r.l.fit_score, nf, oldQ: qualify(r.l.budget_score ?? 0, r.l.fit_score ?? 0), newQ: qualify(r.l.budget_score ?? 0, nf) };
});
console.log(`\nFit under the shared function (informational — --write does not touch fit/status):`);
console.log(`  qualify() outcome changes on ${moved.filter(m => m.oldQ !== m.newQ).length}/${moved.length}: ${JSON.stringify(count(moved.filter(m => m.oldQ !== m.newQ), m => `${m.oldQ}→${m.newQ}`))}`);

for (const m of moved.filter(m => m.oldQ !== m.newQ).sort((a, b) => a.newQ.localeCompare(b.newQ)))
  console.log(`  ${m.oldQ}→${m.newQ}  fit ${m.old}→${m.nf}  ${m.r.res.sector ?? '(null)'}  | ${m.r.l.business_name}`);

console.log('\nStill unresolved (for review):');
for (const r of nulls.filter(r => !r.res.sector)) console.log(`  ${r.l.status.padEnd(11)} ${r.l.business_name} | cats: ${(r.a?.categories ?? []).join('; ')}`);

if (WRITE) {
  let ok = 0, fail = 0;
  for (const r of recovered) {
    const res = await fetch(`${SB}/rest/v1/leads?id=eq.${r.l.id}&sector=is.null&select=id,sector`, {
      method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ sector: r.res.sector }) });
    const d = res.ok ? await res.json() : [];
    (d.length === 1 && d[0].sector === r.res.sector) ? ok++ : fail++;
  }
  console.log(`\nWRITTEN sector on ${ok}, failed ${fail}`);
}
