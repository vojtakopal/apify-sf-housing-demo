import { parse } from 'csv-parse/sync';

const SHEET_ID_RE = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;
// "Publish to web" links: /d/e/<published id>/pubhtml
const PUBLISHED_ID_RE = /docs\.google\.com\/spreadsheets\/d\/e\/([a-zA-Z0-9_-]+)/;

export const isGoogleSheetUrl = (url) => SHEET_ID_RE.test(url);

/** Turn a Google Sheets share/edit/publish URL into its CSV URL. Other URLs pass through. */
export function toCsvUrl(sheetUrl) {
    const gid = sheetUrl.match(/[#?&]gid=(\d+)/)?.[1];
    const gidParam = gid ? `&gid=${gid}` : '';
    const published = sheetUrl.match(PUBLISHED_ID_RE);
    if (published) return `https://docs.google.com/spreadsheets/d/e/${published[1]}/pub?output=csv${gidParam}`;
    const match = sheetUrl.match(SHEET_ID_RE);
    if (!match) return sheetUrl;
    return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv${gidParam}`;
}

const PRIVATE_SHEET_HINT = 'Make sure the sheet is shared as "Anyone with the link can view".';

export function parseCsv(text) {
    return parse(text, { columns: true, skip_empty_lines: true, bom: true, trim: true, relax_column_count: true });
}

/** Download a sheet (or any CSV URL) and parse it into row objects. */
export async function fetchCsvRows(sheetUrl) {
    const csvUrl = toCsvUrl(sheetUrl);
    let res;
    try {
        res = await fetch(csvUrl, { redirect: 'follow' });
    } catch (err) {
        throw new Error(`Could not download ${csvUrl}: ${err.message}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    // A private sheet answers 401/403/404, or redirects to a Google sign-in page (HTML).
    if (isGoogleSheetUrl(sheetUrl)
        && ([401, 403, 404].includes(res.status) || /accounts\.google\.com/.test(res.url) || contentType.includes('text/html'))) {
        throw new Error(`The spreadsheet isn't publicly readable (HTTP ${res.status}). ${PRIVATE_SHEET_HINT}`);
    }
    if (!res.ok) throw new Error(`Downloading ${csvUrl} failed with HTTP ${res.status}.`);
    const rows = parseCsv(await res.text());
    if (!rows.length) throw new Error(`The spreadsheet at ${csvUrl} has no data rows.`);
    return rows;
}

// Patterns are matched against the column name's last dot-separated segment, case-insensitive.
const COLUMN_PATTERNS = {
    latitude: [/^lat(itude)?$/i],
    longitude: [/^(lng|lon|long|longitude)$/i],
    id: [/^zpid$/i, /^(property|listing)_?id$/i, /^id$/i],
    address: [/^(full_?address|address_?full)$/i, /^full$/i, /^address$/i, /^street(_?address)?$/i],
};

function findColumn(headers, patterns) {
    for (const re of patterns) {
        const hit = headers.find((h) => re.test(h.split('.').pop().trim()));
        if (hit) return hit;
    }
    return null;
}

/**
 * Pick the latitude/longitude/id/address columns. Explicit overrides win.
 * For address, prefer a column under an "address" parent (e.g. listingAddress.full).
 */
export function detectColumns(headers, overrides = {}) {
    const addressFull = headers.find((h) => /address/i.test(h) && /\.full$/i.test(h));
    const columns = {
        latitude: overrides.latitudeColumn || findColumn(headers, COLUMN_PATTERNS.latitude),
        longitude: overrides.longitudeColumn || findColumn(headers, COLUMN_PATTERNS.longitude),
        id: overrides.idColumn || findColumn(headers, COLUMN_PATTERNS.id),
        address: overrides.addressColumn || addressFull || findColumn(headers, COLUMN_PATTERNS.address),
    };
    for (const [key, col] of Object.entries(columns)) {
        if (col && !headers.includes(col)) throw new Error(`Column "${col}" (${key}) isn't in the sheet. Columns: ${headers.join(', ')}`);
    }
    if (!columns.latitude || !columns.longitude) {
        throw new Error(`Couldn't find latitude/longitude columns. Set latitudeColumn and longitudeColumn. Columns: ${headers.join(', ')}`);
    }
    return columns;
}

const toNumber = (v) => {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
};

/**
 * One flat output row: our fields first, then the original sheet columns
 * (skipping any that clash with ours), so it can go straight back into a sheet.
 */
export function toOutputRow(property, index) {
    const out = {
        propertyId: property.id,
        address: property.address,
        latitude: property.lat,
        longitude: property.lng,
        starbucksIndexMeters: index?.starbucksIndexMeters ?? null,
        nearestStoreName: index?.nearestStoreName ?? null,
        nearestStoreAddress: index?.nearestStoreAddress ?? null,
        nearestStoreUrl: index?.nearestStoreUrl ?? null,
        storesWithin500m: index?.storesWithin500m ?? null,
        storesWithin1km: index?.storesWithin1km ?? null,
        warning: index?.warning ?? null,
        error: property.error,
    };
    for (const [key, value] of Object.entries(property.row)) {
        if (!(key in out)) out[key] = value;
    }
    return out;
}

/** Normalize sheet rows into properties: { row, id, address, lat, lng, error }. */
export function toProperties(rows, columns) {
    return rows.map((row, i) => {
        const lat = toNumber(row[columns.latitude]);
        const lng = toNumber(row[columns.longitude]);
        const valid = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
        return {
            row,
            id: columns.id ? row[columns.id] || null : String(i + 1),
            address: columns.address ? row[columns.address] || null : null,
            lat: valid ? lat : null,
            lng: valid ? lng : null,
            error: valid ? null : 'Missing or invalid coordinates; row was not geocoded.',
        };
    });
}
