import { classifySectorDeterministic, isIcpSector } from './sector.js';

// ICP fit now comes from scoring/sector.js (ICP_SECTOR_VALUES). The old keyword
// list here substring-matched ad copy ('منتج', 'auto', 'نقل') and disagreed with
// inferSector, which is how fit and sector drifted apart.

// Hard block — drop immediately, never score or write to DB
const HARD_BLOCK = [
  'clinic', 'medical', 'dental', 'doctor', 'hospital', 'pharmacy',
  'dermatology', 'ophthalmology', 'orthopedic',
  'salon', 'spa', 'beauty', 'aesthetic', 'كوافير',
  'عيادة', 'أسنان', 'دنتال', 'طبي', 'مستشفى', 'صيدلية',
  'صالون', 'تجميل', 'جلدية', 'عظام', 'عيون',
];

const PREMIUM_HINTS = ['luxury', 'premium', 'elite', 'vip', 'royal', 'فاخر', 'راقي', 'رويال'];

// Normalize Arabic orthographic variants so block terms match real-world spellings:
// أسنان (U+0623 alef-hamza) must match the common اسنان (U+0627 plain alef).
function normalizeArabic(s) {
  return s
    .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ -> ا
    .replace(/ى/g, 'ي')                     // ى -> ي
    .replace(/ة/g, 'ه');                    // ة -> ه
}

// Whole-word tokens across Latin + Arabic (split on any non-letter). Word-boundary
// matching so 'spa' no longer substring-hits 'spaghetti'/'Spazio' and 'salon' no
// longer hits 'Salontex'. Block-list CONTENTS are untouched — matching logic only.
function tokenSet(s) {
  const toks = normalizeArabic(s.toLowerCase()).match(/\p{L}+/gu) || [];
  return new Set(toks);
}

const HARD_BLOCK_TOKENS = new Set(HARD_BLOCK.map(t => normalizeArabic(t.toLowerCase())));
const PREMIUM_TOKENS = PREMIUM_HINTS.map(t => normalizeArabic(t.toLowerCase()));

export function isHardBlocked(advertiser, searchTerm) {
  const text = [
    advertiser.name ?? '',
    (advertiser.categories ?? []).join(' '),
    (advertiser.creative_snippets ?? []).join(' '),
    searchTerm ?? '',
  ].join(' ');

  const tokens = tokenSet(text);
  for (const blocked of HARD_BLOCK_TOKENS) {
    if (tokens.has(blocked)) return true;
  }
  return false;
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

// Fit is driven by the SAME sector classification that fills `sector`
// (scoring/sector.js), so a lead can no longer earn ICP fit from one keyword list
// and get sector=NULL from another. Pass the classified sector when the caller
// already has it (it may come from Haiku); otherwise the deterministic steps run.
export function scoreFit(advertiser, searchTerm, sector) {
  const s = sector !== undefined
    ? sector
    : classifySectorDeterministic({ ...advertiser, bodies: [...(advertiser.bodies ?? advertiser.creative_snippets ?? []), searchTerm ?? ''] }).sector;

  let score = 0;
  if (isIcpSector(s)) score += 60;

  // Premium positioning bonus — whole words, not substrings.
  const toks = tokenSet([advertiser.name ?? '', (advertiser.categories ?? []).join(' '),
    (advertiser.bodies ?? advertiser.creative_snippets ?? []).join(' ')].join(' '));
  if (PREMIUM_TOKENS.some(p => toks.has(p))) score += 20;

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

// Kept for callers that only need the deterministic answer. New code should call
// classifySector() once and pass its sector to scoreFit().
export function inferSector(advertiser) {
  return classifySectorDeterministic(advertiser).sector;
}
