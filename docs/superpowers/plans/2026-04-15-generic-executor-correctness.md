# Generic Executor Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `executeGenericContract` a real executor: accumulate balances, reconcile payment events, and resolve conditional anchors (`termination_date`, `closing_date`) against scenario events instead of collapsing them to the contract-start date.

**Architecture:** All work is confined to `src/core/executor.ts` and the shared `ExecutionResult` shape in `src/types/execution.ts`. Lease and credit-card paths (`executeLeaseContract`, `executeCreditCardContract`) are untouched — they already accumulate balances and detect breaches; this plan brings the generic path to parity. No prompt or extractor changes.

**Tech Stack:** TypeScript, Node test runner (`node --test` via tsx), existing fixtures under `tests/fixtures/`.

**Non-goals:** fixing scenario authoring, changing the matcher in `match-obligation.ts`, or revising expectations YAML. Those stay put.

---

## Current failure modes (observed on Sequa baseline execution)

1. `summary.endingBalance`, `totalPaid`, `totalInterestCharged`, `totalFeesCharged` — hardcoded to `0` at `executor.ts:556-561`.
2. `amountDue` / `amountPaid` on every obligation — hardcoded to `0` at `executor.ts:465-466` and never mutated.
3. Payment events (`evt-002` $7,408, `ev-012-severance-payment` $192,608) emit ledger rows with `balanceAfter: 0` and "no obligation matched" — the event's `amount` field is ignored.
4. `resolveDueDate` at `executor.ts:373-394` hard-collapses any anchor to `contractStart`: `const anchor = rule.anchor === "contractEnd" ? contractStart : contractStart;` (ternary is a no-op). Sequa's non-compete `due: {anchor: "termination_date", type: "years", value: 1}` resolves to `2005-06-01` instead of `2007-07-24`.

## File Structure

- Modify: `src/core/executor.ts` — the only source file touched.
- Create: `tests/generic-executor-balances.test.ts` — balance accumulation + summary totals.
- Create: `tests/generic-executor-conditional-anchor.test.ts` — anchor resolution via events.
- Modify: `tests/generic-executor.test.ts` — append regression on non-compete due date.

---

### Task 1: Accumulate balances in the ledger ✅ DONE — commit `ced603a`

**Files:**
- Modify: `src/core/executor.ts` (`asLedger` call sites inside `executeGenericContract`, lines ~413, 439, 476, 514)
- Modify: `src/core/executor.ts` (`summary` return, lines ~556-561)
- Create: `tests/generic-executor-balances.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/generic-executor-balances.test.ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { executeContract } from "../src/core/executor.js";
import type { ContractIR } from "../src/types/ir.js";
import type { Scenario } from "../src/types/scenario.js";

const ir: ContractIR = {
  contractId: "balances-fixture",
  title: "Balances fixture",
  currency: "USD",
  jurisdiction: "NY",
  parties: [
    { id: "party-payer", name: "Payer", role: "buyer" },
    { id: "party-payee", name: "Payee", role: "seller" },
  ],
  definitions: [],
  clauses: [
    {
      id: "clause.fee",
      title: "Fee",
      sourceText: "Payer shall pay $1,000.",
      modeled: true,
      semanticTag: "fixed_fee",
      effect: {
        kind: "payment",
        payer: "party-payer",
        payee: "party-payee",
        amount: { op: "const", value: 1000 },
      },
    },
  ],
  metadata: { clauseCount: 1, modeledClauseCount: 1, sourceFile: "fixture" },
};

const scenario: Scenario = {
  scenarioId: "scn-balances",
  archetype: "baseline",
  label: "Balances baseline",
  summary: "Two partial payments.",
  assumptions: [],
  initialState: { contractStart: "2026-01-01" },
  events: [
    { id: "ev-1", date: "2026-01-15", type: "payment", amount: 400, metadata: { actor: "party-payer" } },
    { id: "ev-2", date: "2026-02-15", type: "payment", amount: 600, metadata: { actor: "party-payer" } },
  ],
};

test("generic executor accumulates balances and totals", () => {
  const result = executeContract(ir, scenario);
  const paymentRows = result.ledger.filter((l) => l.amount > 0);
  assert.equal(paymentRows.length >= 3, true, "expected scheduled + 2 payments in ledger");
  const last = result.ledger[result.ledger.length - 1];
  assert.equal(last.balanceAfter, 0, "fully paid should leave 0 balance");
  assert.equal(result.summary.totalPaid, 1000);
  assert.equal(result.summary.endingBalance, 0);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --test-name-pattern "accumulates balances"`
Expected: FAIL — `totalPaid` is `0`, `balanceAfter` is `0` on all rows including the $1,000 scheduled payment.

- [x] **Step 3: Implement balance accumulation in `executeGenericContract`**

In `src/core/executor.ts`, inside `executeGenericContract`, after all ledger rows are built and before the `summary` return, replace the hardcoded summary block:

```ts
// Replace the existing return-summary block
let runningBalance = 0;
let totalPaid = 0;
for (const entry of ledger) {
  if (entry.kind === "statement" && entry.amount > 0) {
    runningBalance += entry.amount; // scheduled charges
  } else if (entry.kind === "notice" && entry.amount > 0) {
    // payment event: reduce balance
    runningBalance = Math.max(0, runningBalance - entry.amount);
    totalPaid += entry.amount;
  }
  entry.balanceAfter = round2(runningBalance);
}

return {
  ledger,
  breaches,
  obligations: obligations.map((o) => ({
    id: o.id,
    clauseId: o.clauseId,
    dueDate: o.dueDate,
    amountDue: round2(o.amountDue),
    amountPaid: round2(o.amountPaid),
    status: o.status === "open" ? "pending" : o.status,
  })),
  summary: {
    endingBalance: round2(runningBalance),
    totalInterestCharged: 0,
    totalFeesCharged: 0,
    totalPaid: round2(totalPaid),
    breached: breaches.length > 0,
  },
};
```

Also: in the `for (const event of events)` loop around line 483, change the `asLedger` call that currently passes `0` for the amount to use `event.amount ?? 0`:

```ts
ledger.push(
  asLedger(
    event.id,
    event.date,
    "notice",
    event.amount ?? 0,
    0, // balanceAfter filled in the accumulation pass
    matchedClauseId
      ? `Event ${event.id} performed obligation ${matchedClauseId}`
      : `Event ${event.id} recorded (no obligation matched)`,
    matchedClauseId,
  ),
);
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --test-name-pattern "accumulates balances"`
Expected: PASS.

- [x] **Step 5: Run full suite to check regressions**

Run: `pnpm test`
Expected: all prior tests pass. 55/55 passed; no fixture-pinned tests asserted the old zero behavior.

- [x] **Step 6: Commit**

Committed as `ced603a`.

```bash
git add src/core/executor.ts tests/generic-executor-balances.test.ts
git commit -m "fix(executor): accumulate ledger balances and summary totals"
```

---

### Task 2: Reconcile payment events against payment-clause obligations

**Files:**
- Modify: `src/core/executor.ts` (inside `executeGenericContract`, ~line 395 and the events loop at ~483)

- [ ] **Step 1: Write the failing test**

Append to `tests/generic-executor-balances.test.ts`:

```ts
test("generic executor tracks amountDue and amountPaid on payment obligations", () => {
  const result = executeContract(ir, scenario);
  const obl = result.obligations.find((o) => o.clauseId === "clause.fee");
  assert.ok(obl, "expected payment obligation to appear");
  assert.equal(obl.amountDue, 1000);
  assert.equal(obl.amountPaid, 1000);
  assert.equal(obl.status, "met");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --test-name-pattern "amountDue and amountPaid"`
Expected: FAIL — payment clauses don't currently create obligations in `executeGenericContract` (only obligation-kind clauses do).

- [ ] **Step 3: Create payment-backed obligations**

In `executeGenericContract`, after the `modeledPayments` loop that emits `stmt-payment-*` ledger rows, push a matching obligation tracker:

```ts
for (const [index, clause] of modeledPayments.entries()) {
  if (!conditionIsMet(clause.condition, scenario)) continue;
  const amount = evaluateExpr(clause.effect.amount, numericEnv(scenario.initialState));
  const scheduledAmount = Number.isFinite(amount) ? amount : 0;
  ledger.push(
    asLedger(
      `stmt-payment-${index + 1}-${clause.id}`,
      contractStart,
      "statement",
      scheduledAmount,
      0,
      `Scheduled payment: ${clause.effect.payer} → ${clause.effect.payee} (${clause.semanticTag})`,
      clause.id,
    ),
  );
  obligations.push({
    id: `obl-payment-${index + 1}`,
    clauseId: clause.id,
    dueDate: contractStart,
    amountDue: scheduledAmount,
    amountPaid: 0,
    status: scheduledAmount === 0 ? "met" : "open",
  });
}
```

- [ ] **Step 4: Reconcile incoming payment events against those trackers**

Inside the `for (const event of events)` loop, before the existing obligation-matching block, handle payment events specifically:

```ts
if (event.type === "payment" && typeof event.amount === "number") {
  // Reconcile against any open payment obligation in FIFO order.
  const paymentObligation = obligations.find(
    (o) => o.id.startsWith("obl-payment-") && o.status === "open",
  );
  if (paymentObligation) {
    paymentObligation.amountPaid += event.amount;
    if (paymentObligation.amountPaid + 0.005 >= paymentObligation.amountDue) {
      paymentObligation.status = "met";
    }
    matchedClauseId = paymentObligation.clauseId;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- --test-name-pattern "generic executor"`
Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/executor.ts tests/generic-executor-balances.test.ts
git commit -m "fix(executor): reconcile payment events against payment obligations"
```

---

### Task 3: Resolve conditional anchors against scenario events

**Files:**
- Modify: `src/core/executor.ts` (`resolveDueDate` and `executeGenericContract` event loop)
- Create: `tests/generic-executor-conditional-anchor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/generic-executor-conditional-anchor.test.ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { executeContract } from "../src/core/executor.js";
import type { ContractIR } from "../src/types/ir.js";
import type { Scenario } from "../src/types/scenario.js";

const ir: ContractIR = {
  contractId: "non-compete-fixture",
  title: "Non-compete fixture",
  currency: "USD",
  jurisdiction: "NY",
  parties: [{ id: "party-employee", name: "E", role: "employee" }],
  definitions: [],
  clauses: [
    {
      id: "clause.non_compete",
      title: "Non-compete",
      sourceText: "Employee shall not compete for 1 year after termination.",
      modeled: true,
      semanticTag: "non_compete_restriction",
      effect: {
        kind: "obligation",
        actor: "party-employee",
        action: "not compete",
        due: { anchor: "termination_date", direction: "after", type: "years", value: 1 },
      },
    },
  ],
  metadata: { clauseCount: 1, modeledClauseCount: 1, sourceFile: "fixture" },
};

const scenario: Scenario = {
  scenarioId: "scn-nc",
  archetype: "baseline",
  label: "Termination then compliant year",
  summary: "Employee complies with non-compete for the full year.",
  assumptions: [],
  initialState: { contractStart: "2005-05-31" },
  events: [
    { id: "ev-term", date: "2006-07-24", type: "notice", amount: 0, metadata: { actor: "party-employer", anchor: "termination_date" } },
    { id: "ev-check", date: "2007-07-24", type: "due_check", amount: 0, metadata: { actor: "party-employee", clauseId: "clause.non_compete" } },
  ],
};

test("conditional anchors resolve against scenario events, not contract start", () => {
  const result = executeContract(ir, scenario);
  const obl = result.obligations.find((o) => o.clauseId === "clause.non_compete");
  assert.ok(obl);
  assert.equal(obl.dueDate, "2007-07-24", "1 year after termination event, not 2006-05-31");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --test-name-pattern "conditional anchors"`
Expected: FAIL — due date will come back as `2006-05-31` (contract start + 1y).

- [ ] **Step 3: Extend `resolveDueDate` and the event loop**

In `src/core/executor.ts`, change `resolveDueDate` to accept an anchor-resolution map and only fall back to `contractStart` when no anchor is supplied:

```ts
function resolveDueDate(
  rule: TemporalRule,
  contractStart: string,
  ir?: ContractIR,
  anchorDates?: Map<string, string>,
): string | undefined {
  if (rule.type === "on_date" && typeof rule.value === "string") {
    if (ir && !ISO_DATE.test(rule.value)) {
      const resolved = resolveTermToDate(rule.value, ir);
      if (resolved) return resolved;
    }
    return rule.value;
  }
  const anchorName = typeof rule.anchor === "string" ? rule.anchor : undefined;
  const anchorDate =
    anchorName && anchorDates?.get(anchorName)
      ? anchorDates.get(anchorName)!
      : anchorName && anchorName !== "contractStart" && anchorName !== "contractEnd"
        ? undefined // unresolved named anchor → caller leaves obligation pending
        : contractStart;
  if (!anchorDate) return undefined;
  const days = typeof rule.value === "number" ? rule.value : 0;
  if (rule.type === "business_days") return addBusinessDays(anchorDate, days);
  if (rule.type === "years") return addCalendarDays(anchorDate, days * 365);
  if (rule.type === "months") return addCalendarDays(anchorDate, days * 30);
  return addCalendarDays(anchorDate, days);
}
```

In `executeGenericContract`, build the `anchorDates` map from events that carry a `metadata.anchor` string, resolve due dates in two passes (before-events pass uses known anchors like `contractStart`; after-events pass re-resolves any that were pending), and only push an obligation tracker once its due date is known:

```ts
const anchorDates = new Map<string, string>();
anchorDates.set("contractStart", contractStart);
for (const event of events) {
  const anchor = typeof event.metadata?.anchor === "string" ? event.metadata.anchor : undefined;
  if (anchor && !anchorDates.has(anchor)) anchorDates.set(anchor, event.date);
}

// then when looping obligations:
const dueDate = resolveDueDate(dueRule, contractStart, ir, anchorDates);
if (!dueDate) {
  obligations.push({
    id: `obl-generic-${index + 1}`,
    clauseId: clause.id,
    dueDate: `pending:${(dueRule as TemporalRule & { anchor?: string }).anchor ?? "unknown"}`,
    amountDue: 0,
    amountPaid: 0,
    status: "open",
  });
  continue;
}
```

In the "promote open → missed" loop near the end, `dueDate.startsWith("pending:")` rows stay `open` and get mapped to `pending` in the final status.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --test-name-pattern "conditional anchors"`
Expected: PASS.

- [ ] **Step 5: Regression test**

Run: `pnpm test`
Expected: all tests pass. Expect fixture-pinned tests that assert old Sequa-style `dueDate: "2005-06-01"` for non-compete to fail — those assertions were codifying the bug; update to the new correct date and regenerate affected fixtures under `tests/fixtures/` by deliberate review (not blanket `-u`).

- [ ] **Step 6: Commit**

```bash
git add src/core/executor.ts tests/generic-executor-conditional-anchor.test.ts tests/fixtures/
git commit -m "fix(executor): resolve conditional anchors against events"
```

---

### Task 4: End-to-end smoke — Sequa baseline is now truthful

**Files:**
- Modify: `tests/generic-executor.test.ts` (append)

- [ ] **Step 1: Add a smoke test that loads the committed Sequa artifacts and asserts the new invariants**

```ts
import { readFileSync } from "node:fs";
test("Sequa baseline execution produces non-zero totals and correct non-compete due date", () => {
  const ir = JSON.parse(readFileSync("out/sequa-employment-agreement-2005/ir.json", "utf8"));
  const scenario = JSON.parse(
    readFileSync("out/sequa-employment-agreement-2005/scenarios/baseline.json", "utf8"),
  );
  const result = executeContract(ir, scenario);
  assert.ok(result.summary.totalPaid > 0, "payroll + severance events should register");
  const nonCompete = result.obligations.find((o) => o.clauseId?.includes("non_compete"));
  assert.ok(nonCompete);
  assert.notEqual(nonCompete!.dueDate, "2005-06-01");
});
```

- [ ] **Step 2: Run test**

Run: `pnpm test -- --test-name-pattern "Sequa baseline"`
Expected: PASS.

- [ ] **Step 3: Regenerate committed `out/` artifacts for contracts whose executions changed**

Run: `pnpm run run --contract contracts/Sequa-employment-agreement-2005.md --out out/sequa-employment-agreement-2005`
Expected: `executions/baseline.json` now shows non-zero `balanceAfter`, obligation `dueDate` for non-compete at `termination + 1y`, and `summary.totalPaid > 0`.

- [ ] **Step 4: Run expectations checker**

Run: `pnpm check:expectations`
Expected: critical / supporting scores unchanged or improved. The checker doesn't grade ledger math directly, so this is a pure no-regression check.

- [ ] **Step 5: Commit**

```bash
git add tests/generic-executor.test.ts out/
git commit -m "chore(executor): refresh committed fixtures under new balance math"
```

---

## Self-review notes

- Task 1 + 2 can be run in either order; Task 3 is independent of both but reuses the `obligations` array built in 1/2.
- `executeLeaseContract` and `executeCreditCardContract` already manage their own balances — verify by grepping `balanceAfter` in `executor.ts` that no call to them is touched.
- The `event.metadata.anchor` convention in Task 3 is new. If the scenario generator doesn't emit it, add a one-line note to `src/pipeline/generate-scenario.ts` documenting the expected shape — but do not change the prompt in this plan. Scenarios already hand-label termination events via `clauseId: "clause.6d.without_cause_notice"`; as a fallback, Task 3's anchor map can also accept `metadata.terminates === true` or inspect `clauseId` patterns. Keep the fallback path narrow.
