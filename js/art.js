// Procedural SVG artworks (original, generated in the browser).
(function () {
  const SCALE = 4;

  function rng(seed) {
    let s = 0;
    for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  function mix(c1, c2, t) {
    const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const a = p(c1), b = p(c2);
    return "#" + a.map((v, i) => Math.round(lerp(v, b[i], t)).toString(16).padStart(2, "0")).join("");
  }
  function gradientAt(palette, t) {
    const n = palette.length - 1;
    const i = Math.min(Math.floor(t * n), n - 1);
    return mix(palette[i], palette[i + 1], t * n - i);
  }

  const painters = {
    rings(w, h, pal) {
      const cx = w * 0.5, cy = h * 0.5, max = Math.hypot(w, h) / 2;
      let out = `<rect width="${w}" height="${h}" fill="${pal[0]}"/>`;
      const steps = 34;
      for (let i = steps; i > 0; i--) {
        const r = (i / steps) * max;
        const off = Math.sin(i * 0.6) * w * 0.012;
        out += `<circle cx="${cx + off}" cy="${cy - off}" r="${r}" fill="${pal[1 + (i % (pal.length - 1))]}"/>`;
      }
      return out;
    },
    waves(w, h, pal) {
      let out = `<rect width="${w}" height="${h}" fill="${pal[1]}"/>`;
      const lines = 60, gap = h / lines;
      for (let i = 0; i < lines; i++) {
        const y0 = i * gap + gap / 2;
        let d = `M0 ${y0}`;
        for (let x = 0; x <= w; x += w / 80) {
          const dist = Math.hypot(x - w / 2, y0 - h / 2) / (w / 2);
          const amp = Math.max(0, 1 - dist) * gap * 1.6;
          d += ` L${x.toFixed(1)} ${(y0 + Math.sin(x / (w / 14)) * amp).toFixed(1)}`;
        }
        out += `<path d="${d}" stroke="${pal[0]}" stroke-width="${gap * 0.42}" fill="none"/>`;
      }
      return out;
    },
    mobile(w, h, pal, r) {
      let out = `<rect width="${w}" height="${h}" fill="${pal[0]}"/>`;
      const cols = 16, rows = 22, cw = w / cols, ch = h / rows;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const rot = Math.abs(Math.sin(i * 0.5 + j * 0.3 + r() * 0.8));
          const pw = cw * 0.75 * rot + 1;
          const shade = mix(pal[1], pal[2], r());
          out += `<rect x="${i * cw + (cw - pw) / 2}" y="${j * ch + ch * 0.1}" width="${pw}" height="${ch * 0.8}" fill="${shade}" opacity="${0.35 + rot * 0.65}"/>`;
        }
      }
      return out;
    },
    squares(w, h, pal) {
      let out = `<rect width="${w}" height="${h}" fill="${pal[0]}"/>`;
      const n = 10, s = w / n;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const k = (i + j) % (pal.length - 1);
          const ang = ((i * j) % 14) * 6.4;
          out += `<rect x="${i * s + s * 0.15}" y="${j * s + s * 0.15}" width="${s * 0.7}" height="${s * 0.7}" fill="${pal[k + 1]}" transform="rotate(${ang} ${i * s + s / 2} ${j * s + s / 2})"/>`;
        }
      }
      return out;
    },
    bars(w, h, pal) {
      let out = "";
      const n = 48, bw = w / n;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        out += `<rect x="${i * bw}" y="0" width="${bw + 0.5}" height="${h}" fill="${gradientAt(pal, t)}"/>`;
        out += `<rect x="${i * bw + bw * 0.4}" y="0" width="${bw * 0.2}" height="${h}" fill="${gradientAt(pal, 1 - t)}"/>`;
      }
      return out;
    },
    sphere(w, h, pal) {
      let out = `<rect width="${w}" height="${h}" fill="${pal[1]}"/>`;
      const n = 28, s = w / n;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const x = i * s + s / 2, y = j * s + s / 2;
          const d = Math.hypot(x - w / 2, y - h / 2) / (w * 0.42);
          const rad = d < 1 ? s * 0.48 * Math.sqrt(1 - d * d) + s * 0.08 : s * 0.12;
          out += `<circle cx="${x}" cy="${y}" r="${rad.toFixed(2)}" fill="${pal[0]}"/>`;
        }
      }
      return out;
    },
    glow(w, h, pal, r) {
      let defs = "<defs>", body = "";
      pal.slice(1).forEach((c, i) => {
        defs += `<radialGradient id="g${i}"><stop offset="0" stop-color="${c}" stop-opacity="0.95"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`;
        body += `<circle cx="${w * (0.25 + r() * 0.5)}" cy="${h * (0.25 + r() * 0.5)}" r="${w * (0.3 + r() * 0.2)}" fill="url(#g${i})" style="mix-blend-mode:screen"/>`;
      });
      defs += "</defs>";
      let frame = "";
      for (let i = 1; i <= 6; i++) {
        const m = (w * i) / 16;
        frame += `<rect x="${m}" y="${m}" width="${w - m * 2}" height="${h - m * 2}" fill="none" stroke="#ffffff" stroke-opacity="${0.05 + i * 0.03}" stroke-width="2"/>`;
      }
      return `${defs}<rect width="${w}" height="${h}" fill="${pal[0]}"/>${body}${frame}`;
    },
    checker(w, h, pal) {
      let out = "";
      const n = 16, s = w / n;
      const warp = (x, y) => {
        const dx = x - w / 2, dy = y - h / 2;
        const k = 1 + 0.25 * Math.cos(Math.hypot(dx, dy) / (w * 0.12));
        return [w / 2 + dx * k * 0.9, h / 2 + dy * k * 0.9];
      };
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const pts = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]]
            .map(([a, b]) => warp(a * s, b * s).map((v) => v.toFixed(1)).join(","))
            .join(" ");
          const fill = (i + j) % 2 ? pal[0] : pal[1];
          out += `<polygon points="${pts}" fill="${(i === 7 || i === 8) && (j === 7 || j === 8) ? pal[2] : fill}"/>`;
        }
      }
      return `<rect width="${w}" height="${h}" fill="${pal[1]}"/>${out}`;
    }
  };

  const DEFAULT_PALETTES = {
    rings: ["#0b0b2b", "#e63946", "#f4a261", "#2a9d8f", "#e9c46a", "#264653"],
    waves: ["#111111", "#f1faee"],
    mobile: ["#0a0a0a", "#c0c6cc", "#ffffff"],
    squares: ["#14213d", "#fca311", "#e5e5e5", "#d62828", "#3a86ff", "#8338ec", "#06d6a0"],
    bars: ["#03045e", "#0077b6", "#00b4d8", "#90e0ef", "#caf0f8", "#ffb703", "#fb8500"],
    sphere: ["#000000", "#ffffff"],
    glow: ["#0b0c10", "#ff006e", "#8338ec", "#3a86ff", "#ffbe0b"],
    checker: ["#1d3557", "#f1faee", "#e63946"]
  };
  window.ART_KINDS = Object.keys(DEFAULT_PALETTES);

  const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  // variant: "main" | "detail"
  window.renderArtwork = function (work, variant = "main") {
    const photo = work.image || (Array.isArray(work.images) && work.images[0]);
    if (photo) {
      return `<img class="art-img ${variant === "detail" ? "detail" : ""}" src="${escAttr(photo)}" alt="${escAttr(work.title)}" loading="lazy" />`;
    }
    const w = work.width * SCALE, h = work.height * SCALE;
    const kind = painters[work.art && work.art.kind] ? work.art.kind : "rings";
    const palette = (work.art && work.art.palette) || DEFAULT_PALETTES[kind];
    const content = painters[kind](w, h, palette, rng(work.id || work.title || "x"));
    const vb = variant === "detail" ? `${w * 0.3} ${h * 0.3} ${w * 0.4} ${h * 0.4}` : `0 0 ${w} ${h}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escAttr(work.title)}">${content}</svg>`;
  };
})();
