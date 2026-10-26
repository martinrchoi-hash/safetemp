// SafeTemp world danger map: feels-like temperature, UV, air quality or wind around the world.
// Vector map (MapLibre + OpenFreeMap) so it zooms smoothly from the whole world down to streets.
// The colors are redrawn live for whatever is on screen, so they never blank out.

const DETAIL_ZOOM = 4; // zoomed in this far, fetch a sharper grid for the view
const HEAT_PIECES = ["heat", "heat_wrap"]; // map layers holding the colors
const HEAT_OPACITY = 0.72;

// The map shows danger zones for the person being checked: each place gets one color for the
// worst of heat or cold, strong sun, unhealthy air and strong wind there, using the same rules
// and the same four levels as the risk card. The numbers behind each zone show on hover and tap.
const ZONES = [
  { name: "Safe zone", color: [92, 176, 106], alpha: 0.4 },
  { name: "Caution zone", color: [240, 196, 64], alpha: 0.8 },
  { name: "Danger zone", color: [232, 112, 40], alpha: 0.88 },
  { name: "Extreme danger zone", color: [156, 22, 38], alpha: 0.92 },
];

// What the map can show: danger zones (the default), or the raw numbers behind them.
// Number layers follow official scales: NWS heat index / wind chill, WHO UV index, EPA air quality index.
const MAP_LAYERS = {
  danger: { button: "Danger", zones: true },
  feels: {
    button: "Feels like",
    description: "How hot or cold it feels right now. Darker red is more dangerous heat; darker blue is more dangerous cold. White lines mark where caution and danger start for the person you're checking for.",
    stops: [
      [-40, [12, 20, 80]],    // extreme cold (darkest blue)
      [-18, [31, 60, 153]],   // frostbite in ~30 minutes
      [0, [47, 111, 214]],    // cold danger
      [32, [79, 179, 232]],   // freezing
      [50, [90, 209, 196]],   // cool
      [65, [124, 207, 107]],  // comfortable
      [75, [197, 220, 90]],   // warm
      [85, [246, 215, 67]],   // heat caution
      [95, [245, 155, 47]],   // hot
      [105, [228, 70, 47]],   // heat danger
      [125, [128, 0, 0]],     // extreme heat (darkest red)
    ],
    // Where cold danger, cold caution, heat caution and heat danger start for the person being checked.
    outlines: () => {
      const p = currentProfile();
      return [...new Set([p.cold, 32 + p.cold, 80, Math.max(81, 103 - p.heat)])].sort((a, b) => a - b);
    },
    ticks: [-18, 0, 32, 65, 85, 105],
    tickLabel: (v) => `${v}°`,
    ends: ["Dangerous cold", "Comfortable", "Dangerous heat"],
    readout: (v) => {
      const r = assess(Math.round(v), currentProfile());
      const label = r.kind === "safe" ? "Safe" : `${["", "Caution", "Danger", "Extreme danger"][r.level]} (${r.kind})`;
      return `Feels like ~${Math.round(v)}°F · ${label}${forWhom()}`;
    },
    daily: "the most extreme feels-like temperature that day (hottest or coldest)",
  },
  uv: {
    button: "UV",
    description: "How strong the sun's UV rays are right now. Purple is extreme: skin can burn in minutes.",
    stops: [
      [0, [62, 167, 45]],
      [2.5, [62, 167, 45]],   // low
      [3.5, [242, 209, 0]],   // moderate
      [5.5, [242, 209, 0]],
      [6.5, [241, 139, 0]],   // high
      [7.5, [241, 139, 0]],
      [8.5, [229, 50, 16]],   // very high
      [10.5, [229, 50, 16]],
      [11.5, [139, 76, 201]], // extreme
      [14, [100, 40, 170]],
    ],
    outlines: [3, 6, 8, 11],
    ticks: [3, 6, 8, 11],
    tickLabel: (v) => (v === 11 ? "11+" : String(v)),
    ends: ["Low", "High", "Extreme"],
    readout: (v) => `UV ${Math.round(v)} · ${UV_LEVELS[levelOf(v, UV_LEVELS)][1]}`,
    daily: "that day's peak UV",
  },
  aqi: {
    button: "Air",
    description: "Air quality right now (US AQI). Green is clean; orange and up is unhealthy, first for sensitive groups and then for everyone.",
    stops: [
      [0, [47, 191, 74]],
      [50, [47, 191, 74]],    // good
      [100, [242, 209, 0]],   // moderate
      [150, [255, 126, 0]],   // unhealthy for sensitive groups
      [200, [229, 38, 44]],   // unhealthy
      [300, [143, 63, 151]],  // very unhealthy
      [400, [126, 0, 35]],    // hazardous
    ],
    outlines: [101, 151, 201],
    ticks: [50, 100, 150, 200, 300],
    tickLabel: (v) => String(v),
    ends: ["Clean air", "Unhealthy", "Hazardous"],
    readout: (v) => `Air quality ~${Math.round(v)} · ${AQI_LEVELS[levelOf(v, AQI_LEVELS)][1]}`,
    daily: "that day's worst air quality",
  },
};

function layerColor(layer, v) {
  const stops = layer.stops;
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    if (v <= t1) {
      const [t0, c0] = stops[i - 1];
      const k = (v - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return stops[stops.length - 1][1];
}

// The zone at a point, from the map's grids: { level, hazards, values }.
// Rain, snow and storms aren't in the world grids, so they only show when a place is tapped.
function zoneAt(lat, lon, profile) {
  const feels = valueAt("feels", lat, lon);
  if (feels == null) return null;
  const values = { feels, uv: valueAt("uv", lat, lon) ?? 0, aqi: valueAt("aqi", lat, lon), wind: valueAt("wind", lat, lon) ?? 0 };
  const f = Math.round(feels);
  const hazards = assessDay({ feelsHi: f, feelsLo: f, feelsNow: f, uv: values.uv, aqi: values.aqi, wind: values.wind, gust: 0, rain: 0, snow: 0, code: 0 }, profile);
  return { level: overallLevel(hazards), hazards, values };
}

// Just the level (or -1 with no data), the same as zoneAt but quick enough to run for every pixel.
function zoneLevelAt(lat, lon, profile) {
  const feels = valueAt("feels", lat, lon);
  if (feels == null) return -1;
  let level = assess(Math.round(feels), profile).level;
  if (level === 3) return 3;
  level = Math.max(level, uvLevelFor(valueAt("uv", lat, lon) ?? 0, profile), windLevelFor(valueAt("wind", lat, lon) ?? 0, 0));
  const aqi = valueAt("aqi", lat, lon);
  return aqi == null ? level : Math.max(level, airLevelFor(aqi, profile));
}

// "because of heat and strong sun": the hazards that set the zone's level.
function zoneReason(hazards, level) {
  if (!level) return "";
  const names = hazards.filter((h) => h.level === level).map((h) => h.title.toLowerCase());
  return "because of " + (names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0]);
}

// " for Grandma" when the person being checked has a name.
function forWhom() {
  const person = typeof activePerson === "function" ? activePerson() : null;
  return person && person.name ? ` for ${person.name}` : "";
}

// Wind as east/north parts (mph), so directions blend smoothly between grid points.
function windParts(speed, dir) {
  const part = (fn) => speed.map((row, r) => row.map((s, c) => -s * fn((dir[r][c] * Math.PI) / 180)));
  return { wu: part(Math.sin), wv: part(Math.cos) };
}

// Smooth curve through the grid points (cell centers, evenly spaced).
function makeSampler(lats, lons, grid, wrap) {
  const rows = lats.length;
  const cols = lons.length;
  const dLat = lats[0] - lats[1];
  const dLon = lons[1] - lons[0];
  const clamp = (v, max) => Math.min(Math.max(v, 0), max);
  const row = (r) => clamp(r, rows - 1);
  const col = (c) => (wrap ? ((c % cols) + cols) % cols : clamp(c, cols - 1));
  // Catmull-Rom: rounded shapes instead of straight-line "diamonds".
  const cubic = (p0, p1, p2, p3, t) =>
    p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  return (lat, lon) => {
    const fr = clamp((lats[0] - lat) / dLat, rows - 1);
    let fc = (lon - lons[0]) / dLon;
    fc = wrap ? ((fc % cols) + cols) % cols : clamp(fc, cols - 1);
    const r1 = Math.floor(fr);
    const c1 = Math.floor(fc);
    const tr = fr - r1;
    const tc = fc - c1;
    const across = (r) => {
      const g = grid[row(r)];
      return cubic(g[col(c1 - 1)], g[col(c1)], g[col(c1 + 1)], g[col(c1 + 2)], tc);
    };
    return cubic(across(r1 - 1), across(r1), across(r1 + 1), across(r1 + 2), tr);
  };
}

// Builds the smooth lookups for every layer from server data, for "now" (day = null)
// or for a forecast day (0 = today, 1 = tomorrow, ...).
function buildSamplers(data, wrap, day, hour) {
  const at = whenInstant(day, hour);
  const out = {};
  let grids;
  if (at != null) {
    // A time of day: blend the two hourly snapshots around it. (Zoomed-in detail has no
    // hourly data, so it steps aside and the world grid is used.)
    grids = data.hourly && hourGrids(data.hourly, at, ["feels", "uv", "wind", "dir"]);
    if (!grids && wrap) grids = dayGrids(data, day ?? 0); // hourly still loading: show the day instead
  } else {
    grids = day == null ? data.layers || { feels: data.grid } : dayGrids(data, day);
  }
  if (!grids || !grids.feels) return out;
  for (const key of ["feels", "uv", "wind"]) {
    if (grids[key]) out[key] = makeSampler(data.lats, data.lons, grids[key], wrap);
  }
  const parts = grids.wu ? grids : grids.wind && grids.dir && windParts(grids.wind, grids.dir);
  if (parts) {
    out.wu = makeSampler(data.lats, data.lons, parts.wu, wrap);
    out.wv = makeSampler(data.lats, data.lons, parts.wv, wrap);
  }
  const air = data.air;
  const airGrid =
    at != null ? data.airHourly && (hourGrids(data.airHourly, at, ["aqi"]) || {}).aqi : air && (day == null ? air.grid : air.days && air.days[day]);
  if (air && airGrid) out.aqi = makeSampler(air.lats, air.lons, airGrid, wrap);
  return out;
}

const dayGrids = (data, day) =>
  data.days && { feels: data.days.feels[day], uv: data.days.uv[day], wind: data.days.wind[day], dir: data.days.dir[day] };

// The world at moment `at`, blended from the hourly snapshots on either side; null if out of range.
// Wind direction is blended as east/north parts so it turns smoothly instead of spinning.
function hourGrids(h, at, keys) {
  const pos = (at - Date.parse(h.start)) / (h.step * 3600 * 1000);
  const i = Math.floor(pos);
  const first = h[keys[0]];
  if (!first || i < 0 || i >= first.length) return null;
  const j = Math.min(i + 1, first.length - 1);
  const k = pos - i;
  const mix = (a, b) => a.map((row, r) => row.map((v, c) => (v == null ? b[r][c] : b[r][c] == null ? v : v + (b[r][c] - v) * k)));
  const out = {};
  for (const key of keys) if (key !== "dir") out[key] = mix(h[key][i], h[key][j]);
  if (keys.includes("dir")) {
    const p = windParts(h.wind[i], h.dir[i]);
    const q = windParts(h.wind[j], h.dir[j]);
    out.wu = mix(p.wu, q.wu);
    out.wv = mix(p.wv, q.wv);
  }
  return out;
}

// Best estimate anywhere for a layer: the sharp zoomed-in grid where we have it,
// blended gently into the world grid near its edges so there's no visible seam.
function valueAt(key, lat, lon) {
  const g = worldMap.global[key];
  if (!g) return null;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180; // the map wraps, so 200°E is the same as 160°W
  // UV, wind and air can't go below 0 (the smooth curve can dip slightly negative near zeros).
  const fix = (v) => (key === "uv" || key === "wind" || key === "aqi" ? Math.max(0, v) : v);
  const base = fix(g(lat, lon));
  const d = worldMap.detail;
  const ds = d && d.samples[key];
  if (!ds) return base;
  const { s, w, n, e } = d.bounds;
  if (lat <= s || lat >= n || lon <= w || lon >= e) return base;
  const edge = Math.min((lat - s) / (n - s), (n - lat) / (n - s), (lon - w) / (e - w), (e - lon) / (e - w));
  const k = Math.min(1, edge / 0.12);
  return k * fix(ds(lat, lon)) + (1 - k) * base;
}
const feelsLikeAt = (lat, lon) => valueAt("feels", lat, lon);

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unmercY = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

// Paints the danger zones for an area into a canvas (Web Mercator, to line up with the map).
function paintHeat(canvas, bounds, width, height) {
  const { s, w, n, e } = bounds;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(width, height);
  const data = img.data;
  const levels = new Uint8Array(width * height);
  const profile = currentProfile();
  const yN = mercY(n);
  const yS = mercY(s);
  const lats = Float64Array.from({ length: height }, (_, py) => unmercY(yN - ((py + 0.5) / height) * (yN - yS)));
  const lons = Float64Array.from({ length: width }, (_, px) => w + ((px + 0.5) / width) * (e - w));
  const layer = MAP_LAYERS[worldMap.layer];
  if (!layer.zones) {
    // A number layer: a smooth color scale, with white lines where it crosses a threshold.
    const outlines = typeof layer.outlines === "function" ? layer.outlines() : layer.outlines;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const v = valueAt(worldMap.layer, lats[py], lons[px]);
        if (v == null) continue;
        const [R, G, B] = layerColor(layer, v);
        const i = py * width + px;
        levels[i] = outlines.reduce((count, t) => count + (v >= t ? 1 : 0), 0);
        data[i * 4] = R;
        data[i * 4 + 1] = G;
        data[i * 4 + 2] = B;
        data[i * 4 + 3] = 255;
      }
    }
  } else {
  // Zones are big and smooth: check every STEP pixels first, and only work out single pixels
  // in cells whose corners disagree (the zone edges). Much faster than checking every pixel.
  const STEP = 4;
  const gw = Math.ceil((width - 1) / STEP) + 1;
  const gh = Math.ceil((height - 1) / STEP) + 1;
  const coarse = new Int8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      coarse[gy * gw + gx] = zoneLevelAt(lats[Math.min(gy * STEP, height - 1)], lons[Math.min(gx * STEP, width - 1)], profile);
    }
  }
  for (let py = 0; py < height; py++) {
    const gy = Math.floor(py / STEP);
    for (let px = 0; px < width; px++) {
      const gx = Math.floor(px / STEP);
      const a = coarse[gy * gw + gx];
      const same =
        a === coarse[gy * gw + Math.min(gx + 1, gw - 1)] &&
        a === coarse[Math.min(gy + 1, gh - 1) * gw + gx] &&
        a === coarse[Math.min(gy + 1, gh - 1) * gw + Math.min(gx + 1, gw - 1)];
      const level = same ? a : zoneLevelAt(lats[py], lons[px], profile);
      if (level < 0) continue;
      const { color, alpha } = ZONES[level];
      const i = py * width + px;
      levels[i] = level;
      data[i * 4] = color[0];
      data[i * 4 + 1] = color[1];
      data[i * 4 + 2] = color[2];
      data[i * 4 + 3] = 255 * alpha;
    }
  }
  }
  // Thin white outlines around each zone or threshold.
  for (let py = 0; py < height - 1; py++) {
    for (let px = 0; px < width - 1; px++) {
      const i = py * width + px;
      if (!data[i * 4 + 3] || !data[(i + 1) * 4 + 3] || !data[(i + width) * 4 + 3]) continue;
      if (levels[i] !== levels[i + 1] || levels[i] !== levels[i + width]) {
        for (let k = 0; k < 3; k++) data[i * 4 + k] = data[i * 4 + k] * 0.3 + 255 * 0.7;
        data[i * 4 + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Layer tabs (Danger, Feels like, UV, Air), the legend, and a "Wind" switch that draws moving gusts.
function setupMapControls() {
  const bar = document.getElementById("mapLayers");
  for (const [key, layer] of Object.entries(MAP_LAYERS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "layer-btn";
    b.dataset.layer = key;
    b.setAttribute("role", "tab");
    b.textContent = layer.button;
    b.addEventListener("click", () => setLayer(key));
    bar.appendChild(b);
  }
  const legend = document.getElementById("zoneLegend");
  for (const [level, zone] of ZONES.entries()) {
    const item = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.className = `zone-${level}`;
    item.append(swatch, zone.name.replace(" zone", ""));
    legend.appendChild(item);
  }
  setLayer(worldMap.layer, true);

  const toggle = document.getElementById("mapWind");
  const show = () => {
    toggle.setAttribute("aria-pressed", worldMap.showWind);
    windFlow.update(true);
  };
  toggle.addEventListener("click", () => {
    worldMap.showWind = !worldMap.showWind;
    store.set("mapWind", worldMap.showWind);
    show();
  });
  show();
}

function setLayer(key, initial) {
  if (!MAP_LAYERS[key]) key = "danger";
  worldMap.layer = key;
  store.set("mapLayer", key);
  const layer = MAP_LAYERS[key];
  for (const b of document.querySelectorAll(".layer-btn")) b.setAttribute("aria-selected", b.dataset.layer === key);
  // Danger: four zone swatches. Number layers: a color bar with tick marks.
  document.getElementById("zoneLegend").hidden = !layer.zones;
  document.getElementById("gradLegend").hidden = !!layer.zones;
  if (!layer.zones) {
    const lo = layer.stops[0][0];
    const hi = layer.stops[layer.stops.length - 1][0];
    const pct = (v) => (((v - lo) / (hi - lo)) * 100).toFixed(1) + "%";
    document.getElementById("legendBar").style.background =
      "linear-gradient(to right, " + layer.stops.map(([v, c]) => `rgb(${c.map(Math.round).join(",")}) ${pct(v)}`).join(", ") + ")";
    const ticks = document.getElementById("legendTicks");
    ticks.innerHTML = "";
    for (const v of layer.ticks) {
      const span = document.createElement("span");
      span.style.left = pct(v);
      span.textContent = layer.tickLabel(v);
      ticks.appendChild(span);
    }
    const ends = document.getElementById("legendEnds");
    ends.innerHTML = "";
    for (const text of layer.ends) {
      const span = document.createElement("span");
      span.textContent = text;
      ends.appendChild(span);
    }
  }
  if (!initial) redrawHeat(true);
  updateMapStatus();
}

// ---------- Map setup ----------

const worldMap = {
  layer: MAP_LAYERS[store.get("mapLayer", "danger")] ? store.get("mapLayer", "danger") : "danger",
  status: document.getElementById("mapStatus"),
  map: null,
  showWind: store.get("mapWind", false), // moving gusts over the zones when zoomed in
  global: {}, // samplers per layer for the chosen day: feels, uv, wind, wu, wv, aqi
  day: null, // null = right now; 0 = today's forecast, 1 = tomorrow, ...
  hour: null, // null = all day (or now); 0-23 = that hour, your time
  worldData: null,
  detailData: null,
  detail: null, // { samples, bounds }
  youMarker: null,
  detailCache: new Map(),
  detailRequest: 0,
  heatCanvases: [document.createElement("canvas"), document.createElement("canvas")],
  heatReady: false,
};

function initMap() {
  const map = new maplibregl.Map({
    container: "worldMap",
    style: "https://tiles.openfreemap.org/styles/positron",
    center: [-30, 25],
    zoom: 1.2,
    minZoom: 0.6,
    maxZoom: 17,
    // Wraps around like a globe: keep dragging east or west and the world repeats seamlessly.
    renderWorldCopies: true,
    dragRotate: false,
    pitchWithRotate: false,
    cooperativeGestures: false,
    attributionControl: { compact: true, customAttribution: 'Weather: <a href="https://open-meteo.com/">Open-Meteo</a>' },
  });
  map.touchZoomRotate.disableRotation();
  // While the mouse is anywhere over the map (including its buttons and popups),
  // the scroll wheel zooms the map and never scrolls the page.
  map.getContainer().addEventListener(
    "wheel",
    (e) => {
      if (e.cancelable) e.preventDefault();
      const overMap = e.target === map.getCanvas() || map.getCanvasContainer().contains(e.target);
      if (!overMap) {
        // Over a button or popup: MapLibre ignores these, so zoom around the cursor ourselves.
        const rect = map.getContainer().getBoundingClientRect();
        const around = map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
        map.zoomTo(map.getZoom() - Math.sign(e.deltaY) * 0.5, { around, duration: 200 });
      }
    },
    { passive: false, capture: true }
  );

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
  map.addControl(new FindMeControl(), "top-left");
  map.addControl(new maplibregl.FullscreenControl(), "top-left");

  map.on("load", () => {
    // Keep the credits tucked behind the small ⓘ button until tapped.
    const attrib = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
    if (attrib) attrib.classList.remove("maplibregl-compact-show");
    styleLabels(map);
    // Temperature colors go above land and water but below rivers, roads, borders and names.
    // Two pieces, because one picture can't cross the date line (±180°); the map
    // repeats them around the globe as you keep scrolling.
    for (const id of HEAT_PIECES) {
      map.addSource(id, { type: "image", url: blankImage(), coordinates: [[-1, 1], [1, 1], [1, -1], [-1, -1]] });
      map.addLayer(
        { id, type: "raster", source: id, paint: { "raster-opacity": 0, "raster-fade-duration": 0, "raster-resampling": "linear" } },
        "waterway"
      );
    }
    // Make the land stand out: oceans get a soft white wash over the colors,
    // and coastlines get a crisp dark outline.
    map.addLayer(
      {
        id: "water_wash",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "water",
        paint: { "fill-color": "#ffffff", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.42, 6, 0.3, 10, 0.15] },
      },
      "waterway"
    );
    map.addLayer(
      {
        id: "coastline",
        type: "line",
        source: "openmaptiles",
        "source-layer": "water",
        filter: ["!=", ["get", "class"], "swimming_pool"],
        layout: { "line-join": "round" },
        paint: {
          "line-color": "rgba(15,23,42,0.6)",
          "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 4, 1, 10, 1.4],
        },
      },
      "waterway"
    );
    worldMap.heatReady = true;
    setupAlertIcons(map);
    redrawHeat(true);
  });

  map.on("move", () => redrawHeat(false));
  map.on("moveend", () => {
    redrawHeat(true);
    scheduleDetail();
  });
  map.on("click", (e) => {
    // Tapping an alert icon opens the alert instead of the place's conditions.
    if (map.getLayer("alert-icons") && map.queryRenderedFeatures(e.point, { layers: ["alert-icons"] }).length) return;
    showSpot(e.lngLat.wrap());
  });

  worldMap.map = map;
  addHoverReadout(map);
  // Label on the map saying which forecast day is showing.
  const pill = document.createElement("div");
  pill.id = "mapDayPill";
  pill.className = "map-day-pill";
  pill.hidden = true;
  map.getContainer().appendChild(pill);
  windFlow.attach(map);
}

// Clearer place names: darker text with a white outline so they read over any color.
function styleLabels(map) {
  for (const layer of map.getStyle().layers) {
    if (layer.type !== "symbol") continue;
    const isPlace = layer["source-layer"] === "place";
    const isWater = layer["source-layer"] === "water_name";
    if (layer.id === "label_state") continue; // styled below
    if (isPlace) {
      const big = /country|city/.test(layer.id);
      map.setLayoutProperty(layer.id, "text-font", [big ? "Noto Sans Bold" : "Noto Sans Regular"]);
      map.setPaintProperty(layer.id, "text-color", /country/.test(layer.id) ? "#334155" : "#1f2937");
      map.setPaintProperty(layer.id, "text-halo-color", "rgba(255,255,255,0.92)");
      map.setPaintProperty(layer.id, "text-halo-width", 1.6);
      map.setPaintProperty(layer.id, "text-halo-blur", 0.4);
    } else if (isWater) {
      map.setPaintProperty(layer.id, "text-color", "#1e5a8a");
      map.setPaintProperty(layer.id, "text-halo-color", "rgba(255,255,255,0.85)");
      map.setPaintProperty(layer.id, "text-halo-width", 1.4);
    }
  }
  // Country borders a little stronger so you can tell where you are.
  for (const id of ["boundary_2", "boundary_3"]) {
    if (map.getLayer(id)) map.setPaintProperty(id, "line-color", "rgba(51,65,85,0.55)");
  }

  // State and province borders (US states, Canadian provinces, etc.), from country-level zoom.
  // The built-in style only draws them very close in, so add our own layer.
  map.addLayer(
    {
      id: "state_borders",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      minzoom: 2.5,
      filter: ["all", ["in", ["get", "admin_level"], ["literal", [3, 4]]], ["!=", ["get", "maritime"], 1]],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "rgba(51,65,85,0.5)",
        "line-width": ["interpolate", ["linear"], ["zoom"], 2.5, 0.5, 5, 1, 9, 1.6],
        "line-dasharray": [3, 2],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 2.5, 0, 3.2, 1],
      },
    },
    "boundary_2"
  );
  // The built-in layer handles counties when zoomed far in.
  if (map.getLayer("boundary_3")) map.setFilter("boundary_3", ["all", [">=", ["get", "admin_level"], 5], ["<=", ["get", "admin_level"], 6], ["!=", ["get", "maritime"], 1]]);

  // Zoomed far out: only big continent names. Country names appear as you zoom in.
  const CONTINENT_ZOOM = 2.2;
  map.addLayer({
    id: "label_continent",
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "place",
    maxzoom: CONTINENT_ZOOM,
    // The data also has an "Americas" label in Central America; North and South America are enough.
    filter: ["all", ["==", ["get", "class"], "continent"], ["!=", ["coalesce", ["get", "name_en"], ["get", "name"]], "Americas"]],
    layout: {
      "text-field": ["coalesce", ["get", "name_en"], ["get", "name"]],
      "text-font": ["Noto Sans Bold"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 0, 12, 2, 16],
      "text-transform": "uppercase",
      "text-letter-spacing": 0.18,
      "text-max-width": 8,
    },
    paint: {
      "text-color": "#0f172a",
      "text-halo-color": "rgba(255,255,255,0.95)",
      "text-halo-width": 2,
      "text-halo-blur": 0.5,
    },
  });
  for (const id of ["label_country_1", "label_country_2", "label_country_3"]) {
    if (map.getLayer(id)) map.setLayerZoomRange(id, CONTINENT_ZOOM, 9);
  }
  // Country borders stay faint until country names appear, so continents read as one shape.
  if (map.getLayer("boundary_2")) {
    map.setPaintProperty("boundary_2", "line-opacity", ["interpolate", ["linear"], ["zoom"], 1, 0.2, CONTINENT_ZOOM, 0.35, CONTINENT_ZOOM + 0.6, 1]);
  }

  // State names: show from country-level zoom, in spaced capitals like a classic atlas.
  if (map.getLayer("label_state")) {
    map.setLayerZoomRange("label_state", 3, 9);
    map.setLayoutProperty("label_state", "text-font", ["Noto Sans Bold"]);
    map.setLayoutProperty("label_state", "text-size", ["interpolate", ["linear"], ["zoom"], 3, 9, 5, 11.5, 8, 14]);
    map.setLayoutProperty("label_state", "text-letter-spacing", 0.12);
    map.setPaintProperty("label_state", "text-color", "rgba(51,65,85,0.85)");
    map.setPaintProperty("label_state", "text-halo-color", "rgba(255,255,255,0.85)");
    map.setPaintProperty("label_state", "text-halo-width", 1.4);
  }
}

function blankImage() {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  return c.toDataURL();
}

// Redraw the colors for the visible area plus a wide margin, so zooming or
// dragging quickly always has color ready. Low detail while moving, full detail when it stops.
let lastQuickDraw = 0;
function redrawHeat(full) {
  const { map } = worldMap;
  if (!map || !worldMap.heatReady || !worldMap.global.feels) return;
  const now = performance.now();
  if (!full && now - lastQuickDraw < 120) return;
  lastQuickDraw = now;

  const b = map.getBounds();
  const spanLon = b.getEast() - b.getWest();
  const yN0 = mercY(Math.min(b.getNorth(), 85));
  const yS0 = mercY(Math.max(b.getSouth(), -85));
  const padY = (yN0 - yS0) * 0.6;
  const n = Math.min(unmercY(yN0 + padY), 85);
  const s = Math.max(unmercY(yS0 - padY), -85);
  let w = b.getWest() - spanLon * 0.6;
  let e = b.getEast() + spanLon * 0.6;
  // The map wraps, so this area can run past ±180°. Shift it into the -180..180 world and
  // split it at the date line; the map repeats both pieces around the globe.
  let pieces;
  if (e - w >= 360) {
    pieces = [[-180, 180]];
  } else {
    const w0 = ((((w + 180) % 360) + 360) % 360) - 180;
    const e0 = w0 + (e - w);
    pieces = e0 <= 180 ? [[w0, e0]] : [[w0, 180], [-180, e0 - 360]];
  }

  const container = map.getContainer();
  const scale = full ? 0.75 : 0.35;
  const totalWidth = Math.max(64, Math.min(1400, Math.round(container.clientWidth * 2.2 * scale)));
  const totalSpan = pieces.reduce((sum, [pw, pe]) => sum + (pe - pw), 0);

  HEAT_PIECES.forEach((id, k) => {
    const piece = pieces[k];
    if (!piece || piece[1] - piece[0] < 0.01) {
      map.setPaintProperty(id, "raster-opacity", 0);
      return;
    }
    const [pw, pe] = piece;
    const width = Math.max(16, Math.round((totalWidth * (pe - pw)) / totalSpan));
    const height = Math.max(16, Math.min(1400, Math.round((width * (mercY(n) - mercY(s))) / (((pe - pw) * Math.PI) / 180))));
    const canvas = worldMap.heatCanvases[k];
    paintHeat(canvas, { s, w: pw, n, e: pe }, width, height);
    map.getSource(id).updateImage({ url: canvas.toDataURL(), coordinates: [[pw, n], [pe, n], [pe, s], [pw, s]] });
    map.setPaintProperty(id, "raster-opacity", HEAT_OPACITY);
  });
}

// "Find me" button under the zoom buttons.
class FindMeControl {
  onAdd(map) {
    this.el = document.createElement("div");
    this.el.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "find-me";
    btn.title = "Go to my location";
    btn.setAttribute("aria-label", "Go to my location");
    btn.textContent = "◎";
    btn.addEventListener("click", () => {
      const place = typeof state !== "undefined" ? state.place : null;
      if (place) map.flyTo({ center: [place.lon, place.lat], zoom: Math.max(map.getZoom(), 8), duration: 1600 });
    });
    this.el.appendChild(btn);
    return this.el;
  }
  onRemove() {
    this.el.remove();
  }
}

// On computers: a small label follows the mouse showing the zone there and the numbers behind it.
function addHoverReadout(map) {
  if (!window.matchMedia || !window.matchMedia("(hover: hover)").matches) return;
  const container = map.getContainer();
  const tip = document.createElement("div");
  tip.className = "map-readout";
  tip.hidden = true;
  container.appendChild(tip);
  map.on("mousemove", (e) => {
    const { lat, lng } = e.lngLat.wrap();
    const layer = MAP_LAYERS[worldMap.layer];
    const zone = zoneAt(lat, lng, currentProfile());
    if (!zone) {
      tip.hidden = true;
      return;
    }
    if (!layer.zones) {
      // Number layers: that layer's reading, with the danger zone underneath.
      const v = valueAt(worldMap.layer, lat, lng);
      if (v == null) {
        tip.hidden = true;
        return;
      }
      const title = document.createElement("b");
      title.textContent = layer.readout(v);
      const stats = document.createElement("span");
      stats.className = "map-readout-stats";
      stats.textContent = ZONES[zone.level].name + forWhom();
      tip.replaceChildren(title, stats);
      placeTip(e);
      return;
    }
    const v = zone.values;
    const title = document.createElement("b");
    title.textContent = ZONES[zone.level].name + forWhom();
    const reason = zoneReason(zone.hazards, zone.level);
    const stats = document.createElement("span");
    stats.className = "map-readout-stats";
    stats.textContent = [
      // Forecast days hold each place's most extreme feels-like: the day's high, or its low where cold is the bigger risk.
      `${worldMap.day == null || worldMap.hour != null ? "Feels like" : v.feels < 65 ? "Feels like down to" : "Feels like up to"} ~${Math.round(v.feels)}°F`,
      `UV ${Math.round(v.uv)}`,
      v.aqi != null ? `Air ${Math.round(v.aqi)}` : null,
      `Wind ${Math.round(v.wind)} mph`,
    ]
      .filter(Boolean)
      .join(" · ");
    tip.replaceChildren(title, reason ? ` ${reason}` : "", stats);
    placeTip(e);
  });
  // Keep the label inside the map: flip it to the other side of the pointer near the edges.
  function placeTip(e) {
    tip.hidden = false;
    const flipX = e.point.x + 14 + tip.offsetWidth > container.clientWidth - 8;
    const flipY = e.point.y + 14 + tip.offsetHeight > container.clientHeight - 8;
    tip.style.left = (flipX ? Math.max(8, e.point.x - 14 - tip.offsetWidth) : e.point.x + 14) + "px";
    tip.style.top = (flipY ? e.point.y - 14 - tip.offsetHeight : e.point.y + 14) + "px";
  }
  container.addEventListener("mouseleave", () => (tip.hidden = true));
}

// ---------- Official alert icons (US) ----------
// Small icons where the National Weather Service has active alerts: likely power outages,
// fire weather, flooding, tornadoes and more. Tap one for the alert itself.

const ALERT_ICON_ZOOM = 4;
const ALERT_ICONS = {
  // kind: [emoji, ring color, label] - in order of importance (shown first when icons crowd)
  tornado: ["🌪️", "#6741d9", "Tornado"],
  flood: ["🌊", "#1c7ed6", "Flooding"],
  fire: ["🔥", "#e8590c", "Fire weather"],
  outage: ["⚡", "#f0a500", "Power outages possible"],
  storm: ["⛈️", "#495057", "Severe storms"],
  heat: ["🌡️", "#c92a2a", "Extreme heat"],
  cold: ["❄️", "#4dabf7", "Extreme cold"],
  snow: ["🌨️", "#74c0fc", "Snow and ice"],
  air: ["🌫️", "#868e96", "Bad air or smoke"],
  dust: ["💨", "#a0785a", "Dust storm"],
};

function alertIconImage(emoji, ring) {
  const size = 64; // drawn at 2x for sharp icons
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(0,0,0,.35)";
  ctx.shadowBlur = 4;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 5;
  ctx.strokeStyle = ring;
  ctx.stroke();
  ctx.font = "30px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, size / 2, size / 2 + 2);
  return ctx.getImageData(0, 0, size, size);
}

async function setupAlertIcons(map) {
  for (const [kind, [emoji, ring]] of Object.entries(ALERT_ICONS)) map.addImage(`alert-${kind}`, alertIconImage(emoji, ring), { pixelRatio: 2 });
  map.addSource("alerts", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const rank = ["match", ["get", "kind"], ...Object.keys(ALERT_ICONS).flatMap((k, i) => [k, i]), 99];
  map.addLayer({
    id: "alert-icons",
    type: "symbol",
    source: "alerts",
    minzoom: ALERT_ICON_ZOOM, // zoomed out, the colors stay clean; icons appear at about state level
    layout: {
      "icon-image": ["concat", "alert-", ["get", "kind"]],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 1, 0.6, 5, 0.85, 9, 1],
      "symbol-sort-key": rank, // when icons crowd, the most serious kinds stay
    },
  });
  map.on("mouseenter", "alert-icons", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "alert-icons", () => (map.getCanvas().style.cursor = ""));
  map.on("click", "alert-icons", (e) => showAlertPopup(e.features[0], e.lngLat));

  const load = async () => {
    try {
      const data = await getJson("api/alert-map");
      map.getSource("alerts").setData(data);
      updateAlertLegend(data.features);
    } catch {
      // Alerts are a bonus; the map works without them.
    }
  };
  await load();
  setInterval(load, 10 * 60 * 1000);
}

function showAlertPopup(feature, lngLat) {
  const p = feature.properties;
  const [emoji, , label] = ALERT_ICONS[p.kind] || ["⚠️", "", "Alert"];
  const box = document.createElement("div");
  box.className = "spot";
  const title = document.createElement("b");
  title.textContent = `${emoji} ${label}`;
  const event = document.createElement("p");
  event.className = "spot-when";
  const ends = p.ends ? new Date(p.ends) : null;
  event.textContent = p.event + (ends && !isNaN(ends) ? ` · until ${ends.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "");
  const area = document.createElement("p");
  area.textContent = p.area;
  const headline = document.createElement("p");
  headline.className = "spot-headline";
  headline.textContent = p.headline;
  box.append(title, event, area, headline);
  const source = document.createElement("small");
  source.className = "spot-source";
  source.textContent = "Official alert from the National Weather Service";
  box.appendChild(source);
  new maplibregl.Popup({ maxWidth: "280px", offset: 14 }).setLngLat(lngLat).setDOMContent(box).addTo(worldMap.map);
}

// "Official alerts: ⚡ Power outages possible · 🔥 Fire weather ..." for the kinds showing now.
function updateAlertLegend(features) {
  const legend = document.getElementById("alertLegend");
  const kinds = Object.keys(ALERT_ICONS).filter((k) => features.some((f) => f.properties.kind === k));
  legend.hidden = !kinds.length;
  legend.innerHTML = "";
  const head = document.createElement("b");
  head.textContent = "US alerts (zoom in to see them):";
  legend.appendChild(head);
  for (const k of kinds) {
    const span = document.createElement("span");
    span.textContent = `${ALERT_ICONS[k][0]} ${ALERT_ICONS[k][2]}`;
    legend.appendChild(span);
  }
}

// Called by app.js whenever the checked place changes: moves the "you" pin.
function drawWorldMap() {
  const { map } = worldMap;
  const place = typeof state !== "undefined" ? state.place : null;
  if (!map || !place) return;
  // A different person (or a change to them) redraws the zones for them.
  const p = currentProfile();
  const who = `${p.heat},${p.cold},${p.air},${p.uv},${forWhom()}`;
  if (worldMap.who !== who) {
    if (worldMap.who != null) {
      redrawHeat(true);
      updateMapStatus();
    }
    worldMap.who = who;
  }
  const lngLat = [place.lon, place.lat];
  if (!worldMap.youMarker) {
    const dot = document.createElement("div");
    dot.className = "you-dot";
    dot.title = "You're checking here";
    worldMap.youMarker = new maplibregl.Marker({ element: dot }).setLngLat(lngLat).addTo(map);
    map.jumpTo({ center: lngLat, zoom: 3 }); // start the map around you
  } else {
    worldMap.youMarker.setLngLat(lngLat);
  }
}

async function loadWorldMap() {
  try {
    setupMapControls();
    initMap();
  } catch {
    worldMap.status.textContent = "The world map isn't available right now.";
    return;
  }
  try {
    // On a brand-new server the world grid takes ~2½ minutes to build; check back until it's ready.
    let data;
    for (;;) {
      const res = await fetch("api/world");
      if (res.ok) {
        data = await res.json();
        break;
      }
      if (res.status !== 503) throw new Error(res.status);
      worldMap.status.textContent = "Gathering weather from around the world (about 3 minutes the first time)...";
      await new Promise((r) => setTimeout(r, 20000));
    }
    worldMap.worldData = data;
    worldMap.global = buildSamplers(data, true, worldMap.day, worldMap.hour);
    updateMapStatus();
    if (!data.hourly) recheckForForecast();
    redrawHeat(true);
    drawWorldMap();
    windFlow.update();
  } catch {
    worldMap.status.textContent = "Map colors aren't available right now. Try again later.";
  }
}

// ---------- Day and time ----------
// The When bar above the results (app.js) picks a day and time for everything, map included.

// The moment the chosen day and hour stand for, in your own time (ms), or null for "now" / "all day".
function whenInstant(day, hour) {
  if (hour == null) return null;
  const d = dayDate(day ?? 0);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

// Called by app.js when the When bar changes.
function setMapWhen(day, hour) {
  worldMap.day = day;
  worldMap.hour = hour;
  if (!worldMap.worldData) return;
  worldMap.global = buildSamplers(worldMap.worldData, true, day, hour);
  if (worldMap.detailData && worldMap.detail) worldMap.detail.samples = buildSamplers(worldMap.detailData, false, day, hour);
  updateMapStatus();
  redrawHeat(true);
  windFlow.update(true);
}

// The server may still be gathering the forecast; check back each minute until it's there.
function recheckForForecast() {
  setTimeout(async () => {
    try {
      const data = await getJson("api/world");
      if (!data.hourly) return recheckForForecast();
      worldMap.worldData = data;
      worldMap.global = buildSamplers(data, true, worldMap.day, worldMap.hour);
      updateMapStatus();
      redrawHeat(true);
    } catch {
      recheckForForecast();
    }
  }, 60000);
}

function updateMapStatus() {
  const data = worldMap.worldData;
  if (!data) return;
  const pill = document.getElementById("mapDayPill");
  const day = worldMap.day;
  const hour = worldMap.hour;
  const person = typeof activePerson === "function" && activePerson();
  const who = person && person.name ? person.name : "you";
  const dayWords = day === 0 ? "today" : "on " + dayLabel(day, { weekday: "long" });
  const when = day == null ? "right now" : hour != null ? `${dayWords} at ${hourLabel(hour)} your time (forecast)` : `${dayWords} (forecast)`;
  const layer = MAP_LAYERS[worldMap.layer];
  document.getElementById("mapDescription").textContent = layer.zones
    ? `Where it's safe or dangerous for ${who} ${when}, from heat or cold, strong sun, unhealthy air and strong wind. ` +
      "Hover or tap anywhere to see the numbers."
    : layer.description.replace("right now", when);
  if (day == null) {
    pill.hidden = true;
    const mins = Math.round((Date.now() - Date.parse(data.updated)) / 60000);
    worldMap.status.textContent =
      `Updated ${mins < 2 ? "just now" : mins + " minutes ago"}. Rain, snow and storms show when you tap a place.` +
      (data.days ? "" : " Forecast days are still loading.");
    return;
  }
  pill.hidden = false;
  pill.textContent = (day === 0 ? "Today" : dayLabel(day, { weekday: "long", month: "short", day: "numeric" })) + (hour != null ? ` · ${hourLabel(hour)}` : "");
  if (hour != null) {
    const hourly = !!(data.hourly && hourGrids(data.hourly, whenInstant(day, hour), ["feels"]));
    worldMap.status.textContent = hourly
      ? `Forecast for ${hourLabel(hour)} your time, everywhere at once (so it's night on the other side of the world).` +
        (worldMap.global.aqi ? "" : " Air quality forecasts only go about 5 days ahead.") +
        " Tap anywhere for that place's forecast."
      : "Hour-by-hour map data is still loading or doesn't reach this far, so the map shows the whole day.";
    return;
  }
  worldMap.status.textContent =
    `Forecast: showing ${layer.daily || "each place's worst for the day"}.` +
    (worldMap.global.aqi ? "" : " Air quality forecasts only go about 5 days ahead, so air isn't included this far out.") +
    " Tap anywhere for that place's full forecast.";
}

// ---------- Sharper colors when zoomed in ----------

let detailTimer;
function scheduleDetail() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(loadDetail, 250);
}

async function loadDetail() {
  const { map } = worldMap;
  if (map.getZoom() < DETAIL_ZOOM) return; // keep the last sharp area; it only refines, never hides
  // Ask for at least a 1° area so zooming into a single town still gets a useful grid.
  const b = map.getBounds();
  const c = b.getCenter().wrap();
  const halfLat = Math.max(((b.getNorth() - b.getSouth()) / 2) * 1.3, 0.5);
  const halfLon = Math.max(((b.getEast() - b.getWest()) / 2) * 1.3, 0.5);
  const params = new URLSearchParams({
    s: (c.lat - halfLat).toFixed(2), w: (c.lng - halfLon).toFixed(2),
    n: (c.lat + halfLat).toFixed(2), e: (c.lng + halfLon).toFixed(2),
  });
  const key = params.toString();
  const id = ++worldMap.detailRequest;
  try {
    let data = worldMap.detailCache.get(key);
    if (!data) {
      data = await getJson("api/area?" + key);
      worldMap.detailCache.set(key, data);
    }
    if (id !== worldMap.detailRequest) return; // the map moved again
    worldMap.detailData = data;
    worldMap.detail = { samples: buildSamplers(data, false, worldMap.day, worldMap.hour), bounds: data.bounds };
    redrawHeat(true);
  } catch {
    // Too many requests or offline: the world colors still show everywhere.
  }
}

// ---------- Tap a spot ----------

async function showSpot(lngLat) {
  if (worldMap.day != null || worldMap.hour != null) return showSpotForecast(lngLat, worldMap.day ?? 0, worldMap.hour);
  const { lat, lng } = lngLat;
  const box = document.createElement("div");
  box.className = "spot";
  box.textContent = "Looking this up...";
  const popup = new maplibregl.Popup({ maxWidth: "260px", offset: 8 }).setLngLat(lngLat).setDOMContent(box).addTo(worldMap.map);

  const geoUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&localityLanguage=en`;
  const wxUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    "&current=temperature_2m,apparent_temperature,weather_code,is_day,uv_index,wind_speed_10m,wind_gusts_10m,precipitation,snowfall,relative_humidity_2m" +
    "&precipitation_unit=inch" +
    "&temperature_unit=fahrenheit&wind_speed_unit=mph";
  const airUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&current=us_aqi`;
  const [geo, wx, air] = await Promise.all([
    getJson(geoUrl).catch(() => null),
    getJson(wxUrl).catch(() => null),
    getJson(airUrl).catch(() => null),
  ]);
  if (!popup.isOpen()) return;

  const name = placeName(geo) || formatLatLon(lat, lng);
  box.innerHTML = "";
  const title = document.createElement("b");
  title.textContent = name;
  box.appendChild(title);

  if (wx && wx.current) {
    const feels = Math.round(wx.current.apparent_temperature);
    const actual = Math.round(wx.current.temperature_2m);
    const [icon, desc] = weatherInfo(wx.current.weather_code, wx.current.is_day === 1);
    const aqiNow = air && air.current && air.current.us_aqi != null ? air.current.us_aqi : null;
    const c = wx.current;
    const hazards = assessDay(
      { feelsHi: feels, feelsLo: feels, feelsNow: feels, uv: c.uv_index ?? 0, aqi: aqiNow, wind: c.wind_speed_10m ?? 0, gust: c.wind_gusts_10m ?? 0, rain: c.precipitation ?? 0, snow: c.snowfall ?? 0, code: c.weather_code, rhMin: c.relative_humidity_2m, tempHi: c.temperature_2m },
      currentProfile()
    );
    const line1 = document.createElement("p");
    line1.textContent = `${icon} ${actual}°F, ${desc.toLowerCase()} · feels like ${feels}°F`;
    box.append(zoneChip(hazards), line1);

    // UV, air and wind as three small colored chips
    const extras = document.createElement("div");
    extras.className = "spot-extras";
    const add = (text, cls) => {
      const c = document.createElement("span");
      c.className = "chip " + cls;
      c.textContent = text;
      extras.appendChild(c);
    };
    const uv = wx.current.uv_index ?? 0;
    const uvLevel = levelOf(uv, UV_LEVELS);
    add(`☀️ UV ${Math.round(uv)}`, `uv-${uvLevel}`);
    if (aqiNow != null) add(`🌫️ Air ${Math.round(aqiNow)}`, `aqi-${levelOf(aqiNow, AQI_LEVELS)}`);
    const wind = wx.current.wind_speed_10m ?? 0;
    const gust = wx.current.wind_gusts_10m ?? 0;
    const windLevel = wind >= 40 || gust >= 58 ? 3 : wind >= 31 || gust >= 46 ? 2 : wind >= 20 || gust >= 30 ? 1 : 0;
    add(`💨 ${Math.round(wind)} mph`, `wind-${windLevel}`);
    box.appendChild(extras);
  } else {
    const p = document.createElement("p");
    p.textContent = "Couldn't get the weather here right now.";
    box.appendChild(p);
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn small";
  btn.textContent = "Check my safety here";
  btn.addEventListener("click", () => {
    popup.remove();
    usePlace({ lat: round(lat, 3), lon: round(lng, 3), name, fromGps: false });
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  box.appendChild(btn);
  // The popup grew after loading; re-place it so it flips below the point if there's no room above.
  popup.setLngLat(lngLat);
}

// Popup for a forecast day: that day's high/low, peak UV, worst air and strongest wind there.
async function showSpotForecast(lngLat, day, hour) {
  const { lat, lng } = lngLat;
  const box = document.createElement("div");
  box.className = "spot";
  box.textContent = "Looking this up...";
  const popup = new maplibregl.Popup({ maxWidth: "260px", offset: 8 }).setLngLat(lngLat).setDOMContent(box).addTo(worldMap.map);
  const at = whenInstant(day, hour);
  const date = isoDate(dayDate(day));
  const from = at != null ? isoDate(dayDate(Math.max(0, day - 1))) : date;
  const to = at != null ? isoDate(dayDate(day + 1)) : date;
  const ll = `latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}`;
  const geoUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?${ll}&localityLanguage=en`;
  const wxUrl =
    `https://api.open-meteo.com/v1/forecast?${ll}&start_date=${from}&end_date=${to}&timezone=auto` +
    (at != null ? "&hourly=temperature_2m,apparent_temperature,weather_code,is_day,uv_index,wind_speed_10m,wind_gusts_10m,precipitation_probability,relative_humidity_2m" : "") +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,uv_index_max,wind_speed_10m_max,wind_gusts_10m_max" +
    ",precipitation_sum,snowfall_sum,precipitation_probability_max,relative_humidity_2m_min" +
    "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch";
  const airUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?${ll}&start_date=${from}&end_date=${to}&hourly=us_aqi&timezone=auto`;
  const [geo, wx, air] = await Promise.all([
    getJson(geoUrl).catch(() => null),
    getJson(wxUrl).catch(() => null),
    day < 5 ? getJson(airUrl).catch(() => null) : null,
  ]);
  if (!popup.isOpen()) return;

  const name = placeName(geo) || formatLatLon(lat, lng);
  box.innerHTML = "";
  const title = document.createElement("b");
  title.textContent = name;
  const when = document.createElement("p");
  when.className = "spot-when";
  when.textContent =
    (day === 0 ? "Today" : dayLabel(day, { weekday: "long", month: "short", day: "numeric" })) +
    (at != null ? ` at ${hourLabel(hour)} your time` : "") +
    " · forecast";
  box.append(title, when);

  const dly = wx && wx.daily;
  const local = at != null && wx ? new Date(at + (wx.utc_offset_seconds || 0) * 1000).toISOString().slice(0, 13) + ":00" : null;
  const di = local && dly ? Math.max(0, dly.time.indexOf(local.slice(0, 10))) : 0;
  const hi_ = local && wx.hourly ? wx.hourly.time.indexOf(local) : -1;
  const hr = hi_ >= 0 ? wx.hourly : null;
  if (dly && dly.temperature_2m_max && dly.temperature_2m_max[di] != null) {
    const hi = Math.round(dly.temperature_2m_max[di]);
    const lo = Math.round(dly.temperature_2m_min[di]);
    const fHi = Math.round(dly.apparent_temperature_max[di]);
    const fLo = Math.round(dly.apparent_temperature_min[di]);
    const fAt = hr ? Math.round(hr.apparent_temperature[hi_]) : null;
    const [icon, desc] = hr ? weatherInfo(hr.weather_code[hi_], hr.is_day[hi_] === 1) : weatherInfo(dly.weather_code[di]);
    // That hour's air, or the worst of the place's day.
    const aqiAt = hr && air && air.hourly ? air.hourly.us_aqi[air.hourly.time.indexOf(local)] : null;
    const aqiValues = air && air.hourly ? air.hourly.us_aqi.filter((v, k) => v != null && air.hourly.time[k].startsWith(dly.time[di])) : [];
    const aqiMax = hr ? aqiAt ?? null : aqiValues.length ? Math.max(...aqiValues) : null;
    const hazards = assessDay(
      {
        feelsHi: hr ? fAt : fHi,
        feelsLo: hr ? fAt : fLo,
        uv: (hr ? hr.uv_index[hi_] : dly.uv_index_max[di]) ?? 0,
        aqi: aqiMax,
        wind: (hr ? hr.wind_speed_10m[hi_] : dly.wind_speed_10m_max[di]) ?? 0,
        gust: (hr ? hr.wind_gusts_10m[hi_] : dly.wind_gusts_10m_max[di]) ?? 0,
        rain: dly.precipitation_sum[di] ?? 0,
        rainChance: dly.precipitation_probability_max ? dly.precipitation_probability_max[di] : null,
        snow: dly.snowfall_sum[di] ?? 0,
        code: hr ? hr.weather_code[hi_] : dly.weather_code[di],
        rhMin: dly.relative_humidity_2m_min ? dly.relative_humidity_2m_min[di] : null,
        tempHi: dly.temperature_2m_max[di],
      },
      currentProfile()
    );
    const line1 = document.createElement("p");
    line1.textContent = hr
      ? `${icon} ${Math.round(hr.temperature_2m[hi_])}°F, ${desc.toLowerCase()} · feels like ${fAt}°F (${local.slice(11, 16)} there)`
      : `${icon} ${desc} · High ${hi}° / Low ${lo}° · feels like ${fLo}° to ${fHi}°F`;
    box.append(zoneChip(hazards), line1);

    const extras = document.createElement("div");
    extras.className = "spot-extras";
    const add = (text, cls) => {
      const c = document.createElement("span");
      c.className = "chip " + cls;
      c.textContent = text;
      extras.appendChild(c);
    };
    const uv = (hr ? hr.uv_index[hi_] : dly.uv_index_max[di]) ?? 0;
    add(`☀️ UV ${Math.round(uv)}`, `uv-${levelOf(uv, UV_LEVELS)}`);
    if (aqiMax != null) add(`🌫️ Air ${Math.round(aqiMax)}`, `aqi-${levelOf(aqiMax, AQI_LEVELS)}`);
    const wind = (hr ? hr.wind_speed_10m[hi_] : dly.wind_speed_10m_max[di]) ?? 0;
    const gust = (hr ? hr.wind_gusts_10m[hi_] : dly.wind_gusts_10m_max[di]) ?? 0;
    const windLevel = wind >= 40 || gust >= 58 ? 3 : wind >= 31 || gust >= 46 ? 2 : wind >= 20 || gust >= 30 ? 1 : 0;
    add(`💨 ${hr ? "" : "up to "}${Math.round(wind)} mph`, `wind-${windLevel}`);
    box.appendChild(extras);
  } else {
    const p = document.createElement("p");
    p.textContent = "Couldn't get the forecast here right now.";
    box.appendChild(p);
  }
  popup.setLngLat(lngLat);
}

// "Danger zone for Grandma" chip, with what's causing it underneath.
function zoneChip(hazards) {
  const level = overallLevel(hazards);
  const wrap = document.createElement("div");
  wrap.className = "spot-zone";
  const chip = document.createElement("span");
  chip.className = `chip zone-chip zone-${level}`;
  chip.textContent = ZONES[level].name + forWhom();
  wrap.appendChild(chip);
  const reason = zoneReason(hazards, level);
  if (reason) {
    const why = document.createElement("small");
    why.textContent = reason.charAt(0).toUpperCase() + reason.slice(1);
    wrap.appendChild(why);
  }
  if (hazards.some((h) => h.id === "outage")) {
    const outage = document.createElement("small");
    outage.textContent = "⚡ Power outage possible";
    wrap.appendChild(outage);
  }
  return wrap;
}

function placeName(geo) {
  if (!geo) return "";
  const SHORT_COUNTRY = { US: "USA", GB: "UK" }; // official names can be very long
  const country = SHORT_COUNTRY[geo.countryCode] || geo.countryName;
  // "locality" is the actual town or neighborhood (La Cañada Flintridge, Manhattan);
  // "city" can be the whole metro area (Los Angeles). Lead with the town, and add the
  // bigger city only when it's a real city around it (Manhattan, New York City), not a county-level area.
  const local = geo.locality || geo.city;
  const cityInfo = ((geo.localityInfo && geo.localityInfo.administrative) || []).find((a) => a.name === geo.city);
  const addCity = geo.city && geo.locality && geo.city !== geo.locality && !(cityInfo && cityInfo.adminLevel === 6);
  const parts = [local, addCity ? geo.city : null, geo.principalSubdivision, country].filter(Boolean);
  // drop repeats like "Singapore, Singapore"
  return parts.filter((p, i) => parts.indexOf(p) === i).join(", ");
}

function formatLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}

// ---------- Wind animation ----------
// When zoomed in, smooth wind lines follow the real path the wind takes across the map,
// spaced evenly like contour lines. A soft glow glides along each line in the direction the
// wind is blowing: faster and brighter where the wind is stronger. Zoomed out, only the colors show.

const WIND_ANIM_ZOOM = 3; // about country level

const windFlow = {
  map: null,
  canvas: null,
  ctx: null,
  hint: null,
  lines: [],
  frame: 0,
  moving: false,
  view: null,

  attach(map) {
    this.map = map;
    const container = map.getContainer();
    this.canvas = document.createElement("canvas");
    this.canvas.className = "wind-flow";
    // Right on top of the map drawing but underneath popups and the "you" dot,
    // which MapLibre adds later in the same container.
    map.getCanvasContainer().insertBefore(this.canvas, map.getCanvas().nextSibling);
    this.ctx = this.canvas.getContext("2d");
    this.hint = document.createElement("div");
    this.hint.className = "wind-hint";
    this.hint.textContent = "Zoom in to see the wind move";
    this.hint.hidden = true;
    container.appendChild(this.hint);

    map.on("movestart", () => {
      this.moving = true;
      this.clear();
    });
    const resume = () => {
      this.moving = false;
      this.update(true);
    };
    map.on("moveend", resume);
    map.on("resize", resume);
    document.addEventListener("visibilitychange", () => this.update());
  },

  // Start, stop or rebuild depending on the chosen layer, zoom, data and motion settings.
  update(rebuild) {
    if (!this.map) return;
    const windLayer = worldMap.showWind && worldMap.global.wu;
    const zoomedIn = this.map.getZoom() >= WIND_ANIM_ZOOM;
    this.hint.hidden = !(windLayer && !zoomedIn);
    const show = windLayer && zoomedIn && !document.hidden;
    if (!show) {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.clear();
      return;
    }
    if (rebuild || !this.frame) this.reset();
    if (!this.frame) {
      const still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const tick = (time) => {
        this.draw(still ? null : time);
        this.frame = still ? 0 : requestAnimationFrame(tick); // reduced motion: draw once, no animation
      };
      this.frame = requestAnimationFrame(tick);
    }
  },

  clear() {
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  },

  // Wind (mph, east and north parts) at a point on screen.
  windAt(x, y) {
    const v = this.view;
    const lon = v.west + (x / v.w) * (v.east - v.west);
    const lat = unmercY(v.yN - (y / v.h) * (v.yN - v.yS));
    const u = valueAt("wu", lat, lon);
    const n = valueAt("wv", lat, lon);
    return u == null ? null : { u, n, mph: Math.hypot(u, n) };
  },

  // Trace evenly spaced lines through the wind (each line follows the wind forward and backward
  // from a starting point, and stops when it gets too close to another line).
  reset() {
    const container = this.map.getContainer();
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.clear();
    const b = this.map.getBounds();
    this.view = {
      w, h,
      west: b.getWest(), east: b.getEast(),
      yN: mercY(Math.min(b.getNorth(), 85.05)), yS: mercY(Math.max(b.getSouth(), -85.05)),
    };

    const SPACING = w < 480 ? 72 : 84; // gap between gust paths (bigger = fewer gusts)
    const CELL = SPACING / 2;
    const cols = Math.ceil(w / CELL);
    const rows = Math.ceil(h / CELL);
    const taken = new Int32Array(cols * rows).fill(-1);
    const cellOf = (x, y) => Math.floor(y / CELL) * cols + Math.floor(x / CELL);
    const STEP = 3; // pixels per tracing step
    const MAX_STEPS = 90;

    const trace = (x, y, dirSign, id) => {
      const pts = [];
      for (let i = 0; i < MAX_STEPS; i++) {
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        const c = cellOf(x, y);
        if (taken[c] !== -1 && taken[c] !== id) break; // too close to another line
        const wind = this.windAt(x, y);
        if (!wind || wind.mph < 1.5) break;
        pts.push([x, y, wind.mph]);
        taken[c] = id;
        x += (dirSign * wind.u / wind.mph) * STEP;
        y -= (dirSign * wind.n / wind.mph) * STEP;
      }
      return pts;
    };

    this.lines = [];
    for (let sy = SPACING / 2; sy < h; sy += SPACING) {
      for (let sx = SPACING / 2; sx < w; sx += SPACING) {
        if (taken[cellOf(sx, sy)] !== -1) continue;
        const id = this.lines.length;
        const back = trace(sx, sy, -1, id).reverse();
        const fwd = trace(sx, sy, 1, id);
        const pts = back.concat(fwd.slice(1));
        if (pts.length < 14) continue; // too short to read as wind
        // Distance along the line to each point, for gliding the glow.
        const dist = [0];
        for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        const mph = pts.reduce((sum, p) => sum + p[2], 0) / pts.length;
        // Sideways direction at each point, so the bundle's lines run parallel.
        const normals = pts.map((_, i) => {
          const a = pts[Math.max(0, i - 2)];
          const b = pts[Math.min(pts.length - 1, i + 2)];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          return [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
        });
        this.lines.push({ pts, normals, dist, length: dist[dist.length - 1], mph, phase: Math.random() });
      }
    }
  },

  // Each gust is a bundle of three lines flowing together along the wind's path, like the 💨
  // symbol: top line curls up, middle (longest) curls down, bottom one is short and plain.
  draw(time) {
    if (this.moving || !this.view) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.view.w, this.view.h);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Soft dark shadow so white lines show up on light colors too.
    ctx.shadowColor = "rgba(15, 23, 42, 0.35)";
    ctx.shadowBlur = 2;

    for (const line of this.lines) {
      const strength = Math.min(line.mph, 45);
      const width = 1.1 + strength / 45;
      const gap = 3.5 + strength * 0.05; // space between the three lines
      const streak = Math.max(30, Math.min(70, line.length * 0.45));
      const pxPerSec = 18 + line.mph * 2.2;
      const loop = line.length + 50; // a short pause before the next gust
      const head = time == null ? line.length * 0.75 : ((time / 1000) * pxPerSec + line.phase * loop) % loop;
      if (head > line.length + 10) continue;
      const fade = Math.max(0, Math.min(1, head / 30, (line.length + 10 - head) / 30));
      if (fade <= 0) continue;
      const curlSize = 2.5 + strength * 0.07;

      //            offset   length  how far behind  curl
      const parts = [[-gap, 0.7, 6, -1], [0, 1, 0, 1], [gap, 0.45, 16, 0]];
      for (const [offset, lengthShare, behind, curl] of parts) {
        drawGustLine(ctx, line, Math.min(head - behind, line.length), streak * lengthShare, offset, width, fade, curl ? curlSize * curl : 0);
      }
    }
  },
};

// One line of a gust: follows the wind path shifted sideways by `offset`, brighter toward
// its head, ending in a curl (`curl` > 0 curls one way, < 0 the other, 0 = no curl).
function drawGustLine(ctx, line, head, length, offset, width, fade, curl) {
  if (head <= 0) return;
  const at = (d) => {
    const [x, y] = pointAlong(line, d);
    const [nx, ny] = normalAlong(line, d);
    return [x + nx * offset, y + ny * offset];
  };
  const PIECES = 9;
  const stepPx = 4;
  for (let k = 0; k < PIECES; k++) {
    const from = Math.max(0, head - length + (length * k) / PIECES);
    const to = Math.min(head, head - length + (length * (k + 1)) / PIECES + 1);
    if (to <= from) continue;
    ctx.beginPath();
    for (let d = from; d <= to; d += stepPx) {
      const [x, y] = at(d);
      if (d === from) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const [ex, ey] = at(to);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = `rgba(255,255,255,${((k + 1) / PIECES) ** 1.4 * 0.8 * fade})`;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  if (!curl) return;
  // The curl keeps going the way the wind blows, then loops back on itself.
  const [hx, hy] = at(head);
  const [bx, by] = at(Math.max(0, head - 5));
  const angle = Math.atan2(hy - by, hx - bx);
  const r = Math.abs(curl);
  const side = Math.sign(curl);
  const cx = hx - Math.sin(angle) * r * side;
  const cy = hy + Math.cos(angle) * r * side;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  if (side > 0) ctx.arc(cx, cy, r, angle - Math.PI / 2, angle - Math.PI / 2 + Math.PI * 1.5, false);
  else ctx.arc(cx, cy, r, angle + Math.PI / 2, angle + Math.PI / 2 - Math.PI * 1.5, true);
  ctx.strokeStyle = `rgba(255,255,255,${0.8 * fade})`;
  ctx.lineWidth = width;
  ctx.stroke();
}

// The sideways direction at a given distance along a traced wind line.
function normalAlong(line, d) {
  const { dist, normals } = line;
  for (let i = 1; i < dist.length; i++) if (dist[i] >= d) return normals[i];
  return normals[normals.length - 1];
}

// The point a given distance along a traced wind line.
function pointAlong(line, d) {
  const { pts, dist } = line;
  if (d <= 0) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (dist[i] >= d) {
      const k = (d - dist[i - 1]) / (dist[i] - dist[i - 1] || 1);
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k];
    }
  }
  return pts[pts.length - 1];
}

loadWorldMap();
