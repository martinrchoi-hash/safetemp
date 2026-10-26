// SafeTemp: your personal danger level for today's weather.
// Looks at every hazard at once (heat, cold, UV, air, wind, rain, snow, ice, storms),
// adjusts for who you are, and builds a checklist for the exact mix you're facing.

// ---------- Who you are ----------

// How much earlier danger starts, in °F of "feels like"
// (CDC: older adults, young kids, people with health conditions, pregnant people and outdoor workers are at higher risk),
// and whether polluted air or strong sun is a bigger risk for them (EPA / WHO).
const PROFILES = {
  health: { label: "people with a health condition", heat: 8, cold: 7, air: true, uv: false },
  outdoor: { label: "outdoor workers", heat: 6, cold: 4, air: true, uv: true },
  athlete: { label: "athletes", heat: 4, cold: 3, air: true, uv: true },
  pregnant: { label: "pregnant people", heat: 7, cold: 3, air: true, uv: false },
  standard: { label: "most adults", heat: 0, cold: 0, air: false, uv: false },
};
const IDENTITY_NAMES = { outdoor: "Outdoor worker", athlete: "Athlete", pregnant: "Pregnant", other: "Something else" };

// Age on its own: babies and young kids, and adults from 60 up (more with each decade), are most at risk.
function ageProfile(age) {
  if (age == null) return null;
  if (age < 1) return { heat: 12, cold: 13, air: true, uv: true, tips: "baby" };
  if (age < 5) return { heat: 10, cold: 11, air: true, uv: true, tips: "baby" };
  if (age < 13) return { heat: 5, cold: 6, air: true, uv: true };
  if (age < 60) return null;
  if (age < 65) return { heat: 4, cold: 5, air: false, uv: false };
  if (age < 75) return { heat: 9, cold: 11, air: true, uv: false, tips: "senior" };
  if (age < 85) return { heat: 11, cold: 13, air: true, uv: false, tips: "senior" };
  return { heat: 13, cold: 15, air: true, uv: false, tips: "senior" };
}

// Each thing about a person (age, health condition, each identity) is one risk factor.
// The health condition and "something else" are assessed from what was typed (AI, or keyword scoring).
function personParts(p) {
  const parts = [];
  const a = ageProfile(p.age);
  if (a) parts.push({ ...a, why: `age ${p.age}` });
  if (p.condition) {
    const c = p.assessed && p.assessed.condition;
    // Until it's assessed, or if it wasn't recognized, use the general numbers for health conditions.
    const known = c && c.text === p.condition && !c.unknown;
    parts.push({ ...(known ? c : PROFILES.health), why: p.condition.toLowerCase(), tips: "health" });
  }
  for (const t of p.types) {
    if (t === "other") {
      const o = p.assessed && p.assessed.other;
      if (p.other && o && o.text === p.other) parts.push({ ...o, why: p.other.toLowerCase() });
    } else if (PROFILES[t]) {
      parts.push({ ...PROFILES[t], why: IDENTITY_NAMES[t].toLowerCase(), tips: t });
    }
  }
  return parts;
}

// Factors stack: the biggest sensitivity counts in full and each extra one adds half
// of its own (capped at 15°F), so a 72-year-old with asthma is warned sooner than either alone.
function combineParts(parts) {
  if (!parts.length) return { ...PROFILES.standard, tips: [] };
  const stack = (key) => {
    const [first, ...rest] = parts.map((p) => p[key] || 0).sort((a, b) => b - a);
    return Math.min(15, Math.round(first + rest.reduce((sum, v) => sum + v / 2, 0)));
  };
  return {
    label: parts.map((p) => p.why).join(", "),
    heat: stack("heat"),
    cold: stack("cold"),
    air: parts.some((p) => p.air),
    uv: parts.some((p) => p.uv),
    notes: parts.flatMap((p) => p.notes || []),
    tips: [...new Set(parts.map((p) => p.tips).filter(Boolean))],
  };
}

function currentProfile() {
  const person = activePerson();
  return combineParts(person ? personParts(person) : []);
}

const selectedTypes = () => [...el.types.querySelectorAll("input:checked")].map((i) => i.value);
const profileOf = (who) => (typeof who === "object" ? who : PROFILES[who] || PROFILES.standard);

// ---------- Heat and cold (National Weather Service heat index / wind chill, feels-like °F) ----------

const HEAT = { caution: 80, danger: 103, extreme: 125 };
const COLD = { caution: 32, danger: 0, extreme: -18 };

// { kind: "heat" | "cold" | "safe", level: 0-3 }. Heat warnings start once it really feels 80°F+;
// after that, a group's sensitivity makes danger start sooner. Cold works the same way.
function assess(feelsLike, who) {
  const p = profileOf(who);
  const heat = feelsLike + p.heat;
  const cold = feelsLike - p.cold;
  if (feelsLike >= HEAT.caution) {
    if (heat >= HEAT.extreme) return { kind: "heat", level: 3 };
    if (heat >= HEAT.danger) return { kind: "heat", level: 2 };
    return { kind: "heat", level: 1 };
  }
  if (cold <= COLD.extreme) return { kind: "cold", level: 3 };
  if (cold <= COLD.danger) return { kind: "cold", level: 2 };
  if (cold <= COLD.caution) return { kind: "cold", level: 1 };
  return { kind: "safe", level: 0 };
}

const worst = (...results) => results.reduce((a, b) => (b.level > a.level ? b : a));

// Labels used by the map and the 7-day list.
const LEVEL_NAMES = ["Low risk", "Caution", "Danger", "Extreme danger"];

// ---------- Other scales ----------

const UV_LEVELS = [[3, "Low"], [6, "Moderate"], [8, "High"], [11, "Very high"], [Infinity, "Extreme"]]; // WHO
const AQI_LEVELS = [ // US EPA
  [51, "Good"], [101, "Moderate"], [151, "Unhealthy for sensitive groups"],
  [201, "Unhealthy"], [301, "Very unhealthy"], [Infinity, "Hazardous"],
];
const levelOf = (value, scale) => scale.findIndex(([limit]) => value < limit);
const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];

// WMO weather codes from Open-Meteo
const THUNDER = (c) => c >= 95;
const HAIL = (c) => c === 96 || c === 99;
const FREEZING_RAIN = (c) => [56, 57, 66, 67].includes(c);
const FOG = (c) => c === 45 || c === 48;

function weatherInfo(code, isDay = true) {
  if (code === 0) return isDay ? ["☀️", "Clear"] : ["🌙", "Clear"];
  if (code === 1) return isDay ? ["🌤️", "Mostly clear"] : ["🌙", "Mostly clear"];
  if (code === 2) return ["⛅", "Partly cloudy"];
  if (code === 3) return ["☁️", "Cloudy"];
  if (FOG(code)) return ["🌫️", "Foggy"];
  if (code >= 51 && code <= 55) return ["🌦️", "Drizzle"];
  if (FREEZING_RAIN(code)) return ["🧊", "Freezing rain"];
  if (code >= 61 && code <= 65) return ["🌧️", "Rain"];
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ["🌨️", "Snow"];
  if (code >= 80 && code <= 82) return ["🌦️", "Rain showers"];
  if (THUNDER(code)) return ["⛈️", "Thunderstorms"];
  return ["🌡️", "Weather"];
}

// ---------- The full assessment ----------

// Levels 0-3 for sun, air and wind. Shared with the map, which runs them for every pixel.
// UV: sun-sensitive people get warned two points sooner.
const uvLevelFor = (uv, profile) => {
  const u = uv + (profile.uv ? 2 : 0);
  return u >= 11 ? 3 : u >= 8 ? 2 : u >= 6 ? 1 : 0;
};
// Air: "unhealthy for sensitive groups" (101-150) is a real danger for sensitive people, a caution for others.
const airLevelFor = (aqi, profile) => (aqi >= 201 ? 3 : aqi >= 151 ? 2 : aqi >= 101 ? (profile.air ? 2 : 1) : 0);
// Wind (NWS: advisory 31+ mph or gusts 46+; high wind warning 40+ / 58+).
const windLevelFor = (wind, gust) => (wind >= 58 || gust >= 75 ? 3 : wind >= 40 || gust >= 58 ? 2 : wind >= 31 || gust >= 46 ? 1 : 0);

// Every hazard for one day. `day` holds that day's numbers; air is only known for today.
// Each hazard: { id, level 0-3, title, detail }. Level 0 hazards still count as "present"
// (e.g. light rain) so the checklist can include an umbrella.
function assessDay(day, profile) {
  const out = [];
  const add = (id, level, title, detail) => out.push({ id, level, title, detail });

  // Heat and cold
  const t = worst(assess(day.feelsHi, profile), assess(day.feelsLo, profile), assess(day.feelsNow ?? day.feelsHi, profile));
  if (t.kind === "heat") add("heat", t.level, "Heat", `Feels like up to ${day.feelsHi}°F`);
  if (t.kind === "cold") add("cold", t.level, "Cold", `Feels like down to ${day.feelsLo}°F`);

  // UV
  const uv = day.uv ?? 0;
  const uvLevel = uvLevelFor(uv, profile);
  if (uvLevel) add("uv", uvLevel, "Strong sun", `UV up to ${Math.round(uv)} (${UV_LEVELS[levelOf(uv, UV_LEVELS)][1].toLowerCase()})`);

  // Air quality
  if (day.aqi != null) {
    const a = day.aqi;
    const airLevel = airLevelFor(a, profile);
    if (airLevel) add("air", airLevel, "Unhealthy air", `Air quality index ${Math.round(a)} (${AQI_LEVELS[levelOf(a, AQI_LEVELS)][1].toLowerCase()})`);
  }

  // Wind
  const wind = day.wind ?? 0;
  const gust = day.gust ?? 0;
  const windLevel = windLevelFor(wind, gust);
  if (windLevel) add("wind", windLevel, "Strong wind", `Gusts up to ${Math.round(gust)} mph`);

  // Rain (inches in a day)
  const rain = day.rain ?? 0;
  if (rain >= 0.1 || (day.rainChance ?? 0) >= 60) {
    const rainLevel = rain >= 3 ? 3 : rain >= 1.5 ? 2 : rain >= 0.75 ? 1 : 0;
    add("rain", rainLevel, rainLevel >= 2 ? "Heavy rain" : "Rain", `${rain >= 0.05 ? rain.toFixed(1) + " in of rain" : "Rain likely"}${day.rainChance != null ? ` · ${day.rainChance}% chance` : ""}`);
  }

  // Snow (inches in a day)
  const snow = day.snow ?? 0;
  if (snow >= 0.2) {
    const snowLevel = snow >= 12 ? 3 : snow >= 6 ? 2 : snow >= 1 ? 1 : 0;
    add("snow", Math.max(snowLevel, windLevel >= 1 && snow >= 6 ? 3 : 0), windLevel >= 1 && snow >= 6 ? "Blizzard" : "Snow", `${snow.toFixed(1)} in of snow`);
  }

  // Ice: freezing rain, or rain falling when it feels below freezing
  if (FREEZING_RAIN(day.code) || (rain >= 0.1 && day.feelsLo <= 32)) add("ice", 2, "Icy roads", "Freezing rain or ice possible");

  // Thunderstorms (lightning; hail is worse)
  if (THUNDER(day.code)) add("storm", HAIL(day.code) || windLevel >= 2 ? 3 : 2, HAIL(day.code) ? "Thunderstorms & hail" : "Thunderstorms", "Lightning possible");

  if (FOG(day.code)) add("fog", 0, "Fog", "Low visibility");

  // What the weather can lead to: flooding, wildfires and power outages.
  const flood = floodRisk(day);
  if (flood.level) add("flood", flood.level, "Flooding possible", flood.detail);
  const fire = fireRisk(day);
  if (fire.level) add("fire", fire.level, "Wildfire risk", fire.detail);
  // A possible power outage is a heads-up, not a risk level: it never changes Caution/Danger/Extreme,
  // but it shows its own notice, outage tips and outage supplies.
  const outage = outageRisk(day, { windLevel, iced: out.some((h) => h.id === "ice"), fire: fire.level });
  if (outage.level) out.push({ id: "outage", level: 0, notice: true, title: "Power outages possible", detail: outage.detail });

  out.sort((a, b) => b.level - a.level);
  return out;
}

// Flooding: a very wet day, or a lot of rain over a few days (worse when the ground is already soaked).
// `rain3` is this day plus the next two; `recentRain` is the week before.
function floodRisk(day) {
  const rain = day.rain ?? 0;
  const rain3 = Math.max(rain, day.rain3 ?? rain);
  let level = rain >= 3 ? 3 : rain >= 1.5 || rain3 >= 4 ? 2 : rain >= 1 || rain3 >= 2.5 ? 1 : 0;
  const soaked = (day.recentRain ?? 0) >= 2;
  if (level && soaked) level = Math.min(3, level + 1);
  const detail = (rain3 > rain + 0.05 ? `${rain3.toFixed(1)} in of rain over 3 days` : `${rain.toFixed(1)} in of rain`) + (soaked ? " on already-soaked ground" : "");
  return { level, detail };
}

// Fire weather (NWS Red Flag idea): dry air plus strong wind lets fires start easily and spread fast.
// This is the weather's fire risk, not a report of an actual fire.
function fireRisk(day) {
  const rh = day.rhMin;
  const gust = day.gust ?? 0;
  if (rh == null || (day.rain ?? 0) >= 0.1 || (day.snow ?? 0) > 0 || (day.tempHi ?? 99) < 50) return { level: 0 };
  let level = rh <= 10 && gust >= 40 ? 3 : rh <= 15 && gust >= 25 ? 2 : (rh <= 25 && gust >= 20) || (rh <= 15 && (day.tempHi ?? 0) >= 85) ? 1 : 0;
  // A wet week means plants are too damp to burn easily.
  if (level && (day.recentRain ?? 0) >= 0.5) level -= 1;
  return { level, detail: `Humidity down to ${Math.round(rh)}% with gusts to ${Math.round(gust)} mph: fires can start and spread fast` };
}

// Power outages: wind gusts, ice and heavy snow bring down lines; extreme heat strains the grid;
// in fire weather, utilities may switch power off on purpose to prevent fires.
function outageRisk(day, { windLevel, iced, fire }) {
  const gust = day.gust ?? 0;
  const causes = [];
  let level = 0;
  const raise = (l, why) => {
    if (!l) return;
    level = Math.max(level, l);
    causes.push(why);
  };
  raise(gust >= 75 ? 3 : gust >= 58 || windLevel >= 2 ? 2 : gust >= 46 ? 1 : 0, "strong wind");
  raise(iced ? 2 : 0, "ice on power lines");
  raise((day.snow ?? 0) >= 12 ? 2 : (day.snow ?? 0) >= 6 ? 1 : 0, "heavy snow");
  raise((day.feelsHi ?? 0) >= 110 || (day.tempHi ?? 0) >= 105 ? 1 : 0, "heat straining the grid");
  raise(fire >= 2 ? 1 : 0, "shutoffs to prevent wildfires");
  return { level, detail: causes.length ? "From " + causes.join(", ") : "" };
}

// Official US alerts (National Weather Service) that raise these risks, even when our numbers wouldn't.
const ALERT_HAZARDS = [
  [/Flash Flood (Warning|Emergency)/i, "flood", 3],
  [/Flood Warning/i, "flood", 2],
  [/Flood (Watch|Advisory)/i, "flood", 1],
  [/Fire Warning|Extreme Fire Danger/i, "fire", 3],
  [/Red Flag Warning/i, "fire", 2],
  [/Fire Weather Watch/i, "fire", 1],
  [/(Hurricane|Typhoon) Warning/i, "flood", 2],
  [/Extreme Wind Warning|(Hurricane|Typhoon) Warning/i, "wind", 3],
  [/High Wind Warning|Tropical Storm Warning/i, "wind", 2],
  [/Wind Advisory/i, "wind", 1],
  [/Ice Storm Warning/i, "ice", 3],
  // These bring down power lines: show the power outage notice (it has no level).
  [/Ice Storm|Hurricane|Typhoon|Tropical Storm|High Wind|Extreme Wind|Wind Advisory|Winter Storm Warning|Blizzard/i, "outage", 0],
  [/Tornado Warning/i, "storm", 3],
  [/Tornado Watch|Severe Thunderstorm Warning/i, "storm", 2],
];
const HAZARD_TITLES = { flood: "Flooding possible", fire: "Wildfire risk", outage: "Power outages possible", storm: "Severe storms", wind: "Strong wind", ice: "Icy roads" };

function mergeAlertHazards(hazards, alertEvents) {
  for (const event of alertEvents) {
    for (const [pattern, id, level] of ALERT_HAZARDS) {
      if (!pattern.test(event)) continue;
      const h = hazards.find((x) => x.id === id);
      if (id === "outage") {
        // Outages are a notice, not a level: the alert just becomes the reason.
        if (!h) hazards.push({ id, level: 0, notice: true, title: HAZARD_TITLES[id], detail: `${event} in effect` });
        else h.detail = `${event} in effect`;
        continue;
      }
      if (!h) hazards.push({ id, level, title: HAZARD_TITLES[id], detail: `${event} in effect` });
      else if (h.level < level) Object.assign(h, { level, detail: `${event} in effect` });
    }
  }
  hazards.sort((a, b) => b.level - a.level);
  return hazards;
}

const overallLevel = (hazards) => hazards.reduce((m, h) => Math.max(m, h.level), 0);

// ---------- What to do (CDC, NWS, EPA, Ready.gov guidance) ----------

const HEAT_COLD_TIPS = {
  senior: {
    heat: ["Stay in air conditioning from 12 to 6 PM. No AC? Go to a cooling center or library.", "Drink water every hour, even if you're not thirsty.", "Ask someone to check on you twice today."],
    cold: ["Keep your home at least 68°F and wear layers and a hat indoors.", "Never heat your home with an oven or grill (carbon monoxide).", "Ask someone to check on you today."],
  },
  outdoor: {
    heat: ["Drink a cup of water every 15 to 20 minutes.", "Take breaks in the shade or AC.", "Know heat stroke signs: confusion, hot dry skin, fainting. Call 911."],
    cold: ["Wear layers, a hat, gloves and waterproof boots.", "Take warm breaks indoors.", "Watch for numb or white skin (frostbite)."],
  },
  athlete: {
    heat: ["Move practice to early morning or evening.", "Take water breaks every 15 to 20 minutes.", "Stop right away if you feel dizzy, sick or confused."],
    cold: ["Warm up indoors first.", "Cover your head, ears and hands.", "Change out of sweaty clothes right after practice."],
  },
  baby: {
    heat: ["Never leave a child in a car, not even for a minute.", "Keep them in shade or AC.", "Dress them in light, loose clothes and offer fluids often."],
    cold: ["Dress babies in one more layer than an adult would wear.", "No loose blankets in the crib.", "Keep time outside short."],
  },
  health: {
    heat: ["Some medicines make heat more dangerous. Ask your doctor or pharmacist.", "Stay in AC during the hottest hours.", "Have someone check on you today."],
    cold: ["Cold strains the heart. Skip shoveling and heavy outdoor work.", "Keep medicine and supplies at home in case of storms.", "Have someone check on you today."],
  },
  pregnant: {
    heat: ["Pregnancy makes it harder to cool down. Stay in AC during the hottest hours.", "Drink extra water: dehydration can bring on contractions.", "Call your doctor if you feel dizzy, faint or have cramps."],
    cold: ["Wear warm layers and skip icy walks: falls are riskier now.", "Keep time waiting outside short.", "Eat and drink regularly so your body can keep warm."],
  },
  standard: {
    heat: ["Drink water throughout the day.", "Limit time outside from 12 to 6 PM and rest in the shade.", "Know heat illness signs: dizziness, cramps, nausea, confusion."],
    cold: ["Dress in layers and cover your head, hands and ears.", "Limit time outside.", "Watch for shivering, confusion or numb skin."],
  },
};

const HAZARD_TIPS = {
  uv: ["Wear SPF 30+ sunscreen, a wide hat and sunglasses; reapply every 2 hours.", "Stay in the shade from 10 AM to 4 PM."],
  air: ["Limit time outside and skip hard exercise.", "Keep windows closed; run an air purifier or AC on recirculate.", "If you must go out, an N95 mask helps."],
  wind: ["Secure or bring in loose things outside.", "Watch for falling branches and downed power lines.", "Keep your phone charged in case the power goes out."],
  rain: ["Slow down and leave extra room when driving.", "Watch for big puddles and water over the road."],
  flood: [
    "Never drive or walk through flood water: 6 inches of moving water can knock you down. Turn around, don't drown.",
    "Move important papers and valuables up high.",
    "Know if you're in a flood zone and where you'd go if told to leave.",
    "Stay away from creeks, rivers and storm drains.",
  ],
  fire: [
    "Avoid anything that could spark a fire: no burning, campfires, or mowing dry grass.",
    "Sign up for local emergency alerts and know two ways out of your area.",
    "Pack a go-bag with medicines, documents, chargers and masks.",
    "Keep your car's gas tank at least half full.",
  ],
  outage: [
    "Charge your phone and power banks now.",
    "Keep the fridge and freezer closed: food stays cold about 4 hours in the fridge, 2 days in a full freezer.",
    "If you use medical equipment that needs power, make a backup plan today. Call 911 if someone is in danger without it.",
    "Run a generator outdoors only, at least 20 feet from doors and windows. Never a generator, grill or camp stove indoors or in a garage (carbon monoxide).",
  ],
  snow: ["Only travel if you have to; keep a blanket and water in the car.", "Shovel slowly and take breaks."],
  ice: ["Walk slowly with small steps; wear shoes with good grip.", "Delay driving until roads are treated if you can."],
  storm: ["When thunder roars, go indoors and stay in for 30 minutes after the last thunder.", "Stay off open fields, water and high ground."],
  fog: ["Drive slowly with low beams on, and leave plenty of space."],
};

// Extra advice when hazards combine.
const COMBO_TIPS = [
  [["rain", "cold"], "Wet and cold together drains body heat fast: stay dry and change out of wet clothes right away."],
  [["heat", "air"], "Heat plus bad air is hard on the heart and lungs: stay inside with AC and filtered air."],
  [["wind", "cold"], "Wind makes cold hit harder: cover every bit of skin."],
  [["storm", "wind"], "Severe storms can cut power: charge your phone and have a flashlight ready."],
  [["snow", "wind"], "Blowing snow can cause whiteouts: avoid driving."],
  [["heat", "outage"], "If the power goes out in this heat, go somewhere cool right away: a cooling center, library or mall (call 211)."],
  [["cold", "outage"], "If the power goes out in this cold, go to a warming center (call 211). Never heat with an oven, grill or generator indoors."],
  [["fire", "wind"], "In wind like this, a fire can reach homes within hours: leave as soon as you're told to."],
];

const URGENT = {
  heat: "If someone is confused, faints or stops sweating, call 911 and cool them down right away.",
  cold: "If someone is shivering hard, confused or has numb, white skin, call 911 and warm them up.",
  storm: "If someone is struck by lightning, call 911; it's safe to touch them and start CPR.",
  air: "If you have trouble breathing or chest pain, get medical help right away.",
  flood: "If water is rising around you, get to higher ground right away and call 911. Don't wait for it to go down.",
  fire: "If you see fire or smoke nearby, or you're told to evacuate, leave right away and call 911.",
};

// ---------- What to have: a checklist built from today's hazards ----------
// Each item has an Amazon search, and a free option where there is one.

const ITEMS = {
  water: { name: "Water (about 1 gallon per person per day)", amazon: "water jug 1 gallon", free: "Free water and AC at cooling centers (call 211)." },
  cooling: { name: "A way to stay cool (AC, or a fan and a cool room)", amazon: "portable fan", free: "Cooling centers, libraries and malls (call 211). Help with bills: LIHEAP." },
  electrolytes: { name: "Electrolyte drinks or tablets", amazon: "electrolyte tablets" },
  lightClothes: { name: "Light, loose, light-colored clothes", amazon: "lightweight breathable shirt" },
  coolingTowel: { name: "Cooling towel", amazon: "cooling towel" },
  jacket: { name: "Warm winter jacket", amazon: "winter jacket", free: "Free coats through coat drives and shelters (call 211)." },
  hatGloves: { name: "Hat, gloves and scarf", amazon: "winter hat gloves scarf set", free: "Free through coat drives (call 211)." },
  thermal: { name: "Thermal base layers", amazon: "thermal underwear base layer" },
  blankets: { name: "Extra blankets", amazon: "fleece blanket", free: "Shelters and warming centers (call 211)." },
  heater: { name: "A safe space heater (never an oven or grill)", amazon: "space heater tip over auto shut off", free: "Warming centers (call 211). Help with bills: LIHEAP." },
  handWarmers: { name: "Hand warmers", amazon: "hand warmers" },
  sunscreen: { name: "Sunscreen, SPF 30+", amazon: "sunscreen spf 50" },
  sunHat: { name: "Wide-brim hat and sunglasses", amazon: "wide brim sun hat" },
  n95: { name: "N95 masks", amazon: "n95 mask", free: "Some health departments hand out free masks on bad air days." },
  purifier: { name: "Air purifier (HEPA)", amazon: "hepa air purifier" },
  umbrella: { name: "Umbrella", amazon: "compact umbrella windproof" },
  rainJacket: { name: "Waterproof jacket", amazon: "waterproof rain jacket" },
  waterproofShoes: { name: "Waterproof, non-slip shoes", amazon: "waterproof non slip shoes" },
  flashlight: { name: "Flashlight and spare batteries", amazon: "led flashlight" },
  powerBank: { name: "Charged power bank", amazon: "power bank" },
  radio: { name: "Weather radio", amazon: "noaa weather radio hand crank" },
  iceGrips: { name: "Ice grips for shoes", amazon: "ice cleats for shoes" },
  saltShovel: { name: "Snow shovel and ice melt", amazon: "snow shovel ice melt" },
  carKit: { name: "Car emergency kit (blanket, water, scraper)", amazon: "car winter emergency kit" },
  coolerIce: { name: "Cooler and ice packs (for food and medicine)", amazon: "cooler with ice packs" },
  generator: { name: "Generator or portable power station (generators outdoors only)", amazon: "portable power station" },
  shelfFood: { name: "3 days of food that needs no cooking", amazon: "emergency food supply", free: "Food banks can help (call 211)." },
  goBag: { name: "Go-bag: medicines, chargers, cash, clothes, copies of IDs", amazon: "emergency go bag", free: "Ready.gov has a free packing checklist." },
  docs: { name: "Waterproof bag for important papers", amazon: "waterproof document bag" },
  sandbags: { name: "Sandbags", amazon: "sandbags", free: "Many cities hand out free sandbags before storms." },
  medicine: { name: "A week of your medicines", free: "Ask your pharmacy about an early refill before bad weather." },
  formula: { name: "Extra formula, diapers and baby supplies", amazon: "baby formula" },
};

const HAZARD_ITEMS = {
  heat: ["water", "cooling", "electrolytes", "lightClothes", "coolingTowel"],
  cold: ["jacket", "hatGloves", "thermal", "blankets", "heater"],
  uv: ["sunscreen", "sunHat"],
  air: ["n95", "purifier"],
  wind: ["flashlight", "powerBank"],
  rain: ["umbrella", "rainJacket", "waterproofShoes"],
  snow: ["saltShovel", "carKit", "jacket", "hatGloves"],
  ice: ["iceGrips", "saltShovel"],
  storm: ["flashlight", "powerBank", "radio"],
  fog: [],
  flood: ["goBag", "docs", "sandbags", "waterproofShoes", "radio"],
  fire: ["goBag", "n95", "docs", "radio"],
  outage: ["flashlight", "powerBank", "generator", "coolerIce", "shelfFood", "water", "radio"],
};
const PROFILE_ITEMS = {
  senior: ["medicine"],
  health: ["medicine"],
  baby: ["formula"],
  outdoor: ["electrolytes", "handWarmers"],
  athlete: ["electrolytes"],
  pregnant: ["water"],
};

function amazonLink(query) {
  return "https://www.amazon.com/s?k=" + encodeURIComponent(query);
}

// ---------- Storage (this device only) ----------

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("safetemp:" + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem("safetemp:" + key, JSON.stringify(value)); } catch {}
  },
};

// ---------- State and elements ----------

const $ = (id) => document.getElementById(id);
const el = {
  types: $("types"),
  whoSummary: $("whoSummary"),
  whoEdit: $("whoEdit"),
  whoName: $("whoName"),
  whoIdentity: $("whoIdentity"),
  peopleList: $("peopleList"),
  whoChange: $("whoChange"),
  whoAdd: $("whoAdd"),
  whoSave: $("whoSave"),
  whoCancel: $("whoCancel"),
  whoDelete: $("whoDelete"),
  whoError: $("whoError"),
  personName: $("personName"),
  personAge: $("personAge"),
  personCondition: $("personCondition"),
  personOther: $("personOther"),
  otherBox: $("otherBox"),
  assessment: $("assessment"),
  locationLabel: $("locationLabel"),
  locationNote: $("locationNote"),
  changeCity: $("changeCity"),
  useMyLocation: $("useMyLocation"),
  cityForm: $("cityForm"),
  cityInput: $("cityInput"),
  cityResults: $("cityResults"),
  checkButton: $("checkButton"),
  alerts: $("alerts"),
  verdict: $("verdict"),
  verdictLevel: $("verdictLevel"),
  verdictWho: $("verdictWho"),
  verdictHazards: $("verdictHazards"),
  details: $("details"),
  readings: $("readings"),
  tipsList: $("tipsList"),
  forecast: $("forecast"),
  supplies: $("supplies"),
  suppliesFor: $("suppliesFor"),
};

const state = {
  place: null, // { lat, lon, name, fromGps }
  weather: null,
  air: null,
  today: null,
  people: store.get("people", []), // [{ id, name, age, condition, types, other, assessed }]
  activeId: store.get("activePerson", null),
  editingId: null, // the person being edited, or null when adding a new one
  when: { day: null, hour: null }, // day: null = right now, 0 = today, 1 = tomorrow...; hour: null = all day, 0-23
  checks: store.get("checks2", {}),
};

// ---------- Location ----------

function setLocationLabel(text) {
  el.locationLabel.textContent = text;
}

// Always try the phone's location first and check automatically.
// If location is off, fall back to the last city the user searched.
function setLocationNote(text) {
  el.locationNote.textContent = text || "";
  el.locationNote.hidden = !text;
}

const REVERSE_GEOCODE = "https://api.bigdatacloud.net/data/reverse-geocode-client?localityLanguage=en";

// On page load: GPS if allowed, otherwise the city saved last time.
// When "Use my location" is tapped: GPS, or if the browser blocks it, an approximate spot from the internet connection.
// Inside the SafeTemp phone app, the app gets the GPS position and hands it over here.
const inPhoneApp = !!window.ReactNativeWebView;
let locateTapped = false;
window.safeTempNativeLocation = (lat, lon) =>
  lat == null ? locationFailed(locateTapped, "Location is off for SafeTemp.") : gotPosition(lat, lon);

async function gotPosition(latitude, longitude) {
  const lat = round(latitude, 3);
  const lon = round(longitude, 3);
  usePlace({ lat, lon, name: "Your current location", fromGps: true });
  // Put a town name on it.
  try {
    const geo = await getJson(`${REVERSE_GEOCODE}&latitude=${lat}&longitude=${lon}`);
    const name = typeof placeName === "function" ? placeName(geo) : geo.city;
    if (name && state.place && state.place.fromGps) {
      state.place.name = name;
      setLocationLabel(name);
      setLocationNote("Your current location");
    }
  } catch {}
}

function findLocation(tapped) {
  el.useMyLocation.hidden = true;
  setLocationNote("");
  locateTapped = !!tapped;
  if (inPhoneApp) {
    setLocationLabel("Finding your location…");
    window.ReactNativeWebView.postMessage("locate");
    return;
  }
  if (!("geolocation" in navigator)) return locationFailed(tapped, "This browser can't share your location.");
  setLocationLabel("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => gotPosition(pos.coords.latitude, pos.coords.longitude),
    (err) =>
      locationFailed(
        tapped,
        err.code === 1 ? "Location access is blocked for this site." : err.code === 3 ? "Finding your location took too long." : "Your location isn't available right now."
      ),
    { timeout: 10000, maximumAge: 10 * 60 * 1000 }
  );
}

async function locationFailed(tapped, reason) {
  const saved = store.get("place", null);
  if (!tapped && saved && !saved.fromGps) return usePlace(saved);
  // Fall back to a rough location from the internet connection (city-level, not exact).
  try {
    const geo = await getJson(REVERSE_GEOCODE);
    if (geo.latitude == null || geo.longitude == null) throw new Error("no location");
    const name = (typeof placeName === "function" ? placeName(geo) : geo.city) || "Near you";
    const place = { lat: round(geo.latitude, 3), lon: round(geo.longitude, 3), name, fromGps: false, approx: true };
    store.set("place", place);
    usePlace(place);
    setLocationNote(`${reason} This is your approximate area, from your internet connection. For an exact spot, allow location in your browser's site settings, or search for your city.`);
  } catch {
    if (saved && !saved.fromGps) {
      usePlace(saved);
      setLocationNote(`${reason} Showing your saved city instead.`);
      return;
    }
    setLocationLabel("Search for your city");
    setLocationNote(reason);
    showCityForm();
  }
}

function usePlace(place) {
  state.place = place;
  setLocationNote("");
  setLocationLabel(place.name);
  el.useMyLocation.hidden = !(inPhoneApp || "geolocation" in navigator);
  el.cityForm.hidden = true;
  check();
  syncAlertPlace();
}

function showCityForm() {
  el.cityForm.hidden = false;
  el.cityInput.focus();
}

let citySearchId = 0;
const cityCache = new Map();

async function searchCity(name) {
  const id = ++citySearchId;
  // Any city in the world; biggest matches first.
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=8&language=en&format=json`;
  try {
    const key = name.toLowerCase();
    const data = cityCache.get(key) || (await getJson(url));
    cityCache.set(key, data);
    if (id !== citySearchId) return; // you kept typing; a newer search will show instead
    el.cityResults.innerHTML = "";
    el.cityResults.dataset.query = key; // which search these suggestions are for
    const results = data.results || [];
    if (!results.length) {
      el.cityResults.innerHTML = "<li class='fine'>No matches. Try another spelling.</li>";
      return;
    }
    for (const r of results) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      // e.g. "Paris, Île-de-France, France" or "Paris, Texas, USA"
      const country = { US: "USA", GB: "UK" }[r.country_code] || r.country;
      const parts = [r.name, r.admin1, country].filter(Boolean);
      b.textContent = parts.filter((p, i) => parts.indexOf(p) === i).join(", ");
      b.addEventListener("click", () => {
        const place = { lat: r.latitude, lon: r.longitude, name: b.textContent, fromGps: false };
        store.set("place", place);
        el.cityResults.innerHTML = "";
        el.cityInput.value = "";
        usePlace(place);
      });
      li.appendChild(b);
      el.cityResults.appendChild(li);
    }
  } catch {
    if (id !== citySearchId) return;
    el.cityResults.innerHTML = "<li class='fine'>Search failed. Check your internet and try again.</li>";
  }
}

// Suggestions appear as you type (after a short pause, so it doesn't search every keystroke).
let cityTypingTimer;
function onCityTyping() {
  clearTimeout(cityTypingTimer);
  const q = el.cityInput.value.trim();
  if (q.length < 2) {
    citySearchId++; // ignore any search still on its way
    el.cityResults.innerHTML = "";
    return;
  }
  cityTypingTimer = setTimeout(() => searchCity(q), 300);
}

// ---------- Weather ----------

const PAST_DAYS = 7; // a week of past rain: soaked ground floods sooner, dry ground burns easier

async function check() {
  if (!state.place) {
    setLocationLabel("Still finding your location… allow location or search for your city.");
    showCityForm();
    return;
  }
  el.checkButton.disabled = true;
  el.verdict.className = "verdict is-loading";
  el.verdictLevel.textContent = "Checking the weather…";
  el.verdictHazards.innerHTML = "";

  const { lat, lon } = state.place;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,apparent_temperature,weather_code,is_day,uv_index,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,uv_index_max," +
    "wind_speed_10m_max,wind_gusts_10m_max,precipitation_sum,precipitation_probability_max,snowfall_sum,relative_humidity_2m_min" +
    // Hour by hour too, for picking a time of day.
    "&hourly=temperature_2m,apparent_temperature,weather_code,is_day,uv_index,wind_speed_10m,wind_gusts_10m,wind_direction_10m," +
    "precipitation,precipitation_probability,snowfall,relative_humidity_2m" +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=${MAX_FORECAST_DAYS}&past_days=${PAST_DAYS}`;
  const airUrl =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
    "&current=us_aqi,pm2_5&hourly=us_aqi&timezone=auto&forecast_days=5";

  try {
    // If the weather service is briefly busy, wait a moment and try once more.
    const withRetry = (u) => getJson(u).catch(() => new Promise((r) => setTimeout(r, 2500)).then(() => getJson(u)));
    const [weather, air] = await Promise.all([
      withRetry(url),
      getJson(airUrl).catch(() => null), // air quality is a bonus; the check works without it
      loadAlerts(lat, lon),
    ]);
    // The past week only tells us how wet or dry it's been; drop it so index 0 is today again.
    state.recentRain = weather.daily.precipitation_sum.slice(0, PAST_DAYS).reduce((sum, v) => sum + (v ?? 0), 0);
    for (const key of Object.keys(weather.daily)) weather.daily[key] = weather.daily[key].slice(PAST_DAYS);
    state.weather = weather;
    state.air = air;
    refreshWhenBar();
    render();
  } catch (err) {
    el.verdict.className = "verdict is-error";
    el.verdictLevel.textContent =
      String(err && err.message) === "429"
        ? "The free weather service is busy or at its daily limit. Please try again later."
        : "Couldn't get the weather. Check your internet and try again.";
  } finally {
    el.checkButton.disabled = false;
  }
}

async function loadAlerts(lat, lon) {
  el.alerts.hidden = true;
  el.alerts.innerHTML = "";
  state.alertEvents = [];
  try {
    const data = await getJson(`https://api.weather.gov/alerts/active?point=${lat},${lon}`);
    state.alertEvents = (data.features || []).map((f) => f.properties.event || "");
    const features = (data.features || []).slice(0, 3);
    for (const f of features) {
      const div = document.createElement("div");
      div.className = "alert";
      const b = document.createElement("b");
      b.textContent = f.properties.event;
      const p = document.createElement("span");
      p.textContent = f.properties.headline || "";
      div.append(b, p);
      el.alerts.appendChild(div);
    }
    el.alerts.hidden = features.length === 0;
  } catch {
    // Official alerts are a bonus (US only); the rest of the app works without them.
  }
}

// Today's numbers in the shape assessDay() expects.
function todayNumbers() {
  const w = state.weather;
  const c = w.current;
  const d = w.daily;
  const air = state.air;
  const aqiNow = air && air.current ? air.current.us_aqi : null;
  const aqiMax = Math.max(airOnDay(0) ?? 0, aqiNow ?? 0) || aqiNow;
  return {
    feelsNow: Math.round(c.apparent_temperature),
    feelsHi: Math.round(d.apparent_temperature_max[0]),
    feelsLo: Math.round(d.apparent_temperature_min[0]),
    uv: d.uv_index_max[0] ?? c.uv_index ?? 0,
    aqi: aqiMax,
    wind: Math.max(c.wind_speed_10m ?? 0, d.wind_speed_10m_max[0] ?? 0),
    gust: Math.max(c.wind_gusts_10m ?? 0, d.wind_gusts_10m_max[0] ?? 0),
    rain: d.precipitation_sum[0] ?? 0,
    rainChance: d.precipitation_probability_max ? d.precipitation_probability_max[0] : null,
    snow: d.snowfall_sum[0] ?? 0,
    ...dryWetNumbers(0),
    // A storm happening right now counts even if the day's summary code is milder.
    code: THUNDER(c.weather_code) || FREEZING_RAIN(c.weather_code) ? c.weather_code : d.weather_code[0] ?? c.weather_code,
  };
}

// Worst air quality forecast for day i, or null past the ~5 days air forecasts cover.
function airOnDay(i) {
  const air = state.air;
  const date = state.weather.daily.time[i];
  if (!air || !air.hourly || !date) return null;
  const values = air.hourly.us_aqi.filter((v, k) => v != null && air.hourly.time[k].startsWith(date));
  return values.length ? Math.max(...values) : null;
}

// Index into the hourly forecast for day i at a given hour (the place's own time), or -1.
function hourIndex(i, hour) {
  const date = state.weather.daily.time[i];
  return date ? state.weather.hourly.time.indexOf(`${date}T${String(hour).padStart(2, "0")}:00`) : -1;
}

// One hour's numbers: heat, cold, sun, air and wind at that hour; rain, snow, flood and fire use the whole day.
function hourNumbers(i, hour) {
  const h = state.weather.hourly;
  const k = hourIndex(i, hour);
  if (k < 0) return dayNumbers(i);
  const feels = Math.round(h.apparent_temperature[k]);
  const air = state.air;
  const ak = air && air.hourly ? air.hourly.time.indexOf(h.time[k]) : -1;
  return {
    ...dayNumbers(i),
    feelsNow: feels,
    feelsHi: feels,
    feelsLo: feels,
    uv: h.uv_index[k] ?? 0,
    aqi: ak >= 0 ? air.hourly.us_aqi[ak] : null,
    wind: h.wind_speed_10m[k] ?? 0,
    gust: h.wind_gusts_10m[k] ?? 0,
    rainChance: h.precipitation_probability ? h.precipitation_probability[k] : null,
    code: h.weather_code[k],
    rhMin: h.relative_humidity_2m[k],
    tempHi: h.temperature_2m[k],
  };
}

// The numbers for whatever the When bar is set to: right now, a whole day, or one hour.
function selectedNumbers() {
  const { day, hour } = state.when;
  if (day == null) return todayNumbers();
  return hour == null ? dayNumbers(day) : hourNumbers(day, hour);
}

function dayNumbers(i) {
  const d = state.weather.daily;
  return {
    feelsHi: Math.round(d.apparent_temperature_max[i]),
    feelsLo: Math.round(d.apparent_temperature_min[i]),
    uv: d.uv_index_max[i] ?? 0,
    aqi: airOnDay(i),
    wind: d.wind_speed_10m_max[i] ?? 0,
    gust: d.wind_gusts_10m_max[i] ?? 0,
    rain: d.precipitation_sum[i] ?? 0,
    rainChance: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
    snow: d.snowfall_sum[i] ?? 0,
    code: d.weather_code[i],
    ...dryWetNumbers(i),
  };
}

// For flood and fire risk on day i: its high, its driest air, rain that day and the next two,
// and how much rain fell in the week before it.
function dryWetNumbers(i) {
  const d = state.weather.daily;
  const rainOn = (k) => d.precipitation_sum[k] ?? 0;
  let before = state.recentRain ?? 0;
  for (let k = 0; k < i; k++) before += rainOn(k); // forecast days before this one count as "recent" too
  return {
    tempHi: d.temperature_2m_max[i],
    rhMin: d.relative_humidity_2m_min ? d.relative_humidity_2m_min[i] : null,
    rain3: rainOn(i) + (i + 1 < d.time.length ? rainOn(i + 1) : 0) + (i + 2 < d.time.length ? rainOn(i + 2) : 0),
    recentRain: before,
  };
}

// ---------- When: one day and time for everything ----------
// Now, the next six days, a calendar for up to 16 days ahead (as far as forecasts go), and a time of day.
// The risk check, conditions, tips, checklist and map all follow it.

const MAX_FORECAST_DAYS = 16;

function dayDate(day) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + day);
  return d;
}
const dayLabel = (day, opts) => dayDate(day).toLocaleDateString("en-US", opts || { weekday: "short", month: "short", day: "numeric" });
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hourLabel = (h) => (h === 0 ? "12 AM" : h === 12 ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`);

// "Right now", "Today at 4 PM", "Tue, Oct 27", "Tue, Oct 27 at 4 PM"
function whenLabel() {
  const { day, hour } = state.when;
  if (day == null) return "Right now";
  const d = day === 0 ? "Today" : dayLabel(day, { weekday: "short", month: "short", day: "numeric" });
  return hour == null ? d : `${d} at ${hourLabel(hour)}`;
}

function setupWhenBar() {
  const bar = $("whenDays");
  const add = (label, day, title) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day-btn";
    b.dataset.day = day == null ? "now" : day;
    b.title = title;
    b.innerHTML = label;
    b.addEventListener("click", () => setWhen(day, day == null ? null : state.when.hour));
    bar.appendChild(b);
  };
  add("Now", null, "Conditions right now");
  for (let d = 1; d <= 6; d++) add(`<span>${dayLabel(d, { weekday: "short" })}</span><small>${dayDate(d).getDate()}</small>`, d, dayLabel(d));

  // Calendar: any day up to 16 days ahead
  const cal = document.createElement("label");
  cal.className = "day-btn day-cal";
  cal.title = `Pick a day (up to ${MAX_FORECAST_DAYS} days ahead)`;
  cal.innerHTML = "📅<span class='visually-hidden'>Pick a day</span>";
  const input = document.createElement("input");
  input.type = "date";
  input.min = isoDate(dayDate(0));
  input.max = isoDate(dayDate(MAX_FORECAST_DAYS - 1));
  input.addEventListener("change", () => {
    if (!input.value) return;
    const day = Math.round((new Date(input.value + "T12:00:00") - dayDate(0)) / 86400000);
    if (day >= 0 && day < MAX_FORECAST_DAYS) setWhen(day, state.when.hour);
  });
  cal.addEventListener("click", () => (input.showPicker ? input.showPicker() : input.focus()));
  cal.appendChild(input);
  bar.appendChild(cal);

  const select = $("whenHour");
  select.add(new Option("", ""));
  for (let h = 0; h < 24; h++) select.add(new Option(hourLabel(h), String(h)));
  // Picking a time while on "Now" means that time today.
  select.addEventListener("change", () => setWhen(select.value === "" ? state.when.day : state.when.day ?? 0, select.value === "" ? null : Number(select.value)));
  refreshWhenBar();
}

function refreshWhenBar() {
  const { day, hour } = state.when;
  const days = state.weather ? state.weather.daily.time.length : 0;
  for (const b of document.querySelectorAll("#whenDays .day-btn")) {
    const isNow = b.dataset.day === "now";
    b.setAttribute("aria-pressed", isNow ? day == null : b.dataset.day == String(day));
    if (!isNow && b.dataset.day !== undefined && !b.classList.contains("day-cal")) b.toggleAttribute("disabled", Number(b.dataset.day) >= days);
  }
  const cal = document.querySelector("#whenDays .day-cal");
  if (cal) {
    cal.setAttribute("aria-pressed", day === 0 || day > 6);
    cal.title = day === 0 || day > 6 ? `${dayLabel(day)} (tap to pick another day)` : `Pick a day (up to ${MAX_FORECAST_DAYS} days ahead)`;
  }
  const select = $("whenHour");
  select.options[0].text = day == null ? "Right now" : "All day";
  select.value = hour == null ? "" : String(hour);
}

function setWhen(day, hour) {
  if (day != null && state.weather && day >= state.weather.daily.time.length) return;
  state.when = { day, hour };
  refreshWhenBar();
  render();
  if (typeof setMapWhen === "function") setMapWhen(day, hour);
}

// ---------- Render ----------

function render() {
  if (!state.weather) return;
  const profile = currentProfile();
  const numbers = selectedNumbers();
  // Official alerts are about now, so they only count for today.
  const today = state.when.day == null || state.when.day === 0;
  const hazards = mergeAlertHazards(assessDay(numbers, profile), today ? state.alertEvents || [] : []);
  const level = overallLevel(hazards);
  state.today = { numbers, hazards, level, profile };

  renderHero(numbers);
  renderVerdict(hazards, level, profile);
  renderOutageNotice(hazards);
  renderReadings(numbers);
  renderTips(hazards, profile);
  renderForecast(profile);
  renderSupplies(hazards, profile.tips);
  loadAiAdvice();

  el.details.hidden = false;
  if (typeof drawWorldMap === "function") drawWorldMap(); // move the "you" pin
}

function renderVerdict(hazards, level, profile) {
  const serious = hazards.filter((h) => h.level > 0);
  const top = serious[0];
  el.verdict.className = `verdict level-${level}` + (top ? ` hazard-${top.id}` : "");
  $("verdictWhen").textContent = state.when.day == null ? "Today's risk" : `Risk · ${whenLabel()}`;
  el.verdictLevel.textContent = level ? LEVEL_NAMES[level] : state.when.day == null ? "Low risk today" : "Low risk";
  const person = activePerson();
  el.verdictWho.textContent =
    `for ${(person && person.name) || "you"}` +
    (profile.heat || profile.cold ? ` · danger levels start ${profile.heat}°F sooner in heat, ${profile.cold}°F sooner in cold` : " · standard danger levels");
  el.verdictHazards.innerHTML = "";
  const list = (serious.length ? serious : hazards).filter((h) => !h.notice); // show light rain / fog even on a calm day
  if (!list.length) {
    const li = document.createElement("li");
    li.textContent = "No weather hazards for you today.";
    el.verdictHazards.appendChild(li);
  }
  for (const h of list) {
    const li = document.createElement("li");
    li.className = `hz hz-${h.level}`;
    const b = document.createElement("b");
    b.textContent = h.title;
    const span = document.createElement("span");
    span.textContent = (h.level ? LEVEL_NAMES[h.level] + " · " : "") + h.detail;
    li.append(b, span);
    el.verdictHazards.appendChild(li);
  }
}

// "Power outage possible" heads-up with the reason (strong wind, ice, an official alert...).
function renderOutageNotice(hazards) {
  const outage = hazards.find((h) => h.id === "outage");
  $("outageNotice").hidden = !outage;
  if (outage) $("outageWhy").textContent = outage.detail.replace(/^From /, "Because of ") + ".";
}

// The sky banner: the weather for the chosen time over a live animated sky that matches it.
function renderHero(n) {
  const c = state.weather.current;
  const d = state.weather.daily;
  const h = state.weather.hourly;
  const { day, hour } = state.when;
  const k = day != null && hour != null ? hourIndex(day, hour) : -1;
  const hi = Math.round(d.temperature_2m_max[day ?? 0]);
  const lo = Math.round(d.temperature_2m_min[day ?? 0]);
  let temp, code, isDay, more;
  if (day == null) {
    [temp, code, isDay] = [c.temperature_2m, c.weather_code, c.is_day === 1];
    more = `Feels like ${n.feelsNow}° · H ${hi}°  L ${lo}°`;
  } else if (k >= 0) {
    [temp, code, isDay] = [h.temperature_2m[k], h.weather_code[k], h.is_day[k] === 1];
    more = `${whenLabel()} · feels like ${n.feelsNow}° · H ${hi}°  L ${lo}°`;
  } else {
    [temp, code, isDay] = [d.temperature_2m_max[day], d.weather_code[day], true];
    more = `${whenLabel()} · feels like ${n.feelsLo}° to ${n.feelsHi}° · low ${lo}°`;
  }
  const [, desc] = weatherInfo(code, isDay);
  $("heroPlace").textContent = state.place ? (state.place.fromGps ? "Your location" : state.place.name.split(",")[0]) : "";
  $("heroIcon").innerHTML = wxIcon(code, isDay, 64);
  $("heroTemp").textContent = `${Math.round(temp)}°`;
  $("heroCond").textContent = desc;
  $("heroMore").textContent = more;
  sky.set(code, isDay);
}

function renderReadings(n) {
  const w = state.weather;
  const c = w.current;
  const { day, hour } = state.when;
  const k = day != null && hour != null ? hourIndex(day, hour) : -1;
  const aqiText = (v) => (v == null ? "—" : String(Math.round(v)));
  const aqiNote = (v, extra) => (v == null ? "No air forecast this far ahead" : `${AQI_LEVELS[levelOf(v, AQI_LEVELS)][1]}${extra}`);
  let rows;
  if (day == null) {
    const aqiNow = state.air && state.air.current ? state.air.current.us_aqi : null;
    rows = [
      ["Feels like today", `${n.feelsLo}–${n.feelsHi}°`, "Humidity and wind included"],
      ["UV peak", String(Math.round(n.uv)), UV_LEVELS[levelOf(n.uv, UV_LEVELS)][1]],
      ["Air quality", aqiText(aqiNow), aqiNow == null ? "Not available" : `${AQI_LEVELS[levelOf(aqiNow, AQI_LEVELS)][1]} now · worst today ${Math.round(n.aqi)}`],
      ["Wind", `${Math.round(c.wind_speed_10m)} mph`, `Gusts to ${Math.round(n.gust)} mph${c.wind_direction_10m != null ? ` · from the ${compass(c.wind_direction_10m)}` : ""}`],
      ["Rain / snow", n.snow >= 0.1 ? `${n.snow.toFixed(1)}″ snow` : `${n.rain.toFixed(2)}″`, `${n.rainChance != null ? n.rainChance + "% chance today" : "Today's total"}`],
    ];
  } else if (k >= 0) {
    const dir = w.hourly.wind_direction_10m[k];
    rows = [
      ["Feels like", `${n.feelsNow}°`, `At ${hourLabel(hour)} · humidity and wind included`],
      ["UV", String(Math.round(n.uv)), UV_LEVELS[levelOf(n.uv, UV_LEVELS)][1]],
      ["Air quality", aqiText(n.aqi), aqiNote(n.aqi, ` at ${hourLabel(hour)}`)],
      ["Wind", `${Math.round(n.wind)} mph`, `Gusts to ${Math.round(n.gust)} mph${dir != null ? ` · from the ${compass(dir)}` : ""}`],
      ["Rain / snow", n.snow >= 0.1 ? `${n.snow.toFixed(1)}″ snow` : `${n.rain.toFixed(2)}″`, `${n.rainChance != null ? n.rainChance + "% chance at this hour · " : ""}day's total`],
    ];
  } else {
    rows = [
      ["Feels like", `${n.feelsLo}–${n.feelsHi}°`, "Lowest to highest that day"],
      ["UV peak", String(Math.round(n.uv)), UV_LEVELS[levelOf(n.uv, UV_LEVELS)][1]],
      ["Air quality", aqiText(n.aqi), aqiNote(n.aqi, " · worst that day")],
      ["Wind", `${Math.round(n.wind)} mph`, `Strongest that day · gusts to ${Math.round(n.gust)} mph`],
      ["Rain / snow", n.snow >= 0.1 ? `${n.snow.toFixed(1)}″ snow` : `${n.rain.toFixed(2)}″`, `${n.rainChance != null ? n.rainChance + "% chance" : "Day's total"}`],
    ];
  }
  el.readings.innerHTML = "";
  for (const [label, value, note] of rows) {
    const div = document.createElement("div");
    div.className = "reading";
    div.innerHTML = "<dt></dt><dd class='reading-value'></dd><dd class='reading-note'></dd>";
    div.querySelector("dt").textContent = label;
    div.querySelector(".reading-value").textContent = value;
    div.querySelector(".reading-note").textContent = note;
    el.readings.appendChild(div);
  }
}

function renderTips(hazards, profile) {
  const tips = [];
  const has = (id) => hazards.some((h) => h.id === id && (h.level > 0 || h.notice || id === "rain" || id === "fog"));
  // Heat and cold tips for everything about this person (the general ones if nothing has its own).
  let tipSets = profile.tips.map((t) => HEAT_COLD_TIPS[t]).filter(Boolean);
  if (!tipSets.length) tipSets = [HEAT_COLD_TIPS.standard];
  for (const h of hazards) {
    if (h.level === 0 && !h.notice && !["rain", "fog", "snow"].includes(h.id)) continue;
    const list = h.id === "heat" || h.id === "cold" ? tipSets.flatMap((s) => s[h.id]) : HAZARD_TIPS[h.id] || [];
    for (const t of list) tips.push({ text: t });
  }
  for (const [ids, text] of COMBO_TIPS) if (ids.every(has)) tips.push({ text, combo: true });
  if (profile.notes) for (const t of profile.notes) tips.push({ text: t });
  for (const h of hazards) if (h.level >= 2 && URGENT[h.id]) tips.push({ text: URGENT[h.id], urgent: true });
  if (!tips.length) {
    tips.push({ text: "Nothing to worry about from the weather today." });
    tips.push({ text: "Check the 7-day outlook below before making plans." });
  }

  el.tipsList.innerHTML = "";
  const seen = new Set();
  for (const t of tips) {
    if (seen.has(t.text)) continue;
    seen.add(t.text);
    addLi(el.tipsList, t.text, t.urgent ? "urgent" : t.combo ? "combo" : "");
  }
}

// ---------- People: saved on this device, pick one or add another ----------

const NO_CONDITION = /^(none|no|nope|n\/?a|nothing|-)$/i;

const activePerson = () => state.people.find((p) => p.id === state.activeId) || state.people[0] || null;

function savePeople() {
  store.set("people", state.people);
  store.set("activePerson", state.activeId);
}

const displayName = (p) => p.name || `Age ${p.age}`;

// "Age 72 · Asthma · Outdoor worker · Athlete"
function personSummary(p) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return [
    p.age != null ? `Age ${p.age}` : null,
    p.condition ? cap(p.condition) : null,
    ...p.types.map((t) => (t === "other" ? (p.other ? cap(p.other) : null) : IDENTITY_NAMES[t])),
  ]
    .filter(Boolean)
    .join(" · ");
}

// Typed text (a health condition, or "something else") -> sensitivity numbers, assessed once per text.
const assessed = new Map();
for (const p of state.people) for (const a of Object.values(p.assessed || {})) if (a) assessed.set(a.text, a);

async function assessText(text) {
  if (assessed.has(text)) return assessed.get(text);
  const res = await fetch("api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  // Keyword scoring that matched nothing means we don't know this condition.
  const unknown = data.source === "keywords" && !data.heat && !data.cold && !data.air;
  const result = { heat: data.heat, cold: data.cold, air: data.air, uv: data.uv, notes: data.notes || [], source: data.source, text, unknown };
  assessed.set(text, result);
  return result;
}

// The person as the form currently describes them.
function draftPerson() {
  const ageText = el.personAge.value.trim();
  const condition = el.personCondition.value.trim().slice(0, 200);
  const types = selectedTypes();
  const other = types.includes("other") ? el.personOther.value.trim().slice(0, 200) : "";
  const p = {
    id: state.editingId || "p" + Date.now().toString(36),
    name: el.personName.value.trim().slice(0, 40),
    age: ageText === "" || !Number.isFinite(Number(ageText)) ? null : Math.round(Number(ageText)),
    condition: NO_CONDITION.test(condition) ? "" : condition,
    types,
    other,
  };
  p.assessed = { condition: assessed.get(p.condition) || null, other: assessed.get(p.other) || null };
  return p;
}

let assessTimer;
let assessing = false;

function onPersonInput() {
  el.otherBox.hidden = !selectedTypes().includes("other");
  el.whoError.hidden = true;
  renderAssessment();
  clearTimeout(assessTimer);
  assessTimer = setTimeout(assessPending, 700);
}

// Assess anything typed that hasn't been assessed yet.
async function assessPending() {
  clearTimeout(assessTimer);
  const d = draftPerson();
  const texts = [d.condition, d.other].filter((t) => t.length >= 2 && !assessed.has(t));
  if (!texts.length) return;
  assessing = true;
  renderAssessment();
  await Promise.all(texts.map((t) => assessText(t).catch(() => null)));
  assessing = false;
  renderAssessment();
}

// The live "SafeTemp's assessment" box under the form.
function renderAssessment() {
  const d = draftPerson();
  if (d.age == null && !d.condition && !d.types.length) {
    el.assessment.innerHTML = "";
    return;
  }
  const p = combineParts(personParts(d));
  const head = p.heat || p.cold
    ? `Danger starts <b>${p.heat}°F sooner in heat</b> and <b>${p.cold}°F sooner in cold</b> than for most adults`
    : "Standard danger levels, the same as most adults";
  const extras = [p.air && "extra sensitive to air quality", p.uv && "extra sensitive to strong sun"].filter(Boolean);
  const notes = [];
  if (p.label) notes.push(`Based on: ${escapeHtml(p.label)}.`);
  if (assessing) notes.push("Checking what you typed…");
  else if (d.condition && d.assessed.condition && d.assessed.condition.unknown)
    notes.push(`We didn't recognize "${escapeHtml(d.condition)}", so we used the general numbers for health conditions.`);
  else if (d.other && d.assessed.other && d.assessed.other.unknown) notes.push(`"${escapeHtml(d.other)}" didn't change the numbers.`);
  el.assessment.innerHTML =
    `<b>SafeTemp's assessment:</b> ${head}${extras.length ? ", " + extras.join(", ") : ""}.` +
    notes.map((n) => `<p class="fine">${n}</p>`).join("");
}

function openEditor(person) {
  state.editingId = person ? person.id : null;
  el.personName.value = person ? person.name : "";
  el.personAge.value = person && person.age != null ? person.age : "";
  el.personCondition.value = person ? person.condition : "";
  el.personOther.value = person ? person.other || "" : "";
  for (const input of el.types.querySelectorAll("input")) input.checked = !!person && person.types.includes(input.value);
  el.whoSave.textContent = person ? "Save changes" : "Save person";
  el.whoCancel.hidden = !state.people.length;
  el.whoDelete.hidden = !person;
  disarmDelete();
  onPersonInput();
  showWho(true);
}

async function savePerson() {
  const ageText = el.personAge.value.trim();
  const age = Number(ageText);
  if (ageText === "" || !Number.isFinite(age) || age < 0 || age > 120) {
    el.whoError.textContent = "Enter an age from 0 to 120.";
    el.whoError.hidden = false;
    el.personAge.focus();
    return;
  }
  el.whoSave.disabled = true;
  await assessPending();
  el.whoSave.disabled = false;
  const p = draftPerson();
  const i = state.people.findIndex((x) => x.id === p.id);
  if (i >= 0) state.people[i] = p;
  else state.people.push(p);
  state.activeId = p.id;
  savePeople();
  showWho(false);
  render();
}

// Two taps to delete (an inline "are you sure", since some browsers block confirm pop-ups).
let deleteArmed = null;
function disarmDelete() {
  deleteArmed = null;
  el.whoDelete.textContent = "Delete this person";
  el.whoDelete.classList.remove("is-armed");
}

function deletePerson() {
  const p = state.people.find((x) => x.id === state.editingId);
  if (!p) return;
  if (deleteArmed !== p.id) {
    deleteArmed = p.id;
    el.whoDelete.textContent = `Tap again to delete ${displayName(p)}`;
    el.whoDelete.classList.add("is-armed");
    setTimeout(() => deleteArmed === p.id && disarmDelete(), 5000);
    return;
  }
  disarmDelete();
  state.people = state.people.filter((x) => x !== p);
  state.activeId = state.people[0] ? state.people[0].id : null;
  savePeople();
  if (!state.people.length) return openEditor(null);
  showWho(false);
  render();
}

function showWho(editing) {
  el.whoEdit.hidden = !editing;
  el.whoSummary.hidden = editing;
  if (editing) return;
  const active = activePerson();
  if (!active) return;
  // One pill per saved person, when there's more than one to pick from.
  el.peopleList.hidden = state.people.length < 2;
  el.peopleList.innerHTML = "";
  for (const p of state.people) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "person-pill";
    b.textContent = displayName(p);
    b.setAttribute("aria-pressed", p === active);
    b.addEventListener("click", () => {
      state.activeId = p.id;
      savePeople();
      showWho(false);
      render();
    });
    el.peopleList.appendChild(b);
  }
  // The name big, everything about them small and grey underneath.
  el.whoName.textContent = active.name || "You";
  el.whoIdentity.textContent = personSummary(active);
}

// ---------- AI advice (optional; hidden if the server has no AI key) ----------

const aiCache = new Map();
let aiAvailable = true;
let aiRequest = 0;

async function loadAiAdvice() {
  const t = state.today;
  if (!t || !aiAvailable) return;
  const aiCard = $("aiCard");
  const aiList = $("aiList");
  const aiStatus = $("aiStatus");
  const heatCold = t.hazards.find((h) => h.id === "heat" || h.id === "cold");
  const payload = {
    type: t.profile.tips.length === 1 ? t.profile.tips[0] : t.profile.label ? "other" : "standard",
    who: t.profile.label || "an adult",
    kind: heatCold ? heatCold.id : "safe",
    level: t.level,
    levelLabel: t.hazards.filter((h) => h.level > 0).map((h) => `${h.title} (${LEVEL_NAMES[h.level]})`).join(", ").slice(0, 200) || "Low risk",
    now: t.numbers.feelsNow ?? t.numbers.feelsHi,
    hi: t.numbers.feelsHi,
    lo: t.numbers.feelsLo,
    uvMax: Math.round(t.numbers.uv),
    aqi: t.numbers.aqi != null ? Math.round(t.numbers.aqi) : null,
    gust: Math.round(t.numbers.gust),
  };
  const key = JSON.stringify(payload);
  const id = ++aiRequest;
  aiCard.hidden = false;
  aiList.innerHTML = "";

  let result = aiCache.get(key);
  if (!result) {
    aiStatus.textContent = "Writing advice for you…";
    try {
      const res = await fetch("api/advice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 503 && /set up yet/.test(data.error || "")) {
        aiAvailable = false; // no AI key on this server: hide the card for good
        aiCard.hidden = true;
        return;
      }
      result = res.ok ? data : { error: data.error || "AI advice isn't available right now." };
      if (res.ok) aiCache.set(key, result);
    } catch {
      result = { error: "AI advice isn't available right now." };
    }
  }
  if (id !== aiRequest) return; // a newer request replaced this one
  aiStatus.textContent = result.error || "";
  for (const line of result.advice || []) addLi(aiList, line);
}

// ---------- 7-day outlook ----------

function renderForecast(profile) {
  const d = state.weather.daily;
  el.forecast.innerHTML = "";
  d.time.slice(0, 7).forEach((date, i) => {
    const hazards = assessDay(dayNumbers(i), profile);
    const level = overallLevel(hazards);
    const top = hazards.find((h) => h.level > 0) || hazards[0];
    const li = document.createElement("li");
    const day = document.createElement("span");
    day.className = "day";
    const dt = new Date(date + "T12:00");
    day.textContent = i === 0 ? "Today" : `${dt.toLocaleDateString("en-US", { weekday: "short" })} ${dt.getDate()}`;
    const [icon, desc] = weatherInfo(d.weather_code[i]);
    const wx = document.createElement("span");
    wx.className = "wx";
    wx.innerHTML = wxIcon(d.weather_code[i], true, 26);
    wx.appendChild(document.createTextNode(desc));
    const range = document.createElement("span");
    range.className = "range";
    range.textContent = `${Math.round(d.temperature_2m_max[i])}° / ${Math.round(d.temperature_2m_min[i])}°`;
    const tag = document.createElement("span");
    tag.className = `tag level-${level}`;
    tag.textContent = level && top ? `${top.title} · ${LEVEL_NAMES[level].toLowerCase()}` : top ? top.title : "Low risk";
    li.title = `${icon} ${desc} · tap to see this day`;
    li.append(day, wx, range, tag);
    // Tap a day to switch everything to it.
    li.tabIndex = 0;
    li.classList.toggle("is-selected", state.when.day === i);
    const pick = () => setWhen(i, null);
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick()));
    el.forecast.appendChild(li);
  });
}

// ---------- Checklist ----------

function renderSupplies(hazards, types) {
  // The top items for each hazard (3 for serious ones, 2 otherwise), most serious hazards first,
  // so every hazard you face is covered without the list getting too long.
  const ids = [];
  // A power outage notice comes first with its whole kit, so it stays together; other hazards get their top items.
  for (const h of [...hazards.filter((x) => x.notice), ...hazards.filter((x) => !x.notice)]) {
    const count = h.notice ? Infinity : h.level >= 2 ? 3 : 2;
    for (const id of (HAZARD_ITEMS[h.id] || []).slice(0, count)) if (!ids.includes(id) && ids.length < 14) ids.push(id);
  }
  for (const type of types) for (const id of PROFILE_ITEMS[type] || []) if (!ids.includes(id)) ids.push(id);
  if (!ids.length) ids.push("water", "powerBank");

  const names = hazards.map((h) => h.title.toLowerCase());
  el.suppliesFor.textContent = hazards.length ? `Picked for today: ${names.join(", ")}.` : "A few basics for any day.";

  el.supplies.innerHTML = "";
  for (const id of ids) {
    const item = ITEMS[id];
    const status = state.checks[id]; // undefined | "have" | "missing"
    const li = document.createElement("li");
    li.className = "supply" + (status ? " is-" + status : "");
    const label = document.createElement("span");
    label.className = "supply-name";
    label.textContent = item.name;
    const choices = document.createElement("span");
    choices.className = "supply-choices";
    for (const [value, text] of [["have", "Have it"], ["missing", "Need it"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.setAttribute("aria-pressed", status === value);
      b.addEventListener("click", () => {
        if (state.checks[id] === value) delete state.checks[id];
        else state.checks[id] = value;
        store.set("checks2", state.checks);
        renderSupplies(state.today.hazards, state.today.profile.tips);
      });
      choices.appendChild(b);
    }
    li.append(label, choices);
    if (status === "missing") {
      const get = document.createElement("div");
      get.className = "supply-get";
      if (item.amazon) {
        const a = document.createElement("a");
        a.href = amazonLink(item.amazon);
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "Find it on Amazon →";
        get.appendChild(a);
      }
      if (item.free) {
        const free = document.createElement("span");
        free.textContent = (item.amazon ? "Or free: " : "") + item.free;
        get.appendChild(free);
      }
      li.appendChild(get);
    }
    el.supplies.appendChild(li);
  }
}

// ---------- Helpers ----------

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

function addLi(list, text, cls) {
  const li = document.createElement("li");
  li.textContent = text;
  if (cls) li.className = cls;
  list.appendChild(li);
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------- Alerts on this device (push notifications) ----------
// Official weather alerts for the checked place arrive as notifications, even with the app closed.

const push = {
  supported: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
  registration: null,
};
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isHomeScreenApp = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;

function setPushStatus(text, on) {
  $("pushStatus").textContent = text;
  $("pushOn").hidden = !!on;
  $("pushTest").hidden = !on;
  $("pushOff").hidden = !on;
}

// The server wants the key as bytes.
function keyBytes(base64) {
  const b64 = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function postPush(action, body) {
  const res = await fetch(`api/push/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

const placeForAlerts = () => (state.place ? (state.place.fromGps ? "your location" : state.place.name.split(",")[0]) : "your location");

// Inside the SafeTemp phone app, alerts are real app notifications: the app hands over its push token.
let nativePushWaiting = null;
window.safeTempNativePush = (token, error) => {
  if (nativePushWaiting) nativePushWaiting(token, error);
  nativePushWaiting = null;
};
const nativePushToken = () =>
  new Promise((resolve, reject) => {
    nativePushWaiting = (token, error) => (token ? resolve(token) : reject(new Error(error || "Alerts aren't available.")));
    window.ReactNativeWebView.postMessage("push-token");
  });

// Who this device is to the server: the phone app's token, or the browser's push subscription.
async function alertDevice() {
  if (inPhoneApp) {
    const token = store.get("pushToken", null);
    return token ? { expoToken: token } : null;
  }
  const subscription = push.registration && (await push.registration.pushManager.getSubscription().catch(() => null));
  return subscription ? { subscription: subscription.toJSON() } : null;
}

async function turnOnAlerts() {
  if (!state.place) return setPushStatus("Pick a location first.");
  if (inPhoneApp) {
    try {
      const token = await nativePushToken();
      await postPush("subscribe", { expoToken: token, lat: state.place.lat, lon: state.place.lon, place: placeForAlerts() });
      store.set("pushToken", token);
      store.set("pushOn", true);
      showPushOn();
    } catch (err) {
      setPushStatus(String(err.message || err));
    }
    return;
  }
  if (isIos && !isHomeScreenApp) {
    setPushStatus("On iPhone and iPad, add SafeTemp to your Home Screen first (Share → Add to Home Screen), then turn on alerts from there.");
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushStatus("Notifications are blocked for this site. Allow them in your browser's site settings, then try again.");
      return;
    }
    const { publicKey } = await getJson("api/push/key");
    const subscription =
      (await push.registration.pushManager.getSubscription()) ||
      (await push.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    await postPush("subscribe", { subscription: subscription.toJSON(), lat: state.place.lat, lon: state.place.lon, place: placeForAlerts() });
    store.set("pushOn", true);
    showPushOn();
  } catch (err) {
    setPushStatus(`Couldn't turn on alerts in this browser (${err.message || err}). Try Chrome, Edge, Firefox or Safari.`);
  }
}

function showPushOn() {
  const usOnly = state.place && !/USA|United States/.test(state.place.name) && !state.place.fromGps ? " Official alerts only cover the US for now." : "";
  setPushStatus(`On for ${placeForAlerts()}. You'll get a notification when there's an official alert here.${usOnly}`, true);
}

async function turnOffAlerts() {
  try {
    const device = await alertDevice();
    if (device) await postPush("unsubscribe", device).catch(() => {});
    if (!inPhoneApp) {
      const subscription = await push.registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    }
  } catch {}
  store.set("pushOn", false);
  setPushStatus("Alerts are off on this device.");
}

async function sendTestAlert() {
  try {
    const device = await alertDevice();
    if (!device) return turnOnAlerts();
    await postPush("test", device);
    setPushStatus("Test sent. It should pop up in a few seconds.", true);
  } catch (err) {
    setPushStatus(String(err.message || err), true);
  }
}

// When the place changes, move this device's alerts to the new place.
async function syncAlertPlace() {
  if (!store.get("pushOn", false) || !state.place) return;
  const device = await alertDevice();
  if (!device) return;
  postPush("subscribe", { ...device, lat: state.place.lat, lon: state.place.lon, place: placeForAlerts() })
    .then(showPushOn)
    .catch(() => {});
}

async function setupAlerts() {
  $("pushOn").addEventListener("click", turnOnAlerts);
  $("pushOff").addEventListener("click", turnOffAlerts);
  $("pushTest").addEventListener("click", sendTestAlert);
  if (inPhoneApp) {
    if (store.get("pushOn", false) && store.get("pushToken", null)) showPushOn();
    return;
  }
  if (!push.supported) {
    $("pushBox").hidden = true;
    return;
  }
  try {
    push.registration = await navigator.serviceWorker.register("sw.js");
  } catch {
    $("pushBox").hidden = true;
    return;
  }
  const subscription = await push.registration.pushManager.getSubscription().catch(() => null);
  if (subscription && store.get("pushOn", false) && Notification.permission === "granted") showPushOn();
}

// ---------- Wire up ----------

if (state.people.length) {
  showWho(false);
} else {
  // First visit (or an older save with no people yet): fill in what we already know.
  openEditor(null);
  el.personName.value = store.get("personName", "");
  const oldCondition = (store.get("customProfiles", {}).health || {}).text;
  if (oldCondition) el.personCondition.value = oldCondition;
  const oldTypes = store.get("types", null) || [];
  for (const input of el.types.querySelectorAll("input")) input.checked = oldTypes.includes(input.value);
  onPersonInput();
}
el.whoChange.addEventListener("click", () => openEditor(activePerson()));
el.whoAdd.addEventListener("click", () => openEditor(null));
el.whoSave.addEventListener("click", savePerson);
el.whoCancel.addEventListener("click", () => showWho(false));
el.whoDelete.addEventListener("click", deletePerson);
el.types.addEventListener("change", onPersonInput);
for (const input of [el.personName, el.personAge, el.personCondition, el.personOther]) {
  input.addEventListener("input", onPersonInput);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      savePerson();
    }
  });
}
el.checkButton.addEventListener("click", check);
el.changeCity.addEventListener("click", showCityForm);
el.useMyLocation.addEventListener("click", () => findLocation(true));
el.cityInput.addEventListener("input", onCityTyping);
el.cityForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = el.cityInput.value.trim();
  if (!q) return;
  // Enter picks the top suggestion (searching first if suggestions haven't loaded yet).
  clearTimeout(cityTypingTimer);
  let first = el.cityResults.dataset.query === q.toLowerCase() && el.cityResults.querySelector("button");
  if (!first) {
    await searchCity(q);
    first = el.cityResults.querySelector("button");
  }
  if (first) first.click();
});

setupWhenBar();
findLocation();
setupAlerts();
