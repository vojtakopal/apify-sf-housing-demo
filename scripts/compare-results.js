// Compare an Actor run's dataset with test/expected-sf-results.csv by zpid.
// Usage: APIFY_TOKEN=... node scripts/compare-results.js <datasetId>
import { readFileSync } from 'node:fs';

import { parseCsv } from '../src/properties.js';

const [datasetId] = process.argv.slice(2);
if (!datasetId) throw new Error('Usage: node scripts/compare-results.js <datasetId>');

const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=1&format=json`, {
    headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` },
});
if (!res.ok) throw new Error(`Fetching dataset failed: HTTP ${res.status}`);
const actual = await res.json();
const expected = parseCsv(readFileSync(new URL('../test/expected-sf-results.csv', import.meta.url), 'utf8'));
const byId = new Map(actual.map((r) => [String(r.propertyId), r]));

const FIELDS = ['starbucksIndexMeters', 'nearestStoreAddress', 'storesWithin500m', 'storesWithin1km'];
let differing = 0;
for (const exp of expected) {
    const act = byId.get(exp.zpid);
    if (!act) { differing++; console.log(`MISSING ${exp.zpid} ${exp.address}`); continue; }
    const diffs = FIELDS.filter((f) => String(act[f] ?? '') !== exp[f]).map((f) => `${f}: ${exp[f]} -> ${act[f]}`);
    if (diffs.length) { differing++; console.log(`DIFF ${exp.zpid} ${exp.address}\n    ${diffs.join('\n    ')}`); }
}
const errors = actual.filter((r) => r.error).length;
const nulls = actual.filter((r) => r.starbucksIndexMeters == null).length;
console.log(`\nrows=${actual.length} expected=${expected.length} differing=${differing} errors=${errors} nullIndex=${nulls}`);
