// Read-only (msg-125 #2): what tonight's 02:00 run will see and do, under production env.
// No Apify run is started, nothing is written.
const { init, getClient } = await import('../src/lib/supabase.js');
init(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { default: targets } = await import('../config/targets.json', { with: { type: 'json' } });
const { tonightsTerms, sizeTermsPerNight, MAX_CYCLE_NIGHTS } = await import('../src/pipeline.js');
const { buildPlan, estimateRunUsd, cycleSpend } = await import('../src/sources/ad-library-apify.js');
const { nightsLeftInCycle, budgetCheck } = await import('../src/lib/apify-cycle.js');
const run = new Date('2026-10-09T02:00:00Z');
const day = Math.floor(run.getTime() / 86_400_000);
const requested = parseInt(process.env.TERMS_PER_NIGHT, 10) || targets.terms_per_night;
const n = sizeTermsPerNight(targets, requested, { day });
const calls = buildPlan(targets, tonightsTerms(targets, n, day));
const worst = estimateRunUsd(calls);
console.log(`TERMS_PER_NIGHT=${process.env.TERMS_PER_NIGHT} -> sized to ${n} | APIFY_BUDGET_ALERT_USD=${process.env.APIFY_BUDGET_ALERT_USD} | APIFY_TERM_ADS=${process.env.APIFY_TERM_ADS ?? '(unset, config 12)'}`);
console.log(`calls ${calls.length}: ${calls.map(c => `${c.terms[0]}@${c.ads}`).join(' · ')}`);
console.log(`worst $${worst.toFixed(4)} x ${MAX_CYCLE_NIGHTS} = $${(worst * MAX_CYCLE_NIGHTS).toFixed(2)}`);
const c = await cycleSpend(run, { supabase: getClient() });
const nl = nightsLeftInCycle(run, c.end);
const b = budgetCheck({ spent: c.spent, tonightUsd: worst, nightUsd: c.trailingNightUsd, nightsLeft: nl, budgetUsd: Math.min(5, c.limitUsd ?? 5), alertUsd: parseFloat(process.env.APIFY_BUDGET_ALERT_USD || '4') });
console.log(`guard: basis ${c.basis} | cycle ${c.start.toISOString().slice(0, 10)} -> ${c.end.toISOString().slice(0, 10)} | spent $${c.spent.toFixed(4)} | nights left ${nl} | projected $${b.projected.toFixed(2)} | halt ${b.halt} | alert ${b.alert}`);
setTimeout(() => process.exit(0), 200);
