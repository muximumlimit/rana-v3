import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPhones, memoryForUrls, soloTermsTonight, soloAdsAllowance, planCalls, estimateRunUsd, termsFor, perCallStats, classifyWriteError, reportWriteFailures, cycleSpend } from './ad-library-apify.js';

// ── msg-116 #1: a new lead that did not land is counted and pages ─────────────────
// 10-01..10-04: 7 inserts failed, logged once each, counted by nothing; every run
// said success with leads_new excluding them.
test('classifyWriteError: insert vs enrich vs anything else', () => {
  assert.equal(classifyWriteError(new Error('insert failed: invalid input syntax for type json')), 'insert_failed');
  assert.equal(classifyWriteError(new Error('enrich unconfirmed: 0 row(s) came back for id x')), 'enrich_not_landed');
  assert.equal(classifyWriteError(new Error('enrich failed: HTTP 500')), 'enrich_not_landed');
  assert.equal(classifyWriteError(new Error('findExisting: timeout')), 'write_error');
});

test('INTENT: any failed write pages ONCE per run, naming the leads and the error', async () => {
  const pages = [];
  const page = async (subject, body) => { pages.push({ subject, body }); return { delivered: true }; };
  const m = { insert_failed: 2, write_errors: 1, enrich_not_landed: 0,
    write_failures: [{ name: 'شركة الرضوان العالميه', kind: 'insert_failed', err: 'insert failed: invalid input syntax for type json' },
      { name: 'تجهيزات تازة الغذائية', kind: 'insert_failed', err: 'insert failed: invalid input syntax for type json' },
      { name: 'X', kind: 'write_error', err: 'findExisting: timeout' }] };
  await reportWriteFailures(m, page);
  assert.equal(pages.length, 1);
  assert.match(pages[0].subject, /3 write\(s\) did not land/);
  assert.match(pages[0].body, /الرضوان/);
  assert.match(pages[0].body, /invalid input syntax for type json/);
});

test('a clean run pages nothing', async () => {
  const pages = [];
  await reportWriteFailures({ insert_failed: 0, write_errors: 0, enrich_not_landed: 0, write_failures: [] }, async (s) => { pages.push(s); });
  assert.equal(pages.length, 0);
});
import { tonightsTerms } from '../pipeline.js';
import targetsJson from '../../config/targets.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// factory call plan + term attribution (Yousif 2026-10-03)
// ---------------------------------------------------------------------------
const oct = (d) => new Date(`2026-10-${String(d).padStart(2, '0')}T02:00:00Z`);
const epochDay = (d) => Math.floor(d.getTime() / 86_400_000);
const planFor = (date, env = {}) => {
  const terms = tonightsTerms(targetsJson, 15, epochDay(date));
  return planCalls(terms, soloTermsTonight(targetsJson, terms, date, env),
    { factory: targetsJson.factory_terms, soloAds: soloAdsAllowance(targetsJson, env) });
};
const THIN = targetsJson.factory_terms.filter(t => !targetsJson.factory_solo_terms.includes(t));

test('INTENT: only مصنع بغداد and معمل بغداد are solo — the 6 thin factory terms are never widened', () => {
  assert.deepEqual(targetsJson.factory_solo_terms, ['مصنع بغداد', 'معمل بغداد']);
  assert.equal(THIN.length, 6);
  for (let d = 1; d <= 31; d++) {
    for (const c of planFor(oct(d)).filter(c => c.solo)) assert.ok(targetsJson.factory_solo_terms.includes(c.terms[0]), `oct ${d}: ${c.terms[0]} went solo`);
  }
});

test('INTENT: a solo term gets the larger allowance; every batch keeps 30', () => {
  const calls = planFor(oct(2));
  const solo = calls.filter(c => c.solo);
  assert.equal(solo.length, 1);
  assert.equal(solo[0].ads, targetsJson.factory_solo_ads);
  assert.ok(targetsJson.factory_solo_ads > 30);
  for (const c of calls.filter(c => !c.solo)) assert.equal(c.ads, 30);
});

test('INTENT: every night = 1 solo + 1 batch of the 3 thin factory terms + the 3 unchanged general batches', () => {
  for (let d = 1; d <= 31; d++) {
    const calls = planFor(oct(d));
    assert.equal(calls.length, 5, `oct ${d}`);
    const [solo, thin, ...general] = calls;
    assert.equal(solo.solo, true);
    assert.equal(thin.terms.length, 3);
    assert.ok(thin.terms.every(t => THIN.includes(t)), `oct ${d}: thin batch mixes in ${thin.terms}`);
    assert.deepEqual(general.map(c => c.terms.length), [4, 4, 3]);
    assert.ok(general.every(c => c.terms.every(t => !targetsJson.factory_terms.includes(t))), 'a factory term was put in a general batch — it would be starved');
    assert.equal(new Set(calls.flatMap(c => c.terms)).size, 15, 'every term runs exactly once');
  }
});

test('INTENT: each solo term runs every 2nd night — they alternate, never the same night', () => {
  for (let d = 1; d <= 30; d++) {
    const two = [...planFor(oct(d)), ...planFor(oct(d + 1))].filter(c => c.solo).map(c => c.terms[0]).sort();
    assert.deepEqual(two, [...targetsJson.factory_solo_terms].sort(), `oct ${d}-${d + 1}`);
  }
});

test('INTENT: the plan has no end date, and the kill switch restores the pre-test plan exactly', () => {
  const nov = new Date('2026-11-20T02:00:00Z');
  assert.equal(planFor(nov).filter(c => c.solo).length, 1, 'still solo after the old 10-04 test end');
  const killed = planFor(oct(2), { APIFY_FACTORY_PER_TERM: 'false' });
  assert.deepEqual(killed.map(c => [c.terms.length, c.solo, c.ads]), [[4, false, 30], [4, false, 30], [4, false, 30], [3, false, 30]]);
  assert.ok(killed[0].terms.every(t => targetsJson.factory_terms.includes(t)), 'killed: the 4 factory terms share one batch, as before the test');
});

test('allowance: env overrides config, and never drops below the batch cap', () => {
  assert.equal(soloAdsAllowance(targetsJson, {}), targetsJson.factory_solo_ads);
  assert.equal(soloAdsAllowance(targetsJson, { APIFY_FACTORY_SOLO_ADS: '75' }), 75);
  assert.equal(soloAdsAllowance(targetsJson, { APIFY_FACTORY_SOLO_ADS: '10' }), 30);
  assert.equal(soloAdsAllowance({}, {}), 30);
});

test('planCalls with no solo and no factory list is the old plan', () => {
  assert.deepEqual(planCalls(['a', 'b', 'c', 'd', 'e']), [
    { terms: ['a', 'b', 'c', 'd'], solo: false, ads: 30 },
    { terms: ['e'], solo: false, ads: 30 },
  ]);
});

test('INTENT: a lead returned by a solo call is credited to that exact term', () => {
  const calls = [{ terms: ['مصنع بغداد'], solo: true }, { terms: ['a', 'b', 'c', 'd'], solo: false }];
  assert.deepEqual(termsFor(new Set([0]), calls), ['مصنع بغداد']);
  assert.deepEqual(termsFor(new Set([1, 0]), calls), ['مصنع بغداد'], 'solo wins over a batch that also returned it');
  assert.deepEqual(termsFor(new Set([1]), calls), ['a', 'b', 'c', 'd'], 'batch only → the honest answer is the batch');
});

test('per_call stats separate thin (under the cap) from starved (hit it)', () => {
  const calls = [{ terms: ['مصنع بغداد'], solo: true }, { terms: ['معمل بلاستيك بغداد'], solo: true }];
  const adv = [
    { name: 'مصنع الجبال', calls: new Set([0]), outcome: 'reseen', factory_named: true },
    { name: 'معمل جديد', calls: new Set([0, 1]), outcome: 'new', factory_named: true },
    { name: 'clinic', calls: new Set([1]), outcome: 'blocked', factory_named: false },
  ];
  const [a, b] = perCallStats(calls, [{ count: 30, ok: true }, { count: 4, ok: true }], adv);
  assert.equal(a.hit_cap, true);
  assert.equal(b.hit_cap, false);
  assert.deepEqual([a.advertisers, a.factory_named, a.new, a.reseen], [2, 2, ['معمل جديد'], ['مصنع الجبال']]);
  assert.deepEqual([b.advertisers, b.new, b.blocked], [2, ['معمل جديد'], 1]);
});

test('INTENT: hit_cap is measured against the call\'s OWN allowance — 30 ads on a 60 allowance is not starved', () => {
  const calls = [{ terms: ['معمل بغداد'], solo: true, ads: 60 }, { terms: ['a', 'b'], solo: false, ads: 30 }];
  const [s, b] = perCallStats(calls, [{ count: 30, ok: true }, { count: 30, ok: true }], []);
  assert.deepEqual([s.allowance, s.hit_cap], [60, false]);
  assert.deepEqual([b.allowance, b.hit_cap], [30, true]);
  const [full] = perCallStats(calls.slice(0, 1), [{ count: 60, ok: true }], []);
  assert.equal(full.hit_cap, true);
});

test('BUDGET: a night is priced at every call\'s cap + 3 overshoot, per call', () => {
  const night = planFor(oct(2));
  const ads = 1 * (targetsJson.factory_solo_ads + 3) + 4 * 33;
  assert.ok(Math.abs(estimateRunUsd(night) - (ads * 0.00075 + 5 * 0.00005)) < 1e-9);
});

test('BUDGET: nights are symmetric, so tonight prices the cycle', () => {
  for (let d = 1; d < 31; d++) assert.ok(Math.abs(estimateRunUsd(planFor(oct(d))) - estimateRunUsd(planFor(oct(d + 1)))) < 1e-12, `oct ${d}`);
});

const fakeRuns = (rows) => ({ from: () => ({ select: () => ({ gte: () => ({ eq: () => ({ order: async () => ({ data: rows, error: null, status: 200 }) }) }) }) }) });
const RUNS = [
  { started_at: '2026-10-08T02:00:00Z', apify_cost_usd: '0.10', status: 'success' },
  { started_at: '2026-10-07T02:00:00Z', apify_cost_usd: '0.12', status: 'success' },
  { started_at: '2026-10-06T02:00:00Z', apify_cost_usd: '0.08', status: 'success' },
  { started_at: '2026-10-05T02:00:00Z', apify_cost_usd: '0.50', status: 'success' },
  { started_at: '2026-09-17T02:00:00Z', apify_cost_usd: '9.00', status: 'success' },   // previous cycle
];

test('INTENT: the guard counts Apify\'s cycle — Apify\'s own figure when it answers', async () => {
  const c = await cycleSpend(new Date('2026-10-09T02:00:00Z'), { supabase: fakeRuns(RUNS),
    readCycle: async () => ({ start: new Date('2026-09-18T00:00:00Z'), end: new Date('2026-10-17T23:59:59.999Z'), spent: 1.74, limitUsd: 5, basis: 'apify_limits' }) });
  assert.deepEqual([c.basis, c.spent, c.limitUsd], ['apify_limits', 1.74, 5]);
  assert.ok(Math.abs(c.trailingNightUsd - 0.10) < 1e-9, 'trailing = mean of the last 3 successful runs');
});

test('INTENT: if Apify does not answer, the cycle comes from the 18th and rana_v3_runs inside it — never the calendar month', async () => {
  const c = await cycleSpend(new Date('2026-10-09T02:00:00Z'), { supabase: fakeRuns(RUNS), readCycle: async () => null });
  assert.equal(c.basis, 'rana_v3_runs');
  assert.equal(c.start.toISOString(), '2026-09-18T00:00:00.000Z');
  assert.ok(Math.abs(c.spent - 0.80) < 1e-9, 'the 09-17 run belongs to the previous cycle');
});

test('BUDGET: a full 31-night cycle of the plan, worst case, stays under the $5 limit', () => {
  const p = 31 * estimateRunUsd(planFor(oct(1)));
  assert.ok(p < 5, `projected $${p.toFixed(2)}`);
});
import { isHardBlocked } from '../scoring/dimensions.js';

// ---------------------------------------------------------------------------
// phone extraction — the whole value of this source
// ---------------------------------------------------------------------------

test('extracts an Iraqi mobile printed in ad copy', () => {
  // real ad copy shape observed 2026-09-24
  const body = '📩 للحجز والاستفسار: 0785 856 2001\n📍 بغداد - شارع الصناعة';
  assert.deepEqual(extractPhones(body), ['+9647858562001']);
});

test('extracts from a wa.me link', () => {
  const body = '📲 للطلب عبر واتساب: https://wa.me/9647859942782';
  assert.deepEqual(extractPhones(body), ['+9647859942782']);
});

test('extracts from api.whatsapp.com with a phone parameter', () => {
  assert.deepEqual(extractPhones('https://api.whatsapp.com/send?phone=9647701234567'), ['+9647701234567']);
});

test('normalises Arabic-Indic and Eastern-Arabic digits', () => {
  assert.deepEqual(extractPhones('اتصل ٠٧٧٠١٢٣٤٥٦٧'), ['+9647701234567']);
  assert.deepEqual(extractPhones('اتصل ۰۷۷۰۱۲۳۴۵۶۷'), ['+9647701234567']);
});

test('accepts all three shapes and dedupes to one E.164 form', () => {
  const out = extractPhones('07701234567 and 9647701234567 and 7701234567');
  assert.deepEqual(out, ['+9647701234567'], 'the same number written three ways is one number');
});

test('INTENT: prices must never be read as phone numbers', () => {
  // dots are a thousands separator in Iraqi ad copy, so they are not phone separators
  assert.deepEqual(extractPhones('💰 السعر: ٨.٠٠٠ الف'), []);
  assert.deepEqual(extractPhones('السعر 250.000 دينار فقط'), []);
  assert.deepEqual(extractPhones('خصم 50% لمدة 3 ايام'), []);
});

test('INTENT: a number that is not a valid Iraqi mobile is dropped, never repaired', () => {
  assert.deepEqual(extractPhones('12345'), []);
  assert.deepEqual(extractPhones('0770123'), [], 'too short');
  assert.deepEqual(extractPhones('+14155552671'), [], 'not Iraqi');
  assert.deepEqual(extractPhones('06701234567'), [], 'Iraqi mobiles start 07');
});

test('picks up multiple numbers, including the network-pair habit', () => {
  const out = extractPhones('للاستفسار 07700444773 او 07800444773');
  assert.deepEqual(out.sort(), ['+9647700444773', '+9647800444773']);
});

test('handles null/empty/undefined without throwing', () => {
  for (const v of [null, undefined, '', 0, {}]) assert.deepEqual(extractPhones(v), []);
});

// ---------------------------------------------------------------------------
// Apify memory constraint — a whole batch was silently lost to this
// ---------------------------------------------------------------------------

test('memoryForUrls returns a power of two that satisfies >=1 URL per 512MB', () => {
  const cases = { 1: 512, 2: 1024, 3: 1024, 4: 2048, 5: 2048, 7: 2048, 8: 4096 };
  for (const [urls, expected] of Object.entries(cases)) {
    const mem = memoryForUrls(Number(urls));
    assert.equal(mem, expected, `${urls} url(s) => ${expected}MB`);
    // both actor constraints, asserted explicitly
    assert.ok(Number.isInteger(Math.log2(mem / 512)), `${mem} must be a power of two`);
    assert.ok(mem / 512 <= Number(urls), `${mem}MB requires at least ${mem / 512} URLs, got ${urls}`);
  }
});

test('memoryForUrls never returns the value that broke the first run', () => {
  for (let n = 1; n <= 16; n++) assert.notEqual(memoryForUrls(n), 1536);
});

// ---------------------------------------------------------------------------
// ICP hard block at write time — requirement: a clinic must never get a row
// ---------------------------------------------------------------------------

test('INTENT: a cosmetic clinic is blocked even when it only shows in the ad body', () => {
  // the real advertiser this rule exists for, surfaced by the 2026-09-24 run
  const advertiser = {
    name: 'عيادة الدكتور محمد نعيم للجراحة التجميلية والليزر',
    categories: [],
    creative_snippets: [],
  };
  assert.equal(isHardBlocked(advertiser, ''), true);
});

test('INTENT: a clinic whose NAME looks clean is still blocked on its ad copy', () => {
  const advertiser = {
    name: 'Project U',
    categories: [],
    creative_snippets: ['أفضل عيادة تجميل في بغداد — ليزر وبوتوكس'],
  };
  assert.equal(isHardBlocked(advertiser, ''), true,
    'body text is passed into the block probe precisely so this case is caught');
});

test('INTENT: the block also fires on a lead\'s STORED sector, so an enrich cannot refresh a blocked row', () => {
  // findExisting() now selects `sector`; the guard reuses isHardBlocked on that
  // string, which works because 'beauty_clinic' tokenises to ['beauty','clinic'].
  const onSector = s => isHardBlocked({ name: s, categories: [], creative_snippets: [] }, '');
  for (const s of ['beauty_clinic', 'medical_clinic', 'dental_clinic', 'pharmacy', 'salon_spa']) {
    assert.equal(onSector(s), true, `stored sector ${s} must block an enrich`);
  }
  for (const s of ['hotel', 'automotive_showroom', 'packaged_fmcg', 'manufacturer', 'b2b_services',
                   'premium_restaurant', 'cafe', 'fashion_retail', 'jewelry', 'real_estate']) {
    assert.equal(onSector(s), false, `ICP sector ${s} must NOT be blocked`);
  }
});

test('a legitimate ICP advertiser is not blocked', () => {
  for (const name of ['شركة الشهير للصناعات الغذائية', 'حسين الكعبي للجملة', 'مفروشات لوڤا', 'Brands Oil - براندس اويل']) {
    assert.equal(isHardBlocked({ name, categories: [], creative_snippets: [] }, ''), false, name);
  }
});
