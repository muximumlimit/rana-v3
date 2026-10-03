// msg-107 Fix 5 (rana-v3): a 401/403 from a provider pages Yousif.
//
// A revoked or unpaid key used to look like a quiet night: Apify returned nothing,
// the sector classifier fell back to 'llm_error', Whapi checks came back "unknown",
// and the run reported success with zeros. The first 401/403 per provider per run now
// pages on Telegram (lib/alert.js); later ones in the same run are only logged.
// resetProviderAuth() is called at the start of every run.
import logger from '../util/logger.js';
import { pageCritical } from './alert.js';

const AUTH = new Set([401, 403]);
let paged = new Set();

export function resetProviderAuth() { paged = new Set(); }

/** Note a provider's HTTP status. Pages once per provider per run on 401/403. Never throws. */
export async function noteProviderStatus(provider, status, detail = '') {
  if (!AUTH.has(Number(status))) return false;
  logger.error({ provider, status, detail }, 'provider rejected our credentials');
  if (paged.has(provider)) return false;
  paged.add(provider);
  try {
    await pageCritical(`rana-v3: ${provider} returned ${status} — credentials rejected`,
      `${detail ? `${detail}\n` : ''}Key revoked, expired or out of credit? Tonight's discovery is degraded until it is fixed.`,
      { kind: 'provider_auth' });
  } catch (err) {
    logger.error({ err: err.message }, 'provider-auth page threw');
  }
  return true;
}
