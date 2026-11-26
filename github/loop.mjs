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

async function sources(topic) {
  const u = "https://api.crossref.org/works?rows=6&filter=has-abstract:true&select=DOI,title,abstract,issued&query=" + encodeURIComponent(topic + " rate");
  const r = await fetch(u, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error("Crossref " + r.status);
  return ((await r.json()).message.items || []).map(i => ({ doi: i.DOI, title: clean((i.title || [])[0]), year: i.issued?.["date-parts"]?.[0]?.[0] || null, abstract: clean(i.abstract) })).filter(s => s.year && s.abstract.length > 80);
}

// Two free model routes, so no single provider stops the loop: GitHub Models on the run's own token, then Hugging Face's router when an
// HF_TOKEN secret exists (a free account's token; without it that route is skipped and says so).
async function chat(prompt) {
  const routes = [
    { name: "github-models", url: "https://models.github.ai/inference/chat/completions", key: TOKEN, model: MODEL },
    { name: "huggingface", url: "https://router.huggingface.co/v1/chat/completions", key: process.env.HF_TOKEN || "", model: process.env.HF_MODEL || "meta-llama/Llama-3.1-8B-Instruct" },
  ];
  let last = "";
  for (const r0 of routes) {
    if (!r0.key) { say("route", r0.name, "skipped: no token"); continue; }
    const r = await fetch(r0.url, { method: "POST", headers: { authorization: "Bearer " + r0.key, "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ model: r0.model, temperature: 0, max_tokens: 400, messages: [{ role: "system", content: "You extract facts from study abstracts. Reply with one JSON object and nothing else." }, { role: "user", content: prompt }] }) });
    say("route", r0.name, r.status, ["x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens"].map(h => h + "=" + r.headers.get(h)).join(" "));
    if (!r.ok) { last = r0.name + " " + r.status + ": " + (await r.text()).slice(0, 160); continue; }
    const j = await r.json(), txt = j.choices[0].message.content || "{}";
    say("reply", JSON.stringify(txt.slice(0, 200)));
    return { answer: JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1) || "{}"), route: r0.name, usage: j.usage };
  }
  throw new Error("no model route answered: " + last);
}

async function draft(topic, srcs) {
  const prompt = `Open question: "${topic}". Below are study abstracts. If one abstract says where the evidence currently leans on this question, or says plainly that it is unresolved, answer with JSON only: {"doi": the DOI, "quote": one sentence copied EXACTLY from that abstract that says where the evidence leans or what is still unknown, "rate": a short plain statement of the current lean using only numbers that are in that sentence (or none), "title": the open question as a plain question}. If none does, answer {"doi": null}.\n\n` +
    srcs.map(s => `DOI: ${s.doi}\nTitle: ${s.title}\nAbstract: ${s.abstract.slice(0, 1800)}`).join("\n\n");
  return chat(prompt);
}

const title = t => "Find where the evidence leans: " + t;
export async function run() {
  const topics = JSON.parse(readFileSync("data/topics.json", "utf8")).topics;
  const entries = JSON.parse(readFileSync("data/entries.json", "utf8"));
  const done = new Set(entries.map(e => e.id));
  const open = await gh(`/repos/${REPO}/issues?state=open&labels=queue&per_page=100&sort=updated&direction=asc`);
  const byTopic = new Map(open.map(i => [i.title.replace(title(""), ""), i]));
  // queue order: topics never tried, then open queue issues, least recently tried first
  const order = [...topics.filter(t => !done.has(slug(t)) && !byTopic.has(t)), ...open.map(i => i.title.replace(title(""), "")).filter(t => topics.includes(t) && !done.has(slug(t)))];
  say("queue", order.length, "open issues", open.length, "published", entries.length);
  let added = 0;
  for (const topic of order.slice(0, TRIES)) {
    let outcome;
    try {
      const srcs = await sources(topic);
      if (!srcs.length) outcome = { ok: false, why: ["Crossref returned no abstract for this query"] };
      else { const d = await draft(topic, srcs); outcome = d.answer?.doi ? verify(d.answer, srcs, topic) : { ok: false, why: ["the model found no stated base rate in " + srcs.length + " abstracts"] }; }
    } catch (e) { outcome = { ok: false, why: [String(e.message || e)] }; }
    const issue = byTopic.get(topic);
    if (outcome.ok) {
      entries.push(outcome.entry); added++; say("kept", topic, "->", outcome.entry.rate);
      if (issue) { await gh(`/repos/${REPO}/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body: "Published: " + outcome.entry.rate + " (doi:" + outcome.entry.sources[0].doi + ")" }) });
        await gh(`/repos/${REPO}/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) }); }
    } else {
      say("not yet", topic, ":", outcome.why.join("; "));
      const body = "Tried " + new Date().toISOString().slice(0, 10) + ": " + outcome.why.join("; ") + ". The loop tries again on a later run.";
      if (issue) await gh(`/repos/${REPO}/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
      else await gh(`/repos/${REPO}/issues`, { method: "POST", body: JSON.stringify({ title: title(topic), labels: ["queue"], body: "Owner: the Open Questions loop (`.github/workflows/loop.yml`). Done when a verified entry for this reference class is in `data/entries.json` (closing probe: `github/verify.mjs`).\n\n" + body }) });
    }
  }
  if (added) writeFileSync("data/entries.json", JSON.stringify(entries, null, 1) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, "## Open Questions loop\n\n" + log.map(l => "- " + l).join("\n") + "\n", { flag: "a" });
  return { added };
}
if (import.meta.url === "file://" + process.argv[1]) run().catch(e => { console.error(e); process.exit(1); });
