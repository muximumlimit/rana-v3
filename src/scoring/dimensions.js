const PREMIUM_HINTS = ['boutique', 'luxury', 'premium', 'elite', 'vip', 'royal', 'فاخر', 'راقي', 'رويال'];

const HIGH_VALUE_SECTORS = [
  'restaurant', 'cafe', 'dental', 'clinic', 'medical', 'beauty', 'fashion',
  'jewelry', 'real estate', 'عقار', 'مطعم', 'كافيه', 'عيادة', 'صالون',
  'مجوهرات', 'بوتيك', 'فندق', 'hotel', 'pharmacy', 'صيدلية',
];

export function scoreBudget(advertiser) {
  let score = 0;

  // Has any active ads — the basic signal
  if ((advertiser.ad_count ?? 0) >= 1) score += 50;

  const adCount = advertiser.ad_count ?? 0;
  if (adCount >= 5)  score += 20;
  if (adCount >= 10) score += 10;

  // Business category present (not a personal page)
  if (advertiser.categories && advertiser.categories.length > 0) score += 10;

  // Long-running campaign (placeholder: we can't easily get start_date from scrape)
  // Will be populated if ad_start_date is available
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

  // Sector match
  const sectorMatch = HIGH_VALUE_SECTORS.some(s => combined.includes(s.toLowerCase()));
  if (sectorMatch) score += 60;

  // Premium positioning hints
  const premiumMatch = PREMIUM_HINTS.some(p => combined.includes(p.toLowerCase()));
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

  if (combined.match(/مطعم|restaurant|food|طعام/)) return 'premium_restaurant';
  if (combined.match(/كافيه|cafe|coffee|قهوة/)) return 'cafe';
  if (combined.match(/dental|أسنان|دنتال/)) return 'dental_clinic';
  if (combined.match(/عيادة|clinic|medical|طبي/)) return 'medical_clinic';
  if (combined.match(/beauty|تجميل|ماكياج/)) return 'beauty_clinic';
  if (combined.match(/fashion|بوتيك|boutique|ملابس/)) return 'fashion_retail';
  if (combined.match(/jewelry|مجوهرات|ذهب/)) return 'jewelry';
  if (combined.match(/real estate|عقار|property/)) return 'real_estate';
  if (combined.match(/pharmacy|صيدلية/)) return 'pharmacy';
  if (combined.match(/salon|spa|صالون|كوافير/)) return 'salon_spa';
  if (combined.match(/hotel|فندق/)) return 'hotel';
  return null;
}
