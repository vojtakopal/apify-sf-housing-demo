// Regenerate test/expected-sf-results.csv from the fixtures:
// the 30-row SF sheet and the 40 stores from the verified Google Maps Scraper run
// (run 2GnR0CbeMeMyY1MdT, dataset gjJMUDH1P0e3i0l7g).
import { readFileSync, writeFileSync } from 'node:fs';

import { dedupeStores, starbucksIndex, toStore } from '../src/geo.js';
import { detectColumns, parseCsv, toOutputRow, toProperties } from '../src/properties.js';

const fixture = (name) => new URL(`../test/fixtures/${name}`, import.meta.url);

const rows = parseCsv(readFileSync(fixture('sf-listings.csv'), 'utf8'));
const properties = toProperties(rows, detectColumns(Object.keys(rows[0])));
const stores = dedupeStores(JSON.parse(readFileSync(fixture('sf-stores.json'), 'utf8')).map((i) => toStore(i, 'Starbucks')).filter(Boolean));

const COLUMNS = ['zpid', 'address', 'latitude', 'longitude', 'starbucksIndexMeters', 'nearestStoreName', 'nearestStoreAddress', 'storesWithin500m', 'storesWithin1km'];
const quote = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

const lines = [COLUMNS.join(',')];
for (const p of properties) {
    const out = toOutputRow(p, starbucksIndex(p, stores));
    lines.push(COLUMNS.map((c) => quote(c === 'zpid' ? out.propertyId : out[c])).join(','));
}
writeFileSync(new URL('../test/expected-sf-results.csv', import.meta.url), `${lines.join('\n')}\n`);
console.log(`Wrote ${properties.length} rows using ${stores.length} stores.`);
