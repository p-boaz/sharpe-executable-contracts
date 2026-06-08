# Grace & Cure Period Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the `TemporalRule.graceAfter` and `effect.curePeriod` fields that the IR schema already defines but the generic executor currently ignores. Closes POSTMORTEM §10.4 item 4.

**Architecture:** All work in `src/core/executor.ts` (`resolveDueDate`, the open→missed promotion loop, and the event loop) plus a new `"cured"` status in `src/types/execution.ts`. No prompt, extractor, scenario-generator, or expectations-YAML changes. Scoped to `executeGenericContract` — lease and credit-card paths don't currently honor grace/cure either, and bringing them along is out of scope.

**Tech Stack:** TypeScript, Node `--test` runner via tsx.

**Dependency note:** This plan overlaps *slightly* with the Generic-Executor-Correctness plan (Task 3 there extends `resolveDueDate` to accept an anchor map). Land this plan AFTER executor Task 3, or merge them carefully — the `resolveDueDate` signature change is coordinated in both. If this plan lands first, executor Task 3 rebases onto it; if executor Task 3 lands first, this plan adds the `graceAfter` path on top of the new signature. Either order works; just avoid concurrent editing of `resolveDueDate`.

---

## What the schema already supports (and the executor ignores)

- `TemporalRule.graceAfter?: TemporalRule` — e.g. `{ type: "months", value: 14, graceAfter: { type: "calendar_days", value: 60 } }` encodes "14 months with 60-day grace."
- `effect.curePeriod?: TemporalRule` on obligation clauses — "N days to cure after breach notice."

Neither field is read anywhere in `src/core/executor.ts`. `resolveDueDate` returns only the hard due date, and the open→missed promotion at `executor.ts:~536` fires the moment `dueDate` passes.

## File Structure

- Modify: `src/types/execution.ts` — add `"cured"` to obligation status union.
- Modify: `src/core/executor.ts` — grace-aware breach window and cure reconciliation.
- Create: `tests/generic-executor-grace.test.ts`.
- Create: `tests/generic-executor-cure.test.ts`.

---

### Task 1: Honor `graceAfter` before firing breaches

**Files:**
- Modify: `src/core/executor.ts` (`resolveDueDate` at ~L373, open→missed loop at ~L536)
- Create: `tests/generic-executor-grace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/generic-executor-grace.test.ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { executeContract } from "../src/core/executor.js";
import type { ContractIR } from "../src/types/ir.js";
import type { Scenario } from "../src/types/scenario.js";

function makeIr(): ContractIR {
  return {
    contractId: "grace-fixture",
    title: "Grace fixture",
    currency: "USD",
    jurisdiction: "NY",
    parties: [{ id: "party-tenant", name: "Tenant", role: "tenant" }],
    definitions: [],
    clauses: [
      {
        id: "clause.rent",
        title: "Rent",
        sourceText: "Tenant shall pay rent by the 1st; 5 days grace.",
        modeled: true,
        semanticTag: "recurring_rent",
        effect: {
          kind: "obligation",
          actor: "party-tenant",
          action: "pay monthly rent",
          due: {
            type: "on_date",
            value: "2026-02-01",
            graceAfter: { type: "calendar_days", value: 5 },
          },
        },
      },
    ],
    metadata: { clauseCount: 1, modeledClauseCount: 1, sourceFile: "fixture" },
  };
}

function makeScenario(eventDate: string): Scenario {
  return {
    scenarioId: "scn-grace",
    archetype: "baseline",
    label: "Grace scenario",
    summary: "Rent paid inside the grace window.",
    assumptions: [],
    initialState: { contractStart: "2026-01-01" },
    events: [
      {
        id: "ev-pay",
        date: eventDate,
        type: "payment",
        amount: 0,
        metadata: { actor: "party-tenant", clauseId: "clause.rent" },
      },
    ],
  };
}

test("payment inside grace window satisfies the obligation without breach", () => {
  const result = executeContract(makeIr(), makeScenario("2026-02-04")); // 3 days late, within 5-day grace
  const obl = result.obligations.find((o) => o.clauseId === "clause.rent");
  assert.equal(obl?.status, "met");
  assert.equal(result.breaches.length, 0);
});

test("payment past grace window misses the obligation", () => {
  const result = executeContract(makeIr(), makeScenario("2026-02-10")); // 9 days late, past 5-day grace
  const obl = result.obligations.find((o) => o.clauseId === "clause.rent");
  assert.equal(obl?.status, "missed");
  assert.equal(result.breaches.length, 1);
  assert.ok(result.breaches[0].description.includes("2026-02-06") ||
            result.breaches[0].date === "2026-02-06",
    "breach should fire at due + graceAfter, not at due");
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `pnpm test`
Expected: both grace tests FAIL — today the obligation misses at `2026-02-01` regardless of grace.

- [ ] **Step 3: Extend `resolveDueDate` to compute the grace-adjusted deadline**

In `src/core/executor.ts`, keep `resolveDueDate` returning the *hard* due date (for display), and add a sibling helper that applies `graceAfter`:

```ts
function applyGrace(dueDate: string, rule: TemporalRule): string {
  if (!rule.graceAfter) return dueDate;
  if (!ISO_DATE.test(dueDate)) return dueDate; // symbolic, leave alone
  const grace = rule.graceAfter;
  const days = typeof grace.value === "number" ? grace.value : 0;
  if (grace.type === "business_days") return addBusinessDays(dueDate, days);
  if (grace.type === "years") return addCalendarDays(dueDate, days * 365);
  if (grace.type === "months") return addCalendarDays(dueDate, days * 30);
  return addCalendarDays(dueDate, days);
}
```

- [ ] **Step 4: Use the grace window in the open→missed promotion**

In `executeGenericContract`, when building the obligation tracker, store both dates. The tracker surface keeps `dueDate` for display; breach promotion uses the effective deadline.

Adjust the obligation record push (around the `stmt-<clauseId>` loop):

```ts
const dueDate = resolveDueDate(dueRule, contractStart, ir);
const effectiveDeadline = applyGrace(dueDate, dueRule);
resolvedDueDates.set(clause.id, dueDate);
resolvedDeadlines.set(clause.id, effectiveDeadline);
```

Add `const resolvedDeadlines = new Map<string, string>();` next to the existing `resolvedDueDates` map.

Then in the open→missed loop:

```ts
for (const tracker of obligations) {
  if (tracker.status !== "open") continue;
  const deadline = resolvedDeadlines.get(tracker.clauseId) ?? tracker.dueDate;
  if (!ISO_DATE.test(deadline)) continue;
  tracker.status = "missed";
  pushBreach(
    breaches,
    `breach-missed-${tracker.clauseId}`,
    deadline,
    "obligation_missed",
    `No scenario event performed obligation ${tracker.clauseId} by ${deadline}`,
    tracker.clauseId,
  );
}
```

In the event-matching loop, when an event satisfies an obligation, the event date must not be past the `effectiveDeadline` for status to flip to `met`:

```ts
if (result.matched) {
  const deadline = resolvedDeadlines.get(clause.id) ?? dueDate;
  if (!ISO_DATE.test(deadline) || event.date <= deadline) {
    tracker.status = "met";
    matchedClauseId = clause.id;
  }
  break;
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm test`
Expected: new grace tests PASS; existing suite stays green.

- [ ] **Step 6: Commit**

```bash
git add src/core/executor.ts tests/generic-executor-grace.test.ts
git commit -m "feat(executor): honor TemporalRule.graceAfter in breach promotion"
```

---

### Task 2: Honor `curePeriod` for reclassifying missed obligations

**Files:**
- Modify: `src/types/execution.ts` — add `"cured"` to the obligation `status` union.
- Modify: `src/core/executor.ts` — post-promotion pass that looks for cure events.
- Create: `tests/generic-executor-cure.test.ts`.

**Cure semantics for this plan:** an obligation whose status would otherwise be `missed` is reclassified to `cured` if a scenario event with `type: "cure"` OR `metadata.cures === clauseId` arrives on or before `breachDate + curePeriod`. Reclassification removes the associated `breach-missed-*` entry from `breaches[]`. Any other cure-notice mechanics (e.g. notice from the non-breaching party) are out of scope.

- [ ] **Step 1: Add `"cured"` to the obligation status type**

In `src/types/execution.ts`, extend the `status` union on the obligation record (wherever it's declared — likely `"open" | "met" | "missed" | "pending"` today). Add `"cured"`.

- [ ] **Step 2: Write the failing test**

```ts
// tests/generic-executor-cure.test.ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { executeContract } from "../src/core/executor.js";
import type { ContractIR } from "../src/types/ir.js";
import type { Scenario } from "../src/types/scenario.js";

function makeIr(): ContractIR {
  return {
    contractId: "cure-fixture",
    title: "Cure fixture",
    currency: "USD",
    jurisdiction: "NY",
    parties: [{ id: "party-service-provider", name: "SP", role: "service_provider" }],
    definitions: [],
    clauses: [
      {
        id: "clause.service_level",
        title: "Service level",
        sourceText: "Provider shall maintain uptime; 30 days to cure breaches.",
        modeled: true,
        semanticTag: "service_level_obligation",
        effect: {
          kind: "obligation",
          actor: "party-service-provider",
          action: "maintain service level",
          due: { type: "on_date", value: "2026-03-01" },
          curePeriod: { type: "calendar_days", value: 30 },
        },
      },
    ],
    metadata: { clauseCount: 1, modeledClauseCount: 1, sourceFile: "fixture" },
  };
}

function makeScenario(cureDate: string | null): Scenario {
  const events: Scenario["events"] = [];
  if (cureDate) {
    events.push({
      id: "ev-cure",
      date: cureDate,
      type: "cure",
      amount: 0,
      metadata: { actor: "party-service-provider", cures: "clause.service_level" },
    });
  }
  return {
    scenarioId: "scn-cure",
    archetype: "baseline",
    label: "Cure scenario",
    summary: "Missed SLO, cure attempt.",
    assumptions: [],
    initialState: { contractStart: "2026-01-01" },
    events,
  };
}

test("cure event inside cure window reclassifies missed to cured and removes breach", () => {
  const result = executeContract(makeIr(), makeScenario("2026-03-20")); // 19 days after due, within 30-day cure
  const obl = result.obligations.find((o) => o.clauseId === "clause.service_level");
  assert.equal(obl?.status, "cured");
  assert.equal(result.breaches.length, 0);
});

test("cure event outside cure window does not reclassify", () => {
  const result = executeContract(makeIr(), makeScenario("2026-04-15")); // 45 days after due, past cure
  const obl = result.obligations.find((o) => o.clauseId === "clause.service_level");
  assert.equal(obl?.status, "missed");
  assert.equal(result.breaches.length, 1);
});

test("no cure event leaves obligation missed", () => {
  const result = executeContract(makeIr(), makeScenario(null));
  const obl = result.obligations.find((o) => o.clauseId === "clause.service_level");
  assert.equal(obl?.status, "missed");
  assert.equal(result.breaches.length, 1);
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run: `pnpm test`
Expected: the two "cured" assertions FAIL.

- [ ] **Step 4: Implement cure reconciliation**

In `executeGenericContract`, after the open→missed promotion loop, add a pass over missed obligations to look for cure events. Place it before the `return { ... }` block (and before the balance-accumulation pass if that lands first — order: events → promotion → cure → balance).

```ts
for (const tracker of obligations) {
  if (tracker.status !== "missed") continue;
  const clause = modeledObligations.find((c) => c.id === tracker.clauseId);
  if (!clause || clause.effect.kind !== "obligation") continue;
  const curePeriod = clause.effect.curePeriod;
  if (!curePeriod) continue;
  const breachDate = tracker.dueDate;
  if (!ISO_DATE.test(breachDate)) continue;
  const cureDeadline = addCureWindow(breachDate, curePeriod);
  const cureEvent = events.find(
    (e) =>
      (e.type === "cure" || e.metadata?.cures === tracker.clauseId) &&
      e.date >= breachDate &&
      e.date <= cureDeadline,
  );
  if (!cureEvent) continue;
  tracker.status = "cured";
  // Remove the corresponding breach
  const idx = breaches.findIndex((b) => b.id === `breach-missed-${tracker.clauseId}`);
  if (idx >= 0) breaches.splice(idx, 1);
  // Add a ledger entry so the cure is visible
  ledger.push(
    asLedger(
      `cure-${tracker.clauseId}`,
      cureEvent.date,
      "notice",
      0,
      0,
      `Obligation ${tracker.clauseId} cured by ${cureEvent.id} within ${curePeriod.value} ${curePeriod.type}`,
      tracker.clauseId,
    ),
  );
}
```

Add a small helper (can live next to `applyGrace`):

```ts
function addCureWindow(from: string, rule: TemporalRule): string {
  const days = typeof rule.value === "number" ? rule.value : 0;
  if (rule.type === "business_days") return addBusinessDays(from, days);
  if (rule.type === "years") return addCalendarDays(from, days * 365);
  if (rule.type === "months") return addCalendarDays(from, days * 30);
  return addCalendarDays(from, days);
}
```

(If Task 1's `applyGrace` and this `addCureWindow` end up structurally identical, consolidate into one `addDuration(from, rule)` helper and use it in both places.)

- [ ] **Step 5: Run tests**

Run: `pnpm test`
Expected: all three cure tests PASS; grace tests still green; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/types/execution.ts src/core/executor.ts tests/generic-executor-cure.test.ts
git commit -m "feat(executor): reclassify missed obligations as cured within curePeriod"
```

---

### Task 3: Smoke & fixture regeneration

**Files:**
- Modify: `out/*/executions/*.json` for any contracts whose IR contains `graceAfter` or `curePeriod`.

- [ ] **Step 1: Find contracts whose IR already emits grace/cure**

Run:
```bash
grep -l 'graceAfter\|curePeriod' /Users/boaz/Projects/sharpe-postmortem-recovery/out/*/ir.json
```
Note the list. If empty, no regen needed — skip to Step 3.

- [ ] **Step 2: Regenerate each affected contract**

For each slug:
```bash
pnpm -C /Users/boaz/Projects/sharpe-postmortem-recovery run run --contract contracts/<Name>.md --out out/<slug>
```
Review the `executions/baseline.json` diff: any obligation that was previously `missed` on the day-of-due but whose IR carries `graceAfter` should now flip to `met` or stay `missed` at `due + graceAfter`; any `cured` status should appear where a cure event is present.

- [ ] **Step 3: Run expectations checker**

Run: `pnpm -C /Users/boaz/Projects/sharpe-postmortem-recovery check:expectations`
Expected: no regression in critical / supporting scores. The checker doesn't grade grace/cure semantics directly.

- [ ] **Step 4: Commit**

```bash
git add out/
git commit -m "chore(executor): refresh fixtures under grace/cure execution"
```

---

## Self-review notes

- Task 1 and Task 2 can be merged into one commit if both helpers are small — but keeping them separate preserves bisect-ability if one semantics change surfaces a regression.
- `event.type === "cure"` is a new event type the scenario generator doesn't currently emit. This plan does NOT change the scenario prompt to produce cure events — test coverage relies on hand-constructed scenarios. If you want the LLM to generate cure scenarios, add a follow-up plan; don't mix that into this one.
- The cure pass deliberately removes the breach entry rather than marking it as `cured: true`. If any downstream consumer (UI, audit) needs the historical "we breached, then cured" view, swap to soft-delete: add `Breach["type"] = "obligation_cured"` and transform the row in place. Out of scope here unless the implementer finds a real consumer that needs it.
- Symbolic/non-ISO due dates are explicitly bypassed for both grace and cure — the engine already treats those as `pending` and we don't want to invent timelines for unresolved anchors. Once executor Task 3 (conditional-anchor resolution) lands, more clauses will have resolved ISO dates and this code will automatically cover them.
