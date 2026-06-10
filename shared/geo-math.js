// shared/geo-math.js

// Haversine formula to compute geodesic distance in km
export function haversineDistance(p1, p2) {
    const R = 6371; // km
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLon = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Compass bearing between two points in radians
export function bearing(p1, p2) {
    const lat1 = p1.lat * Math.PI / 180;
    const lat2 = p2.lat * Math.PI / 180;
    const dLon = (p2.lng - p1.lng) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
              Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return Math.atan2(y, x);
}

// Compute destination point from start, distance (km), and bearing (radians)
export function destinationPoint(start, distKm, brngRad) {
    const R = 6371; // km
    const dR = distKm / R;
    const lat1 = start.lat * Math.PI / 180;
    const lon1 = start.lng * Math.PI / 180;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dR) +
                           Math.cos(lat1) * Math.sin(dR) * Math.cos(brngRad));
    const lon2 = lon1 + Math.atan2(Math.sin(brngRad) * Math.sin(dR) * Math.cos(lat1),
                                   Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2));
    return {
        lat: lat2 * 180 / Math.PI,
        lng: ((lon2 * 180 / Math.PI + 180) % 360 + 360) % 360 - 180
    };
}

export function vincentyDistance(p1, p2) {
    if (!p1 || !p2) return 0;
    const lat1 = p1.lat * Math.PI / 180;
    const lon1 = p1.lng * Math.PI / 180;
    const lat2 = p2.lat * Math.PI / 180;
    const lon2 = p2.lng * Math.PI / 180;

    const a = 6378137.0; // WGS-84 semi-major axis (meters)
    const f = 1 / 298.257223563; // WGS-84 flattening
    const b = 6356752.314245; // WGS-84 semi-minor axis (meters)

    const L = lon2 - lon1;
    const U1 = Math.atan((1 - f) * Math.tan(lat1));
    const U2 = Math.atan((1 - f) * Math.tan(lat2));

    const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
    const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

    let lambda = L;
    let lambdaP;
    let iterLimit = 100;
    let cosSqAlpha = 0;
    let cos2SigmaM = 0;
    let sinSigma = 0;
    let cosSigma = 0;
    let sigma = 0;

    do {
        const sinLambda = Math.sin(lambda);
        const cosLambda = Math.cos(lambda);
        sinSigma = Math.sqrt((cosU2 * sinLambda) * (cosU2 * sinLambda) +
                             (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) * (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda));
        if (sinSigma === 0) return 0; // co-incident points

        cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
        sigma = Math.atan2(sinSigma, cosSigma);

        const sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
        cosSqAlpha = 1 - sinAlpha * sinAlpha;
        cos2SigmaM = (cosSqAlpha === 0) ? 0 : cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha;

        const C = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
        lambdaP = lambda;
        lambda = L + (1 - C) * f * sinAlpha * (
            sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM))
        );
    } while (Math.abs(lambda - lambdaP) > 1e-12 && --iterLimit > 0);

    if (iterLimit === 0) {
        // failed to converge: fallback to haversine with WGS84 radius
        return haversineDistance(p1, p2) * (6378.137 / 6371.0);
    }

    const uSq = cosSqAlpha * (a * a - b * b) / (b * b);
    const A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    const deltaSigma = B * sinSigma * (
        cos2SigmaM + B / 4 * (
            cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            B / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)
        )
    );

    const s = b * A * (sigma - deltaSigma);
    return s / 1000; // in kilometers
}
