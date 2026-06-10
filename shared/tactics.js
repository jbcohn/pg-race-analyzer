import { haversineDistance, bearing, destinationPoint } from './geo-math.js';

function calculateMax10SecSpeed(points, startIdx, endIdx) {
    if (!points || points.length < 5 || endIdx - startIdx < 5) return { speed: 0, idx: -1 };
    
    const N_start = Math.max(0, startIdx);
    const N_end = Math.min(points.length, endIdx);
    const len = N_end - N_start;
    
    const rawSpeeds = new Float64Array(len - 1);
    const segmentDts = new Float64Array(len - 1);
    
    for (let i = 0; i < len - 1; i++) {
        const pt1 = points[N_start + i];
        const pt2 = points[N_start + i + 1];
        let dt = pt2.time - pt1.time;
        if (dt < -43200) {
            dt += 86400;
        }
        segmentDts[i] = dt;
        if (dt > 0) {
            const dist = haversineDistance(pt1, pt2);
            rawSpeeds[i] = (dist / dt) * 3600;
        } else {
            rawSpeeds[i] = 0;
        }
    }
    
    // Helper to find the median of 5 numbers
    const medianOf5 = (a, b, c, d, e) => {
        const arr = [a, b, c, d, e];
        arr.sort((x, y) => x - y);
        return arr[2];
    };
    
    // Apply 5-point median filter to remove coordinate jumps (which affect up to 2 segments)
    const smoothedSpeeds = new Float64Array(len - 1);
    for (let i = 0; i < len - 1; i++) {
        if (i < 2 || i >= len - 3) {
            smoothedSpeeds[i] = rawSpeeds[i];
        } else {
            smoothedSpeeds[i] = medianOf5(
                rawSpeeds[i-2],
                rawSpeeds[i-1],
                rawSpeeds[i],
                rawSpeeds[i+1],
                rawSpeeds[i+2]
            );
        }
    }
    
    let maxSpeed = 0;
    let maxSpeedIdx = -1;
    let windowTime = 0;
    let windowDist = 0;
    let windowStartIdx = 0;
    
    for (let endIdxWindow = 0; endIdxWindow < len - 1; endIdxWindow++) {
        windowTime += segmentDts[endIdxWindow];
        windowDist += (smoothedSpeeds[endIdxWindow] * segmentDts[endIdxWindow]) / 3600;
        
        while (windowTime > 10 && windowStartIdx < endIdxWindow) {
            windowTime -= segmentDts[windowStartIdx];
            windowDist -= (smoothedSpeeds[windowStartIdx] * segmentDts[windowStartIdx]) / 3600;
            windowStartIdx++;
        }
        
        if (windowTime >= 8 && windowTime <= 15) {
            const speed = (windowDist / windowTime) * 3600;
            if (speed > maxSpeed && speed < 120) { // Safety cap for absolute extreme outliers
                maxSpeed = speed;
                maxSpeedIdx = windowStartIdx;
            }
        }
    }
    
    return { speed: maxSpeed, idx: maxSpeedIdx !== -1 ? N_start + maxSpeedIdx : -1 };
}

/**
 * Analyze a pilot's track against the task to extract tactical metrics.
 * 
 * @param {Array} points - Array of { lat, lng, alt, time } from the parsed track
 * @param {Array} task - Array of { id, type, radius, lat, lng, elev }
 * @returns {Object} Tactical metrics
 */
// Helper to dynamically calculate remaining distance across multiple cylinders
export function calculateRemainingLegs(task, startIdx, endIdx) {
    if (startIdx >= endIdx) return 0;
    let dist = 0;
    for (let i = startIdx; i < endIdx; i++) {
        const t1 = task[i];
        const t2 = task[i+1];
        const dCenters = haversineDistance(t1, t2);
        if (dCenters === 0) {
            // Concentric cylinders
            dist += Math.abs((t1.radius / 1000) - (t2.radius / 1000));
        } else {
            // Standard cylinders: distance between centers minus radii
            dist += Math.max(0, dCenters - (t1.radius / 1000) - (t2.radius / 1000));
        }
    }
    return dist;
}

export function optimizeTaskRoute(task) {
    const N = task.length;
    if (N === 0) return [];
    
    const Q = [];
    for (let i = 0; i < N; i++) {
        Q.push({ lat: task[i].lat, lng: task[i].lng });
    }
    
    const maxIterations = 15;
    for (let iter = 0; iter < maxIterations; iter++) {
        for (let i = 1; i < N - 1; i++) {
            const center = task[i];
            const radiusKm = (center.radius || 0) / 1000;
            if (radiusKm <= 0) {
                Q[i] = { lat: center.lat, lng: center.lng };
                continue;
            }
            
            const prev = Q[i-1];
            const next = Q[i+1];
            
            let low = -Math.PI;
            let high = Math.PI;
            for (let t = 0; t < 15; t++) {
                const m1 = low + (high - low) / 3;
                const m2 = high - (high - low) / 3;
                
                const p1 = destinationPoint(center, radiusKm, m1);
                const p2 = destinationPoint(center, radiusKm, m2);
                
                const d1 = haversineDistance(prev, p1) + haversineDistance(p1, next);
                const d2 = haversineDistance(prev, p2) + haversineDistance(p2, next);
                
                if (d1 < d2) {
                    high = m2;
                } else {
                    low = m1;
                }
            }
            Q[i] = destinationPoint(center, radiusKm, (low + high) / 2);
        }
    }
    
    if (N > 1 && task[N-1].radius > 0) {
        const goalCenter = task[N-1];
        const prevPoint = Q[N-2];
        const brng = bearing(goalCenter, prevPoint);
        Q[N-1] = destinationPoint(goalCenter, goalCenter.radius / 1000, brng);
    }
    
    return Q;
}

export function getOptimizedTaskDistances(task) {
    const optPoints = optimizeTaskRoute(task);
    const distances = [0];
    let accum = 0;
    for (let i = 0; i < optPoints.length - 1; i++) {
        accum += haversineDistance(optPoints[i], optPoints[i+1]);
        distances.push(accum);
    }
    return { points: optPoints, distances: distances, totalDist: accum };
}

export function getOptimizedRemainingDist(p, task, targetIndex, goalIndex) {
    if (targetIndex > goalIndex) return 0;
    
    const sequence = [];
    sequence.push({ lat: p.lat, lng: p.lng, radius: 0, isExit: false });
    for (let i = targetIndex; i <= goalIndex; i++) {
        sequence.push(task[i]);
    }
    
    const N = sequence.length;
    const Q = [];
    for (let i = 0; i < N; i++) {
        Q.push({ lat: sequence[i].lat, lng: sequence[i].lng });
    }
    
    const maxIterations = 8;
    for (let iter = 0; iter < maxIterations; iter++) {
        for (let i = 1; i < N - 1; i++) {
            const center = sequence[i];
            const radiusKm = (center.radius || 0) / 1000;
            if (radiusKm <= 0) {
                Q[i] = { lat: center.lat, lng: center.lng };
                continue;
            }
            
            const prev = Q[i-1];
            const next = Q[i+1];
            
            let low = -Math.PI;
            let high = Math.PI;
            for (let t = 0; t < 12; t++) {
                const m1 = low + (high - low) / 3;
                const m2 = high - (high - low) / 3;
                
                const p1 = destinationPoint(center, radiusKm, m1);
                const p2 = destinationPoint(center, radiusKm, m2);
                
                const d1 = haversineDistance(prev, p1) + haversineDistance(p1, next);
                const d2 = haversineDistance(prev, p2) + haversineDistance(p2, next);
                
                if (d1 < d2) {
                    high = m2;
                } else {
                    low = m1;
                }
            }
            Q[i] = destinationPoint(center, radiusKm, (low + high) / 2);
        }
    }
    
    if (sequence[N-1].radius > 0) {
        const goalCenter = sequence[N-1];
        const prevPoint = Q[N-2];
        const brng = bearing(goalCenter, prevPoint);
        Q[N-1] = destinationPoint(goalCenter, goalCenter.radius / 1000, brng);
    }
    
    let totalDist = 0;
    for (let i = 0; i < N - 1; i++) {
        totalDist += haversineDistance(Q[i], Q[i+1]);
    }
    return totalDist;
}
function distanceToSegment(p, A, B) {
    const latMean = (A.lat + B.lat) / 2 * Math.PI / 180;
    const cosLat = Math.cos(latMean);
    
    const R = 6371; // km
    const ax = A.lng * Math.PI / 180 * cosLat * R;
    const ay = A.lat * Math.PI / 180 * R;
    const bx = B.lng * Math.PI / 180 * cosLat * R;
    const by = B.lat * Math.PI / 180 * R;
    const px = p.lng * Math.PI / 180 * cosLat * R;
    const py = p.lat * Math.PI / 180 * R;
    
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return haversineDistance(p, A);
    
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    
    const distX = px - projX;
    const distY = py - projY;
    return Math.sqrt(distX * distX + distY * distY);
}

export function getOptimizedRemainingDistWithGuess(p, task, targetIndex, goalIndex, Q_global, suffixDist) {
    if (targetIndex > goalIndex) return { dist: 0, T: p };
    
    if (targetIndex === goalIndex) {
        const goalCenter = task[goalIndex];
        if (goalCenter.radius > 0) {
            const brng = bearing(goalCenter, p);
            const T = destinationPoint(goalCenter, goalCenter.radius / 1000, brng);
            const dist = Math.max(0, haversineDistance(p, goalCenter) - goalCenter.radius / 1000);
            return { dist, T };
        } else {
            return { dist: haversineDistance(p, goalCenter), T: goalCenter };
        }
    }
    
    const sequence = [];
    sequence.push({ lat: p.lat, lng: p.lng, radius: 0 }); // Index 0: pilot position p
    
    const numToOptimize = Math.min(2, goalIndex - targetIndex);
    for (let i = 0; i <= numToOptimize; i++) {
        sequence.push(task[targetIndex + i]);
    }
    
    const hasFixedEndpoint = goalIndex - targetIndex > numToOptimize;
    if (hasFixedEndpoint) {
        const fixedIdx = targetIndex + numToOptimize + 1;
        sequence.push({ lat: Q_global[fixedIdx].lat, lng: Q_global[fixedIdx].lng, radius: 0 });
    }
    
    const N = sequence.length;
    const Q = [];
    Q.push({ lat: p.lat, lng: p.lng }); // Q[0] is p
    
    for (let i = 1; i < N; i++) {
        if (i === N - 1 && hasFixedEndpoint) {
            Q.push({ lat: sequence[i].lat, lng: sequence[i].lng });
        } else {
            const globalIdx = targetIndex + i - 1;
            Q.push({ lat: Q_global[globalIdx].lat, lng: Q_global[globalIdx].lng });
        }
    }
    
    const maxIterations = 3;
    for (let iter = 0; iter < maxIterations; iter++) {
        for (let i = 1; i < N - 1; i++) {
            const center = sequence[i];
            const radiusKm = (center.radius || 0) / 1000;
            if (radiusKm <= 0) {
                Q[i] = { lat: center.lat, lng: center.lng };
                continue;
            }
            
            const prev = Q[i-1];
            const next = Q[i+1];
            
            let low = -Math.PI;
            let high = Math.PI;
            for (let t = 0; t < 12; t++) {
                const m1 = low + (high - low) / 3;
                const m2 = high - (high - low) / 3;
                
                const p1 = destinationPoint(center, radiusKm, m1);
                const p2 = destinationPoint(center, radiusKm, m2);
                
                const d1 = haversineDistance(prev, p1) + haversineDistance(p1, next);
                const d2 = haversineDistance(prev, p2) + haversineDistance(p2, next);
                
                if (d1 < d2) {
                    high = m2;
                } else {
                    low = m1;
                }
            }
            Q[i] = destinationPoint(center, radiusKm, (low + high) / 2);
        }
    }
    
    if (!hasFixedEndpoint && sequence[N-1].radius > 0) {
        const goalCenter = sequence[N-1];
        const prevPoint = Q[N-2];
        const brng = bearing(goalCenter, prevPoint);
        Q[N-1] = destinationPoint(goalCenter, goalCenter.radius / 1000, brng);
    }
    
    let dist = 0;
    for (let i = 0; i < N - 1; i++) {
        dist += haversineDistance(Q[i], Q[i+1]);
    }
    
    if (hasFixedEndpoint) {
        const fixedIdx = targetIndex + numToOptimize + 1;
        dist += suffixDist[fixedIdx];
    }
    
    return { dist: dist, T: Q[1] };
}

export function analyzeTactics(points, task, startGateTime = null) {
    if (!points || points.length === 0) {
        return null;
    }

    const hasTask = task && task.length > 0;

    const essIndex = hasTask ? task.findIndex(t => t.type === 'es') : -1;
    const goalIndex = hasTask ? task.findIndex(t => t.type === 'goal') : -1;
    const ess = essIndex !== -1 ? task[essIndex] : null;
    const goal = goalIndex !== -1 ? task[goalIndex] : null;
    const endGoalIdx = goalIndex !== -1 ? goalIndex : (hasTask ? task.length - 1 : -1);

    // Slice subtask and precompute the globally optimized route Q_global once
    let Q_global = [];
    let suffixDist = [];
    let totalTaskDist = 0;

    if (hasTask) {
        const subTask = task.slice(0, endGoalIdx + 1);
        const optTask = getOptimizedTaskDistances(subTask);
        Q_global = optTask.points;
        const N_sub = subTask.length;

        // Precompute remaining suffix distances along the optimized path
        suffixDist = new Array(N_sub).fill(0);
        for (let i = N_sub - 2; i >= 0; i--) {
            suffixDist[i] = suffixDist[i+1] + haversineDistance(Q_global[i], Q_global[i+1]);
        }
        totalTaskDist = suffixDist[0];
    }

    // 1. Precalculate segment times and speeds for O(N) sliding window analysis
    const numPoints = points.length;
    const segmentDts = new Float64Array(numPoints - 1);
    const segmentSpeeds = new Float64Array(numPoints - 1);
    for (let i = 0; i < numPoints - 1; i++) {
        const p1 = points[i];
        const p2 = points[i+1];
        let dt = p2.time - p1.time;
        if (dt < -43200) {
            dt += 86400;
        }
        segmentDts[i] = dt;
        if (dt > 0) {
            const dist = haversineDistance(p1, p2);
            segmentSpeeds[i] = (dist / dt) * 3600;
        } else {
            segmentSpeeds[i] = 0;
        }
    }

    // Find firstMoveIdx (first time speed > 10 km/h for 60s) to bypass launch preparation
    let firstMoveIdx = 0;
    let windowTimeFM = 0;
    let movingTimeFM = 0;
    let startIdxFM = 0;
    for (let k = 0; k < numPoints - 1; k++) {
        const dt = segmentDts[k];
        if (dt <= 0 || dt > 60) {
            windowTimeFM = 0;
            movingTimeFM = 0;
            startIdxFM = k + 1;
            continue;
        }
        windowTimeFM += dt;
        if (segmentSpeeds[k] > 10) {
            movingTimeFM += dt;
        }
        while (startIdxFM < k && windowTimeFM - segmentDts[startIdxFM] >= 60) {
            windowTimeFM -= segmentDts[startIdxFM];
            if (segmentSpeeds[startIdxFM] > 10) {
                movingTimeFM -= segmentDts[startIdxFM];
            }
            startIdxFM++;
        }
        if (windowTimeFM >= 60 && (movingTimeFM / windowTimeFM) >= 0.85) {
            firstMoveIdx = startIdxFM;
            break;
        }
    }

    // Detect landing first on the entire track starting from firstMoveIdx to ignore post-race retrieval vehicle travel
    let landingIdx = -1;
    let windowTime = 0;
    let lowSpeedTime = 0;
    let startIdx = firstMoveIdx;

    for (let k = firstMoveIdx; k < numPoints - 1; k++) {
        const dt = segmentDts[k];
        
        // Time gap check
        if (dt > 180) {
            landingIdx = k;
            break;
        }
        
        if (dt <= 0 || dt > 60) {
            windowTime = 0;
            lowSpeedTime = 0;
            startIdx = k + 1;
            continue;
        }
        
        windowTime += dt;
        if (segmentSpeeds[k] < 12) {
            lowSpeedTime += dt;
        }
        
        while (startIdx < k && windowTime - segmentDts[startIdx] >= 120) {
            windowTime -= segmentDts[startIdx];
            if (segmentSpeeds[startIdx] < 12) {
                lowSpeedTime -= segmentDts[startIdx];
            }
            startIdx++;
        }
        
        if (windowTime >= 120 && (lowSpeedTime / windowTime) >= 0.85) {
            landingIdx = startIdx;
            break;
        }
    }
    let raceEndIdx = landingIdx !== -1 ? landingIdx + 1 : numPoints;

    const metrics = {
        ssCrossTime: null,
        speedSectionTime: null,
        essCrossTime: null,
        essCrossAlt: null,
        essGrNeededToGoal: null,
        finalGlideStartTime: null,
        finalGlideStartAlt: null,
        finalGlideGrToGoal: null,
        finalGlideDistToGoal: null,
        grToGoalSeries: [], // Array of { time, gr, distToGoal }
        grToEssSeries: [],  // Array of { time, gr }
        crossingDistances: {},
        maxSpeed10Sec: 0,
        maxSpeed10SecIdx: -1
    };

    let targetIndex = hasTask ? Math.min(1, task.length - 1) : -1; // Start heading to first turnpoint after launch
    let essCrossIdx = -1;
    let goalCrossIdx = -1;
    const crossingIndices = {};

    let lastT = null;
    let lastDistFromTToGoal = 0;
    let lastTargetIndex = -1;
    let lastOptimizedTime = null;

    if (hasTask) {
        for (let i = 0; i < raceEndIdx; i++) {
            const p = points[i];
            const target = task[targetIndex];
            
            const dCenter = haversineDistance(p, target);
            let dCyl = 0;
            let isCrossed = false;

            // CIVL Sporting Code 0.5% cylinder tolerance
            const TOLERANCE_KM = (target.radius / 1000) * 0.005;

            if (target.isExit) {
                dCyl = Math.max(0, (target.radius / 1000) - dCenter);
                if (dCenter >= (target.radius / 1000) - TOLERANCE_KM) isCrossed = true;
            } else {
                dCyl = Math.max(0, dCenter - (target.radius / 1000));
                if (dCenter <= (target.radius / 1000) + TOLERANCE_KM) isCrossed = true;
            }

            // Advance turnpoint if crossed
            if (isCrossed) {
                if (target.type === 'es' && essCrossIdx === -1) essCrossIdx = i;
                if (target.type === 'goal' && goalCrossIdx === -1) {
                    goalCrossIdx = i;
                    raceEndIdx = goalCrossIdx + 1; // Stop processing immediately once goal is crossed
                }
                
                if (crossingIndices[targetIndex] === undefined) {
                    crossingIndices[targetIndex] = i;
                }
                
                if (targetIndex < task.length - 1) {
                    targetIndex++;
                    // Recalculate target and dCyl for the new target index to prevent distance jumps
                    const newTarget = task[targetIndex];
                    const dCenterNew = haversineDistance(p, newTarget);
                    if (newTarget.isExit) {
                        dCyl = Math.max(0, (newTarget.radius / 1000) - dCenterNew);
                    } else {
                        dCyl = Math.max(0, dCenterNew - (newTarget.radius / 1000));
                    }
                }
            }

            // Calculate Distance to Goal
            const refElev = goal ? goal.elev : task[task.length - 1].elev;
            const heightAgl = Math.max(0.1, p.alt - refElev);

            // Dynamically calculate distance remaining along the legs using local dynamic re-optimization
            let totalDistToGoal = 0;
            if (goalCrossIdx === -1) {
                // Re-optimize only once a minute (>= 60 seconds), or if target index changed, or on first point
                let timeDiff = lastOptimizedTime !== null ? p.time - lastOptimizedTime : Infinity;
                if (timeDiff < -43200) {
                    timeDiff += 86400;
                }
                if (timeDiff >= 60 || targetIndex !== lastTargetIndex || !lastT) {
                    const res = getOptimizedRemainingDistWithGuess(p, task, targetIndex, endGoalIdx, Q_global, suffixDist);
                    lastT = res.T;
                    lastDistFromTToGoal = Math.max(0, res.dist - haversineDistance(p, lastT));
                    lastTargetIndex = targetIndex;
                    lastOptimizedTime = p.time;
                    totalDistToGoal = res.dist;
                } else {
                    totalDistToGoal = haversineDistance(p, lastT) + lastDistFromTToGoal;
                }
            }

            const grGoal = (totalDistToGoal * 1000) / heightAgl;

            // Calculate distFlown along the optimized course line
            let distFlown = 0;
            if (goalCrossIdx !== -1) {
                distFlown = totalTaskDist;
            } else {
                distFlown = Math.max(0, totalTaskDist - totalDistToGoal);
            }

            metrics.grToGoalSeries.push({ time: p.time, gr: grGoal, distToGoal: totalDistToGoal, distFlown: distFlown, targetIndex: targetIndex });

            // Calculate GR to ESS if it exists
            if (ess) {
                let totalDistToEss = 0;
                if (essCrossIdx !== -1) {
                    totalDistToEss = 0;
                } else if (targetIndex <= essIndex) {
                    const remainingToEss = calculateRemainingLegs(task, targetIndex, essIndex);
                    totalDistToEss = remainingToEss + dCyl;
                }
                const essHeightAgl = Math.max(0.1, p.alt - refElev); // Still use goal elevation as ground floor
                const grEss = (totalDistToEss * 1000) / essHeightAgl;
                metrics.grToEssSeries.push({ time: p.time, gr: grEss });
            }
        }
    }

    // 2. ESS Crossing Analysis
    if (hasTask && essCrossIdx !== -1 && goal) {
        const p = points[essCrossIdx];
        metrics.essCrossTime = p.time;
        metrics.essCrossAlt = p.alt;
        metrics.essGrNeededToGoal = metrics.grToGoalSeries[essCrossIdx].gr;
    }

    // 3. Final Glide Transition Detection (Starts after the last circle/thermal exit before searchEndIdx)
    if (hasTask && goal) {
        const searchEndIdx = essCrossIdx !== -1 ? essCrossIdx : (goalCrossIdx !== -1 ? goalCrossIdx : raceEndIdx - 1);
        
        // Precompute bearings for all segments up to searchEndIdx
        const bearings = new Float64Array(searchEndIdx + 1);
        for (let k = 0; k < searchEndIdx; k++) {
            const p1 = points[k];
            const p2 = points[k+1];
            const dLat = p2.lat - p1.lat;
            const dLng = (p2.lng - p1.lng) * Math.cos(p1.lat * Math.PI / 180);
            // Avoid division by zero/NaN if the points are identical
            bearings[k] = (dLat === 0 && dLng === 0) ? (k > 0 ? bearings[k-1] : 0) : Math.atan2(dLng, dLat) * 180 / Math.PI;
        }
        if (searchEndIdx > 0) {
            bearings[searchEndIdx] = bearings[searchEndIdx - 1];
        }
        
        // Detect if circling at each point k using a sliding 30-second window
        const isCircling = new Uint8Array(searchEndIdx + 1);
        let windowStart = 0;
        for (let k = 1; k <= searchEndIdx; k++) {
            while (windowStart < k) {
                let dt = points[k].time - points[windowStart].time;
                if (dt < -43200) dt += 86400;
                if (dt > 30) {
                    windowStart++;
                } else {
                    break;
                }
            }
            let sum = 0;
            for (let m = windowStart + 1; m <= k; m++) {
                let diff = bearings[m] - bearings[m-1];
                while (diff < -180) diff += 360;
                while (diff > 180) diff -= 360;
                sum += diff;
            }
            if (Math.abs(sum) >= 250) {
                isCircling[k] = 1;
            }
        }
        
        // Find the last circling index
        let lastCircleIdx = -1;
        for (let k = searchEndIdx; k >= 0; k--) {
            if (isCircling[k] === 1) {
                lastCircleIdx = k;
                break;
            }
        }
        
        // Final glide starts after the last circle, bounded by 0 and searchEndIdx
        let finalGlideIdx = 0;
        if (lastCircleIdx !== -1) {
            finalGlideIdx = Math.min(searchEndIdx, lastCircleIdx + 1);
        }

        const p = points[finalGlideIdx];
        metrics.finalGlideStartTime = p.time;
        metrics.finalGlideStartAlt = p.alt;
        metrics.finalGlideDistToGoal = metrics.grToGoalSeries[finalGlideIdx].distToGoal;
        metrics.finalGlideGrToGoal = metrics.grToGoalSeries[finalGlideIdx].gr;
    }

    // Find last crossing of start cylinder (index 1)
    if (task.length > 1) {
        const startCyl = task[1];
        const rKm = startCyl.radius / 1000;
        const tolKm = rKm * 0.005;
        
        let wasInside = false;
        if (points.length > 0) {
            const d = haversineDistance(points[0], startCyl);
            wasInside = startCyl.isExit ? (d <= rKm - tolKm) : (d <= rKm + tolKm);
        }
        
        const tp2CrossIdx = crossingIndices[2] !== undefined ? crossingIndices[2] : points.length;
        let lastStartCrossIdx = -1;
        
        for (let k = 1; k < tp2CrossIdx; k++) {
            const d = haversineDistance(points[k], startCyl);
            const isInside = startCyl.isExit ? (d <= rKm - tolKm) : (d <= rKm + tolKm);
            
            if (startCyl.isExit) {
                if (wasInside && !isInside) {
                    if (startGateTime === null || points[k].time >= startGateTime) {
                        lastStartCrossIdx = k;
                    }
                }
            } else {
                if (!wasInside && isInside) {
                    if (startGateTime === null || points[k].time >= startGateTime) {
                        lastStartCrossIdx = k;
                    }
                }
            }
            wasInside = isInside;
        }
        
        if (lastStartCrossIdx !== -1) {
            crossingIndices[1] = lastStartCrossIdx;
        }
    }

    // Map crossingIndices to distFlown values
    for (const tpIdx in crossingIndices) {
        const ptIdx = crossingIndices[tpIdx];
        const s = metrics.grToGoalSeries[ptIdx];
        if (s) {
            metrics.crossingDistances[tpIdx] = s.distFlown;
        }
    }
    
    // Populate ssCrossTime and speedSectionTime
    if (crossingIndices[1] !== undefined) {
        metrics.ssCrossTime = points[crossingIndices[1]].time;
        if (essCrossIdx !== -1) {
            const referenceStartTime = (startGateTime !== null) ? startGateTime : metrics.ssCrossTime;
            let elapsed = points[essCrossIdx].time - referenceStartTime;
            if (elapsed < 0) elapsed += 86400;
            metrics.speedSectionTime = elapsed;
        }
    }
    
    // Detect takeoff by scanning backward from raceEndIdx to find the last stationary period before flight
    let raceStartIdx = 0;
    let takeoffIdx = -1;
    let windowTimeTO = 0;
    let lowSpeedTimeTO = 0;
    let startIdxTO = raceEndIdx - 2;

    for (let k = raceEndIdx - 2; k >= 0; k--) {
        const dt = segmentDts[k];
        
        // Time gap check
        if (dt > 180) {
            takeoffIdx = k + 1;
            break;
        }
        
        if (dt <= 0 || dt > 60) {
            windowTimeTO = 0;
            lowSpeedTimeTO = 0;
            startIdxTO = k - 1;
            continue;
        }
        
        windowTimeTO += dt;
        if (segmentSpeeds[k] < 8) {
            lowSpeedTimeTO += dt;
        }
        
        while (startIdxTO > k && windowTimeTO - segmentDts[startIdxTO] >= 60) {
            windowTimeTO -= segmentDts[startIdxTO];
            if (segmentSpeeds[startIdxTO] < 8) {
                lowSpeedTimeTO -= segmentDts[startIdxTO];
            }
            startIdxTO--;
        }
        
        if (windowTimeTO >= 60 && (lowSpeedTimeTO / windowTimeTO) >= 0.85) {
            takeoffIdx = startIdxTO + 1;
            break;
        }
    }
    if (takeoffIdx !== -1) {
        raceStartIdx = takeoffIdx;
    }
    
    const resSpeed = calculateMax10SecSpeed(points, raceStartIdx, raceEndIdx);
    metrics.maxSpeed10Sec = resSpeed.speed;
    metrics.maxSpeed10SecIdx = resSpeed.idx;

    return metrics;
}
