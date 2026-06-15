export function integratePgWeightCurve(q1, q2) {
    // Integrate the standard weighting curve.
    // FAI GAP places heavier weight on leading later in the speed section.
    // Standard geometric curve uses x^2 weighting -> (q2^3 - q1^3)/3.
    // We'll use the squared curve (q2^2 - q1^2)/2 to better match FAI.
    return Math.max(0, (Math.pow(q2, 2) - Math.pow(q1, 2)) / 2.0);
}

function calculateLeadingPointsCore(tracks, availableLeadPoints, speedSectionDist, taskDeadline, firstStartTime, lastOutlandingTime, lastEssTime) {
    if (!tracks || tracks.length === 0 || speedSectionDist <= 0) return;

    let lcMin = Infinity;
    
    // 1. Calculate Leading Coefficient (LC) for each track
    for (const track of tracks) {
        if (track.visible === false || !track.tactics || !track.tactics.ss_trackpoints || track.tactics.ss_trackpoints.length === 0) {
            track.lc = Infinity;
            if (track.tactics) track.tactics.finalLeadingPoints = 0;
            continue;
        }

        let leadingArea = 0;
        const ssPts = track.tactics.ss_trackpoints;
        let minDistSoFarPrev = ssPts[0].minDistToEss;

        for (let i = 1; i < ssPts.length; i++) {
            const currPt = ssPts[i];
            
            const minToEssCurr = currPt.minDistToEss;
            // Convert ms to seconds!
            const taskTime = Math.max(0, Math.min(currPt.time, taskDeadline) - firstStartTime);
            
            const donePrev = 1.0 - (minDistSoFarPrev / speedSectionDist);
            const doneCurr = 1.0 - (minToEssCurr / speedSectionDist);
            
            const weight = integratePgWeightCurve(donePrev, doneCurr);
            
            // FAI GAP integrates Time * dWeight to find the area under the t(x) graph.
            leadingArea += taskTime * weight;
            
            minDistSoFarPrev = minToEssCurr;
        }
        
        // 2. Missing Area Penalty
        const bestPt = track.tactics.best_ss_trackpoint;
        if (!bestPt) {
            track.lc = Infinity;
            track.tactics.finalLeadingPoints = 0;
            continue;
        }

        const doneBest = 1.0 - (bestPt.minDistToEss / speedSectionDist);
        const missingWeight = integratePgWeightCurve(doneBest, 1.0);
        
        // Convert ms to seconds!
        const maxTime = Math.max(0, Math.min(Math.max(lastOutlandingTime, lastEssTime), taskDeadline) - firstStartTime);
        const missingArea = maxTime * missingWeight;
        
        // 3. Final LC Calculation
        // Since we removed distance from the area integral, the denominator should not have speedSectionDist squared,
        // it's just scaled by the area geometry. Wait, the formula normalizes the units out.
        // Actually, FAI GAP denominator is usually 1800 * speedSectionDist or just 1800. 
        // We'll keep the LC calculation proportional because leadingFactor normalizes against lcMin anyway.
        track.lc = (leadingArea + missingArea) / (1800 * speedSectionDist);
        if (track.lc < lcMin) {
            lcMin = track.lc;
        }
    }

    // 4. Normalize and allocate points across the field
    for (const track of tracks) {
        if (track.lc === Infinity) {
            if (track.tactics) track.tactics.finalLeadingPoints = 0;
            continue;
        }
        
        // The Leading Factor curve limits exponential point bleeding.
        let leadingFactor = 0;
        if (lcMin > 0 && track.lc >= lcMin) {
            const val = ((track.lc - lcMin) / Math.sqrt(lcMin));
            leadingFactor = Math.max(0.0, 1.0 - Math.pow(val, 1.0/3.0));
        } else if (track.lc === lcMin) {
            leadingFactor = 1.0;
        }

        if (isNaN(leadingFactor)) leadingFactor = 0;

        // Final rounding
        track.tactics.finalLeadingPoints = parseFloat((leadingFactor * availableLeadPoints).toFixed(1));
    }
}

export function calculateLeadingPoints(tracks, availableLeadPoints, speedSectionDist, taskDeadline, firstStartTime, lastOutlandingTime, lastEssTime, currentTime = Infinity) {
    if (!tracks || tracks.length === 0 || speedSectionDist <= 0) return;

    // 1. Ensure final points are calculated
    let needsFinalCalc = false;
    for (const track of tracks) {
        if (track.visible !== false && track.tactics && track.tactics.finalLeadingPoints === undefined) {
            needsFinalCalc = true;
            break;
        }
    }

    if (needsFinalCalc) {
        calculateLeadingPointsCore(tracks, availableLeadPoints, speedSectionDist, taskDeadline, firstStartTime, lastOutlandingTime, lastEssTime);
    }

    // 2. Distribute points based on accumulated lead weight up to currentTime
    for (const track of tracks) {
        if (track.visible === false || !track.tactics || !track.tactics.ss_trackpoints || track.tactics.ss_trackpoints.length === 0) {
            track.leadingPoints = 0;
            continue;
        }

        const ssPts = track.tactics.ss_trackpoints;
        let minDistSoFarPrev = ssPts[0].minDistToEss;
        
        let currentLeadWeight = 0;

        for (let i = 1; i < ssPts.length; i++) {
            const currPt = ssPts[i];
            const minToEssCurr = currPt.minDistToEss;
            
            const donePrev = 1.0 - (minDistSoFarPrev / speedSectionDist);
            const doneCurr = 1.0 - (minToEssCurr / speedSectionDist);
            const weight = integratePgWeightCurve(donePrev, doneCurr);
            
            if (currPt.time <= currentTime) {
                currentLeadWeight += weight;
            }
            
            minDistSoFarPrev = minToEssCurr;
        }
        
        // The total lead weight should just be the sum up to the end of the pilot's flight
        if (!track.tactics.totalLeadWeight) {
            let totalLeadWeight = 0;
            let tempMinDist = ssPts[0].minDistToEss;
            for (let i = 1; i < ssPts.length; i++) {
                const pt = ssPts[i];
                const w = integratePgWeightCurve(1.0 - (tempMinDist / speedSectionDist), 1.0 - (pt.minDistToEss / speedSectionDist));
                totalLeadWeight += w;
                tempMinDist = pt.minDistToEss;
            }
            track.tactics.totalLeadWeight = totalLeadWeight > 0 ? totalLeadWeight : 1e-9;
        }
        
        const ratio = Math.min(1.0, currentLeadWeight / track.tactics.totalLeadWeight);
        track.leadingPoints = parseFloat((track.tactics.finalLeadingPoints * ratio).toFixed(1));
    }
}

export function calculateTimePoints(tracks, availableTimePoints, currentTime = Infinity) {
    if (!tracks || tracks.length === 0) return;

    // 1. Determine the Best Time among pilots who reached goal
    let bestTimeHours = Infinity;
    let goalPilotsCount = 0;
    
    for (const track of tracks) {
        if (track.visible === false || !track.tactics) continue;
        
        // Ensure they have a valid speed section time and reached ESS by currentTime
        const ssTimeSec = track.tactics.speedSectionTime;
        const essTime = track.tactics.essCrossTime;
        
        if (ssTimeSec && ssTimeSec > 0 && essTime && currentTime >= essTime) {
            const ssTimeHours = ssTimeSec / 3600.0;
            
            // Check if they reached goal
            const pts = track.points;
            let reachedGoal = false;
            
            // They only officially "reach goal" in replay if playback has reached their goal crossing time!
            const goalTime = track.tactics.goalCrossTime;
            if (goalTime && currentTime >= goalTime) {
                reachedGoal = true;
            } else if (!goalTime && pts && pts.length > 0 && track.tactics.grToGoalSeries && track.tactics.grToGoalSeries.length > 0) {
                const lastIdx = Math.min(pts.length - 1, track.tactics.grToGoalSeries.length - 1);
                const finalPtTime = pts[lastIdx].time;
                const finalDistToGoal = track.tactics.grToGoalSeries[lastIdx].distToGoal;
                if (finalDistToGoal !== undefined && finalDistToGoal <= 0.0 && currentTime >= finalPtTime) {
                    reachedGoal = true;
                }
            }
            
            track.tactics.reachedGoal = reachedGoal;
            
            if (reachedGoal) {
                goalPilotsCount++;
                if (ssTimeHours < bestTimeHours) {
                    bestTimeHours = ssTimeHours;
                }
            }
        } else {
            track.tactics.reachedGoal = false;
        }
    }

    if (goalPilotsCount === 0 || bestTimeHours === Infinity) {
        // Nobody reaches goal (or playback hasn't reached it) -> 0 time points
        for (const track of tracks) {
            track.timePoints = 0.0;
        }
        return;
    }

    // 2. Calculate Speed Fraction and Final Time Points
    for (const track of tracks) {
        if (track.visible === false || !track.tactics) {
            track.timePoints = 0.0;
            continue;
        }

        const ssTimeSec = track.tactics.speedSectionTime;
        const essTime = track.tactics.essCrossTime;
        const reachedEss = (ssTimeSec && ssTimeSec > 0 && essTime && currentTime >= essTime);
        
        if (!reachedEss || !track.tactics.reachedGoal) {
            track.timePoints = 0.0;
            continue;
        }

        const pilotTimeHours = ssTimeSec / 3600.0;
        const timeDiff = pilotTimeHours - bestTimeHours;
        const rootBest = Math.sqrt(bestTimeHours);
        
        let speedFraction = 0.0;
        if (timeDiff < rootBest) {
            const ratio = timeDiff / rootBest;
            speedFraction = Math.max(0.0, 1.0 - Math.pow(ratio, 5.0 / 6.0));
        }

        track.timePoints = parseFloat((speedFraction * availableTimePoints).toFixed(1));
    }
}
