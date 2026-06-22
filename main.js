import { parseIGC, parseGPX, parseKML, ensureTimestamps } from './shared/parsers.js';
import { haversineDistance, bearing } from './shared/geo-math.js';
import { parseWaypointFile, parseTaskCoordinates } from './shared/waypoint-parsers.js';
import { analyzeTactics, calculateRemainingLegs, getOptimizedTaskDistances } from './shared/tactics.js';
import { calculateLeadingPoints, calculateTimePoints, integratePgWeightCurve } from './shared/scoring.js';
import { initAudio, playCoinSound } from './shared/audio.js';
import { SideView } from './side-view.js';

/**
 * Encode a relative file path for use in fetch() URLs.
 * Encodes each path segment individually so spaces and special characters
 * like parentheses are percent-encoded, while slashes are preserved.
 */
function encodePath(path) {
    return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

// Application State
const state = {
    map: null,
    tracks: [],          // Array of { id, name, color, points, polyline, marker, layerGroup }
    minTime: Infinity,
    maxTime: -Infinity,
    currentTime: 0,
    isPlaying: false,
    playbackSpeed: 10,
    lastFrameTime: 0,
    animationFrameId: null,
    waypoints: {},
    task: [],
    taskLayerGroup: null,
    startGateTime: null,
    startGateTimeStr: null,
    deadlineTime: null,
    deadlineTimeStr: null,
    isStatsResizedManually: false,
    localDem: null,
    liftSinkEnabled: false,
    liftSinkMode: 'raw',
    liftSinkWindow: 600,
    liftSinkGridSize: 150,
    liftSinkMinPoints: 3,
    liftSinkLayerGroup: null,
    overallStandings: {},
    drawGlideSlope: false,
    glideSlopeRatio: 10,
    activeTaskName: "No Task Active",
    topoMap: null,
    satelliteMap: null,
    currentMapType: 'topo',
    coinEnabled: true,
    coinInterval: 3,
    chartResolution: 500
};

// Pilot Colors mapping to CSS variables
const COLORS = [
    'var(--color-pilot-1)', 'var(--color-pilot-2)', 'var(--color-pilot-3)',
    'var(--color-pilot-4)', 'var(--color-pilot-5)', 'var(--color-pilot-6)',
    'var(--color-pilot-7)', 'var(--color-pilot-8)'
];

function formatPilotName(rawName) {
    // Remove file extension if present
    let name = rawName.replace(/\.(igc|gpx|kml)$/i, "");
    // Remove "Livetrack " prefix
    name = name.replace(/^livetrack\s+/i, '');
    // Remove all numbers
    name = name.replace(/[0-9]/g, '');
    
    // Replace dots, underscores, dashes with spaces, clean up spacing
    let cleanName = name.replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = cleanName.split(' ');
    
    if (words.length >= 2) {
        const firstInitial = words[0].charAt(0).toUpperCase();
        const lastName = words[words.length - 1];
        let formattedLastName = lastName.charAt(0).toUpperCase() + lastName.slice(1).toLowerCase();
        if (formattedLastName.length > 6) {
            formattedLastName = formattedLastName.slice(0, 6);
        }
        return `${firstInitial}.${formattedLastName}`;
    } else if (words.length === 1 && words[0].length > 0) {
        let singleName = words[0].charAt(0).toUpperCase() + words[0].slice(1).toLowerCase();
        if (singleName.length > 6) {
            singleName = singleName.slice(0, 6);
        }
        return singleName;
    }
    return rawName;
}

function getPilotFullName(rawName) {
    let name = rawName.replace(/\.(igc|gpx|kml)$/i, "");
    name = name.replace(/^livetrack\s+/i, '');
    name = name.replace(/[0-9]/g, '');
    let cleanName = name.replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim();
    return cleanName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function resolveColor(color) {
    if (color && typeof color === 'string' && color.startsWith('var(')) {
        const varName = color.slice(4, -1).trim();
        return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || '#ffffff';
    }
    return color;
}

function getPilotInitials(rawName) {
    let name = rawName.replace(/\.(igc|gpx|kml)$/i, "");
    name = name.replace(/^livetrack\s+/i, '');
    name = name.replace(/[0-9]/g, '');
    let cleanName = name.replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = cleanName.split(' ');
    
    if (words.length >= 2) {
        const firstInitial = words[0].charAt(0).toUpperCase();
        const lastInitial = words[words.length - 1].charAt(0).toUpperCase();
        return firstInitial + lastInitial;
    } else if (words.length === 1 && words[0].length > 0) {
        return words[0].slice(0, 2).toUpperCase();
    }
    return '??';
}

let sideView;

async function loadLocalDem() {
    try {
        const response = await fetch(`${encodePath('Tasks/chelan-dem.json')}?t=${Date.now()}`);
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        state.localDem = await response.json();
        console.log("Successfully loaded local DEM grid:", state.localDem.rows, "x", state.localDem.cols);
    } catch (err) {
        console.warn("Could not load local DEM grid:", err);
    }
}

function getLocalElevation(lat, lng) {
    if (!state.localDem) return null;
    const { latMin, latMax, lngMin, lngMax, rows, cols, elevations } = state.localDem;
    if (lat < latMin || lat > latMax || lng < lngMin || lng > lngMax) return null;
    
    // Convert to grid coordinates
    const r = ((lat - latMin) / (latMax - latMin)) * (rows - 1);
    const c = ((lng - lngMin) / (lngMax - lngMin)) * (cols - 1);
    
    const r0 = Math.floor(r);
    const r1 = Math.min(rows - 1, r0 + 1);
    const ty = r - r0;
    
    const c0 = Math.floor(c);
    const c1 = Math.min(cols - 1, c0 + 1);
    const tx = c - c0;
    
    const e00 = elevations[r0 * cols + c0];
    const e01 = elevations[r0 * cols + c1];
    const e10 = elevations[r1 * cols + c0];
    const e11 = elevations[r1 * cols + c1];
    
    // Bilinear interpolation
    return (1 - tx) * (1 - ty) * e00 + tx * (1 - ty) * e01 + (1 - tx) * ty * e10 + tx * ty * e11;
}

function toggleMapType() {
    if (state.currentMapType === 'topo') {
        state.map.removeLayer(state.topoMap);
        state.satelliteMap.addTo(state.map);
        state.currentMapType = 'satellite';
        const img = document.getElementById('map-type-thumbnail');
        const label = document.querySelector('.map-type-label');
        if (img) img.src = 'shared/topo_thumbnail.png';
        if (label) label.textContent = 'Topo Map';
    } else {
        state.map.removeLayer(state.satelliteMap);
        state.topoMap.addTo(state.map);
        state.currentMapType = 'topo';
        const img = document.getElementById('map-type-thumbnail');
        const label = document.querySelector('.map-type-label');
        if (img) img.src = 'shared/satellite_thumbnail.png';
        if (label) label.textContent = 'Satellite';
    }
}

function initApp() {
    // Load local DEM grid data
    loadLocalDem();

    // Setup Map
    state.map = L.map('map').setView([46.8, 8.2], 8); // Default to Switzerland
    
    // Define base map tile layers
    state.topoMap = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 17,
        attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
    });
    
    state.satelliteMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
    });

    // Add default topo map to the map
    state.topoMap.addTo(state.map);
    state.currentMapType = 'topo';

    // Add custom thumbnail map switcher control in the bottom right
    const CustomMapTypeControl = L.Control.extend({
        options: { position: 'bottomright' },
        onAdd: function (map) {
            const container = L.DomUtil.create('div', 'custom-map-type-toggle');
            container.innerHTML = `
                <div class="map-type-thumbnail-wrapper">
                    <img id="map-type-thumbnail" src="shared/satellite_thumbnail.png" alt="Satellite View">
                    <div class="map-type-label">Satellite</div>
                </div>
            `;
            
            // Prevent event propagation so clicking control doesn't drag/click the map
            L.DomEvent.disableClickPropagation(container);
            L.DomEvent.disableScrollPropagation(container);
            
            container.addEventListener('click', toggleMapType);
            return container;
        }
    });
    state.map.addControl(new CustomMapTypeControl());

    // Add map scale control
    L.control.scale({ position: 'bottomleft' }).addTo(state.map);

    // Lift/Sink layer group
    state.liftSinkLayerGroup = L.featureGroup().addTo(state.map);

    // Setup Map zoom event listeners
    state.map.on('zoom', updateMarkerSizes);
    state.map.on('zoomend', updateMarkerSizes);

    // Event Listeners
    document.getElementById('file-upload').addEventListener('change', handleFileUpload);
    document.getElementById('btn-clear-tracks').addEventListener('click', clearTracks);
    document.getElementById('wpt-upload').addEventListener('change', handleWptUpload);
    document.getElementById('btn-draw-task').addEventListener('click', drawTask);
    document.getElementById('btn-clear-task').addEventListener('click', clearTask);
    document.getElementById('btn-play-pause').addEventListener('click', () => {
        try {
            initAudio();
        } catch (e) {
            console.warn('Failed to init audio on play/pause click:', e);
        }
        togglePlayback();
    });
    document.getElementById('btn-export-xlsx').addEventListener('click', exportStatsToXLSX);
    
    // Vertical resizer
    const verticalResizer = document.getElementById('vertical-resizer');
    const sideViewContainer = document.getElementById('side-view-container');
    const mapContainerEl = document.getElementById('map-container');
    
    let isDraggingVertical = false;
    verticalResizer.addEventListener('mousedown', () => isDraggingVertical = true);
    document.addEventListener('mouseup', () => isDraggingVertical = false);
    document.addEventListener('mousemove', (e) => {
        if (!isDraggingVertical) return;
        const rect = mapContainerEl.getBoundingClientRect();
        let newHeight = rect.bottom - e.clientY;
        if (newHeight < 100) newHeight = 100;
        if (newHeight > rect.height - 150) newHeight = rect.height - 150;
        sideViewContainer.style.height = `${newHeight}px`;
        if (sideView) sideView.resize();
        if (state.map) state.map.invalidateSize();
    });

    sideView = new SideView('side-view-container', 'side-view-canvas');
    document.getElementById('btn-reset-side-view').addEventListener('click', () => {
        if (sideView) sideView.resetZoom();
    });

    document.getElementById('btn-zoom-h-in').addEventListener('click', () => {
        if (sideView) sideView.zoomHorizontal(1.25);
    });
    document.getElementById('btn-zoom-h-out').addEventListener('click', () => {
        if (sideView) sideView.zoomHorizontal(1 / 1.25);
    });
    document.getElementById('btn-zoom-v-in').addEventListener('click', () => {
        if (sideView) sideView.zoomVertical(1.25);
    });
    document.getElementById('btn-zoom-v-out').addEventListener('click', () => {
        if (sideView) sideView.zoomVertical(1 / 1.25);
    });

    document.getElementById('timeline-scrubber').addEventListener('input', handleScrub);
    document.getElementById('playback-speed').addEventListener('change', (e) => {
        state.playbackSpeed = parseInt(e.target.value, 10);
    });
    
    // UI Resizer & Toggle
    setupSidebarControls();
    initSettingsMenu();
    
    // Sort and persistent sorting option
    document.getElementById('pilot-sort-select').addEventListener('change', (e) => {
        state.currentSort = e.target.value;
        try { localStorage.setItem('pg-pilot-sort', state.currentSort); } catch(err) {}
        sortPilotList();
    });
    
    let savedSort = 'name';
    try {
        savedSort = localStorage.getItem('pg-pilot-sort') || 'name';
    } catch(err) {}
    state.currentSort = savedSort;
    document.getElementById('pilot-sort-select').value = savedSort;

    // Select/Unselect All Checkbox
    document.getElementById('chk-all-tracks').addEventListener('change', (e) => {
        const visible = e.target.checked;
        state.tracks.forEach(track => {
            setTrackVisibility(track, visible);
        });
        document.querySelectorAll('.chk-track').forEach(chk => {
            chk.checked = visible;
        });
    });

    // Stats Panel toggle & controls listeners
    const togglePanelBtn = document.getElementById('btn-toggle-right-panel');
    const closePanelBtn = document.getElementById('btn-close-right-panel');
    const rightPanelEl = document.getElementById('right-panel');
    
    if (togglePanelBtn && rightPanelEl) {
        togglePanelBtn.addEventListener('click', () => {
            rightPanelEl.classList.toggle('collapsed');
            if (!rightPanelEl.classList.contains('collapsed')) {
                state.isStatsResizedManually = false;
                const sidebar = document.querySelector('.sidebar');
                let sidebarWidth = 0;
                if (sidebar && !sidebar.classList.contains('collapsed')) {
                    sidebarWidth = sidebar.offsetWidth;
                }
                let targetWidth = window.innerWidth - sidebarWidth;
                if (targetWidth < 350) targetWidth = 350;
                rightPanelEl.style.width = `${targetWidth}px`;
                
                const btnTabLeading = document.getElementById('btn-tab-leading');
                if (btnTabLeading && btnTabLeading.classList.contains('active')) {
                    updateLeadingPointsChart();
                } else {
                    updateStatsAnalysis();
                }
                setTimeout(() => {
                    if (statsChart) statsChart.resize();
                    if (leadPointsChart) leadPointsChart.resize();
                }, 350);
            }
        });
    }
    if (closePanelBtn && rightPanelEl) {
        closePanelBtn.addEventListener('click', () => {
            rightPanelEl.classList.add('collapsed');
        });
    }

    // Stats Tab Switching controls
    const btnTabCorrelation = document.getElementById('btn-tab-correlation');
    const btnTabLeading = document.getElementById('btn-tab-leading');
    const tabCorrelationContent = document.getElementById('stats-tab-correlation-content');
    const tabLeadingContent = document.getElementById('stats-tab-leading-content');

    if (btnTabCorrelation && btnTabLeading && tabCorrelationContent && tabLeadingContent) {
        btnTabCorrelation.addEventListener('click', () => {
            btnTabCorrelation.classList.add('active');
            btnTabLeading.classList.remove('active');
            tabCorrelationContent.style.display = 'flex';
            tabLeadingContent.style.display = 'none';
            updateStatsAnalysis();
            setTimeout(() => {
                if (statsChart) statsChart.resize();
            }, 50);
        });

        btnTabLeading.addEventListener('click', () => {
            btnTabLeading.classList.add('active');
            btnTabCorrelation.classList.remove('active');
            tabLeadingContent.style.display = 'flex';
            tabCorrelationContent.style.display = 'none';
            updateLeadingPointsChart();
            setTimeout(() => {
                if (leadPointsChart) leadPointsChart.resize();
            }, 50);
        });
    }

    // Drag-to-resize listener for Stats Panel (Right Panel)
    const rightPanelResizer = document.getElementById('right-panel-resizer');
    let isDraggingRightPanel = false;
    if (rightPanelResizer && rightPanelEl) {
        rightPanelResizer.addEventListener('mousedown', (e) => {
            isDraggingRightPanel = true;
            rightPanelResizer.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDraggingRightPanel) return;
            
            state.isStatsResizedManually = true;
            const sidebar = document.querySelector('.sidebar');
            let sidebarWidth = 0;
            if (sidebar && !sidebar.classList.contains('collapsed')) {
                sidebarWidth = sidebar.offsetWidth;
            }
            
            const maxAllowedWidth = window.innerWidth - sidebarWidth;
            let newWidth = window.innerWidth - e.clientX;
            
            if (newWidth < 350) newWidth = 350;
            if (newWidth > maxAllowedWidth) newWidth = maxAllowedWidth;
            
            rightPanelEl.style.width = `${newWidth}px`;
            if (statsChart) statsChart.resize();
            if (leadPointsChart) leadPointsChart.resize();
        });

        document.addEventListener('mouseup', () => {
            if (isDraggingRightPanel) {
                isDraggingRightPanel = false;
                rightPanelResizer.classList.remove('dragging');
                document.body.style.cursor = 'default';
                document.body.style.userSelect = '';
                if (statsChart) statsChart.resize();
                if (leadPointsChart) leadPointsChart.resize();
            }
        });
    }

    // Window Resize listener to update right panel size when screen size changes
    window.addEventListener('resize', () => {
        if (rightPanelEl && !rightPanelEl.classList.contains('collapsed')) {
            const sidebar = document.querySelector('.sidebar');
            let sidebarWidth = 0;
            if (sidebar && !sidebar.classList.contains('collapsed')) {
                sidebarWidth = sidebar.offsetWidth;
            }
            const maxAllowedWidth = window.innerWidth - sidebarWidth;
            
            if (!state.isStatsResizedManually) {
                let targetWidth = maxAllowedWidth;
                if (targetWidth < 350) targetWidth = 350;
                rightPanelEl.style.width = `${targetWidth}px`;
            } else {
                let currentWidth = parseInt(rightPanelEl.style.width) || 450;
                if (currentWidth > maxAllowedWidth) currentWidth = maxAllowedWidth;
                if (currentWidth < 350) currentWidth = 350;
                rightPanelEl.style.width = `${currentWidth}px`;
            }
            if (statsChart) statsChart.resize();
            if (leadPointsChart) leadPointsChart.resize();
        }
    });
    
    const chartXSelect = document.getElementById('chart-x-select');
    const chartFitSelect = document.getElementById('chart-fit-select');
    if (chartXSelect) chartXSelect.addEventListener('change', updateStatsAnalysis);
    if (chartFitSelect) chartFitSelect.addEventListener('change', updateStatsAnalysis);
    
    const chartResSelect = document.getElementById('select-chart-resolution');
    if (chartResSelect) {
        try {
            const storedRes = localStorage.getItem('pg-chart-resolution');
            if (storedRes !== null) {
                state.chartResolution = parseFloat(storedRes) || 500;
                chartResSelect.value = state.chartResolution.toString();
            }
        } catch (e) {}

        chartResSelect.addEventListener('change', (e) => {
            state.chartResolution = parseFloat(e.target.value) || 500;
            try { localStorage.setItem('pg-chart-resolution', state.chartResolution); } catch(err) {}
            updateLeadingPointsChart();
        });

        const leadXaxisRadios = document.querySelectorAll('input[name="lead-chart-xaxis"]');
        leadXaxisRadios.forEach(radio => {
            radio.addEventListener('change', () => {
                updateLeadingPointsChart();
            });
        });
    }
    
    // Setup predefined tasks dropdown if manifest is available
    setupPredefinedTasks();

    // Restore persisted data from localStorage
    restoreFromStorage();

    // Fetch and parse overall standings (default to 2025 on startup)
    loadOverallStandingsForTask('USOP 2025');

    // Select Top N Pilots event listener
    const btnApplyTopN = document.getElementById('btn-apply-top-n');
    if (btnApplyTopN) {
        btnApplyTopN.addEventListener('click', applyTopNSelection);
    }

    // Initialize Lift/Sink Overlay Controls
    initLiftSinkControls();
}

async function loadOverallStandingsForTask(taskId) {
    let standingsFile = 'Tasks/USOP 2025 Chelan overall_standings.txt'; // default to 2025
    if (taskId && taskId.includes('2023')) {
        standingsFile = 'Tasks/USOP 2023 Chelan overall_standings.txt';
    }
    
    try {
        const res = await fetch(`${encodePath(standingsFile)}?t=${Date.now()}`);
        if (!res.ok) throw new Error(`Failed to load overall standings: ${res.statusText}`);
        const text = await res.text();
        const lines = text.split('\n');
        state.overallStandings = {};
        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            
            let parts = trimmed.split('\t');
            if (parts.length < 3) {
                parts = trimmed.split(/\s{2,}/);
            }
            
            if (parts.length >= 3) {
                const rank = parseInt(parts[0].trim(), 10);
                const name = parts[2].trim().toLowerCase();
                if (!isNaN(rank)) {
                    state.overallStandings[name] = rank;
                }
            }
        });
        console.log(`Successfully loaded overall standings (${standingsFile}) for`, Object.keys(state.overallStandings).length, 'pilots');
    } catch (err) {
        console.error('Error loading overall standings:', err);
    }
}

function setupPredefinedTasks() {
    fetch(`${encodePath('Tasks/manifest.json')}?t=${Date.now()}`)
        .then(res => {
            if (!res.ok) throw new Error('No predefined tasks found');
            return res.json();
        })
        .then(manifest => {
            const container = document.getElementById('task-presets-container');
            const select = document.getElementById('task-select');
            if (!container || !select) return;
            
            // Clear default and populate options
            select.innerHTML = '<option value="">-- Select Task --</option>';
            manifest.tasks.forEach(task => {
                const opt = document.createElement('option');
                opt.value = task.id;
                opt.textContent = task.name;
                select.appendChild(opt);
            });
            
            container.style.display = 'block';
            
            select.addEventListener('change', async (e) => {
                const val = e.target.value;
                if (!val) return;
                
                const taskInfo = manifest.tasks.find(t => t.id === val);
                if (!taskInfo) return;
                
                state.activeTaskName = taskInfo.name;
                const taskTitleEl = document.getElementById('active-task-title');
                if (taskTitleEl) {
                    taskTitleEl.textContent = taskInfo.name;
                    taskTitleEl.style.display = 'block';
                }
                
                // Close settings modal immediately so user can see progress
                const modal = document.getElementById('settings-modal');
                if (modal) modal.classList.add('hidden');
                
                const loaderEl = document.getElementById('track-loader');
                const loaderTextEl = document.getElementById('track-loader-text');
                const loaderBarEl = document.getElementById('loader-bar-fill');
                
                if (loaderEl) {
                    loaderEl.classList.remove('hidden');
                    if (loaderTextEl) loaderTextEl.textContent = 'Loading task preset...';
                    if (loaderBarEl) loaderBarEl.style.width = '0%';
                }
                
                try {
                    select.disabled = true;
                    
                    // Stop playback if playing
                    if (state.isPlaying) {
                        togglePlayback();
                    }

                    // Load corresponding overall standings
                    await loadOverallStandingsForTask(taskInfo.id);
                    
                    // Remove all track layers from the map
                    state.tracks.forEach(t => {
                        if (state.map && t.layerGroup) {
                            state.map.removeLayer(t.layerGroup);
                        }
                    });
                    
                    // Clear tracks state
                    state.tracks = [];
                    state.minTime = Infinity;
                    state.maxTime = -Infinity;
                    state.currentTime = 0;
                    
                    // Reset scrubber and time display
                    const scrubber = document.getElementById('timeline-scrubber');
                    if (scrubber) {
                        scrubber.value = 0;
                        scrubber.disabled = true;
                    }
                    const timeDisplay = document.getElementById('time-display');
                    if (timeDisplay) timeDisplay.textContent = '--:--:--';
                    
                    // Clear IndexedDB tracks
                    const db = await getDB();
                    if (db) {
                        const tx = db.transaction(STORE_NAME, 'readwrite');
                        tx.objectStore(STORE_NAME).clear();
                        await new Promise((resolve, reject) => {
                            tx.oncomplete = () => resolve();
                            tx.onerror = (e) => reject(tx.error || e.target.error);
                        });
                    }
                    try { localStorage.removeItem('pg-tracks'); } catch(err) {}
                    
                    // Clear waypoints state and cache
                    state.waypoints = {};
                    try { localStorage.removeItem('pg-waypoints'); } catch(err) {}
                    
                    // Reset waypoint upload label
                    const wptLabel = document.querySelector('label[for="wpt-upload"]');
                    if (wptLabel) {
                        for (let node of wptLabel.childNodes) {
                            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) {
                                node.textContent = ' Upload Waypoints (.wpt/.cup) ';
                                break;
                            }
                        }
                    }
                    
                    // Reset file inputs
                    const fileUploadInput = document.getElementById('file-upload');
                    if (fileUploadInput) fileUploadInput.value = '';
                    const wptUploadInput = document.getElementById('wpt-upload');
                    if (wptUploadInput) wptUploadInput.value = '';
                    
                    // Clear existing task representation on map and state
                    if (state.taskLayerGroup) {
                        state.map.removeLayer(state.taskLayerGroup);
                        state.taskLayerGroup = null;
                    }
                    state.task = [];
                    state.optimizedTask = null;
                    state.terrainProfile = null;
                    state.startGateTime = null;
                    state.startGateTimeStr = null;
                    state.deadlineTime = null;
                    state.deadlineTimeStr = null;
                    
                    const gateInfoEl = document.getElementById('task-gate-info');
                    if (gateInfoEl) {
                        gateInfoEl.innerHTML = '';
                    }
                    
                    // Clear task text
                    document.getElementById('task-textarea').value = '';
                    try { localStorage.removeItem('pg-task-text'); } catch(err) {}
                    
                    // Clear Lift/Sink overlay
                    if (state.liftSinkLayerGroup) {
                        state.liftSinkLayerGroup.clearLayers();
                    }
                    
                    // Render empty state immediately
                    if (sideView) sideView.render(state);
                    updatePilotListUI();
                    
                    // 1. Load waypoints
                    if (manifest.waypoint_file) {
                        if (loaderTextEl) loaderTextEl.textContent = 'Loading waypoints...';
                        const wptRes = await fetch(`${encodePath(manifest.waypoint_file)}?t=${Date.now()}`);
                        const wptText = await wptRes.text();
                        const newWpts = parseWaypointFile(wptText, "us-open-paragliding-2025.FS(1).wpt");
                        Object.assign(state.waypoints, newWpts);
                        try { localStorage.setItem('pg-waypoints', JSON.stringify(state.waypoints)); } catch(err) {}
                    }
                    
                    // 2. Load task definition
                    if (taskInfo.task_file) {
                        if (loaderTextEl) loaderTextEl.textContent = 'Loading task definition...';
                        const taskRes = await fetch(`${encodePath(taskInfo.task_file)}?t=${Date.now()}`);
                        const taskText = await taskRes.text();
                        document.getElementById('task-textarea').value = taskText;
                        try { localStorage.setItem('pg-task-text', taskText); } catch(err) {}
                        drawTask();
                    }
                    
                    // 3. Clear existing tracks (Done at start)
                    
                    // 4. Fetch and load the track logs in parallel with concurrency limit of 6
                    const igcFiles = taskInfo.igc_files;
                    const total = igcFiles.length;
                    let loadedCount = 0;
                    
                    async function fetchAndAddTrack(url) {
                        const filename = url.substring(url.lastIndexOf('/') + 1);
                        const cleanName = formatPilotName(filename);
                        if (loaderTextEl) loaderTextEl.textContent = `Fetching ${cleanName}...`;
                        
                        const trackRes = await fetch(`${encodePath(url)}?t=${Date.now()}`);
                        const text = await trackRes.text();
                        const trackPoints = parseIGC(text);
                        if (!trackPoints || trackPoints.length === 0) return;
                        
                        // Add track to state
                        const points = ensureTimestamps(trackPoints);
                        addTrackToState(filename, points);
                        
                        loadedCount++;
                        const pct = Math.round((loadedCount / total) * 100);
                        if (loaderBarEl) loaderBarEl.style.width = `${pct}%`;
                        if (loaderTextEl) loaderTextEl.textContent = `Loading tracks (${loadedCount}/${total})...`;
                    }
                    
                    const concurrency = 6;
                    const queue = [...igcFiles];
                    
                    async function worker() {
                        while (queue.length > 0) {
                            const url = queue.shift();
                            try {
                                await fetchAndAddTrack(url);
                            } catch (err) {
                                console.error(`Error loading track file ${url}:`, err);
                            }
                        }
                    }
                    
                    const workers = [];
                    for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
                        workers.push(worker());
                    }
                    
                    await Promise.all(workers);
                    
                    if (loaderBarEl) loaderBarEl.style.width = '100%';
                    if (loaderTextEl) loaderTextEl.textContent = 'All preset tracks loaded!';
                    await new Promise(resolve => setTimeout(resolve, 300));
                    
                    // Trigger UI updates
                    onAllFilesLoaded();
                    
                } catch (err) {
                    console.error('Failed to load task preset:', err);
                    alert('Error loading task preset: ' + err.message);
                } finally {
                    select.disabled = false;
                    if (loaderEl) loaderEl.classList.add('hidden');
                }
            });
        })
        .catch(err => {
            console.log('Predefined tasks manifest not available or failed to load:', err);
        });
}

function resetPredefinedTaskSelect() {
    const select = document.getElementById('task-select');
    if (select) {
        select.value = '';
    }
}

function setupSidebarControls() {
    const sidebar = document.querySelector('.sidebar');
    const resizer = document.getElementById('sidebar-resizer');
    const toggleBtn = document.getElementById('btn-toggle-sidebar');
    
    // Set initial position of toggle button to match current sidebar width
    const initialWidth = parseInt(getComputedStyle(sidebar).width);
    toggleBtn.style.left = `${initialWidth}px`;
    
    let isDragging = false;

    resizer.addEventListener('mousedown', (e) => {
        isDragging = true;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        // Prevent map from capturing mouse events
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        let newWidth = e.clientX;
        if (newWidth < 300) newWidth = 300;
        if (newWidth > 800) newWidth = 800;
        sidebar.style.width = `${newWidth}px`;
        toggleBtn.style.left = `${newWidth}px`;

        const rightPanelEl = document.getElementById('right-panel');
        if (rightPanelEl && !rightPanelEl.classList.contains('collapsed')) {
            const maxAllowedWidth = window.innerWidth - newWidth;
            if (!state.isStatsResizedManually) {
                let targetWidth = maxAllowedWidth;
                if (targetWidth < 350) targetWidth = 350;
                rightPanelEl.style.width = `${targetWidth}px`;
            } else {
                let currentWidth = parseInt(rightPanelEl.style.width) || 450;
                if (currentWidth > maxAllowedWidth) currentWidth = maxAllowedWidth;
                if (currentWidth < 350) currentWidth = 350;
                rightPanelEl.style.width = `${currentWidth}px`;
            }
            if (statsChart) statsChart.resize();
        }
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            resizer.classList.remove('dragging');
            document.body.style.cursor = 'default';
            document.body.style.userSelect = '';
        }
    });

    toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        if (sidebar.classList.contains('collapsed')) {
            sidebar.style.marginLeft = `-${sidebar.offsetWidth}px`;
            toggleBtn.style.left = '0px';
            toggleBtn.textContent = '▶';
        } else {
            sidebar.style.marginLeft = '0px';
            const currentWidth = parseInt(getComputedStyle(sidebar).width);
            toggleBtn.style.left = `${currentWidth}px`;
            toggleBtn.textContent = '◀';
        }

        const rightPanelEl = document.getElementById('right-panel');
        if (rightPanelEl && !rightPanelEl.classList.contains('collapsed')) {
            let sidebarWidth = 0;
            if (!sidebar.classList.contains('collapsed')) {
                sidebarWidth = sidebar.offsetWidth;
            }
            const maxAllowedWidth = window.innerWidth - sidebarWidth;
            if (!state.isStatsResizedManually) {
                let targetWidth = maxAllowedWidth;
                if (targetWidth < 350) targetWidth = 350;
                rightPanelEl.style.width = `${targetWidth}px`;
            } else {
                let currentWidth = parseInt(rightPanelEl.style.width) || 450;
                if (currentWidth > maxAllowedWidth) currentWidth = maxAllowedWidth;
                if (currentWidth < 350) currentWidth = 350;
                rightPanelEl.style.width = `${currentWidth}px`;
            }
            if (statsChart) statsChart.resize();
        }
    });
}

function initSettingsMenu() {
    const modal = document.getElementById('settings-modal');
    const openBtn = document.getElementById('btn-open-settings');
    const closeBtn = document.querySelector('.btn-close-modal');
    
    if (openBtn && modal) {
        openBtn.addEventListener('click', () => {
            modal.classList.remove('hidden');
            // Sync glide slope wrapper to actual checkbox state on every open
            // (browser form-state autocomplete may have changed the checkbox after init)
            const chk = document.getElementById('chk-draw-glide-slope');
            const wrapper = document.getElementById('glide-slope-controls-wrapper');
            if (chk && wrapper) {
                state.drawGlideSlope = chk.checked;
                wrapper.style.display = chk.checked ? 'flex' : 'none';
            }
            
            // Sync coin controls wrapper on every open
            const coinChk = document.getElementById('chk-coin-enable');
            const coinWrapper = document.getElementById('coin-controls-wrapper');
            if (coinChk && coinWrapper) {
                state.coinEnabled = coinChk.checked;
                coinWrapper.style.display = coinChk.checked ? 'flex' : 'none';
            }
        });
    }
    
    if (closeBtn && modal) {
        closeBtn.addEventListener('click', () => {
            modal.classList.add('hidden');
        });
    }
    
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.add('hidden');
            }
        });
    }

    // Glide Slope Controls wiring
    const drawGlideSlopeCheckbox = document.getElementById('chk-draw-glide-slope');
    const glideSlopeRatioSlider = document.getElementById('slide-glide-slope-ratio');
    const glideSlopeControlsWrapper = document.getElementById('glide-slope-controls-wrapper');
    const labelGlideSlopeRatio = document.getElementById('label-glide-slope-ratio');

    if (drawGlideSlopeCheckbox) {
        // Restore persisted state
        try {
            const stored = localStorage.getItem('pg-draw-glide-slope');
            if (stored !== null) state.drawGlideSlope = stored === 'true';
            const storedRatio = localStorage.getItem('pg-glide-slope-ratio');
            if (storedRatio !== null) state.glideSlopeRatio = parseFloat(storedRatio);
        } catch(e) {}

        // Sync DOM to restored state
        drawGlideSlopeCheckbox.checked = state.drawGlideSlope;
        if (glideSlopeControlsWrapper) {
            glideSlopeControlsWrapper.style.display = state.drawGlideSlope ? 'flex' : 'none';
        }
        if (glideSlopeRatioSlider) glideSlopeRatioSlider.value = state.glideSlopeRatio;
        if (labelGlideSlopeRatio) labelGlideSlopeRatio.textContent = `${state.glideSlopeRatio}:1`;

        drawGlideSlopeCheckbox.addEventListener('change', (e) => {
            state.drawGlideSlope = e.target.checked;
            try { localStorage.setItem('pg-draw-glide-slope', state.drawGlideSlope); } catch(err) {}
            if (glideSlopeControlsWrapper) {
                glideSlopeControlsWrapper.style.display = e.target.checked ? 'flex' : 'none';
            }
            if (sideView && state.task && state.task.length > 0) {
                sideView.render(state);
            }
        });
    }

    if (glideSlopeRatioSlider) {
        glideSlopeRatioSlider.addEventListener('input', (e) => {
            state.glideSlopeRatio = parseFloat(e.target.value);
            try { localStorage.setItem('pg-glide-slope-ratio', state.glideSlopeRatio); } catch(err) {}
            if (labelGlideSlopeRatio) {
                labelGlideSlopeRatio.textContent = `${state.glideSlopeRatio}:1`;
            }
            if (sideView && state.task && state.task.length > 0) {
                sideView.render(state);
            }
        });
    }

    // Coin Animation Controls wiring
    const coinEnableCheckbox = document.getElementById('chk-coin-enable');
    const coinIntervalInput = document.getElementById('input-coin-interval');
    const coinControlsWrapper = document.getElementById('coin-controls-wrapper');

    if (coinEnableCheckbox) {
        // Restore persisted state
        try {
            const stored = localStorage.getItem('pg-coin-enable');
            if (stored !== null) state.coinEnabled = stored === 'true';
            const storedInterval = localStorage.getItem('pg-coin-interval');
            if (storedInterval !== null) state.coinInterval = parseFloat(storedInterval);
        } catch(e) {}

        // Sync DOM to restored state
        coinEnableCheckbox.checked = state.coinEnabled;
        if (coinControlsWrapper) {
            coinControlsWrapper.style.display = state.coinEnabled ? 'flex' : 'none';
        }
        if (coinIntervalInput) coinIntervalInput.value = state.coinInterval;

        coinEnableCheckbox.addEventListener('change', (e) => {
            state.coinEnabled = e.target.checked;
            try { localStorage.setItem('pg-coin-enable', state.coinEnabled); } catch(err) {}
            if (coinControlsWrapper) {
                coinControlsWrapper.style.display = e.target.checked ? 'flex' : 'none';
            }
        });
    }

    if (coinIntervalInput) {
        coinIntervalInput.addEventListener('input', (e) => {
            let val = parseFloat(e.target.value);
            if (isNaN(val) || val <= 0) val = 1;
            state.coinInterval = val;
            try { localStorage.setItem('pg-coin-interval', state.coinInterval); } catch(err) {}
        });
    }
}

function handleWptUpload(e) {
    resetPredefinedTaskSelect();
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const content = event.target.result;
        const newWpts = parseWaypointFile(content, file.name);
        // Merge into state
        Object.assign(state.waypoints, newWpts);
        console.log(`Loaded ${Object.keys(newWpts).length} waypoints from ${file.name}`);
        
        // Temporarily show success on the button without an intrusive alert
        const label = document.querySelector('label[for="wpt-upload"]');
        if (label) {
            for (let node of label.childNodes) {
                if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) {
                    const originalText = node.textContent;
                    node.textContent = `Loaded ${Object.keys(newWpts).length} WPTs ✓ `;
                    setTimeout(() => { node.textContent = originalText; }, 2000);
                    break;
                }
            }
        }
        
        saveWaypointsToStorage();
    };
    reader.readAsText(file);
    e.target.value = '';
}

function drawTask() {
    const text = document.getElementById('task-textarea').value;
    if (!text) return;

    const lines = text.split(/\r?\n/);
    
    let taskName = state.activeTaskName;
    if (!taskName || taskName === "No Task Active") {
        taskName = "Custom Task";
        for (let i = 0; i < Math.min(5, lines.length); i++) {
            const line = lines[i].trim();
            if (line.toLowerCase().startsWith('task') || line.toLowerCase().includes('race')) {
                taskName = line;
                break;
            }
        }
        state.activeTaskName = taskName;
    }
    const taskTitleEl = document.getElementById('active-task-title');
    if (taskTitleEl) {
        taskTitleEl.textContent = taskName;
        taskTitleEl.style.display = 'block';
    }
    
    // Clear existing
    clearTask();
    // Keep active task name since clearTask resets it
    state.activeTaskName = taskName;
    if (taskTitleEl) {
        taskTitleEl.textContent = taskName;
        taskTitleEl.style.display = 'block';
    }

    // Extract coordinates from task definition if embedded
    const embeddedWaypoints = parseTaskCoordinates(text);
    if (Object.keys(embeddedWaypoints).length > 0) {
        // Merge embedded coordinates with existing waypoints
        // Embedded coordinates take precedence
        state.waypoints = { ...state.waypoints, ...embeddedWaypoints };
        console.log(`Extracted ${Object.keys(embeddedWaypoints).length} waypoints from task definition`);
    }
    
    state.taskLayerGroup = L.featureGroup().addTo(state.map);
    state.task = [];

    // Pre-scan for a header row to build a column index map.
    // Expected header: "No \t Leg Dist. \t Id \t Radius \t Open \t Close \t Coordinates \t Altitude"
    let colMap = null; // null means legacy format
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        const headerParts = line.split(/\t+|\s{2,}/);
        // Detect header by presence of both an "Id" and a "Radius" column
        const lc = headerParts.map(p => p.toLowerCase().replace(/[.\s]/g, ''));
        const idIdx     = lc.findIndex(p => p === 'id');
        const radiusIdx = lc.findIndex(p => p === 'radius');
        const distIdx   = lc.findIndex(p => p === 'legdist' || p === 'dist');
        const noIdx     = lc.findIndex(p => p === 'no');
        if (idIdx !== -1 && radiusIdx !== -1) {
            colMap = { noIdx, idIdx, radiusIdx, distIdx };
            break;
        }
    }

    let previousTaskPoint = null;

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('id') || line.startsWith('Radius')) continue;
        
        const startgateMatch = line.match(/^startgate\s*:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
        if (startgateMatch) {
            const hh = startgateMatch[1];
            const mm = startgateMatch[2];
            const ss = startgateMatch[3] || "00";
            state.startGateTimeStr = `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:${ss.padStart(2, '0')}`;
            state.startGateTime = parseInt(hh, 10) * 3600 + parseInt(mm, 10) * 60 + parseInt(ss, 10);
            continue;
        }
        
        const deadlineMatch = line.match(/^deadline\s*:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
        if (deadlineMatch) {
            const hh = deadlineMatch[1];
            const mm = deadlineMatch[2];
            const ss = deadlineMatch[3] || "00";
            state.deadlineTimeStr = `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:${ss.padStart(2, '0')}`;
            state.deadlineTime = parseInt(hh, 10) * 3600 + parseInt(mm, 10) * 60 + parseInt(ss, 10);
            continue;
        }

        const parts = line.split(/\t+|\s{2,}/);
        if (parts.length < 2) continue;

        let id, type, radius = 0, dist = 0;

        if (colMap && colMap.idIdx !== -1 && parts.length > colMap.idIdx) {
            // --- Tabular format: use header-derived column indices ---
            // Skip the header row itself
            const firstCell = parts[0].toLowerCase().replace(/[.\s]/g, '');
            if (firstCell === 'no') continue;

            // Row number cell may contain the type keyword, e.g. "2 SS" or "7 ES"
            const rowCell = (parts[colMap.noIdx] || parts[0]).toUpperCase();
            id = parts[colMap.idIdx].replace(/[^\w-]/g, '').trim();
            type = 'turnpoint';
            if (rowCell.includes(' SS')) type = 'ss';
            else if (rowCell.includes(' ES')) type = 'es';
            else if (id.toUpperCase() === 'LAUNCH') type = 'launch';

            // Radius column: strip non-numeric, convert km→m
            if (colMap.radiusIdx !== -1 && parts.length > colMap.radiusIdx) {
                let rawRadius = parts[colMap.radiusIdx];
                // If the radius cell contains a type keyword, columns are shifted
                if (['launch', 'ss', 'es', 'goal'].includes(rawRadius.toLowerCase().trim())) {
                    type = rawRadius.toLowerCase().trim();
                    rawRadius = parts[colMap.radiusIdx + 1] || rawRadius;
                }
                const rVal = parseFloat(rawRadius.replace(/[^\d.]/g, ''));
                if (!isNaN(rVal)) {
                    radius = /km/i.test(rawRadius) ? rVal * 1000 : rVal;
                } else {
                    // Fallback to regex
                    const matches = [...line.matchAll(/(\d+(?:\.\d+)?)\s*(m|km)/gi)];
                    if (matches.length >= 1) {
                        const rVal2 = parseFloat(matches[0][1]);
                        radius = matches[0][2].toLowerCase() === 'km' ? rVal2 * 1000 : rVal2;
                    }
                }
            }

            // Leg distance column
            if (colMap.distIdx !== -1 && parts.length > colMap.distIdx) {
                let rawDist = parts[colMap.distIdx];
                // If radius cell contained a type keyword, the distance cell is also shifted
                if (parts[colMap.radiusIdx] && ['launch', 'ss', 'es', 'goal'].includes(parts[colMap.radiusIdx].toLowerCase().trim())) {
                    rawDist = parts[colMap.distIdx + 1] || rawDist;
                }
                const dVal = parseFloat(rawDist.replace(/[^\d.]/g, ''));
                if (!isNaN(dVal)) {
                    dist = /km/i.test(rawDist) ? dVal * 1000 : dVal;
                } else {
                    // Fallback to regex
                    const matches = [...line.matchAll(/(\d+(?:\.\d+)?)\s*(m|km)/gi)];
                    if (matches.length >= 2) {
                        const dVal2 = parseFloat(matches[1][1]);
                        dist = matches[1][2].toLowerCase() === 'km' ? dVal2 * 1000 : dVal2;
                    }
                }
            }
        } else {
            // --- Legacy format: ID is parts[0], optional type keyword is parts[1] ---
            id = parts[0].trim();
            type = 'turnpoint';
            const p1 = parts[1].toLowerCase().trim();
            if (['launch', 'ss', 'es', 'goal'].includes(p1)) type = p1;

            // Extract radius and distance via regex (legacy order: radius first, dist second)
            const matches = [...line.matchAll(/(\d+(?:\.\d+)?)\s*(m|km)/gi)];
            if (matches.length >= 1) {
                const rVal = parseFloat(matches[0][1]);
                radius = matches[0][2].toLowerCase() === 'km' ? rVal * 1000 : rVal;
            }
            if (matches.length >= 2) {
                const dVal = parseFloat(matches[1][1]);
                dist = matches[1][2].toLowerCase() === 'km' ? dVal * 1000 : dVal;
            }
        }

        if (!id) continue;


        const wpt = state.waypoints[id];
        if (wpt) {
            const tp = { id, type, radius, cumulativeDist: dist, lat: wpt.lat, lng: wpt.lng, elev: wpt.elev || 0, isExit: false };
            
            // Determine if it's an Exit cylinder
            if (previousTaskPoint) {
                const distFromPrev = haversineDistance(previousTaskPoint, tp) * 1000;
                // If the previous turnpoint is inside this turnpoint's cylinder, it's an exit cylinder
                if (distFromPrev + previousTaskPoint.radius < tp.radius) {
                    tp.isExit = true;
                }
            }

            state.task.push(tp);
            previousTaskPoint = tp;
            
            // Draw cylinder
            let color = 'blue';
            let fillColor = 'blue';
            let fillOpacity = 0.1;
            
            if (type === 'ss') { color = 'green'; fillColor = 'green'; }
            if (type === 'es') { color = 'orange'; fillColor = 'orange'; fillOpacity = 0; }
            if (type === 'goal') { color = 'red'; fillColor = 'red'; fillOpacity = 0.2; }
            
            // Draw boundary
            L.circle([wpt.lat, wpt.lng], {
                radius: radius,
                color: color,
                weight: 2,
                fillColor: fillColor,
                fillOpacity: fillOpacity,
                dashArray: (type === 'turnpoint' || tp.isExit) ? '5, 5' : null
            }).addTo(state.taskLayerGroup);
            
            // Marker
            L.marker([wpt.lat, wpt.lng], {
                icon: L.divIcon({
                    className: 'pilot-marker-label',
                    html: id + (tp.isExit ? ' (EXIT)' : ''),
                    iconSize: [0, 0]
                })
            }).addTo(state.taskLayerGroup);
            
        } else {
            console.warn(`Turnpoint ${id} not found in uploaded waypoints!`);
        }
    }
    
    if (state.task.length > 0) {
        // If no turnpoint was explicitly typed as 'goal' (e.g. tabular format files
        // where the last row has no keyword), promote the last turnpoint to goal.
        const hasGoal = state.task.some(t => t.type === 'goal');
        if (!hasGoal) {
            state.task[state.task.length - 1].type = 'goal';
        }

        state.map.invalidateSize();
        state.map.fitBounds(state.taskLayerGroup.getBounds(), { padding: [50, 50] });
        
        // Compute optimized task route distances
        state.optimizedTask = getOptimizedTaskDistances(state.task);

        // Draw the optimized route on the map as a dashed white polyline
        if (state.optimizedTask && state.optimizedTask.points) {
            const optLatLngs = state.optimizedTask.points.map(p => [p.lat, p.lng]);
            L.polyline(optLatLngs, {
                color: 'white',
                weight: 1.5,
                opacity: 0.55,
                dashArray: '6, 6',
                interactive: false
            }).addTo(state.taskLayerGroup);
        }
        
        // Compute tactics for selected tracks now that we have a task
        state.tracks.forEach(track => {
            if (track.visible !== false) {
                track.tactics = analyzeTactics(track.points, state.task, state.startGateTime);
                updateMaxSpeedMarker(track);
                fetchTrackTerrainProfile(track);
            } else {
                track.tactics = null;
            }
        });

        // Display parsed startgate / deadline info
        const gateInfoEl = document.getElementById('task-gate-info');
        if (gateInfoEl) {
            let infoHtml = '';
            if (state.startGateTimeStr) {
                infoHtml += `<div><strong>Start Gate:</strong> ${state.startGateTimeStr}</div>`;
            }
            if (state.deadlineTimeStr) {
                infoHtml += `<div><strong>Deadline:</strong> ${state.deadlineTimeStr}</div>`;
            }
            gateInfoEl.innerHTML = infoHtml;
        }

        updatePilotListUI();
        if (sideView) sideView.render(state);
        
        // Fetch real terrain elevation data
        fetchTerrainProfile();
        
        saveTaskToStorage();
    }
}

function clearTask() {
    state.activeTaskName = "No Task Active";
    const taskTitleEl = document.getElementById('active-task-title');
    if (taskTitleEl) {
        taskTitleEl.textContent = 'No Task Active';
        taskTitleEl.style.display = 'none';
    }
    
    if (state.taskLayerGroup) {
        state.map.removeLayer(state.taskLayerGroup);
        state.taskLayerGroup = null;
    }
    state.task = [];
    state.optimizedTask = null;
    state.terrainProfile = null;
    state.startGateTime = null;
    state.startGateTimeStr = null;
    state.deadlineTime = null;
    state.deadlineTimeStr = null;
    
    const gateInfoEl = document.getElementById('task-gate-info');
    if (gateInfoEl) {
        gateInfoEl.innerHTML = '';
    }
    
    // Recalculate tactics to clear task-specific metrics
    state.tracks.forEach(track => {
        if (track.visible !== false) {
            track.tactics = analyzeTactics(track.points, state.task, null);
            updateMaxSpeedMarker(track);
        } else {
            track.tactics = null;
        }
    });
    updatePilotListUI();
    
    if (sideView) sideView.render(state);
    try { localStorage.removeItem('pg-task-text'); } catch(e) {}
    resetPredefinedTaskSelect();
}

async function fetchTerrainProfile() {
    const task = state.task;
    const goalIndex = task.findIndex(t => t.type === 'goal');
    const endGoalIdx = goalIndex !== -1 ? goalIndex : task.length - 1;

    // Use the optimized route points (cylinder-edge touch points) if available,
    // falling back to center-to-center.
    const optTask = state.optimizedTask;
    const optPts  = optTask ? optTask.points : null;
    const totalTaskDist = optTask ? optTask.totalDist : calculateRemainingLegs(task, 0, endGoalIdx);

    if (totalTaskDist <= 0 || endGoalIdx <= 0) return;

    const samplePoints = [];
    const TOTAL_SAMPLES = 150;

    // Sample along each leg using optimized waypoints when available
    for (let i = 0; i < endGoalIdx; i++) {
        const from = optPts ? optPts[i]   : task[i];
        const to   = optPts ? optPts[i+1] : task[i+1];
        const legDist = haversineDistance(from, to);
        const numSamples = Math.max(3, Math.round((legDist / totalTaskDist) * TOTAL_SAMPLES));

        const distAtFrom = optPts ? optTask.distances[i]   : (totalTaskDist - calculateRemainingLegs(task, i,   endGoalIdx));
        const distAtTo   = optPts ? optTask.distances[i+1] : (totalTaskDist - calculateRemainingLegs(task, i+1, endGoalIdx));

        for (let j = 0; j < numSamples; j++) {
            const t = j / numSamples;
            const lat   = from.lat + (to.lat - from.lat) * t;
            const lng   = from.lng + (to.lng - from.lng) * t;
            const distKm = distAtFrom + (distAtTo - distAtFrom) * t;
            samplePoints.push({ lat, lng, distKm });
        }
    }
    // Add final goal point
    const goalPt = optPts ? optPts[endGoalIdx] : task[endGoalIdx];
    samplePoints.push({ lat: goalPt.lat, lng: goalPt.lng, distKm: totalTaskDist });
    
    // Check if local DEM contains these points
    if (state.localDem) {
        let allValid = true;
        const localElevations = [];
        for (let i = 0; i < samplePoints.length; i++) {
            const elev = getLocalElevation(samplePoints[i].lat, samplePoints[i].lng);
            if (elev === null) {
                allValid = false;
                break;
            }
            localElevations.push(elev);
        }
        if (allValid) {
            state.terrainProfile = samplePoints.map((p, i) => ({
                distKm: p.distKm,
                elevFt: localElevations[i] * 3.28084
            }));
            console.log(`Loaded ${state.terrainProfile.length} terrain elevation points from local DEM`);
            if (sideView) sideView.render(state);
            return;
        }
    }
    
    // Fetch elevations from Open-Meteo in batches of 100 with DEM caching
    const BATCH_SIZE = 100;
    const elevations = [];
    
    for (let i = 0; i < samplePoints.length; i += BATCH_SIZE) {
        const batch = samplePoints.slice(i, i + BATCH_SIZE);
        
        // 1. Check cache first
        const cached = await getCachedElevations(batch);
        const missingIndices = [];
        const missingPoints = [];
        for (let j = 0; j < batch.length; j++) {
            if (cached[j] === null) {
                missingIndices.push(j);
                missingPoints.push(batch[j]);
            }
        }
        
        // 2. Query missing elevations from Open-Meteo
        if (missingPoints.length > 0) {
            const lats = missingPoints.map(p => p.lat.toFixed(6)).join(',');
            const lngs = missingPoints.map(p => p.lng.toFixed(6)).join(',');
            
            try {
                const resp = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`);
                if (!resp.ok) throw new Error(`HTTP error ${resp.status}`);
                const data = await resp.json();
                if (data && data.elevation && !data.error) {
                    await saveElevationsToCache(missingPoints, data.elevation);
                    for (let k = 0; k < missingPoints.length; k++) {
                        cached[missingIndices[k]] = data.elevation[k];
                    }
                } else {
                    throw new Error((data && data.reason) || "API returned error status");
                }
            } catch (err) {
                console.warn('Failed to fetch terrain elevations:', err);
                useTerrainFallback(task, samplePoints, totalTaskDist, endGoalIdx);
                return;
            }
        }
        
        elevations.push(...cached);
    }
    
    // Check if any elevations are missing (e.g. if the cache lookup returned null and we skipped fetch due to an error that was handled)
    if (elevations.includes(null)) {
        useTerrainFallback(task, samplePoints, totalTaskDist, endGoalIdx);
        return;
    }
    
    state.terrainProfile = samplePoints.map((p, i) => {
        let elev = parseFloat(elevations[i]);
        if (isNaN(elev)) elev = 0;
        return {
            distKm: p.distKm,
            elevFt: elev * 3.28084
        };
    });
    
    console.log(`Loaded ${state.terrainProfile.length} terrain elevation points`);
    if (sideView) sideView.render(state);
}

function useTerrainFallback(task, samplePoints, totalTaskDist, endGoalIdx) {
    state.terrainProfile = samplePoints.map(p => {
        let elev = 0;
        for (let i = 0; i < endGoalIdx; i++) {
            const from = task[i];
            const to = task[i + 1];
            const distAtFrom = totalTaskDist - calculateRemainingLegs(task, i, endGoalIdx);
            const distAtTo = totalTaskDist - calculateRemainingLegs(task, i + 1, endGoalIdx);
            
            if (p.distKm >= distAtFrom && p.distKm <= distAtTo) {
                const legLen = distAtTo - distAtFrom;
                const t = legLen > 0 ? (p.distKm - distAtFrom) / legLen : 0;
                const fromElev = from.elev || 0;
                const toElev = to.elev || 0;
                elev = fromElev + (toElev - fromElev) * t;
                break;
            }
        }
        return {
            distKm: p.distKm,
            elevFt: elev * 3.28084
        };
    });
    console.log(`Loaded ${state.terrainProfile.length} terrain elevation points (interpolated fallback)`);
    if (sideView) sideView.render(state);
}

let terrainFetchQueue = [];
let isFetchingTerrain = false;

function fetchTrackTerrainProfile(track) {
    if (track.terrainProfile) return;
    if (!track.points || track.points.length === 0) return;
    
    if (!terrainFetchQueue.includes(track)) {
        terrainFetchQueue.push(track);
        processTerrainQueue();
    }
}

async function processTerrainQueue() {
    if (isFetchingTerrain || terrainFetchQueue.length === 0) return;
    isFetchingTerrain = true;
    
    while (terrainFetchQueue.length > 0) {
        const track = terrainFetchQueue.shift();
        if (track.terrainProfile) continue;
        
        try {
            await fetchTrackTerrainProfileDirect(track);
        } catch (err) {
            console.error(`Failed to process terrain profile for ${track.name}:`, err);
        }
        
        // Brief spacing to comply with API rate limits
        await new Promise(r => setTimeout(r, 150));
    }
    
    isFetchingTerrain = false;
    await saveTracksToStorage();
}

async function fetchTrackTerrainProfileDirect(track) {
    if (track.terrainProfile) return;
    if (!track.points || track.points.length === 0) return;
    
    const series = (track.tactics && track.tactics.grToGoalSeries && track.tactics.grToGoalSeries.length > 0) ? track.tactics.grToGoalSeries : null;
    const points = track.points;
    const totalPoints = points.length;
    
    const NUM_SAMPLES = 100;
    const sampleIndices = [];
    if (totalPoints <= NUM_SAMPLES) {
        for (let i = 0; i < totalPoints; i++) sampleIndices.push(i);
    } else {
        for (let i = 0; i < NUM_SAMPLES; i++) {
            sampleIndices.push(Math.floor((i / (NUM_SAMPLES - 1)) * (totalPoints - 1)));
        }
    }
    
    const goalIndex = state.task.findIndex(t => t.type === 'goal');
    const endGoalIdx = goalIndex !== -1 ? goalIndex : state.task.length - 1;
    const optTask = state.optimizedTask;
    const totalTaskDist = optTask ? optTask.totalDist : calculateRemainingLegs(state.task, 0, endGoalIdx);
    
    const samplePoints = sampleIndices.map(idx => {
        let distFlown = 0;
        if (series && series[idx]) {
            const s = series[idx];
            distFlown = s.distFlown !== undefined ? s.distFlown : Math.max(0, Math.min(totalTaskDist, totalTaskDist - s.distToGoal));
        }
        return {
            lat: points[idx].lat,
            lng: points[idx].lng,
            distKm: distFlown,
            index: idx
        };
    });
    
    // Check if local DEM contains these points
    if (state.localDem) {
        let allValid = true;
        const localElevations = [];
        for (let i = 0; i < samplePoints.length; i++) {
            const elev = getLocalElevation(samplePoints[i].lat, samplePoints[i].lng);
            if (elev === null) {
                allValid = false;
                break;
            }
            localElevations.push(elev);
        }
        if (allValid) {
            track.terrainProfile = samplePoints.map((p, i) => {
                let elev = parseFloat(localElevations[i]);
                if (isNaN(elev)) elev = 0;
                return {
                    distKm: p.distKm,
                    elevFt: elev * 3.28084,
                    lat: p.lat,
                    lng: p.lng,
                    index: p.index
                };
            });
            if (sideView) sideView.render(state);
            
            // Instantly update alt display in pilot standings table
            const altEl = document.getElementById(`alt-${track.id}`);
            if (altEl) {
                const currentIdx = track.currentPosIndex !== undefined ? track.currentPosIndex : 0;
                const currentPos = track.points[currentIdx];
                if (currentPos) {
                    const altFt = currentPos.alt * 3.28084;
                    let aglStr = '';
                    const profile = track.terrainProfile;
                    let groundElevFt = null;
                    if (profile[0].index !== undefined) {
                        if (currentIdx <= profile[0].index) {
                            groundElevFt = profile[0].elevFt;
                        } else if (currentIdx >= profile[profile.length - 1].index) {
                            groundElevFt = profile[profile.length - 1].elevFt;
                        } else {
                            for (let i = 0; i < profile.length - 1; i++) {
                                const p1 = profile[i];
                                const p2 = profile[i + 1];
                                if (currentIdx >= p1.index && currentIdx <= p2.index) {
                                    const ratio = (currentIdx - p1.index) / (p2.index - p1.index);
                                    groundElevFt = p1.elevFt + ratio * (p2.elevFt - p1.elevFt);
                                    break;
                                }
                            }
                        }
                    }
                    if (groundElevFt !== null) {
                        aglStr = ` (${Math.round(altFt - groundElevFt)})`;
                    }
                    altEl.textContent = `${Math.round(altFt)}${aglStr}`;
                }
            }
            saveSingleTrackToStorage(track);
            return;
        }
    }
    
    const BATCH_SIZE = 100;
    const elevations = [];
    for (let i = 0; i < samplePoints.length; i += BATCH_SIZE) {
        const batch = samplePoints.slice(i, i + BATCH_SIZE);
        
        // 1. Check DEM cache first
        const cached = await getCachedElevations(batch);
        const missingIndices = [];
        const missingPoints = [];
        for (let j = 0; j < batch.length; j++) {
            if (cached[j] === null) {
                missingIndices.push(j);
                missingPoints.push(batch[j]);
            }
        }
        
        // 2. Query missing coordinates from Open-Meteo
        if (missingPoints.length > 0) {
            const lats = missingPoints.map(p => p.lat.toFixed(6)).join(',');
            const lngs = missingPoints.map(p => p.lng.toFixed(6)).join(',');
            
            try {
                const resp = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`);
                if (!resp.ok) throw new Error(`HTTP error ${resp.status}`);
                const data = await resp.json();
                if (data && data.elevation && !data.error) {
                    await saveElevationsToCache(missingPoints, data.elevation);
                    for (let k = 0; k < missingPoints.length; k++) {
                        cached[missingIndices[k]] = data.elevation[k];
                    }
                } else {
                    throw new Error((data && data.reason) || "API returned error status");
                }
            } catch (err) {
                console.warn(`Failed to fetch terrain elevations for pilot ${track.name}:`, err);
                throw err;
            }
        }
        
        elevations.push(...cached);
    }
    
    if (elevations.length === samplePoints.length) {
        track.terrainProfile = samplePoints.map((p, i) => {
            let elev = parseFloat(elevations[i]);
            if (isNaN(elev)) elev = 0;
            return {
                distKm: p.distKm,
                elevFt: elev * 3.28084,
                lat: p.lat,
                lng: p.lng,
                index: p.index
            };
        });
        if (sideView) sideView.render(state);
        
        // Instantly update alt display in pilot standings table
        const altEl = document.getElementById(`alt-${track.id}`);
        if (altEl) {
            const currentIdx = track.currentPosIndex !== undefined ? track.currentPosIndex : 0;
            const currentPos = track.points[currentIdx];
            if (currentPos) {
                const altFt = currentPos.alt * 3.28084;
                let aglStr = '';
                const profile = track.terrainProfile;
                let groundElevFt = null;
                if (profile[0].index !== undefined) {
                    if (currentIdx <= profile[0].index) {
                        groundElevFt = profile[0].elevFt;
                    } else if (currentIdx >= profile[profile.length - 1].index) {
                        groundElevFt = profile[profile.length - 1].elevFt;
                    } else {
                        for (let i = 0; i < profile.length - 1; i++) {
                            const p1 = profile[i];
                            const p2 = profile[i + 1];
                            if (currentIdx >= p1.index && currentIdx <= p2.index) {
                                const ratio = (currentIdx - p1.index) / (p2.index - p1.index);
                                groundElevFt = p1.elevFt + ratio * (p2.elevFt - p1.elevFt);
                                break;
                            }
                        }
                    }
                }
                if (groundElevFt !== null) {
                    aglStr = ` (${Math.round(altFt - groundElevFt)})`;
                }
                altEl.textContent = `${Math.round(altFt)}${aglStr}`;
            }
        }
        saveSingleTrackToStorage(track);
    }
}

async function handleFileUpload(e) {
    resetPredefinedTaskSelect();
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Close settings modal immediately so progress bar is visible floating on the page
    const modal = document.getElementById('settings-modal');
    if (modal) modal.classList.add('hidden');

    const loader = document.getElementById('track-loader');
    const fill = document.getElementById('loader-bar-fill');
    const text = document.getElementById('track-loader-text');

    if (loader) {
        loader.classList.remove('hidden');
        if (text) text.textContent = `Preparing to load ${files.length} files...`;
        if (fill) fill.style.width = '0%';
    }

    // Yield thread to let modal close and loader render
    await new Promise(resolve => setTimeout(resolve, 100));

    let successfulCount = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const name = file.name;
        const cleanName = formatPilotName(name);

        if (text) text.textContent = `Reading ${cleanName}... (${i + 1}/${files.length})`;
        if (fill) fill.style.width = `${(i / files.length) * 100}%`;

        // Yield thread to let UI update
        await new Promise(resolve => setTimeout(resolve, 20));

        try {
            const content = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (event) => resolve(event.target.result);
                reader.onerror = (err) => reject(err);
                reader.readAsText(file);
            });

            let rawPoints = [];
            if (name.toLowerCase().endsWith('.igc')) {
                rawPoints = parseIGC(content);
            } else if (name.toLowerCase().endsWith('.gpx')) {
                rawPoints = parseGPX(content);
            } else if (name.toLowerCase().endsWith('.kml')) {
                rawPoints = parseKML(content);
            }

            if (rawPoints && rawPoints.length > 0) {
                const points = ensureTimestamps(rawPoints);
                addTrackToState(name, points);
                successfulCount++;
            }
        } catch (err) {
            console.error(`Error loading file ${name}:`, err);
        }
    }

    if (fill) fill.style.width = '100%';
    if (text) text.textContent = `Successfully loaded ${successfulCount} tracks!`;

    // Wait a brief moment for the user to see the success state
    await new Promise(resolve => setTimeout(resolve, 300));

    if (loader) loader.classList.add('hidden');
    onAllFilesLoaded();

    // Reset file input
    e.target.value = '';
}

function addTrackToState(rawName, points, terrainProfile = null) {
    ensureTimestamps(points);
    const name = formatPilotName(rawName);
    const fullName = getPilotFullName(rawName);
    const initials = getPilotInitials(rawName);
    const id = 'pilot-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const color = COLORS[state.tracks.length % COLORS.length];
    
    // Create map layers
    const layerGroup = L.featureGroup().addTo(state.map);
    
    // Full track polyline
    const latlngs = points.map(p => [p.lat, p.lng]);
    const polyline = L.polyline(latlngs, { 
        color: color, 
        weight: 1.5, 
        opacity: 0.6 
    }).addTo(layerGroup);

    // Calculate initial heading from first two points
    let initialHeading = 0;
    if (points && points.length > 1) {
        const rad = bearing(points[0], points[1]);
        initialHeading = rad * 180 / Math.PI;
    }

    // Calculate dynamic pilot marker sizes based on current map zoom (minimum size is 36px now, 150% of 24px)
    let targetSize = 36;
    let topOffset = 18;
    let leftOffset = 18;
    let labelTop = 22;
    if (state.map) {
        const zoom = state.map.getZoom();
        const lat = points[0].lat;
        const metersPerPixel = (40075016.686 * Math.cos(lat * Math.PI / 180)) / (256 * Math.pow(2, zoom));
        const size10m = 10 / metersPerPixel;
        targetSize = Math.max(36, size10m * 1.2);
        topOffset = targetSize * 0.5;
        leftOffset = targetSize * 0.5;
        labelTop = (targetSize * 0.5) + 4;
    }

    // Dynamic Pilot Marker (Paraglider Wing shape - Symmetrical Top-Down View)
    const iconHtml = `
        <div class="pilot-marker-icon" title="${fullName}">
            <div class="pilot-marker-dot" style="transform: rotate(${initialHeading}deg); width: ${targetSize}px; height: ${targetSize}px; top: -${topOffset}px; left: -${leftOffset}px; transform-origin: 50% 50%;">
                <svg width="${targetSize}" height="${targetSize}" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <!-- Pod Harness (Pilot) - sticking out front and back, nose at 16.5, tail at 33, CG at 24 -->
                    <path d="M 24 16.5 C 25.5 16.5, 25.8 21, 25.8 24 C 25.8 28, 25.3 33.0, 24 33.0 C 22.7 33.0, 22.2 28, 22.2 24 C 22.2 21, 22.5 16.5, 24 16.5 Z" fill="#0f172a" stroke="white" stroke-width="0.75" />

                    <!-- Paraglider Wing Canopy - flat trailing edge, curved leading edge, vertical wing tips -->
                    <path d="M 4 24 Q 24 16 44 24 L 44 26 L 4 26 Z" fill="${color}" stroke="#0f172a" stroke-width="1.25" stroke-linejoin="round" />

                    <!-- Internal cell details (ribs) for realistic top view -->
                    <line x1="24" y1="20" x2="24" y2="26" stroke="rgba(255,255,255,0.4)" stroke-width="0.55" />
                    <line x1="19" y1="20.25" x2="19" y2="26" stroke="rgba(255,255,255,0.4)" stroke-width="0.55" />
                    <line x1="14" y1="21" x2="14" y2="26" stroke="rgba(255,255,255,0.4)" stroke-width="0.55" />
                    <line x1="9" y1="22.25" x2="9" y2="26" stroke="rgba(255,255,255,0.4)" stroke-width="0.55" />
                    <line x1="29" y1="20.25" x2="29" y2="26" stroke="rgba(255,255,255,0.4)" stroke-width="0.55" />
                    <line x1="34" y1="21" x2="34" y2="26" stroke="rgba(255,255,255,0.4)" stroke-width="0.55" />
                    <line x1="39" y1="22.25" x2="39" y2="26" stroke="rgba(255,255,255,0.4)" stroke-width="0.55" />
                </svg>
            </div>
            <div class="pilot-marker-label" style="background-color: ${color}; top: ${labelTop}px;">${initials}</div>
        </div>
    `;
    const icon = L.divIcon({
        html: iconHtml,
        className: '',
        iconSize: [0, 0],
        iconAnchor: [0, 0]
    });
    
    const marker = L.marker([points[0].lat, points[0].lng], { icon, title: fullName }).addTo(layerGroup);

    const trackObj = {
        id,
        name,
        rawName,
        fullName,
        initials,
        color,
        points,
        terrainProfile,
        layerGroup,
        polyline,
        marker,
        currentPosIndex: 0,
        lastHeading: initialHeading
    };

    state.tracks.push(trackObj);

    // Update global min/max time
    const tMin = points[0].time;
    const tMax = points[points.length - 1].time;
    if (tMin < state.minTime) state.minTime = tMin;
    if (tMax > state.maxTime) state.maxTime = tMax;
}

function updateMarkerSizes() {
    if (!state.map || state.tracks.length === 0) return;
    
    const zoom = state.map.getZoom();
    const center = state.map.getCenter();
    const lat = center.lat;
    
    // Formula for meters per pixel in Web Mercator
    const metersPerPixel = (40075016.686 * Math.cos(lat * Math.PI / 180)) / (256 * Math.pow(2, zoom));
    
    // 10 meters in pixels
    const size10m = 10 / metersPerPixel;
    
    // Scale size: minimum 36px, otherwise matching 10m (with 1.2 multiplier so wing span is 10m on map)
    const targetSize = Math.max(36, size10m * 1.2);
    const topOffset = targetSize * 0.5;
    const leftOffset = targetSize * 0.5;
    const labelTop = (targetSize * 0.5) + 4;
    
    state.tracks.forEach(track => {
        if (!track.marker) return;
        const markerEl = track.marker.getElement();
        if (markerEl) {
            const dot = markerEl.querySelector('.pilot-marker-dot');
            if (dot) {
                dot.style.width = `${targetSize}px`;
                dot.style.height = `${targetSize}px`;
                dot.style.top = `-${topOffset}px`;
                dot.style.left = `-${leftOffset}px`;
                
                const svg = dot.querySelector('svg');
                if (svg) {
                    svg.setAttribute('width', targetSize);
                    svg.setAttribute('height', targetSize);
                }
            }
            const label = markerEl.querySelector('.pilot-marker-label');
            if (label) {
                label.style.top = `${labelTop}px`;
            }
        }
    });
}

function clearTracks() {
    if (state.isPlaying) {
        togglePlayback();
    }
    
    state.tracks.forEach(t => {
        if (state.map && t.layerGroup) {
            state.map.removeLayer(t.layerGroup);
        }
    });
    
    state.tracks = [];
    state.minTime = Infinity;
    state.maxTime = -Infinity;
    state.currentTime = 0;
    
    const scrubber = document.getElementById('timeline-scrubber');
    if (scrubber) {
        scrubber.value = 0;
        scrubber.disabled = true;
    }
    
    const timeDisplay = document.getElementById('time-display');
    if (timeDisplay) timeDisplay.textContent = '--:--:--';
    
    updatePilotListUI();
    clearTracksInStorage();
    resetPredefinedTaskSelect();
    
    if (sideView) sideView.render(state);
    updateStatsAnalysis();
    updateLeadingPointsChart();
    
    // Clear Lift/Sink overlay
    if (state.liftSinkLayerGroup) {
        state.liftSinkLayerGroup.clearLayers();
    }
}

async function clearTracksInStorage() {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(tx.error || e.target.error);
        });
        console.log('Cleared all tracks from IndexedDB');
    } catch (e) {
        console.warn('Could not clear tracks from IndexedDB:', e);
    }
}

function onAllFilesLoaded() {
    if (state.tracks.length === 0) return;

    // Fit map to all tracks
    const allLayers = L.featureGroup(state.tracks.map(t => t.layerGroup));
    state.map.invalidateSize();
    try {
        const bounds = allLayers.getBounds();
        if (bounds && bounds.isValid()) {
            state.map.fitBounds(bounds, { padding: [50, 50] });
        }
    } catch (err) {
        console.warn('Could not fit map bounds:', err);
    }

    // Setup scrubber
    const scrubber = document.getElementById('timeline-scrubber');
    scrubber.min = state.minTime;
    scrubber.max = state.maxTime;
    scrubber.value = state.minTime;
    scrubber.disabled = false;
    
    state.currentTime = state.minTime;
    
    updatePilotListUI();
    updatePlaybackState();
    updateMarkerSizes();
    
    saveTracksToStorage();
}

function recomputeSpeedSectionTimes() {
    if (state.startGateTime !== null) {
        // startGateTime is already used directly in analyzeTactics, so speedSectionTime is already correct.
        return;
    }
    
    // Find earliest ssCrossTime of any visible track
    let minSSCrossTime = Infinity;
    state.tracks.forEach(track => {
        if (track.visible !== false && track.tactics && track.tactics.ssCrossTime !== null) {
            if (track.tactics.ssCrossTime < minSSCrossTime) {
                minSSCrossTime = track.tactics.ssCrossTime;
            }
        }
    });
    
    // Apply minSSCrossTime to calculate speedSectionTime for all tracks
    state.tracks.forEach(track => {
        if (track.tactics) {
            if (track.tactics.ssCrossTime !== null && track.tactics.essCrossTime !== null && minSSCrossTime !== Infinity) {
                let elapsed = track.tactics.essCrossTime - minSSCrossTime;
                if (elapsed < 0) elapsed += 86400;
                track.tactics.speedSectionTime = elapsed;
            } else {
                track.tactics.speedSectionTime = null;
            }
        }
    });
}

function updatePilotListUI() {
    const list = document.getElementById('pilot-list');
    list.innerHTML = '';
    
    // Sync Select All Checkbox state
    const allChecked = state.tracks.length > 0 && state.tracks.every(t => t.visible !== false);
    const chkAll = document.getElementById('chk-all-tracks');
    if (chkAll) chkAll.checked = allChecked;

    state.tracks.forEach(track => {
        // Setup tactical overlay for selected tracks only
        if (track.visible !== false && !track.tactics) {
            track.tactics = analyzeTactics(track.points, state.task, state.startGateTime);
            updateMaxSpeedMarker(track);
            fetchTrackTerrainProfile(track);
        }
    });

    // Recompute speed section times (either from startGateTime or minimum ssCrossTime fallback)
    recomputeSpeedSectionTimes();

    // Calculate Leading Points once initially or re-calculate
    updateRealTimeScores();

    state.tracks.forEach(track => {
        let fgDistStr = '--';
        let fgGrStr = '--';
        let essAltStr = '--';
        let essGrStr = '--';

        if (track.tactics && track.tactics.finalGlideStartTime !== null && track.tactics.finalGlideStartTime !== undefined) {
            const fgNeeded = track.tactics.finalGlideGrToGoal;
            const essNeeded = track.tactics.essGrNeededToGoal;
            
            const fgDist = track.tactics.finalGlideDistToGoal;
            fgDistStr = (fgDist !== null && fgDist !== undefined) ? fgDist.toFixed(1) : '--';
            fgGrStr = (fgNeeded !== null && fgNeeded !== undefined) ? (fgNeeded > 100 ? '99+' : fgNeeded.toFixed(1)) : '--';
            
            if (track.tactics.essCrossTime !== null && track.tactics.essCrossTime !== undefined) {
                const essTP = state.task.find(t => t.type === 'es');
                const goalTP = state.task.find(t => t.type === 'goal') || state.task[state.task.length - 1];
                const refElev = essTP ? essTP.elev : (goalTP ? goalTP.elev : 0);
                const essAglFt = (track.tactics.essCrossAlt - refElev) * 3.28084;
                essAltStr = `${Math.round(essAglFt)}`;
                
                essGrStr = (essNeeded !== null && essNeeded !== undefined) ? (essNeeded > 100 ? '99+' : essNeeded.toFixed(1)) : '--';
                if (essNeeded > 12) {
                    essGrStr = `<span style="color:var(--danger)">${essGrStr}</span>`;
                }
            }
        }

        let maxSpdStr = '--';
        if (track.tactics && track.tactics.maxSpeed10Sec !== undefined && track.tactics.maxSpeed10Sec !== null) {
            maxSpdStr = Math.round(track.tactics.maxSpeed10Sec).toString();
        }

        let essTimeStr = '--:--:--';
        if (track.tactics && track.tactics.speedSectionTime !== null && track.tactics.speedSectionTime !== undefined) {
            essTimeStr = formatTime(track.tactics.speedSectionTime);
        }

        const leadPtsStr = (track.leadingPoints !== undefined && track.leadingPoints !== null) ? track.leadingPoints.toFixed(1) : '--';
        const timePtsStr = (track.timePoints !== undefined && track.timePoints !== null) ? track.timePoints.toFixed(1) : '--';

        // Main Pilot Row
        const row = document.createElement('tr');
        row.className = 'pilot-row';
        row.id = `row-${track.id}`;
        row.innerHTML = `
            <td>
                <input type="checkbox" class="chk-track" data-track-id="${track.id}" ${track.visible !== false ? 'checked' : ''} style="margin-right: 6px; vertical-align: middle;">
                <span class="pilot-color-indicator" style="background-color: ${track.color};"></span>
                ${track.name}
            </td>
            <td class="stat-value" id="alt-${track.id}">--</td>
            <td class="stat-value" id="spd-${track.id}">--</td>
            <td class="stat-value" id="dist-${track.id}">--</td>
            <td class="stat-value" id="gr-${track.id}">--</td>
            <td class="stat-value" id="grgoal-${track.id}">--</td>
            <td class="stat-value" id="leadpts-${track.id}">${leadPtsStr}</td>
            <td class="stat-value" id="timepts-${track.id}">${timePtsStr}</td>
        `;
        
        // Collapsed Details Row
        const detailsRow = document.createElement('tr');
        detailsRow.className = 'pilot-details-row';
        detailsRow.id = `details-${track.id}`;
        detailsRow.style.display = 'none';
        detailsRow.innerHTML = `
            <td colspan="8">
                <div class="pilot-details-content">
                    <div class="detail-item"><strong>FG Dist:</strong> <span>${fgDistStr} km</span></div>
                    <div class="detail-item"><strong>FG GR:</strong> <span>${fgGrStr}</span></div>
                    <div class="detail-item"><strong>ESS Alt AGL:</strong> <span>${essAltStr} ft</span></div>
                    <div class="detail-item"><strong>ESS GR:</strong> <span>${essGrStr}</span></div>
                    <div class="detail-item"><strong>ESS Time:</strong> <span>${essTimeStr}</span></div>
                    <div class="detail-item"><strong>Max Spd (10s avg):</strong> <span>${maxSpdStr} km/h</span></div>
                </div>
            </td>
        `;
        
        list.appendChild(row);
        list.appendChild(detailsRow);

        // Click row to toggle details
        row.addEventListener('click', (e) => {
            if (e.target.classList.contains('chk-track') || e.target.type === 'checkbox') {
                return;
            }
            const isOpen = detailsRow.style.display !== 'none';
            detailsRow.style.display = isOpen ? 'none' : 'table-row';
            row.classList.toggle('expanded', !isOpen);
        });

        const chk = row.querySelector('.chk-track');
        if (chk) {
            chk.addEventListener('change', (e) => {
                setTrackVisibility(track, e.target.checked);
                const allChks = list.querySelectorAll('.chk-track');
                const allCheckedNow = Array.from(allChks).every(c => c.checked);
                if (chkAll) chkAll.checked = allCheckedNow;
            });
        }
    });

    // Apply sorting immediately on draw
    sortPilotList();
    
    // Update stats chart in real-time if panel is open
    const rightPanelEl = document.getElementById('right-panel');
    if (rightPanelEl && !rightPanelEl.classList.contains('collapsed')) {
        updateStatsAnalysis();
        updateLeadingPointsChart();
    }
}

function setTrackVisibility(track, visible) {
    track.visible = visible;
    if (visible) {
        if (state.map && track.layerGroup) {
            track.layerGroup.addTo(state.map);
        }
        if (!track.tactics) {
            track.tactics = analyzeTactics(track.points, state.task, state.startGateTime);
            updateMaxSpeedMarker(track);
            fetchTrackTerrainProfile(track);
            updatePilotListUI();
        } else if (visible && track.tactics && !track.terrainProfile) {
            fetchTrackTerrainProfile(track);
        }
    } else {
        if (state.map && track.layerGroup) {
            state.map.removeLayer(track.layerGroup);
        }
    }
    if (sideView) sideView.render(state);
}

function togglePlayback() {
    if (state.tracks.length === 0) return;
    
    state.isPlaying = !state.isPlaying;
    const btn = document.getElementById('btn-play-pause');
    
    if (state.isPlaying) {
        btn.textContent = '⏸';
        state.lastFrameTime = performance.now();
        playLoop();
    } else {
        btn.textContent = '▶';
        cancelAnimationFrame(state.animationFrameId);
    }
}

function playLoop(timestamp) {
    if (!state.isPlaying) return;
    
    const deltaMs = timestamp - state.lastFrameTime;
    if (deltaMs > 0) {
        // Advance time: deltaMs (ms) * speed / 1000 = delta time (sec)
        const advanceSecs = (deltaMs * state.playbackSpeed) / 1000;
        state.currentTime += advanceSecs;
        
        if (state.currentTime > state.maxTime) {
            state.currentTime = state.minTime;
            togglePlayback(); // Auto pause at end
            updatePlaybackState();
            return;
        }
        
        document.getElementById('timeline-scrubber').value = state.currentTime;
        updatePlaybackState();
    }
    
    state.lastFrameTime = timestamp;
    state.animationFrameId = requestAnimationFrame(playLoop);
}

function handleScrub(e) {
    state.currentTime = parseFloat(e.target.value);
    updatePlaybackState();
}

function formatTime(seconds) {
    const s = Math.floor(seconds) % 86400;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

// Interpolate between two points based on time
function interpolatePoint(p1, p2, t) {
    if (t <= p1.time) return p1;
    if (t >= p2.time) return p2;
    
    const ratio = (t - p1.time) / (p2.time - p1.time);
    return {
        lat: p1.lat + (p2.lat - p1.lat) * ratio,
        lng: p1.lng + (p2.lng - p1.lng) * ratio,
        alt: p1.alt + (p2.alt - p1.alt) * ratio,
        time: t
    };
}

function updatePlaybackState() {
    document.getElementById('time-display').textContent = formatTime(state.currentTime);
    
    state.tracks.forEach(track => {
        // Find current segment using binary search or linear scan
        const pts = track.points;
        if (state.currentTime <= pts[0].time) {
            track.currentPosIndex = 0;
            updatePilotMarker(track, pts[0], null);
        } else if (state.currentTime >= pts[pts.length - 1].time) {
            track.currentPosIndex = pts.length - 1;
            updatePilotMarker(track, pts[pts.length - 1], null);
        } else {
            // Simple linear scan (could optimize by storing currentPosIndex)
            let i = track.currentPosIndex;
            
            // Adjust index to current time
            while (i < pts.length - 1 && pts[i + 1].time < state.currentTime) i++;
            while (i > 0 && pts[i].time > state.currentTime) i--;
            
            track.currentPosIndex = i;
            
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const currentPos = interpolatePoint(p1, p2, state.currentTime);
            
            // Calculate speed and GR (look back ~10 seconds for smoothing)
            let lookbackIdx = i;
            while (lookbackIdx > 0 && pts[i].time - pts[lookbackIdx].time < 10) {
                lookbackIdx--;
            }
            
            updatePilotMarker(track, currentPos, pts[lookbackIdx]);
        }
    });

    // Throttled Sorting (don't sort every single frame)
    if (state.currentSort !== 'name') {
        sortPilotList();
    }
    
    updateRealTimeScores();
    
    // Render side view once per frame
    if (sideView) sideView.render(state);

    // Update Lift/Sink map overlay
    updateLiftSinkOverlay();
}

let lastScoreUpdatePerf = 0;

function updateRealTimeScores() {
    if (!state.task || state.task.length === 0 || !state.tracks || state.tracks.length === 0) return;

    // Throttle to roughly 10 FPS
    const now = performance.now();
    if (now - lastScoreUpdatePerf < 100) return;
    lastScoreUpdatePerf = now;

    let speedSectionDist = 0;
    let minSSCrossTime = Infinity;
    let lastOutlandingTime = 0;
    let lastEssTime = 0;

    state.tracks.forEach(t => {
        if (t.tactics) {
            if (t.tactics.speedSectionDist > speedSectionDist) {
                speedSectionDist = t.tactics.speedSectionDist;
            }
            if (t.tactics.essCrossTime) {
                if (t.tactics.essCrossTime > lastEssTime) lastEssTime = t.tactics.essCrossTime;
            } else if (t.points && t.points.length > 0) {
                const lastPtTime = t.points[t.points.length - 1].time;
                if (lastPtTime > lastOutlandingTime) lastOutlandingTime = lastPtTime;
            }
            if (t.tactics.ssCrossTime !== null && t.tactics.ssCrossTime < minSSCrossTime) {
                minSSCrossTime = t.tactics.ssCrossTime;
            }
        }
    });

    const firstStartTime = state.startGateTime !== null ? state.startGateTime : (minSSCrossTime !== Infinity ? minSSCrossTime : 0);

    calculateLeadingPoints(
        state.tracks, 
        162.5, 
        speedSectionDist, 
        state.deadlineTime || Infinity, 
        firstStartTime, 
        lastOutlandingTime, 
        lastEssTime,
        state.currentTime
    );

    // Call calculateTimePoints only if we're near the end of the race, or let it evaluate dynamically
    // In GAP, time points are given if they reached ESS, which implies playback reached their ESS time.
    calculateTimePoints(state.tracks, 202.85, state.currentTime);

    state.tracks.forEach(track => {
        const leadPtsEl = document.getElementById(`leadpts-${track.id}`);
        if (leadPtsEl) {
            const leadPtsStr = (track.leadingPoints !== undefined && track.leadingPoints !== null) ? track.leadingPoints.toFixed(1) : '--';
            leadPtsEl.textContent = leadPtsStr;
        }

        const timePtsEl = document.getElementById(`timepts-${track.id}`);
        if (timePtsEl) {
            const timePtsStr = (track.timePoints !== undefined && track.timePoints !== null) ? track.timePoints.toFixed(1) : '--';
            timePtsEl.textContent = timePtsStr;
        }
        
        if (track.leadingPoints !== undefined && track.leadingPoints !== null) {
            const coinInterval = state.coinInterval || 3;
            const currentMilestone = Math.floor(track.leadingPoints / coinInterval);
            if (track.lastCoinMilestone === undefined) {
                track.lastCoinMilestone = currentMilestone;
            } else if (currentMilestone > track.lastCoinMilestone) {
                if (state.isPlaying && state.coinEnabled) {
                    const pointGain = (currentMilestone - track.lastCoinMilestone) * coinInterval;
                    showCoinAnimation(track, pointGain);
                    playCoinSound();
                }
                track.lastCoinMilestone = currentMilestone;
            } else if (currentMilestone < track.lastCoinMilestone) {
                track.lastCoinMilestone = currentMilestone;
            }
        }
    });
}

function showCoinAnimation(track, value = 1) {
    const displayVal = Math.round(value);
    const text = displayVal > 0 ? `+${displayVal}` : '';
    if (!text) return;

    // 1. Map Animation
    if (state.map && track.marker) {
        const latlng = track.marker.getLatLng();
        if (latlng) {
            const mapPoint = state.map.latLngToContainerPoint(latlng);
            const mapContainer = state.map.getContainer();
            
            const coin = document.createElement('div');
            coin.className = 'coin-popup';
            coin.innerHTML = text;
            coin.style.left = `${mapPoint.x - 10}px`;
            coin.style.top = `${mapPoint.y - 10}px`;
            coin.style.color = track.color;
            coin.style.textShadow = '1px 1px 0 #000';
            
            mapContainer.appendChild(coin);
            
            setTimeout(() => {
                if (mapContainer.contains(coin)) {
                    mapContainer.removeChild(coin);
                }
            }, 800);
        }
    }
    
    // 2. Side View Animation
    if (sideView && sideView.pilotCoords && sideView.container) {
        const pCoord = sideView.pilotCoords.find(p => p.track.id === track.id);
        if (pCoord) {
            const coinSV = document.createElement('div');
            coinSV.className = 'coin-popup';
            coinSV.innerHTML = text;
            coinSV.style.left = `${pCoord.x - 10}px`;
            coinSV.style.top = `${pCoord.y - 10}px`;
            coinSV.style.color = track.color;
            coinSV.style.textShadow = '1px 1px 0 #000';
            
            sideView.container.appendChild(coinSV);
            
            setTimeout(() => {
                if (sideView.container.contains(coinSV)) {
                    sideView.container.removeChild(coinSV);
                }
            }, 800);
        }
    }
}

function sortPilotList() {
    if (state.tracks.length === 0) return;
    
    // Sort logic
    state.tracks.sort((a, b) => {
        if (state.currentSort === 'name') {
            return a.name.localeCompare(b.name);
        } else if (state.currentSort === 'alt') {
            const aVal = a.currentAlt ?? 0;
            const bVal = b.currentAlt ?? 0;
            return bVal - aVal; // Descending
        } else if (state.currentSort === 'dist') {
            const aVal = a.currentDistToGoal ?? Infinity;
            const bVal = b.currentDistToGoal ?? Infinity;
            if (aVal === bVal) return 0;
            return aVal - bVal; // Ascending
        } else if (state.currentSort === 'gr') {
            const aVal = a.currentInstGR ?? 0;
            const bVal = b.currentInstGR ?? 0;
            return aVal - bVal; // Ascending
        } else if (state.currentSort === 'grGoal') {
            const aVal = a.currentGRGoal ?? Infinity;
            const bVal = b.currentGRGoal ?? Infinity;
            if (aVal === bVal) return 0;
            return aVal - bVal; // Ascending
        } else if (state.currentSort === 'maxSpeed') {
            const aVal = a.tactics?.maxSpeed10Sec ?? -Infinity;
            const bVal = b.tactics?.maxSpeed10Sec ?? -Infinity;
            if (aVal === bVal) return 0;
            return bVal - aVal; // Descending
        } else if (state.currentSort === 'fgDist') {
            const aVal = a.tactics?.finalGlideDistToGoal ?? Infinity;
            const bVal = b.tactics?.finalGlideDistToGoal ?? Infinity;
            if (aVal === bVal) return 0;
            return bVal - aVal; // Descending (longer final glide is more impressive)
        } else if (state.currentSort === 'fgGr') {
            const aVal = a.tactics?.finalGlideGrToGoal ?? Infinity;
            const bVal = b.tactics?.finalGlideGrToGoal ?? Infinity;
            if (aVal === bVal) return 0;
            return aVal - bVal; // Ascending
        } else if (state.currentSort === 'essAlt') {
            const aVal = a.tactics?.essCrossAlt ?? -Infinity;
            const bVal = b.tactics?.essCrossAlt ?? -Infinity;
            if (aVal === bVal) return 0;
            return bVal - aVal; // Descending
        } else if (state.currentSort === 'essGr') {
            const aVal = a.tactics?.essGrNeededToGoal ?? Infinity;
            const bVal = b.tactics?.essGrNeededToGoal ?? Infinity;
            if (aVal === bVal) return 0;
            return aVal - bVal; // Ascending
        } else if (state.currentSort === 'essTime') {
            const aVal = a.tactics?.speedSectionTime ?? Infinity;
            const bVal = b.tactics?.speedSectionTime ?? Infinity;
            if (aVal === bVal) return 0;
            return aVal - bVal; // Ascending (shortest speed run duration is best)
        }
        return 0;
    });
    
    // Reorder DOM elements
    const list = document.getElementById('pilot-list');
    state.tracks.forEach(track => {
        const row = document.getElementById(`row-${track.id}`);
        if (row) list.appendChild(row);
        const detailsRow = document.getElementById(`details-${track.id}`);
        if (detailsRow) list.appendChild(detailsRow);
    });
}

function updateMaxSpeedMarker(track) {
    if (track.maxSpeedMarker) {
        track.layerGroup.removeLayer(track.maxSpeedMarker);
        track.maxSpeedMarker = null;
    }
    
    /* Commented out debug max speed dots on map
    if (track.tactics && track.tactics.maxSpeed10SecIdx !== undefined && track.tactics.maxSpeed10SecIdx !== -1) {
        const pt = track.points[track.tactics.maxSpeed10SecIdx];
        if (pt) {
            const speed = track.tactics.maxSpeed10Sec;
            const marker = L.circleMarker([pt.lat, pt.lng], {
                radius: 5,
                color: '#ef4444',
                fillColor: '#ef4444',
                fillOpacity: 0.9,
                weight: 1.5
            });
            marker.bindTooltip(`${track.fullName}: Max ${Math.round(speed)} km/h @ ${formatTime(pt.time)}`, {
                permanent: false,
                direction: 'top'
            });
            marker.addTo(track.layerGroup);
            track.maxSpeedMarker = marker;
        }
    }
    */
}

function updatePilotMarker(track, currentPos, prevPos) {
    track.marker.setLatLng([currentPos.lat, currentPos.lng]);
    track.currentAlt = currentPos.alt;
    
    // Rotate dot based on heading
    let heading = track.lastHeading !== undefined ? track.lastHeading : 0;
    if (prevPos) {
        const dist = haversineDistance(prevPos, currentPos);
        if (dist > 0.005) { // at least 5 meters in 10s (~1.8 km/h)
            const rad = bearing(prevPos, currentPos);
            heading = rad * 180 / Math.PI;
            track.lastHeading = heading;
        }
    } else if (track.points && track.points.length > 1) {
        const p1 = track.points[0];
        const p2 = track.points[1];
        const rad = bearing(p1, p2);
        heading = rad * 180 / Math.PI;
        track.lastHeading = heading;
    }
    
    const markerEl = track.marker.getElement();
    if (markerEl) {
        const dot = markerEl.querySelector('.pilot-marker-dot');
        if (dot) {
            dot.style.transform = `rotate(${heading}deg)`;
        }
    }
    
    // Snail trail animation
    if (track.currentPosIndex !== undefined) {
        const trailPoints = [];
        const step = track.currentPosIndex > 3000 ? 5 : (track.currentPosIndex > 1000 ? 2 : 1);
        for (let i = 0; i <= track.currentPosIndex; i += step) {
            trailPoints.push(track.points[i]);
        }
        if (track.currentPosIndex % step !== 0) {
            trailPoints.push(track.points[track.currentPosIndex]);
        }
        // Include the interpolated currentPos at the very tip for smooth animation
        trailPoints.push(currentPos);
        track.polyline.setLatLngs(trailPoints.map(p => [p.lat, p.lng]));
    }
    
    // Update stats UI
    const altEl = document.getElementById(`alt-${track.id}`);
    const spdEl = document.getElementById(`spd-${track.id}`);
    const distEl = document.getElementById(`dist-${track.id}`);
    const grEl = document.getElementById(`gr-${track.id}`);
    
    // Altitude in feet
    if (altEl) {
        const altFt = currentPos.alt * 3.28084;
        let aglStr = '';
        if (track.terrainProfile && track.terrainProfile.length > 0) {
            let groundElevFt = null;
            const profile = track.terrainProfile;
            const currentIdx = track.currentPosIndex !== undefined ? track.currentPosIndex : 0;
            
            // 1. Try index-based lookup (most accurate time/position mapping)
            if (profile[0].index !== undefined) {
                if (currentIdx <= profile[0].index) {
                    groundElevFt = profile[0].elevFt;
                } else if (currentIdx >= profile[profile.length - 1].index) {
                    groundElevFt = profile[profile.length - 1].elevFt;
                } else {
                    for (let i = 0; i < profile.length - 1; i++) {
                        const p1 = profile[i];
                        const p2 = profile[i + 1];
                        if (currentIdx >= p1.index && currentIdx <= p2.index) {
                            const ratio = (currentIdx - p1.index) / (p2.index - p1.index);
                            groundElevFt = p1.elevFt + ratio * (p2.elevFt - p1.elevFt);
                            break;
                        }
                    }
                }
            }
            
            // 2. If index-based is unavailable, try spatial coordinate lookup
            if (groundElevFt === null && profile[0].lat !== undefined) {
                let minD2 = Infinity;
                let closestIdx = 0;
                for (let i = 0; i < profile.length; i++) {
                    const pt = profile[i];
                    const d2 = Math.pow(pt.lat - currentPos.lat, 2) + Math.pow(pt.lng - currentPos.lng, 2);
                    if (d2 < minD2) {
                        minD2 = d2;
                        closestIdx = i;
                    }
                }
                groundElevFt = profile[closestIdx].elevFt;
            }
            
            if (groundElevFt === null && track.tactics && track.tactics.grToGoalSeries && track.tactics.grToGoalSeries.length > 0) {
                let lookupIdx = currentIdx;
                if (lookupIdx >= track.tactics.grToGoalSeries.length) {
                    lookupIdx = track.tactics.grToGoalSeries.length - 1;
                }
                const s = track.tactics.grToGoalSeries[lookupIdx];
                const distFlown = s.distFlown !== undefined ? s.distFlown : 0;
                if (distFlown <= profile[0].distKm) {
                    groundElevFt = profile[0].elevFt;
                } else if (distFlown >= profile[profile.length - 1].distKm) {
                    groundElevFt = profile[profile.length - 1].elevFt;
                } else {
                    for (let i = 0; i < profile.length - 1; i++) {
                        const p1 = profile[i];
                        const p2 = profile[i + 1];
                        if (distFlown >= p1.distKm && distFlown <= p2.distKm) {
                            const ratio = (distFlown - p1.distKm) / (p2.distKm - p1.distKm);
                            groundElevFt = p1.elevFt + ratio * (p2.elevFt - p1.elevFt);
                            break;
                        }
                    }
                }
            }
            
            if (groundElevFt !== null) {
                const aglFt = Math.max(0, altFt - groundElevFt);
                aglStr = ` (${Math.round(aglFt)})`;
            }
        }
        altEl.textContent = `${Math.round(altFt)}${aglStr}`;
    }
    
    if (prevPos && prevPos.time < currentPos.time && spdEl && grEl) {
        const dt = currentPos.time - prevPos.time; // seconds
        const dDist = haversineDistance(prevPos, currentPos); // km
        const dAlt = currentPos.alt - prevPos.alt; // meters
        
        // Speed in km/h
        const speed = (dDist / dt) * 3600;
        track.currentSpeed = speed;
        spdEl.textContent = `${Math.round(speed)}`;
        
        // 1. Instantaneous Glide Ratio (always goes into the standard GR column)
        let instGR = 0;
        let instGRStr = '--';
        if (dAlt < -0.1) {
            instGR = (dDist * 1000) / Math.abs(dAlt);
            instGRStr = instGR > 100 ? '99+' : instGR.toFixed(1);
        } else if (dAlt > 0.1) {
            instGRStr = 'Climb';
        } else {
            instGRStr = 'Level';
        }
        track.currentInstGR = instGR;
        grEl.textContent = instGRStr;
    } else {
        if (spdEl) spdEl.textContent = '--';
        if (grEl) grEl.textContent = '--';
    }

    // 2. GR to Goal (goes into the new GR to Goal column if task is available)
    const grGoalEl = document.getElementById(`grgoal-${track.id}`);
    if (track.tactics && track.tactics.grToGoalSeries && track.tactics.grToGoalSeries.length > 0) {
        let idx = track.currentPosIndex || 0;
        if (idx >= track.tactics.grToGoalSeries.length) {
            idx = track.tactics.grToGoalSeries.length - 1;
        }
        
        const grGoal = track.tactics.grToGoalSeries[idx].gr;
        const distGoal = track.tactics.grToGoalSeries[idx].distToGoal;
        
        track.currentDistToGoal = distGoal;
        track.currentGRGoal = grGoal;
        
        if (distEl) distEl.textContent = (distGoal !== null && distGoal !== undefined) ? (distGoal <= 0.0 ? 'Goal' : distGoal.toFixed(1)) : '--';
        if (grGoalEl) {
            if (distGoal <= 0.0) {
                grGoalEl.textContent = 'Goal';
            } else {
                grGoalEl.textContent = (grGoal !== null && grGoal !== undefined) ? (grGoal > 100 ? '99+' : grGoal.toFixed(1)) : '--';
            }
        }
    } else {
        track.currentDistToGoal = Infinity;
        track.currentGRGoal = Infinity;
        if (distEl) distEl.textContent = '--';
        if (grGoalEl) grGoalEl.textContent = '--';
    }
}

// --- LocalStorage Persistence ---

function saveWaypointsToStorage() {
    try {
        localStorage.setItem('pg-waypoints', JSON.stringify(state.waypoints));
    } catch (e) {
        console.warn('Could not save waypoints to localStorage:', e);
    }
}

// --- LocalStorage & IndexedDB Persistence ---

const DB_NAME = 'PGRaceAnalyzerDB';
const DB_VERSION = 4;
const STORE_NAME = 'tracks';
const DEM_STORE = 'dem_cache';

function getDB() {
    return new Promise((resolve, reject) => {
        try {
            if (!window.indexedDB) {
                reject(new Error("IndexedDB is not supported"));
                return;
            }
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'name' });
                }
                if (!db.objectStoreNames.contains(DEM_STORE)) {
                    db.createObjectStore(DEM_STORE);
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        } catch (err) {
            reject(err);
        }
    });
}

async function getCachedElevations(coords) {
    try {
        const db = await getDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(DEM_STORE, 'readonly');
            const store = tx.objectStore(DEM_STORE);
            const results = [];
            
            let completed = 0;
            if (coords.length === 0) {
                resolve([]);
                return;
            }
            
            for (let i = 0; i < coords.length; i++) {
                const c = coords[i];
                const key = `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;
                const req = store.get(key);
                req.onsuccess = (e) => {
                    results[i] = e.target.result !== undefined ? e.target.result : null;
                    completed++;
                    if (completed === coords.length) {
                        resolve(results);
                    }
                };
                req.onerror = (e) => {
                    results[i] = null;
                    completed++;
                    if (completed === coords.length) {
                        resolve(results);
                    }
                };
            }
        });
    } catch (e) {
        console.warn('Failed to read DEM cache from IndexedDB:', e);
        return coords.map(() => null);
    }
}

async function saveElevationsToCache(coords, elevations) {
    try {
        const db = await getDB();
        const tx = db.transaction(DEM_STORE, 'readwrite');
        const store = tx.objectStore(DEM_STORE);
        for (let i = 0; i < coords.length; i++) {
            const key = `${coords[i].lat.toFixed(4)},${coords[i].lng.toFixed(4)}`;
            if (elevations[i] !== null && elevations[i] !== undefined) {
                store.put(elevations[i], key);
            }
        }
    } catch (e) {
        console.warn('Failed to save DEM cache to IndexedDB:', e);
    }
}

async function saveTracksToStorage() {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        
        // Queue clear and puts synchronously to avoid TransactionInactiveError
        store.clear();
        for (const t of state.tracks) {
            const data = { 
                name: t.rawName || t.name, 
                rawName: t.rawName || t.name, 
                points: t.points,
                terrainProfile: t.terrainProfile 
            };
            store.put(data);
        }
        
        // Wait for the transaction to complete
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(tx.error || e.target.error);
            tx.onabort = (e) => reject(tx.error || e.target.error);
        });
        
        console.log(`Saved ${state.tracks.length} tracks to IndexedDB`);
        
        // Clean up legacy localStorage item if exists
        localStorage.removeItem('pg-tracks');
    } catch (e) {
        console.warn('Could not save tracks to IndexedDB:', e);
    }
}

async function saveSingleTrackToStorage(t) {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const data = { 
            name: t.rawName || t.name, 
            rawName: t.rawName || t.name, 
            points: t.points,
            terrainProfile: t.terrainProfile 
        };
        store.put(data);
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(tx.error || e.target.error);
            tx.onabort = (e) => reject(tx.error || e.target.error);
        });
    } catch (e) {
        console.warn(`Could not save single track ${t.name} to IndexedDB:`, e);
    }
}

function saveTaskToStorage() {
    try {
        const text = document.getElementById('task-textarea').value;
        if (text) {
            localStorage.setItem('pg-task-text', text);
        } else {
            localStorage.removeItem('pg-task-text');
        }
    } catch (e) {
        console.warn('Could not save task to localStorage:', e);
    }
}

async function getTracksFromStorage() {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        return new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        console.warn('Could not read tracks from IndexedDB:', e);
        return [];
    }
}

async function restoreFromStorage() {
    // 1. Restore waypoints
    try {
        const wptStr = localStorage.getItem('pg-waypoints');
        if (wptStr) {
            state.waypoints = JSON.parse(wptStr);
            const count = Object.keys(state.waypoints).length;
            if (count > 0) {
                console.log(`Restored ${count} waypoints from storage`);
                const label = document.querySelector('label[for="wpt-upload"]');
                if (label) {
                    for (let node of label.childNodes) {
                        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) {
                            node.textContent = ` ${count} WPTs (cached) `;
                            break;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.warn('Could not restore waypoints:', e);
    }

    // 2. Restore task text (set UI textarea)
    try {
        const taskText = localStorage.getItem('pg-task-text');
        if (taskText) {
            document.getElementById('task-textarea').value = taskText;
        }
    } catch (e) {
        console.warn('Could not restore task text:', e);
    }

    // 3. Restore tracks from IndexedDB (fallback to legacy localStorage)
    let tracks = [];
    try {
        tracks = await getTracksFromStorage();
        if (!tracks || tracks.length === 0) {
            const legacyTracksStr = localStorage.getItem('pg-tracks');
            if (legacyTracksStr) {
                try {
                    tracks = JSON.parse(legacyTracksStr);
                } catch(err) {}
            }
        }
    } catch (e) {
        console.warn('Could not restore tracks:', e);
    }
    
    const loader = document.getElementById('track-loader');
    const fill = document.getElementById('loader-bar-fill');
    const text = document.getElementById('track-loader-text');
    
    try {
        if (tracks && tracks.length > 0) {
            if (loader) loader.classList.remove('hidden');
            
            for (let i = 0; i < tracks.length; i++) {
                const t = tracks[i];
                if (!t || !t.points || t.points.length === 0) continue;
                
                if (text) text.textContent = `Restoring ${t.name || 'track'}...`;
                if (fill) fill.style.width = `${(i / tracks.length) * 100}%`;
                
                // Yield thread to let browser repaint DOM and animate progress
                await new Promise(resolve => setTimeout(resolve, 50));
                
                addTrackToState(t.rawName || t.name, t.points, t.terrainProfile);
            }
            
            if (fill) fill.style.width = '100%';
            if (text) text.textContent = 'Tracks loaded!';
            
            await new Promise(resolve => setTimeout(resolve, 150));
            console.log(`Restored ${tracks.length} tracks`);
            onAllFilesLoaded();
        }
    } catch (e) {
        console.warn('Could not load restored tracks:', e);
    } finally {
        if (loader) loader.classList.add('hidden');
    }

    // 4. Auto-draw task if waypoints and task text exist
    try {
        const taskText = localStorage.getItem('pg-task-text') || document.getElementById('task-textarea').value;
        if (taskText && Object.keys(state.waypoints).length > 0) {
            drawTask();
        }
    } catch (e) {
        console.warn('Could not auto-draw task:', e);
    }
}

function exportStatsToXLSX() {
    if (state.tracks.length === 0) {
        alert("No pilot tracks loaded to export.");
        return;
    }
    
    recomputeSpeedSectionTimes();
    
    const headers = [
        "Pilot Name",
        "FG Dist (km)",
        "FG GR",
        "ESS Alt AGL (ft)",
        "ESS GR",
        "ESS Time",
        "Max Spd (10s avg, km/h)"
    ];
    
    const rows = [];
    
    state.tracks.forEach(t => {
        let fgDistStr = '--';
        let fgGrStr = '--';
        let essAltStr = '--';
        let essGrStr = '--';
        let maxSpdStr = '--';
        let essTimeStr = '--:--:--';
        
        if (t.tactics) {
            if (t.tactics.finalGlideStartTime !== null && t.tactics.finalGlideStartTime !== undefined) {
                const fd = t.tactics.finalGlideDistToGoal;
                const fg = t.tactics.finalGlideGrToGoal;
                fgDistStr = (fd !== null && fd !== undefined) ? fd.toFixed(1) : '--';
                fgGrStr = (fg !== null && fg !== undefined) ? (fg > 100 ? '99+' : fg.toFixed(1)) : '--';
            }
            if (t.tactics.essCrossTime !== null && t.tactics.essCrossTime !== undefined) {
                const essTP = state.task.find(wpt => wpt.type === 'es');
                const goalTP = state.task.find(wpt => wpt.type === 'goal') || state.task[state.task.length - 1];
                const refElev = essTP ? essTP.elev : (goalTP ? goalTP.elev : 0);
                const essAglFt = (t.tactics.essCrossAlt - refElev) * 3.28084;
                essAltStr = Math.round(essAglFt).toString();
                const essNeeded = t.tactics.essGrNeededToGoal;
                essGrStr = (essNeeded !== null && essNeeded !== undefined) ? (essNeeded > 100 ? '99+' : essNeeded.toFixed(1)) : '--';
                if (t.tactics.speedSectionTime !== null && t.tactics.speedSectionTime !== undefined) {
                    essTimeStr = formatTime(t.tactics.speedSectionTime);
                }
            }
            if (t.tactics.maxSpeed10Sec !== undefined && t.tactics.maxSpeed10Sec !== null) {
                maxSpdStr = Math.round(t.tactics.maxSpeed10Sec).toString();
            }
        }
        
        const parseExcelVal = (val) => {
            if (val === '--') return '';
            if (val === '99+') return '99+';
            const num = parseFloat(val);
            return isNaN(num) ? val : num;
        };
        
        rows.push({
            "Pilot Name": t.fullName || t.name,
            "FG Dist (km)": parseExcelVal(fgDistStr),
            "FG GR": parseExcelVal(fgGrStr),
            "ESS Alt AGL (ft)": parseExcelVal(essAltStr),
            "ESS GR": parseExcelVal(essGrStr),
            "ESS Time": essTimeStr === '--:--:--' ? '' : essTimeStr,
            "Max Spd (10s avg, km/h)": parseExcelVal(maxSpdStr)
        });
    });
    
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Standings");
    
    // Auto-fit columns
    const max_len = headers.map(h => h.length);
    rows.forEach(r => {
        headers.forEach((h, i) => {
            const val = r[h];
            if (val !== undefined && val !== null) {
                max_len[i] = Math.max(max_len[i], val.toString().length);
            }
        });
    });
    worksheet["!cols"] = max_len.map(l => ({ wch: l + 3 }));
    
    const filename = `race_statistics_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(workbook, filename);
}

let statsChart = null;
let leadPointsChart = null;

function getXValue(track, type) {
    if (!track.tactics) return null;
    if (type === 'fgDist') {
        return track.tactics.finalGlideDistToGoal;
    }
    if (type === 'fgGr') {
        return track.tactics.finalGlideGrToGoal;
    }
    if (type === 'essAlt') {
        if (track.tactics.essCrossTime === null || track.tactics.essCrossAlt === null) return null;
        const essTP = state.task.find(wpt => wpt.type === 'es');
        const goalTP = state.task.find(wpt => wpt.type === 'goal') || state.task[state.task.length - 1];
        const refElev = essTP ? essTP.elev : (goalTP ? goalTP.elev : 0);
        return (track.tactics.essCrossAlt - refElev) * 3.28084;
    }
    if (type === 'essGr') {
        return track.tactics.essGrNeededToGoal;
    }
    if (type === 'maxSpeed') {
        return track.tactics.maxSpeed10Sec;
    }
    return null;
}

function calculatePearsonCorrelation(X, Y) {
    const n = X.length;
    if (n < 2) return 0;
    let sumX = 0, sumY = 0, sumXY = 0;
    let sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += X[i];
        sumY += Y[i];
        sumXY += X[i] * Y[i];
        sumX2 += X[i] * X[i];
        sumY2 += Y[i] * Y[i];
    }
    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    if (den === 0) return 0;
    return num / den;
}

function solveLinearRegression(X, Y) {
    const n = X.length;
    if (n < 2) return { m: 0, c: 0 };
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += X[i];
        sumY += Y[i];
        sumXY += X[i] * Y[i];
        sumX2 += X[i] * X[i];
    }
    const den = n * sumX2 - sumX * sumX;
    if (den === 0) return { m: 0, c: 0 };
    const m = (n * sumXY - sumX * sumY) / den;
    const c = (sumY - m * sumX) / n;
    return { m, c };
}

function solveQuadraticRegression(X, Y) {
    const n = X.length;
    if (n < 3) return null;
    
    let s_x = 0, s_x2 = 0, s_x3 = 0, s_x4 = 0;
    let s_y = 0, s_xy = 0, s_x2y = 0;
    
    for (let i = 0; i < n; i++) {
        const x = X[i];
        const y = Y[i];
        const x2 = x * x;
        s_x += x;
        s_x2 += x2;
        s_x3 += x2 * x;
        s_x4 += x2 * x2;
        s_y += y;
        s_xy += x * y;
        s_x2y += x2 * y;
    }
    
    const m00 = s_x4, m01 = s_x3, m02 = s_x2, d0 = s_x2y;
    const m10 = s_x3, m11 = s_x2, m12 = s_x,  d1 = s_xy;
    const m20 = s_x2, m21 = s_x,  m22 = n,    d2 = s_y;
    
    const det = m00*(m11*m22 - m12*m21) - m01*(m10*m22 - m12*m20) + m02*(m10*m21 - m11*m20);
    if (det === 0) return null;
    
    const det_a = d0*(m11*m22 - m12*m21) - m01*(d1*m22 - m12*d2) + m02*(d1*m21 - m11*d2);
    const det_b = m00*(d1*m22 - m12*d2) - d0*(m10*m22 - m12*m20) + m02*(m10*d2 - d1*m20);
    const det_c = m00*(m11*d2 - d1*m21) - m01*(m10*d2 - d1*m20) + d0*(m10*m21 - m11*m20);
    
    const a = det_a / det;
    const b = det_b / det;
    const c = det_c / det;
    
    return { a, b, c };
}

function highlightPilot(track) {
    const detailsRow = document.getElementById(`details-${track.id}`);
    const row = document.getElementById(`row-${track.id}`);
    if (detailsRow && row) {
        detailsRow.style.display = 'table-row';
        row.classList.add('expanded');
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        row.style.transition = 'background-color 0.3s';
        row.style.backgroundColor = 'rgba(99, 102, 241, 0.3)'; // Indigo accent
        setTimeout(() => {
            row.style.backgroundColor = '';
        }, 1500);
    }
    
    if (track.marker && state.map) {
        const points = track.points;
        const currentIdx = track.currentPosIndex !== undefined ? track.currentPosIndex : 0;
        const pt = points[currentIdx];
        if (pt) {
            state.map.setView([pt.lat, pt.lng], state.map.getZoom(), { animate: true });
        }
        track.marker.openTooltip();
    }
}

function updateStatsAnalysis() {
    const xStatSelect = document.getElementById('chart-x-select');
    const fitSelect = document.getElementById('chart-fit-select');
    if (!xStatSelect || !fitSelect) return;
    
    const xStat = xStatSelect.value;
    const fitType = fitSelect.value;
    const xLabel = xStatSelect.selectedOptions[0].text;
    
    const dataPoints = [];
    state.tracks.forEach(track => {
        if (track.visible !== false && track.tactics && track.tactics.speedSectionTime !== null && track.tactics.speedSectionTime !== undefined) {
            const xVal = getXValue(track, xStat);
            if (xVal !== null && xVal !== undefined && !isNaN(xVal)) {
                dataPoints.push({
                    x: xVal,
                    y: track.tactics.speedSectionTime,
                    pilot: track
                });
            }
        }
    });

    const coefEl = document.getElementById('stats-correlation-coef');
    const descEl = document.getElementById('stats-correlation-desc');
    const optimalCard = document.getElementById('optimal-insight-card');
    const optimalText = document.getElementById('optimal-insight-text');
    const tableBody = document.getElementById('correlations-table-body');
    
    // Pearson correlation table update
    if (tableBody) {
        const statsToCompare = [
            { key: 'fgDist', label: 'FG Dist (km)' },
            { key: 'fgGr', label: 'FG GR' },
            { key: 'essAlt', label: 'ESS Alt AGL (ft)' },
            { key: 'essGr', label: 'ESS GR' },
            { key: 'maxSpeed', label: 'Max Speed (km/h)' }
        ];
        
        let tableHtml = '';
        statsToCompare.forEach(stat => {
            const tempPoints = [];
            state.tracks.forEach(track => {
                if (track.visible !== false && track.tactics && track.tactics.speedSectionTime !== null && track.tactics.speedSectionTime !== undefined) {
                    const xVal = getXValue(track, stat.key);
                    if (xVal !== null && xVal !== undefined && !isNaN(xVal)) {
                        tempPoints.push({ x: xVal, y: track.tactics.speedSectionTime });
                    }
                }
            });
            
            if (tempPoints.length >= 2) {
                const tempX = tempPoints.map(p => p.x);
                const tempY = tempPoints.map(p => p.y);
                const tempR = calculatePearsonCorrelation(tempX, tempY);
                const absR = Math.abs(tempR);
                
                let badgeClass = 'strength-weak';
                let strengthStr = 'Weak';
                if (absR >= 0.7) {
                    badgeClass = 'strength-strong';
                    strengthStr = 'Strong';
                } else if (absR >= 0.4) {
                    badgeClass = 'strength-moderate';
                    strengthStr = 'Moderate';
                }
                
                const dirStr = tempR < 0 ? ' (Neg)' : ' (Pos)';
                
                tableHtml += `
                    <tr>
                        <td>${stat.label}</td>
                        <td class="coef-val" style="color: ${tempR < 0 ? '#4ade80' : '#f87171'}">${tempR.toFixed(2)}</td>
                        <td><span class="strength-badge ${badgeClass}">${strengthStr}${dirStr}</span></td>
                    </tr>
                `;
            } else {
                tableHtml += `
                    <tr>
                        <td>${stat.label}</td>
                        <td class="coef-val">--</td>
                        <td><span class="strength-badge strength-weak">N/A</span></td>
                    </tr>
                `;
            }
        });
        tableBody.innerHTML = tableHtml;
    }

    if (dataPoints.length < 2) {
        if (coefEl) coefEl.textContent = 'r = --';
        if (descEl) descEl.textContent = 'Needs at least 2 pilots with completed speed runs.';
        if (optimalCard) optimalCard.classList.add('hidden');
        if (statsChart) {
            statsChart.destroy();
            statsChart = null;
        }
        return;
    }
    
    const X = dataPoints.map(p => p.x);
    const Y = dataPoints.map(p => p.y);
    const r = calculatePearsonCorrelation(X, Y);
    const absR = Math.abs(r);
    
    if (coefEl) coefEl.textContent = `r = ${r.toFixed(2)}`;
    
    let strengthDesc = '';
    if (absR >= 0.7) strengthDesc = 'Strong';
    else if (absR >= 0.4) strengthDesc = 'Moderate';
    else if (absR >= 0.1) strengthDesc = 'Weak';
    else strengthDesc = 'Very Weak/No';
    
    let directionDesc = '';
    if (r < -0.1) {
        directionDesc = `Negative Correlation (higher ${xLabel} correlates with faster/shorter ESS Time)`;
    } else if (r > 0.1) {
        directionDesc = `Positive Correlation (higher ${xLabel} correlates with slower/longer ESS Time)`;
    } else {
        directionDesc = `No linear directional trend with ESS Time`;
    }
    
    if (descEl) descEl.textContent = `${strengthDesc} ${directionDesc}`;
    
    dataPoints.sort((a, b) => a.x - b.x);
    const minX = dataPoints[0].x;
    const maxX = dataPoints[dataPoints.length - 1].x;
    const pad = (maxX - minX) * 0.05 || 1.0;
    
    const trendlinePoints = [];
    let showOptimal = false;
    let optimalValText = '';
    
    if (fitType === 'linear') {
        const { m, c } = solveLinearRegression(X, Y);
        const steps = 10;
        for (let i = 0; i <= steps; i++) {
            const x = minX + (maxX - minX) * (i / steps);
            trendlinePoints.push({ x: x, y: m * x + c });
        }
    } else if (fitType === 'quadratic' && dataPoints.length >= 3) {
        const quad = solveQuadraticRegression(X, Y);
        if (quad) {
            const { a, b, c } = quad;
            const steps = 50;
            for (let i = 0; i <= steps; i++) {
                const x = (minX - pad) + (maxX - minX + 2*pad) * (i / steps);
                trendlinePoints.push({ x: x, y: a * x * x + b * x + c });
            }
            
            if (a > 0) {
                const x_opt = -b / (2 * a);
                if (x_opt >= minX - pad && x_opt <= maxX + pad) {
                    showOptimal = true;
                    const y_opt = a * x_opt * x_opt + b * x_opt + c;
                    optimalValText = `Based on a quadratic curve fit, the optimal <strong>${xLabel}</strong> for minimum ESS Time is approximately <strong>${x_opt.toFixed(2)}</strong>, corresponding to an expected ESS Time of <strong>${formatTime(y_opt)}</strong>.`;
                }
            }
        }
    }
    
    if (optimalCard && optimalText) {
        if (showOptimal) {
            optimalCard.classList.remove('hidden');
            optimalText.innerHTML = optimalValText;
        } else {
            optimalCard.classList.add('hidden');
        }
    }
    
    const ctx = document.getElementById('stats-chart').getContext('2d');
    
    const scatterData = dataPoints.map(p => ({
        x: p.x,
        y: p.y,
        pilotName: p.pilot.fullName || p.pilot.name,
        pilotId: p.pilot.id
    }));
    
    const pointColors = dataPoints.map(p => resolveColor(p.pilot.color));
    
    const chartData = {
        datasets: [
            {
                label: 'Pilots',
                data: scatterData,
                backgroundColor: pointColors,
                borderColor: '#ffffff',
                pointRadius: 3.5,
                pointHoverRadius: 5.5,
                showLine: false
            }
        ]
    };
    
    if (trendlinePoints.length > 0) {
        chartData.datasets.push({
            label: fitType === 'linear' ? 'Linear Fit' : 'Quadratic Fit',
            data: trendlinePoints,
            borderColor: fitType === 'linear' ? 'rgba(99, 102, 241, 0.7)' : 'rgba(234, 179, 8, 0.7)',
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            showLine: true
        });
    }
    
    if (statsChart) {
        statsChart.data = chartData;
        statsChart.options.scales.x.title.text = xLabel;
        statsChart.update();
    } else {
        statsChart = new Chart(ctx, {
            type: 'scatter',
            data: chartData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                if (context.datasetIndex === 0) {
                                    const raw = context.raw;
                                    const xTitle = context.chart.options.scales.x.title.text;
                                    let xValStr = '';
                                    if (xTitle.includes('Alt') || xTitle.includes('Speed')) {
                                        xValStr = Math.round(raw.x).toString();
                                    } else if (xTitle.includes('GR')) {
                                        xValStr = raw.x > 100 ? '99+' : raw.x.toFixed(1);
                                    } else {
                                        xValStr = raw.x.toFixed(1);
                                    }
                                    return `${raw.pilotName}: ${xTitle} = ${xValStr}, ESS Time = ${formatTime(raw.y)}`;
                                }
                                return null;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        position: 'bottom',
                        title: {
                            display: true,
                            text: xLabel,
                            color: '#e2e8f0'
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)'
                        },
                        ticks: {
                            color: '#94a3b8'
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'ESS Time (HH:MM:SS)',
                            color: '#e2e8f0'
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)'
                        },
                        ticks: {
                            color: '#94a3b8',
                            callback: function(value) {
                                return formatTime(value);
                            }
                        }
                    }
                },
                onClick: (event, activeElements) => {
                    if (activeElements.length > 0) {
                        const datasetIndex = activeElements[0].datasetIndex;
                        if (datasetIndex === 0) { // Scatter dataset
                            const elementIndex = activeElements[0].index;
                            if (statsChart && statsChart.data.datasets[0].data[elementIndex]) {
                                const rawPoint = statsChart.data.datasets[0].data[elementIndex];
                                const pilot = state.tracks.find(t => t.id === rawPoint.pilotId);
                                if (pilot) {
                                    highlightPilot(pilot);
                                }
                            }
                        }
                    }
                }
            }
        });
    }
}

function updateLeadingPointsChart() {
    const canvas = document.getElementById('lead-points-chart');
    if (!canvas) return;

    if (!state.task || state.task.length === 0 || !state.tracks || state.tracks.length === 0) {
        if (leadPointsChart) {
            leadPointsChart.destroy();
            leadPointsChart = null;
        }
        return;
    }

    // Determine speed section parameters
    let speedSectionDist = 0;
    let minSSCrossTime = Infinity;
    let lastEssTime = 0;
    let lastOutlandingTime = 0;

    state.tracks.forEach(t => {
        if (t.tactics) {
            if (t.tactics.speedSectionDist > speedSectionDist) {
                speedSectionDist = t.tactics.speedSectionDist;
            }
            if (t.tactics.essCrossTime) {
                if (t.tactics.essCrossTime > lastEssTime) lastEssTime = t.tactics.essCrossTime;
            } else if (t.points && t.points.length > 0) {
                const lastPtTime = t.points[t.points.length - 1].time;
                if (lastPtTime > lastOutlandingTime) lastOutlandingTime = lastPtTime;
            }
            if (t.tactics.ssCrossTime !== null && t.tactics.ssCrossTime < minSSCrossTime) {
                minSSCrossTime = t.tactics.ssCrossTime;
            }
        }
    });

    if (speedSectionDist <= 0) return;

    const firstStartTime = state.startGateTime !== null ? state.startGateTime : (minSSCrossTime !== Infinity ? minSSCrossTime : 0);
    const taskDeadline = state.deadlineTime || Infinity;
    const maxTime = Math.max(0, Math.min(Math.max(lastOutlandingTime, lastEssTime), taskDeadline) - firstStartTime);

    // 1. Pre-calculate cumulative leading areas for each track
    state.tracks.forEach(track => {
        if (track.visible === false || !track.tactics || !track.tactics.ss_trackpoints || track.tactics.ss_trackpoints.length === 0) {
            return;
        }

        const ssPts = track.tactics.ss_trackpoints;
        let minDistSoFarPrev = ssPts[0].minDistToEss;
        let cumLeadingArea = 0;
        let cumWeight = 0;

        ssPts[0].cumLeadingArea = 0;
        ssPts[0].cumWeight = 0;
        ssPts[0].distFlown = Math.max(0, speedSectionDist - ssPts[0].minDistToEss);

        for (let i = 1; i < ssPts.length; i++) {
            const currPt = ssPts[i];
            const minToEssCurr = currPt.minDistToEss;
            
            const donePrev = 1.0 - (minDistSoFarPrev / speedSectionDist);
            const doneCurr = 1.0 - (minToEssCurr / speedSectionDist);
            const weight = integratePgWeightCurve(donePrev, doneCurr);
            
            const taskTime = Math.max(0, Math.min(currPt.time, taskDeadline) - firstStartTime);
            cumLeadingArea += taskTime * weight;
            cumWeight += weight;
            
            currPt.cumLeadingArea = cumLeadingArea;
            currPt.cumWeight = cumWeight;
            currPt.distFlown = Math.max(0, speedSectionDist - minToEssCurr);
            
            minDistSoFarPrev = minToEssCurr;
        }
    });

    // Determine X-axis mode
    const isTimeMode = document.querySelector('input[name="lead-chart-xaxis"]:checked')?.value === 'time';
    const resMeters = state.chartResolution || 500;
    const datasets = [];

    // Ensure final leading points are computed
    const availableLeadPoints = 162.5;
    calculateLeadingPoints(
        state.tracks,
        availableLeadPoints,
        speedSectionDist,
        taskDeadline,
        firstStartTime,
        lastOutlandingTime,
        lastEssTime
    );

    let steps = [];
    let xMax = 0;

    if (isTimeMode) {
        // Time Mode: steps in seconds, resolution scales: 500 -> 300s, 50 -> 30s, etc.
        const stepSec = resMeters * 0.6;
        const maxTimeSeconds = maxTime;
        let currentT = 0;
        while (currentT < maxTimeSeconds) {
            steps.push(currentT);
            currentT += stepSec;
        }
        if (steps.length === 0 || steps[steps.length - 1] < maxTimeSeconds) {
            steps.push(maxTimeSeconds);
        }
        xMax = maxTimeSeconds / 60.0; // minutes
    } else {
        // Distance Mode: steps in km, resolution scales: 500 -> 0.5km
        const stepKm = resMeters / 1000.0;
        let currentX = 0;
        while (currentX < speedSectionDist) {
            steps.push(currentX);
            currentX += stepKm;
        }
        if (steps.length === 0 || steps[steps.length - 1] < speedSectionDist) {
            steps.push(speedSectionDist);
        }
        xMax = speedSectionDist;
    }

    state.tracks.forEach(track => {
        if (track.visible === false || !track.tactics || !track.tactics.ss_trackpoints || track.tactics.ss_trackpoints.length === 0) {
            return;
        }

        const ssPts = track.tactics.ss_trackpoints;
        const distFlownFinal = ssPts[ssPts.length - 1].distFlown;
        const finalLeadPts = track.tactics.finalLeadingPoints || 0;
        const totalFlightWeight = integratePgWeightCurve(0, distFlownFinal / speedSectionDist);

        const linePoints = [];

        if (isTimeMode) {
            // Calculate points accumulated at each time step T (in seconds)
            steps.forEach(T => {
                let currentLeadWeight = 0;
                let minDistSoFarPrev = ssPts[0].minDistToEss;

                for (let i = 1; i < ssPts.length; i++) {
                    const currPt = ssPts[i];
                    const minToEssCurr = currPt.minDistToEss;
                    
                    const donePrev = 1.0 - (minDistSoFarPrev / speedSectionDist);
                    const doneCurr = 1.0 - (minToEssCurr / speedSectionDist);
                    const weight = integratePgWeightCurve(donePrev, doneCurr);
                    
                    if (currPt.time - firstStartTime <= T) {
                        currentLeadWeight += weight;
                    } else {
                        break;
                    }
                    
                    minDistSoFarPrev = minToEssCurr;
                }

                const ratio = totalFlightWeight > 0 ? currentLeadWeight / totalFlightWeight : 0;
                const pts = finalLeadPts * ratio;

                linePoints.push({
                    x: T / 60.0, // X axis in minutes
                    y: parseFloat(pts.toFixed(1))
                });
            });
        } else {
            // Distance mode X is in km
            steps.forEach(X => {
                let pts = 0;
                if (X <= distFlownFinal) {
                    const cumWeight = integratePgWeightCurve(0, X / speedSectionDist);
                    const ratio = totalFlightWeight > 0 ? cumWeight / totalFlightWeight : 0;
                    pts = finalLeadPts * ratio;
                } else {
                    pts = finalLeadPts;
                }
                linePoints.push({
                    x: X,
                    y: parseFloat(pts.toFixed(1))
                });
            });
        }

        const resolvedColor = resolveColor(track.color);
        datasets.push({
            label: track.fullName || track.name,
            data: linePoints,
            borderColor: resolvedColor,
            backgroundColor: resolvedColor + '22',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            fill: false,
            tension: 0.1
        });
    });

    const ctx = canvas.getContext('2d');
    const chartData = { datasets };

    if (leadPointsChart) {
        leadPointsChart.data = chartData;
        leadPointsChart.options.scales.x.max = xMax;
        leadPointsChart.options.scales.x.title.text = isTimeMode ? 'Elapsed Time along SS (min)' : 'Distance Flown along SS (km)';
        
        // Update tooltip callback for the correct units
        leadPointsChart.options.plugins.tooltip.callbacks.title = function(context) {
            if (context.length > 0) {
                return isTimeMode 
                    ? `Time along SS: ${context[0].raw.x.toFixed(1)} min`
                    : `Distance Flown: ${context[0].raw.x.toFixed(1)} km`;
            }
            return '';
        };

        leadPointsChart.update();
    } else {
        leadPointsChart = new Chart(ctx, {
            type: 'line',
            data: chartData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: '#e2e8f0',
                            font: {
                                size: 10
                            },
                            boxWidth: 12
                        }
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            title: function(context) {
                                if (context.length > 0) {
                                    return isTimeMode 
                                        ? `Time along SS: ${context[0].raw.x.toFixed(1)} min`
                                        : `Distance Flown: ${context[0].raw.x.toFixed(1)} km`;
                                }
                                return '';
                            },
                            label: function(context) {
                                return `${context.dataset.label}: ${context.raw.y.toFixed(1)} pts`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        position: 'bottom',
                        title: {
                            display: true,
                            text: isTimeMode ? 'Elapsed Time along SS (min)' : 'Distance Flown along SS (km)',
                            color: '#e2e8f0'
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)'
                        },
                        ticks: {
                            color: '#94a3b8'
                        },
                        min: 0,
                        max: xMax
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Accumulated Leading Points',
                            color: '#e2e8f0'
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)'
                        },
                        ticks: {
                            color: '#94a3b8'
                        },
                        min: 0
                    }
                }
            }
        });
    }
}

/**
 * Calculates 10-second centered vertical speed (climb/sink rate in m/s)
 * for each trackpoint lazily when the Lift/Sink overlay is activated.
 */
function lazyComputeClimbRates(track) {
    if (track.hasClimbRates) return;
    const pts = track.points;
    const n = pts.length;
    if (n === 0) return;
    
    let j = 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
        const t = pts[i].time;
        
        // Find left boundary j (time >= t - 5)
        while (j < i && pts[j].time < t - 5) {
            j++;
        }
        // Find right boundary k (time <= t + 5)
        while (k < n - 1 && pts[k + 1].time <= t + 5) {
            k++;
        }
        
        const dt = pts[k].time - pts[j].time;
        if (dt > 0) {
            pts[i].climbRate = (pts[k].alt - pts[j].alt) / dt;
        } else {
            pts[i].climbRate = 0;
        }
    }
    track.hasClimbRates = true;
    console.log(`Lazily computed climb rates for ${track.fullName}`);
}

/**
 * Renders the Lift/Sink Map overlay.
 * Uses raw tracks (emerald green/rose red/amber yellow polylines)
 * or spatial grid averages based on user settings and current playback time.
 */
function updateLiftSinkOverlay() {
    if (!state.liftSinkLayerGroup) return;
    state.liftSinkLayerGroup.clearLayers();
    
    const mapEl = document.getElementById('map');
    if (mapEl) {
        mapEl.classList.toggle('liftsink-active', state.liftSinkEnabled);
    }
    
    if (!state.liftSinkEnabled || state.tracks.length === 0) {
        return;
    }
    
    // Ensure climb rates are calculated lazily on demand
    state.tracks.forEach(track => {
        if (track.visible !== false && !track.hasClimbRates) {
            lazyComputeClimbRates(track);
        }
    });
    
    const tMax = state.currentTime;
    const tMin = state.currentTime - state.liftSinkWindow;
    
    if (state.liftSinkMode === 'raw') {
        // Raw Trails Mode
        state.tracks.forEach(track => {
            if (track.visible === false) return;
            const pts = track.points;
            
            // Filter points within the sliding time window
            const windowPoints = pts.filter(p => p.time >= tMin && p.time <= tMax && p.climbRate !== undefined);
            if (windowPoints.length < 2) return;
            
            let currentCategory = null;
            let currentSegment = [];
            
            const drawSegment = (segment, category) => {
                if (segment.length < 2) return;
                let color = '#f59e0b'; // Neutral (amber yellow)
                let weight = 2.5;
                let opacity = 0.7;
                if (category === 'climb') {
                    color = '#10b981'; // Climb (emerald green)
                    weight = 3;
                    opacity = 0.8;
                } else if (category === 'sink') {
                    color = '#ef4444'; // Sink (rose red)
                    weight = 3;
                    opacity = 0.8;
                }
                
                L.polyline(segment, {
                    color: color,
                    weight: weight,
                    opacity: opacity,
                    lineCap: 'round',
                    lineJoin: 'round'
                }).addTo(state.liftSinkLayerGroup);
            };
            
            for (let i = 0; i < windowPoints.length; i++) {
                const pt = windowPoints[i];
                let cat = 'neutral';
                if (pt.climbRate >= 0.5) cat = 'climb';
                else if (pt.climbRate <= -0.5) cat = 'sink';
                
                if (currentCategory === null) {
                    currentCategory = cat;
                    currentSegment.push([pt.lat, pt.lng]);
                } else if (currentCategory === cat) {
                    currentSegment.push([pt.lat, pt.lng]);
                } else {
                    // Prevent gaps by connecting previous segment's end to current point
                    currentSegment.push([pt.lat, pt.lng]);
                    drawSegment(currentSegment, currentCategory);
                    currentSegment = [[pt.lat, pt.lng]];
                    currentCategory = cat;
                }
            }
            if (currentSegment.length > 1) {
                drawSegment(currentSegment, currentCategory);
            }
        });
    } else {
        // Grid Averages Mode
        let refLat = 47.8;
        const firstActiveTrack = state.tracks.find(t => t.visible !== false && t.points && t.points.length > 0);
        if (firstActiveTrack) {
            refLat = firstActiveTrack.points[0].lat;
        }
        
        const latStep = state.liftSinkGridSize / 111000;
        const lngStep = state.liftSinkGridSize / (111000 * Math.cos(refLat * Math.PI / 180));
        
        const grid = {};
        
        state.tracks.forEach(track => {
            if (track.visible === false) return;
            const pts = track.points;
            const windowPoints = pts.filter(p => p.time >= tMin && p.time <= tMax && p.climbRate !== undefined);
            windowPoints.forEach(p => {
                const latIdx = Math.floor(p.lat / latStep);
                const lngIdx = Math.floor(p.lng / lngStep);
                const key = `${latIdx},${lngIdx}`;
                if (!grid[key]) {
                    grid[key] = {
                        latIdx: latIdx,
                        lngIdx: lngIdx,
                        climbRates: [],
                        pilots: new Set()
                    };
                }
                grid[key].climbRates.push(p.climbRate);
                grid[key].pilots.add(track.fullName || track.name);
            });
        });
        
        // Render grid rectangles meeting count threshold
        Object.keys(grid).forEach(key => {
            const cell = grid[key];
            if (cell.climbRates.length < state.liftSinkMinPoints) return;
            
            const sum = cell.climbRates.reduce((a, b) => a + b, 0);
            const avgClimb = sum / cell.climbRates.length;
            
            let color = '#f59e0b'; // Neutral (amber yellow)
            let typeLabel = 'Neutral Air';
            if (avgClimb >= 0.5) {
                color = '#10b981'; // Climb (emerald green)
                typeLabel = 'Thermal Lift Area';
            } else if (avgClimb <= -0.5) {
                color = '#ef4444'; // Sink (rose red)
                typeLabel = 'Sink Area';
            }
            
            const lat0 = cell.latIdx * latStep;
            const lat1 = (cell.latIdx + 1) * latStep;
            const lng0 = cell.lngIdx * lngStep;
            const lng1 = (cell.lngIdx + 1) * lngStep;
            
            const bounds = [
                [lat0, lng0],
                [lat1, lng1]
            ];
            
            const rect = L.rectangle(bounds, {
                fillColor: color,
                fillOpacity: 0.4,
                color: color,
                weight: 1,
                opacity: 0.2
            });
            
            rect.on('mouseover', () => {
                rect.setStyle({ weight: 2.5, opacity: 0.8, fillOpacity: 0.55 });
            });
            rect.on('mouseout', () => {
                rect.setStyle({ weight: 1, opacity: 0.2, fillOpacity: 0.4 });
            });
            
            const pilotsList = Array.from(cell.pilots).join(', ');
            const sign = avgClimb > 0 ? '+' : '';
            const popupContent = `
                <div class="liftsink-popup" style="font-family: inherit;">
                    <h4 style="margin: 0 0 6px 0; color: ${color}; font-size: 0.9rem; font-weight: 600;">
                        ${typeLabel}
                    </h4>
                    <div style="font-size: 0.8rem; line-height: 1.45; color: var(--text-main);">
                        <div><strong>Avg Vario:</strong> <span style="font-family: monospace; font-weight: bold; color: ${color};">${sign}${avgClimb.toFixed(2)} m/s</span></div>
                        <div><strong>Trackpoints:</strong> <span style="font-family: monospace;">${cell.climbRates.length}</span></div>
                        <div><strong>Pilots:</strong> <span style="font-family: monospace;">${cell.pilots.size}</span></div>
                        <div style="margin-top: 4px; font-size: 0.75rem; color: var(--text-muted); border-top: 1px solid var(--border); padding-top: 4px; max-width: 200px; word-wrap: break-word;">
                            <strong>Pilots active:</strong> ${pilotsList}
                        </div>
                    </div>
                </div>
            `;
            
            rect.bindPopup(popupContent);
            rect.addTo(state.liftSinkLayerGroup);
        });
    }
}

/**
 * Binds UI inputs and settings controls for Lift/Sink Map.
 * Syncs settings, manages dynamic visibility of controls, and handles localStorage.
 */
function initLiftSinkControls() {
    const chkEnable = document.getElementById('chk-liftsink-enable');
    const selectMode = document.getElementById('select-liftsink-mode');
    const slideWindow = document.getElementById('slide-liftsink-window');
    const labelWindow = document.getElementById('label-liftsink-window');
    const slideGridSize = document.getElementById('slide-liftsink-gridsize');
    const labelGridSize = document.getElementById('label-liftsink-gridsize');
    const slideMinPts = document.getElementById('slide-liftsink-minpts');
    const labelMinPts = document.getElementById('label-liftsink-minpts');
    const wrapperControls = document.getElementById('liftsink-controls-wrapper');
    const wrapperAverage = document.getElementById('average-settings-wrapper');

    // Restore settings from localStorage
    try {
        const storedEnabled = localStorage.getItem('pg-liftsink-enabled');
        if (storedEnabled !== null) state.liftSinkEnabled = storedEnabled === 'true';
        
        const storedMode = localStorage.getItem('pg-liftsink-mode');
        if (storedMode !== null) state.liftSinkMode = storedMode;
        
        const storedWindow = localStorage.getItem('pg-liftsink-window');
        if (storedWindow !== null) state.liftSinkWindow = parseInt(storedWindow, 10);
        
        const storedGridSize = localStorage.getItem('pg-liftsink-gridsize');
        if (storedGridSize !== null) state.liftSinkGridSize = parseInt(storedGridSize, 10);
        
        const storedMinPoints = localStorage.getItem('pg-liftsink-minpts');
        if (storedMinPoints !== null) state.liftSinkMinPoints = parseInt(storedMinPoints, 10);
    } catch (e) {
        console.warn('Failed to restore lift/sink settings', e);
    }

    // Apply state to UI
    if (chkEnable) chkEnable.checked = state.liftSinkEnabled;
    if (selectMode) selectMode.value = state.liftSinkMode;
    if (slideWindow) slideWindow.value = Math.round(state.liftSinkWindow / 60);
    if (labelWindow) labelWindow.textContent = `${Math.round(state.liftSinkWindow / 60)} min`;
    if (slideGridSize) slideGridSize.value = state.liftSinkGridSize;
    if (labelGridSize) labelGridSize.textContent = `${state.liftSinkGridSize}m`;
    if (slideMinPts) slideMinPts.value = state.liftSinkMinPoints;
    if (labelMinPts) labelMinPts.textContent = state.liftSinkMinPoints.toString();

    const updateVisibility = () => {
        if (wrapperControls) {
            wrapperControls.style.display = state.liftSinkEnabled ? 'flex' : 'none';
        }
        if (wrapperAverage) {
            wrapperAverage.style.display = (state.liftSinkEnabled && state.liftSinkMode === 'average') ? 'flex' : 'none';
        }
    };
    updateVisibility();

    // Event Listeners
    if (chkEnable) {
        chkEnable.addEventListener('change', (e) => {
            state.liftSinkEnabled = e.target.checked;
            try { localStorage.setItem('pg-liftsink-enabled', state.liftSinkEnabled); } catch(err) {}
            updateVisibility();
            updateLiftSinkOverlay();
        });
    }

    if (selectMode) {
        selectMode.addEventListener('change', (e) => {
            state.liftSinkMode = e.target.value;
            try { localStorage.setItem('pg-liftsink-mode', state.liftSinkMode); } catch(err) {}
            updateVisibility();
            updateLiftSinkOverlay();
        });
    }

    if (slideWindow) {
        slideWindow.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            state.liftSinkWindow = val * 60;
            if (labelWindow) labelWindow.textContent = `${val} min`;
            try { localStorage.setItem('pg-liftsink-window', state.liftSinkWindow); } catch(err) {}
            updateLiftSinkOverlay();
        });
    }

    if (slideGridSize) {
        slideGridSize.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            state.liftSinkGridSize = val;
            if (labelGridSize) labelGridSize.textContent = `${val}m`;
            try { localStorage.setItem('pg-liftsink-gridsize', state.liftSinkGridSize); } catch(err) {}
            updateLiftSinkOverlay();
        });
    }

    if (slideMinPts) {
        slideMinPts.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            state.liftSinkMinPoints = val;
            if (labelMinPts) labelMinPts.textContent = val.toString();
            try { localStorage.setItem('pg-liftsink-minpts', state.liftSinkMinPoints); } catch(err) {}
            updateLiftSinkOverlay();
        });
    }
}

function applyTopNSelection() {
    const inputCount = document.getElementById('input-top-n-count');
    let n = 10;
    if (inputCount) {
        n = parseInt(inputCount.value, 10);
        if (isNaN(n) || n < 1) n = 10;
    }
    
    // Get mode: "currently", "endOfTask", "overall"
    let mode = 'currently';
    const modes = document.getElementsByName('top-n-mode');
    for (const radio of modes) {
        if (radio.checked) {
            mode = radio.value;
            break;
        }
    }
    
    if (state.tracks.length === 0) return;
    
    if ((mode === 'currently' || mode === 'endOfTask') && (!state.task || state.task.length === 0)) {
        alert("Please load a task first to select by task metrics.");
        return;
    }
    
    const sortedTracks = [...state.tracks];
    
    // Helper to get distance to goal at current playback time
    const getDistAtCurrentTime = (track) => {
        if (!track.tactics || !track.tactics.grToGoalSeries || track.tactics.grToGoalSeries.length === 0) {
            return Infinity;
        }
        const pts = track.points;
        let idx = track.currentPosIndex || 0;
        if (idx >= pts.length) idx = pts.length - 1;
        while (idx < pts.length - 1 && pts[idx + 1].time < state.currentTime) idx++;
        while (idx > 0 && pts[idx].time > state.currentTime) idx--;
        
        if (idx >= track.tactics.grToGoalSeries.length) {
            idx = track.tactics.grToGoalSeries.length - 1;
        }
        return track.tactics.grToGoalSeries[idx].distToGoal;
    };
    
    if (mode === 'currently') {
        // Ensure all tracks have tactics computed
        sortedTracks.forEach(track => {
            if (!track.tactics && state.task && state.task.length > 0) {
                track.tactics = analyzeTactics(track.points, state.task, state.startGateTime);
            }
        });
        
        sortedTracks.sort((a, b) => {
            const aFinished = a.tactics && a.tactics.essCrossTime !== null && a.tactics.essCrossTime !== undefined && state.currentTime >= a.tactics.essCrossTime;
            const bFinished = b.tactics && b.tactics.essCrossTime !== null && b.tactics.essCrossTime !== undefined && state.currentTime >= b.tactics.essCrossTime;
            
            if (aFinished && !bFinished) return -1;
            if (!aFinished && bFinished) return 1;
            
            if (aFinished && bFinished) {
                const aTime = a.tactics.speedSectionTime ?? Infinity;
                const bTime = b.tactics.speedSectionTime ?? Infinity;
                return aTime - bTime;
            } else {
                const aDist = getDistAtCurrentTime(a);
                const bDist = getDistAtCurrentTime(b);
                return aDist - bDist;
            }
        });
    } else if (mode === 'endOfTask') {
        // Ensure all tracks have tactics computed
        sortedTracks.forEach(track => {
            if (!track.tactics && state.task && state.task.length > 0) {
                track.tactics = analyzeTactics(track.points, state.task, state.startGateTime);
            }
        });
        
        sortedTracks.sort((a, b) => {
            const aFinished = a.tactics && a.tactics.essCrossTime !== null && a.tactics.essCrossTime !== undefined;
            const bFinished = b.tactics && b.tactics.essCrossTime !== null && b.tactics.essCrossTime !== undefined;
            
            if (aFinished && !bFinished) return -1;
            if (!aFinished && bFinished) return 1;
            
            if (aFinished && bFinished) {
                const aTime = a.tactics.speedSectionTime ?? Infinity;
                const bTime = b.tactics.speedSectionTime ?? Infinity;
                return aTime - bTime;
            } else {
                const aFinalDist = (a.tactics && a.tactics.grToGoalSeries && a.tactics.grToGoalSeries.length > 0)
                    ? a.tactics.grToGoalSeries[a.tactics.grToGoalSeries.length - 1].distToGoal
                    : Infinity;
                const bFinalDist = (b.tactics && b.tactics.grToGoalSeries && b.tactics.grToGoalSeries.length > 0)
                    ? b.tactics.grToGoalSeries[b.tactics.grToGoalSeries.length - 1].distToGoal
                    : Infinity;
                return aFinalDist - bFinalDist;
            }
        });
    } else if (mode === 'overall') {
        sortedTracks.sort((a, b) => {
            const aName = (a.fullName || a.name || '').toLowerCase().trim();
            const bName = (b.fullName || b.name || '').toLowerCase().trim();
            const aRank = state.overallStandings[aName] ?? 999;
            const bRank = state.overallStandings[bName] ?? 999;
            return aRank - bRank;
        });
    }
    
    const topNIds = new Set(sortedTracks.slice(0, n).map(t => t.id));
    
    state.tracks.forEach(track => {
        const visible = topNIds.has(track.id);
        track.visible = visible;
        
        if (visible) {
            if (state.map && track.layerGroup) {
                track.layerGroup.addTo(state.map);
            }
            if (!track.tactics && state.task && state.task.length > 0) {
                track.tactics = analyzeTactics(track.points, state.task, state.startGateTime);
                updateMaxSpeedMarker(track);
                fetchTrackTerrainProfile(track);
            } else if (track.tactics && !track.terrainProfile) {
                fetchTrackTerrainProfile(track);
            }
        } else {
            if (state.map && track.layerGroup) {
                state.map.removeLayer(track.layerGroup);
            }
        }
        
        const chk = document.querySelector(`.chk-track[data-track-id="${track.id}"]`);
        if (chk) {
            chk.checked = visible;
        }
    });
    
    const chkAll = document.getElementById('chk-all-tracks');
    if (chkAll) {
        chkAll.checked = state.tracks.every(t => t.visible !== false);
    }
    
    sortPilotList();
    if (sideView) sideView.render(state);
    updateLiftSinkOverlay();
    
    // Update stats chart in real-time if panel is open
    const rightPanelEl = document.getElementById('right-panel');
    if (rightPanelEl && !rightPanelEl.classList.contains('collapsed')) {
        const btnTabLeading = document.getElementById('btn-tab-leading');
        if (btnTabLeading && btnTabLeading.classList.contains('active')) {
            updateLeadingPointsChart();
        } else {
            updateStatsAnalysis();
        }
    }
}

// Bootstrap
document.addEventListener('DOMContentLoaded', initApp);

window.addEventListener('load', () => {
    if (state.map) {
        state.map.invalidateSize();
    }
    if (sideView) {
        sideView.resize();
    }
});
