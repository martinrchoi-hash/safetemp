// SafeTemp server: serves the app and the AI advice endpoint (POST /api/advice).
// AI advice needs a Claude API key in the ANTHROPIC_API_KEY environment variable.
// Without one, the app still works and just skips the AI card.
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = __dirname;
// Private files (push keys, subscribed devices, caches) live here. On a host, point DATA_DIR at a
// persistent disk so they survive restarts and new deploys.
const dataDir = process.env.DATA_DIR || root;
fs.mkdirSync(dataDir, { recursive: true });
// Behind a hosting proxy, the visitor's address is in X-Forwarded-For (set TRUST_PROXY=1 there).
const clientIp = (req) =>
  (process.env.TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress;
const port = Number(process.env.PORT) || 5180;
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const PUBLIC_FILES = new Set(["/index.html", "/privacy.html", "/styles.css", "/app.js", "/sky.js", "/map.js", "/sw.js", "/manifest.webmanifest", "/icon.svg"]);

// ---------- AI advice ----------

const MODEL = "claude-opus-5-5";
const USER_TYPES = {
  senior: "a senior (65+)",
  outdoor: "an outdoor worker",
  athlete: "an athlete",
  baby: "a parent of a baby or young child",
  health: "a person with a health condition",
  pregnant: "a pregnant person",
  other: "an adult",
  standard: "an adult",
};
const KINDS = new Set(["heat", "cold", "safe"]);

const SYSTEM_PROMPT = `You write safety advice for SafeTemp, an app that warns people about dangerous weather (heat, cold, UV, air, wind, rain, snow, ice, storms).
The app has already decided the danger level using National Weather Service charts. Never change or argue with that level.
Write exactly 3 short, specific actions this person should take today, based only on CDC and National Weather Service guidance.
Rules:
- Plain words a 12-year-old understands. Under 70 words total.
- Each action on its own line, starting with "- ".
- Make the advice fit this person's group and today's temperatures. If UV is 6+, air quality (AQI) is over 100, or gusts are 46+ mph, cover the most serious of those too (EPA/WHO/NWS guidance).
- At danger or extreme levels, one line must say when to call 911.
- No greetings, headings, markdown or extra text.`;

let client = null;
async function getClient() {
  if (!client) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic();
  }
  return client;
}

// Simple per-visitor limit so a public link can't run up the bill.
const hits = new Map();
function allowed(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 30) return false;
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

async function handleAdvice(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return sendJson(res, 503, { error: "AI advice isn't set up yet." });
  if (!allowed(clientIp(req))) return sendJson(res, 429, { error: "Too many requests. Try again later." });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Bad request." });
  }
  const { type, kind, level, levelLabel, now, hi, lo } = body || {};
  const nums = [level, now, hi, lo];
  if (!USER_TYPES[type] || !KINDS.has(kind) || nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    return sendJson(res, 400, { error: "Bad request." });
  }

  const optional = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
  const uvMax = optional(body.uvMax);
  const aqi = optional(body.aqi);
  const gust = optional(body.gust);
  const facts = [
    `Person: ${typeof body.who === "string" && body.who.trim() ? body.who.trim().slice(0, 80) : USER_TYPES[type]}`,
    `SafeTemp danger level: ${String(levelLabel || kind).slice(0, 200)}`,
    `Feels like now: ${Math.round(now)}°F`,
    `Today feels like up to ${Math.round(hi)}°F and down to ${Math.round(lo)}°F`,
    uvMax != null ? `Today's peak UV index: ${uvMax}` : "",
    aqi != null ? `Today's worst US air quality index (AQI): ${aqi}` : "",
    gust != null ? `Strongest wind gusts today: ${gust} mph` : "",
  ].filter(Boolean).join("\n");

  try {
    const anthropic = await getClient();
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      // If the model declines, the API retries on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: facts }],
    });

    if (response.stop_reason === "refusal") {
      return sendJson(res, 502, { error: "AI advice isn't available right now." });
    }
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const advice = text
      .split("\n")
      .map((line) => line.replace(/^\s*[-•*]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 4);
    if (!advice.length) return sendJson(res, 502, { error: "AI advice isn't available right now." });
    return sendJson(res, 200, { advice, model: response.model });
  } catch (err) {
    const status = err && err.status;
    console.error("AI advice failed:", status || "", err && err.message);
    if (status === 401) return sendJson(res, 503, { error: "AI advice isn't set up correctly (check the API key)." });
    if (status === 429) return sendJson(res, 503, { error: "AI advice is busy. Try again in a minute." });
    return sendJson(res, 502, { error: "AI advice isn't available right now." });
  }
}

// ---------- "Other": how sensitive is this person? ----------
// The person describes themselves in their own words. AI (or, without an API key, simple keyword
// matching) turns that into how many °F sooner heat and cold danger should start for them, and
// whether polluted air or strong sun is a bigger risk. Based on CDC/EPA/WHO at-risk groups.

const PROFILE_PROMPT = `You set personal weather-danger settings for SafeTemp, a safety app.
Someone describes themselves. Using CDC, EPA and WHO guidance on who is at higher risk:
- Use precise whole numbers that reflect how serious their specific situation is (e.g. 3, 7, 11, 13), not just 0, 5 or 10. Two different people should rarely get the same numbers.
- heat_sensitivity: degrees F (0-15) that heat danger should start sooner for them. 0 = healthy adult; 5 = outdoor worker or athlete; 10 = older adult, baby, pregnancy, heart/lung/kidney disease, diabetes, medicines that affect heat (diuretics, beta blockers, some psychiatric drugs); up to 15 if several apply.
- cold_sensitivity: degrees F (0-15), same idea for cold (older adults, babies, heart disease, poor circulation, unhoused people).
- air_sensitive: true for asthma, COPD or other lung disease, heart disease, pregnancy, kids, older adults, people active outdoors.
- uv_sensitive: true for babies, very fair skin, past skin cancer, lupus, or medicines that make skin burn easily.
- label: a short plural phrase for them, like "people with asthma" or "pregnant people" (under 40 characters).
- notes: 0-2 short, specific safety tips for this person (under 20 words each), plain language.
If the text isn't about a person or health, use zeros/false and an empty notes list.`;

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string" },
    heat_sensitivity: { type: "integer" },
    cold_sensitivity: { type: "integer" },
    air_sensitive: { type: "boolean" },
    uv_sensitive: { type: "boolean" },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["label", "heat_sensitivity", "cold_sensitivity", "air_sensitive", "uv_sensitive", "notes"],
  additionalProperties: false,
};

// Without AI: add up risk factors found in what they wrote. Each factor adds its own amount,
// so "asthma" and "heart disease" and "72 years old" all land on different numbers.
// [pattern, heat °F, cold °F, sensitive to air, sensitive to sun] — based on CDC/EPA at-risk groups.
const RISK_FACTORS = [
  [/newborn|infant|\bbaby\b|babies/, 12, 13, true, true],
  [/toddler|young child|little kid/, 9, 10, true, true],
  [/\bchild\b|\bkid\b|children|kids/, 6, 7, true, false],
  [/pregnan/, 7, 4, true, false],
  [/elder|senior|retire/, 9, 11, true, false],
  [/heart|cardi|coronary|arrhythm/, 8, 7, true, false],
  [/blood pressure|hypertens/, 4, 3, false, false],
  [/diabet/, 6, 5, false, false],
  [/kidney|renal|dialysis/, 6, 3, false, false],
  [/asthma/, 3, 4, true, false],
  [/copd|emphysema|lung|bronch|cystic fibrosis/, 5, 6, true, false],
  [/dementia|alzheimer/, 7, 8, false, false],
  [/parkinson/, 6, 6, false, false],
  [/multiple sclerosis|\bms\b/, 9, 2, false, false],
  [/epilep|seizure/, 4, 2, false, false],
  [/obes|overweight/, 5, 1, false, false],
  [/thyroid/, 3, 4, false, false],
  [/sickle cell/, 5, 8, false, false],
  [/raynaud|poor circulation/, 0, 8, false, false],
  [/underweight|anemi|anaemi|very thin/, 1, 5, false, false],
  [/diuretic|beta.?blocker|antipsychotic|psychiatric|lithium|antidepress|stimulant|adhd med/, 6, 2, false, false],
  [/chemo|cancer|immun/, 5, 5, false, true],
  [/disab|wheelchair|bedridden|mobility/, 6, 7, false, false],
  [/homeless|unhoused|live outside|living outside/, 7, 10, true, true],
  [/outdoor|construct|farm|landscap|roof|deliver|mail|postal|lifeguard|garden/, 6, 4, true, true],
  [/runner|running|\brun\b|athlet|sport|football|soccer|hik|cycl|\bbike\b|marathon|train/, 4, 3, true, true],
  [/lupus/, 3, 3, false, true],
  [/fair skin|pale|freckl|burn easily|skin cancer|melanoma|photosensit|albin|accutane|isotretinoin|doxycycline/, 0, 0, false, true],
];

function keywordProfile(text) {
  const t = text.toLowerCase();
  const found = RISK_FACTORS.filter(([re]) => re.test(t));
  // Age counts as one more factor: older adults get more sensitive year by year from 60 up.
  const age = t.match(/\b(\d{2,3})\s*(?:years?|yrs?|yo|y\/o)?\s*old\b|\bage[d]?\s*(\d{2,3})\b|\bi'?m\s*(\d{2,3})\b|\bi\s+am\s+(\d{2,3})\b/);
  const years = age ? Number(age[1] || age[2] || age[3] || age[4]) : null;
  if (years && years >= 60 && years < 120) found.push([null, (years - 56) * 0.6, (years - 54) * 0.65, true, false]);
  else if (years && years <= 4) found.push([null, 11, 12, true, true]);
  // The biggest factor counts fully; each extra one adds half its amount.
  const combine = (key) => found.map((f) => f[key]).sort((a, b) => b - a).reduce((sum, v, i) => sum + (i === 0 ? v : v / 2), 0);
  return {
    label: "you",
    heat: Math.min(15, Math.round(combine(1))),
    cold: Math.min(15, Math.round(combine(2))),
    air: found.some((f) => f[3]),
    uv: found.some((f) => f[4]),
    notes: [],
    source: "keywords",
  };
}

async function handleProfile(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Bad request." });
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 300) : "";
  if (text.length < 2) return sendJson(res, 400, { error: "Tell us a little about yourself." });
  if (!process.env.ANTHROPIC_API_KEY || !allowed(clientIp(req))) return sendJson(res, 200, keywordProfile(text));

  try {
    const anthropic = await getClient();
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: "low", format: { type: "json_schema", schema: PROFILE_SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: PROFILE_PROMPT,
      messages: [{ role: "user", content: text }],
    });
    if (response.stop_reason === "refusal") return sendJson(res, 200, keywordProfile(text));
    const raw = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const p = JSON.parse(raw);
    const clamp = (v) => Math.max(0, Math.min(15, Math.round(Number(v) || 0)));
    return sendJson(res, 200, {
      label: String(p.label || "you").slice(0, 40),
      heat: clamp(p.heat_sensitivity),
      cold: clamp(p.cold_sensitivity),
      air: !!p.air_sensitive,
      uv: !!p.uv_sensitive,
      notes: (Array.isArray(p.notes) ? p.notes : []).slice(0, 2).map((n) => String(n).slice(0, 160)),
      source: "ai",
    });
  } catch (err) {
    console.error("Profile AI failed:", err && err.status, err && err.message);
    return sendJson(res, 200, keywordProfile(text));
  }
}

// ---------- World map data ----------
// A 7.5° grid of feels-like temperature, UV index, wind speed and direction from Open-Meteo covering
// the whole map, poles included: right now, plus a daily forecast 16 days ahead (as far as forecasts go).
// Also a coarser 15° air quality grid (now, plus ~5 days ahead, as far as air forecasts go).
// Shared by all visitors and refreshed every 4 hours to stay inside the free usage limits.

const WORLD = {
  lats: Array.from({ length: 24 }, (_, i) => 86.25 - i * 7.5), // 86.25°N ... 86.25°S (cell centers)
  lons: Array.from({ length: 48 }, (_, i) => -176.25 + i * 7.5), // 176.25°W ... 176.25°E
  maxAgeMs: 6 * 60 * 60 * 1000, // hourly data makes each refresh heavier; every 6 hours stays inside the free limits
};
const AIR_GRID = {
  lats: Array.from({ length: 12 }, (_, i) => 82.5 - i * 15), // 82.5°N ... 82.5°S
  lons: Array.from({ length: 24 }, (_, i) => -172.5 + i * 15), // 172.5°W ... 172.5°E
};
const FORECAST_DAYS = 16;
const AIR_DAYS = 5;
const FORECAST_API =
  "https://api.open-meteo.com/v1/forecast?temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=" + FORECAST_DAYS;
const AIR_API = "https://air-quality-api.open-meteo.com/v1/air-quality?timezone=auto&forecast_days=" + (AIR_DAYS + 1);
const WEATHER_AREA = {
  current: { feels: "apparent_temperature", uv: "uv_index", wind: "wind_speed_10m", dir: "wind_direction_10m" },
  daily: {
    hi: "apparent_temperature_max",
    lo: "apparent_temperature_min",
    uv: "uv_index_max",
    wind: "wind_speed_10m_max",
    dir: "wind_direction_10m_dominant",
  },
};
// The world grid also gets hourly values, so the map can show any time of day.
const WEATHER = {
  ...WEATHER_AREA,
  hourly: { feels: "apparent_temperature", uv: "uv_index", wind: "wind_speed_10m", dir: "wind_direction_10m" },
};
const HOUR_STEP = 3; // hours between map snapshots (the page blends between them)
const AIR = { current: { aqi: "us_aqi" }, hourly: { aqi: "us_aqi" } };

// Saved to disk so a restart doesn't refetch (not served publicly).
const WORLD_FILE = path.join(dataDir, "world-cache.json");
let worldCache = readWorldFile();
let worldGzip = null;
let worldLoading = null;

function readWorldFile() {
  try {
    const data = JSON.parse(fs.readFileSync(WORLD_FILE, "utf8"));
    // Reuse a saved grid with the same shape (one without forecast days still works; it just gets refreshed).
    const sameShape = data.lats && data.lats.length === WORLD.lats.length && data.lats[0] === WORLD.lats[0];
    return sameShape && data.layers && data.layers.dir && data.air ? data : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round1 = (v) => Math.round((v ?? 0) * 10) / 10;

// Fetches current / daily / hourly values for many places, 50 at a time (the 16-day forecast makes
// each batch big). Batches are spaced 12 seconds apart to stay under the free plan's ~600 places a minute.
// Returns { current: {key: [per place]}, daily: {key: [per place: [per day]]}, hourly: {key: [per place: {time, values}]} }.
async function fetchPoints(base, vars, points, pace = true) {
  const out = {};
  for (const part of ["current", "daily", "hourly"]) {
    if (vars[part]) out[part] = Object.fromEntries(Object.keys(vars[part]).map((k) => [k, []]));
  }
  const BATCH = 50;
  for (let i = 0; i < points.length; i += BATCH) {
    if (i > 0 && pace) await sleep(6000);
    const chunk = points.slice(i, i + BATCH);
    let url = `${base}&latitude=${chunk.map((p) => p[0]).join(",")}&longitude=${chunk.map((p) => p[1]).join(",")}`;
    for (const part of ["current", "daily", "hourly"]) {
      if (vars[part]) url += `&${part}=${Object.values(vars[part]).join(",")}`;
    }
    // Retry a batch up to twice if the connection drops or the per-minute limit is hit.
    let body;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url);
        if (res.status === 429 && pace && attempt < 2) {
          await sleep(65000);
          continue;
        }
        if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
        body = await res.json();
        break;
      } catch (err) {
        if (attempt >= 2 || /Open-Meteo 4/.test(err.message)) throw err;
        await sleep(5000);
      }
    }
    for (const loc of [].concat(body)) {
      if (vars.current) for (const [k, v] of Object.entries(vars.current)) out.current[k].push(round1(loc.current[v]));
      if (vars.daily) for (const [k, v] of Object.entries(vars.daily)) out.daily[k].push(loc.daily[v].map(round1));
      if (vars.hourly) {
        for (const [k, v] of Object.entries(vars.hourly)) out.hourly[k].push({ time: loc.hourly.time, values: loc.hourly[v], offset: loc.utc_offset_seconds || 0 });
      }
    }
  }
  return out;
}

const toRows = (values, rows, cols) => Array.from({ length: rows }, (_, r) => values.slice(r * cols, (r + 1) * cols));
const gridPoints = (lats, lons) => lats.flatMap((lat) => lons.map((lon) => [lat, lon]));

// Daily forecast grids: one rows×cols grid per day for each layer.
// "feels" for a day is its most extreme feels-like: the high if heat is the bigger worry, else the low.
function dailyGrids(daily, rows, cols, days) {
  const perDay = (pick) => Array.from({ length: days }, (_, d) => toRows(pick(d), rows, cols));
  const extreme = (d) =>
    daily.hi.map((hi, i) => {
      const h = hi[d] ?? 65;
      const l = daily.lo[i][d] ?? 65;
      return h - 65 >= 65 - l ? h : l;
    });
  return {
    feels: perDay(extreme),
    uv: perDay((d) => daily.uv.map((v) => v[d] ?? 0)),
    wind: perDay((d) => daily.wind.map((v) => v[d] ?? 0)),
    dir: perDay((d) => daily.dir.map((v) => v[d] ?? 0)),
  };
}

// Daily worst air quality from the hourly forecast (only days that have enough hours of data).
// Hourly values as world snapshots every HOUR_STEP hours, all at the same moment (UTC),
// starting at `start`. Each place's hours are in its own time zone, so line them up first.
function hourlyGrids(hourly, keys, rows, cols, start, slots) {
  const out = {};
  for (const key of keys) {
    const series = hourly[key];
    out[key] = Array.from({ length: slots }, (_, s) => {
      const at = start + s * HOUR_STEP * 3600 * 1000;
      const values = series.map(({ time, values, offset }) => {
        const first = Date.parse(time[0] + ":00Z") - offset * 1000; // UTC time of this place's first hour
        const i = Math.round((at - first) / 3600000);
        const v = values[Math.min(Math.max(i, 0), values.length - 1)];
        return v == null ? null : round1(v);
      });
      return toRows(values, rows, cols);
    });
  }
  return out;
}

function dailyAir(hourly, rows, cols) {
  const days = [];
  for (let d = 0; d < AIR_DAYS; d++) {
    const values = hourly.aqi.map(({ time, values }) => {
      const date = time[d * 24] && time[d * 24].slice(0, 10);
      const day = values.filter((v, h) => v != null && time[h].startsWith(date));
      return day.length >= 12 ? Math.max(...day) : null;
    });
    if (values.some((v) => v == null)) break;
    days.push(toRows(values, rows, cols));
  }
  return days;
}

// The full world takes about 3 minutes to gather.
async function loadWorld() {
  const w = await fetchPoints(FORECAST_API, WEATHER, gridPoints(WORLD.lats, WORLD.lons));
  await sleep(12000);
  const a = await fetchPoints(AIR_API, AIR, gridPoints(AIR_GRID.lats, AIR_GRID.lons));
  const rows = WORLD.lats.length;
  const cols = WORLD.lons.length;
  const airRows = AIR_GRID.lats.length;
  const airCols = AIR_GRID.lons.length;
  // Snapshots from the start of today (UTC, rounded down to a step) through the forecast.
  const step = HOUR_STEP * 3600 * 1000;
  const start = Math.floor((Date.now() - 24 * 3600 * 1000) / step) * step;
  const slots = Math.floor(((FORECAST_DAYS - 1) * 24) / HOUR_STEP);
  const airSlots = Math.floor((AIR_DAYS * 24) / HOUR_STEP);
  return {
    updated: new Date().toISOString(),
    hourly: { start: new Date(start).toISOString(), step: HOUR_STEP, ...hourlyGrids(w.hourly, ["feels", "uv", "wind", "dir"], rows, cols, start, slots) },
    airHourly: { start: new Date(start).toISOString(), step: HOUR_STEP, ...hourlyGrids(a.hourly, ["aqi"], airRows, airCols, start, airSlots) },
    lats: WORLD.lats,
    lons: WORLD.lons,
    step: 7.5,
    grid: toRows(w.current.feels, rows, cols), // "feels like" (kept as `grid` for older pages)
    layers: {
      feels: toRows(w.current.feels, rows, cols),
      uv: toRows(w.current.uv, rows, cols),
      wind: toRows(w.current.wind, rows, cols),
      dir: toRows(w.current.dir, rows, cols), // where the wind blows FROM, degrees
    },
    days: dailyGrids(w.daily, rows, cols, FORECAST_DAYS),
    air: {
      lats: AIR_GRID.lats,
      lons: AIR_GRID.lons,
      grid: toRows(a.current.aqi, airRows, airCols),
      days: dailyAir(a.hourly, airRows, airCols),
    },
  };
}

function refreshWorld() {
  if (worldLoading) return;
  worldLoading = loadWorld()
    .then((data) => {
      worldCache = data;
      worldGzip = null;
      fs.writeFile(WORLD_FILE, JSON.stringify(data), () => {});
      console.log("World map data updated.");
    })
    .catch((err) => console.error("World map data failed:", err.message))
    .finally(() => (worldLoading = null));
}

// Always answer right away: serve what we have, and refresh in the background when it's old.
function handleWorld(req, res) {
  const stale = !worldCache || !worldCache.hourly || Date.now() - Date.parse(worldCache.updated) > WORLD.maxAgeMs;
  if (stale) refreshWorld();
  if (!worldCache) return sendJson(res, 503, { error: "loading", retryInSeconds: 20 });
  // The forecast makes this big (~1 MB), so send it compressed when the browser allows.
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    worldGzip = worldGzip || zlib.gzipSync(JSON.stringify(worldCache));
    res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
    res.end(worldGzip);
    return;
  }
  return sendJson(res, 200, worldCache);
}

// Sharper 8x8 grid for the area a visitor has zoomed into, now plus the 16-day forecast.
// Rounded to 0.5° and cached 30 minutes so nearby visitors share results.
const AREA_SIZE = 8;
const areaCache = new Map();
const areaHits = new Map();

function areaAllowed(ip) {
  const now = Date.now();
  const recent = (areaHits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 120) return false;
  recent.push(now);
  areaHits.set(ip, recent);
  return true;
}

async function handleArea(req, res) {
  const q = new URL(req.url, "http://x").searchParams;
  // Round outward to 0.5° so the area always covers the whole view.
  const down = (v) => Math.floor(Number(v) * 2) / 2;
  const up = (v) => Math.ceil(Number(v) * 2) / 2;
  let s = down(q.get("s")), w = down(q.get("w")), n = up(q.get("n")), e = up(q.get("e"));
  if (![s, w, n, e].every(Number.isFinite)) return sendJson(res, 400, { error: "Bad request." });
  s = Math.max(-85, s); n = Math.min(85, n);
  w = Math.max(-180, w); e = Math.min(180, e);
  if (n - s < 0.5 || e - w < 0.5 || n - s > 40 || e - w > 60) return sendJson(res, 400, { error: "Area too big or small." });

  const key = [s, w, n, e].join(",");
  const cached = areaCache.get(key);
  if (cached && Date.now() - cached.time < 30 * 60 * 1000) return sendJson(res, 200, cached.data);
  if (!areaAllowed(clientIp(req))) return sendJson(res, 429, { error: "Too many requests." });

  const lats = Array.from({ length: AREA_SIZE }, (_, i) => +(n - ((i + 0.5) * (n - s)) / AREA_SIZE).toFixed(3));
  const lons = Array.from({ length: AREA_SIZE }, (_, i) => +(w + ((i + 0.5) * (e - w)) / AREA_SIZE).toFixed(3));
  try {
    const v = await fetchPoints(FORECAST_API, WEATHER_AREA, gridPoints(lats, lons), false);
    const layers = {
      feels: toRows(v.current.feels, AREA_SIZE, AREA_SIZE),
      uv: toRows(v.current.uv, AREA_SIZE, AREA_SIZE),
      wind: toRows(v.current.wind, AREA_SIZE, AREA_SIZE),
      dir: toRows(v.current.dir, AREA_SIZE, AREA_SIZE),
    };
    const days = dailyGrids(v.daily, AREA_SIZE, AREA_SIZE, FORECAST_DAYS);
    const data = { bounds: { s, w, n, e }, lats, lons, grid: layers.feels, layers, days };
    if (areaCache.size > 500) areaCache.clear();
    areaCache.set(key, { time: Date.now(), data });
    return sendJson(res, 200, data);
  } catch (err) {
    console.error("Area data failed:", err.message);
    return sendJson(res, 502, { error: "Detail isn't available right now." });
  }
}

// ---------- Official US alerts, placed on the map ----------
// Active National Weather Service alerts, grouped into the kinds people care about. Warnings
// usually come with their own area; others name forecast zones, whose shapes we look up once
// and keep (a few hundred per refresh, so a cold start fills in over the first refreshes).

const NWS = "https://api.weather.gov";
const NWS_HEADERS = { "User-Agent": "SafeTemp weather safety app", Accept: "application/geo+json" };
const ALERT_KINDS = [
  // [pattern, kind] - first match wins; anything unmatched (marine, beach, minor statements) is left off the map.
  [/Ice Storm|Hurricane|Typhoon|Tropical Storm|High Wind|Extreme Wind|Wind Advisory/i, "outage"],
  [/Red Flag|Fire Weather|Fire Warning|Extreme Fire/i, "fire"],
  [/Flood/i, "flood"],
  [/Tornado/i, "tornado"],
  [/Severe Thunderstorm/i, "storm"],
  [/Heat/i, "heat"],
  [/Blizzard|Winter Storm|Winter Weather|Lake Effect Snow|Snow Squall/i, "snow"],
  [/Extreme Cold|Wind Chill|Cold Weather/i, "cold"],
  [/Air Quality|Dense Smoke|Ashfall/i, "air"],
  [/Dust Storm|Blowing Dust/i, "dust"],
];
const ALERTS_FILE = path.join(dataDir, "zone-cache.json");
const zoneCenters = new Map(Object.entries(readJson(ALERTS_FILE) || {})); // zone URL -> [lon, lat]
let alertMap = null; // { updated, features }
let alertMapLoading = null;
const ALERT_MAP_MAX_AGE = 10 * 60 * 1000;
const ZONE_FETCHES_PER_REFRESH = 250;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Middle of a polygon or multipolygon (average of the outer ring's corners: close enough for an icon).
function centerOf(geometry) {
  if (!geometry) return null;
  const rings = geometry.type === "Polygon" ? [geometry.coordinates[0]] : geometry.type === "MultiPolygon" ? geometry.coordinates.map((p) => p[0]) : [];
  const pts = rings.flat();
  if (!pts.length) return null;
  const lon = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return [Math.round(lon * 1000) / 1000, Math.round(lat * 1000) / 1000];
}

async function nwsJson(url) {
  const res = await fetch(url, { headers: NWS_HEADERS });
  if (!res.ok) throw new Error(`NWS ${res.status}`);
  return res.json();
}

async function loadAlertMap() {
  const data = await nwsJson(`${NWS}/alerts/active?status=actual`);
  const alerts = [];
  const missingZones = new Set();
  for (const f of data.features || []) {
    const p = f.properties || {};
    const match = ALERT_KINDS.find(([re]) => re.test(p.event || ""));
    if (!match) continue;
    const alert = { kind: match[1], event: p.event, headline: p.headline || "", area: p.areaDesc || "", ends: p.ends || p.expires || null, severity: p.severity };
    const center = centerOf(f.geometry);
    if (center) {
      alerts.push({ ...alert, points: [center] });
      continue;
    }
    // No shape of its own: one icon per affected zone we know the shape of.
    const zones = p.affectedZones || [];
    alerts.push({ ...alert, zones });
    for (const z of zones) if (!zoneCenters.has(z)) missingZones.add(z);
  }
  // Look up zone shapes we haven't seen yet, politely, a batch at a time.
  let fetched = 0;
  for (const z of missingZones) {
    if (fetched >= ZONE_FETCHES_PER_REFRESH) break;
    fetched++;
    try {
      const zone = await nwsJson(z);
      zoneCenters.set(z, centerOf(zone.geometry));
    } catch {
      // try again next refresh
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  if (fetched) fs.writeFile(ALERTS_FILE, JSON.stringify(Object.fromEntries(zoneCenters)), () => {});

  const features = [];
  const seen = new Set();
  for (const a of alerts) {
    const points = a.points || a.zones.map((z) => zoneCenters.get(z)).filter(Boolean);
    for (const pt of points) {
      const key = `${a.kind}|${pt.join(",")}`; // one icon per kind per place
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: pt },
        properties: { kind: a.kind, event: a.event, headline: a.headline.slice(0, 220), area: a.area.slice(0, 160), ends: a.ends },
      });
    }
  }
  alertMap = { updated: new Date().toISOString(), features, pendingZones: Math.max(0, missingZones.size - fetched) };
  // More zone shapes still to look up: keep going soon instead of waiting the full refresh time.
  if (alertMap.pendingZones) setTimeout(refreshAlertMap, 30 * 1000);
  return alertMap;
}

function refreshAlertMap() {
  if (!alertMapLoading) alertMapLoading = loadAlertMap().catch((err) => console.error("Alert map:", err.message)).finally(() => (alertMapLoading = null));
  return alertMapLoading;
}

async function handleAlertMap(req, res) {
  if (!alertMap || Date.now() - Date.parse(alertMap.updated) > ALERT_MAP_MAX_AGE) {
    const loading = refreshAlertMap();
    if (!alertMap) await loading; // first time: wait for it
  }
  if (!alertMap) return sendJson(res, 503, { error: "Alerts aren't available right now." });
  sendJson(res, 200, { type: "FeatureCollection", updated: alertMap.updated, features: alertMap.features });
}

// ---------- Push notifications for official alerts ----------
// A device that turns on alerts sends us its push subscription and the place it checks.
// Every 10 minutes we look up active NWS alerts for each place and send a notification for
// each new one (once per alert). Works on Android, computers, and iPhones from the Home Screen.

const webpush = require("web-push");
const PUSH_KEYS_FILE = path.join(dataDir, "push-keys.json"); // private: never served
const PUSH_SUBS_FILE = path.join(dataDir, "push-subs.json"); // private: never served
// Push services want a contact for the sender. Set PUSH_CONTACT (e.g. mailto:you@yourdomain.com) before going live.
const PUSH_CONTACT = process.env.PUSH_CONTACT || "mailto:safetemp@example.com";
const PUSH_CHECK_EVERY = 10 * 60 * 1000;
const ALERT_LABELS = {
  outage: ["⚡", "Power outages possible"],
  fire: ["🔥", "Fire weather"],
  flood: ["🌊", "Flooding"],
  tornado: ["🌪️", "Tornado"],
  storm: ["⛈️", "Severe storms"],
  heat: ["🌡️", "Extreme heat"],
  snow: ["🌨️", "Snow and ice"],
  cold: ["❄️", "Extreme cold"],
  air: ["🌫️", "Bad air or smoke"],
  dust: ["💨", "Dust storm"],
};

let pushKeys = readJson(PUSH_KEYS_FILE);
if (!pushKeys) {
  pushKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(PUSH_KEYS_FILE, JSON.stringify(pushKeys));
}
webpush.setVapidDetails(PUSH_CONTACT, pushKeys.publicKey, pushKeys.privateKey);
let pushSubs = readJson(PUSH_SUBS_FILE) || []; // [{ subscription, lat, lon, place, sent: { alertId: expiresMs } }]
const savePushSubs = () => fs.writeFile(PUSH_SUBS_FILE, JSON.stringify(pushSubs), () => {});

function validSubscription(s) {
  return s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) && s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string";
}

// The phone app's push address, e.g. "ExponentPushToken[abc123]".
const validExpoToken = (t) => typeof t === "string" && /^Expo(nent)?PushToken\[[\w-]+\]$/.test(t);

// Phone app: send through Expo's push service, which passes it on to Apple or Google.
async function sendExpoPush(sub, payload) {
  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        to: sub.expoToken,
        title: payload.title,
        body: payload.body,
        sound: "default",
        priority: "high",
        channelId: "alerts", // the Android channel the app creates
        ttl: 6 * 60 * 60,
        data: { url: payload.url },
      }),
    });
    const data = await res.json().catch(() => ({}));
    const ticket = Array.isArray(data.data) ? data.data[0] : data.data;
    if (res.ok && ticket && ticket.status === "ok") return true;
    // The app was deleted or notifications were turned off: forget this phone.
    if (ticket && ticket.details && ticket.details.error === "DeviceNotRegistered") sub.gone = true;
    else console.error("Phone push failed:", (ticket && ticket.message) || res.status);
    return false;
  } catch (err) {
    console.error("Phone push failed:", err.message);
    return false;
  }
}

async function sendPush(sub, payload) {
  if (sub.expoToken) return sendExpoPush(sub, payload);
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify(payload), { TTL: 6 * 60 * 60 });
    return true;
  } catch (err) {
    // 404/410: the device turned notifications off or the subscription expired; forget it.
    if (err.statusCode === 404 || err.statusCode === 410) sub.gone = true;
    else console.error("Push failed:", err.statusCode || err.code || err.message || err);
    return false;
  }
}

// New official alerts for one subscriber's place -> one notification each.
async function checkPushAlerts(sub) {
  const data = await nwsJson(`${NWS}/alerts/active?status=actual&point=${sub.lat.toFixed(4)},${sub.lon.toFixed(4)}`);
  const now = Date.now();
  for (const [id, until] of Object.entries(sub.sent)) if (until < now) delete sub.sent[id];
  for (const f of data.features || []) {
    const p = f.properties || {};
    const match = ALERT_KINDS.find(([re]) => re.test(p.event || ""));
    if (!match || sub.sent[p.id]) continue;
    const [emoji, label] = ALERT_LABELS[match[1]];
    const until = Date.parse(p.ends || p.expires) || now + 24 * 60 * 60 * 1000;
    const sent = await sendPush(sub, {
      title: `${emoji} ${label}: ${p.event}`,
      body: (p.headline || p.event).slice(0, 180),
      tag: p.id,
      url: "./",
    });
    if (sent) sub.sent[p.id] = until;
    if (sub.gone) return;
  }
}

async function checkAllPush() {
  for (const sub of pushSubs) {
    try {
      await checkPushAlerts(sub);
    } catch (err) {
      console.error("Alert check failed:", err.message);
    }
    await new Promise((r) => setTimeout(r, 200)); // be gentle with the weather service
  }
  pushSubs = pushSubs.filter((s) => !s.gone);
  savePushSubs();
}

async function handlePush(req, res, action) {
  if (action === "key") return sendJson(res, 200, { publicKey: pushKeys.publicKey });
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Bad request." });
  }
  // A browser sends its push subscription; the phone app sends its Expo push token.
  const s = body.subscription;
  const token = body.expoToken;
  if (!validSubscription(s) && !validExpoToken(token)) return sendJson(res, 400, { error: "Bad subscription." });
  let sub = token
    ? pushSubs.find((x) => x.expoToken === token)
    : pushSubs.find((x) => x.subscription && x.subscription.endpoint === s.endpoint);

  if (action === "unsubscribe") {
    pushSubs = pushSubs.filter((x) => x !== sub);
    savePushSubs();
    return sendJson(res, 200, { ok: true });
  }
  if (action === "test") {
    if (!sub) return sendJson(res, 404, { error: "Turn on alerts first." });
    const ok = await sendPush(sub, { title: "🔔 SafeTemp alerts are on", body: `You'll get a notification here for official weather alerts near ${sub.place}.`, tag: "test", url: "./" });
    return sendJson(res, ok ? 200 : 502, ok ? { ok: true } : { error: "Couldn't send. Try turning alerts off and on again." });
  }
  // subscribe (or move to a new place)
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return sendJson(res, 400, { error: "Bad location." });
  const place = typeof body.place === "string" ? body.place.slice(0, 80) : "your location";
  if (!sub) {
    if (pushSubs.length >= 5000) return sendJson(res, 503, { error: "Alerts are full right now." });
    sub = token ? { expoToken: token, sent: {} } : { subscription: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, sent: {} };
    pushSubs.push(sub);
  }
  Object.assign(sub, { lat, lon, place });
  savePushSubs();
  sendJson(res, 200, { ok: true });
  // Alerts already active here count too: send them now rather than in 10 minutes.
  checkPushAlerts(sub).then(savePushSubs).catch(() => {});
}

// ---------- Helpers ----------

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10000) {
        reject(new Error("too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function serveFile(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const file = urlPath === "/" ? "/index.html" : urlPath;
  if (!PUBLIC_FILES.has(file)) {
    res.writeHead(404).end("Not found");
    return;
  }
  fs.readFile(path.join(root, file), (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      // Pages always check for a newer version; it's small and changes with every update.
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/profile") {
      handleProfile(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/advice") {
      handleAdvice(req, res);
      return;
    }
    if (req.method === "GET" && req.url === "/api/world") {
      handleWorld(req, res);
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/area?")) {
      handleArea(req, res);
      return;
    }
    if (req.method === "GET" && req.url === "/healthz") {
      sendJson(res, 200, { ok: true }); // for the host's health checks
      return;
    }
    if (req.method === "GET" && req.url === "/api/alert-map") {
      handleAlertMap(req, res);
      return;
    }
    if (req.method === "GET" && req.url === "/api/push/key") {
      handlePush(req, res, "key");
      return;
    }
    const pushAction = req.method === "POST" && req.url.match(/^\/api\/push\/(subscribe|unsubscribe|test)$/);
    if (pushAction) {
      handlePush(req, res, pushAction[1]);
      return;
    }
    if (req.method === "GET") {
      serveFile(req, res);
      return;
    }
    res.writeHead(405).end();
  })
  .listen(port, () => {
    console.log(`SafeTemp running at http://localhost:${port}`);
    if (!worldCache || Date.now() - Date.parse(worldCache.updated) > WORLD.maxAgeMs) refreshWorld();
    console.log(process.env.ANTHROPIC_API_KEY ? "AI advice: on" : "AI advice: off (no ANTHROPIC_API_KEY)");
    setInterval(checkAllPush, PUSH_CHECK_EVERY);
  });
