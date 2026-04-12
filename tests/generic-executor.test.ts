import { strict as assert } from "node:assert";
import test from "node:test";
import { executeContract } from "../src/core/executor.js";
import {
  eventTypesForVerb,
  matchEventToObligation,
  obligationVerb,
  type ObligationForMatching,
} from "../src/core/match-obligation.js";
import type { Clause, ContractIR } from "../src/types/ir.js";
import type { Scenario, ScenarioEvent } from "../src/types/scenario.js";

interface ObligationOverrides {
  id?: string;
  title?: string;
  sourceText?: string;
  modeled?: boolean;
  actor?: string;
  action?: string;
  due?: { type: "on_date"; value: string };
}

function mkObligation(overrides: ObligationOverrides = {}): Clause {
  return {
    id: overrides.id ?? "clause.obligation.deliver_goods",
    title: overrides.title ?? "Deliver goods",
    sourceText:
      overrides.sourceText ?? "Seller shall deliver conforming goods by 2026-02-15.",
    modeled: overrides.modeled ?? true,
    semanticTag: "delivery_obligation",
    effect: {
      kind: "obligation",
      actor: overrides.actor ?? "party.seller",
      action: overrides.action ?? "Deliver conforming goods",
      due: overrides.due ?? { type: "on_date", value: "2026-02-15" },
    },
  };
}

// Extract the matcher-facing fields from a new-shape Clause.
function toMatch(clause: Clause): ObligationForMatching {
  if (clause.effect.kind !== "obligation") {
    throw new Error("mkObligation helper must produce an obligation effect");
  }
  return { id: clause.id, actor: clause.effect.actor, action: clause.effect.action };
}

function mkEvent(overrides: Partial<ScenarioEvent> = {}): ScenarioEvent {
  return {
    id: "event-1",
    date: "2026-02-15",
    type: "delivery",
    ...overrides,
  };
}

test("obligationVerb extracts leading verb lowercased", () => {
  assert.equal(obligationVerb("Pay monthly rent"), "pay");
  assert.equal(obligationVerb("Deliver conforming goods"), "deliver");
  assert.equal(obligationVerb(""), "");
});

test("eventTypesForVerb maps known verbs, returns empty for unknown", () => {
  assert.deepEqual(eventTypesForVerb("pay"), ["payment"]);
  assert.deepEqual(eventTypesForVerb("deliver"), ["delivery"]);
  assert.deepEqual(eventTypesForVerb("unknown-verb"), []);
});

test("matcher: explicit clauseId wins over actor/verb/window", () => {
  const ob = mkObligation();
  const ev = mkEvent({
    date: "2030-01-01",
    type: "action",
    metadata: { clauseId: ob.id },
  });
  const result = matchEventToObligation(ev, toMatch(ob), "2026-02-15");
  assert.equal(result.matched, true);
  assert.equal(result.reason, "clauseId");
});

test("matcher: actor+verb+window fallback matches inside window", () => {
  const ob = mkObligation();
  const ev = mkEvent({
    date: "2026-02-17",
    type: "delivery",
    metadata: { actor: "party.seller" },
  });
  const result = matchEventToObligation(ev, toMatch(ob), "2026-02-15", 7);
  assert.equal(result.matched, true);
  assert.equal(result.reason, "actor+verb+window");
});

test("matcher: actor+verb+window no-match when outside window", () => {
  const ob = mkObligation();
  const ev = mkEvent({
    date: "2026-04-01",
    type: "delivery",
    metadata: { actor: "party.seller" },
  });
  const result = matchEventToObligation(ev, toMatch(ob), "2026-02-15", 7);
  assert.equal(result.matched, false);
  assert.equal(result.reason, "no-match");
});

test("matcher: actor+verb+window no-match when actor differs", () => {
  const ob = mkObligation();
  const ev = mkEvent({
    date: "2026-02-16",
    type: "delivery",
    metadata: { actor: "party.buyer" },
  });
  const result = matchEventToObligation(ev, toMatch(ob), "2026-02-15", 7);
  assert.equal(result.matched, false);
});

test("matcher: actor+verb+window no-match when event type doesn't fit verb", () => {
  const ob = mkObligation();
  const ev = mkEvent({
    date: "2026-02-16",
    type: "notice",
    metadata: { actor: "party.seller" },
  });
  const result = matchEventToObligation(ev, toMatch(ob), "2026-02-15", 7);
  assert.equal(result.matched, false);
});

test("generic executor: produces non-empty ledger with performed + missed on procurement-shaped IR", () => {
  const ir: ContractIR = {
    contractId: "test-procurement",
    title: "Test Procurement",
    currency: "USD",
    parties: [
      { id: "party.seller", role: "seller", name: "Seller Co" },
      { id: "party.buyer", role: "buyer", name: "Buyer Inc" },
    ],
    definitions: [],
    clauses: [
      mkObligation({
        id: "clause.obligation.deliver_goods",
        action: "Deliver conforming goods",
        due: { type: "on_date", value: "2026-02-15" },
      }),
      mkObligation({
        id: "clause.obligation.notify_defects",
        actor: "party.buyer",
        action: "Notify of any defects",
        due: { type: "on_date", value: "2026-03-01" },
      }),
    ],
    metadata: {
      sourceFile: "test.md",
      extractionHash: "test",
      extractorVersion: "test",
      clauseCount: 2,
      modeledClauseCount: 2,
      extraction: { llmRequested: false, llmUsed: false, mode: "heuristic_fallback" },
    },
  };

  const scenario: Scenario = {
    scenarioId: "test-procurement-baseline",
    archetype: "baseline",
    assumptions: [],
    initialState: { contractStart: "2026-01-01" },
    events: [
      {
        id: "event-delivery",
        date: "2026-02-15",
        type: "delivery",
        metadata: { clauseId: "clause.obligation.deliver_goods" },
      },
      // Buyer notification obligation has no matching event → should miss.
    ],
  };

  const result = executeContract(ir, scenario);
  assert.ok(result.ledger.length > 0, "expected non-empty ledger");
  const metObligations = result.obligations.filter((o) => o.status === "met");
  const missedObligations = result.obligations.filter((o) => o.status === "missed");
  assert.equal(metObligations.length, 1, "expected one met obligation");
  assert.equal(missedObligations.length, 1, "expected one missed obligation");
  assert.ok(
    result.breaches.some((b) => b.type === "obligation_missed"),
    "expected obligation_missed breach",
  );
});
