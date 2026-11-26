// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) Ultrastable
// GH-ONLY-1: the same router as the Cloudflare Worker, rendered to static files for GitHub Pages. The beat ledger is SQLite in the run
// (node:sqlite), loaded from the beats the live site already publishes and written back only through the site, so beats never cost a commit.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handle, beat } from "../worker/index.js";

const SITE = process.env.SITE || "https://ultrastable.github.io/open-questions", BASE = new URL(SITE).pathname.replace(/\/$/, "");
function d1() {
  const raw = new DatabaseSync(":memory:");
  const stmt = sql => { let a = []; const o = { bind(...x) { a = x; return o; },
    async all() { return { results: raw.prepare(sql).all(...a).map(r => ({ ...r })) }; },
    async first() { const r = raw.prepare(sql).get(...a); return r ? { ...r } : null; },
    async run() { const r = raw.prepare(sql).run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; };
  return { prepare: stmt };
}
const env = { DB: d1(), HALT: process.env.HALT };
await env.DB.prepare("CREATE TABLE IF NOT EXISTS beats (at INTEGER PRIMARY KEY, entries INTEGER NOT NULL, note TEXT NOT NULL)").run();
try {
  const prev = await (await fetch(SITE + "/api/beats.json")).json();
  for (const b of prev.beats || []) await env.DB.prepare("INSERT OR REPLACE INTO beats (at, entries, note) VALUES (?1, ?2, ?3)").bind(Date.parse(b.at), b.entries, b.note).run();
  console.log("loaded", (prev.beats || []).length, "earlier beats from the live site");
} catch (e) { console.log("no earlier beats readable (first deploy?):", e.message); }
console.log(JSON.stringify(await beat(env)));

const routes = { "/": "index.html", "/health": "health.json", "/api/beats": "api/beats.json", "/api/entries.json": "api/entries.json", "/api/graph": "api/graph.json",
  "/social-queue.json": "social-queue.json", "/feed.json": "feed.json", "/robots.txt": "robots.txt", "/claims.json": "claims.json", "/.well-known/ultrastable.json": ".well-known/ultrastable.json", "/nope": "404.html" };
for (const [path, file] of Object.entries(routes)) {
  const r = await handle(new Request("https://pages.local" + path), env);
  let body = await r.text();
  // links are written for a site at the root; a Pages project site lives under /<repo>/
  if (file.endsWith(".html")) body = body.replace(/(href|src)="\/(?!\/)/g, `$1="${BASE}/`).replace(/"(\/(?:api|claims|feed|health|social)[^"]*)"/g, `"${BASE}$1"`);
  mkdirSync(dirname("_site/" + file), { recursive: true });
  writeFileSync("_site/" + file, body);
  console.log(r.status, path, "->", file);
}
// Pages serves files, not routes: the extension-less paths the contract names are copied as folders with an index
for (const [p, f] of [["health", "health.json"], ["api/beats", "api/beats.json"], ["api/graph", "api/graph.json"]]) { mkdirSync("_site/" + p, { recursive: true }); writeFileSync(`_site/${p}/index.json`, (await import("node:fs")).readFileSync("_site/" + f)); }
writeFileSync("_site/.nojekyll", "");
