import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findUnknownSemanticTags } from "../../src/pipeline/semantic-tag-validator.js";
import type { Clause } from "../../src/types/ir.js";

const mkClause = (id: string, tag: string): Clause => ({
  id,
  title: id,
  sourceText: "",
  modeled: true,
  semanticTag: tag,
  effect: { kind: "unmodeled" },
});

describe("findUnknownSemanticTags", () => {
  it("returns empty when all tags are known", () => {
    const result = findUnknownSemanticTags([
      mkClause("a", "late_payment_fee"),
      mkClause("b", "rent_obligation"),
    ]);
    assert.deepStrictEqual(result, []);
  });

  it("lists clauses with unknown tags", () => {
    const clauses = [
      mkClause("a", "late_payment_fee"),
      mkClause("b", "late-payment-fee"),  // hyphenated drift
      mkClause("c", "mystery_tag"),       // invented
    ];
    const result = findUnknownSemanticTags(clauses);
    assert.deepStrictEqual(result, [
      { clauseId: "b", tag: "late-payment-fee" },
      { clauseId: "c", tag: "mystery_tag" },
    ]);
  });

  it("treats untagged as unknown (no longer in the vocab)", () => {
    const result = findUnknownSemanticTags([mkClause("a", "untagged")]);
    assert.deepStrictEqual(result, [{ clauseId: "a", tag: "untagged" }]);
  });
});
