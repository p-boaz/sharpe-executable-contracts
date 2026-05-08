import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { ContractIR } from "../../src/types/ir.js";

// These tests pin the three recall invariants the POSTMORTEM §1 table
// regressed against. They assert against the committed out/ caches
// (regenerated under Task 5 + Task 4.5 + FU#1/#3/#2) so they run
// deterministically in CI without an API key.

const root = resolve(process.cwd());

function loadIr(contractDir: string): ContractIR {
  const path = resolve(root, "out", contractDir, "ir.json");
  return JSON.parse(readFileSync(path, "utf8")) as ContractIR;
}

test("POSTMORTEM regression: no single-clause unmodeled_summary collapse on any committed contract", () => {
  // The original POSTMORTEM §1 failure was that 5 of 7 contracts collapsed
  // into a single clause with semanticTag=unmodeled_summary covering the
  // first 260 chars of source. The committed caches (which represent the
  // two executor-supported families) should show the opposite.
  for (const dir of [
    "westex-visa-credit-card-agreement",
    "galleria-atlanta-office-lease-american-safety-insurance-2006",
  ]) {
    const ir = loadIr(dir);
    assert.ok(ir.clauses.length > 1, `${dir}: expected >1 clause, got ${ir.clauses.length}`);
    const summaryCollapse =
      ir.clauses.length === 1 && ir.clauses[0]?.semanticTag === "unmodeled_summary";
    assert.equal(summaryCollapse, false, `${dir}: collapsed to single unmodeled_summary`);
  }
});

test("credit-card: emits late_payment_fee and minimum_payment_formula in closed vocab form", () => {
  const ir = loadIr("westex-visa-credit-card-agreement");
  const tags = new Set(ir.clauses.map((c) => c.semanticTag));
  assert.ok(tags.has("late_payment_fee"), "expected late_payment_fee tag");
  assert.ok(tags.has("minimum_payment_formula"), "expected minimum_payment_formula tag");
  // Underscore form, no hyphenated drift.
  assert.ok(!tags.has("late-payment-fee"));
  assert.ok(!tags.has("minimum-payment-formula"));
});

test("galleria lease: emits rent_obligation in closed vocab form", () => {
  const ir = loadIr("galleria-atlanta-office-lease-american-safety-insurance-2006");
  const tags = new Set(ir.clauses.map((c) => c.semanticTag));
  assert.ok(tags.has("rent_obligation"), "expected rent_obligation tag");
  assert.ok(!tags.has("rent-obligation"));
});
