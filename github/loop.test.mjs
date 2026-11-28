// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) Ultrastable
// Regression for the stuck queue: a retry must read different sources, a spent item must close with a disposition, and a model route that
// answers 200 with non-JSON must be recorded, not mistaken for "no lean found".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.GITHUB_TOKEN = "t"; process.env.GITHUB_REPOSITORY = "o/r"; process.env.MAX_ATTEMPTS = "2"; process.env.TRIES = "1";
const { run } = await import("./loop.mjs");

const { slug } = await import("./verify.mjs");
const topics = JSON.parse(readFileSync("data/topics.json", "utf8")).topics, done = new Set(JSON.parse(readFileSync("data/entries.json", "utf8")).map(e => e.id));
const TOPIC = topics.find(t => !done.has(slug(t)));
const abs = "Despite many trials, the evidence on this question remains unresolved and further research is needed to decide it.";
test("retries page through sources; the cap closes the issue as not planned", async () => {
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push([init.method || "GET", u, init.body]);
    const json = o => new Response(JSON.stringify(o), { status: 200 });
    if (u.includes("/issues?state=open")) return json(topics.filter(t => !done.has(slug(t))).map((t, n) => ({ number: t === TOPIC ? 7 : 100 + n, title: "Find where the evidence leans: " + t, state: "open", comments: 1 })).sort(a => (a.number === 7 ? -1 : 1)));
    if (u.includes("/issues?state=closed")) return json([]);
    if (u.endsWith("/issues/7")) return json({ comments: 1 });
    if (u.includes("crossref")) return json({ message: { items: [{ DOI: "10.1/x", title: ["T"], abstract: abs, issued: { "date-parts": [[2024]] } }] } });
    if (u.includes("pollinations") || u.includes("models.github.ai")) return u.includes("pollinations") ? json({ choices: [{ message: { content: '{"doi": null}' } }] }) : new Response("OK\r\n", { status: 200 });
    return json({});
  };
  try { await run(); } finally { globalThis.fetch = real; }
  assert.ok(calls.some(c => c[1].includes("offset=20")), "second attempt reads page 2 of Crossref");
  const patch = calls.find(c => c[0] === "PATCH");
  assert.match(patch[2], /not_planned/);
  const comment = calls.find(c => c[1].endsWith("/issues/7/comments"));
  assert.match(comment[2], /earlier routes failed/);
});
