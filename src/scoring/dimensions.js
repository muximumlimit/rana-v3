// ICP sectors — leads matching these receive fit_score bonus
const ICP_SECTORS = [
  // HORECA
  'restaurant', 'cafe', 'coffee', 'hotel', 'مطعم', 'كافيه', 'فندق',
  // Manufacturing / products
  'manufacturer', 'factory', 'مصنع', 'تصنيع', 'plastics', 'بلاستيك',
  'cement', 'اسمنت', 'precast', 'مواد بناء',
  // FMCG / packaged brands
  'fmcg', 'packaged', 'مواد غذائية', 'food brand', 'beverage', 'haircare',
  'personal care', 'consumer goods', 'منتج', 'علامة تجارية',
  // Fashion / jewelry (single-location OK per ICP)
  'fashion', 'boutique', 'بوتيك', 'ملابس', 'jewelry', 'مجوهرات', 'ذهب',
  // Automotive
  'automotive', 'سيارات', 'معرض سيارات', 'car showroom', 'cars', 'auto',
  'وكالة سيارات', 'voyah', 'toyota', 'kia', 'hyundai', 'ford',
  // B2B services / distribution
  'distribution', 'توزيع', 'import', 'استيراد', 'export', 'تصدير',
  'logistics', 'نقل', 'lab services', 'مختبر', 'b2b',
];

// Hard block — drop immediately, never score or write to DB
const HARD_BLOCK = [
  'clinic', 'medical', 'dental', 'doctor', 'hospital', 'pharmacy',
  'dermatology', 'ophthalmology', 'orthopedic',
  'salon', 'spa', 'beauty', 'aesthetic', 'كوافير',
  'عيادة', 'أسنان', 'دنتال', 'طبي', 'مستشفى', 'صيدلية',
  'صالون', 'تجميل', 'جلدية', 'عظام', 'عيون',
];

const PREMIUM_HINTS = ['luxury', 'premium', 'elite', 'vip', 'royal', 'فاخر', 'راقي', 'رويال'];

export function isHardBlocked(advertiser, searchTerm) {
  const combined = [
    advertiser.name ?? '',
    (advertiser.categories ?? []).join(' '),
    (advertiser.creative_snippets ?? []).join(' '),
    searchTerm ?? '',
  ].join(' ').toLowerCase();

  return HARD_BLOCK.some(term => combined.includes(term));
}

export function scoreBudget(advertiser) {
  let score = 0;

  if ((advertiser.ad_count ?? 0) >= 1)  score += 50;
  if ((advertiser.ad_count ?? 0) >= 5)  score += 20;
  if ((advertiser.ad_count ?? 0) >= 10) score += 10;

  if (advertiser.categories && advertiser.categories.length > 0) score += 10;

  if (advertiser.ad_start_date) {
    const startMs = new Date(advertiser.ad_start_date).getTime();
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    if (!isNaN(startMs) && startMs < thirtyDaysAgo) score += 10;
  }

  return Math.min(score, 100);
}

export function scoreFit(advertiser, searchTerm) {
  let score = 0;
  const combined = [
    advertiser.name ?? '',
    (advertiser.categories ?? []).join(' '),
    (advertiser.creative_snippets ?? []).join(' '),
    searchTerm ?? '',
  ].join(' ').toLowerCase();

  // ICP sector match
  const icpMatch = ICP_SECTORS.some(s => combined.includes(s));
  if (icpMatch) score += 60;

  // Premium positioning bonus (applies across all ICP sectors)
  const premiumMatch = PREMIUM_HINTS.some(p => combined.includes(p));
  if (premiumMatch) score += 20;

  return Math.min(score, 100);
}

export function scoreSize(adCount) {
  const n = adCount ?? 0;
  if (n >= 16) return 80;
  if (n >= 6)  return 60;
  if (n >= 3)  return 40;
  if (n >= 1)  return 20;
  return 0;
}

export function qualify(budgetScore, fitScore) {
  if (budgetScore >= 60 && fitScore >= 50) return 'Discovered';
  if (budgetScore >= 40) return 'BacklogV3';
  return 'Dropped';
}

export function inferSector(advertiser) {
  const combined = [
    advertiser.name ?? '',
    (advertiser.categories ?? []).join(' '),
  ].join(' ').toLowerCase();

  if (combined.match(/مطعم|restaurant|food brand|طعام/)) return 'premium_restaurant';
  if (combined.match(/كافيه|cafe|coffee|قهوة/))           return 'cafe';
  if (combined.match(/hotel|فندق/))                        return 'hotel';
  if (combined.match(/fashion|بوتيك|boutique|ملابس/))      return 'fashion_retail';
  if (combined.match(/jewelry|مجوهرات|ذهب/))               return 'jewelry';
  if (combined.match(/مصنع|manufacturer|factory|تصنيع|plastics|بلاستيك|cement|اسمنت|precast|مواد بناء/)) return 'manufacturer';
  if (combined.match(/مواد غذائية|fmcg|packaged food|haircare|beverage|personal care|consumer goods/))    return 'packaged_fmcg';
  if (combined.match(/سيارات|automotive|cars|auto|معرض سيارات|car showroom|voyah|toyota|kia|hyundai/))    return 'automotive_showroom';
  if (combined.match(/distribution|توزيع|logistics|نقل|import|استيراد|export|تصدير|lab|مختبر/))          return 'b2b_services';
  if (combined.match(/real estate|عقار|property|developer|مطور/))                                         return 'real_estate';
  return null;
}
