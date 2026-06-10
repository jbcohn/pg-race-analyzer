// shared/parsers.js
import { vincentyDistance } from './geo-math.js';

export function parseIGC(text) {
    const points = [];
    const lines = text.split(/\r?\n/);
    for (let line of lines) {
        line = line.trim();
        if (line.startsWith('B') && line.length >= 24) {
            try {
                // Lat: DDMMmmmN/S (8 chars)
                const latStr = line.substring(7, 15);
                const latDeg = parseInt(latStr.substring(0, 2), 10);
                const latMin = parseInt(latStr.substring(2, 7), 10) / 1000;
                let lat = latDeg + latMin / 60;
                if (latStr.charAt(7) === 'S') lat = -lat;

                // Lng: DDDMMmmmE/W (9 chars)
                const lngStr = line.substring(15, 24);
                const lngDeg = parseInt(lngStr.substring(0, 3), 10);
                const lngMin = parseInt(lngStr.substring(3, 8), 10) / 1000;
                let lng = lngDeg + lngMin / 60;
                if (lngStr.charAt(8) === 'W') lng = -lng;

                // Time: HHMMSS (6 chars) starting at index 1
                const timeStr = line.substring(1, 7);
                const hrs = parseInt(timeStr.substring(0, 2), 10);
                const mins = parseInt(timeStr.substring(2, 4), 10);
                const secs = parseInt(timeStr.substring(4, 6), 10);
                const time = hrs * 3600 + mins * 60 + secs;

                // Extract GPS Altitude (A) and Baro Altitude (P) from IGC
                let gpsAlt = null;
                let baroAlt = null;
                if (line.length >= 35) {
                    const baroAltStr = line.substring(25, 30);
                    const gpsAltStr = line.substring(30, 35);
                    if (baroAltStr !== '00000') baroAlt = parseInt(baroAltStr, 10);
                    if (gpsAltStr !== '00000') gpsAlt = parseInt(gpsAltStr, 10);
                }
                const alt = gpsAlt !== null ? gpsAlt : baroAlt !== null ? baroAlt : 0;

                if (!isNaN(lat) && !isNaN(lng)) {
                    points.push({ lat, lng, time, alt });
                }
            } catch (e) {
                // Ignore malformed lines
            }
        }
    }
    return points;
}

export function parseGPX(text) {
    const points = [];
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    const trkpts = xml.getElementsByTagName('trkpt');
    for (let i = 0; i < trkpts.length; i++) {
        const lat = parseFloat(trkpts[i].getAttribute('lat'));
        const lng = parseFloat(trkpts[i].getAttribute('lon'));
        
        const eleEl = trkpts[i].getElementsByTagName('ele')[0];
        const alt = eleEl && eleEl.textContent ? parseFloat(eleEl.textContent) : 0;
        
        // Parse time tag if exists
        const timeEl = trkpts[i].getElementsByTagName('time')[0];
        let time = undefined;
        if (timeEl && timeEl.textContent) {
            try {
                const d = new Date(timeEl.textContent);
                if (!isNaN(d.getTime())) {
                    time = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
                }
            } catch (e) {
                // Ignore timestamp error
            }
        }
        
        if (!isNaN(lat) && !isNaN(lng)) {
            if (time !== undefined) {
                points.push({ lat, lng, time, alt });
            } else {
                points.push({ lat, lng, alt });
            }
        }
    }
    return points;
}

export function parseKML(text) {
    const points = [];
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    const coordTags = xml.getElementsByTagName('coordinates');
    for (let i = 0; i < coordTags.length; i++) {
        const coordsText = coordTags[i].textContent.trim();
        const coordPairs = coordsText.split(/\s+/);
        for (let pair of coordPairs) {
            const parts = pair.split(',');
            if (parts.length >= 2) {
                const lng = parseFloat(parts[0]);
                const lat = parseFloat(parts[1]);
                const alt = parts.length >= 3 ? parseFloat(parts[2]) : 0;
                if (!isNaN(lat) && !isNaN(lng)) {
                    points.push({ lat, lng, alt });
                }
            }
        }
    }
    return points;
}

function getLocalOffsetHours(points, explicitOffset = 'auto') {
    if (explicitOffset !== 'auto') {
        return explicitOffset;
    }
    if (points && points.length > 0) {
        const lng = points[0].lng;
        // Pacific Time Zone (PST -8, PDT -7). Default to PDT for summer paragliding flying season.
        if (lng >= -125 && lng <= -114) {
            return -7;
        }
        return Math.round(lng / 15);
    }
    return 0;
}

export function ensureTimestamps(points, explicitOffset = 'auto') {
    if (!points || points.length === 0) return [];
    
    // Check if points already have valid processed timestamps
    const hasUtc = points.some(p => p.utcTime !== undefined && !isNaN(p.utcTime));
    if (hasUtc) {
        const offset = getLocalOffsetHours(points, explicitOffset);
        points.forEach(p => {
            p.time = (p.utcTime + offset * 3600 + 86400 * 2) % 86400;
        });
        return points;
    }
    
    // Check if points already have valid timestamps
    const hasTime = points.some(p => p.time !== undefined && !isNaN(p.time) && p.time > 0);
    if (hasTime) {
        // First, handle any midnight wrap-around to make timestamps strictly increasing
        let dayOffset = 0;
        let prevRawTime = -1;
        for (let i = 0; i < points.length; i++) {
            if (points[i].time !== undefined && !isNaN(points[i].time)) {
                const rawTime = points[i].time;
                if (prevRawTime !== -1 && rawTime < prevRawTime - 43200) {
                    dayOffset += 86400;
                }
                points[i].time = rawTime + dayOffset;
                prevRawTime = rawTime;
            }
        }

        // Linearly interpolate any missing intermediate timestamps
        let lastTime = (points[0].time !== undefined && !isNaN(points[0].time)) ? points[0].time : (43200 - getLocalOffsetHours(points, explicitOffset) * 3600);
        for (let i = 0; i < points.length; i++) {
            if (points[i].time === undefined || isNaN(points[i].time)) {
                // Find next point with valid timestamp to interpolate
                let nextIdx = -1;
                for (let j = i + 1; j < points.length; j++) {
                    if (points[j].time !== undefined && !isNaN(points[j].time)) {
                        nextIdx = j;
                        break;
                    }
                }
                if (nextIdx !== -1) {
                    const step = (points[nextIdx].time - lastTime) / (nextIdx - i + 1);
                    for (let k = i; k < nextIdx; k++) {
                        points[k].time = Math.round(lastTime + step * (k - i + 1));
                    }
                    i = nextIdx - 1;
                } else {
                    // No future timestamp, just increment by 1 sec
                    points[i].time = lastTime + 1;
                }
            }
            lastTime = points[i].time;
        }
    } else {
        // Interpolate timestamps based on cumulative Vincenty distance
        let cumulativeDist = 0;
        const offsetHours = getLocalOffsetHours(points, explicitOffset);
        const startTime = 43200 - offsetHours * 3600;
        points[0].time = startTime;
        for (let i = 1; i < points.length; i++) {
            const d = vincentyDistance(points[i - 1], points[i]);
            cumulativeDist += d;
            points[i].time = startTime + Math.round(cumulativeDist / 0.00833);
        }
    }

    // Assign monotonic utcTime reference and project to local solar time
    const offset = getLocalOffsetHours(points, explicitOffset);
    points.forEach(p => {
        p.utcTime = p.time;
        p.time = (p.utcTime + offset * 3600 + 86400 * 2) % 86400;
    });

    return points;
}
