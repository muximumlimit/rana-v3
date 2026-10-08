// msg-124/125 #2: projected per-night cost of the plan as production will run it
// (TERMS_PER_NIGHT=15 asked, cut by the invariant). Read-only arithmetic, no network.
import targets from '../config/targets.json' with { type: 'json' };
import { tonightsTerms, sizeTermsPerNight, MAX_CYCLE_NIGHTS } from '../src/pipeline.js';
import { buildPlan, estimateRunUsd } from '../src/sources/ad-library-apify.js';
const M = { 'مصنع بغداد': 36, 'معمل بغداد': 36, 'مصنع اثاث بغداد': 0.4, 'معمل بلاستيك بغداد': 2.3, 'معمل حلويات بغداد': 9, 'ورشة تصنيع بغداد': 1.3,
  'مطعم راقي بغداد': 9, 'تجهيزات مطاعم بغداد': 8, 'fashion Baghdad': 13, 'boutique Baghdad': 17, 'بوتيك بغداد': 30, 'ملابس بغداد': 13, 'مجوهرات بغداد': 13,
  'عبايات بغداد': 30, 'مواد غذائية بغداد': 12, 'توزيع بغداد': 25, 'جملة بغداد': 12, 'شركة توزيع بغداد': 30, 'hotel Baghdad': 18, 'فندق بغداد': 19,
  'علامة تجارية بغداد': 23, 'خدمات شركات بغداد': 29, 'ديكور بغداد': 26, 'دعاية واعلان بغداد': 7, 'مطبعة بغداد': 13, 'سيارات بغداد': 30, 'معرض سيارات بغداد': 23,
  'اثاث بغداد': 30, 'معرض اثاث بغداد': 30, 'اجهزة كهربائية بغداد': 30, 'اجهزة منزلية بغداد': 28, 'مواد بناء بغداد': 26, 'مواد انشائية بغداد': 3, 'سفر وسياحة بغداد': 5, 'شركة سياحة بغداد': 30 };
const env = { APIFY_TERM_ADS: process.argv[2] || '' };
let typ = 0, worst = 0, ads = 0, maxWorst = 0, n = 0;
for (let d = 0; d < 31; d++) {
  const day = 20734 + d; // 2026-10-09 onward
  n = sizeTermsPerNight(targets, 15, { env, day });
  const calls = buildPlan(targets, tonightsTerms(targets, n, day), env);
  const a = calls.reduce((s, c) => s + Math.min(M[c.terms[0]], c.ads), 0);
  const w = estimateRunUsd(calls);
  ads += a; typ += a * 0.00075 + calls.length * 0.00005; worst += w; maxWorst = Math.max(maxWorst, w);
}
console.log(`terms/night ${n} | typical $${(typ / 31).toFixed(4)}/night (${(ads / 31).toFixed(0)} ads) → 31-night cycle $${typ.toFixed(2)} | worst $${maxWorst.toFixed(4)}/night → x${MAX_CYCLE_NIGHTS} $${(maxWorst * MAX_CYCLE_NIGHTS).toFixed(2)}`);
