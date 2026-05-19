import logger from '../util/logger.js';

export async function scrapeAdLibrary(searchTerm) {
  const url = `https://www.facebook.com/ads/library/?ad_type=all&country=IQ&q=${encodeURIComponent(searchTerm)}&active_status=active&media_type=all`;

  logger.info({ searchTerm, url }, 'firecrawl scrape start');

  const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown', 'html'],
      onlyMainContent: false,
      waitFor: 3000,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    throw new Error(`firecrawl HTTP ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();

  if (!result.success) {
    throw new Error(`firecrawl error: ${result.error || JSON.stringify(result)}`);
  }

  const contentLen = result.data?.markdown?.length ?? 0;
  logger.info({ searchTerm, contentLen }, 'firecrawl scrape complete');

  return result.data;
}

export async function scrapeAdLibraryWithRetry(searchTerm, waitFor = 3000) {
  try {
    return await scrapeAdLibrary(searchTerm);
  } catch (err) {
    if (waitFor < 5000) {
      logger.warn({ searchTerm, err: err.message }, 'firecrawl retry with waitFor=5000');
      return await scrapeWithWait(searchTerm, 5000);
    }
    throw err;
  }
}

async function scrapeWithWait(searchTerm, waitFor) {
  const url = `https://www.facebook.com/ads/library/?ad_type=all&country=IQ&q=${encodeURIComponent(searchTerm)}&active_status=active&media_type=all`;

  const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown', 'html'],
      onlyMainContent: false,
      waitFor,
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!response.ok) throw new Error(`firecrawl HTTP ${response.status}`);
  const result = await response.json();
  if (!result.success) throw new Error(`firecrawl error: ${result.error}`);
  return result.data;
}
