import { strict as assert } from "node:assert";
import test from "node:test";
import { executeContract } from "../src/core/executor.js";
import type { ContractIR } from "../src/types/ir.js";
import type { Scenario } from "../src/types/scenario.js";

function genericScenario(): Scenario {
  return {
    scenarioId: "generic-baseline",
    name: "Baseline",
    archetype: "baseline",
    initialState: { contractFamily: "generic", contractStart: "2026-01-01" },
    events: [{ id: "exec-event", date: "2026-01-01", type: "notice" }],
  };
}

function ir(clauses: ContractIR["clauses"]): ContractIR {
  return {
    contractId: "test",
    parties: [
      { id: "party-employer", role: "employer", name: "Acme" },
      { id: "party-employee", role: "employee", name: "Employee" },
    ],
    clauses,
    definitions: [],
    metadata: { sourceFile: "synthetic.md", extractorVersion: "test" },
  };
}

test("generic executor emits a scheduled statement for each modeled payment", () => {
  const contract = ir([
    {
      id: "clause.base_salary",
      title: "Base Salary",
      sourceText: "Employee shall be paid $250,000 per year.",
      modeled: true,
      semanticTag: "recurring_base_salary",
      effect: {
        kind: "payment",
        payer: "party-employer",
        payee: "party-employee",
        amount: { op: "const", value: 250000 },
      },
    },
  ]);
  const result = executeContract(contract, genericScenario());
  const paymentStmt = result.ledger.find(
    (e) => e.kind === "statement" && e.clauseId === "clause.base_salary",
  );
  assert.ok(paymentStmt, "expected scheduled statement for payment clause");
  assert.equal(paymentStmt!.amount, 250000);
});

test("generic executor emits a statement for each modeled definitional formula", () => {
  const contract = ir([
    {
      id: "clause.firm_price",
      title: "Firm Fixed Price",
      sourceText: "Unit price shall be $12,500 per payload.",
      modeled: true,
      semanticTag: "firm_fixed_price",
      effect: {
        kind: "formula",
        outputVar: "firm_fixed_price",
        expr: { op: "const", value: 12500 },
      },
    },
  ]);
  const result = executeContract(contract, genericScenario());
  const formulaStmt = result.ledger.find(
    (e) => e.kind === "statement" && e.clauseId === "clause.firm_price",
  );
  assert.ok(formulaStmt, "expected scheduled statement for formula clause");
  assert.equal(formulaStmt!.amount, 12500);
  assert.match(formulaStmt!.description, /firm_fixed_price/);
});

test("generic executor still registers obligations alongside payments/formulas", () => {
  const contract = ir([
    {
      id: "clause.term",
      title: "Employment term",
      sourceText: "Employee shall be employed for one year.",
      modeled: true,
      semanticTag: "employment_term",
      effect: {
        kind: "obligation",
        actor: "party-employer",
        action: "employ Employee for one year",
        due: { type: "calendar_days", value: 365 },
      },
    },
    {
      id: "clause.salary",
      title: "Salary",
      sourceText: "$250,000 per year.",
      modeled: true,
      semanticTag: "recurring_base_salary",
      effect: {
        kind: "payment",
        payer: "party-employer",
        payee: "party-employee",
        amount: { op: "const", value: 250000 },
      },
    },
  ]);
  const result = executeContract(contract, genericScenario());
  assert.equal(result.obligations.length, 1);
  const paymentStmt = result.ledger.find(
    (e) => e.kind === "statement" && e.clauseId === "clause.salary",
  );
  assert.ok(paymentStmt);
});
