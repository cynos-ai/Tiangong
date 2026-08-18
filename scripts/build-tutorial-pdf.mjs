#!/usr/bin/env node
// Build the team-control tutorial (docs/design/evidence-backed-team-control-tutorial/)
// into a PDF using only local tools — no internet needed:
//   - marked (installed separately when building this optional artifact) for markdown -> HTML
//   - a hand-written mini mermaid-flowchart -> SVG renderer (no mermaid.js)
//   - a headless chromium (from the playwright cache) for --print-to-pdf
//
// Usage:  node scripts/build-tutorial-pdf.mjs [output.pdf]
// Default output: ./evidence-backed-team-control-tutorial.zh.pdf
//
// Env deps (must pre-exist on this machine):
//   - marked (provides markdown -> HTML)
//   - a chromium under ~/.cache/ms-playwright (provides the headless browser)
//   - a CJK font (e.g. WenQuanYi Zen Hei) for Chinese text
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const TUT = path.join(REPO, "docs/design/evidence-backed-team-control-tutorial");
const OUT = process.argv[2] || path.join(REPO, "evidence-backed-team-control-tutorial.zh.pdf");

// --- locate marked from this optional build environment ---
function findMarked() {
  try { return require.resolve("marked"); } catch {}
  throw new Error("marked not found; install the optional marked package before building the tutorial");
}
import { readdirSync } from "node:fs";
const { marked } = require(findMarked());

// --- locate a headless chromium ---
function findChromium() {
  const cache = path.join(os.homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) throw new Error("no playwright chromium cache found");
  const cands = [];
  for (const d of readdirSync(cache)) {
    if (!d.startsWith("chromium")) continue;
    cands.push(path.join(cache, d, "chrome-linux64/chrome"));
    cands.push(path.join(cache, d, "chrome-linux/chrome"));
    cands.push(path.join(cache, d, "chrome-headless-shell-linux64/chrome-headless-shell"));
  }
  for (const c of cands) if (existsSync(c)) return c;
  throw new Error("no chromium binary found under ~/.cache/ms-playwright");
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- mini mermaid flowchart -> SVG ----------
function renderMermaidSvg(code) {
  const labels = new Map();
  const edges = [];
  let orient = "TD";
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const fm = line.match(/^flowchart\s+([A-Za-z]+)/i);
    if (fm) { orient = fm[1].toUpperCase(); continue; }
    let m;
    const nodeRe = /([A-Za-z0-9_]+)\s*\[\s*"([^"]*)"\s*\]/g;
    while ((m = nodeRe.exec(line)) !== null) labels.set(m[1], m[2]);
    const edgeRe = /([A-Za-z0-9_]+)\s*(?:-->|->)\s*([A-Za-z0-9_]+)/g;
    while ((m = edgeRe.exec(line)) !== null) {
      edges.push([m[1], m[2]]);
      if (!labels.has(m[1])) labels.set(m[1], m[1]);
      if (!labels.has(m[2])) labels.set(m[2], m[2]);
    }
  }
  const allIds = new Set([...labels.keys(), ...edges.map((e) => e[0]), ...edges.map((e) => e[1])]);
  for (const n of allIds) if (!labels.has(n)) labels.set(n, n);
  const nodes = [...allIds];
  if (nodes.length === 0) return `<pre><code>${esc(code)}</code></pre>`;

  const indeg = new Map(nodes.map((n) => [n, 0]));
  const succ = new Map(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) { (succ.get(a) || succ.set(a, []).get(a)).push(b); indeg.set(b, (indeg.get(b) || 0) + 1); }

  const order = [];
  const indeg2 = new Map(indeg);
  const q = nodes.filter((n) => indeg2.get(n) === 0);
  const seen = new Set(q);
  while (q.length) { const n = q.shift(); order.push(n); for (const s of succ.get(n)) { indeg2.set(s, indeg2.get(s) - 1); if (indeg2.get(s) === 0 && !seen.has(s)) { seen.add(s); q.push(s); } } }
  for (const n of nodes) if (!order.includes(n)) order.push(n);
  const layer = new Map();
  for (const n of order) { let mx = -1; for (const [a, b] of edges) if (b === n) mx = Math.max(mx, layer.get(a) ?? -1); layer.set(n, mx + 1); }
  const maxL = Math.max(...layer.values());
  const layers = Array.from({ length: maxL + 1 }, () => []);
  for (const n of nodes) layers[layer.get(n)].push(n);

  const fs = 13, padX = 12, padY = 8, lineH = 16;
  const boxW = (lbl) => { let w = 0; for (const ch of lbl) w += ch.charCodeAt(0) > 127 ? 14 : 7.2; return w + padX * 2; };
  const boxH = lineH + padY * 2;
  const gapMaj = 64, gapMin = 14;

  const vertical = orient.startsWith("T") || orient.startsWith("B");
  const pos = new Map();
  let span = 0;
  const sizes = layers.map((ls) => ls.map((n) => boxW(labels.get(n))));
  let totalW, totalH;
  if (vertical) {
    let y = 0;
    for (let l = 0; l < layers.length; l++) {
      const totalWrow = sizes[l].reduce((a, b) => a + b, 0) + Math.max(0, layers[l].length - 1) * gapMin;
      let x = 0;
      for (let i = 0; i < layers[l].length; i++) { pos.set(layers[l][i], { x, y, w: sizes[l][i], h: boxH }); x += sizes[l][i] + gapMin; }
      span = Math.max(span, totalWrow);
      y += boxH + gapMaj;
    }
    totalH = layers.length * boxH + (layers.length - 1) * gapMaj;
    totalW = span;
  } else {
    const colW = layers.map((ls) => Math.max(...ls.map((n) => boxW(labels.get(n)))));
    let x = 0;
    for (let l = 0; l < layers.length; l++) {
      let y = 0;
      for (const n of layers[l]) { pos.set(n, { x, y, w: boxW(labels.get(n)), h: boxH }); y += boxH + gapMin; }
      span = Math.max(span, y - gapMin);
      x += colW[l] + gapMaj;
    }
    totalW = x - gapMaj;
    totalH = span;
  }

  const pad = 8;
  const off = (p) => ({ x: p.x + pad, y: p.y + pad, w: p.w, h: p.h });
  const exit = (cx, cy, w, h, tx, ty) => {
    const dx = tx - cx, dy = ty - cy;
    const sx = dx !== 0 ? w / 2 / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? h / 2 / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  };

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW + pad * 2} ${totalH + pad * 2}" font-family="'WenQuanYi Zen Hei','Noto Sans CJK SC',sans-serif" font-size="${fs}">`;
  svg += `<defs><marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L8,3 L0,6 z" fill="#5a6275"/></marker></defs>`;
  for (const [a, b] of edges) {
    const pa = off(pos.get(a)), pb = off(pos.get(b));
    const ca = { x: pa.x + pa.w / 2, y: pa.y + pa.h / 2 };
    const cb = { x: pb.x + pb.w / 2, y: pb.y + pb.h / 2 };
    const s = exit(ca.x, ca.y, pa.w, pa.h, cb.x, cb.y);
    const t = exit(cb.x, cb.y, pb.w, pb.h, ca.x, ca.y);
    svg += `<line x1="${s.x.toFixed(1)}" y1="${s.y.toFixed(1)}" x2="${t.x.toFixed(1)}" y2="${t.y.toFixed(1)}" stroke="#5a6275" stroke-width="1.4" marker-end="url(#ah)"/>`;
  }
  for (const n of nodes) {
    const p = off(pos.get(n));
    svg += `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="6" ry="6" fill="#f3f5fa" stroke="#6b7280" stroke-width="1.1"/>`;
    svg += `<text x="${p.x + p.w / 2}" y="${p.y + p.h / 2 + 4}" text-anchor="middle" fill="#1f2430">${esc(labels.get(n))}</text>`;
  }
  svg += `</svg>`;
  return `<div class="diagram">${svg}</div>`;
}

// ---------- markdown -> html ----------
marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    code(token) {
      const obj = typeof token === "string" ? { text: token, lang: "" } : token;
      const lang = (obj.lang || "").trim();
      if (lang === "mermaid") return renderMermaidSvg(obj.text);
      const cls = lang ? ` class="language-${esc(lang)}"` : "";
      return `<pre><code${cls}>${esc(obj.text)}</code></pre>`;
    },
  },
});

const order = ["README.md",
  "01-message-to-team.zh.md", "02-one-request-one-work.zh.md", "03-clarify-the-goal.zh.md",
  "04-one-bounded-delegation.zh.md", "05-capability-and-context.zh.md", "06-prepared-environment-and-bash.zh.md",
  "07-result-and-content.zh.md", "08-tool-results-and-storage.zh.md", "09-external-operation.zh.md",
  "10-exact-approval.zh.md", "11-uncertainty-and-recovery.zh.md", "12-concurrency-cancellation-and-resume.zh.md",
  "13-work-closure.zh.md", "14-complete-walkthrough.zh.md"];

const chunks = order.map((f) => marked.parse(readFileSync(path.join(TUT, f), "utf8")));
const body = chunks.join('\n<div style="break-before:page"></div>\n');

const css = `
@page { size: A4; margin: 16mm 15mm; }
* { box-sizing: border-box; }
body { font-family: 'WenQuanYi Zen Hei','Noto Sans CJK SC','WenQuanYi Micro Hei',sans-serif; font-size: 10.5pt; line-height: 1.6; color: #1f2430; }
h1,h2,h3,h4 { line-height: 1.3; color: #11162a; font-weight: 700; }
h1 { font-size: 19pt; border-bottom: 2px solid #d7deea; padding-bottom: 6px; margin-top: 0; }
h2 { font-size: 14.5pt; margin-top: 1.4em; border-left: 5px solid #5a7fbf; padding-left: 8px; }
h3 { font-size: 12pt; margin-top: 1.2em; color: #243049; }
h4 { font-size: 11pt; margin-top: 1em; color: #3a4258; }
p { margin: 0.5em 0; }
a { color: #2a5db0; text-decoration: none; word-break: break-all; }
ul,ol { margin: 0.4em 0 0.7em; padding-left: 1.5em; }
li { margin: 0.18em 0; }
blockquote { margin: 0.6em 0; padding: 0.3em 0.9em; background: #f6f8fc; border-left: 4px solid #9fb3d8; color: #2b3245; }
blockquote p { margin: 0.25em 0; }
code { font-family: 'DejaVu Sans Mono','WenQuanYi Zen Hei',monospace; font-size: 9pt; background: #eef1f6; padding: 1px 4px; border-radius: 3px; }
pre { background: #f5f7fb; border: 1px solid #dce3ee; border-radius: 6px; padding: 9px 11px; overflow-x: auto; line-height: 1.5; }
pre code { background: none; padding: 0; font-size: 8.8pt; }
table { border-collapse: collapse; width: 100%; margin: 0.7em 0; font-size: 9.6pt; }
th,td { border: 1px solid #cdd6e4; padding: 5px 8px; text-align: left; vertical-align: top; }
th { background: #eaeef6; }
tr:nth-child(even) td { background: #f8fafd; }
hr { border: none; border-top: 1px solid #d7deea; margin: 1.2em 0; }
.diagram { text-align: center; margin: 14px 0; }
.diagram svg { max-width: 100%; height: auto; }
strong { color: #141a2e; }
`;

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Tiangong 可信团队控制教程</title><style>${css}</style></head><body>${body}</body></html>`;
const htmlPath = path.join(os.tmpdir(), "tiangong-tutorial.html");
writeFileSync(htmlPath, html);

const chrome = findChromium();
const r = spawnSync(chrome, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer",
  "--virtual-time-budget=8000", `--print-to-pdf=${OUT}`, `file://${htmlPath}`,
], { encoding: "utf8" });
if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
console.log(`PDF written: ${OUT}  (${(require("node:fs").statSync(OUT).size / 1024 / 1024).toFixed(2)} MB, ${chunks.length} sections, ${(body.match(/<div class="diagram">/g) || []).length} diagrams)`);
