// Sector classification — the ONE function both `sector` and fit scoring use.
//
// Before this, inferSector() read only name + Facebook page categories with a
// keyword regex that missed Facebook's own taxonomy ("Men's Clothing" is not
// /fashion|ملابس/), while scoreFit() substring-matched ad copy against a
// different, looser list ('منتج', 'auto', 'نقل'). So a lead could earn ICP fit
// from its ad copy and still get sector=NULL — 112 of 144 ad-library leads
// (09-24..09-26), which Lara's sector filter then excludes.
//
// Order, most to least trustworthy:
//   1. Facebook page category → sector, explicit lookup (deterministic)
//   2. whole-word ad-copy + name keywords (deterministic, needs a clear winner)
//   3. Haiku, only for what 1 and 2 leave unresolved (async, capped by caller)

// Values Lara's blast accepts (lara-v2 lib/crm.js ICP_SECTORS). Kept in sync by
// hand — the two services share no package. A sector outside this set can still
// be classified; it just earns no ICP fit and is not sendable.
export const ICP_SECTOR_VALUES = new Set([
  'premium_restaurant', 'cafe', 'hotel', 'horeca',
  'fashion_retail', 'jewelry',
  'factory', 'manufacturing', 'manufacturer',
  'fmcg', 'packaged_fmcg',
  'b2b_services',
  'automotive', 'automotive_showroom', 'auto_service',
  // Widened by Yousif 2026-09-26 (same change in lara-v2 crm.js).
  'furniture_home', 'electronics_appliances', 'construction_materials', 'travel_tourism',
]);

// Every label this classifier can emit — ONE canonical label per sector. Lara also
// accepts legacy aliases (factory, manufacturing, fmcg, horeca, automotive), but
// offering those to Haiku split identical businesses across two labels on the
// first backfill pass, so they are mapped back here instead.
// The non-ICP labels exist so the data shows what is actually being found,
// rather than collapsing it all into NULL.
const ALIAS = { factory: 'manufacturer', manufacturing: 'manufacturer', fmcg: 'packaged_fmcg', automotive: 'automotive_showroom' };
export const canonicalSector = s => ALIAS[s] ?? s;
export const SECTORS = [
  'premium_restaurant', 'cafe', 'hotel', 'fashion_retail', 'jewelry', 'manufacturer',
  'packaged_fmcg', 'b2b_services', 'automotive_showroom', 'auto_service',
  'furniture_home', 'electronics_appliances', 'travel_tourism', 'transport',
  'construction_materials', 'real_estate', 'education', 'health_beauty',
  'events_gifts', 'printing_office', 'energy_solar', 'finance', 'legal',
  'media_entertainment', 'retail_general', 'home_services', 'agriculture',
  'pets', 'crafts_art',
];

// ── 1. Facebook page category lookup ─────────────────────────────────────────
// Keys are normalised (lowercase, bidi marks stripped). Categories that say
// nothing about the business ("Business", "Brand", "Product/service") are
// deliberately absent so they fall through to step 2.
const FB_CATEGORY = {
  // food & hospitality
  'restaurant': 'premium_restaurant', 'fast food': 'premium_restaurant', 'italian': 'premium_restaurant',
  'seafood': 'premium_restaurant', 'meal takeaway': 'premium_restaurant', 'food service': 'premium_restaurant',
  'مطعم': 'premium_restaurant',
  'cafe': 'cafe', 'coffee shop': 'cafe', 'dessert': 'cafe', 'cake shop': 'cafe', 'ice cream': 'cafe',
  'bakery': 'cafe', 'مقهى': 'cafe',
  'hotel': 'hotel', 'lodging': 'hotel', 'resort': 'hotel', 'فندق': 'hotel',
  // fashion & jewelry
  'clothing': 'fashion_retail', 'clothing (brand)': 'fashion_retail', "women's clothing": 'fashion_retail',
  "men's clothing": 'fashion_retail', "children's clothing": 'fashion_retail', 'apparel': 'fashion_retail',
  'shoes': 'fashion_retail', 'lingerie': 'fashion_retail', 'fabrics': 'fashion_retail', 'boutique': 'fashion_retail',
  'ملابس': 'fashion_retail', 'ملابس نسائية': 'fashion_retail', 'ملابس داخلية': 'fashion_retail',
  'ملابس (علامة تجارية)': 'fashion_retail',
  'jewelry': 'jewelry', 'jewelry/watches': 'jewelry', 'مجوهرات/ساعات': 'jewelry',
  // manufacturing
  'industrial company': 'manufacturer', 'manufacturer': 'manufacturer', 'factory': 'manufacturer',
  // automotive
  'motor vehicle company': 'automotive_showroom', 'cars': 'automotive_showroom', 'auto dealer': 'automotive_showroom',
  'car dealership': 'automotive_showroom', 'سيارات': 'automotive_showroom',
  'auto service': 'auto_service', 'auto supplies': 'auto_service', 'خدمة سيارات': 'auto_service',
  // not in Lara's ICP today — labelled so they are visible
  'furniture': 'furniture_home', 'أثاث': 'furniture_home', 'home design': 'furniture_home',
  'home & garden': 'furniture_home', 'منازل وحدائق': 'furniture_home',
  'electronics': 'electronics_appliances', 'electrical supply store': 'electronics_appliances',
  'vacuum cleaner store': 'electronics_appliances', 'أجهزة كمبيوتر (علامة تجارية)': 'electronics_appliances',
  'travel service': 'travel_tourism', 'travel agency': 'travel_tourism', 'travel company': 'travel_tourism',
  'travel & transport': 'travel_tourism',
  'transport service': 'transport',
  'construction': 'construction_materials', 'بناء': 'construction_materials',
  'building materials': 'construction_materials', 'tools/equipment': 'construction_materials',
  'real estate': 'real_estate', 'residence': 'real_estate',
  'education': 'education', 'school': 'education', 'community college': 'education', 'تعليم': 'education',
  'books': 'education',
  'health/beauty': 'health_beauty', 'health & beauty': 'health_beauty', 'صحة/تجميل': 'health_beauty',
  'pharmacy': 'health_beauty', 'medical service': 'health_beauty', 'medical center': 'health_beauty',
  'hospital': 'health_beauty', 'beauty salon': 'health_beauty', 'barber shop': 'health_beauty',
  'dentist': 'health_beauty', 'plastic surgeon': 'health_beauty', 'urologist': 'health_beauty',
  'radiologist': 'health_beauty', 'therapist': 'health_beauty', 'counselor': 'health_beauty',
  'أخصائي أمراض جلدية': 'health_beauty', 'أخصائي علاج': 'health_beauty',
  'florist': 'events_gifts', 'gifts': 'events_gifts', 'wedding planner': 'events_gifts',
  'printing': 'printing_office', 'office supplies': 'printing_office',
  'energy company': 'energy_solar', 'public utility': 'energy_solar',
  'financial service': 'finance',
  'lawyer': 'legal', 'legal service': 'legal',
  'media/news company': 'media_entertainment', 'news & media website': 'media_entertainment',
  'tv show': 'media_entertainment', 'entertainment': 'media_entertainment',
  'photographer': 'media_entertainment', 'مصور فوتوغرافي': 'media_entertainment',
  'shopping mall': 'retail_general', 'discount shopping': 'retail_general', 'general store': 'retail_general',
  'retail company': 'retail_general', 'متجر بقالة': 'retail_general', 'household supplies': 'retail_general',
  'carpenter': 'home_services', 'نجار': 'home_services', 'home repair': 'home_services',
  'dry cleaner': 'home_services', 'storage': 'home_services',
  'farm': 'agriculture', 'landscaping': 'agriculture',
  'pet supplies': 'pets',
  'crafts': 'crafts_art', 'art': 'crafts_art',
};

const normCategory = c => String(c ?? '').replace(/[‎‏‪-‮]/g, '').trim().toLowerCase();

export function sectorFromCategories(categories = []) {
  for (const c of categories) {                        // Facebook lists the primary category first
    const s = FB_CATEGORY[normCategory(c)];
    if (s) return { sector: s, matched: c };
  }
  return null;
}

// ── 2. Whole-word ad-copy / name keywords ────────────────────────────────────
function normalizeArabic(s) {
  return s.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[ً-ْـ]/g, '');
}

// Arabic attaches the article and prepositions to the word: المطعم, للمطاعم,
// وبالسيارات. Emit the bare stem too so a whole-word match still lands, without
// falling back to substring matching (which is how 'spa' used to hit 'spaghetti').
function stems(tok) {
  const out = [tok];
  let t = tok;
  if (/^[وف]/.test(t) && t.length > 3) { t = t.slice(1); out.push(t); }
  if (/^[بلك]ال/.test(t) && t.length > 4) { t = t.slice(1); out.push(t); }
  if (/^لل/.test(t) && t.length > 4) { out.push(t.slice(2)); }
  if (/^ال/.test(t) && t.length > 4) { out.push(t.slice(2)); }
  return out;
}

export function tokens(text) {
  const raw = normalizeArabic(String(text ?? '').toLowerCase()).match(/\p{L}+/gu) || [];
  return raw.map(stems);          // array of alternatives per position
}

// Keywords are single words or short phrases, written in normalised form
// (ا not أ, ه not ة). Deliberately excluded because they misfire: ذهب ("went"
// as well as gold), منتج ("product" — in every ad), شحن (shipping and phone
// charging), auto/car substrings, صيانه on its own.
const KEYWORDS = {
  premium_restaurant: ['مطعم', 'مطاعم', 'restaurant', 'مشويات', 'شاورما', 'برغر', 'برگر', 'burger', 'pizza', 'بيتزا', 'كباب'],
  cafe:               ['كافيه', 'كافي', 'cafe', 'coffee', 'قهوه', 'كوفي', 'حلويات', 'dessert', 'كيك', 'cake', 'ايس كريم'],
  hotel:              ['فندق', 'فنادق', 'hotel', 'منتجع', 'resort'],
  fashion_retail:     ['ملابس', 'بوتيك', 'boutique', 'fashion', 'ازياء', 'فساتين', 'فستان', 'عبايات', 'احذيه', 'اقمشه', 'clothing', 'clothes'],
  jewelry:            ['مجوهرات', 'jewelry', 'jewellery', 'مصوغات', 'عيار', 'الماس'],
  manufacturer:       ['مصنع', 'مصانع', 'معمل', 'factory', 'manufacturer', 'manufacturing', 'تصنيع'],
  packaged_fmcg:      ['منظفات', 'شامبو', 'shampoo', 'fmcg', 'مواد غذائيه', 'منتجات غذائيه'],
  automotive_showroom:['سيارات', 'سياره', 'معرض سيارات', 'cars', 'تويوتا', 'toyota', 'كيا', 'kia', 'هيونداي', 'hyundai', 'voyah'],
  auto_service:       ['قطع غيار', 'spare parts', 'صيانه سيارات', 'ميكانيك', 'كراج', 'garage'],
  b2b_services:       ['استيراد', 'تصدير', 'import', 'export', 'توزيع', 'distribution', 'logistics', 'لوجستيه', 'مختبر'],
  real_estate:        ['عقار', 'عقارات', 'شقق', 'real estate', 'مجمع سكني'],
  furniture_home:     ['اثاث', 'furniture', 'غرف نوم', 'ديكور', 'decor', 'مطابخ', 'كنبات'],
  electronics_appliances: ['الكترونيات', 'electronics', 'اجهزه منزليه', 'اجهزه كهربائيه', 'موبايل', 'موبايلات', 'mobile', 'لابتوب', 'laptop', 'ايفون', 'iphone', 'سامسونج', 'samsung'],
  travel_tourism:     ['سفر', 'سياحه', 'travel', 'tourism', 'تذاكر', 'طيران', 'فيزا', 'visa', 'رحلات', 'نقل المسافرين'],
  education:          ['دورات', 'كورس', 'course', 'تعليم', 'مدرسه', 'جامعه', 'معهد', 'اكاديميه', 'academy', 'تدريب'],
  construction_materials: ['مواد بناء', 'اسمنت', 'cement', 'طابوق', 'سيراميك', 'ceramic', 'مقاولات', 'انشاءات', 'construction'],
  events_gifts:       ['هدايا', 'gifts', 'ورد', 'زهور', 'florist', 'اعراس', 'wedding'],
  printing_office:    ['طباعه', 'printing', 'مطبعه', 'قرطاسيه'],
  energy_solar:       ['طاقه شمسيه', 'solar', 'منظومات', 'مولدات'],
};

// Pre-tokenise each keyword into its normalised word sequence.
const KW = Object.fromEntries(Object.entries(KEYWORDS).map(([s, list]) =>
  [s, list.map(k => normalizeArabic(k.toLowerCase()).match(/\p{L}+/gu))]));

function hits(toks, phrase) {
  outer: for (let i = 0; i + phrase.length <= toks.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (!toks[i + j].includes(phrase[j])) continue outer;
    return true;
  }
  return false;
}

// Distinct keywords per sector: a hit in the business name counts 3, in ad copy 1.
// Needs a clear winner (score >= 2 and at least double the runner-up); a tie or a
// single passing mention in the copy is left for step 3 rather than guessed.
export function sectorFromText({ name = '', bodies = [] }) {
  const nameToks = tokens(name);
  const bodyToks = tokens(bodies.join(' \n '));
  const score = {};
  for (const [sector, phrases] of Object.entries(KW)) {
    let s = 0;
    const found = [];
    for (const p of phrases) {
      if (hits(nameToks, p)) { s += 3; found.push(p.join(' ')); }
      else if (hits(bodyToks, p)) { s += 1; found.push(p.join(' ')); }
    }
    if (s) score[sector] = { s, found };
  }
  const ranked = Object.entries(score).sort((a, b) => b[1].s - a[1].s);
  if (!ranked.length) return null;
  const [top, second] = ranked;
  if (top[1].s < 2) return null;
  if (second && top[1].s < 2 * second[1].s) return null;
  return { sector: top[0], matched: top[1].found.join(', ') };
}

// ── 0. The business's own name beats a shopfront label ───────────────────────
// A page named "مصنع الجبال" but filed under "Electrical Supply Store" is a factory
// that sells electrical goods, not a shop (Yousif, 2026-09-26). Whole words in
// the NAME only — ad copy mentioning a factory proves nothing about the advertiser.
const FACTORY_NAME_WORDS = ['مصنع', 'مصانع', 'معمل', 'factory'].map(w => [normalizeArabic(w)]);
export function factoryInName(name) {
  const toks = tokens(name);
  return FACTORY_NAME_WORDS.some(p => hits(toks, p));
}

// ── 0 + 1 + 2: deterministic, synchronous ────────────────────────────────────
export function classifySectorDeterministic(adv) {
  if (factoryInName(adv.name)) return { sector: 'manufacturer', via: 'name_factory', matched: adv.name };
  const cat = sectorFromCategories(adv.categories);
  if (cat) return { sector: cat.sector, via: 'fb_category', matched: cat.matched };
  const txt = sectorFromText({ name: adv.name, bodies: adv.bodies ?? adv.creative_snippets ?? [] });
  if (txt) return { sector: txt.sector, via: 'ad_copy', matched: txt.matched };
  return { sector: null, via: null, matched: null };
}

// ── 3. Haiku for the residue ─────────────────────────────────────────────────
// `llm` is an async (prompt) => { text, cost_usd } — injected so tests and the
// backfill control spend. Returns via:'llm' only for a label from SECTORS.
export async function classifySector(adv, { llm = null } = {}) {
  const det = classifySectorDeterministic(adv);
  if (det.sector || !llm) return { ...det, cost_usd: 0 };

  const copy = (adv.bodies ?? adv.creative_snippets ?? []).slice(0, 3).map(b => String(b).slice(0, 400));
  const prompt = `Classify this Iraqi business, found through its Meta ads, into exactly one sector.

Business name: ${adv.name ?? ''}
Facebook page categories: ${(adv.categories ?? []).join(', ') || '(none)'}
Ad copy samples:
${copy.map((c, i) => `${i + 1}. ${c}`).join('\n') || '(none)'}

Allowed sectors: ${SECTORS.join(', ')}

Answer with JSON only: {"sector": "<one allowed sector, or unknown>"}.
Use "unknown" if the evidence does not clearly support one sector. Do not guess.`;

  try {
    const { text, cost_usd } = await llm(prompt);
    const m = String(text ?? '').match(/\{[\s\S]*?\}/);
    const s = m ? canonicalSector(JSON.parse(m[0]).sector) : null;
    if (s && SECTORS.includes(s)) return { sector: s, via: 'llm', matched: null, cost_usd };
    return { sector: null, via: 'llm_unknown', matched: null, cost_usd };
  } catch (err) {
    return { sector: null, via: 'llm_error', matched: err.message, cost_usd: 0 };
  }
}

export const isIcpSector = s => ICP_SECTOR_VALUES.has(s);
