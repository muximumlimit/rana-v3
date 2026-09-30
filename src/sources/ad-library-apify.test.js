import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPhones, memoryForUrls, soloTermsTonight, planCalls, estimateRunUsd, projectMonthUsd, termsFor, perCallStats } from './ad-library-apify.js';
import { tonightsTerms } from '../pipeline.js';
import targetsJson from '../../config/targets.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// per-term factory test + term attribution (Yousif 2026-09-30)
// ---------------------------------------------------------------------------
const T = { factory_terms: ['مصنع بغداد', 'معمل بغداد'], factory_per_term_until: '2026-10-04' };
const oct = (d) => new Date(`2026-10-${String(d).padStart(2, '0')}T02:00:00Z`);

test('INTENT: each factory term gets its own call; the rest stay in 4-term batches', () => {
  const terms = ['مصنع بغداد', 'معمل بغداد', 'a', 'b', 'c', 'd', 'e'];
  const calls = planCalls(terms, soloTermsTonight(T, terms, oct(1), {}));
  assert.deepEqual(calls, [
    { terms: ['مصنع بغداد'], solo: true },
    { terms: ['معمل بغداد'], solo: true },
    { terms: ['a', 'b', 'c', 'd'], solo: false },
    { terms: ['e'], solo: false },
  ]);
});

test('INTENT: the test switches itself off after factory_per_term_until, and the env kills it', () => {
  const terms = ['مصنع بغداد', 'a'];
  assert.equal(soloTermsTonight(T, terms, oct(4), {}).length, 1, 'the until date is inclusive');
  assert.deepEqual(soloTermsTonight(T, terms, oct(5), {}), [], 'day after → batches again');
  assert.deepEqual(soloTermsTonight(T, terms, oct(1), { APIFY_FACTORY_PER_TERM: 'false' }), []);
  assert.deepEqual(soloTermsTonight({ factory_terms: T.factory_terms }, terms, oct(1), {}), [], 'no date → off');
  assert.deepEqual(planCalls(terms, []), [{ terms: ['مصنع بغداد', 'a'], solo: false }], 'off = exactly the old plan');
});

test('the real nightly batch on a test night: 4 solo factory calls + 3 batches = 7 calls', () => {
  const day = Math.floor(oct(1).getTime() / 86_400_000);
  const terms = tonightsTerms(targetsJson, 15, day);
  const calls = planCalls(terms, soloTermsTonight(targetsJson, terms, oct(1), {}));
  assert.equal(calls.filter(c => c.solo).length, 4);
  assert.equal(calls.length, 7);
  assert.equal(new Set(calls.flatMap(c => c.terms)).size, 15, 'every term runs exactly once');
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

test('BUDGET: October with the 4-night test stays under the $4 alert and the $5 halt', () => {
  const p = projectMonthUsd({ mtd: 0, now: oct(1), termsPerNight: 15, factorySlots: 4, until: '2026-10-04' });
  // 4 nights × 7 calls + 27 nights × 4 calls, at 33 ads/call (the observed max)
  assert.ok(Math.abs(p - (28 * (33 * 0.00075 + 0.00005) + 108 * (33 * 0.00075 + 0.00005))) < 1e-9);
  assert.ok(p < 4, `projected $${p.toFixed(2)}`);
});

test('BUDGET: the same plan made permanent would breach the $5 guard — why it is time-boxed', () => {
  const p = projectMonthUsd({ mtd: 0, now: oct(1), termsPerNight: 15, factorySlots: 4, until: '2026-10-31' });
  assert.ok(p > 5, `projected $${p.toFixed(2)}`);
  assert.ok(Math.abs(estimateRunUsd(new Array(7)) - 7 * (33 * 0.00075 + 0.00005)) < 1e-9);
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
