# Starbucks Index Live

For every property in a Google Sheet, the Actor computes a **Starbucks index**: the straight-line distance in meters to the nearest open Starbucks, plus the number of stores within 500 m and 1 km.

It wraps [Google Maps Scraper](https://apify.com/compass/crawler-google-places) and calls it **once for the whole sheet**, not once per property.

## Input

| Field | Default | Notes |
|---|---|---|
| `spreadsheetUrl` | (required) | Google Sheet shared as **"Anyone with the link can view"**, or any CSV URL. A `#gid=` in the URL selects the tab. |
| `searchTerm` | `Starbucks` | A place counts only if its name contains this text (case-insensitive). |
| `bufferMeters` | `3000` | How far around each property to search. See [Why the buffer](#why-the-buffer). |
| `maxStoresToScrape` | unlimited | Cost cap. Leave empty: a capped scrape misses stores and gives wrong nearest-store results. |
| `latitudeColumn`, `longitudeColumn`, `idColumn`, `addressColumn` | auto | Only needed if auto-detection picks the wrong columns. |

Columns are auto-detected. For a Zillow scraper export, that means `coordinates.latitude`, `coordinates.longitude`, `zpid` and `listingAddress.full`. Rows without coordinates aren't geocoded. They're output with `error` set.

## Output

One flat dataset row per sheet row, so the dataset can go straight back into a sheet:

| Field | Meaning |
|---|---|
| `propertyId`, `address`, `latitude`, `longitude` | From the detected columns |
| `starbucksIndexMeters` | Straight-line distance to the nearest open store, in meters |
| `nearestStoreName`, `nearestStoreAddress`, `nearestStoreUrl` | The nearest store |
| `storesWithin500m`, `storesWithin1km` | Store counts around the property |
| `warning` | Set when the nearest store is farther than `bufferMeters`, so a closer store outside the search area may have been missed |
| `error` | Set when the row couldn't be processed |
| *all original sheet columns* | Kept as they were |

The key-value store also holds:

- `SUMMARY`: counts, `storesFound`, the scraper run ID, and the median, min and max distance.
- `STORES`: every store used, after filtering and dedupe.
- `SEARCH_AREA`: the GeoJSON sent to the scraper, plus its area in km².
- `CHANGES`: what changed since the previous run of the same sheet. See [Change tracking](#change-tracking).

## How it works

1. Load the sheet through its CSV export URL.
2. Build one search area. Each property gets a box padded by `bufferMeters` (3 km by default). Overlapping boxes merge into their bounding box. One city ends up as a single `Polygon`. Far-apart cities, whose boxes don't overlap, end up as a `MultiPolygon` in the same `customGeolocation`.
3. Run Google Maps Scraper once, with that area as `customGeolocation`, `searchMatching: "only_includes"`, `skipClosedPlaces: true`, and no detail pages, reviews or images. If the platform migrates the Actor mid-run, it reattaches to the same scraper run instead of starting and paying for a new one.
4. Filter again on our side. The name must contain the search term, the place must not be permanently or temporarily closed, and it must have coordinates. Then dedupe by `placeId`.
5. For each property, compute the haversine distance to every store.
6. Compare with the previous run of the same sheet and save `CHANGES`.

### Change tracking

Every run saves a snapshot to the named key-value store `starbucks-index-live-state`, keyed by the sheet URL, search term and buffer. Named storage doesn't expire, so last week's snapshot is still there next week. The next run of the same setup compares against it and writes `CHANGES`:

| Field | Meaning |
|---|---|
| `firstRun` | `true` when there was no snapshot yet |
| `previousRunAt` | When the compared snapshot was taken |
| `summary.before`, `summary.after` | Median, min and max distance, and the store count |
| `storesOpened`, `storesClosed` | Stores that appeared or disappeared, by `placeId` |
| `propertiesAdded`, `propertiesRemoved` | Property IDs that appeared or disappeared from the sheet |
| `propertiesChanged` | Properties whose distance, nearest store or store counts changed, with before and after values |
| `message` | One-paragraph summary, short enough for a push notification |

If the scrape finds no stores at all, the snapshot isn't overwritten: that's almost surely a glitch, and it would make next week's diff report every store as reopened.

### Why the buffer

A property at the edge of the set can have its true nearest store outside the area the properties cover. Without the buffer, the Actor would report a farther store as the nearest one. Any result farther than `bufferMeters` gets a `warning`, because only stores within the buffer are guaranteed to have been searched. In San Francisco the largest distance is about 2 km, well inside the default 3000 m.

## Known limits

- **Straight-line distance, not walking distance.** Hills and the street grid can make the walk much longer.
- Starbucks inside Target or Safeway count as stores, e.g. 789 Mission St (Target).
- Store completeness depends on Google Maps. A store listed under a different name can be missed.
- Properties forming a long diagonal corridor can merge into one big box. The Actor logs a warning when the area is over 20,000 km².

## Example: San Francisco, 30 three-bedroom listings

[Sheet](https://docs.google.com/spreadsheets/d/1MpK1pVsTo7HF19kNaNLFDpM1dhhMkdLncYvYSZkRR7o/edit?usp=sharing): the search area is about 212 km² and returns about 37 open stores.

- Median distance: 863 m.
- Closest: 2508 Leavenworth St, 268 m to 499 Bay St.
- Farthest: 265 Carl St, 1,975 m to 2675 Geary Blvd.
- Only 6 of 30 listings are within 500 m of a store. All Haight/Cole Valley and Outer Sunset listings are over 1.5 km away, because neither area has a Starbucks.

Full expected results are in `test/expected-sf-results.csv`.

## Development

```bash
npm install
npm test                     # unit tests on the SF fixtures, no network
npm run expected             # regenerate test/expected-sf-results.csv from fixtures
apify push                   # deploy
node scripts/compare-results.js <datasetId>   # diff a run's dataset vs. expected
```

`test/fixtures/` holds the SF sheet and the 40 stores from a verified Google Maps Scraper run (`2GnR0CbeMeMyY1MdT`).
