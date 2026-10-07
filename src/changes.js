// Week-over-week change tracking. Pure functions, no I/O.

import { createHash } from 'node:crypto';

/** Key-value store key for one sheet + search setup, so different sheets never share a baseline. */
export function snapshotKey({ csvUrl, searchTerm, bufferMeters }) {
    const hash = createHash('sha256').update(JSON.stringify([csvUrl, searchTerm.toLowerCase(), bufferMeters])).digest('hex');
    return `SNAPSHOT-${hash.slice(0, 16)}`;
}

/** What we keep from one run to compare the next run against. */
export function buildSnapshot({ output, stores, summary, finishedAt }) {
    const properties = {};
    for (const o of output) {
        if (o.propertyId == null) continue;
        properties[o.propertyId] = {
            address: o.address,
            starbucksIndexMeters: o.starbucksIndexMeters,
            nearestStoreAddress: o.nearestStoreAddress,
            storesWithin500m: o.storesWithin500m,
            storesWithin1km: o.storesWithin1km,
        };
    }
    const storeMap = {};
    for (const s of stores) {
        if (s.placeId) storeMap[s.placeId] = { title: s.title, address: s.address };
    }
    const { medianMeters, minMeters, maxMeters, storesFound, properties: propertyCount } = summary;
    return {
        finishedAt,
        summary: { medianMeters, minMeters, maxMeters, storesFound, properties: propertyCount },
        properties,
        stores: storeMap,
    };
}

const fmtDelta = (before, after) => {
    if (before == null || after == null || before === after) return '';
    const d = after - before;
    return ` (${d > 0 ? '+' : ''}${d})`;
};

const storeLabel = (s) => [s.title, s.address].filter(Boolean).join(', ');

/**
 * Compare two snapshots. `previous` is null on the first run.
 * Returns the structured diff plus a one-paragraph `message` for a notification.
 */
export function diffSnapshots(previous, current) {
    const s = current.summary;
    const headline = `Median ${s.medianMeters ?? '-'} m${fmtDelta(previous?.summary.medianMeters, s.medianMeters)}, `
        + `min ${s.minMeters ?? '-'} m${fmtDelta(previous?.summary.minMeters, s.minMeters)}, `
        + `max ${s.maxMeters ?? '-'} m${fmtDelta(previous?.summary.maxMeters, s.maxMeters)}. `
        + `${s.storesFound} stores${fmtDelta(previous?.summary.storesFound, s.storesFound)}.`;

    if (!previous) {
        return {
            firstRun: true,
            previousRunAt: null,
            summary: { before: null, after: s },
            storesOpened: [],
            storesClosed: [],
            propertiesAdded: [],
            propertiesRemoved: [],
            propertiesChanged: [],
            message: `First run, no baseline yet. ${headline}`,
        };
    }

    const storesOpened = Object.entries(current.stores)
        .filter(([id]) => !(id in previous.stores))
        .map(([placeId, st]) => ({ placeId, ...st }));
    const storesClosed = Object.entries(previous.stores)
        .filter(([id]) => !(id in current.stores))
        .map(([placeId, st]) => ({ placeId, ...st }));
    const propertiesAdded = Object.keys(current.properties).filter((id) => !(id in previous.properties));
    const propertiesRemoved = Object.keys(previous.properties).filter((id) => !(id in current.properties));

    const FIELDS = ['starbucksIndexMeters', 'nearestStoreAddress', 'storesWithin500m', 'storesWithin1km'];
    const propertiesChanged = [];
    for (const [id, after] of Object.entries(current.properties)) {
        const before = previous.properties[id];
        if (!before) continue;
        const changed = FIELDS.filter((f) => before[f] !== after[f]);
        if (changed.length) {
            propertiesChanged.push({
                propertyId: id,
                address: after.address,
                ...Object.fromEntries(changed.flatMap((f) => [[`${f}Before`, before[f]], [`${f}After`, after[f]]])),
            });
        }
    }

    const parts = [headline];
    if (storesOpened.length) parts.push(`New: ${storesOpened.map(storeLabel).join('; ')}.`);
    if (storesClosed.length) parts.push(`Gone: ${storesClosed.map(storeLabel).join('; ')}.`);
    if (propertiesAdded.length || propertiesRemoved.length) {
        parts.push(`Properties +${propertiesAdded.length} / -${propertiesRemoved.length}.`);
    }
    if (propertiesChanged.length) {
        parts.push(`${propertiesChanged.length} ${propertiesChanged.length === 1 ? 'property' : 'properties'} changed nearest store or counts.`);
    }
    const nothing = !storesOpened.length && !storesClosed.length && !propertiesAdded.length
        && !propertiesRemoved.length && !propertiesChanged.length;
    if (nothing) parts.push('No changes since last run.');

    return {
        firstRun: false,
        previousRunAt: previous.finishedAt ?? null,
        summary: { before: previous.summary, after: s },
        storesOpened,
        storesClosed,
        propertiesAdded,
        propertiesRemoved,
        propertiesChanged,
        message: parts.join(' '),
    };
}
