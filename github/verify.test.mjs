// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) Ultrastable
import test from "node:test";
import assert from "node:assert/strict";
import { verify } from "./verify.mjs";

const src = [{ doi: "10.1/x", title: "<i>Survival</i> of firms", year: 2020, abstract: "<jats:p>We follow firms. About 45 percent of new firms survive five years in the sample.</jats:p>" }];
test("a draft whose quote and numbers are in the abstract is kept", () => {
  const r = verify({ doi: "10.1/X", quote: "About 45 percent of new firms survive five years in the sample.", rate: "45% survive five years", title: "New firms surviving five years" }, src, "new firm survival");
  assert.equal(r.ok, true); assert.equal(r.entry.sources[0].title, "Survival of firms");
});
test("a number the source does not state is refused", () => {
  const r = verify({ doi: "10.1/x", quote: "About 45 percent of new firms survive five years in the sample.", rate: "60% survive" }, src, "t");
  assert.equal(r.ok, false); assert.match(r.why.join(), /60/);
});
test("a quote that is not in the abstract, or an unknown DOI, is refused", () => {
  assert.equal(verify({ doi: "10.1/x", quote: "Most new firms close within a year of opening their doors.", rate: "most close" }, src, "t").ok, false);
  assert.equal(verify({ doi: "10.9/none", quote: "x", rate: "1" }, src, "t").ok, false);
});
