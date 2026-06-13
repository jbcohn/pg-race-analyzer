export function parseWaypointFile(text, filename) {
    const waypoints = {}; // id -> {lat, lng, name}
    const lines = text.split(/\r?\n/);

    if (filename.toLowerCase().endsWith('.cup')) {
        // SeeYou format
        // "Name", "Code", Country, Lat, Lon, Elev...
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith('-----')) continue;
            
            const parts = line.split(',');
            if (parts.length >= 5) {
                // Remove quotes
                const name = parts[0].replace(/"/g, '').trim();
                const code = parts[1].replace(/"/g, '').trim();
                
                const latStr = parts[3].trim();
                const lonStr = parts[4].trim();
                
                let lat = parseCupCoord(latStr, true);
                let lng = parseCupCoord(lonStr, false);
                let elev = parseFloat(parts[5].replace(/[^\d.-]/g, ''));
                if (isNaN(elev)) elev = 0;
                
                if (!isNaN(lat) && !isNaN(lng)) {
                    waypoints[code] = { lat, lng, elev, name: code };
                    if (name !== code) waypoints[name] = { lat, lng, elev, name: code };
                }
            }
        }
    } else {
        // Assume CompeGPS (.wpt) or OziExplorer (.wpt) or FS or GEO
        let isGeoFormat = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            if (line.startsWith('$FormatGEO')) {
                isGeoFormat = true;
                continue;
            }
            
            if (isGeoFormat) {
                // e.g. MANSFL    N 47 49 03.66    W 119 38 36.30   693   MANSFL
                // Match: ID, N/S, DD, MM, SS.ss, E/W, DDD, MM, SS.ss, Elev, Name
                const parts = line.split(/\s+/);
                if (parts.length >= 10) {
                    const id = parts[0];
                    const latDir = parts[1];
                    const latDeg = parseInt(parts[2], 10);
                    const latMin = parseInt(parts[3], 10);
                    const latSec = parseFloat(parts[4]);
                    
                    const lonDir = parts[5];
                    const lonDeg = parseInt(parts[6], 10);
                    const lonMin = parseInt(parts[7], 10);
                    const lonSec = parseFloat(parts[8]);
                    
                    let elev = parseFloat(parts[9]);
                    if (isNaN(elev)) elev = 0;
                    
                    let lat = latDeg + (latMin / 60) + (latSec / 3600);
                    if (latDir === 'S') lat = -lat;
                    
                    let lng = lonDeg + (lonMin / 60) + (lonSec / 3600);
                    if (lonDir === 'W') lng = -lng;
                    
                    if (!isNaN(lat) && !isNaN(lng)) {
                        waypoints[id] = { lat, lng, elev, name: id };
                    }
                }
            } else if (line.startsWith('W ')) {
                // CompeGPS format
                // W  NAME A LAT LON DATE TIME ALT
                const parts = line.split(/\s+/);
                if (parts.length >= 5) {
                    const name = parts[1];
                    let lat = parseFloat(parts[3].replace(/[^\d.-]/g, ''));
                    let lng = parseFloat(parts[4].replace(/[^\d.-]/g, ''));
                    if (parts[3].includes('S')) lat = -lat;
                    if (parts[4].includes('W')) lng = -lng;
                    
                    let elev = parts.length >= 7 ? parseFloat(parts[7]) : 0;
                    if (isNaN(elev)) elev = 0;
                    
                    if (!isNaN(lat) && !isNaN(lng)) {
                        waypoints[name] = { lat, lng, elev, name };
                    }
                }
            } else {
                // OziExplorer format: ID,Name,Lat,Lng,...
                const parts = line.split(',');
                if (parts.length >= 4 && !isNaN(parseFloat(parts[2])) && !isNaN(parseFloat(parts[3]))) {
                    const name = parts[1].trim();
                    const lat = parseFloat(parts[2]);
                    const lng = parseFloat(parts[3]);
                    let elev = parts.length >= 15 ? parseFloat(parts[14]) : 0; // Ozi sometimes puts altitude in field 14
                    if (isNaN(elev)) elev = 0;
                    if (!isNaN(lat) && !isNaN(lng)) {
                        waypoints[name] = { lat, lng, elev, name };
                    }
                }
            }
        }
    }
    return waypoints;
}

/**
 * Parse task definitions with embedded waypoint coordinates.
 * Looks for table rows with columns like: No, Leg Dist, Id, Radius, Open, Close, Coordinates, Altitude
 * Extracts Lat: XX.XXXXX Lon: -YYY.YYYYY patterns
 * Returns object mapping waypoint IDs to {lat, lng, elev}
 */
export function parseTaskCoordinates(text) {
    const waypoints = {};
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Recreate the regex each iteration to avoid stale lastIndex from the g flag
        const coordPattern = /Lat:\s*([-\d.]+)\s+Lon:\s*([-\d.]+)/i;
        const coordMatch = coordPattern.exec(line);
        if (coordMatch) {
            const lat = parseFloat(coordMatch[1]);
            const lng = parseFloat(coordMatch[2]);
            
            if (!isNaN(lat) && !isNaN(lng)) {
                // Extract the waypoint ID from the portion of the line before the coordinates
                let lineBefore = line.substring(0, coordMatch.index);
                
                // Split by tabs or multiple spaces
                const parts = lineBefore.split(/\t+|\s{2,}/);
                let id = null;
                
                // Find a non-numeric identifier. In the tabular format:
                //   "No \t Leg Dist \t Id \t Radius \t ... \t Coordinates"
                // the ID is at index 2.
                if (parts.length >= 3) {
                    const candidate = parts[2].replace(/[^\w-]/g, '').trim();
                    if (candidate && !candidate.match(/^\d+(\.\d+)?$/)) {
                        id = candidate;
                    }
                }
                
                // Fallback: look for any uppercase identifier in lineBefore
                if (!id) {
                    const matches = lineBefore.match(/[A-Z]{2,}[A-Z0-9]*/);
                    if (matches) {
                        id = matches[0];
                    }
                }
                
                // Extract elevation (look for number followed by 'm' immediately before "Lat:")
                let elev = 0;
                const elevMatch = line.match(/(\d+)\s*m\s+Lat:/);
                if (elevMatch) {
                    elev = parseInt(elevMatch[1], 10);
                }
                
                if (id) {
                    waypoints[id] = { lat, lng, elev, name: id };
                }
            }
        }
    }
    
    return waypoints;
}

// SeeYou coordinates are DDMM.mmmN/S or DDDMM.mmmE/W
function parseCupCoord(str, isLat) {
    if (!str || str.length < 8) return NaN;
    const dir = str.charAt(str.length - 1).toUpperCase();
    const valStr = str.substring(0, str.length - 1);
    
    let degLen = isLat ? 2 : 3;
    let deg = parseInt(valStr.substring(0, degLen), 10);
    let min = parseFloat(valStr.substring(degLen));
    
    let dec = deg + (min / 60);
    if (dir === 'S' || dir === 'W') {
        dec = -dec;
    }
    return dec;
}
