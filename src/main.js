import { Actor, log } from 'apify';

import { buildSearchArea, dedupeStores, starbucksIndex, toStore } from './geo.js';
import { detectColumns, fetchCsvRows, toOutputRow, toProperties } from './properties.js';
import { SCRAPER_ACTOR_ID, buildScraperInput } from './scraper.js';

const LARGE_AREA_KM2 = 20000;
const PAGE_SIZE = 1000;

async function* iterateDataset(datasetId) {
    const dataset = Actor.apifyClient.dataset(datasetId);
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const { items, total } = await dataset.listItems({ offset, limit: PAGE_SIZE, clean: true });
        yield* items;
        if (items.length < PAGE_SIZE || offset + items.length >= total) return;
    }
}

const median = (values) => {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};
    const {
        spreadsheetUrl,
        searchTerm = 'Starbucks',
        bufferMeters = 3000,
        maxStoresToScrape,
    } = input;
    if (!spreadsheetUrl) throw new Error('Input "spreadsheetUrl" is required.');

    // 1. Load properties
    const rows = await fetchCsvRows(spreadsheetUrl);
    const columns = detectColumns(Object.keys(rows[0]), input);
    log.info(`Loaded ${rows.length} rows. Columns: ${JSON.stringify(columns)}`);
    const properties = toProperties(rows, columns);
    const located = properties.filter((p) => !p.error);
    const skipped = properties.length - located.length;
    if (skipped) log.warning(`${skipped} rows have no usable coordinates; they are output with "error" set.`);

    let stores = [];
    let scraperRun = null;
    if (located.length) {
        // 2. One search area for all properties
        const area = buildSearchArea(located, { bufferMeters });
        log.info(`Search area: ${area.geojson.type}, ${area.boxes.length} box(es), ${Math.round(area.areaKm2)} km²`);
        if (area.areaKm2 > LARGE_AREA_KM2) {
            log.warning(`Search area is ${Math.round(area.areaKm2)} km², over ${LARGE_AREA_KM2} km². `
                + 'Properties may form a long diagonal corridor that merged into one big box. The scrape may be slow and costly.');
        }
        await Actor.setValue('SEARCH_AREA', { bufferMeters, ...area });

        // 3. One Google Maps Scraper run
        const scraperInput = buildScraperInput({ searchTerm, geojson: area.geojson, maxStoresToScrape });
        log.info(`Calling ${SCRAPER_ACTOR_ID}...`);
        scraperRun = await Actor.call(SCRAPER_ACTOR_ID, scraperInput);
        log.info(`Scraper run ${scraperRun.id} finished with status ${scraperRun.status}.`);
        if (scraperRun.status !== 'SUCCEEDED') {
            throw new Error(`Google Maps Scraper run ${scraperRun.id} ended with status ${scraperRun.status}.`);
        }

        let rawCount = 0;
        for await (const item of iterateDataset(scraperRun.defaultDatasetId)) {
            rawCount++;
            const store = toStore(item, searchTerm);
            if (store) stores.push(store);
        }
        stores = dedupeStores(stores);
        log.info(`Scraper returned ${rawCount} places; ${stores.length} open "${searchTerm}" stores after filtering.`);
        await Actor.setValue('STORES', stores);
        if (!stores.length) log.warning(`No "${searchTerm}" stores found in the search area.`);
    }

    // 4. Compute index and output
    const output = properties.map((p) => toOutputRow(p, p.error ? null : starbucksIndex(p, stores)));
    await Actor.pushData(output);

    const distances = output.map((o) => o.starbucksIndexMeters).filter((d) => d != null);
    const summary = {
        properties: properties.length,
        propertiesWithCoordinates: located.length,
        propertiesWithErrors: output.filter((o) => o.error).length,
        storesFound: stores.length,
        searchTerm,
        bufferMeters,
        scraperRunId: scraperRun?.id ?? null,
        medianMeters: median(distances),
        minMeters: distances.length ? Math.min(...distances) : null,
        maxMeters: distances.length ? Math.max(...distances) : null,
        within500m: output.filter((o) => o.storesWithin500m > 0).length,
        within1km: output.filter((o) => o.storesWithin1km > 0).length,
    };
    await Actor.setValue('SUMMARY', summary);
    log.info(`Done. ${JSON.stringify(summary)}`);
    await Actor.exit();
} catch (err) {
    log.exception(err, 'Starbucks index failed');
    await Actor.fail(err.message);
}
