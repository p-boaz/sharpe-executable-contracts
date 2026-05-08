import { strict as assert } from "node:assert";
import test from "node:test";
import {
  extractIsoDate,
  findDefinition,
  findReferencedTerms,
  resolveTermToDate,
} from "../../src/core/definition-resolver.js";
import type { ContractIR } from "../../src/types/ir.js";

function ir(defs: ContractIR["definitions"]): ContractIR {
  return {
    contractId: "test",
    parties: [],
    clauses: [],
    definitions: defs,
    metadata: { sourceFile: "x.md", extractorVersion: "test" },
  };
}

test("findDefinition is case- and whitespace-tolerant", () => {
  const contract = ir([
    { id: "def-1", term: "Closing Date", meaning: "April 1, 2009.", sourceText: "" },
  ]);
  assert.ok(findDefinition("closing_date", contract));
  assert.ok(findDefinition("ClosingDate", contract));
  assert.ok(findDefinition("Closing Date", contract));
  assert.equal(findDefinition("not-a-term", contract), undefined);
});

test("extractIsoDate parses month-day-year, day-month-year, and ISO forms", () => {
  assert.equal(extractIsoDate("April 1, 2009."), "2009-04-01");
  assert.equal(extractIsoDate("delivered on February 1, 2007"), "2007-02-01");
  assert.equal(extractIsoDate("signed 3 November 2004"), "2004-11-03");
  assert.equal(extractIsoDate("due 2026-04-14"), "2026-04-14");
  assert.equal(extractIsoDate("on the date first hereinabove appearing"), null);
});

test("resolveTermToDate chains lookup and parse", () => {
  const contract = ir([
    { id: "def-ed", term: "Effective Date", meaning: "April 1, 2009.", sourceText: "" },
    { id: "def-vag", term: "Commencement Date", meaning: "The earlier of X or Y.", sourceText: "" },
  ]);
  assert.equal(resolveTermToDate("effective_date", contract), "2009-04-01");
  assert.equal(resolveTermToDate("commencement_date", contract), null);
  assert.equal(resolveTermToDate("not_a_term", contract), null);
});

test("findReferencedTerms requires whole-word match and de-duplicates", () => {
  const contract = ir([
    { id: "def-fund", term: "Fund", meaning: "xx", sourceText: "" },
    { id: "def-funds", term: "Funds", meaning: "yy", sourceText: "" },
    { id: "def-client", term: "Client", meaning: "zz", sourceText: "" },
  ]);
  // "funding" should NOT match "Fund" (requires word boundary).
  const hits = findReferencedTerms(
    "The Client shall inform the Fund and the Funds of any funding events.",
    contract,
  );
  const ids = hits.map((d) => d.id).sort();
  assert.deepEqual(ids, ["def-client", "def-fund", "def-funds"]);
});
