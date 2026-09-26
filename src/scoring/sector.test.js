import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySector, classifySectorDeterministic, sectorFromCategories, sectorFromText, isIcpSector } from './sector.js';
import { scoreFit } from './dimensions.js';

// ── 1. Facebook category lookup ──────────────────────────────────────────────
test("INTENT: Facebook's own taxonomy maps (the old regex missed these)", () => {
  assert.equal(sectorFromCategories(["Men's Clothing"]).sector, 'fashion_retail');
  assert.equal(sectorFromCategories(['Motor vehicle company']).sector, 'automotive_showroom');
  assert.equal(sectorFromCategories(['Jewelry/watches']).sector, 'jewelry');
  assert.equal(sectorFromCategories(['مجوهرات/ساعات']).sector, 'jewelry');
});

test('generic categories carry no sector and fall through', () => {
  assert.equal(sectorFromCategories(['Business', 'Brand', 'Product/service', 'منتج/خدمة']), null);
  assert.equal(sectorFromCategories(['‎Brand‎']), null, 'bidi marks stripped, still generic');
});

test('among equally specific categories, Facebook order breaks the tie', () => {
  assert.equal(sectorFromCategories(['Business', 'Furniture', 'Restaurant']).sector, 'furniture_home');
});

test('INTENT: the most specific category wins over an earlier umbrella one (Aumary)', () => {
  const r = sectorFromCategories(['Residence', 'Hotel', 'Lodging']);
  assert.deepEqual([r.sector, r.matched], ['hotel', 'Hotel']);
  assert.equal(sectorFromCategories(['Home & Garden', 'Electronics']).sector, 'electronics_appliances');
  assert.equal(sectorFromCategories(['Residence']).sector, 'real_estate', 'an umbrella category alone still counts');
});

test('equal specificity: more categories naming the same sector win', () => {
  assert.equal(sectorFromCategories(['Furniture', 'Hotel', 'Resort']).sector, 'hotel');
});

// ── 2. whole-word ad copy ────────────────────────────────────────────────────
test('whole words only — no substring hits', () => {
  assert.equal(sectorFromText({ name: 'Spaghetti Automatic', bodies: ['cafeteria automation'] }), null);
});

test('Arabic article and prefixes still match the stem', () => {
  assert.equal(sectorFromText({ name: 'المطعم الذهبي', bodies: [] }).sector, 'premium_restaurant');
  assert.equal(sectorFromText({ name: 'x', bodies: ['تخفيضات على الملابس', 'وللملابس النسائية تشكيلة'] })?.sector ?? null, null,
    'one keyword in copy (weight 1 per distinct keyword) is not enough');
  assert.equal(sectorFromText({ name: 'x', bodies: ['بوتيك جديد', 'فساتين سهرة وملابس'] }).sector, 'fashion_retail');
});

test('INTENT: known false positives stay out', () => {
  // ذهب also means "went"; منتج ("product") appears in almost every ad
  assert.equal(sectorFromText({ name: 'شركة النور', bodies: ['ذهب الزبون وانبسط', 'منتج اصلي منتج مضمون'] }), null);
});

test('a tie is not guessed', () => {
  // name hits both manufacturer (مصنع) and furniture (مطابخ) at weight 3 each
  assert.equal(sectorFromText({ name: 'مصنع مطابخ', bodies: [] }), null);
});

// ── deterministic order ──────────────────────────────────────────────────────
test('category beats ad copy', () => {
  const r = classifySectorDeterministic({ name: 'مطعم', categories: ['Hotel'], bodies: [] });
  assert.deepEqual([r.sector, r.via], ['hotel', 'fb_category']);
});

test('INTENT: factory / مصنع / معمل in the NAME beats the Facebook category', () => {
  const ddk = classifySectorDeterministic({ name: 'مصنع الجبال - DDK', categories: ['Electrical Supply Store'], bodies: [] });
  assert.deepEqual([ddk.sector, ddk.via], ['manufacturer', 'name_factory']);
  assert.equal(classifySectorDeterministic({ name: 'معمل خزانات الوطني', categories: ['Furniture'] }).sector, 'manufacturer');
  assert.equal(classifySectorDeterministic({ name: 'Rashid Factory', categories: ['Shopping'] }).sector, 'manufacturer');
  assert.equal(classifySectorDeterministic({ name: 'والمصنع الحديث', categories: [] }).sector, 'manufacturer', 'prefixed form');
});

test('a factory mentioned only in ad COPY does not override the category', () => {
  const r = classifySectorDeterministic({ name: 'بيت الاثاث', categories: ['Furniture'], bodies: ['من المصنع الى بيتك', 'مصنع معتمد'] });
  assert.deepEqual([r.sector, r.via], ['furniture_home', 'fb_category']);
});

test('widened ICP: the four added sectors earn fit', () => {
  for (const s of ['furniture_home', 'electronics_appliances', 'construction_materials', 'travel_tourism'])
    assert.equal(isIcpSector(s), true, s);
});

// ── 3. Haiku only for the residue ────────────────────────────────────────────
test('Haiku is not called when 1 or 2 resolve', async () => {
  let called = 0;
  const r = await classifySector({ name: 'x', categories: ['Restaurant'] }, { llm: async () => { called++; return { text: '{}' }; } });
  assert.equal(called, 0);
  assert.equal(r.via, 'fb_category');
});

test('Haiku resolves the residue, only to an allowed label', async () => {
  const adv = { name: 'شركة', categories: ['Business'], bodies: [] };
  const ok = await classifySector(adv, { llm: async () => ({ text: '{"sector":"jewelry"}', cost_usd: 0.0003 }) });
  assert.deepEqual([ok.sector, ok.via, ok.cost_usd], ['jewelry', 'llm', 0.0003]);
  const bad = await classifySector(adv, { llm: async () => ({ text: '{"sector":"spaceships"}', cost_usd: 0.0003 }) });
  assert.deepEqual([bad.sector, bad.via], [null, 'llm_unknown']);
  const err = await classifySector(adv, { llm: async () => { throw new Error('529'); } });
  assert.deepEqual([err.sector, err.via], [null, 'llm_error']);
  const alias = await classifySector(adv, { llm: async () => ({ text: '{"sector":"manufacturing"}', cost_usd: 0 }) });
  assert.equal(alias.sector, 'manufacturer', 'legacy alias mapped to its canonical label');
  const none = await classifySector(adv, {});
  assert.deepEqual([none.sector, none.via], [null, null], 'no llm injected → unresolved, no call');
});

// ── 4. fit and sector share one answer ───────────────────────────────────────
test('INTENT: fit follows sector — ICP sector earns fit, non-ICP does not', () => {
  const fashion = { name: 'Chantal', categories: ["Men's Clothing"], bodies: [] };
  assert.equal(scoreFit(fashion, ''), 60);
  const legal = { name: 'شركة الحلول', categories: ['Lawyer'], bodies: ['منتج اصلي'] };
  assert.equal(scoreFit(legal, ''), 0, "no fit from 'منتج' any more");
  assert.equal(scoreFit(legal, '', 'manufacturer'), 60, 'an explicitly passed sector is what counts');
  assert.equal(isIcpSector('legal'), false);
});

test('premium bonus is whole-word', () => {
  assert.equal(scoreFit({ name: 'Royal Hotel', categories: ['Hotel'] }, ''), 80);
  assert.equal(scoreFit({ name: 'Royalty Hotel', categories: ['Hotel'] }, ''), 60);
});
