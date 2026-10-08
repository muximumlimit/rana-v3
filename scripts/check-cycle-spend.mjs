// Read-only: print what the budget guard sees right now (msg-124 #2a).
const { init, getClient } = await import('../src/lib/supabase.js');
init(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const m = await import('../src/sources/ad-library-apify.js');
const c = await m.cycleSpend(new Date(), { supabase: getClient() });
console.log(JSON.stringify(c));
console.log('TERMS_PER_NIGHT=', process.env.TERMS_PER_NIGHT, 'AD_LIBRARY_SOURCE=', process.env.AD_LIBRARY_SOURCE, 'APIFY_TERM_ADS=', process.env.APIFY_TERM_ADS);
setTimeout(() => process.exit(0), 200);
