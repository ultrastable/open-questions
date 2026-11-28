// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) Ultrastable
// GH-ONLY-1: the Open Questions loop on GitHub alone. Issues are the work queue, Crossref is the source, GitHub Models drafts, verify.mjs decides,
// data/entries.json is the database. It writes data/entries.json only when a verified entry is new, so a quiet run commits nothing.
// Needs only the run's own GITHUB_TOKEN (models: read, issues: write); no stored secret.
import { readFileSync, writeFileSync } from "node:fs";
import { verify, clean, slug } from "./verify.mjs";

const REPO = process.env.GITHUB_REPOSITORY || "ultrastable/open-questions", TOKEN = process.env.GITHUB_TOKEN || "";
const MODEL = process.env.MODEL || "openai/gpt-4o-mini", TRIES = Number(process.env.TRIES || 2);
const UA = "open-questions-loop (https://github.com/" + REPO + ")";
const gh = async (path, init = {}) => {
  const r = await fetch("https://api.github.com" + path, { ...init, headers: { authorization: "Bearer " + TOKEN, accept: "application/vnd.github+json", "user-agent": UA, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`GitHub ${r.status} on ${path}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
};
const log = [];
const say = (...a) => { const l = a.join(" "); log.push(l); console.log(l); };

// A retry used to fetch the same six top hits for a temperature-0 model, so a topic that failed once failed forever. Each attempt now
// searches a different window (offset) and phrasing (core lesson: a retry that repeats its input cannot converge).
const PAGE = 6, MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 6);
const PHRASES = [" review", " systematic review", " meta-analysis", " evidence consensus", " unresolved"];
export const plan = attempt => ({ rows: 10, offset: attempt * 10, phrase: PHRASES[attempt % PHRASES.length] });
// An issue exists only because an attempt already failed (its first note is in the body), so its next attempt is comments + 1.
export const attemptOf = issue => (issue ? issue.comments + 1 : 0);
async function sources(topic, attempt = 0) {
  const p = plan(attempt);
  const u = `https://api.crossref.org/works?rows=${p.rows}&offset=${p.offset}&filter=has-abstract:true&select=DOI,title,abstract,issued&query=` + encodeURIComponent(topic + p.phrase);
  const r = await fetch(u, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error("Crossref " + r.status);
  return ((await r.json()).message.items || []).map(i => ({ doi: i.DOI, title: clean((i.title || [])[0]), year: i.issued?.["date-parts"]?.[0]?.[0] || null, abstract: clean(i.abstract) })).filter(s => s.year && s.abstract.length > 80);
}

// Two free model routes, so no single provider stops the loop: GitHub Models on the run's own token, then Hugging Face's router when an
// HF_TOKEN secret exists (a free account's token; without it that route is skipped and says so).
let lastPoll = 0;
async function chat(prompt) {
  const routes = [
    { name: "github-models", url: "https://models.github.ai/inference/chat/completions", key: TOKEN, model: MODEL },
    { name: "github-models-org", url: "https://models.github.ai/orgs/" + REPO.split("/")[0] + "/inference/chat/completions", key: TOKEN, model: MODEL },
    // Keyless free route: Pollinations serves an OpenAI-shaped endpoint with no account. Its answers pass the same verify gate.
    { name: "pollinations", url: "https://text.pollinations.ai/openai", key: "none", model: "openai" },
    { name: "huggingface", url: "https://router.huggingface.co/v1/chat/completions", key: process.env.HF_TOKEN || "", model: process.env.HF_MODEL || "meta-llama/Llama-3.1-8B-Instruct" },
  ];
  let last = "";
  const failed = [];
  for (const r0 of routes) {
    // Pollinations allows one free reply per 45 s per IP; wait out the gap instead of losing the try.
    if (r0.name === "pollinations" && lastPoll && Date.now() - lastPoll < 46000) await new Promise(ok => setTimeout(ok, 46000 - (Date.now() - lastPoll)));
    if (r0.name === "pollinations") lastPoll = Date.now();
    if (!r0.key) { say("route", r0.name, "skipped: no token"); failed.push(r0.name + " skipped (no token)"); continue; }
    const r = await fetch(r0.url, { method: "POST", headers: { ...(r0.key === "none" ? {} : { authorization: "Bearer " + r0.key }), "content-type": "application/json", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": UA },
      body: JSON.stringify({ model: r0.model, temperature: 0, max_tokens: 400, messages: [{ role: "system", content: "You extract facts from study abstracts. Reply with one JSON object and nothing else." }, { role: "user", content: prompt }] }) });
    say("route", r0.name, r.status, ["x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens"].map(h => h + "=" + r.headers.get(h)).join(" "));
    if (!r.ok) { last = r0.name + " " + r.status + ": " + (await r.text()).slice(0, 160); failed.push(last); continue; }
    const raw = await r.text();
    let j; try { j = JSON.parse(raw); } catch { last = r0.name + " answered 200 with non-JSON: " + JSON.stringify(raw.slice(0, 80)); say(last); failed.push(last); continue; }
    const txt = j.choices?.[0]?.message?.content || "{}";
    say("reply", JSON.stringify(txt.slice(0, 200)));
    let answer; try { answer = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1) || "{}"); } catch { last = r0.name + " reply was not JSON"; failed.push(last); continue; }
    return { answer, route: r0.name, usage: j.usage, failed };
  }
  throw new Error("no model route answered: " + last);
}

async function draft(topic, srcs) {
  const prompt = `Open question: "${topic}". Below are study abstracts. If one abstract says where the evidence currently leans on this question, or says plainly that it is unresolved, answer with JSON only: {"doi": the DOI, "quote": one sentence copied EXACTLY from that abstract that says where the evidence leans or what is still unknown, "rate": a short plain statement of the current lean using only numbers that are in that sentence (or none), "title": the open question as a plain question}. If none does, answer {"doi": null}.\n\n` +
    srcs.map(s => `DOI: ${s.doi}\nTitle: ${s.title}\nAbstract: ${s.abstract.slice(0, 900)}`).join("\n\n");
  return chat(prompt);
}

const title = t => "Find where the evidence leans: " + t;
export async function run() {
  const topics = JSON.parse(readFileSync("data/topics.json", "utf8")).topics;
  const entries = JSON.parse(readFileSync("data/entries.json", "utf8"));
  const done = new Set(entries.map(e => e.id));
  const open = await gh(`/repos/${REPO}/issues?state=open&labels=queue&per_page=100&sort=updated&direction=asc`);
  const shelved = new Set((await gh(`/repos/${REPO}/issues?state=closed&labels=queue&per_page=100`)).filter(i => i.state_reason === "not_planned").map(i => i.title.replace(title(""), "")));
  const byTopic = new Map(open.map(i => [i.title.replace(title(""), ""), i]));
  // queue order: topics never tried, then open queue issues, least recently tried first
  const order = [...topics.filter(t => !done.has(slug(t)) && !byTopic.has(t) && !shelved.has(t)), ...open.map(i => i.title.replace(title(""), "")).filter(t => topics.includes(t) && !done.has(slug(t)))];
  say("queue", order.length, "open issues", open.length, "published", entries.length);
  let added = 0;
  for (const topic of order.slice(0, TRIES)) {
    let outcome, route = "";
    const issue = byTopic.get(topic), attempt = attemptOf(issue);
    try {
      const srcs = await sources(topic, attempt);
      if (!srcs.length) outcome = { ok: false, why: ["Crossref returned no abstract for this query"] };
      else { const d = await draft(topic, srcs); route = d.route + (d.failed.length ? " (earlier routes failed: " + d.failed.map(f => f.slice(0, 60)).join(" | ") + ")" : ""); outcome = d.answer?.doi ? verify(d.answer, srcs, topic) : { ok: false, why: ["no abstract on page " + (attempt + 1) + " (" + srcs.length + " read) stated where the evidence leans"] }; }
    } catch (e) { outcome = { ok: false, why: [String(e.message || e)] }; }
    if (outcome.ok) {
      entries.push(outcome.entry); added++; say("kept", topic, "->", outcome.entry.rate);
      if (issue) { await gh(`/repos/${REPO}/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body: "Published: " + outcome.entry.rate + " (doi:" + outcome.entry.sources[0].doi + ")" }) });
        await gh(`/repos/${REPO}/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) }); }
    } else {
      say("not yet", topic, ":", outcome.why.join("; "));
      const spent = attempt + 1 >= MAX_ATTEMPTS;  // ATTEMPTS-CAP-1: a queue item ends with a disposition, it never idles open forever
      const body = "Tried " + new Date().toISOString().slice(0, 10) + " (attempt " + (attempt + 1) + "/" + MAX_ATTEMPTS + (route ? ", answered by " + route : "") + "): " + outcome.why.join("; ") +
        (spent ? ". Cap reached: closed as not planned, no source stated a lean. Reopen to retry." : ". The next run reads the next page of sources.");
      if (issue) { await gh(`/repos/${REPO}/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
        if (spent) await gh(`/repos/${REPO}/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "not_planned" }) }); }
      else await gh(`/repos/${REPO}/issues`, { method: "POST", body: JSON.stringify({ title: title(topic), labels: ["queue"], body: "Owner: the Open Questions loop (`.github/workflows/loop.yml`). Done when a verified entry for this reference class is in `data/entries.json` (closing probe: `github/verify.mjs`).\n\n" + body }) });
    }
  }
  if (added) writeFileSync("data/entries.json", JSON.stringify(entries, null, 1) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, "## Open Questions loop\n\n" + log.map(l => "- " + l).join("\n") + "\n", { flag: "a" });
  return { added };
}
if (import.meta.url === "file://" + process.argv[1]) run().catch(e => { console.error(e); process.exit(1); });
