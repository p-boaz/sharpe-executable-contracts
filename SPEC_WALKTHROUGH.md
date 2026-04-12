# Spec Walkthrough — Sharpe Hackathon Executable Contracts

Section-by-section walkthrough of the hackathon brief at
<https://github.com/hdubugras/sharpe-hackathon> with notes on what this
repo currently does for each section.

This is a conversational companion to `PLAN/SPEC_AUDIT.md`. The audit
is a dry checklist; this doc is the narrative version, written so a
judge or a new engineer can pick up the repo and see how each piece of
the brief maps to concrete files.

Last updated: 2026-04-12.

---

## 1. Overview

**What the brief asks for:** a pipeline that turns real Markdown
contracts into an executable representation that actually *runs*
(evaluates interest, deadlines, breach conditions) and deterministically
compiles back to English. Judges explicitly penalize "a pretty parse
tree that never evaluates."

**What we've shipped:**

- Executable IR lives in `src/types/ir.ts` with clauses typed as
  `obligation | formula | fee | default` (plus `definition`).
- Real runner in `src/core/executor.ts` — APR-driven balances, minimum
  payments, late + over-limit fees, breach flags, stateful month-
  stepping for credit-card; modeled monthly-rent execution for lease.
- Deterministic decompiler in `src/core/decompiler.ts` (~84 lines, zero
  LLM imports).
- Round-trip demonstrated via `pnpm run run`, which writes a
  per-contract bundle under `out/<contractId>/`: `contract.md` (copy
  of the source), `ir.json`, `english.txt`, `scenarios/<archetype>.json`
  and `executions/<archetype>.json` (one pair per archetype, see
  §2.6), and a `meta.json` with extraction + scenario stage metadata
  and artifact hashes. A separate `pnpm run determinism` command runs
  the pipeline twice and hashes outputs; under `--use-llm` it narrows
  the determinism assertion to `english.txt` only, matching the
  brief's requirement that the executable-to-English leg stay
  LLM-free.
- Honest-limits posture is baked in: unmodeled clauses carry
  `modeled: false` and the decompiler prefixes them `[UNMODELED]` in
  English.

**Key insight.** The brief's framing is "real computation + honest
limits, not pretend full formalization." That's why the
`modeled: true|false` flag per clause matters more than IR breadth —
it converts partial coverage from a weakness into an explicit contract
surfaced to judges.

---

## 2. Part 1 — Contract → code

The brief breaks Part 1 into several sub-asks. Addressing each:

### 2.1 "Input is Markdown"

- `contracts/` holds all 5 bundled spec samples plus two extras
  (OneAmerica MBSC service agreement, Sequa employment agreement).
- `runPipeline` (`src/pipeline/run-pipeline.ts`, 50 lines) reads `.md`
  directly; no preprocessing, no heading normalization step.
- CLI: `pnpm run run --contract <id>` picks a contract by slug and
  writes artifacts under `out/<contractId>/`.

### 2.2 "Parse clauses and pull out obligations, conditions, deadlines, penalties"

Extraction has two paths, selected by `--use-llm` / `--no-llm`
(default-on when `OPENAI_API_KEY` is set, closed by T16):

- **LLM path** (`extract-ir.ts:925`). Prompts an OpenAI model to emit
  JSON conforming to `ContractIR`. Normalizers (`normalizeClause`,
  `normalizeExpr`, `normalizeBoolExpr`, `normalizeTemporalRule`)
  coerce the model's output into the typed IR shape; unknown fields
  are dropped, malformed clauses become `modeled: false` stubs rather
  than being trusted. This is the generality path for held-out
  Markdown.
- **Heuristic fallback** (`heuristicFallbackIr`, `extract-ir.ts:477`).
  Regex-driven extraction specialized for credit-card and lease
  families, plus `addGenericUnmodeledClauses` which walks headings
  and emits `modeled: false` placeholders for anything it doesn't
  recognize. When a judge runs with `--no-llm`, a stderr banner
  names the two covered families so degradation is visible.

Clauses carry deterministic source spans (T6) so the IR links back to
the original Markdown offsets.

### 2.3 "Put those into a machine-executable format"

IR shape (`src/types/ir.ts`):

- `ContractIR { contractId, title, parties, definitions, clauses[], metadata }`.
- Clause union: `obligation | formula | fee | default` (+ `definition`).
- `obligation` carries `actor`, `action`, `due: TemporalRule`,
  optional `condition: BoolExpr`, optional `curePeriod`.
- `formula` carries an `Expr` tree over `const | var | add | sub | mul | div | max | min`.
- `fee` is typed: `late_payment | over_limit | returned_payment | foreign_txn`,
  with `fixed` or `percent` amount.
- Metadata includes `extractionHash` (deterministic over input text,
  replacing the old fake `1970-01-01` timestamp — T4) and
  `extraction.mode` so the artifact itself records whether the IR
  came from the LLM or the heuristic fallback.

### 2.4 "Run the logic"

`src/core/executor.ts` (~579 lines) is the runner. It does real
numeric computation, not schema validation:

- Credit card: month-by-month stepping — accrues interest from APR,
  applies payments, fires late-fee and over-limit-fee clauses when
  their triggers hit, tracks balance forward, emits a ledger entry
  per event and a breach list.
- Lease: monthly rent stepping — compares rent-due obligations
  against payment events, marks obligations `met | breached`,
  carries unpaid balance forward.
- Expression evaluation is factored into `src/core/eval-expr.ts`
  and `src/core/eval-bool.ts`, both unit-tested.

This satisfies the brief's "scenario-based evaluation", "stateful
simulation", "event-driven stepping", and "formula and constraint
evaluation" patterns. Business-days / grace-periods are *not*
modeled yet — `curePeriod` exists in the type but the executor
doesn't consume it. That's an honest gap, not a hidden one.

### 2.5 "Execution data (facts and scenarios)"

- `scenario.json` is an explicit artifact on disk. It has an
  `initialState`, an `events[]` timeline, and carries `archetype`
  + `label` + `assumptions[]` so judges can see *what* was
  assumed and *why*.
- `execution.json` mirrors every scenario event in a ledger plus
  obligation status + breach list. "What you passed in" and "what
  came out" are visually parallel.

### 2.6 "LLM to generate sample data" (required)

- `src/pipeline/generate-scenario.ts` has a `--use-llm` path
  (`generateScenario`) that prompts an OpenAI model for a timeline
  conforming to the `Scenario` type, tied to the IR it just
  extracted.
- **Archetype layer** (T17a, `src/pipeline/archetypes.ts`): per
  family, generation loops named archetypes — credit-card gets
  `on-time`, `late-payment`, `over-limit`; lease gets `on-time`,
  `partial-payment`; everything else gets `baseline`. The LLM
  prompt appends "generate a scenario that exercises
  ${archetype.intent}".
- **Post-condition validators** (T17c,
  `src/pipeline/archetype-check.ts`): after the executor runs on
  a candidate scenario, `validateArchetype` checks AND-form
  conditions — e.g. `credit-card/late-payment` requires *both* a
  payment dated past due *and* a `late-fee` ledger entry whose
  `clauseId` maps to a modeled fee clause in the IR. Shape-only
  passes are rejected. If the LLM candidate fails validation,
  the system falls back to the deterministic fixture and records
  the failure reason in `scenario.validationNote` — honest over
  silent.
- Per-contract output: `out/<contractId>/scenarios/<archetype>.json`
  and `out/<contractId>/executions/<archetype>.json` (T17b storage
  rework). One contract, many archetypes, join key is the
  filename.

### 2.7 Gaps vs Part 1

- Business-days / grace-periods / cure-periods are typed but not
  executed.
- Cross-reference resolution ("as defined in Section 3.2") is not
  implemented; definitions exist in the IR but the executor doesn't
  use them to resolve terms.
- Heuristic fallback only deeply covers credit-card + lease. For
  other families on `--no-llm`, extraction degrades to headings +
  unmodeled placeholders (which is honest, but thin).

**Key insight.** The repo treats scenario generation as a
*validated* step, not a *trusted* one. The AND-form validator is
what lets the archetype layer mean something — without it, a
"late-payment" scenario that never actually pays late would pass.
This turns the LLM scenario step into something with an observable
pass/fail signal, which is the only way the generality claim
survives held-out contracts.

---

## 3. Example contracts

The brief ships 5 sample contracts and expects the pipeline to
generalize beyond them to a held-out evaluation set.

### 3.1 What's in `contracts/`

All 5 spec samples are present, plus 2 extras:

| File | Type | Depth of our modeling |
| --- | --- | --- |
| `WesTex-VISA-credit-card-agreement.md` | Credit card | Full — APR, min payment, late + over-limit fees, default |
| `Galleria-Atlanta-office-lease-American-Safety-Insurance-2006.md` | Office lease | Modeled monthly rent + obligation met/breached; rest unmodeled |
| `ORBCOMM-Orbital-amendment-1-AIS-payload-procurement-2006.md` | Procurement | LLM-only; heuristic fallback gives headings + unmodeled placeholders |
| `Masterworks084-IndieBrokers-Regulation-A-engagement-letter.md` | Engagement letter | Same — LLM-only full path |
| `A-Plus-Xodtec-securities-exchange-agreement-2009.md` | Securities exchange | Same — LLM-only full path |
| `OneAmerica-MBSC-service-agreement-2015.md` | Service agreement (extra) | Same — LLM-only full path |
| `Sequa-employment-agreement-2005.md` | Employment (extra) | Same — LLM-only full path |

### 3.2 End-to-end exercise status

- **Credit card + lease:** fully exercised end-to-end on the
  deterministic heuristic path. `pnpm demo` runs the credit-card
  contract into `out/demo/`; the lease is driven via
  `pnpm run run --contract contracts/Galleria-Atlanta-office-lease-American-Safety-Insurance-2006.md`
  (or any other contract path). Either run produces
  modeled-and-unmodeled IR mixes, typed scenarios per archetype,
  real execution with ledger entries + breaches, and deterministic
  English. The bundled `out/<contractId>/` artifacts for these two
  families are what the web dossier renders.
- **Other 5 samples:** LLM path has been used to extract IRs from
  each of them historically (see `out/_llm_sweep/`), but the
  heuristic path degrades to headings + unmodeled placeholders.
  A judge without an API key will see that degradation; the
  stderr banner under `--no-llm` names credit-card and lease as
  the only deeply covered families so this is visible at run time
  rather than hidden.

### 3.3 Generality posture

The brief is explicit that judges run every submission on the same
held-out set of Markdown contracts. Our posture is:

1. LLM extractor (`extract-ir.ts:925`) is the generality path. It
   emits the same typed IR shape regardless of contract family, and
   normalizers downgrade malformed clauses to `modeled: false`
   instead of crashing.
2. Archetype layer falls back to `[baseline]` for unknown families,
   so execution still runs even if we can't name the family.
3. Decompiler is family-agnostic — it walks the typed clause union,
   not family-specific templates — so English is produced even on
   contracts we've never seen.
4. What we *don't* claim: that the heuristic fallback generalizes.
   It is credit-card + lease only, and the CLI says so out loud.

**Key insight.** The held-out generality claim is really a claim
about the *LLM extractor + normalizers + typed IR shape* together.
The heuristic fallback exists so the repo demos without network
access, not because it's the generality story. Conflating those
would be the dishonest version of this pitch — the SPEC_AUDIT
explicitly calls this out as the weakest axis, and the stderr
banner is how we keep that honest at judging time.

