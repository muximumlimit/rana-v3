export function pickPrimaryHook(lead) {
  // Phase 1: all leads from Meta Ad Library use running_ads hook
  if (lead.discovery_source === 'ad_library') return 'running_ads';

  // Future phases will add: ig_weak_content, agency_managed, hashtag_engagement
  return 'running_ads';
}
