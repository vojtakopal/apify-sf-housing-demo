// Pure geo helpers. No I/O here so everything is unit-testable.

const EARTH_RADIUS_M = 6371000;
// Meters per degree of latitude (and of longitude at the equator).
const M_PER_DEG = 111320;

const toRad = (deg) => (deg * Math.PI) / 180;

/** Straight-line (great-circle) distance in meters. Points are { lat, lng }. */
export function haversineMeters(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

const lngDegPerMeter = (lat) => 1 / (M_PER_DEG * Math.cos(toRad(lat)));

/** Box around a point, padded by `padMeters` on every side. */
export function paddedBox(p, padMeters) {
    const dLat = padMeters / M_PER_DEG;
    const dLng = padMeters * lngDegPerMeter(p.lat);
    return { west: p.lng - dLng, east: p.lng + dLng, south: p.lat - dLat, north: p.lat + dLat };
}

const overlaps = (a, b) => a.west <= b.east && b.west <= a.east && a.south <= b.north && b.south <= a.north;

const union = (a, b) => ({
    west: Math.min(a.west, b.west),
    east: Math.max(a.east, b.east),
    south: Math.min(a.south, b.south),
    north: Math.max(a.north, b.north),
});

/** Merge overlapping boxes into their bounding box until no two boxes overlap. */
export function mergeBoxes(boxes) {
    let result = [...boxes];
    let merged = true;
    while (merged) {
        merged = false;
        const next = [];
        for (const box of result) {
            const hit = next.findIndex((other) => overlaps(box, other));
            if (hit === -1) {
                next.push(box);
            } else {
                next[hit] = union(next[hit], box);
                merged = true;
            }
        }
        result = next;
    }
    return result;
}

export function boxAreaKm2(box) {
    const midLat = (box.south + box.north) / 2;
    const heightKm = ((box.north - box.south) * M_PER_DEG) / 1000;
    const widthKm = ((box.east - box.west) * M_PER_DEG * Math.cos(toRad(midLat))) / 1000;
    return heightKm * widthKm;
}

const ring = (b) => [
    [b.west, b.south],
    [b.east, b.south],
    [b.east, b.north],
    [b.west, b.north],
    [b.west, b.south],
];

/**
 * Build the one search area covering all properties.
 * Each property gets a box padded by `bufferMeters`, overlapping boxes merge.
 * Returns GeoJSON ready for the scraper's `customGeolocation`.
 */
export function buildSearchArea(points, { bufferMeters = 3000 } = {}) {
    if (!points.length) throw new Error('No properties with coordinates to build a search area from.');
    const boxes = mergeBoxes(points.map((p) => paddedBox(p, bufferMeters)));
    const geojson = boxes.length === 1
        ? { type: 'Polygon', coordinates: [ring(boxes[0])] }
        : { type: 'MultiPolygon', coordinates: boxes.map((b) => [ring(b)]) };
    const areaKm2 = boxes.reduce((sum, b) => sum + boxAreaKm2(b), 0);
    return { geojson, boxes, areaKm2 };
}

/**
 * Normalize one Google Maps Scraper item into a store, or null if it doesn't qualify:
 * the name must contain the search term (literal, case-insensitive), it must not be
 * closed, and it must have coordinates.
 */
export function toStore(item, searchTerm) {
    const title = item?.title ?? '';
    if (!title.toLowerCase().includes(searchTerm.toLowerCase())) return null;
    if (item.permanentlyClosed || item.temporarilyClosed) return null;
    const lat = Number(item.location?.lat);
    const lng = Number(item.location?.lng);
    if (item.location?.lat == null || item.location?.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
        placeId: item.placeId ?? null,
        title,
        address: item.address ?? null,
        lat,
        lng,
        url: item.url ?? null,
    };
}

/** Dedupe stores by placeId (stores without one are kept). */
export function dedupeStores(stores) {
    const seen = new Set();
    return stores.filter((s) => {
        if (!s.placeId) return true;
        if (seen.has(s.placeId)) return false;
        seen.add(s.placeId);
        return true;
    });
}

/**
 * Distance to the nearest store plus store counts within 500 m and 1 km.
 * Only stores within `bufferMeters` are guaranteed to have been scraped, so a nearest
 * store farther than that may not be the true nearest one: flag it in `warning`.
 */
export function starbucksIndex(point, stores, { bufferMeters = Infinity } = {}) {
    let nearest = null;
    let nearestMeters = Infinity;
    let within500m = 0;
    let within1km = 0;
    for (const store of stores) {
        const d = haversineMeters(point, store);
        if (d < nearestMeters) {
            nearestMeters = d;
            nearest = store;
        }
        if (d <= 500) within500m++;
        if (d <= 1000) within1km++;
    }
    let warning = null;
    if (!nearest) {
        warning = 'No store found in the search area.';
    } else if (nearestMeters > bufferMeters) {
        warning = `Nearest store is beyond the ${bufferMeters} m search buffer; a closer one outside the search area may exist.`;
    }
    return {
        starbucksIndexMeters: nearest ? Math.round(nearestMeters) : null,
        nearestStoreName: nearest?.title ?? null,
        nearestStoreAddress: nearest?.address ?? null,
        nearestStoreUrl: nearest?.url ?? null,
        storesWithin500m: within500m,
        storesWithin1km: within1km,
        warning,
    };
}
