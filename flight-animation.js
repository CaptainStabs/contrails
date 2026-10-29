// Flight history animation.
// Reads MyFlightbook telemetry (.csv / .kml, or combined-flights.kml) that the user opens or drops on the page,
// then replays the flights in date order: for each flight the camera zooms out to fit it plus everything drawn
// so far, then the flight is traced. "Record" renders the same animation frame by frame into an MP4.
(() => {
'use strict';

const $ = id => document.getElementById(id);
const setStatus = msg => { $('status').textContent = msg; };

if (!window.maplibregl || !window.deck || !window.Mp4Muxer) {
  setStatus('Libraries failed to load. Keep the lib folder next to flight-animation.html.');
  return;
}
addEventListener('error', e => setStatus('Error: ' + (e.message || 'unknown')));

const W = 1920, H = 1080;
const PADDING = { top: 140, bottom: 220, left: 140, right: 140 };   // extra bottom room for the date overlay
const MAX_ZOOM = 11.5;     // closest the camera gets (first flight)
const END_HOLD = 3;        // seconds to hold the final view
const FOCUS_CONTEXT = 0.6; // when zoomed in on a small flight, stay this many zoom levels wider than a tight fit
const ACTIVE = [255, 190, 60], DONE = [90, 200, 255, 210], HEAD = [255, 255, 255];

const BASEMAPS = {
  dark: { style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', credit: '© OpenStreetMap contributors © CARTO' },
  light: { style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json', credit: '© OpenStreetMap contributors © CARTO' },
  satellite: {
    style: {
      version: 8,
      sources: { esri: { type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' } },
      layers: [{ id: 'esri', type: 'raster', source: 'esri', paint: { 'raster-fade-duration': 0 } }]
    },
    credit: 'Imagery © Esri, Maxar, Earthstar Geographics'
  }
};

function readSetting(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; } }
function saveSetting(key, v) { try { localStorage.setItem(key, v); } catch {} }
let basemapKey = BASEMAPS[readSetting('fa.basemap')] ? readSetting('fa.basemap') : 'dark';
$('basemap').value = basemapKey;
$('zoomSec').value = readSetting('fa.zoomSec', $('zoomSec').value);
$('traceSec').value = readSetting('fa.traceSec', $('traceSec').value);
$('fps').value = readSetting('fa.fps', $('fps').value);
$('focus').value = readSetting('fa.focus', $('focus').value);
$('mode').value = readSetting('fa.mode', $('mode').value);
$('allSec').value = readSetting('fa.allSec', $('allSec').value);
$('framing').value = readSetting('fa.framing', $('framing').value);
const together = () => $('mode').value === 'together';
const showMode = () => { document.body.className = 'mode-' + $('mode').value; };
showMode();

// ---- Layout: scale the fixed 1920x1080 stage to fit the window ----
function fitStage() {
  const s = Math.min(innerWidth / W, innerHeight / H);
  $('stage').style.transform = `translate(-50%, -50%) scale(${s})`;
}
addEventListener('resize', fitStage);
fitStage();

// ---- Telemetry parsing ----
// Each parser returns flights as { name, points: [[lon, lat, timeMs], ...] }.

function parseCsv(text) {
  // MyFlightbook CSV: LAT,LON,PALT,SPEED,HERROR,DATE,TZOFFSET,COMMENT
  const lines = text.split(/\r?\n/);
  const hdr = lines[0].split(',').map(s => s.trim().toUpperCase());
  const iLat = hdr.indexOf('LAT'), iLon = hdr.indexOf('LON'), iDate = hdr.indexOf('DATE');
  if (iLat < 0 || iLon < 0 || iDate < 0) return [];
  const points = [];
  for (let k = 1; k < lines.length; k++) {
    const f = lines[k].split(',');
    if (f.length <= Math.max(iLat, iLon, iDate)) continue;
    const lat = parseFloat(f[iLat]), lon = parseFloat(f[iLon]), t = Date.parse(f[iDate]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && !isNaN(t)) points.push([lon, lat, t]);
  }
  return [{ name: null, points }];
}

function parseKml(text) {
  // Timestamped gx:Track placemarks (<when> + <gx:coord>), as exported by MyFlightbook
  // and written by Combine-Telemetry.ps1. Regex rather than DOMParser keeps large files fast.
  const flights = [];
  for (const part of text.split(/<Placemark[\s>]/).slice(1)) {
    const pm = part.split('</Placemark>')[0];
    const whens = [...pm.matchAll(/<when\s*>([^<]*)<\/when>/g)];
    const coords = [...pm.matchAll(/<gx:coord\s*>([^<]*)<\/gx:coord>/g)];
    if (!coords.length || whens.length !== coords.length) continue;
    const points = [];
    for (let k = 0; k < coords.length; k++) {
      const [lon, lat] = coords[k][1].trim().split(/\s+/).map(Number), t = Date.parse(whens[k][1]);
      if (Number.isFinite(lat) && Number.isFinite(lon) && !isNaN(t)) points.push([lon, lat, t]);
    }
    const name = /<name\s*>([^<]*)<\/name>/.exec(pm);
    flights.push({ name: name ? name[1].trim() : null, points });
  }
  return flights;
}

function makeFlight({ name, points }) {
  const pts = points.filter(p => !(p[0] === 0 && p[1] === 0));   // GPS dropouts
  if (pts.length < 2) return null;
  const t0 = pts[0][2], dur = (pts[pts.length - 1][2] - t0) || 1;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of pts) {
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  }
  const tail = (name || '').match(/\bN[0-9][0-9A-Z]{0,4}\b/);   // US registration, if the name has one
  return {
    start: new Date(t0), tail: tail ? tail[0] : '',
    path: pts.map(p => [p[0], p[1]]), rel: pts.map(p => (p[2] - t0) / dur),
    bbox: [minLon, minLat, maxLon, maxLat], key: t0 + ':' + pts.length, durMs: dur, timestamps: null
  };
}

async function loadFiles(fileList) {
  const files = [...fileList].filter(f => /\.(kml|csv)$/i.test(f.name));
  if (!files.length) { setStatus('No .kml or .csv files in that selection.'); return; }
  const list = [], seen = new Set(), failed = [];
  for (let n = 0; n < files.length; n++) {
    const f = files[n];
    setStatus(`Reading ${n + 1} / ${files.length}: ${f.name}`);
    try {
      const text = await f.text();
      for (const raw of /\.csv$/i.test(f.name) ? parseCsv(text) : parseKml(text)) {
        const flight = makeFlight(raw);
        // The same flight can arrive twice (raw file plus combined-flights.kml)
        if (flight && !seen.has(flight.key)) { seen.add(flight.key); list.push(flight); }
      }
    } catch (e) {
      failed.push(f.name);
    }
  }
  if (!list.length) { setStatus('No timestamped flight tracks found in those files.'); return; }
  list.sort((a, b) => a.start - b.start);
  list.forEach((f, i) => { f.index = i; });
  setFlights(list);
  setStatus(`${list.length} flights loaded` + (failed.length ? ` (${failed.length} file(s) could not be read: ${failed.slice(0, 3).join(', ')})` : '') +
    '. Space = play/pause, H = hide panel.');
}

// ---- Flights and timeline ----
let flights = [], cumBounds = [], targets = [], overview = null, mapReady = false;

function setFlights(list) {
  flights = list;
  // Cumulative bounds: everything up to and including flight i. These only grow, so the camera only zooms out.
  cumBounds = [];
  flights.forEach((f, i) => {
    const b = f.bbox, p = cumBounds[i - 1];
    cumBounds.push(p ? [Math.min(p[0], b[0]), Math.min(p[1], b[1]), Math.max(p[2], b[2]), Math.max(p[3], b[3])] : b.slice());
  });
  buildTimeline();
  computeTargets();   // only needs the map's size, not its style
  time = 0;
  setPlaying(false);
  $('drop').classList.add('hidden');
  setControlsDisabled(false);
}

// One at a time: flight i has a camera move over [i*(Z+T), i*(Z+T)+Z), then a trace over [.. +Z, (i+1)*(Z+T)).
// After the last flight: one more camera move back to the overview of everything, then a hold.
// All at once: every flight starts at 0 and draws at its real relative speed, so the longest flight
// takes the whole draw time D; then a hold.
let Z, T, D, total = 0, longestMs = 1;
function buildTimeline() {
  Z = +$('zoomSec').value; T = +$('traceSec').value; D = +$('allSec').value;
  $('zoomVal').textContent = Z.toFixed(1) + ' s';
  $('traceVal').textContent = T.toFixed(1) + ' s';
  $('allVal').textContent = D.toFixed(0) + ' s';
  longestMs = Math.max(1, ...flights.map(f => f.durMs));
  if (together()) {
    flights.forEach(f => {
      const span = D * f.durMs / longestMs;
      f.timestamps = f.rel.map(r => r * span);
    });
    total = flights.length ? D + TOGETHER_OUTRO + END_HOLD : 0;
  } else {
    flights.forEach((f, i) => {
      const t0 = i * (Z + T) + Z;
      f.timestamps = f.rel.map(r => t0 + r * T);
    });
    total = flights.length ? flights.length * (Z + T) + Z + END_HOLD : 0;
  }
  $('scrub').max = total || 1;
}

// ---- Map + deck.gl ----
const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAPS[basemapKey].style,
  center: [-95, 38], zoom: 3.5,
  interactive: false,
  pixelRatio: 1,
  fadeDuration: 0,
  attributionControl: { compact: false },
  canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true }
});
map.on('error', e => setStatus('Map error: ' + (e.error?.message || e.error || 'unknown') + ' (map tiles need an internet connection)'));
// Trails are drawn by a separate deck.gl instance on its own transparent canvas above the map, kept in sync
// by giving it the same camera each frame. Unlike drawing inside the map's WebGL pass (MapboxOverlay
// interleaved mode), this keeps the trails independent of the basemap's GL state and of style changes,
// and lets the recorder update and draw them on demand before compositing the two canvases.
const trails = new deck.Deck({
  canvas: $('trails'),
  width: W, height: H,
  useDevicePixels: false,
  controller: false,
  viewState: { longitude: -95, latitude: 38, zoom: 3.5, pitch: 0, bearing: 0 },
  layers: []
});

function fitCamera(b) {
  const cam = map.cameraForBounds([[b[0], b[1]], [b[2], b[3]]], { padding: PADDING, maxZoom: MAX_ZOOM });
  const c = maplibregl.LngLat.convert(cam.center);
  return { center: [c.lng, c.lat], zoom: cam.zoom };
}

// Camera per flight. Normally the overview of everything so far (it only ever widens). With the
// "Small flights" option, a flight that would appear smaller than half/quarter of that overview
// (1 or 2 zoom levels) gets its own closer view instead, kept a little wider than a tight fit for context.
function computeTargets() {
  computeTogetherCameras();
  const focusLevels = +$('focus').value;
  const cum = cumBounds.map(fitCamera);
  overview = cum[cum.length - 1];
  targets = flights.map((f, i) => {
    if (!focusLevels) return cum[i];
    const own = fitCamera(f.bbox);
    if (own.zoom - cum[i].zoom < focusLevels) return cum[i];
    return { center: own.center, zoom: Math.max(cum[i].zoom, own.zoom - FOCUS_CONTEXT) };
  });
}

// All at once: camera keyframes at TOGETHER_STEPS points across the draw time. Keyframe k frames what is
// drawn by step k+1 (one step ahead), so the camera is already wide enough while it moves toward the next.
// "Framing" below 1 frames only the central share of the drawn points (by longitude and latitude), so a few
// long cross-country legs don't shrink the dense local flying; those legs run off the edge until the
// final zoom-out to everything. Each box is merged with the previous one, so the camera only zooms out.
const TOGETHER_STEPS = 48;
const TOGETHER_OUTRO = 1.5;   // seconds to pull back to everything after the draw time
const FRAMING_SAMPLE = 20000; // max points used for the share-of-flying boxes
let togetherCams = [], togetherOverview = null;
function computeTogetherCameras() {
  if (!flights.length) return;
  const share = +$('framing').value;
  const longest = Math.max(1, ...flights.map(f => f.durMs));
  const totalPts = flights.reduce((s, f) => s + f.path.length, 0);
  const stride = Math.max(1, Math.ceil(totalPts / FRAMING_SAMPLE));
  const next = flights.map(() => 0);   // per flight, index of the first point not yet included
  const lons = [], lats = [];
  let b = [Infinity, Infinity, -Infinity, -Infinity], focus = null, seen = 0;
  const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  const boxes = [];
  for (let k = 0; k <= TOGETHER_STEPS; k++) {
    const u = k / TOGETHER_STEPS;
    flights.forEach((f, i) => {
      const local = u * longest / f.durMs;   // how far through its own flight this one is
      while (next[i] < f.rel.length && f.rel[next[i]] <= local) {
        const [lon, lat] = f.path[next[i]++];
        b = [Math.min(b[0], lon), Math.min(b[1], lat), Math.max(b[2], lon), Math.max(b[3], lat)];
        if (seen++ % stride === 0) { lons.push(lon); lats.push(lat); }
      }
    });
    let box = b.slice();
    if (share < 1 && lons.length >= 20) {
      const lo = (1 - share) / 2, hi = 1 - lo;
      const sx = lons.slice().sort((p, q) => p - q), sy = lats.slice().sort((p, q) => p - q);
      const qb = [quantile(sx, lo), quantile(sy, lo), quantile(sx, hi), quantile(sy, hi)];
      focus = focus ? [Math.min(focus[0], qb[0]), Math.min(focus[1], qb[1]), Math.max(focus[2], qb[2]), Math.max(focus[3], qb[3])] : qb;
      box = focus.slice();
    }
    boxes.push(box);
  }
  togetherCams = boxes.map((_, k) => fitCamera(boxes[Math.min(k + 1, TOGETHER_STEPS)]));
  togetherOverview = fitCamera(b);
}

const ease = u => u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
// Smooth zoom-and-pan between two cameras (van Wijk & Nuij, the curve maplibre's flyTo uses): long moves
// between close-up views pull out and back in instead of sliding across the map at high zoom.
function flyCamera(a, b, u) {
  if (u <= 0) return a;
  if (u >= 1) return b;
  const ma = maplibregl.MercatorCoordinate.fromLngLat(a.center), mb = maplibregl.MercatorCoordinate.fromLngLat(b.center);
  const dx = mb.x - ma.x, dy = mb.y - ma.y, u1 = Math.hypot(dx, dy);
  // View widths in world units (the world is 512 * 2^zoom pixels wide)
  const w0 = W / (512 * 2 ** a.zoom), w1 = W / (512 * 2 ** b.zoom);
  const rho = 1.42, rho2 = rho * rho;
  let wAt, uAt, S;
  if (u1 < 1e-12) {
    // Pure zoom, no pan
    S = Math.abs(Math.log(w1 / w0)) / rho;
    const k = w1 < w0 ? -1 : 1;
    wAt = s => w0 * Math.exp(k * rho * s); uAt = () => 0;
  } else {
    const b0 = (w1 * w1 - w0 * w0 + rho2 * rho2 * u1 * u1) / (2 * w0 * rho2 * u1);
    const b1 = (w1 * w1 - w0 * w0 - rho2 * rho2 * u1 * u1) / (2 * w1 * rho2 * u1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    S = (r1 - r0) / rho;
    wAt = s => w0 * Math.cosh(r0) / Math.cosh(rho * s + r0);
    uAt = s => w0 / rho2 * (Math.cosh(r0) * Math.tanh(rho * s + r0) - Math.sinh(r0));
  }
  if (!(S > 0)) return b;
  const s = u * S, f = u1 < 1e-12 ? 0 : uAt(s) / u1;
  const ll = new maplibregl.MercatorCoordinate(ma.x + dx * f, ma.y + dy * f).toLngLat();
  return { center: [ll.lng, ll.lat], zoom: a.zoom + Math.log2(w0 / wAt(s)) };
}

// Which flight is active at time t, and how far into its zoom/trace phase
function phaseAt(t) {
  const step = Z + T;
  const i = Math.min(flights.length - 1, Math.max(0, Math.floor(t / step)));
  const local = t - i * step;
  return { i, zoomU: Math.min(1, Math.max(0, local / Z)), traceU: Math.min(1, Math.max(0, (local - Z) / T)), ended: t >= flights.length * step };
}

function cameraAt(t) {
  if (together()) {
    if (t > D) {
      // Pull back to everything (a no-op when already framing everything)
      return flyCamera(togetherCams[TOGETHER_STEPS], togetherOverview, ease(Math.min(1, (t - D) / TOGETHER_OUTRO)));
    }
    const x = Math.min(TOGETHER_STEPS, Math.max(0, t / D * TOGETHER_STEPS)), k = Math.min(TOGETHER_STEPS - 1, Math.floor(x));
    return flyCamera(togetherCams[k], togetherCams[k + 1], x - k);
  }
  const ph = phaseAt(t), n = flights.length;
  if (ph.ended) {
    // Final move back out to everything
    const u = Math.min(1, (t - n * (Z + T)) / Z);
    return flyCamera(targets[n - 1], overview, ease(u));
  }
  return flyCamera(targets[Math.max(0, ph.i - 1)], targets[ph.i], ease(ph.zoomU));
}

function headPosition(f, u) {
  // Binary search the normalized times for the current point, then interpolate
  const r = f.rel; let lo = 0, hi = r.length - 1;
  if (u >= r[hi]) return f.path[hi];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (r[mid] <= u) lo = mid; else hi = mid; }
  const span = r[hi] - r[lo] || 1, k = (u - r[lo]) / span, a = f.path[lo], b = f.path[hi];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}

const hud = { date: '', sub: '' };
function render(t) {
  if (!flights.length || targets.length !== flights.length) return;
  const all = together();
  const ph = phaseAt(t);
  const active = all || ph.ended ? -1 : ph.i;
  const cam = cameraAt(t);
  map.jumpTo(cam);

  const layers = [
    new deck.TripsLayer({
      id: 'trips',
      data: flights,
      getPath: f => f.path,
      getTimestamps: f => f.timestamps,
      getColor: f => f.index === active ? ACTIVE : DONE,
      getWidth: f => f.index === active ? 4 : 2.5,
      widthUnits: 'pixels',
      capRounded: true, jointRounded: true,
      fadeTrail: false, trailLength: 1e9,
      currentTime: t,
      updateTriggers: { getColor: active, getWidth: active, getTimestamps: [total, all] }
    })
  ];
  if (all) {
    // A dot at the front of every flight that is still drawing
    const heads = [];
    for (const f of flights) {
      const local = t / (D * f.durMs / longestMs);
      if (local > 0 && local < 1) heads.push(headPosition(f, local));
    }
    layers.push(new deck.ScatterplotLayer({
      id: 'head', data: heads,
      getPosition: d => d, getFillColor: HEAD, getLineColor: ACTIVE,
      radiusUnits: 'pixels', getRadius: 5, stroked: true, lineWidthUnits: 'pixels', getLineWidth: 2.5
    }));
  } else if (active >= 0 && ph.traceU > 0 && ph.traceU < 1) {
    layers.push(new deck.ScatterplotLayer({
      id: 'head', data: [headPosition(flights[active], ph.traceU)],
      getPosition: d => d, getFillColor: HEAD, getLineColor: ACTIVE,
      radiusUnits: 'pixels', getRadius: 7, stroked: true, lineWidthUnits: 'pixels', getLineWidth: 3
    }));
  }
  // Same camera as the map (deck.gl and MapLibre share the 512px-tile Web Mercator zoom scale)
  trails.setProps({
    layers,
    viewState: { longitude: cam.center[0], latitude: cam.center[1], zoom: cam.zoom, pitch: 0, bearing: 0 }
  });

  const fmt = d => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (all) {
    hud.date = `${fmt(flights[0].start)} – ${fmt(flights[flights.length - 1].start)}`;
    hud.sub = `${flights.length} flights`;
  } else {
    const f = flights[ph.ended ? flights.length - 1 : ph.i];
    const shown = ph.ended ? flights.length : ph.i + 1;
    hud.date = fmt(f.start);
    hud.sub = `Flight ${shown} of ${flights.length}` + (f.tail ? ` · ${f.tail}` : '');
  }
  $('hudDate').textContent = hud.date;
  $('hudSub').textContent = hud.sub;
  $('clock').textContent = `${t.toFixed(1)} / ${total.toFixed(0)} s`;
  if (document.activeElement !== $('scrub')) $('scrub').value = t;
}

// ---- Playback ----
let time = 0, playing = false, lastFrame = 0, paused = false;
function frame(now) {
  // While recording, frames are driven by the recorder instead
  if (!paused) {
    if (playing) {
      time += Math.min(0.1, (now - lastFrame) / 1000);
      if (time >= total) { time = total; setPlaying(false); }
    }
    render(time);
  }
  lastFrame = now;
  requestAnimationFrame(frame);
}
function setPlaying(p) {
  playing = p;
  $('play').textContent = p ? 'Pause' : 'Play';
}

const DATA_CONTROLS = ['play', 'restart', 'record', 'scrub', 'zoomSec', 'traceSec', 'allSec', 'mode', 'framing', 'fps', 'focus'];
function setControlsDisabled(d) {
  for (const id of DATA_CONTROLS) $(id).disabled = d || !flights.length;
  if (!recording) $('record').disabled = d || !flights.length || !mapReady;
  for (const id of ['openFiles', 'openFolder', 'basemap']) $(id).disabled = d;
}

$('play').onclick = () => { if (time >= total) time = 0; setPlaying(!playing); };
$('restart').onclick = () => { time = 0; render(0); };
$('scrub').oninput = e => { time = +e.target.value; };
for (const id of ['zoomSec', 'traceSec', 'allSec']) {
  $(id).oninput = () => {
    const u = total ? time / total : 0;
    saveSetting('fa.' + id, $(id).value);
    buildTimeline();
    time = u * total;
  };
}
$('fps').onchange = e => saveSetting('fa.fps', e.target.value);
$('framing').onchange = e => {
  saveSetting('fa.framing', e.target.value);
  if (flights.length) computeTargets();
};
$('mode').onchange = e => {
  saveSetting('fa.mode', e.target.value);
  showMode();
  buildTimeline();
  time = 0;
  setPlaying(false);
};
$('focus').onchange = e => {
  saveSetting('fa.focus', e.target.value);
  if (flights.length) computeTargets();
};
$('basemap').onchange = e => {
  basemapKey = e.target.value;
  saveSetting('fa.basemap', basemapKey);
  map.setStyle(BASEMAPS[basemapKey].style);   // trails are on their own canvas, so they're unaffected
};
$('collapse').onclick = () => {
  const c = $('panel').classList.toggle('collapsed');
  $('collapse').textContent = c ? 'Show' : 'Hide';
};
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space' && !$('play').disabled) { e.preventDefault(); $('play').click(); }
  if (e.key === 'h' || e.key === 'H') $('collapse').click();
});

// ---- Opening files ----
$('openFiles').onclick = () => $('filesInput').click();
$('openFolder').onclick = () => $('folderInput').click();
for (const id of ['filesInput', 'folderInput']) {
  $(id).onchange = e => { if (e.target.files.length) loadFiles(e.target.files); e.target.value = ''; };
}
addEventListener('dragover', e => { e.preventDefault(); $('drop').classList.remove('hidden'); $('drop').classList.add('over'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) { $('drop').classList.remove('over'); if (flights.length) $('drop').classList.add('hidden'); } });
addEventListener('drop', e => {
  e.preventDefault();
  $('drop').classList.remove('over');
  if (flights.length) $('drop').classList.add('hidden');
  if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

// ---- Recording ----
// Frame-by-frame, not real time: each frame is rendered at an exact timeline position, waits for map tiles,
// is composited with the date overlay into a 2D canvas, and is encoded with WebCodecs into an MP4.
// The video is smooth regardless of how fast this machine renders.
let recording = false, cancelRecording = false;
const recCanvas = document.createElement('canvas');
recCanvas.width = W; recCanvas.height = H;
const recCtx = recCanvas.getContext('2d');

function drawRecordFrame() {
  const ctx = recCtx;
  ctx.drawImage(map.getCanvas(), 0, 0, W, H);
  ctx.drawImage($('trails'), 0, 0, W, H);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 2;
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic';
  ctx.font = '700 64px system-ui, "Segoe UI", sans-serif';
  ctx.fillText(hud.date, 56, H - 56 - 46);
  ctx.fillStyle = '#cfd3dc'; ctx.font = '30px system-ui, "Segoe UI", sans-serif';
  ctx.fillText(hud.sub, 56, H - 56);
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '16px system-ui, sans-serif'; ctx.textAlign = 'right';
  ctx.fillText(BASEMAPS[basemapKey].credit, W - 16, H - 14);
  ctx.textAlign = 'left';
}

// Highest-quality H.264 profile this browser can encode at 1080p
async function pickCodec(fps) {
  for (const codec of ['avc1.640033', 'avc1.64002A', 'avc1.4d002A', 'avc1.42002A']) {
    const cfg = { codec, width: W, height: H, bitrate: 16_000_000, framerate: fps };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch {}
  }
  return null;
}

// Yield to the event loop without timers (timers are heavily throttled in background tabs)
const yieldNow = () => new Promise(res => { const ch = new MessageChannel(); ch.port1.onmessage = () => res(); ch.port2.postMessage(0); });

// Render the map synchronously, re-rendering until all visible tiles are loaded (or 10 s pass)
async function renderWhenTilesLoaded() {
  map.redraw();
  const t0 = performance.now();
  while (!(map.isStyleLoaded() && map.areTilesLoaded()) && performance.now() - t0 < 10000) {
    await new Promise(res => { const done = () => { map.off('data', done); clearTimeout(to); res(); }; const to = setTimeout(done, 100); map.on('data', done); });
    map.redraw();
  }
  map.redraw();
}

$('record').onclick = async () => {
  if (recording) { cancelRecording = true; return; }
  if (!window.VideoEncoder) { setStatus('Video export needs a recent Chrome or Edge (WebCodecs).'); return; }
  const fps = +$('fps').value;
  const cfg = await pickCodec(fps);
  if (!cfg) { setStatus('This browser cannot encode 1080p H.264 video.'); return; }
  if (!trails.isInitialized) { setStatus('Still starting up, try again in a moment.'); return; }

  setPlaying(false);
  setControlsDisabled(true);
  $('record').disabled = false;
  recording = true; cancelRecording = false; paused = true;
  $('record').textContent = '■ Cancel';

  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    fastStart: 'in-memory'
  });
  let encodeError = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { encodeError = e; } });
  encoder.configure(cfg);

  const frames = Math.ceil(total * fps);
  const started = performance.now();
  try {
    for (let k = 0; k <= frames && !cancelRecording && !encodeError; k++) {
      time = Math.min(total, k / fps);
      render(time);
      await renderWhenTilesLoaded();
      // deck.gl only applies new layers (setProps) in its own requestAnimationFrame loop, which barely runs
      // while recording, so apply them and draw now. Otherwise frames show stale trails.
      trails.layerManager.updateLayers();
      trails.redraw('record');
      drawRecordFrame();
      const vf = new VideoFrame(recCanvas, { timestamp: Math.round(k * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(vf, { keyFrame: k % (fps * 2) === 0 });
      vf.close();
      while (encoder.encodeQueueSize > 8) await new Promise(res => encoder.addEventListener('dequeue', res, { once: true }));
      if (k % 15 === 0) {
        const el = (performance.now() - started) / 1000, eta = k ? el / k * (frames - k) : 0;
        setStatus(`Rendering frame ${k} / ${frames} (${Math.round(100 * k / frames)}%), about ${Math.ceil(eta / 60)} min left`);
      }
      await yieldNow();
    }
    if (encodeError) throw encodeError;
    if (cancelRecording) { setStatus('Recording cancelled.'); encoder.close(); return; }
    await encoder.flush();
    muxer.finalize();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([muxer.target.buffer], { type: 'video/mp4' }));
    a.download = 'flight-history.mp4';
    a.click();
    setStatus(`Saved flight-history.mp4 (${(muxer.target.buffer.byteLength / 1e6).toFixed(0)} MB)`);
  } catch (e) {
    setStatus('Recording failed: ' + (e && e.message || e));
  } finally {
    recording = false; paused = false;
    setControlsDisabled(false);
    $('record').textContent = '● Record';
  }
};

// ---- Start ----
buildTimeline();
setControlsDisabled(false);
setStatus('Open or drop your telemetry files (.csv / .kml, or combined-flights.kml).');
// Rendering doesn't wait for the map's load event; only recording does (see setControlsDisabled)
map.on('load', () => { mapReady = true; setControlsDisabled(false); });
requestAnimationFrame(now => { lastFrame = now; requestAnimationFrame(frame); });
})();
