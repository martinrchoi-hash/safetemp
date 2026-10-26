// Weather graphics and the animated sky banner behind today's weather.
// Small icons for each kind of weather, and a live sky: sun glow, drifting clouds,
// falling rain or snow, lightning, stars at night, rolling fog. Respects "reduce motion".

// Which scene a WMO weather code belongs to.
function sceneOf(code, isDay = true) {
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if ([56, 57, 66, 67].includes(code)) return "sleet";
  if ((code >= 61 && code <= 65) || (code >= 80 && code <= 82)) return "rain";
  if (code >= 51 && code <= 55) return "drizzle";
  if (code === 45 || code === 48) return "fog";
  if (code === 3) return "cloudy";
  if (code === 2) return isDay ? "partly" : "partly-night";
  return isDay ? "clear" : "clear-night";
}

// ---------- Icons (small inline SVGs, drawn to read at 20–64px) ----------

const ICON_PARTS = {
  sun: '<circle cx="24" cy="24" r="8.5" fill="#f6b73c"/><g stroke="#f6b73c" stroke-width="2.6" stroke-linecap="round"><path d="M24 6v4M24 38v4M6 24h4M38 24h4M11.3 11.3l2.8 2.8M33.9 33.9l2.8 2.8M11.3 36.7l2.8-2.8M33.9 14.1l2.8-2.8"/></g>',
  smallSun: '<circle cx="17" cy="16" r="6.5" fill="#f6b73c"/><g stroke="#f6b73c" stroke-width="2.2" stroke-linecap="round"><path d="M17 3.5v3M4.5 16h3M8.2 7.2l2.1 2.1M25.8 7.2l-2.1 2.1"/></g>',
  moon: '<path d="M30 8a16 16 0 1 0 10 27A13 13 0 0 1 30 8z" fill="#e9e2c4"/>',
  smallMoon: '<path d="M19 5a10 10 0 1 0 7 17A8 8 0 0 1 19 5z" fill="#e9e2c4"/>',
  cloud: '<path d="M14 36h21a8 8 0 0 0 .9-15.95A11 11 0 0 0 15.2 22.2 7 7 0 0 0 14 36z" fill="#eef2f6" stroke="#9fb0c2" stroke-width="1.6"/>',
  darkCloud: '<path d="M14 32h21a8 8 0 0 0 .9-15.95A11 11 0 0 0 15.2 18.2 7 7 0 0 0 14 32z" fill="#c6d0db" stroke="#7d8ea2" stroke-width="1.6"/>',
  rain: '<g stroke="#3d8bd9" stroke-width="2.4" stroke-linecap="round"><path d="M17 36l-2 6M25 36l-2 6M33 36l-2 6"/></g>',
  drizzle: '<g fill="#3d8bd9"><circle cx="17" cy="39" r="1.6"/><circle cx="25" cy="41" r="1.6"/><circle cx="33" cy="39" r="1.6"/></g>',
  snow: '<g fill="#8fb8e0"><circle cx="17" cy="38" r="2"/><circle cx="25" cy="42" r="2"/><circle cx="33" cy="38" r="2"/></g>',
  sleet: '<g stroke="#3d8bd9" stroke-width="2.2" stroke-linecap="round"><path d="M17 36l-1.5 5M33 36l-1.5 5"/></g><circle cx="25" cy="41" r="2" fill="#8fb8e0"/>',
  bolt: '<path d="M26 30l-6 9h5l-3 7 9-11h-5l3-5z" fill="#f6b73c" stroke="#d9951f" stroke-width=".8" stroke-linejoin="round"/>',
  fog: '<g stroke="#9fb0c2" stroke-width="2.6" stroke-linecap="round"><path d="M9 20h30M13 27h26M9 34h24"/></g>',
};

function wxIcon(code, isDay = true, size = 28) {
  const p = ICON_PARTS;
  const parts = {
    clear: p.sun,
    "clear-night": p.moon,
    partly: p.smallSun + p.cloud,
    "partly-night": p.smallMoon + p.cloud,
    cloudy: p.cloud,
    fog: p.fog,
    drizzle: p.darkCloud + p.drizzle,
    rain: p.darkCloud + p.rain,
    sleet: p.darkCloud + p.sleet,
    snow: p.cloud + p.snow,
    storm: p.darkCloud + p.rain + p.bolt,
  }[sceneOf(code, isDay)];
  return `<svg class="wx-icon" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true">${parts}</svg>`;
}

// ---------- Animated sky ----------

const sky = {
  el: null,
  canvas: null,
  ctx: null,
  scene: null,
  frame: 0,
  drops: [],

  set(code, isDay) {
    this.el = this.el || document.getElementById("hero");
    if (!this.el) return;
    const scene = sceneOf(code, isDay);
    const night = !isDay;
    this.el.className = `hero scene-${scene}${night ? " is-night" : ""}`;
    if (scene === this.scene && this.night === night) return;
    this.scene = scene;
    this.night = night;
    this.canvas = this.canvas || this.el.querySelector(".hero-fx");
    this.ctx = this.canvas.getContext("2d");
    this.resize();
    this.seed();
    if (!this.frame) this.loop();
  },

  still() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  },

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  // Particles for the current scene: raindrops, snowflakes or stars.
  seed() {
    const area = this.w * this.h;
    // Pixels of sky per particle: smaller number = more particles.
    const perParticle = { rain: 900, storm: 700, drizzle: 2600, sleet: 1300, snow: 1900, "clear-night": 2400, "partly-night": 3600 }[this.scene];
    const n = perParticle ? area / perParticle : 0;
    this.drops = Array.from({ length: Math.round(n) }, () => this.spawn(true));
  },

  spawn(anywhere) {
    const s = this.scene;
    const snowy = s === "snow" || (s === "sleet" && Math.random() < 0.4);
    if (s.endsWith("night")) {
      return { kind: "star", x: Math.random() * this.w, y: Math.random() * this.h * 0.75, r: Math.random() * 1.2 + 0.3, t: Math.random() * 6 };
    }
    return {
      kind: snowy ? "snow" : "rain",
      x: Math.random() * (this.w + 60) - 30,
      y: anywhere ? Math.random() * this.h : -20,
      v: snowy ? 0.4 + Math.random() * 0.7 : (s === "drizzle" ? 5 : 9) + Math.random() * 6,
      len: s === "drizzle" ? 6 : 12 + Math.random() * 10,
      r: snowy ? 1.2 + Math.random() * 2.2 : 0,
      sway: Math.random() * Math.PI * 2,
    };
  },

  loop() {
    const tick = (time) => {
      this.draw(time);
      this.frame = this.still() || document.hidden ? 0 : requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  },

  draw(time) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);
    for (const d of this.drops) {
      if (d.kind === "star") {
        const a = 0.35 + 0.65 * Math.abs(Math.sin(time / 1400 + d.t));
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      if (d.kind === "snow") {
        d.y += d.v;
        d.x += Math.sin(time / 900 + d.sway) * 0.4;
        ctx.fillStyle = "rgba(255,255,255,.9)";
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        d.y += d.v;
        d.x -= d.v * 0.18;
        ctx.strokeStyle = "rgba(220,232,245,.55)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x + d.len * 0.18, d.y - d.len);
        ctx.stroke();
      }
      if (d.y > this.h + 20 || d.x < -40) Object.assign(d, this.spawn(false));
    }
  },
};

window.addEventListener("resize", () => {
  if (!sky.el || !sky.canvas) return;
  sky.resize();
  sky.seed();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && sky.el && !sky.frame) sky.loop();
});
