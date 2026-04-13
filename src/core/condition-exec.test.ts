import { strict as assert } from "node:assert";
import { executeContract } from "./executor.js";
import type { ContractIR } from "../types/ir.js";

const leaseIr: ContractIR = {
  contractId: "lease-test",
  title: "Lease Test",
  currency: "USD",
  parties: [
    { id: "landlord", role: "landlord", name: "Landlord" },
    { id: "tenant", role: "tenant", name: "Tenant" },
  ],
  definitions: [],
  clauses: [
    {
      id: "clause.obligation.monthly_rent",
      title: "Monthly rent due",
      sourceText: "Tenant shall pay monthly rent.",
      modeled: true,
      semanticTag: "rent_obligation",
      condition: { op: "eq", left: "rent_cycle_active", right: 1 },
      effect: {
        kind: "obligation",
        actor: "tenant",
        action: "Pay monthly rent",
        due: { type: "on_date", value: "first_day_of_month" },
      },
    },
    {
      id: "clause.formula.monthly_rent",
      title: "Monthly rent amount",
      sourceText: "$100 monthly rent",
      modeled: true,
      semanticTag: "base_rent",
      effect: {
        kind: "formula",
        outputVar: "monthly_rent_due",
        expr: { op: "const", value: 100 },
      },
    },
  ],
  metadata: {
    sourceFile: "lease-test.md",
    extractionHash: "test",
    extractorVersion: "test",
    clauseCount: 2,
    modeledClauseCount: 2,
    extraction: {
      llmRequested: true,
      llmUsed: true,
      mode: "llm",
    },
  },
};

function run(): void {
  const scenarioConditionTrue = {
    scenarioId: "s-true",
    assumptions: [],
    initialState: {
      contractFamily: "lease",
      monthlyRent: 100,
      rentDueDate: "2026-02-01",
      rent_cycle_active: 1,
    },
    events: [
      { id: "evt-001", date: "2026-02-05", type: "payment" as const, amount: 60 },
      { id: "evt-002", date: "2026-02-10", type: "due_check" as const },
    ],
  };
  const scenarioConditionFalse = {
    scenarioId: "s-false",
    assumptions: [],
    initialState: {
      contractFamily: "lease",
      monthlyRent: 100,
      rentDueDate: "2026-02-01",
      rent_cycle_active: 0,
    },
    events: [
      { id: "evt-001", date: "2026-02-05", type: "payment" as const, amount: 60 },
      { id: "evt-002", date: "2026-02-10", type: "due_check" as const },
    ],
  };

  const resultTrue = executeContract(leaseIr, scenarioConditionTrue);
  const resultFalse = executeContract(leaseIr, scenarioConditionFalse);

  assert.equal(resultTrue.obligations.length, 1);
  assert.equal(resultTrue.breaches.length, 1);
  assert.equal(resultTrue.summary.breached, true);

  assert.equal(resultFalse.obligations.length, 0);
  assert.equal(resultFalse.breaches.length, 0);
  assert.equal(resultFalse.summary.breached, false);
  assert.ok(
    resultFalse.ledger.some((entry) =>
      entry.description.includes("condition evaluated false"),
    ),
  );
}

run();
process.stdout.write("condition execution tests passed\n");
