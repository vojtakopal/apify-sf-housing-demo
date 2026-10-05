export const SCRAPER_ACTOR_ID = 'compass/crawler-google-places';

/** The scraper input for one run over the whole search area. */
export function buildScraperInput({ searchTerm, geojson, maxStoresToScrape }) {
    const input = {
        searchStringsArray: [searchTerm],
        customGeolocation: geojson,
        searchMatching: 'only_includes',
        skipClosedPlaces: true,
        scrapePlaceDetailPage: false,
        maxReviews: 0,
        maxImages: 0,
        language: 'en',
    };
    // Omitted on purpose when not set: 50 is only the scraper's prefill, omitting means unlimited.
    // A capped scrape misses stores, which silently breaks nearest-store results.
    if (maxStoresToScrape) input.maxCrawledPlacesPerSearch = maxStoresToScrape;
    return input;
}
