import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPhones, memoryForUrls } from './ad-library-apify.js';
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
