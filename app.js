"use strict";
/* ---------- helpers ---------- */
/* Skip empty slots (null/false) when filling an element, so they never show up as the word "null". */
{ const rc = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...k) { return rc.apply(this, k.flat(Infinity).filter(x => x != null && x !== false)); }; }
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let late = null;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked") (late = late || {})[k] = v;
    else if (k === "for" || k.startsWith("aria-") || k.startsWith("data-") || k === "role") el.setAttribute(k, v === true ? "" : v);
    else if (k in el) { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  if (late) for (const k in late) el[k] = late[k];
  return el;
}
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
const slug = s => (s || "musings").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "musings";

/* ---------- storage (IndexedDB, with in-memory fallback) ---------- */
const DB = {
  db: null, mem: false, memKV: new Map(), memBlobs: new Map(),
  async open() {
    if (this.db || this.mem) return;
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open("musings-studio-app", 1);
        r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("kv"); d.createObjectStore("blobs"); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        setTimeout(() => rej(new Error("timeout")), 4000);
      });
    } catch (e) { this.mem = true; }
  },
  _store(name) { return name === "kv" ? this.memKV : this.memBlobs; },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => res(r && r.result);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  async get(s, k) { if (this.mem) return this._store(s).get(k); return this.tx(s, "readonly", st => st.get(k)); },
  async put(s, k, v) { if (this.mem) { this._store(s).set(k, v); return; } return this.tx(s, "readwrite", st => st.put(v, k)); },
  async del(s, k) { if (this.mem) { this._store(s).delete(k); return; } return this.tx(s, "readwrite", st => st.delete(k)); },
  async keys(s) { if (this.mem) return [...this._store(s).keys()]; return this.tx(s, "readonly", st => st.getAllKeys()); },
  async clear(s) { if (this.mem) { this._store(s).clear(); return; } return this.tx(s, "readwrite", st => st.clear()); }
};

const blobCache = new Map();
async function putBlob(blob) { const id = "b" + uid(); await DB.put("blobs", id, blob); return id; }
async function blobURL(id) {
  if (!id) return null;
  const c = blobCache.get(id); if (c) return c.url;
  const b = await DB.get("blobs", id); if (!b) return null;
  const url = URL.createObjectURL(b); blobCache.set(id, { url }); return url;
}
async function loadImg(id) {
  const url = await blobURL(id); if (!url) return null;
  const c = blobCache.get(id);
  if (!c.img) c.img = new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = url; });
  return c.img;
}
async function importImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const max = 2400, s = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s);
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.9));
    return await putBlob(blob);
  } catch (e) { toast("That image couldn't be opened. Try a JPG or PNG."); return null; }
  finally { URL.revokeObjectURL(url); }
}
function pickFile(accept) {
  return new Promise(res => {
    const inp = h("input", { type: "file", accept, style: "display:none" });
    inp.addEventListener("change", () => { res(inp.files[0] || null); inp.remove(); });
    document.body.append(inp); inp.click();
  });
}
function blobRefs(s = state) {
  const refs = new Set(), state_ = s;
  state_.notes.forEach(n => n.img && refs.add(n.img));
  state_.decks.forEach(d => d.cards.forEach(c => c.bg.img && refs.add(c.bg.img)));
  state_.fonts.forEach(f => f.blobId && refs.add(f.blobId));
  return refs;
}
async function gcBlob(id) {
  if (!id || blobRefs().has(id)) return;
  await DB.del("blobs", id).catch(() => {});
  const c = blobCache.get(id); if (c) { URL.revokeObjectURL(c.url); blobCache.delete(id); }
}

/* ---------- state ---------- */
let state = null;
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); if (window.Drive) Drive.markDirty(); }
async function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  try { await DB.put("kv", "state", state); }
  catch (e) { toast("Couldn't save. Your browser storage may be full."); }
}
document.addEventListener("visibilitychange", () => { if (document.hidden && saveTimer) saveNow(); });
window.addEventListener("pagehide", () => { if (saveTimer) saveNow(); });
function touch(deck) { if (deck) deck.updated = Date.now(); saveSoon(); }

const ASPECTS = { "4:5": [1080, 1350], "3:4": [1080, 1440], "1:1": [1080, 1080], "9:16": [1080, 1920] };
const SEED_FONTS = [
  ["Playfair Display", "Playfair+Display:ital,wght@0,400;0,700;1,400;1,700"],
  ["Montserrat", "Montserrat:ital,wght@0,400;0,600;0,700;0,800;1,400;1,600;1,700;1,800"],
  ["Cormorant Garamond", "Cormorant+Garamond:ital,wght@0,400;0,600;1,400;1,600"],
  ["Libre Baskerville", "Libre+Baskerville:ital,wght@0,400;0,700;1,400"],
  ["EB Garamond", "EB+Garamond:ital,wght@0,400;0,700;1,400;1,700"],
  ["Lora", "Lora:ital,wght@0,400;0,700;1,400;1,700"],
  ["Cinzel", "Cinzel:wght@400;700"],
  ["Raleway", "Raleway:ital,wght@0,400;0,700;1,400;1,700"],
  ["Josefin Sans", "Josefin+Sans:ital,wght@0,300;0,600;1,300;1,600"],
  ["Great Vibes", "Great+Vibes"],
  ["Special Elite", "Special+Elite"]
];
const PRELOADED = new Set(SEED_FONTS.map(f => f[0]));

function L(o) {
  return Object.assign({ id: uid(), text: "Text", font: "Montserrat", size: 60, weight: 700, italic: false, color: "#FFFFFF",
    align: "center", x: 0.5, y: 0.5, w: 0.8, opacity: 1, lh: 1.25, box: false, boxColor: "#000000", boxOpacity: 0.55, shadow: true }, o);
}
function newBg(o) { return Object.assign({ img: null, color: "#34322F", color2: "#56524C", tone: "sepia", strength: 1, dim: 0.15, zoom: 1, fx: 0.5, fy: 0.5 }, o); }
function newCard(layers, bg) { return { id: uid(), bg: newBg(bg), layers: (layers || []).map(l => L(l)) }; }

function starterTypes() {
  const T = (name, layers, bg) => ({ id: uid(), name, card: newCard(layers, bg) });
  return [
    T("Title", [
      { text: "“Come, Follow Me”\nMusings", font: "Playfair Display", size: 70, weight: 700, y: 0.44, w: 0.8, lh: 1.2 },
      { text: "Chapter", font: "Playfair Display", size: 62, weight: 700, y: 0.58 }
    ], { color: "#2E2720", color2: "#7E6247" }),
    T("Statement", [{ text: "Your line", font: "Montserrat", size: 96, weight: 800, italic: true, y: 0.5, w: 0.78, lh: 1.12 }]),
    T("Whisper", [{ text: "A quiet line", font: "Cormorant Garamond", size: 46, weight: 400, italic: true, y: 0.5, w: 0.8, opacity: 0.88, shadow: true }], { color: "#1E1C1A", color2: "#5A554E" }),
    T("Quote + credit", [
      { text: "“Quote goes here”", font: "Montserrat", size: 50, weight: 600, italic: true, color: "#F3E3C3", y: 0.3, w: 0.84, lh: 1.5 },
      { text: "Caption line", font: "Libre Baskerville", size: 30, weight: 400, italic: true, y: 0.8, w: 0.62, box: true, boxOpacity: 0.6, shadow: false, lh: 1.5 },
      { text: "Name", font: "Libre Baskerville", size: 26, weight: 700, italic: true, x: 0.84, y: 0.93, w: 0.25, align: "right", opacity: 0.9 }
    ]),
    T("Scripture", [
      { text: "Verse text", font: "Montserrat", size: 64, weight: 600, y: 0.44, w: 0.78, lh: 1.3 },
      { text: "Book 1:1", font: "Montserrat", size: 30, weight: 400, italic: true, y: 0.88, opacity: 0.7 }
    ], { color: "#24211E", color2: "#6C6358" }),
    T("Response", [
      { text: "Your response", font: "Montserrat", size: 70, weight: 700, italic: true, y: 0.5, w: 0.84 },
      { text: "small line", font: "Cormorant Garamond", size: 40, weight: 400, italic: true, y: 0.64, opacity: 0.9 }
    ], { color: "#3A332C", color2: "#A08E78" })
  ];
}
function cardFromType(t) { const c = clone(t.card); c.id = uid(); c.layers.forEach(l => l.id = uid()); return c; }
function seed() {
  const types = starterTypes();
  const by = n => types.find(t => t.name === n);
  const order = ["Title", "Statement", "Quote + credit", "Whisper", "Scripture", "Whisper", "Statement", "Response"];
  const tmplCards = order.map(n => cardFromType(by(n)));
  const now = Date.now();
  const example = { id: uid(), name: "Example deck", aspect: "4:5", created: now, updated: now, cards: order.map(n => cardFromType(by(n))) };
  return {
    v: 1,
    notes: [{ id: uid(), text: "Example note. Jot anything here: a verse, a line, a song, a photo of a notepad page.\n\nTap Edit or Delete below.", img: null, created: now, updated: now }],
    decks: [example],
    cardTypes: types,
    templates: [{ id: uid(), name: "Musings, 8 cards", aspect: "4:5", cards: tmplCards }],
    fonts: SEED_FONTS.map(([family, q]) => ({ family, source: "google", q })),
    usage: { fonts: {}, colors: ["#FFFFFF", "#F3E3C3", "#1C1B19"] },
    lastStyle: null
  };
}

/* ---------- fonts ---------- */
const fontLoaded = new Set();
function fontStr(l, scale) { return `${l.italic ? "italic " : ""}${l.weight || 400} ${Math.max(1, Math.round(l.size * scale))}px "${l.font}", Georgia, serif`; }
async function ensureFont(l) {
  const key = `${l.italic ? "i" : "n"}${l.weight}|${l.font}`;
  if (fontLoaded.has(key)) return;
  try { await Promise.race([document.fonts.load(fontStr(l, 1).replace(/\d+px/, "40px")), new Promise(r => setTimeout(r, 3000))]); } catch (e) {}
  fontLoaded.add(key);
}
function addGoogleLink(q) {
  return new Promise(res => {
    const link = h("link", { rel: "stylesheet", href: `https://fonts.googleapis.com/css2?family=${q}&display=swap` });
    link.onload = () => res(true); link.onerror = () => { link.remove(); res(false); };
    document.head.append(link);
  });
}
async function loadCustomFont(f) {
  try {
    const b = await DB.get("blobs", f.blobId); if (!b) return false;
    const face = new FontFace(f.family, await b.arrayBuffer());
    await face.load(); document.fonts.add(face); return true;
  } catch (e) { return false; }
}
async function loadAllFonts() {
  for (const f of state.fonts) {
    if (f.source === "google" && !PRELOADED.has(f.family)) addGoogleLink(f.q);
    if (f.source === "custom") loadCustomFont(f);
  }
}
function fontsByUse() {
  const u = state.usage.fonts;
  return [...state.fonts].sort((a, b) => (u[b.family] || 0) - (u[a.family] || 0) || a.family.localeCompare(b.family));
}
function bumpFont(fam) { state.usage.fonts[fam] = (state.usage.fonts[fam] || 0) + 1; }
function rememberColor(c) {
  c = c.toUpperCase();
  state.usage.colors = [c, ...state.usage.colors.filter(x => x !== c)].slice(0, 10);
}

/* ---------- rendering ---------- */
const bgCache = new Map();
function applyTone(x, W, H, tone, k) {
  const d = x.getImageData(0, 0, W, H), p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i], g = p[i + 1], b = p[i + 2]; let R, G, B;
    if (tone === "sepia") { R = (r * .393 + g * .769 + b * .189) * .9 + 14; G = (r * .349 + g * .686 + b * .168) * .9 + 10; B = (r * .272 + g * .534 + b * .131) * .9 + 6; }
    else if (tone === "mono") { R = G = B = r * .299 + g * .587 + b * .114; }
    else if (tone === "warm") { R = r * 1.06 + 8; G = g + 3; B = b * .86; }
    else { R = r; G = g; B = b; }
    p[i] = r + (R - r) * k; p[i + 1] = g + (G - g) * k; p[i + 2] = b + (B - b) * k;
  }
  x.putImageData(d, 0, 0);
}
async function bgCanvas(bg, W, H) {
  const key = JSON.stringify([bg.img, bg.color, bg.color2, bg.tone, bg.strength, bg.dim, bg.zoom, bg.fx, bg.fy, W, H]);
  if (bgCache.has(key)) return bgCache.get(key);
  const img = bg.img ? await loadImg(bg.img) : null;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d", { willReadFrequently: true });
  if (img) {
    const s = Math.max(W / img.naturalWidth, H / img.naturalHeight) * (bg.zoom || 1);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    x.drawImage(img, (W - dw) * (bg.fx ?? .5), (H - dh) * (bg.fy ?? .5), dw, dh);
    if (bg.tone && bg.tone !== "none" && bg.strength > 0) applyTone(x, W, H, bg.tone, bg.strength);
  } else {
    const g = x.createLinearGradient(0, 0, W * 0.35, H);
    g.addColorStop(0, bg.color || "#3B332B"); g.addColorStop(1, bg.color2 || bg.color || "#8A765F");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
  }
  if (bg.dim > 0) { x.fillStyle = `rgba(0,0,0,${bg.dim})`; x.fillRect(0, 0, W, H); }
  bgCache.set(key, c);
  if (bgCache.size > 24) bgCache.delete(bgCache.keys().next().value);
  return c;
}
function wrapLines(x, text, maxW) {
  const out = [];
  for (const para of String(text).split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    const parts = para.split(/(\s+)/); let line = "";
    for (const w of parts) {
      const test = line + w;
      if (x.measureText(test).width > maxW && line.trim()) { out.push(line.trimEnd()); line = w.trimStart(); }
      else line = test;
    }
    out.push(line.trimEnd());
  }
  return out;
}
function drawLayer(x, l, W, H, scale) {
  x.save();
  x.font = fontStr(l, scale);
  const maxW = l.w * W, fs = l.size * scale, lh = fs * (l.lh || 1.25);
  const lines = wrapLines(x, l.text || " ", maxW);
  const bw = Math.max(1, ...lines.map(s => x.measureText(s).width));
  const blockH = lines.length * lh, cx = l.x * W, cy = l.y * H, align = l.align || "center";
  const left = align === "left" ? cx - maxW / 2 : align === "right" ? cx + maxW / 2 - bw : cx - bw / 2;
  const top = cy - blockH / 2, padX = fs * 0.55, padY = fs * 0.35;
  let bb = { x: left - padX, y: top - padY, w: bw + padX * 2, h: blockH + padY * 2 };
  if (l.box) {
    x.globalAlpha = l.boxOpacity ?? .55; x.fillStyle = l.boxColor || "#000"; x.beginPath();
    const shape = l.boxShape || "square";
    const rad = (w, hh) => shape === "pill" ? hh / 2 : shape === "rounded" ? Math.min(w, hh) * 0.22 : 0;
    if ((l.boxFit || "block") === "line") {
      const lx = fs * 0.5, lhh = fs * 1.35; let minX = Infinity, maxX = -Infinity;
      lines.forEach((s, i) => {
        if (!s.trim()) return;
        const tw = x.measureText(s).width, cyL = top + lh * (i + 0.5);
        const sx = align === "left" ? cx - maxW / 2 : align === "right" ? cx + maxW / 2 - tw : cx - tw / 2;
        const r = { x: sx - lx, y: cyL - lhh / 2, w: tw + lx * 2, h: lhh };
        roundRectPath(x, r.x, r.y, r.w, r.h, rad(r.w, r.h));
        minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x + r.w);
      });
      if (minX < Infinity) bb = { x: minX, y: top + lh / 2 - lhh / 2, w: maxX - minX, h: blockH - lh + lhh };
    } else {
      const px2 = shape === "pill" ? padX * 1.3 : padX;
      bb = { x: left - px2, y: top - padY, w: bw + px2 * 2, h: blockH + padY * 2 };
      roundRectPath(x, bb.x, bb.y, bb.w, bb.h, rad(bb.w, bb.h));
    }
    x.fill("nonzero");
  }
  x.globalAlpha = l.opacity ?? 1; x.fillStyle = l.color || "#fff"; x.textBaseline = "middle"; x.textAlign = align;
  if (l.shadow) { x.shadowColor = "rgba(0,0,0,.45)"; x.shadowBlur = fs * 0.25; x.shadowOffsetY = fs * 0.04; }
  const ax = align === "left" ? cx - maxW / 2 : align === "right" ? cx + maxW / 2 : cx;
  lines.forEach((s, i) => x.fillText(s, ax, top + lh * (i + 0.5)));
  x.restore();
  return { id: l.id, x: Math.min(bb.x, left - padX), y: Math.min(bb.y, top - padY), w: Math.max(bb.x + bb.w, left + bw + padX) - Math.min(bb.x, left - padX), h: Math.max(bb.y + bb.h, top + blockH + padY) - Math.min(bb.y, top - padY) };
}
function roundRectPath(x, rx, ry, w, hh, r) {
  r = Math.max(0, Math.min(r, w / 2, hh / 2));
  x.moveTo(rx + r, ry); x.lineTo(rx + w - r, ry); x.arcTo(rx + w, ry, rx + w, ry + r, r);
  x.lineTo(rx + w, ry + hh - r); x.arcTo(rx + w, ry + hh, rx + w - r, ry + hh, r);
  x.lineTo(rx + r, ry + hh); x.arcTo(rx, ry + hh, rx, ry + hh - r, r);
  x.lineTo(rx, ry + r); x.arcTo(rx, ry, rx + r, ry, r); x.closePath();
}
async function renderCard(card, cv, W, H, opt = {}) {
  const scale = opt.scale || 1, w = Math.round(W * scale), hh = Math.round(H * scale);
  const seq = (cv._seq = (cv._seq || 0) + 1);
  const bg = await bgCanvas(card.bg, w, hh);
  await Promise.all(card.layers.map(ensureFont));
  if (seq !== cv._seq) return null;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== hh) cv.height = hh;
  const x = cv.getContext("2d");
  x.clearRect(0, 0, w, hh); x.drawImage(bg, 0, 0);
  const bounds = card.layers.map(l => drawLayer(x, l, w, hh, scale));
  if (opt.selectedId) {
    const b = bounds.find(b => b.id === opt.selectedId);
    if (b) { x.save(); x.strokeStyle = "rgba(255,255,255,.9)"; x.lineWidth = 3 * scale; x.setLineDash([12 * scale, 9 * scale]); x.strokeRect(b.x, b.y, b.w, b.h); x.restore(); }
  }
  return bounds;
}

/* ---------- UI primitives ---------- */
function toast(msg, action) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const t = h("div", { class: "toast", role: "status" }, h("span", {}, msg), action && h("button", { onclick: () => { t.remove(); action.fn(); } }, action.label));
  document.body.append(t); setTimeout(() => t.remove(), action ? 6000 : 3200);
}
function sheet(title, content, opts = {}) {
  const ov = h("div", { class: "overlay" });
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); opts.onClose && opts.onClose(); };
  const onKey = e => { if (e.key === "Escape") close(); };
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  const body = h("div", { class: "sheetbody" }, content);
  ov.append(h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "sheethead" }, h("h2", {}, title), h("button", { class: "btn ghost", onclick: close }, "Close")), body));
  document.body.append(ov); document.addEventListener("keydown", onKey);
  return { close, body };
}
function askText(title, initial = "", okLabel = "Save") {
  return new Promise(res => {
    let done = false;
    const inp = h("input", { class: "field", id: "ask-text", value: initial, autocomplete: "off" });
    const ok = () => { done = true; const v = inp.value.trim(); s.close(); res(v || null); };
    inp.addEventListener("keydown", e => { if (e.key === "Enter") ok(); });
    const s = sheet(title, [inp, h("div", { class: "row end" }, h("button", { class: "btn", onclick: () => s.close() }, "Cancel"), h("button", { class: "btn primary", onclick: ok }, okLabel))],
      { onClose: () => { if (!done) res(null); } });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}
function confirmSheet(msg, okLabel = "Delete") {
  return new Promise(res => {
    let done = false;
    const s = sheet("Are you sure?", [h("p", {}, msg), h("div", { class: "row end" },
      h("button", { class: "btn", onclick: () => s.close() }, "Cancel"),
      h("button", { class: "btn primary", onclick: () => { done = true; s.close(); res(true); } }, okLabel))],
      { onClose: () => { if (!done) res(false); } });
  });
}
function choose(title, options, extra) {
  return new Promise(res => {
    let done = false;
    const s = sheet(title, [
      extra || null,
      ...options.map(o => h("button", { class: "choice", onclick: () => { done = true; s.close(); res(o.value); } }, h("span", {}, o.label), o.sub && h("span", { class: "sub" }, o.sub)))
    ], { onClose: () => { if (!done) res(null); } });
  });
}
function rangeRow(label, id, val, min, max, step, onInput) {
  const num = h("input", { type: "number", class: "field", id: id + "-n", min, max, step, value: val });
  const rng = h("input", { type: "range", id, min, max, step, value: val });
  rng.addEventListener("input", () => { num.value = rng.value; onInput(+rng.value); });
  num.addEventListener("input", () => { if (num.value === "") return; rng.value = num.value; onInput(clamp(+num.value, min, max * 4)); });
  return h("div", {}, h("label", { class: "lbl", for: id }, label), h("div", { class: "rng" }, rng, num));
}

function saveFile(filename, data) {
  const a = h("a", { href: URL.createObjectURL(data), download: filename, style: "display:none" });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  return true;
}
async function shareFiles(files, title) {
  const list = files.map(([n, b]) => new File([b], n, { type: b.type || "image/png" }));
  if (!navigator.canShare || !navigator.canShare({ files: list })) { toast("Sharing files isn't available in this browser. Use Save instead."); return; }
  try { await navigator.share({ files: list, title }); }
  catch (e) { if (e && e.name !== "AbortError") toast("Sharing didn't work. Use Save instead."); }
}
/* Files from Drive or the device, used by several screens. */
function driveButton(label, onFiles, opts) {
  if (!window.Drive || !Drive.enabled) return null;
  return h("button", { class: "btn", "data-drive": "1", onclick: async () => {
    if (!Drive.connected) { toast("Connect Google Drive first, in Library."); return; }
    const files = await Drive.pick(opts); if (files.length) onFiles(files);
  } }, label);
}
async function notesFromFiles(files) {
  let n = 0;
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    const id = await importImage(f); if (!id) continue;
    const now = Date.now(); state.notes.unshift({ id: uid(), text: "", img: id, created: now, updated: now }); n++;
  }
  if (n) { saveSoon(); toast(`Added ${n} photo note${n === 1 ? "" : "s"}.`); if (ui.screen === "notes") renderNotes(); }
}
async function fontFromFile(f) {
  const fam = await askText("Name for this font", f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "), "Add"); if (!fam) return;
  const blobId = await putBlob(f);
  const entry = { family: fam, source: "custom", blobId };
  if (!await loadCustomFont(entry)) { await DB.del("blobs", blobId); toast("That font file couldn't be read."); return; }
  state.fonts.push(entry); saveSoon(); if (ui.screen === "library") renderLibrary(); toast(`Added ${fam}.`);
}
const isFont = f => /\.(ttf|otf|woff2?)$/i.test(f.name);

/* ---------- navigation ---------- */
const ui = { screen: "notes", deckId: null, cardId: null, layerId: null, tab: "text", noteQuery: "" };
const main = $("#main");
document.querySelectorAll(".nav button").forEach(b => b.addEventListener("click", () => go(b.dataset.go)));
function go(screen, arg) {
  ui.screen = screen;
  if (screen === "deck") { ui.deckId = arg; ui.cardId = null; ui.layerId = null; }
  document.querySelectorAll(".nav button").forEach(b => b.setAttribute("aria-current", (b.dataset.go === screen || (screen === "deck" && b.dataset.go === "decks")) ? "page" : "false"));
  window.scrollTo(0, 0);
  ({ notes: renderNotes, decks: renderDecks, deck: renderDeck, library: renderLibrary })[screen]();
}

/* ---------- Notes ---------- */
let draft = { text: "", img: null };
function renderNotes() {
  const ta = h("textarea", { id: "compose-text", placeholder: "Jot something…", value: draft.text, "aria-label": "New note" });
  ta.addEventListener("input", () => { draft.text = ta.value; });
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveDraft(); });
  ta.addEventListener("paste", async e => {
    const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith("image/"));
    if (f) { e.preventDefault(); const id = await importImage(f); if (id) { draft.img = id; renderNotes(); } }
  });
  const attach = h("div", { id: "attach" });
  if (draft.img) blobURL(draft.img).then(u => attach.replaceChildren(h("div", { class: "attach" }, h("img", { src: u, alt: "Attached photo" }), h("button", { class: "btn small", onclick: async () => { const id = draft.img; draft.img = null; await gcBlob(id); renderNotes(); } }, "Remove"))));
  const list = h("div", { class: "notes", id: "notes-list" });
  const search = h("input", { class: "field", id: "note-search", type: "search", placeholder: "Search notes", value: ui.noteQuery });
  search.addEventListener("input", () => { ui.noteQuery = search.value; fillNotes(list); });
  main.replaceChildren(
    h("div", { class: "compose" }, ta, attach,
      h("div", { class: "row between" },
        h("div", { class: "row" },
          h("button", { class: "btn", onclick: async () => { const f = await pickFile("image/*"); if (f) { const id = await importImage(f); if (id) { if (draft.img) await gcBlob(draft.img); draft.img = id; renderNotes(); } } } }, draft.img ? "Change photo" : "Add photo"),
          driveButton("From Drive", files => notesFromFiles(files), { images: true, multi: true })),
        h("button", { class: "btn primary", onclick: saveDraft }, "Save note"))),
    h("div", { style: "margin-top:14px" }, search),
    list
  );
  fillNotes(list);
}
function saveDraft() {
  if (!draft.text.trim() && !draft.img) { toast("Type something or add a photo first."); return; }
  const now = Date.now();
  state.notes.unshift({ id: uid(), text: draft.text.trim(), img: draft.img, created: now, updated: now });
  draft = { text: "", img: null }; saveSoon(); renderNotes(); $("#compose-text")?.focus();
}
function fillNotes(list) {
  const q = ui.noteQuery.trim().toLowerCase();
  const notes = state.notes.filter(n => !q || (n.text || "").toLowerCase().includes(q));
  if (!notes.length) { list.replaceChildren(h("div", { class: "empty", style: "grid-column:1/-1" }, q ? "No notes match that search." : "No notes yet. Jot your first one above.")); return; }
  list.replaceChildren(...notes.map(n => noteEl(n, list)));
}
function noteEl(n, list) {
  const el = h("article", { class: "note" });
  const view = () => {
    const img = h("div");
    if (n.img) blobURL(n.img).then(u => u && img.replaceChildren(h("img", { src: u, alt: "" })));
    el.replaceChildren(
      n.img ? img : null,
      n.text ? h("div", { class: "txt" }, n.text) : null,
      h("div", { class: "meta" }, fmtDate(n.created)),
      h("div", { class: "acts" },
        h("button", { class: "btn small", onclick: edit }, "Edit"),
        h("button", { class: "btn small", onclick: () => sendToDeck(n) }, "Send to deck"),
        h("button", { class: "btn small ghost danger", onclick: async () => {
          if (!await confirmSheet("Delete this note? This can't be undone.")) return;
          state.notes = state.notes.filter(x => x !== n); saveSoon(); await gcBlob(n.img); fillNotes(list);
        } }, "Delete")));
  };
  const edit = () => {
    const ta = h("textarea", { class: "field", id: "edit-" + n.id, value: n.text, rows: 5 });
    el.replaceChildren(ta, h("div", { class: "row end" },
      h("button", { class: "btn small", onclick: view }, "Cancel"),
      h("button", { class: "btn small primary", onclick: () => { n.text = ta.value.trim(); n.updated = Date.now(); saveSoon(); view(); } }, "Save")));
    ta.focus();
  };
  view(); return el;
}
function layerFromNote(text) {
  const base = state.lastStyle ? clone(state.lastStyle) : {};
  return L(Object.assign(base, { id: uid(), text, x: 0.5, y: 0.5 }));
}
async function sendToDeck(n) {
  const opts = [...state.decks].sort((a, b) => b.updated - a.updated).map(d => ({ label: d.name, sub: `${d.cards.length} cards`, value: d.id }));
  opts.unshift({ label: "New deck", sub: "Start a new deck with this note", value: "__new" });
  let id = await choose("Send to which deck?", opts); if (!id) return;
  let deck;
  if (id === "__new") { deck = makeDeck("Untitled", []); } else deck = state.decks.find(d => d.id === id);
  const card = newCard([], { img: n.img || null });
  if (n.text) card.layers.push(layerFromNote(n.text));
  deck.cards.push(card); touch(deck);
  toast(`Added a card to ${deck.name}.`, { label: "Open", fn: () => { go("deck", deck.id); ui.cardId = card.id; renderDeck(); } });
}

/* ---------- Decks ---------- */
function makeDeck(name, cards, aspect = "4:5") {
  const now = Date.now();
  const d = { id: uid(), name, aspect, created: now, updated: now, cards };
  state.decks.push(d); saveSoon(); return d;
}
function copyCards(cards, keepImages) {
  return clone(cards).map(c => { c.id = uid(); c.layers.forEach(l => l.id = uid()); if (!keepImages) c.bg.img = null; return c; });
}
function renderDecks() {
  const grid = h("div", { class: "decks" });
  const decks = [...state.decks].sort((a, b) => b.updated - a.updated);
  main.replaceChildren(
    h("div", { class: "row between" }, h("h2", {}, "Decks"), h("div", { class: "row" }, h("button", { class: "btn", onclick: newDeckFromFlow }, "Start from…"), h("button", { class: "btn primary", onclick: newDeckFlow }, "New deck"))),
    grid);
  if (!decks.length) { grid.append(h("div", { class: "empty", style: "grid-column:1/-1" }, "No decks yet. Make one with New deck.")); return; }
  for (const d of decks) {
    const cv = h("canvas", { "aria-hidden": "true" });
    const [W, H] = ASPECTS[d.aspect] || ASPECTS["4:5"];
    if (d.cards[0]) renderCard(d.cards[0], cv, W, H, { scale: 0.2 }); else { cv.width = 216; cv.height = 270; }
    grid.append(h("article", { class: "deckcard" },
      h("button", { class: "cover", onclick: () => go("deck", d.id), "aria-label": "Open " + d.name }, cv),
      h("div", { class: "info" },
        h("div", { class: "name" }, d.name),
        h("div", { class: "small muted" }, `${d.cards.length} card${d.cards.length === 1 ? "" : "s"} · edited ${fmtDate(d.updated)}`),
        h("div", { class: "row" },
          h("button", { class: "btn small", onclick: () => go("deck", d.id) }, "Open"),
          h("button", { class: "btn small", onclick: async () => { const nm = await askText("Rename deck", d.name); if (nm) { d.name = nm; touch(d); renderDecks(); } } }, "Rename"),
          h("button", { class: "btn small", onclick: () => deckMenu(d) }, "More")))));
  }
}
async function deckMenu(d) {
  const v = await choose(d.name, [
    { label: "Duplicate", sub: "Copy the deck, images included", value: "dup" },
    { label: "Save as template", sub: "Keep its cards and text styles to start future decks", value: "tmpl" },
    { label: "Delete deck", sub: "Removes it for good", value: "del" }
  ]);
  if (v === "dup") { makeDeck(d.name + " copy", copyCards(d.cards, true), d.aspect); renderDecks(); toast("Deck duplicated."); }
  if (v === "tmpl") saveTemplate(d);
  if (v === "del") {
    if (!await confirmSheet(`Delete “${d.name}” and its ${d.cards.length} cards?`)) return;
    const imgs = d.cards.map(c => c.bg.img);
    state.decks = state.decks.filter(x => x !== d); saveSoon();
    for (const i of imgs) await gcBlob(i);
    renderDecks();
  }
}
async function saveTemplate(d) {
  const nm = await askText("Template name", d.name); if (!nm) return;
  state.templates.push({ id: uid(), name: nm, aspect: d.aspect, cards: copyCards(d.cards, false) });
  saveSoon(); toast(`Saved template “${nm}”.`);
}
function defaultDeckName() {
  const d = new Date(); d.setDate(d.getDate() - d.getDay());
  return "Week of " + d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function newDeckFlow() {
  const deck = makeDeck(defaultDeckName(), Array.from({ length: 5 }, () => newCard([])));
  go("deck", deck.id);
}
async function newDeckFromFlow() {
  const opts = [];
  state.templates.forEach(t => opts.push({ label: t.name, sub: `Template · ${t.cards.length} cards`, value: "t:" + t.id }));
  [...state.decks].sort((a, b) => b.updated - a.updated).slice(0, 6).forEach(d => opts.push({ label: "Copy of " + d.name, sub: "Text and layout, without images", value: "d:" + d.id }));
  if (!opts.length) { toast("No templates or decks to start from yet."); return; }
  const v = await choose("Start from", opts); if (!v) return;
  let deck;
  if (v.startsWith("t:")) { const t = state.templates.find(x => x.id === v.slice(2)); deck = makeDeck(defaultDeckName(), copyCards(t.cards, false), t.aspect); }
  else { const s = state.decks.find(x => x.id === v.slice(2)); deck = makeDeck(defaultDeckName(), copyCards(s.cards, false), s.aspect); }
  go("deck", deck.id);
}

/* ---------- Deck editor ---------- */
const curDeck = () => state.decks.find(d => d.id === ui.deckId);
const curCard = () => curDeck()?.cards.find(c => c.id === ui.cardId);
const curLayer = () => curCard()?.layers.find(l => l.id === ui.layerId);
let preview = null, bounds = [], thumbs = new Map(), rafPending = false, thumbTimer = null;

function isEmptyCard(c) { return !c.bg.img && !c.layers.length; }
function renderDeck() {
  const deck = curDeck(); if (!deck) return go("decks");
  if (ui.cardId && !curCard()) { ui.cardId = null; ui.layerId = null; }
  return ui.cardId ? renderEditor(deck) : renderOverview(deck);
}
function deckNameInput(deck) {
  const nameInp = h("input", { class: "deckname", id: "deck-name", value: deck.name, "aria-label": "Deck name" });
  nameInp.addEventListener("input", () => { deck.name = nameInp.value; touch(deck); });
  return nameInp;
}
function addEmptyCard() {
  const deck = curDeck(); deck.cards.push(newCard([])); touch(deck); renderDeck();
}
async function removeLastCard() {
  const deck = curDeck(); const c = deck.cards[deck.cards.length - 1]; if (!c) return;
  if (!isEmptyCard(c) && !await confirmSheet(`Card ${deck.cards.length} has content. Remove it?`, "Remove")) return;
  deck.cards.pop(); touch(deck); await gcBlob(c.bg.img); renderDeck();
}
function renderOverview(deck) {
  const [W, H] = ASPECTS[deck.aspect] || ASPECTS["4:5"];
  const aspect = h("select", { class: "field", id: "aspect", style: "width:auto", "aria-label": "Card size", value: deck.aspect },
    Object.keys(ASPECTS).map(a => h("option", { value: a }, a === "4:5" ? "4:5 (Facebook)" : a)));
  aspect.addEventListener("change", () => { deck.aspect = aspect.value; touch(deck); renderDeck(); });
  const grid = h("div", { class: "cardgrid", style: `--ar:${W / H}` });
  deck.cards.forEach((c, i) => {
    const cv = h("canvas", { "aria-hidden": "true" });
    renderCard(c, cv, W, H, { scale: 0.3 });
    const tile = h("button", { class: "tile", "data-id": c.id, "aria-label": `Card ${i + 1}${isEmptyCard(c) ? ", empty" : ""}`, onclick: () => { ui.cardId = c.id; ui.layerId = null; renderDeck(); } },
      cv, h("span", { class: "num" }, i + 1), isEmptyCard(c) ? h("span", { class: "emptylbl" }, "Empty") : null);
    tile.addEventListener("dragover", e => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); tile.classList.add("dropping"); } });
    tile.addEventListener("dragleave", () => tile.classList.remove("dropping"));
    tile.addEventListener("drop", async e => {
      tile.classList.remove("dropping");
      const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith("image/")); if (!f) return;
      e.preventDefault(); e.stopPropagation();
      const id = await importImage(f); if (!id) return;
      const old = c.bg.img; c.bg.img = id; touch(deck); await gcBlob(old); renderDeck();
    });
    grid.append(tile);
  });
  grid.append(h("button", { class: "tile addtile", onclick: addEmptyCard, "aria-label": "Add an empty card" }, "+"));
  main.replaceChildren(
    h("div", { class: "deckbar" },
      h("button", { class: "btn ghost", onclick: () => go("decks") }, "‹ Decks"), deckNameInput(deck),
      h("button", { class: "btn primary", onclick: () => openExport(deck), disabled: !deck.cards.length }, "Export")),
    h("div", { class: "row between", style: "margin-bottom:12px" },
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: removeLastCard, disabled: !deck.cards.length, "aria-label": "Remove last card" }, "−"),
        h("span", { class: "count" }, `${deck.cards.length} card${deck.cards.length === 1 ? "" : "s"}`),
        h("button", { class: "btn", onclick: addEmptyCard, "aria-label": "Add an empty card" }, "+")),
      aspect),
    grid,
    h("p", { class: "small muted", style: "margin-top:12px" }, "Drag cards to change their order. On a phone, press and hold a card first."));
  if (window.Sortable && deck.cards.length > 1) Sortable.create(grid, {
    animation: 160, delay: 220, delayOnTouchOnly: true, filter: ".addtile", preventOnFilter: false, ghostClass: "sort-ghost",
    onMove: e => !e.related.classList.contains("addtile"),
    onEnd: e => {
      if (e.oldIndex === e.newIndex) return;
      const [c] = deck.cards.splice(e.oldIndex, 1); deck.cards.splice(e.newIndex, 0, c); touch(deck); renderDeck();
    }
  });
}
function renderEditor(deck) {
  const [W, H] = ASPECTS[deck.aspect] || ASPECTS["4:5"];
  const idx = deck.cards.findIndex(c => c.id === ui.cardId);
  const goTo = j => { ui.cardId = deck.cards[j].id; ui.layerId = null; renderDeck(); };
  preview = h("canvas", { id: "preview", "aria-label": "Card preview. Drag text to move it." });
  preview.style.setProperty("--ar", W / H);
  wirePreview(preview);
  main.replaceChildren(
    h("div", { class: "deckbar" },
      h("button", { class: "btn ghost", onclick: () => { ui.cardId = null; ui.layerId = null; renderDeck(); } }, "‹ All cards"),
      h("div", { class: "cardnav" },
        h("button", { class: "btn small", disabled: idx <= 0, onclick: () => goTo(idx - 1), "aria-label": "Previous card" }, "‹"),
        h("span", {}, `Card ${idx + 1} of ${deck.cards.length}`),
        h("button", { class: "btn small", disabled: idx >= deck.cards.length - 1, onclick: () => goTo(idx + 1), "aria-label": "Next card" }, "›")),
      h("button", { class: "btn primary", onclick: () => openExport(deck) }, "Export")),
    h("div", { class: "editor" },
      h("div", { class: "stagewrap" }, h("div", { class: "stage" }, preview), cardActions(deck)),
      h("div", { class: "panel", id: "panel" })));
  drawPreview(); renderPanel();
}
function renderStrip() {}
function cardActions(deck) {
  const idx = deck.cards.findIndex(c => c.id === ui.cardId);
  const move = dir => { const j = idx + dir; if (j < 0 || j >= deck.cards.length) return; const [c] = deck.cards.splice(idx, 1); deck.cards.splice(j, 0, c); touch(deck); renderDeck(); };
  return h("div", { class: "row cardacts" },
    h("button", { class: "btn small", onclick: () => move(-1), disabled: idx <= 0 }, "Move earlier"),
    h("button", { class: "btn small", onclick: () => move(1), disabled: idx >= deck.cards.length - 1 }, "Move later"),
    h("button", { class: "btn small", onclick: applyCardType }, "Use card type"),
    h("button", { class: "btn small", onclick: () => { const c = copyCards([curCard()], true)[0]; deck.cards.splice(idx + 1, 0, c); ui.cardId = c.id; touch(deck); renderDeck(); } }, "Duplicate"),
    h("button", { class: "btn small", onclick: saveCardType }, "Save as card type"),
    h("button", { class: "btn small ghost danger", onclick: async () => {
      if (!isEmptyCard(curCard()) && !await confirmSheet("Delete this card?")) return;
      const c = deck.cards[idx]; deck.cards.splice(idx, 1); ui.cardId = null; ui.layerId = null;
      touch(deck); await gcBlob(c.bg.img); renderDeck();
    } }, "Delete card"));
}
async function applyCardType() {
  if (!state.cardTypes.length) { toast("No card types yet. Save one with Save as card type."); return; }
  const v = await choose("Use card type", state.cardTypes.map(t => ({ label: t.name, sub: `${t.card.layers.length} text piece${t.card.layers.length === 1 ? "" : "s"}`, value: t.id })));
  if (!v) return;
  const card = curCard(), t = cardFromType(state.cardTypes.find(x => x.id === v));
  if (card.layers.length && !await confirmSheet("This replaces the text on this card. Your photo stays.", "Replace")) return;
  const img = card.bg.img;
  card.layers = t.layers; card.bg = Object.assign(t.bg, { img, fx: card.bg.fx, fy: card.bg.fy, zoom: card.bg.zoom });
  ui.layerId = card.layers[0]?.id || null; changed(); renderPanel();
}
async function saveCardType() {
  const nm = await askText("Name this card type", ""); if (!nm) return;
  const c = copyCards([curCard()], false)[0];
  state.cardTypes.push({ id: uid(), name: nm, card: c }); saveSoon();
  toast(`Saved card type “${nm}”. It's in Add a card from now on.`);
}
function drawPreview() {
  const deck = curDeck(), card = curCard(); if (!card || !preview) return;
  const [W, H] = ASPECTS[deck.aspect] || ASPECTS["4:5"];
  renderCard(card, preview, W, H, { selectedId: ui.layerId }).then(b => { if (b) bounds = b; });
}
function changed(opts = {}) {
  const deck = curDeck(); touch(deck);
  if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; drawPreview(); }); }
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    const c = curCard(), cv = c && thumbs.get(c.id); if (!cv) return;
    const [W, H] = ASPECTS[deck.aspect] || ASPECTS["4:5"]; renderCard(c, cv, W, H, { scale: 0.12 });
  }, 350);
  if (opts.style) { const l = curLayer(); if (l) { const s = clone(l); delete s.id; delete s.text; delete s.x; delete s.y; state.lastStyle = s; } }
}
function wirePreview(cv) {
  let drag = null;
  cv.addEventListener("dragover", e => { const t = [...(e.dataTransfer?.types || [])]; if (t.includes("Files") || t.includes("application/x-musings-note")) { e.preventDefault(); cv.classList.add("dropping"); } });
  cv.addEventListener("dragleave", () => cv.classList.remove("dropping"));
  cv.addEventListener("drop", async e => {
    cv.classList.remove("dropping");
    const card = curCard(); if (!card) return;
    const noteId = e.dataTransfer.getData("application/x-musings-note");
    e.preventDefault(); e.stopPropagation();
    if (noteId) {
      const n = state.notes.find(x => x.id === noteId); if (!n) return;
      const r = cv.getBoundingClientRect();
      if (n.text) { const nl = layerFromNote(n.text); nl.x = clamp((e.clientX - r.left) / r.width, 0, 1); nl.y = clamp((e.clientY - r.top) / r.height, 0, 1); card.layers.push(nl); ui.layerId = nl.id; ui.tab = "text"; }
      else if (n.img) card.bg.img = n.img;
      changed(); renderPanel(); return;
    }
    const f = [...(e.dataTransfer.files || [])].find(f => f.type.startsWith("image/")); if (!f) return;
    const id = await importImage(f); if (!id) return;
    const old = card.bg.img; card.bg.img = id; changed(); renderPanel(); await gcBlob(old);
  });
  const pt = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * cv.width, (e.clientY - r.top) / r.height * cv.height]; };
  cv.addEventListener("pointerdown", e => {
    const [px, py] = pt(e);
    const hit = [...bounds].reverse().find(b => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
    const card = curCard(); if (!card) return;
    if (!hit) { if (ui.layerId) { ui.layerId = null; drawPreview(); renderPanel(); } return; }
    const l = card.layers.find(x => x.id === hit.id);
    if (ui.layerId !== l.id) { ui.layerId = l.id; ui.tab = "text"; renderPanel(); }
    drag = { l, sx: px, sy: py, ox: l.x, oy: l.y, moved: false };
    cv.setPointerCapture(e.pointerId); e.preventDefault(); drawPreview();
  });
  cv.addEventListener("pointermove", e => {
    if (!drag) return;
    const [px, py] = pt(e);
    let nx = drag.ox + (px - drag.sx) / cv.width, ny = drag.oy + (py - drag.sy) / cv.height;
    if (Math.abs(nx - 0.5) < 0.012) nx = 0.5;
    if (Math.abs(ny - 0.5) < 0.012) ny = 0.5;
    drag.l.x = clamp(nx, -0.2, 1.2); drag.l.y = clamp(ny, -0.2, 1.2); drag.moved = true; changed();
  });
  const end = () => { drag = null; };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
}

function renderPanel() {
  const panel = $("#panel"); if (!panel) return;
  const tabs = [["text", "Text"], ["bg", "Background"], ["notes", "Notes"]];
  const tabBar = h("div", { class: "tabs", role: "tablist" }, tabs.map(([k, lbl]) =>
    h("button", { role: "tab", "aria-selected": ui.tab === k ? "true" : "false", onclick: () => { ui.tab = k; renderPanel(); } }, lbl)));
  const body = ui.tab === "text" ? textPanel() : ui.tab === "bg" ? bgPanel() : notesPanel();
  panel.replaceChildren(tabBar, ...[].concat(body).flat(Infinity).filter(Boolean));
}
function textPanel() {
  const card = curCard(), l = curLayer();
  const chips = h("div", { class: "chips" },
    card.layers.map(x => h("button", { class: "chip", "aria-pressed": x.id === ui.layerId ? "true" : "false", onclick: () => { ui.layerId = x.id; drawPreview(); renderPanel(); } }, (x.text || "(empty)").split("\n")[0].slice(0, 28))),
    h("button", { class: "chip", onclick: () => { const nl = layerFromNote("New text"); card.layers.push(nl); ui.layerId = nl.id; changed(); renderPanel(); setTimeout(() => { const t = $("#layer-text"); t && (t.focus(), t.select()); }, 20); } }, "+ Text"));
  if (!l) return [chips, h("p", { class: "muted small" }, card.layers.length ? "Tap a piece of text on the card, or pick one above." : "Add text with + Text, or bring in a note from the Notes tab.")];

  const set = (k, v, style = true) => { l[k] = v; changed({ style }); };
  const ta = h("textarea", { class: "field", id: "layer-text", value: l.text, rows: 3, "aria-label": "Text" });
  ta.addEventListener("input", () => { l.text = ta.value; changed(); renderChipsLabel(); });
  function renderChipsLabel() { const c = chips.querySelector('[aria-pressed="true"]'); if (c) c.textContent = (l.text || "(empty)").split("\n")[0].slice(0, 28); }

  const fontSel = h("select", { class: "field", id: "layer-font", value: l.font, "aria-label": "Font" },
    fontsByUse().map(f => h("option", { value: f.family, style: `font-family:"${f.family}"` }, f.family)));
  if (!state.fonts.find(f => f.family === l.font)) fontSel.prepend(h("option", { value: l.font }, l.font + " (missing)"));
  fontSel.value = l.font;
  fontSel.addEventListener("change", () => { bumpFont(fontSel.value); set("font", fontSel.value); });

  const tog = (label, on, fn, aria) => h("button", { class: "btn small" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false", "aria-label": aria || label, onclick: fn }, label);
  const styleRow = h("div", { class: "row" },
    tog("B", l.weight >= 600, () => { set("weight", l.weight >= 600 ? 400 : 700); renderPanel(); }, "Bold"),
    tog("I", l.italic, () => { set("italic", !l.italic); renderPanel(); }, "Italic"),
    h("span", { style: "width:6px" }),
    ...["left", "center", "right"].map(a => tog(a[0].toUpperCase() + a.slice(1), l.align === a, () => { set("align", a); renderPanel(); }, "Align " + a)),
    h("span", { style: "width:6px" }),
    tog("Shadow", l.shadow, () => { set("shadow", !l.shadow); renderPanel(); }),
    tog("Box", l.box, () => { set("box", !l.box); renderPanel(); }));

  const weightSel = h("select", { class: "field", id: "layer-weight", value: String(l.weight), "aria-label": "Weight" },
    [300, 400, 500, 600, 700, 800].map(w => h("option", { value: String(w) }, { 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold" }[w])));
  weightSel.value = String(l.weight);
  weightSel.addEventListener("change", () => { set("weight", +weightSel.value); renderPanel(); });

  const colorInp = h("input", { type: "color", id: "layer-color", value: l.color, "aria-label": "Text color" });
  colorInp.addEventListener("input", () => set("color", colorInp.value.toUpperCase()));
  colorInp.addEventListener("change", () => { rememberColor(colorInp.value); saveSoon(); renderPanel(); });
  const swatches = h("div", { class: "swatches" }, colorInp, state.usage.colors.map(c =>
    h("button", { class: "sw", style: `background:${c}`, "aria-label": "Use color " + c, onclick: () => { set("color", c); rememberColor(c); renderPanel(); } })));

  const seg = (label, key, opts, def) => h("div", {}, h("div", { class: "lbl" }, label), h("div", { class: "row" },
    opts.map(([v, t]) => tog(t, (l[key] || def) === v, () => { set(key, v); renderPanel(); }, label + ": " + t))));
  const shapeRow = l.box ? h("div", { class: "grid2" },
    seg("Box shape", "boxShape", [["square", "Square"], ["rounded", "Rounded"], ["pill", "Pill"]], "square"),
    seg("Box fits", "boxFit", [["block", "Whole block"], ["line", "Each line"]], "block")) : null;
  const boxRow = l.box ? h("div", { class: "grid2" },
    h("div", {}, h("label", { class: "lbl", for: "box-color" }, "Box color"),
      (() => { const i = h("input", { type: "color", id: "box-color", value: l.boxColor }); i.addEventListener("input", () => set("boxColor", i.value)); return i; })()),
    rangeRow("Box opacity", "box-op", l.boxOpacity, 0, 1, 0.05, v => set("boxOpacity", v))) : null;

  const idx = card.layers.indexOf(l);
  const order = h("div", { class: "row" },
    h("button", { class: "btn small", onclick: () => { l.x = 0.5; changed(); } }, "Center across"),
    h("button", { class: "btn small", onclick: () => { l.y = 0.5; changed(); } }, "Center up/down"),
    h("button", { class: "btn small", disabled: idx >= card.layers.length - 1, onclick: () => { card.layers.splice(idx, 1); card.layers.splice(idx + 1, 0, l); changed(); renderPanel(); } }, "Bring forward"),
    h("button", { class: "btn small", onclick: () => { const c = clone(l); c.id = uid(); c.y = clamp(l.y + 0.08, 0, 1); card.layers.push(c); ui.layerId = c.id; changed(); renderPanel(); } }, "Duplicate"),
    h("button", { class: "btn small ghost danger", onclick: () => { card.layers.splice(idx, 1); ui.layerId = null; changed(); renderPanel(); } }, "Delete text"));

  return [chips, ta,
    h("div", { class: "grid2" }, h("div", {}, h("label", { class: "lbl", for: "layer-font" }, "Font"), fontSel), h("div", {}, h("label", { class: "lbl", for: "layer-weight" }, "Weight"), weightSel)),
    styleRow,
    rangeRow("Size", "layer-size", l.size, 12, 200, 1, v => set("size", v)),
    h("div", {}, h("label", { class: "lbl", for: "layer-color" }, "Color"), swatches),
    h("div", { class: "grid2" },
      rangeRow("Width", "layer-w", Math.round(l.w * 100), 10, 100, 1, v => set("w", v / 100, false)),
      rangeRow("Line spacing", "layer-lh", l.lh, 0.8, 2.4, 0.05, v => set("lh", v))),
    rangeRow("Opacity", "layer-op", l.opacity, 0.1, 1, 0.05, v => set("opacity", v)),
    shapeRow, boxRow,
    h("hr", { class: "divider" }), order];
}
function bgPanel() {
  const card = curCard(), bg = card.bg;
  const set = (k, v) => { bg[k] = v; changed(); };
  const photoRow = h("div", { class: "row" },
    h("button", { class: "btn", onclick: async () => { const f = await pickFile("image/*"); if (!f) return; const id = await importImage(f); if (!id) return; const old = bg.img; bg.img = id; changed(); renderPanel(); await gcBlob(old); } }, bg.img ? "Replace photo" : "Add photo"),
    h("button", { class: "btn", onclick: pickNotePhoto }, "Photo from notes"),
    driveButton("From Drive", async files => { const f = files.find(f => f.type.startsWith("image/")) || files[0]; if (!f) return; const id = await importImage(f); if (!id) return; const old = bg.img; bg.img = id; changed(); renderPanel(); await gcBlob(old); }, { images: true }),
    bg.img ? h("button", { class: "btn ghost danger", onclick: async () => { const old = bg.img; bg.img = null; changed(); renderPanel(); await gcBlob(old); } }, "Remove photo") : null);
  const toneSel = h("select", { class: "field", id: "bg-tone", value: bg.tone, "aria-label": "Tone" },
    [["none", "None"], ["sepia", "Sepia"], ["warm", "Warm"], ["mono", "Black & white"]].map(([v, t]) => h("option", { value: v }, t)));
  toneSel.value = bg.tone;
  toneSel.addEventListener("change", () => set("tone", toneSel.value));
  const colorPick = (lbl, id, k) => { const i = h("input", { type: "color", id, value: bg[k] }); i.addEventListener("input", () => set(k, i.value)); return h("div", {}, h("label", { class: "lbl", for: id }, lbl), i); };
  return [
    photoRow,
    bg.img ? [
      h("div", { class: "grid2" }, h("div", {}, h("label", { class: "lbl", for: "bg-tone" }, "Tone"), toneSel), rangeRow("Tone strength", "bg-str", bg.strength, 0, 1, 0.05, v => set("strength", v))),
      rangeRow("Zoom", "bg-zoom", bg.zoom, 1, 3, 0.02, v => set("zoom", v)),
      h("div", { class: "grid2" },
        rangeRow("Left / right", "bg-fx", Math.round(bg.fx * 100), 0, 100, 1, v => set("fx", v / 100)),
        rangeRow("Up / down", "bg-fy", Math.round(bg.fy * 100), 0, 100, 1, v => set("fy", v / 100)))
    ] : [h("p", { class: "small muted" }, "No photo. The card uses a two-color fade."),
      h("div", { class: "row" }, colorPick("Top color", "bg-c1", "color"), colorPick("Bottom color", "bg-c2", "color2"))],
    rangeRow("Darken", "bg-dim", bg.dim, 0, 0.8, 0.01, v => set("dim", v))
  ];
}
async function pickNotePhoto() {
  const withImg = state.notes.filter(n => n.img);
  if (!withImg.length) { toast("None of your notes have photos yet."); return; }
  const grid = h("div", { class: "exportgrid" });
  const s = sheet("Photo from notes", grid);
  for (const n of withImg) {
    const u = await blobURL(n.img);
    grid.append(h("figure", {}, h("button", { class: "thumb", style: "padding:0", onclick: () => { curCard().bg.img = n.img; changed(); renderPanel(); s.close(); } },
      h("img", { src: u, alt: (n.text || "Note photo").slice(0, 60), style: "width:100%;aspect-ratio:1;object-fit:cover;display:block;border-radius:6px" }))));
  }
}
function notesPanel() {
  const card = curCard();
  const list = h("div", { class: "picknotes" });
  const q = h("input", { class: "field", id: "pick-search", type: "search", placeholder: "Search notes" });
  const fill = () => {
    const t = q.value.trim().toLowerCase();
    const notes = state.notes.filter(n => !t || (n.text || "").toLowerCase().includes(t));
    list.replaceChildren(...(notes.length ? notes.map(n => {
      const img = h("div");
      if (n.img) blobURL(n.img).then(u => u && img.replaceChildren(h("img", { src: u, alt: "" })));
      const item = h("div", { class: "picknote", draggable: "true", title: "Drag onto the card, or use the buttons" }, n.img ? img : null,
        h("div", { class: "txt" }, n.text || h("span", { class: "muted" }, "Photo only")),
        h("div", { class: "stack", style: "gap:5px" },
          n.text ? h("button", { class: "btn small", onclick: () => { const nl = layerFromNote(n.text); card.layers.push(nl); ui.layerId = nl.id; ui.tab = "text"; changed(); renderPanel(); } }, "Add text") : null,
          n.img ? h("button", { class: "btn small", onclick: () => { card.bg.img = n.img; changed(); toast("Photo set as background."); } }, "Use photo") : null));
      item.addEventListener("dragstart", e => { e.dataTransfer.setData("application/x-musings-note", n.id); e.dataTransfer.effectAllowed = "copy"; });
      return item;
    }) : [h("p", { class: "muted small" }, "No matching notes.")]));
  };
  q.addEventListener("input", fill); fill();
  return [q, list];
}

/* ---------- Export ---------- */
async function openExport(deck) {
  const [W, H] = ASPECTS[deck.aspect] || ASPECTS["4:5"];
  const grid = h("div", { class: "exportgrid" });
  const status = h("p", { class: "small muted", role: "status" }, "Making images…");
  const zipBtn = h("button", { class: "btn", disabled: true }, "Save all (.zip)");
  const shareBtn = h("button", { class: "btn primary", disabled: true }, "Share…");
  const driveBtn = (window.Drive && Drive.enabled) ? h("button", { class: "btn", disabled: true, "data-drive": "1" }, "Save to Drive") : null;
  sheet("Export " + deck.name, [status, h("div", { class: "row" }, shareBtn, driveBtn, zipBtn), grid,
    h("p", { class: "small muted" }, "Share opens your phone's share sheet, so you can send the cards straight to Facebook. You can also press and hold an image to save it to your photos.")]);
  const files = [], base = slug(deck.name);
  for (let i = 0; i < deck.cards.length; i++) {
    const cv = document.createElement("canvas");
    await renderCard(deck.cards[i], cv, W, H, {});
    const b = await new Promise(r => cv.toBlob(r, "image/png"));
    const name = `${base}-${String(i + 1).padStart(2, "0")}.png`;
    files.push([name, b]);
    grid.append(h("figure", {}, h("img", { src: URL.createObjectURL(b), alt: "Card " + (i + 1) }),
      h("figcaption", {}, "Card " + (i + 1), h("button", { class: "btn small", onclick: () => saveFile(name, b) }, "Save"))));
    status.textContent = `Made ${i + 1} of ${deck.cards.length}…`;
  }
  status.textContent = `${deck.cards.length} images ready, ${W}×${H}.`;
  zipBtn.disabled = false; shareBtn.disabled = false;
  shareBtn.addEventListener("click", () => shareFiles(files, deck.name));
  if (driveBtn) {
    driveBtn.disabled = false;
    driveBtn.addEventListener("click", async () => {
      if (!Drive.connected) { toast("Connect Google Drive first, in Library."); return; }
      driveBtn.disabled = true; driveBtn.textContent = "Saving to Drive…";
      const ok = await Drive.saveDeck(deck, files);
      driveBtn.disabled = false; driveBtn.textContent = "Save to Drive";
      toast(ok ? `Saved to Musings Studio › Decks › ${deck.name} in your Drive.` : "Couldn't save to Drive. Try again.");
    });
  }
  zipBtn.addEventListener("click", async () => {
    if (!window.JSZip) { toast("The zip tool didn't load. Save the images one at a time."); return; }
    const zip = new JSZip(); files.forEach(([n, b]) => zip.file(n, b));
    saveFile(base + ".zip", await zip.generateAsync({ type: "blob" }));
  });
}

/* ---------- Library ---------- */
function renderLibrary() {
  const typeItems = h("div", { class: "items" }), tmplItems = h("div", { class: "items" }), fontItems = h("div", { class: "items" });
  const rename = async (obj, title) => { const nm = await askText(title, obj.name); if (nm) { obj.name = nm; saveSoon(); renderLibrary(); } };
  state.cardTypes.forEach(t => {
    const cv = h("canvas", { "aria-hidden": "true" }); renderCard(t.card, cv, 1080, 1350, { scale: 0.08 });
    typeItems.append(h("div", { class: "item" }, cv, h("div", { class: "grow" }, h("div", { class: "nm" }, t.name), h("div", { class: "small muted" }, `${t.card.layers.length} text piece${t.card.layers.length === 1 ? "" : "s"}`)),
      h("button", { class: "btn small", onclick: () => rename(t, "Rename card type") }, "Rename"),
      h("button", { class: "btn small ghost danger", onclick: async () => { if (await confirmSheet(`Delete card type “${t.name}”?`)) { state.cardTypes = state.cardTypes.filter(x => x !== t); saveSoon(); renderLibrary(); } } }, "Delete")));
  });
  if (!state.cardTypes.length) typeItems.append(h("p", { class: "muted small" }, "None yet. In a deck, use Save as card type."));
  state.templates.forEach(t => {
    const cv = h("canvas", { "aria-hidden": "true" }); if (t.cards[0]) renderCard(t.cards[0], cv, ...(ASPECTS[t.aspect] || ASPECTS["4:5"]), { scale: 0.05 });
    tmplItems.append(h("div", { class: "item" }, cv, h("div", { class: "grow" }, h("div", { class: "nm" }, t.name), h("div", { class: "small muted" }, `${t.cards.length} cards`)),
      h("button", { class: "btn small", onclick: async () => { const nm = await askText("Name this deck", "") || "Untitled"; const d = makeDeck(nm, copyCards(t.cards, false), t.aspect); go("deck", d.id); } }, "Use"),
      h("button", { class: "btn small", onclick: () => rename(t, "Rename template") }, "Rename"),
      h("button", { class: "btn small ghost danger", onclick: async () => { if (await confirmSheet(`Delete template “${t.name}”?`)) { state.templates = state.templates.filter(x => x !== t); saveSoon(); renderLibrary(); } } }, "Delete")));
  });
  if (!state.templates.length) tmplItems.append(h("p", { class: "muted small" }, "None yet. On the Decks page, use More, then Save as template."));
  fontsByUse().forEach(f => {
    fontItems.append(h("div", { class: "item" }, h("div", { class: "grow" },
      h("div", { class: "fontsample", style: `font-family:"${f.family}", Georgia, serif` }, f.family),
      h("div", { class: "small muted" }, `${f.source === "custom" ? "Your file" : "Google Fonts"} · used ${state.usage.fonts[f.family] || 0}×`)),
      h("button", { class: "btn small ghost danger", onclick: async () => {
        if (!await confirmSheet(`Remove ${f.family} from your font list? Cards already using it keep their text, but it may show in a fallback font.`, "Remove")) return;
        state.fonts = state.fonts.filter(x => x !== f); saveSoon(); if (f.blobId) await gcBlob(f.blobId); renderLibrary();
      } }, "Remove")));
  });
  main.replaceChildren(
    h("h2", {}, "Library"),
    driveSection(),
    installSection(),
    h("section", { class: "section" }, h("h3", {}, "Card types"), typeItems),
    h("section", { class: "section" }, h("h3", {}, "Templates"), tmplItems),
    h("section", { class: "section" }, h("div", { class: "row between" }, h("h3", {}, "Fonts"),
      h("div", { class: "row" }, h("button", { class: "btn small", onclick: addGoogleFont }, "Add Google font"), h("button", { class: "btn small", onclick: uploadFont }, "Upload font file"),
      (window.Drive && Drive.enabled) ? h("button", { class: "btn small", "data-drive": "1", onclick: async () => { if (!Drive.connected) { toast("Connect Google Drive first."); return; } const files = await Drive.pick({ images: false }); const f = files.find(isFont); if (f) fontFromFile(f); else if (files.length) toast("That isn't a font file (.ttf, .otf, .woff or .woff2)."); } }, "Font from Drive") : null)), fontItems),
    h("section", { class: "section" }, h("h3", {}, "Backup"),
      h("p", { class: "small muted", style: "max-width:62ch;margin:0" }, (window.Drive && Drive.connected) ? "Your work syncs to Google Drive. A backup file is an extra copy you keep yourself." : "Everything is saved in this browser on this device. Save a backup now and then, or connect Google Drive above."),
      h("div", { class: "row" }, h("button", { class: "btn primary", onclick: backup }, "Save backup file"), h("button", { class: "btn", onclick: restore }, "Restore from backup")),
      h("p", { class: "small muted", id: "usage-line", style: "margin:0" })));
  if (navigator.storage?.estimate) navigator.storage.estimate().then(e => { const u = $("#usage-line"); if (u && e.usage != null) u.textContent = `Using about ${(e.usage / 1048576).toFixed(1)} MB.`; }).catch(() => {});
}
function driveSection() {
  if (!window.Drive || !Drive.enabled) return h("section", { class: "section" }, h("h3", {}, "Google Drive"),
    h("p", { class: "small muted", style: "margin:0;max-width:62ch" }, "Drive sync isn't set up yet. The Google keys go in config.js (see the README)."));
  const line = h("p", { class: "small muted", style: "margin:0" });
  const paint = () => { line.textContent = Drive.connected ? `Connected${Drive.email ? " as " + Drive.email : ""}. ${Drive.message}` : "Not connected."; };
  paint(); Drive.onStatus(() => { if (line.isConnected) paint(); });
  return h("section", { class: "section" }, h("h3", {}, "Google Drive"),
    h("p", { class: "small muted", style: "margin:0;max-width:62ch" }, "Syncs your notes, decks, photos and fonts to a Musings Studio folder in your Drive. The app can only see files it made and files you pick."),
    line,
    Drive.connected
      ? h("div", { class: "row" }, h("button", { class: "btn primary", "data-drive": "1", onclick: () => Drive.syncNow() }, "Sync now"),
          h("button", { class: "btn ghost danger", "data-drive": "1", onclick: async () => { if (await confirmSheet("Stop syncing on this device? Your files stay in Drive.", "Disconnect")) { await Drive.disconnect(); renderLibrary(); } } }, "Disconnect"))
      : h("div", { class: "row" }, h("button", { class: "btn primary", "data-drive": "1", onclick: () => Drive.connect() }, "Connect Google Drive")));
}
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; if (ui.screen === "library") renderLibrary(); });
function installSection() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone) return null;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return h("section", { class: "section" }, h("h3", {}, "Put it on your home screen"),
    installEvt ? h("div", { class: "row" }, h("button", { class: "btn primary", onclick: async () => { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; renderLibrary(); } }, "Install app"))
      : h("p", { class: "small muted", style: "margin:0;max-width:62ch" }, ios ? "In Safari, tap the Share button, then Add to Home Screen." : "In your browser menu, choose Install app or Add to Home screen."));
}
async function addGoogleFont() {
  const name = await askText("Google font name (as shown on fonts.google.com)", "", "Add"); if (!name) return;
  const fam = name.trim().replace(/\s+/g, " ");
  if (state.fonts.find(f => f.family.toLowerCase() === fam.toLowerCase())) { toast("That font is already in your list."); return; }
  const plus = fam.replace(/ /g, "+");
  let q = plus + ":ital,wght@0,400;0,700;1,400;1,700";
  let ok = await addGoogleLink(q);
  if (!ok) { q = plus; ok = await addGoogleLink(q); }
  let faces = [];
  if (ok) { try { faces = await document.fonts.load(`16px "${fam}"`); } catch (e) {} }
  if (!ok || !faces.length) { toast(`Couldn't find “${fam}” on Google Fonts. Check the spelling.`); return; }
  state.fonts.push({ family: fam, source: "google", q }); saveSoon(); renderLibrary(); toast(`Added ${fam}.`);
}
async function uploadFont() {
  const f = await pickFile(".ttf,.otf,.woff,.woff2"); if (f) fontFromFile(f);
}
async function backup() {
  if (!window.JSZip) { toast("The backup tool didn't load. Reload the page and try again."); return; }
  const zip = new JSZip();
  zip.file("state.json", JSON.stringify(state));
  for (const id of blobRefs()) { const b = await DB.get("blobs", id); if (b) zip.file("blobs/" + id, b); }
  const d = new Date(), stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (await saveFile(`musings-backup-${stamp}.zip`, await zip.generateAsync({ type: "blob" }))) toast("Backup saved.");
}
async function restore() {
  if (!window.JSZip) { toast("The backup tool didn't load. Reload the page and try again."); return; }
  const f = await pickFile(".zip"); if (!f) return;
  let zip, s;
  try { zip = await JSZip.loadAsync(f); s = JSON.parse(await zip.file("state.json").async("string")); if (!s || !Array.isArray(s.notes)) throw 0; }
  catch (e) { toast("That file isn't a Musings backup."); return; }
  if (!await confirmSheet("Restoring replaces everything in the app with the backup. Continue?", "Restore")) return;
  await DB.clear("blobs"); blobCache.clear(); bgCache.clear();
  for (const name of Object.keys(zip.files)) {
    if (!name.startsWith("blobs/") || zip.files[name].dir) continue;
    await DB.put("blobs", name.slice(6), await zip.file(name).async("blob"));
  }
  state = s; await saveNow(); loadAllFonts(); go("notes"); toast("Backup restored.");
}

async function replaceState(s) {
  s.usage = s.usage || { fonts: {}, colors: [] };
  state = s; bgCache.clear();
  clearTimeout(saveTimer); await DB.put("kv", "state", state).catch(() => {});
  loadAllFonts();
  if (ui.screen === "deck" && !curDeck()) go("decks"); else go(ui.screen === "deck" ? "deck" : ui.screen, ui.deckId);
  toast("Updated from Google Drive.");
}
function notesText() {
  return state.notes.map(n => `${new Date(n.created).toLocaleString()}\n${n.text || "(photo)"}`).join("\n\n----------\n\n");
}
function conflictChoice() {
  return choose("Changes in two places", [
    { label: "Use the Drive version", sub: "Replace what's on this device with what's in Drive", value: "drive" },
    { label: "Keep this device's version", sub: "Replace what's in Drive with what's here", value: "device" }
  ], h("p", { class: "small", style: "margin:0" }, "This device and your Drive both changed since the last sync.")).then(v => v || "device");
}
function firstConnectChoice() {
  return choose("You already have Musings in Drive", [
    { label: "Use what's in Drive", sub: "Best when you've used the app on another device", value: "drive" },
    { label: "Use what's on this device", sub: "Replaces what's in Drive", value: "device" }
  ]).then(v => v || "drive");
}
/* Drop files anywhere: photos become notes (or a card background in the editor), fonts get added. */
document.addEventListener("dragover", e => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
document.addEventListener("drop", async e => {
  const files = [...(e.dataTransfer?.files || [])]; if (!files.length) return;
  e.preventDefault();
  const fonts = files.filter(isFont), imgs = files.filter(f => f.type.startsWith("image/"));
  for (const f of fonts) await fontFromFile(f);
  if (!imgs.length) return;
  if (ui.screen === "deck" && curCard()) { const id = await importImage(imgs[0]); if (!id) return; const c = curCard(), old = c.bg.img; c.bg.img = id; changed(); renderPanel(); await gcBlob(old); }
  else notesFromFiles(imgs);
});

/* ---------- boot ---------- */
(async function boot() {
  await DB.open();
  let s = null;
  if (!DB.mem) { try { s = await DB.get("kv", "state"); } catch (e) {} }
  state = s || seed();
  state.usage = state.usage || { fonts: {}, colors: [] };
  if (!s) saveNow();
  if (DB.mem) $("#banner").replaceChildren(h("div", { class: "banner" }, "This browser isn't letting the app save. Anything you make will be lost when you close the page. A private window can cause this."));
  $("#storeNote").textContent = DB.mem ? "Not saving" : "";
  loadAllFonts();
  try { navigator.storage?.persist?.().catch(() => {}); } catch (e) {}
  go("notes");
  if (window.Drive) {
    await Drive.init({ getState: () => state, replaceState, blobRefs, notesText, conflict: conflictChoice, firstConnect: firstConnectChoice, toast });
    const chip = $("#syncChip");
    if (Drive.enabled) Drive.onStatus((s, msg) => {
      chip.hidden = s === "off";
      chip.textContent = { connecting: "Connecting…", syncing: "Syncing…", synced: "Synced", paused: "Tap to sync", error: "Sync problem", offline: "Offline" }[s] || "";
      chip.title = msg; chip.dataset.state = s;
    });
    chip.addEventListener("click", () => { if (Drive.status === "paused" || Drive.status === "error") Drive.reconnect(); else go("library"); });
  }
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
