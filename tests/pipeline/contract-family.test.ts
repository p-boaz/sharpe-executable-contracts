import { test } from "node:test";
import assert from "node:assert/strict";
import { contractFamily } from "../../src/pipeline/archetypes.js";
import type { ContractIR, Clause } from "../../src/types/ir.js";

// Regression test for a bug observed during the Task 5 regen: Galleria
// (a lease) was classified as credit_card because its modeled clauses
// included a `late_payment_fee` (for late rent). Specific signals
// (rent / base_rent / tenant_default) must win over ambiguous ones
// (late_payment_fee appears in both families).

function mkIr(title: string, clauses: Clause[]): ContractIR {
  return {
    contractId: title.toLowerCase().replace(/\s+/g, "-"),
    title,
    currency: "USD",
    parties: [],
    definitions: [],
    clauses,
    metadata: {
      sourceFile: "x.md",
      extractionHash: "h",
      extractorVersion: "v",
      clauseCount: clauses.length,
      modeledClauseCount: clauses.filter((c) => c.modeled).length,
      extraction: { llmRequested: true, llmUsed: true, mode: "llm" },
    },
  };
}

function rentObligation(id: string): Clause {
  return {
    id,
    title: "Rent",
    sourceText: "Rent is due.",
    modeled: true,
    semanticTag: "rent_obligation",
    effect: {
      kind: "obligation",
      actor: "tenant",
      action: "Pay rent",
      due: { type: "on_date", value: "first_of_month" },
    },
  };
}

function latePaymentFee(id: string): Clause {
  return {
    id,
    title: "Late fee",
    sourceText: "Late fee applies.",
    modeled: true,
    semanticTag: "late_payment_fee",
    effect: {
      kind: "payment",
      payer: "party",
      payee: "counterparty",
      amount: { op: "const", value: 25 },
    },
  };
}

function minimumPaymentObligation(id: string): Clause {
  return {
    id,
    title: "Minimum payment",
    sourceText: "Pay minimum.",
    modeled: true,
    semanticTag: "minimum_payment_obligation",
    effect: {
      kind: "obligation",
      actor: "cardholder",
      action: "Pay minimum",
      due: { type: "on_date", value: "statement_due_date" },
    },
  };
}

test("lease with late_payment_fee classifies as lease, not credit_card", () => {
  const ir = mkIr("Galleria Office Lease", [
    rentObligation("clause.2a.rent_obligation"),
    latePaymentFee("clause.2b.late_payment_fee"),
  ]);
  assert.equal(contractFamily(ir), "lease");
});

test("credit card with late_payment_fee + minimum_payment classifies as credit_card", () => {
  const ir = mkIr("WesTex VISA Credit Card Agreement", [
    minimumPaymentObligation("clause.5.minimum_payment_obligation"),
    latePaymentFee("clause.7.late_payment_fee"),
  ]);
  assert.equal(contractFamily(ir), "credit_card");
});

test("late_payment_fee alone (no credit-card-specific tag) does not force credit_card", () => {
  const ir = mkIr("Some Service Agreement", [
    latePaymentFee("clause.7.late_payment_fee"),
  ]);
  assert.equal(contractFamily(ir), "generic");
});

test("generic IR with no family signals classifies as generic", () => {
  const ir = mkIr("Securities Exchange Agreement", [
    {
      id: "clause.1.transfer",
      title: "Transfer",
      sourceText: "Transfer of shares.",
      modeled: false,
      semanticTag: "unmodeled_section",
      effect: { kind: "unmodeled" },
    },
  ]);
  assert.equal(contractFamily(ir), "generic");
});
