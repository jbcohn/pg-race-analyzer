import { calculateRemainingLegs } from './shared/tactics.js';
import { haversineDistance } from './shared/geo-math.js';

export class SideView {
    constructor(containerId, canvasId) {
        this.container = document.getElementById(containerId);
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        
        this.viewport = {
            offsetX: 0,
            offsetY: 0,
            scaleX: 1,  // px per km
            scaleY: 1   // px per ft
        };
        
        this.isDragging = false;
        this.lastMouse = { x: 0, y: 0 };
        this.lastState = null;
        this.hasAutoFit = false;
        
        this.hoveredPilot = null;
        this.pilotCoords = [];
        
        this.setupEventListeners();
        this.resize();
        window.addEventListener('resize', () => {
            this.hasAutoFit = false;
            this.resize();
        });
    }

    resize() {
        if (!this.container) return;
        const rect = this.container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.hasAutoFit = false;
        if (this.lastState) this.render(this.lastState);
    }

    autoFitToData(totalTaskDist, minAltFt, maxAltFt) {
        const W = this.canvas.width;
        const H = this.canvas.height;
        if (W === 0 || H === 0) return;

        const padding = { left: 55, right: 20, top: 20, bottom: 30 };
        const usableW = W - padding.left - padding.right;
        const usableH = H - padding.top - padding.bottom;

        // Add vertical margin
        const altRange = maxAltFt - minAltFt;
        const displayMinAlt = Math.max(0, minAltFt - altRange * 0.05);
        const displayMaxAlt = maxAltFt + altRange * 0.1;
        const displayAltRange = displayMaxAlt - displayMinAlt;

        if (totalTaskDist <= 0 || displayAltRange <= 0) return;

        this.viewport.scaleX = usableW / totalTaskDist;
        this.viewport.scaleY = usableH / displayAltRange;

        // offsetX: mapX(0) = offsetX + 0 * scaleX = offsetX => padding.left
        this.viewport.offsetX = padding.left;

        // offsetY: mapY(displayMinAlt) should be at H - padding.bottom
        // mapY(ft) = offsetY - ft * scaleY
        // H - padding.bottom = offsetY - displayMinAlt * scaleY
        this.viewport.offsetY = (H - padding.bottom) + displayMinAlt * this.viewport.scaleY;

        this.hasAutoFit = true;
    }

    setupEventListeners() {
        this.canvas.addEventListener('mousedown', (e) => {
            this.isDragging = true;
            this.lastMouse = { x: e.clientX, y: e.clientY };
        });

        window.addEventListener('mouseup', () => {
            this.isDragging = false;
        });

        window.addEventListener('mousemove', (e) => {
            if (!this.isDragging) return;
            const dx = e.clientX - this.lastMouse.x;
            this.viewport.offsetX += dx;
            this.lastMouse = { x: e.clientX, y: e.clientY };
            if (this.lastState) this.render(this.lastState);
        });

        this.canvas.addEventListener('mousemove', (e) => {
            if (this.isDragging) return;
            
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            
            let foundHover = null;
            let minDist = 15; // Proximity threshold in pixels
            
            for (const pc of this.pilotCoords) {
                const dx = mouseX - pc.x;
                const dy = mouseY - pc.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist < minDist) {
                    minDist = dist;
                    foundHover = pc.track;
                }
            }
            
            if (foundHover !== this.hoveredPilot) {
                this.hoveredPilot = foundHover;
                this.canvas.style.cursor = foundHover ? 'pointer' : '';
                if (this.lastState) this.render(this.lastState);
            }
        });

        this.canvas.addEventListener('mouseleave', () => {
            if (this.hoveredPilot) {
                this.hoveredPilot = null;
                this.canvas.style.cursor = '';
                if (this.lastState) this.render(this.lastState);
            }
        });

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const zoomSensitivity = 0.003;
            const zoomFactor = Math.exp(-e.deltaY * zoomSensitivity);
            
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            
            const distX = mouseX - this.viewport.offsetX;
            
            this.viewport.scaleX *= zoomFactor;
            this.viewport.offsetX = mouseX - distX * zoomFactor;
            
            if (this.lastState) this.render(this.lastState);
        }, { passive: false });
    }

    resolveColor(color) {
        if (color && color.startsWith('var(')) {
            const varName = color.slice(4, -1).trim();
            return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || '#ffffff';
        }
        return color;
    }

    render(state) {
        this.lastState = state;
        
        // Reset auto-fit zoom if the tracks, task, or visibility of tracks changes
        const visibleTrackCount = (state.tracks || []).filter(t => t.visible !== false).length;
        const trackCount = (state.tracks || []).length;
        const taskLength = (state.task || []).length;
        
        if (this.lastTrackCount !== trackCount || 
            this.lastTaskLength !== taskLength ||
            this.lastVisibleTrackCount !== visibleTrackCount) {
            this.hasAutoFit = false;
            this.lastTrackCount = trackCount;
            this.lastTaskLength = taskLength;
            this.lastVisibleTrackCount = visibleTrackCount;
        }

        this.pilotCoords = [];
        const ctx = this.ctx;
        
        // Auto-resize canvas if container dimensions changed
        const containerRect = this.container.getBoundingClientRect();
        if (containerRect.width === 0 || containerRect.height === 0) return;
        if (this.canvas.width !== Math.floor(containerRect.width) || this.canvas.height !== Math.floor(containerRect.height)) {
            this.canvas.width = Math.floor(containerRect.width);
            this.canvas.height = Math.floor(containerRect.height);
            this.hasAutoFit = false;
        }

        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        if (!state.task || state.task.length === 0) return;

        const goalIndex = state.task.findIndex(t => t.type === 'goal');
        const endGoalIdx = goalIndex !== -1 ? goalIndex : state.task.length - 1;
        const optTask = state.optimizedTask;
        const totalTaskDist = optTask ? optTask.totalDist : calculateRemainingLegs(state.task, 0, endGoalIdx);
        const goalTP = state.task[endGoalIdx];
        const goalRadiusKm = (goalTP.radius || 0) / 1000;
        const maxScaleDist = totalTaskDist + goalRadiusKm;

        // Compute altitude bounds from terrain profile (or task elevations) AND pilot tracks
        let minAltFt = Infinity;
        let maxAltFt = -Infinity;

        // Use terrain profile if available, otherwise task turnpoint elevations
        const terrainProfile = state.terrainProfile || null;
        if (terrainProfile && terrainProfile.length > 0) {
            for (const pt of terrainProfile) {
                if (pt.elevFt < minAltFt) minAltFt = pt.elevFt;
                if (pt.elevFt > maxAltFt) maxAltFt = pt.elevFt;
            }
        } else {
            for (let i = 0; i <= endGoalIdx; i++) {
                const elevFt = (state.task[i].elev || 0) * 3.28084;
                if (elevFt < minAltFt) minAltFt = elevFt;
                if (elevFt > maxAltFt) maxAltFt = elevFt;
            }
        }

        // Include pilot altitude range using the full track to ensure vertical scale stability
        state.tracks.forEach(track => {
            if (track.visible === false || !track.points) return;
            for (let i = 0; i < track.points.length; i++) {
                const altFt = track.points[i].alt * 3.28084;
                if (altFt < minAltFt) minAltFt = altFt;
                if (altFt > maxAltFt) maxAltFt = altFt;
            }
        });

        if (minAltFt === Infinity) minAltFt = 0;
        if (maxAltFt === -Infinity) maxAltFt = 2000;
        // Set ceiling to 500' above max altitude
        maxAltFt += 500;
        if (maxAltFt - minAltFt < 1000) maxAltFt = minAltFt + 1000;

        // Auto-fit viewport on first render or after resize
        if (!this.hasAutoFit) {
            this.autoFitToData(maxScaleDist, minAltFt, maxAltFt);
        }

        const mapX = (km) => this.viewport.offsetX + (km * this.viewport.scaleX);
        const mapY = (ft) => this.viewport.offsetY - (ft * this.viewport.scaleY);

        // --- Grid lines and axis labels ---
        ctx.save();
        ctx.font = '10px Inter, Arial, sans-serif';
        
        // Y-axis altitude grid lines
        const altStep = this.chooseStep((maxAltFt - minAltFt) * 1.2, 6);
        const altGridStart = Math.floor(Math.max(0, minAltFt - (maxAltFt - minAltFt) * 0.1) / altStep) * altStep;
        const altGridEnd = maxAltFt + (maxAltFt - minAltFt) * 0.2;
        
        for (let alt = altGridStart; alt <= altGridEnd; alt += altStep) {
            const y = mapY(alt);
            if (y < 0 || y > this.canvas.height - 25) continue;
            
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(50, y);
            ctx.lineTo(this.canvas.width, y);
            ctx.stroke();
            
            ctx.fillStyle = '#64748b';
            ctx.textAlign = 'right';
            ctx.fillText(`${Math.round(alt)} ft`, 48, y + 3);
        }

        const invMapX = (x) => (x - this.viewport.offsetX) / this.viewport.scaleX;

        // X-axis distance grid lines
        const visibleTaskDist = (this.canvas.width - 50) / this.viewport.scaleX;
        const distStep = this.chooseStep(visibleTaskDist, 8);
        const startKm = Math.max(0, Math.floor(invMapX(50) / distStep) * distStep);
        const endKm = Math.min(maxScaleDist, Math.ceil(invMapX(this.canvas.width) / distStep) * distStep);

        for (let d = startKm; d <= endKm; d += distStep) {
            const x = mapX(d);
            if (x < 50 || x > this.canvas.width) continue;
            
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.canvas.height - 25);
            ctx.stroke();
        }
        ctx.restore();

        // --- 1. Waypoint Cylinder Crossing Lines ---
        state.tracks.forEach(track => {
            if (track.visible === false || !track.tactics || !track.tactics.grToGoalSeries) return;
            
            if (track.tactics.crossingDistances) {
                for (const tpIdxStr in track.tactics.crossingDistances) {
                    const tpIdx = parseInt(tpIdxStr, 10);
                    const crossDist = track.tactics.crossingDistances[tpIdx];
                    if (crossDist !== undefined) {
                        const tp = state.task[tpIdx];
                        if (!tp) continue;
                        
                        ctx.save();
                        let strokeColor = 'rgba(59, 130, 246, 0.75)'; // blue
                        if (tp.type === 'ss') {
                            strokeColor = 'rgba(34, 197, 94, 0.75)'; // green
                        } else if (tp.type === 'es') {
                            strokeColor = 'rgba(249, 115, 22, 0.75)'; // orange
                        } else if (tp.type === 'goal') {
                            strokeColor = 'rgba(239, 68, 68, 0.75)'; // red
                        }
                        
                        ctx.strokeStyle = strokeColor;
                        ctx.lineWidth = 1.2;
                        if (tp.type === 'turnpoint' || tp.isExit) {
                            ctx.setLineDash([4, 4]);
                        }
                        
                        const x = mapX(crossDist);
                        ctx.beginPath();
                        ctx.moveTo(x, 0);
                        ctx.lineTo(x, this.canvas.height - 25);
                        ctx.stroke();
                        ctx.restore();
                    }
                }
            }
        });

        // --- 2. Ground Profile ---
        const panelBgColor = this.resolveColor('var(--bg-panel)');
        if (terrainProfile && terrainProfile.length > 0) {
            // A. Solid mask using background color to cover cylinders below ground
            ctx.fillStyle = panelBgColor;
            ctx.beginPath();
            ctx.moveTo(mapX(terrainProfile[0].distKm), this.canvas.height);
            for (const pt of terrainProfile) {
                ctx.lineTo(mapX(pt.distKm), mapY(pt.elevFt));
            }
            ctx.lineTo(mapX(terrainProfile[terrainProfile.length - 1].distKm), this.canvas.height);
            ctx.closePath();
            ctx.fill();

            // B. Detailed DEM terrain fill
            ctx.fillStyle = 'rgba(133, 77, 14, 0.18)';
            ctx.beginPath();
            ctx.moveTo(mapX(terrainProfile[0].distKm), this.canvas.height);
            for (const pt of terrainProfile) {
                ctx.lineTo(mapX(pt.distKm), mapY(pt.elevFt));
            }
            ctx.lineTo(mapX(terrainProfile[terrainProfile.length - 1].distKm), this.canvas.height);
            ctx.closePath();
            ctx.fill();

            // C. Terrain top edge stroke
            ctx.strokeStyle = '#854d0e';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i < terrainProfile.length; i++) {
                const pt = terrainProfile[i];
                if (i === 0) ctx.moveTo(mapX(pt.distKm), mapY(pt.elevFt));
                else ctx.lineTo(mapX(pt.distKm), mapY(pt.elevFt));
            }
            ctx.stroke();
        } else {
            // Fallback solid mask
            // Fallback solid mask
            ctx.fillStyle = panelBgColor;
            ctx.beginPath();
            ctx.moveTo(mapX(0), this.canvas.height);
            for (let i = 0; i <= endGoalIdx; i++) {
                const tp = state.task[i];
                const distFlown = optTask ? optTask.distances[i] : (totalTaskDist - calculateRemainingLegs(state.task, i, endGoalIdx));
                const radiusKm = (tp.radius || 0) / 1000;
                let centerDist = distFlown;
                if (tp.isExit) {
                    centerDist = i > 0 ? (optTask ? optTask.distances[i - 1] : 0) : 0;
                } else if (tp.type === 'es' || tp.type === 'goal') {
                    centerDist = distFlown + radiusKm;
                }
                const elevFt = (tp.elev || 0) * 3.28084;
                ctx.lineTo(mapX(centerDist), mapY(elevFt));
            }
            ctx.lineTo(mapX(maxScaleDist), this.canvas.height);
            ctx.closePath();
            ctx.fill();

            // Fallback: crude turnpoint-to-turnpoint interpolation
            ctx.fillStyle = 'rgba(133, 77, 14, 0.2)';
            ctx.beginPath();
            ctx.moveTo(mapX(0), this.canvas.height);
            for (let i = 0; i <= endGoalIdx; i++) {
                const tp = state.task[i];
                const distFlown = optTask ? optTask.distances[i] : (totalTaskDist - calculateRemainingLegs(state.task, i, endGoalIdx));
                const radiusKm = (tp.radius || 0) / 1000;
                let centerDist = distFlown;
                if (tp.isExit) {
                    centerDist = i > 0 ? (optTask ? optTask.distances[i - 1] : 0) : 0;
                } else if (tp.type === 'es' || tp.type === 'goal') {
                    centerDist = distFlown + radiusKm;
                }
                const elevFt = (tp.elev || 0) * 3.28084;
                ctx.lineTo(mapX(centerDist), mapY(elevFt));
            }
            ctx.lineTo(mapX(maxScaleDist), this.canvas.height);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = '#854d0e';
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i <= endGoalIdx; i++) {
                const tp = state.task[i];
                const distFlown = optTask ? optTask.distances[i] : (totalTaskDist - calculateRemainingLegs(state.task, i, endGoalIdx));
                const radiusKm = (tp.radius || 0) / 1000;
                let centerDist = distFlown;
                if (tp.isExit) {
                    centerDist = i > 0 ? (optTask ? optTask.distances[i - 1] : 0) : 0;
                } else if (tp.type === 'es' || tp.type === 'goal') {
                    centerDist = distFlown + radiusKm;
                }
                const elevFt = (tp.elev || 0) * 3.28084;
                if (i === 0) ctx.moveTo(mapX(centerDist), mapY(elevFt));
                else ctx.lineTo(mapX(centerDist), mapY(elevFt));
            }
            ctx.stroke();
        }

        // Draw individual pilot terrain profiles if available
        state.tracks.forEach(track => {
            if (track.visible === false || !track.terrainProfile || track.terrainProfile.length === 0) return;
            
            const resolvedColor = this.resolveColor(track.color);
            ctx.save();
            ctx.strokeStyle = resolvedColor;
            ctx.lineWidth = 1.0;
            ctx.globalAlpha = 0.55; // slightly transparent to not clutter
            ctx.beginPath();
            
            for (let i = 0; i < track.terrainProfile.length; i++) {
                const pt = track.terrainProfile[i];
                const x = mapX(pt.distKm);
                const y = mapY(pt.elevFt);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.restore();
        });

        // --- 3. Turnpoint labels ---
        for (let i = 0; i <= endGoalIdx; i++) {
            const tp = state.task[i];
            const distFlown = optTask ? optTask.distances[i] : (totalTaskDist - calculateRemainingLegs(state.task, i, endGoalIdx));
            const radiusKm = (tp.radius || 0) / 1000;
            const elevFt = (tp.elev || 0) * 3.28084;
            
            let centerDist = distFlown;
            if (tp.isExit) {
                centerDist = i > 0 ? (optTask ? optTask.distances[i - 1] : 0) : 0;
            } else if (tp.type === 'es' || tp.type === 'goal') {
                centerDist = distFlown + radiusKm;
            }
            
            ctx.fillStyle = '#94a3b8';
            ctx.font = '600 10px Inter, Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(tp.id, mapX(centerDist), mapY(elevFt) - 10);
        }

        // --- 2. Pilot Snail Trails ---
        state.tracks.forEach(track => {
            if (track.visible === false || !track.tactics || !track.tactics.grToGoalSeries) return;
            
            const series = track.tactics.grToGoalSeries;
            if (series.length === 0) return;
            
            let currentIdx = track.currentPosIndex;
            if (currentIdx === undefined) currentIdx = series.length - 1;
            
            const resolvedColor = this.resolveColor(track.color);
            ctx.strokeStyle = resolvedColor;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            
            let lastX = null;
            let lastY = null;
            let started = false;
            
            for (let i = 0; i <= currentIdx; i++) {
                const s = series[i];
                if (!s || s.distToGoal === undefined) continue;
                
                const pt = track.points[i];
                const distFlown = s.distFlown !== undefined ? s.distFlown : Math.max(0, Math.min(totalTaskDist, totalTaskDist - s.distToGoal));
                const altFt = pt.alt * 3.28084;
                

                
                const x = mapX(distFlown);
                const y = mapY(altFt);
                
                if (lastX !== null && lastY !== null) {
                    const dx = x - lastX;
                    const dy = y - lastY;
                    if (Math.abs(dx) < 0.75 && Math.abs(dy) < 0.75 && i < currentIdx) {
                        continue;
                    }
                }
                
                if (!started) {
                    ctx.moveTo(x, y);
                    started = true;
                } else {
                    ctx.lineTo(x, y);
                }
                
                lastX = x;
                lastY = y;
            }
            ctx.stroke();
            
            // Pilot dot
            if (lastX !== null && lastY !== null) {
                // Populate coordinate list for hover detection
                this.pilotCoords.push({ x: lastX, y: lastY, track });

                ctx.fillStyle = resolvedColor;
                ctx.beginPath();
                ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5;
                ctx.stroke();
                
                // Draw pilot name label
                ctx.save();
                ctx.font = 'bold 9px Inter, Arial, sans-serif';
                ctx.fillStyle = resolvedColor;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                
                const labelText = track.initials || track.name;
                const textWidth = ctx.measureText(labelText).width;
                
                // Draw background box for readability
                ctx.fillStyle = 'rgba(15, 23, 42, 0.75)'; // dark background matching var(--bg-main)
                ctx.fillRect(lastX + 8, lastY - 6, textWidth + 6, 12);
                
                ctx.fillStyle = resolvedColor;
                ctx.fillText(labelText, lastX + 11, lastY);
                ctx.restore();
            }
        });

        // --- 5. Draw Horizontal Distance Scale Bar ---
        const yScaleLine = this.canvas.height - 25;
        ctx.save();
        ctx.strokeStyle = '#334155'; // slate-700
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(50, yScaleLine);
        ctx.lineTo(this.canvas.width, yScaleLine);
        ctx.stroke();
        
        ctx.fillStyle = '#94a3b8'; // slate-400
        ctx.font = '500 10px Inter, Arial, sans-serif';
        ctx.textAlign = 'center';
        
        for (let d = startKm; d <= endKm; d += distStep) {
            const x = mapX(d);
            
            ctx.strokeStyle = '#475569'; // slate-600
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, yScaleLine);
            ctx.lineTo(x, yScaleLine + 4);
            ctx.stroke();
            
            const labelStr = (d % 1 === 0) ? `${d} km` : `${d.toFixed(1)} km`;
            ctx.fillText(labelStr, x, yScaleLine + 15);
        }
        ctx.restore();

        // --- 4. Hover Tooltip Overlay ---
        if (this.hoveredPilot) {
            const pc = this.pilotCoords.find(c => c.track.id === this.hoveredPilot.id);
            if (pc) {
                this.drawHoverTooltip(ctx, pc.x, pc.y, this.hoveredPilot.fullName || this.hoveredPilot.name);
            }
        }
    }

    drawHoverTooltip(ctx, x, y, text) {
        ctx.save();
        ctx.font = '500 11px Inter, Arial, sans-serif';
        
        const textWidth = ctx.measureText(text).width;
        const paddingH = 8;
        const paddingV = 5;
        const tooltipW = textWidth + paddingH * 2;
        const tooltipH = 16 + paddingV * 2; // ~26px height
        
        // Target coordinates: centered above (x, y)
        let tx = x - tooltipW / 2;
        let ty = y - tooltipH - 8;
        
        // Clamp to canvas borders
        if (tx < 5) tx = 5;
        if (tx + tooltipW > this.canvas.width - 5) tx = this.canvas.width - 5 - tooltipW;
        if (ty < 5) ty = y + 12; // place below dot if it clips top of canvas
        
        // Draw tooltip background (rounded rect)
        ctx.fillStyle = 'rgba(15, 23, 42, 0.95)'; // dark tailwind slate-900 equivalent
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(tx, ty, tooltipW, tooltipH, 4);
        } else {
            this.roundRect(ctx, tx, ty, tooltipW, tooltipH, 4);
        }
        ctx.fill();
        ctx.stroke();
        
        // Draw text
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, tx + paddingH, ty + tooltipH / 2);
        ctx.restore();
    }

    roundRect(ctx, x, y, width, height, radius) {
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    resetZoom() {
        this.hasAutoFit = false;
        if (this.lastState) {
            this.render(this.lastState);
        }
    }

    // Choose a nice round step for grid lines
    chooseStep(range, targetLines) {
        if (range <= 0) return 1;
        const rough = range / targetLines;
        const pow = Math.pow(10, Math.floor(Math.log10(rough)));
        const normalized = rough / pow;
        let step;
        if (normalized < 1.5) step = 1;
        else if (normalized < 3.5) step = 2;
        else if (normalized < 7.5) step = 5;
        else step = 10;
        return step * pow;
    }
}
