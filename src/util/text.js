// Text that ends up in a JSON body — a DB write (PostgREST hands the body to Postgres
// as json) or an API call — must never carry half of a UTF-16 surrogate pair.
// JSON.stringify writes an unpaired half as a bare \ud83d, and both Postgres
// ("invalid input syntax for type json") and Anthropic reject it.
// msg-116: body.slice(0, 100) cut 🕋 🎓 🛑 🚛 📸 📍 in half and 7 new leads were lost.

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripLoneSurrogates(str) {
  return String(str ?? '').replace(LONE, '');
}

export function hasLoneSurrogate(str) {
  return new RegExp(LONE.source).test(String(str ?? ''));
}

/** At most `max` UTF-16 units, never ending on half an emoji. */
export function truncateText(str, max) {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}
