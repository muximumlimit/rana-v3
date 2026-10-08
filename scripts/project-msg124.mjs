// msg-124 #2: projected per-night cost of the new plan (read-only arithmetic, no network).
import targets from '../config/targets.json' with { type: 'json' };
import { tonightsTerms } from '../src/pipeline.js';
import { planCalls, soloTermsTonight, soloAdsAllowance, termAdsAllowance, estimateRunUsd } from '../src/sources/ad-library-apify.js';
const M = { 'مصنع بغداد': 36, 'معمل بغداد': 36, 'مصنع اثاث بغداد': 0.4, 'معمل بلاستيك بغداد': 2.3, 'معمل حلويات بغداد': 9, 'ورشة تصنيع بغداد': 1.3,
  'مطعم راقي بغداد': 9, 'تجهيزات مطاعم بغداد': 8, 'fashion Baghdad': 13, 'boutique Baghdad': 17, 'بوتيك بغداد': 30, 'ملابس بغداد': 13, 'مجوهرات بغداد': 13,
  'عبايات بغداد': 30, 'مواد غذائية بغداد': 12, 'توزيع بغداد': 25, 'جملة بغداد': 12, 'شركة توزيع بغداد': 30, 'hotel Baghdad': 18, 'فندق بغداد': 19,
  'علامة تجارية بغداد': 23, 'خدمات شركات بغداد': 29, 'ديكور بغداد': 26, 'دعاية واعلان بغداد': 7, 'مطبعة بغداد': 13, 'سيارات بغداد': 30, 'معرض سيارات بغداد': 23,
  'اثاث بغداد': 30, 'معرض اثاث بغداد': 30, 'اجهزة كهربائية بغداد': 30, 'اجهزة منزلية بغداد': 28, 'مواد بناء بغداد': 26, 'مواد انشائية بغداد': 3, 'سفر وسياحة بغداد': 5, 'شركة سياحة بغداد': 30 };
for (const termAds of [12, 15, 20, 30]) {
  let typ = 0, worst = 0, ads = 0;
  for (let d = 0; d < 30; d++) {
    const day = 20734 + d; // 2026-10-09 onward
    const terms = tonightsTerms(targets, 15, day);
    const calls = planCalls(terms, soloTermsTonight(targets, terms), { factory: targets.factory_terms, soloAds: soloAdsAllowance(targets, {}), termAds });
    const a = calls.reduce((s, c) => s + Math.min(M[c.terms[0]], c.ads), 0);
    ads += a; typ += a * 0.00075 + calls.length * 0.00005; worst += estimateRunUsd(calls);
  }
  console.log(`term_ads ${termAds}: typical $${(typ / 30).toFixed(3)}/night (${(ads / 30).toFixed(0)} ads), worst $${(worst / 30).toFixed(3)}/night, typical 30-night cycle $${typ.toFixed(2)}`);
}
