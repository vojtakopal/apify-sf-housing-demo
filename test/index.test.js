import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildSearchArea, dedupeStores, haversineMeters, starbucksIndex, toStore } from '../src/geo.js';
import { detectColumns, parseCsv, toCsvUrl, toOutputRow, toProperties } from '../src/properties.js';
import { buildScraperInput } from '../src/scraper.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const loadSf = () => {
    const rows = parseCsv(fixture('sf-listings.csv'));
    return { rows, columns: detectColumns(Object.keys(rows[0])), properties: toProperties(rows, detectColumns(Object.keys(rows[0]))) };
};
const sfStores = () => dedupeStores(JSON.parse(fixture('sf-stores.json')).map((i) => toStore(i, 'Starbucks')).filter(Boolean));

test('haversine matches a known distance', () => {
    // Ferry Building -> Coit Tower, about 1.3 km.
    const d = haversineMeters({ lat: 37.7955, lng: -122.3937 }, { lat: 37.8024, lng: -122.4058 });
    assert.ok(Math.abs(d - 1308) < 15, `got ${d}`);
    assert.equal(haversineMeters({ lat: 10, lng: 20 }, { lat: 10, lng: 20 }), 0);
});

test('sheet URL becomes a CSV export URL, keeping gid', () => {
    const id = '1MpK1pVsTo7HF19kNaNLFDpM1dhhMkdLncYvYSZkRR7o';
    assert.equal(toCsvUrl(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`),
        `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`);
    assert.equal(toCsvUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=42`),
        `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=42`);
    assert.equal(toCsvUrl('https://example.com/data.csv'), 'https://example.com/data.csv');
    // "Publish to web" link: /d/e/<id>/ must not be read as sheet ID "e".
    assert.equal(toCsvUrl('https://docs.google.com/spreadsheets/d/e/2PACX-1vAbc_123/pubhtml?gid=7&single=true'),
        'https://docs.google.com/spreadsheets/d/e/2PACX-1vAbc_123/pub?output=csv&gid=7');
});

test('columns are auto-detected on the Zillow export', () => {
    const { rows, columns } = loadSf();
    assert.equal(rows.length, 30);
    assert.equal(Object.keys(rows[0]).length, 36);
    assert.deepEqual(columns, {
        latitude: 'coordinates.latitude',
        longitude: 'coordinates.longitude',
        id: 'zpid',
        address: 'listingAddress.full',
    });
    assert.throws(() => detectColumns(['foo', 'bar']), /latitude\/longitude/);
});

test('rows without coordinates get an error and are kept', () => {
    const props = toProperties([{ lat: '', lng: '1' }, { lat: 'abc', lng: '2' }, { lat: '37.7', lng: '-122.4' }],
        { latitude: 'lat', longitude: 'lng', id: null, address: null });
    assert.deepEqual(props.map((p) => Boolean(p.error)), [true, true, false]);
    const out = toOutputRow(props[0], null);
    assert.equal(out.starbucksIndexMeters, null);
    assert.match(out.error, /coordinates/);
    assert.equal(out.lat, '', 'original columns are kept');
});

test('search area for the SF sheet reproduces the verified scraper polygon', () => {
    const { properties } = loadSf();
    const area = buildSearchArea(properties, { bufferMeters: 3000 });
    const verified = JSON.parse(fixture('verified-scraper-input.json')).customGeolocation;
    assert.equal(area.geojson.type, 'Polygon');
    area.geojson.coordinates[0].flat().forEach((v, i) => {
        assert.ok(Math.abs(v - verified.coordinates[0].flat()[i]) < 1e-9, `coord ${i}: ${v}`);
    });
    assert.ok(area.areaKm2 > 265 && area.areaKm2 < 280, `area ${area.areaKm2}`);
});

test('far-apart cities become a MultiPolygon, and the buffer covers edge properties', () => {
    const sf = { lat: 37.77, lng: -122.42 };
    const nyc = { lat: 40.71, lng: -74.0 };
    const area = buildSearchArea([sf, nyc], { bufferMeters: 3000 });
    assert.equal(area.geojson.type, 'MultiPolygon');
    assert.equal(area.boxes.length, 2);
    // A store 3 km north of the property must be inside the search area.
    const box = area.boxes.find((b) => b.south < sf.lat && sf.lat < b.north);
    assert.ok(box.north - sf.lat >= 3000 / 111320);
});

test('every property keeps the full buffer, including ones dropped by grid dedupe', () => {
    // Regression: these two are 2.4 km apart and used to share a cell, leaving the
    // dropped one only 1.8 km of buffer to the west.
    const kept = { lat: 37.77864, lng: -122.45820 };
    const dropped = { lat: 37.78714, lng: -122.48283 };
    let worst = Infinity;
    const check = (points) => {
        const { boxes } = buildSearchArea(points, { bufferMeters: 3000 });
        for (const p of points) {
            const m = 111320 * Math.cos((p.lat * Math.PI) / 180);
            const margin = Math.max(...boxes.map((b) => Math.min(
                (p.lng - b.west) * m, (b.east - p.lng) * m, (p.lat - b.south) * 111320, (b.north - p.lat) * 111320)));
            worst = Math.min(worst, margin);
        }
    };
    check([kept, dropped]);
    for (let i = 0; i < 2000; i++) {
        const c = { lat: 37.7 + (i % 50) * 0.002, lng: -122.5 + Math.floor(i / 50) * 0.0025 };
        check([c, { lat: c.lat + (((i * 7) % 13) - 6) * 0.0015, lng: c.lng + (((i * 11) % 17) - 8) * 0.0018 }]);
    }
    assert.ok(worst >= 3000, `worst margin ${worst} m`);
});

test('store filter: name must match, open only, coordinates required, dedupe by placeId', () => {
    const base = { title: 'Starbucks', placeId: 'a', location: { lat: 37.7, lng: -122.4 } };
    assert.ok(toStore(base, 'starbucks'));
    assert.equal(toStore({ ...base, title: 'Peet\'s Coffee' }, 'Starbucks'), null);
    assert.equal(toStore({ ...base, permanentlyClosed: true }, 'Starbucks'), null);
    assert.equal(toStore({ ...base, temporarilyClosed: true }, 'Starbucks'), null);
    assert.equal(toStore({ ...base, location: null }, 'Starbucks'), null);
    assert.ok(toStore({ ...base, title: 'Starbucks (inside Target)' }, 'Starbucks'));
    assert.equal(dedupeStores([toStore(base, 'Starbucks'), toStore(base, 'Starbucks')]).length, 1);
    assert.equal(sfStores().length, 40);
});

test('index on the verified SF stores matches expected-sf-results.csv', () => {
    const { properties } = loadSf();
    const stores = sfStores();
    const expected = new Map(parseCsv(fixture('../expected-sf-results.csv')).map((r) => [r.zpid, r]));
    for (const p of properties) {
        const out = toOutputRow(p, starbucksIndex(p, stores));
        const exp = expected.get(out.propertyId);
        assert.equal(out.starbucksIndexMeters, Number(exp.starbucksIndexMeters), out.address);
        assert.equal(out.nearestStoreAddress, exp.nearestStoreAddress);
        assert.equal(out.storesWithin500m, Number(exp.storesWithin500m));
        assert.equal(out.storesWithin1km, Number(exp.storesWithin1km));
    }
    const leavenworth = toOutputRow(properties.find((p) => p.id === '15063535'), starbucksIndex(properties.find((p) => p.id === '15063535'), stores));
    assert.equal(leavenworth.starbucksIndexMeters, 268);
    assert.equal(leavenworth.zpid, '15063535', 'original columns are kept');
    assert.equal(leavenworth.warning, null);
    const none = starbucksIndex({ lat: 0, lng: 0 }, []);
    assert.equal(none.starbucksIndexMeters, null);
    assert.match(none.warning, /No store/);
    // Nearest store beyond the buffer may not be the true nearest one: flagged.
    const far = starbucksIndex({ lat: 37.70, lng: -122.45 }, stores, { bufferMeters: 1000 });
    assert.ok(far.starbucksIndexMeters > 1000);
    assert.match(far.warning, /beyond the 1000 m search buffer/);
});

test('scraper input: max places omitted unless capped', () => {
    const geojson = { type: 'Polygon', coordinates: [] };
    const input = buildScraperInput({ searchTerm: 'Starbucks', geojson });
    assert.equal('maxCrawledPlacesPerSearch' in input, false);
    assert.equal(input.searchMatching, 'only_includes');
    assert.equal(input.skipClosedPlaces, true);
    assert.equal(input.scrapePlaceDetailPage, false);
    assert.equal(buildScraperInput({ searchTerm: 'Starbucks', geojson, maxStoresToScrape: 100 }).maxCrawledPlacesPerSearch, 100);
});
