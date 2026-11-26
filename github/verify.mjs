// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) Ultrastable
// GH-ONLY-1 (NO-FABRICATION-1): the gate between a model's draft and the published list. A draft is kept only when its DOI is one of the
// sources the loop fetched, its quote is a literal sentence of that source's abstract, and every number it states is in that quote.
// The model never supplies a fact the code cannot find in the source text.
import { validate } from "../worker/entries.js";

export const clean = s => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const nums = s => (String(s).match(/\d+(?:[.,]\d+)?/g) || []).map(n => n.replace(",", "."));
export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

// sources: [{ doi, title, year, abstract }] as read from Crossref; draft: the model's JSON answer.
export function verify(draft, sources, topic) {
  const why = [];
  const src = sources.find(s => s.doi.toLowerCase() === String(draft?.doi || "").toLowerCase());
  if (!src) return { ok: false, why: ["the DOI is not one of the fetched sources"] };
  const abs = clean(src.abstract), quote = clean(draft.quote);
  if (quote.length < 30) why.push("the quote is too short to carry a base rate");
  if (!abs.includes(quote)) why.push("the quote is not a literal part of the abstract");
  const qn = nums(quote), rn = nums(draft.rate);
  for (const n of rn) if (!qn.includes(n)) why.push(`the number ${n} is not in the quote`);
  const entry = {
    id: slug(topic), title: String(draft.title || topic).slice(0, 120), lean: String(draft.rate || "").slice(0, 160),
    summary: quote, sources: [{ title: clean(src.title), year: src.year, doi: src.doi }],
    grade: "lean quoted from the source abstract; study design not yet graded",
  };
  for (const b of validate(entry)) why.push(b);
  return why.length ? { ok: false, why } : { ok: true, entry };
}
