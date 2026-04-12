# TODOs — Sharpe Executable Contracts

This backlog is ordered against the canonical target in [END_STATE.md](./END_STATE.md).

Priority rule:

- first, make the pipeline honestly executable
- second, make it robust on unseen Markdown
- third, make it easy for judges to verify

## Status convention

Each TODO heading carries one of these tags:

- `[ ]` — not started
- `[~]` — in progress
- `[x]` — done
- `[deferred]` — intentionally pushed out

When closing a TODO, append an **Outcome:** line under its `Done when:` block, naming what shipped and a commit SHA or key file path. Nothing else — git log holds the rest.

---

## P0 — Make the current pipeline honest and end-to-end credible

These are the highest-priority tasks because they directly determine whether the repo meets the hackathon ask.

### [x] T1 — Honest partial extraction instead of hardcoded full modeling

**Goal:** The extractor should produce a sparse, truthful IR from contract Markdown instead of pretending the entire selected shape is modeled.

**Why this matters:** The brief favors real computation plus honest limits. Right now the fallback path is still effectively a hardcoded credit-card profile.

**Done when:**

- the fallback extractor derives clauses from the input text instead of emitting the same clause set for every contract
- unsupported or partially supported clauses are emitted as `modeled: false` placeholders instead of being silently ignored
- modeled coverage in the decompiler reflects reality
- the IR remains small, inspectable, and deterministic

**Outcome:** Shipped IR-responsive fallback extraction with explicit unmodeled placeholders and broader heading-based degradation in `src/pipeline/extract-ir.ts`.

### [x] T2 — Make scenario generation responsive to the IR

**Goal:** Generate scenario data that matches the extracted contract shape instead of always producing the same credit-card scenario.

**Why this matters:** The hackathon explicitly requires an LLM scenario-generation step for unseen contracts. The current fallback is useful for a demo, but it is not a credible end state.

**Done when:**

- the scenario generator chooses events and initial state based on the IR
- the LLM path is clearly documented as the generality path for held-out contracts
- the fallback path stays deterministic but is visibly tied to the IR, not to one contract file
- `scenario.json` makes the chosen assumptions explicit

**Outcome:** Scenario generation now derives fallback family/events from IR modeled clauses and writes explicit IR-linked assumptions/state in `src/pipeline/generate-scenario.ts`, with held-out LLM-path guidance in `README.md`.

### [x] T3 — Fix determinism to test repeated runs, not repeated stringification

**Goal:** Make `determinism` prove something real about the executable-to-English path.

**Why this matters:** The brief explicitly asks judges to be able to re-run and diff the deterministic English output.

**Done when:**

- `determinism` runs the relevant pipeline stages twice
- the command compares two independently produced English outputs
- any normalization rules are explicit
- the result artifact makes clear what was compared

**Outcome:** `determinism` now runs the full pipeline twice and compares IR/scenario/execution/English with explicit hashes in `src/main.ts`.

### [x] T4 — Replace fake extraction metadata with deterministic, meaningful metadata

**Goal:** Remove the fake `1970-01-01` extraction timestamp and replace it with stable metadata derived from the input.

**Why this matters:** Visible honesty matters for both inspectability and credibility.

**Done when:**

- IR metadata contains a deterministic, meaningful field such as `extractionHash`
- the old fake timestamp is removed everywhere
- README and any output examples stay in sync

**Outcome:** Replaced fake timestamps with deterministic `extractionHash` metadata in `src/types/ir.ts`, `src/pipeline/extract-ir.ts`, and `README.md`.

### [x] T16 — Default LLM on when key is set + honest fallback banner

**Goal:** Close SPEC_AUDIT gaps #2 and #5: the spec treats LLM scenario generation as required, and the heuristic fallback is known to only cover credit-card + lease shapes. Both needed to be visible at the CLI.

**Done when:**

- `--use-llm` turns on automatically when `OPENAI_API_KEY` is present; `--no-llm` forces fallback; `--use-llm` still works as an explicit override.
- `LLM mode:` line in the `run`/`determinism` stdout block states the chosen mode *and* the reason.
- When running in fallback mode, the CLI prints a one-paragraph banner to stderr naming the known-degraded families so judges are not left to notice it in the artifacts.

**Outcome:** `parseArgs` / `runCommand` / `runDeterminismCommand` in `src/main.ts` implement the default-on behavior, the `--no-llm` force-off flag, the reasoned `LLM mode:` line, and the stderr heuristic-fallback banner. README quickstart step 2 and the Notes section document the new default.

### [~] T23 — Path B: effect-based IR restructure for held-out generality

**Goal:** Restructure the clause-kind union in `src/types/ir.ts` into a composable `Effect` + `semanticTag` + universal `condition` shape, so the IR honestly expresses all 7 bundled contract families instead of being credit-card-shaped. Unblocks Executability (25%) and Generality (15%) on held-out contracts.

**Why this matters:** The hand-authored expectation files under `expectations/` show the current IR only fits the credit-card contract cleanly. On the other six, `FeeClause.feeType`'s closed enum force-fits or corrupts compensation/damages/incentives clauses, and `FormulaClause` has no way to carry the triggers that make non-credit-card clauses conditional. The refactor replaces the closed clause-kind union with:

- `Clause` carrying `semanticTag: string` (open), `condition?: BoolExpr` (universal), and one `effect: Effect` field.
- `Effect` union: `payment | obligation | formula | accumulation | indemnification | default | unmodeled`.
- `payment` carries `assetKind?: string` so non-cash transfers (shares, commodities) stop straining the primitive.
- `TemporalRule` gains `direction?: "before" | "after"` (default `"after"`) and `months | years` to the unit list, plus `graceAfter?: TemporalRule` for compound durations ("14 months + 60 days grace").
- `ContractIR.currency: string` replaces the literal `"USD"` type.

**Shape of the change:**

Land as a single branch / one substantial commit. 11-step implementation order:

1. New `src/types/ir.ts` — the ground truth.
2. Heuristic extractor + normalizers (`src/pipeline/extract-ir.ts`) — credit-card + lease paths rewritten against new shape, get it compiling.
3. Decompiler (`src/core/decompiler.ts`) — dispatch on `effect.kind`.
4. Executor (`src/core/executor.ts`) — credit-card + lease paths rekeyed on `semanticTag` + `effect.kind`.
5. Archetype validators (`src/pipeline/archetype-check.ts`) — rekey on `semanticTag` instead of `feeType`.
6. Scenario generator (`src/pipeline/generate-scenario.ts`) + LLM prompts.
7. Tests (`tests/`, `src/core/*.test.ts`) — greened.
8. Web dossier (`web/app/Dossier.tsx`) — reads `effect.kind`.
9. Update 3 existing expectation files (WesTex, Masterworks, ORBCOMM) to new shape.
10. Already-written expectation files for remaining 4 contracts stand (lease, securities, service, employment were written directly in Path B shape).
11. Checker (`scripts/check-expectations.ts`, new) — reads expectation YAML, compares against extracted IR, reports per-contract pass/fail on critical + supporting targets.

**Scope guard:**

- LLM path stays last to stabilize — heuristic path must be fully green before touching prompts.
- No new effect kinds beyond the 7 proposed. `modeled: false` stubs stay the answer for milestone schedules, force-majeure modifiers, amendment layering, stepped-schedule aggregators, recurring-payment aggregators, present-value computations.
- No Tier 3 scope creep (amendment-over-base, cross-clause modifiers).
- The web dossier update is last because UI reads shape the executor emits — keep tests and executor green before touching UI.

**Done when:**

- All 7 contracts in `contracts/` run through `pnpm run run --no-llm` (where heuristic coverage exists) and `--use-llm` (where LLM path is used) without crashing, emitting IRs that validate against their expectation files' `critical` targets.
- `pnpm test` green. `pnpm run determinism` still reports IR / scenario / execution / English stable on heuristic credit-card + lease runs.
- `pnpm build` + `pnpm typecheck` green in `web/`.
- `scripts/check-expectations.ts` runs end-to-end on all 7 expectation files and reports per-contract scores.
- `expectations/*.yaml` all use the new shape consistently.
- README's 9-step demo still works verbatim.

**Outcome (partial, steps 1–10 of 11):** `src/types/ir.ts` rewritten around `semanticTag: string` + `condition?: BoolExpr` + `effect: Effect` union (`payment | obligation | formula | accumulation | indemnification | default | unmodeled`). `TemporalRule` gained `direction?: "before" | "after"` + `months | years` + `graceAfter`. `currency` is now `string`. Heuristic extractor + normalizers rewritten (`extract-ir.ts`), decompiler dispatches on `effect.kind` (`decompiler.ts`), executor rekeyed on `semanticTag` (`executor.ts`), archetype validators rekeyed on `late_payment_fee` / `over_limit_fee` (`archetype-check.ts`), scenario generator updated, web dossier updated to render new shape. All 7 expectation YAMLs use the new shape. Heuristic `pnpm run run` green on credit card (3 archetypes) + lease (2). LLM demo green on WesTex. Determinism: IR / scenario / execution / English all stable under `--no-llm`. 18/21 tests pass; the 3 failing tests are pre-existing T22 matcher-stub failures unrelated to Path B. Web `pnpm build` + `pnpm typecheck` green.

**Remaining (step 11):** Write `scripts/check-expectations.ts` — the YAML-to-IR validator that consumes `expectations/*.yaml` and reports per-contract pass/fail on `coverageTargets.critical` + `supporting`. Deferred as its own task; the 10 landed steps stand on their own.

**Explicit non-goals:**

- Fixing the LLM fee-classification bug (T21 scope — keep it separate; Path B just removes the forcing function that causes it by opening the tag vocabulary).
- Held-out sweep (T20 scope — after Path B lands, the sweep becomes meaningful; before, it would mostly report the same degradation modes we already know).
- Generic obligation executor (T22 — complementary, not blocked by Path B).

---

## P1 — Prove the system generalizes beyond one contract

These tasks support the hackathon's generality requirement once P0 is in place.

### [x] T5 — Add a second contract path and make it degrade honestly

**Goal:** Show that the repo is not just a WesTex demo.

**Why this matters:** Judges run submissions on held-out Markdown contracts. We need evidence that this code generalizes beyond one contract family.

**Done when:**

- one additional sample contract is exercised end to end
- the extractor produces a mix of modeled and unmodeled clauses honestly
- the scenario generator emits a plausible scenario for that contract family
- execution still produces readable, inspectable artifacts

**Suggested target:** the bundled office lease sample is a better proof of generality than adding another credit-card sample.

**Outcome:** Added a lease-family path on the Galleria sample with modeled monthly-rent execution plus explicit unmodeled default context in `src/pipeline/extract-ir.ts`, `src/pipeline/generate-scenario.ts`, and `src/core/executor.ts`.

### [x] T6 — Add optional clause traceability from source -> IR -> English

**Goal:** Preserve source spans so the demo can show where executable clauses came from.

**Why this matters:** The brief marks traceability as optional, but it is a strong judging and demo aid.

**Done when:**

- extracted clauses can carry source offsets
- the offsets are available in the IR artifact
- regenerated English can be linked back to the original source clause when useful

**Outcome:** Added deterministic `sourceSpan` offsets per clause in `src/pipeline/extract-ir.ts`/`src/types/ir.ts` and surfaced source markers in regenerated English in `src/core/decompiler.ts`.

**Scope note:** This is valuable, but it is secondary to executability, scenario generation, and determinism.

### [x] T13 — Gate `--use-llm` against the new determinism checks

**Goal:** Make the LLM-assisted path honest about what it can and cannot promise under the stricter determinism command.

**Why this matters:** `determinism` now compares IR, scenario, execution, and English across two independent pipeline runs (commit 77ebb7b, `src/main.ts`). The LLM extraction and scenario paths are not guaranteed byte-stable, so `irStable` / `scenarioStable` will likely flip to `false` when `--use-llm` is on. Without guidance, a judge running the documented flow against an unseen contract will see red flags that do not mean what they appear to mean.

**Done when:**

- behavior of `determinism --use-llm` is either (a) documented as expected-unstable for IR/scenario with a clear explanation, or (b) gated so only the executable-to-English leg is compared in that mode
- README's judge-demo flow reflects the choice
- no silent regression: if IR/scenario are not stable, the artifact says so and why

**Outcome:** `runDeterminismCommand` now sets `irStable`/`scenarioStable` to `null` and narrows `comparedArtifacts` to `["execution","english"]` when LLM mode is on, with an explanatory `notes` field in `determinism.json` (`src/main.ts`). README step 6 documents the two-mode behavior.

### [x] T14 — Verify `web/` dossier renders a lease run end-to-end

**Goal:** Confirm the Next.js viewer still works against the new scenario shape and the lease family.

**Why this matters:** 77ebb7b loosened `Scenario.initialState` to `Record<string, string | number | boolean>` and added a lease execution path. `web/app/lib/types.ts` already types it as `Record<string, unknown>`, so the app should not crash — but this is the first non-credit-card family to hit the UI, and the Dossier cross-linking was written against modeled-only clauses.

**Done when:**

- a lease `out/<run>/` bundle loads in the dossier without runtime errors
- unmodeled clauses render cleanly (no cross-link dangling)
- any breakage found is either fixed or captured as a distinct TODO

**Scope note:** Verification only. Do not roll T12's simplification into this item.

**Outcome:** Generated `out/lease-run/` via `pnpm run run --contract Galleria… --no-llm` (2 modeled + 1 unmodeled clauses, 1 breach, ending balance $30,144.22). Loaded in the dossier at `localhost:3000/?run=lease-run` — top bar, parties, inputs row, scenario card, execution ribbon, ledger, obligations/breaches, and IR drawer all render without runtime errors. Clause kinds `obligation` / `formula` / `default` all display correctly; the one unmodeled clause renders as a normal card. Browser console is clean apart from a favicon 404.

### [x] T17a — Archetype layer + post-condition validators

**Goal:** Introduce named archetypes (on-time / late / over-limit / partial / baseline) as a first-class concept in scenario generation, with post-condition validators that assert a generated scenario actually exercises its declared intent.

**Why this matters:** This is the semantic core of the old T17 — and the prerequisite for T18's research loop. Without archetype validators, "archetype pass rate" is not a meaningful metric: a scenario labeled `late-payment` that never actually pays late is indistinguishable from a scenario that does. Validators make the LLM scenario step independently verifiable instead of opaque.

**Shape of the change:**

- **Archetype layer** (`src/pipeline/archetypes.ts`, new):
  - `archetypesFor(family) -> Archetype[]` returning `{ id, label, intent }` tuples.
  - Credit card: `on-time`, `late-payment`, `over-limit`. Lease: `on-time`, `partial-payment`. Generic: `baseline`.
  - Reuses `contractFamily(ir)` already in `src/pipeline/generate-scenario.ts`.

- **Generator signature change:** `generateScenario({ ir, archetype, useLlm })`; add `generateAllScenarios({ ir, useLlm })` that loops archetypes. The LLM system prompt appends `"Generate a scenario that exercises ${archetype.intent}"`. The existing family-keyed fallback fixtures split into `(family, archetype)` pairs.

- **Archetype validation** (`src/pipeline/archetype-check.ts`, new):
  - `validateArchetype(scenario, archetype, execution) -> { pass: boolean, reason: string }`.
  - Per-archetype post-conditions — see below for the initial set; these need explicit human sign-off before implementation because they define what "exercising the path" means.
  - On failure under `--use-llm`, fall back to the deterministic fixture for that archetype and log the fallback reason.

- **Scenario JSON additions:** `archetype: "late-payment"` (join key) and `label: "Late payment, below minimum"` (UI display).

**Initial post-condition proposals** (human to confirm/adjust before implementation):

- `credit-card / on-time`: every payment event is dated ≤ due date, and no `late-fee` appears in execution ledger.
- `credit-card / late-payment`: at least one payment event is dated > due date, and execution ledger contains a `late-fee` entry.
- `credit-card / over-limit`: at some point during execution, `balance > creditLimit`, and ledger contains an `over-limit-fee` entry.
- `lease / on-time`: every rent payment is dated ≤ due date and full amount.
- `lease / partial-payment`: at least one rent payment is < full amount, and execution shows unpaid balance carried forward.
- `generic / baseline`: execution produces at least one ledger entry and the run does not crash.

**Scope guard:**

- No storage layout changes — keep `out/<run>/` as today. That's T17b.
- No web UI changes — T17b.
- Archetype set stays deterministic per family; unknown-family contracts default to `[baseline]`.

**Done when:**

- `src/pipeline/archetypes.ts` and `src/pipeline/archetype-check.ts` exist and are covered by focused tests in `tests/archetypes.test.ts`.
- `generateAllScenarios({ir, useLlm})` produces one scenario per archetype with the correct `archetype` field.
- LLM-mode validation runs after generation, logs failures, and falls back to the deterministic fixture for failing archetypes.
- Validators are deterministic and do not call an LLM.
- `pnpm demo` and `pnpm test` are green. Both bundled samples (credit-card + lease) produce ≥ 2 archetype-labeled scenarios each.

**Outcome:** Added `src/pipeline/archetypes.ts` with `archetypesFor(family)` + `contractFamily(ir)`. Split `generate-scenario.ts` into archetype-keyed fallbacks (credit-card: on-time / late-payment / over-limit; lease: on-time / partial-payment; generic: baseline) and added inline `validateArchetype` post-condition checks; LLM failures fall back to the deterministic fixture with mode=`llm_validated_fallback` and a recorded `validationNote`. Exported `generateAllScenarios`. Updated `Scenario` type with `archetype` + `label`. Tests updated in `tests/pipeline.test.ts`; all 8 green.

### [x] T17b — Contract-first storage layout + UI rework

**Goal:** Restructure `out/` around the contract (not the run) and rework `web/` so the UI tells the story as `contract → IR+English → pick a scenario → execute`. Depends on T17a.

**Why this matters:** Once multiple scenarios exist per contract (T17a), the current `out/<run>/` layout forces the UI to treat every scenario as a peer even when several share the same contract. A contract-keyed layout surfaces the IR-vs-scenario split directly.

**Shape of the change:**

- **Storage layout** — one folder per contract:
  ```
  out/<contractId>/
    contract.md
    ir.json
    english.txt
    meta.json               # { contractId, title, irHash, scenarioIds[], generatedAt }
    scenarios/<archetype>.json
    executions/<archetype>.json
  ```
  Join key between `scenarios/` and `executions/` is the archetype slug (filename). Check-artifacts like `_llm_sweep/` and `determinism/` move to `out/_checks/` so they do not pollute the contract dropdown.

- **CLI changes (`src/main.ts`):** `--contract <id>` selects a contract; absent `--scenario` generates all archetypes. Per-contract regeneration is gated by `meta.json.irHash` so unchanged contracts skip IR+English rebuild but still refresh scenarios/executions on demand.

- **Web UI (`web/app/`):** three vertical zones replacing the current scenario strip:
  1. Contract dropdown (reads `out/*/meta.json`).
  2. IR + deterministic English panel (unchanged by scenario).
  3. Scenario list filtered to the selected contract, each with an "Execute" affordance that surfaces the matching `executions/<archetype>.json`.
  Keeps the existing clause↔ledger↔english hover link; drops the cross-contract scenario-strip model.

**Scope guard:**

- No new LLM calls on the `IR → English` path.
- No in-browser pipeline execution; UI remains read-only over CLI artifacts.
- Migration of existing `out/run/`, `out/lease-run/` is a one-shot rename or clean `pnpm demo` — do not dual-write.

**Done when:**

- `out/<contractId>/{ir.json, english.txt, meta.json, scenarios/*.json, executions/*.json}` is the canonical layout for both bundled samples.
- Web UI is contract-first: dropdown → IR+English → scenario list scoped to that contract → execute.
- `pnpm demo` and `pnpm test` are green; `determinism` still passes (English stable per contract; scenarios allowed unstable under `--use-llm`, per T13).
- README's 9-step base demo is updated to reflect the new artifact paths.

**Explicit non-goals:** in-browser scenario editing, counterfactual comparison across archetypes, scenario diffing, new contract families beyond credit card / lease / generic.

**Outcome:** `src/main.ts` now writes `out/<contractId>/{contract.md, ir.json, english.txt, meta.json, scenarios/<archetype>.json, executions/<archetype>.json}`; determinism runs land under `out/_checks/determinism/<contractId>/`. `run-pipeline.ts` returns `runs: ScenarioRun[]` across all archetypes plus shared `ir`/`english`/`family`. Web UI rewritten to contract-first in `web/app/page.tsx` and `web/app/Dossier.tsx`: header dropdown picks contract, Step 1 shows contract.md + english.txt side-by-side with IR drawer, Step 2 shows scenario cards filtered to the selected contract (with ending balance + breach badge), Step 3 reveals a Run button that unveils the ledger / obligations / breaches for the selected `executions/<archetype>.json`. Verified end-to-end in Chrome at `localhost:3001` for both bundled samples; `pnpm test` green (8/8), `pnpm build` green in `web/`.

### [x] T17c — Tighten archetype validators to AND-form (event + ledger consequence)

**Goal:** Upgrade `validateArchetype` so each post-condition checks both the event shape in the scenario AND the expected consequence in the execution ledger. Stricter baseline check. Prerequisite for T18's metric to be honest.

**Why this matters:** The T17a validators (`src/pipeline/generate-scenario.ts:302-367`) only check event shape — a scenario labeled `late-payment` passes if it contains a late payment event, regardless of whether the executor actually assessed a `late-fee`. That means the extractor can silently drop the late-fee clause and the metric won't notice. If T18's research loop optimizes against this shape-only metric, an agent can "win" by generating scenarios that hit the right event shape while the extractor regresses on fee modeling.

**Shape of the change:**

- **Signature change**: `validateArchetype(scenario, archetype) -> string | null` becomes `validateArchetype(scenario, archetype, execution) -> string | null`.
- **AND-form post-conditions** (per human confirmation):
  - `credit-card / on-time`: every payment event dated ≤ due date, AND no `late-fee` entry in execution ledger.
  - `credit-card / late-payment`: ≥1 payment dated > due date, AND execution ledger contains a `late-fee` entry.
  - `credit-card / over-limit`: purchases > creditLimit, AND execution ledger contains an `over-limit-fee` entry.
  - `lease / on-time`: every rent payment dated ≤ due date, AND full monthlyRent paid each period.
  - `lease / partial-payment`: ≥1 rent payment < full amount, AND execution shows unpaid balance carried forward (e.g. non-zero `outstandingRent` in ending state or breach flag raised).
  - `generic / baseline`: ≥1 modeled clause fires in execution (`execution.obligationsFired` or equivalent contains at least one entry whose source IR clause has `modeled: true`). Crash-free is no longer sufficient.
- **Call-site update**: the LLM fallback path in `generate-scenario.ts` currently validates against `scenario` alone before executor runs; it must now run the executor on the candidate scenario before validating. Fallback to deterministic fixture on failure as today.
- **Executor coupling**: if this creates an awkward cycle (generator → executor → validator), keep the cycle contained to the generator module rather than leaking execution state upward.

**Scope guard:**

- No changes to IR shape, archetype set, storage layout, or web UI.
- Validators stay deterministic, no LLM calls.
- Do not weaken the event-shape checks — the AND-form is strictly stricter than what shipped.

**Done when:**

- `validateArchetype` signature and all six archetype post-conditions match the AND-form spec above.
- `generate-scenario.ts` LLM path runs executor on candidate before validating, with fallback preserved.
- `tests/pipeline.test.ts` (or a dedicated `tests/archetypes.test.ts`) has per-archetype tests that prove a shape-only pass now fails without the ledger consequence.
- `pnpm demo` still produces green bundled samples (both credit-card + lease archetypes must pass the new stricter checks on the shipped deterministic fixtures — if they don't, that's a real extractor bug to fix here).
- `pnpm test` green.

**Outcome:** Extracted `validateArchetype` to new `src/pipeline/archetype-check.ts` with signature `(scenario, archetype, execution, ir)`. AND-form checks match the spec: late/on-time/over-limit now require fee-clause presence in IR AND a matching ledger entry (keyed by `clauseId`, not description regex); lease on-time adds rent-obligation `status=met`; partial-payment adds `endingBalance > 0`; baseline requires ≥1 ledger entry whose `clauseId` maps to a modeled clause. Restructured `generate-scenario.ts` around a single `checkScenario()` gate that executes + validates both LLM and fallback candidates; if both fail, the scenario is tagged `llm_validated_fallback` with both failure reasons in `validationNote` (honest over silent). Added `tests/archetype-check.test.ts` with positive tests (heuristic fallbacks pass on credit-card + lease) and negative tests (shape-only passes rejected without ledger consequence). 13/13 tests green. Heuristic `pnpm run run --no-llm` is clean on both samples. LLM demo correctly surfaces a real extractor bug — the current LLM IR mis-classifies every fee as `feeType: late_payment`, so the over-limit archetype's `validationNote` now honestly reads "IR does not model an over_limit fee clause." That mis-classification is a distinct extractor issue for T18's research loop to target, not a regression here.

### [deferred] T18 — Autoresearch-style research loop for the extractor

**Deferred 2026-04-12.** The target is right — extractor robustness on unseen Markdown is the real generality concern the brief scores (held-out evaluation, 15%). But a research harness is an indirect, high-cost attack on that target, and judges never see it. T20 (held-out sweep across the six bundled samples) and T21 (fix the concrete fee-classification bug already surfaced by T17c) are direct attacks on the same goal. Revisit only if both land and the extractor's ceiling still feels too low to demo honestly.

Original framing preserved below for reference.

---

**Goal:** Stand up a bounded, scoreable loop that lets an agent iterate on the IR extractor overnight against a held-out corpus, keeping or reverting changes based on a single metric: archetype pass rate. Modeled on [karpathy/autoresearch](https://github.com/karpathy/autoresearch). Depends on T17a **and T17c**.

**Why this matters:** The extractor is the single biggest source of heuristic fragility in the pipeline. Today we improve it by hand-editing `src/pipeline/extract-ir.ts` and eyeballing artifacts. A bounded research loop with one editable surface, one frozen harness, and one scalar metric turns that into ~100 experiments per overnight run, each directly comparable.

**Shape of the change:**

- **Layout:**
  ```
  research/
    corpus/
      seen/           # agent may inspect (westex.md, galleria.md)
      heldout/        # agent runs against, does not read directly
    harness/
      run-all.ts      # runs pipeline over corpus, bounded wall time
      score.ts        # frozen: aggregate archetype pass rate + per-contract breakdown
    experiments/
      <timestamp>/
        diff.patch
        scores.json
        notes.md
        baseline.sha
    RESEARCH.md       # the "program.md" — how the agent should iterate
  ```

- **Editable surface (agent writes these):** `src/pipeline/extract-ir.ts`, `src/llm/openai-json.ts` prompt.

- **Frozen surface (agent must not modify):** everything under `src/core/`, `src/pipeline/archetypes.ts`, `src/pipeline/archetype-check.ts`, `research/harness/`, `research/corpus/`.

- **Metric:** `score = aggregate archetype pass rate` across `corpus/`, with per-contract + per-archetype breakdown in `scores.json`. Single number the agent optimizes. Pulls directly from `validateArchetype` in T17a.

- **Loop:** human kicks off a session pointing at `RESEARCH.md`; agent proposes a diff, runs `research/harness/run-all.ts`, writes `experiments/<timestamp>/`, keeps change if `score` strictly improved or reverts via `git checkout`.

**Scope guard:**

- Research loop does not call an LLM on the `IR → English` path.
- Corpus splits matter: `heldout/*.md` contents are never read by the agent; the agent sees only `scores.json` aggregates for those contracts.
- No CI integration; this is a local overnight tool, not a gate.

**Done when:**

- `research/harness/run-all.ts` runs the full pipeline over `research/corpus/` with a bounded wall-clock budget and writes a single `scores.json`.
- `research/harness/score.ts` is the single source of truth for the metric, is deterministic, and is documented as frozen during an experiment.
- `RESEARCH.md` is written and tells an agent exactly: the editable surface, the frozen surface, how to run the harness, how to log an experiment, when to keep vs. revert.
- `research/corpus/` contains ≥ 4 contracts across ≥ 2 families (credit-card + lease), with a `seen/`/`heldout/` split.
- At least one example experiment is committed under `research/experiments/` as a reference.
- README has a short "Research loop (optional)" section pointing at `RESEARCH.md`.

**Explicit non-goals:** distributed experiments, cost tracking, model-provider sweeps, auto-PR creation, CI gating.

### [ ] T19 — Broaden unmodeled-clause capture for credit-card + lease runs

**Goal:** Surface more of each contract's real section structure as `modeled: false` clauses, so the judge-facing output honestly shows the scope boundary on the two canonical contracts (not just on unsupported families).

**Why this matters:** The killswitch in `addGenericUnmodeledClauses` (`src/pipeline/extract-ir.ts`) — `if (clauses.some((clause) => clause.modeled)) return;` — means the function fires *only* when nothing was modeled. As a result, the Galleria lease output has 3 clauses total (2 modeled + 1 cherry-picked default) instead of something like "2 modeled + 6–8 honestly-named unmodeled sections (insurance, maintenance, assignment, holding-over, …)" that a reader of the source would expect. Same on the WesTex credit card (8 clauses today vs. ~12–15 if we also capture arbitration, privacy, disclosure headings). CLAUDE.md says "Be honest about scope limits and unsupported clause patterns" — today that's only honored on contracts we can't model at all. Fixing it makes the demo honest even on the contracts the heuristic *does* handle.

**Shape of the change:**

- In `addGenericUnmodeledClauses`, replace the killswitch with a policy that always tries to add section-heading unmodeled clauses up to a higher cap (e.g. 6–8 total headings), deduping against titles of already-modeled clauses.
- Keep the existing "Unsupported contract terms" summary fallback for contracts where *no* headings were collected (so securities exchange / pure-prose contracts still get a marker).
- Keep `modeled: false` and use `action: "See source text for unsupported clause: <title>"` so they read honestly in English decompilation.

**Scope guard:**

- Do not add a new `kind: "unmodeled"` to the type system — the convention is `modeled: false` on a regular kind. Preserve that.
- Do not change behavior for contracts that currently hit the `modeled: 0` branch (employment, securities, service) except possibly raising their cap.
- Do not touch archetype validators, scenario generation, or output layout.
- Expect `clauseCount` on the two canonical contracts to increase, shifting `english.txt` and determinism hashes. Land **after** the contract-first storage refactor so baselines move once.

**Done when:**

- Fresh `pnpm run run` on WesTex credit-card shows ≥ 10 total clauses with ≥ 6 `modeled: false` entries carrying real section titles (not just the generic fallback).
- Fresh `pnpm run run` on Galleria lease shows ≥ 6 total clauses with ≥ 4 `modeled: false` section entries.
- `extractor returns honest modeled/unmodeled mix on lease sample` test still passes and continues to assert `modeledClauseCount < clauseCount`.
- `pnpm run determinism --no-llm` still reports IR / scenario / execution / English all stable on both contracts after regeneration.
- `pnpm test` green.

### [ ] T20 — Held-out sweep across the bundled sample set

**Goal:** Run the full pipeline end-to-end on every contract in `contracts/` (not just WesTex + Galleria) and produce an honest, per-sample behavior report. Make "how the system degrades on unseen families" a first-class, inspectable artifact rather than something a judge has to discover by running things.

**Why this matters:** The upstream brief is explicit that "judges evaluate each submission by running it on the same set of held-out Markdown contracts," and **Generality** is a scored axis (15%). Today we have artifacts for two families (credit-card, lease) and silence on the other five samples already sitting in `contracts/`. That silence hides the system's real behavior on procurement, engagement-letter, securities, employment, and service agreements — which is exactly the material a held-out evaluation will probe. Running them ourselves, honestly scoring what happens, and documenting it is the shortest path to showing generality.

**Shape of the change:**

- Add a `pnpm run sweep` command (or a small script under `scripts/`) that runs the existing pipeline once per sample in `contracts/` and writes to `out/_sweep/<sample>/`.
- For each sample, record four boolean-ish outcomes in a shared `out/_sweep/sweep.json`: `extractionRan`, `scenarioGenerated`, `executionRan`, `englishRegenerated`, plus a short `notes` string naming the degradation mode (e.g. "no modeled clauses — generic unmodeled fallback only", "scenario generator defaulted to baseline archetype", "executor produced empty ledger").
- The scoring logic reuses `archetypeFor(family)` + `validateArchetype` where applicable; for families with no archetype coverage it drops to crash-free + non-empty English.
- Write `PLAN/HELDOUT_SWEEP.md` from the sweep output — a short table keyed by sample + family + four outcome columns + one-line notes. Regenerate, don't hand-edit.

**Scope guard:**

- No changes to the extractor, scenario generator, executor, or decompiler as part of this task. This is a reporting task. If the sweep surfaces clear bugs, file them as follow-up TODOs (T21-style) rather than fixing them inline.
- No CI gating; this is a local artifact.
- No new contract samples — use exactly what's in `contracts/` today.

**Done when:**

- `pnpm run sweep --no-llm` runs clean and writes `out/_sweep/<sample>/` for all 7 bundled samples plus a top-level `out/_sweep/sweep.json`.
- `PLAN/HELDOUT_SWEEP.md` exists and tells an honest story: which samples produce modeled clauses vs. unmodeled-only output, which execute meaningfully, which degrade to "structure without computation".
- README gains a short pointer to the sweep artifact under "Notes" or a new "Generality" subsection — one paragraph, not a pitch.
- `pnpm test` green.

### [ ] T21 — Fix LLM fee-classification: every fee tagged `feeType: late_payment`

**Goal:** Fix the concrete extractor bug T17c's outcome documented — the LLM IR path classifies *every* fee clause (late fee, over-limit fee, foreign transaction fee, returned-payment fee) as `feeType: late_payment`. This breaks `credit-card / over-limit` archetype validation and silently degrades Expressiveness on the one family the repo handles best.

**Why this matters:** The brief scores Expressiveness (25%) and Executability (25%) on whether the system captures and runs real contract mechanics. On the credit-card sample — the family with the most modeled clauses and the richest executor — the LLM extraction is currently collapsing distinct fee types into a single label. That's visible in `validationNote` output on the over-limit archetype and is the kind of silent-failure pitfall the brief calls out explicitly. Fixing it is a bounded prompt + validator change, not a research project.

**Shape of the change:**

- Tighten the LLM extraction prompt in `src/llm/openai-json.ts` so the fee-type enum is explicit (`late_payment | over_limit | foreign_transaction | returned_payment | annual | cash_advance`) and the prompt shows a one-line example per type tied to the headings the extractor commonly sees.
- Add a post-extraction validator that rejects an IR where ≥2 distinct fee clauses share the same `feeType` without clear textual justification. On rejection, one retry with a sharpened prompt; if still bad, fall through to heuristic.
- Keep the heuristic fee-classification path unchanged — it's the deterministic-demo path and already handles this correctly.
- Add a focused test: run LLM extraction (stubbed) on WesTex, assert the modeled fee clauses include at least two distinct `feeType` values.

**Scope guard:**

- LLM-only path. Do not touch the heuristic extractor, decompiler, or executor.
- Do not expand the `feeType` enum beyond what the existing executor + decompiler already handle — if a new type needs runtime support, that's a separate TODO.
- No prompt-engineering spiral: one prompt revision + one retry. If that doesn't hold, report honestly and escalate, don't keep tuning.

**Done when:**

- LLM extraction on WesTex produces at least one `over_limit` fee clause and at least one `late_payment` fee clause, verified by a test.
- `credit-card / over-limit` archetype validator passes in LLM mode on WesTex (no more "IR does not model an over_limit fee clause" `validationNote`).
- Prompt + validator changes are localized to `src/llm/openai-json.ts` and `src/pipeline/extract-ir.ts`; no IR-shape or executor changes.
- `pnpm test` green in both LLM-stubbed and heuristic modes.

### [~] T22 — Generic obligation executor (hybrid event-to-clause matching)

**Goal:** Give every IR — not just credit-card and lease — a real execution path. For any contract whose obligations aren't already handled by the CC or lease branches, walk each `obligation` clause, resolve its due date from the `TemporalRule`, match scenario events against obligations via a hybrid rule (explicit `metadata.clauseId` first, actor+verb+window fallback), and emit `performed` / `missed` / `partial` ledger entries plus breach records.

**Why this matters:** Executability (25%) and Generality (15%) are the two biggest judged-points gaps today. Non-CC/non-lease contracts extract fine, round-trip English fine, but the executor currently falls through into credit-card machinery and either produces nothing meaningful or emits nonsense driven by CC event types the scenario doesn't have. One generic path converts every `[UNMODELED]`-dominant execution into a real performed/breached computation across all five other bundled samples and any held-out contract in those shapes.

**Shape of the change:**

- **New isolated matcher** (`src/core/match-obligation.ts`, new): pure function `matchEventToObligation(event, obligation, resolvedDueDate, windowDays) -> { matched, reason }`. `reason` ∈ `"clauseId" | "actor+verb+window" | "no-match"`. Hybrid rule: explicit `event.metadata.clauseId === obligation.id` wins; otherwise accept if `event.metadata.actor === obligation.actor` AND event type fits the obligation's action verb (via small `VERB_TO_EVENT_TYPES` map: `pay→payment`, `deliver→delivery`, `notify→notice`) AND `|event.date - resolvedDueDate| <= windowDays` (default 7).

- **Due-date resolution from `TemporalRule`:** `on_date` → use `value`; `calendar_days` with `anchor` → `contractStart + value`; `business_days` → same with dumb Sat/Sun skip. `contractStart` read from `scenario.initialState.contractStart`, fallback to earliest event date.

- **Executor branch** (`src/core/executor.ts`): new third path `executeGenericObligations(ir, scenario, events)` below the lease branch. Add a discriminator `isCreditCardScenario(ir, scenario)` (presence of `clause.obligation.minimum_payment` OR CC-specific fee) so the existing CC machinery runs only when the IR actually is CC. Generic path emits one `statement` ledger entry per obligation announcing the due date, one `performed` or `missed` entry after matching, and a `Breach { type: "obligation_missed" }` for unmatched obligations.

- **ScenarioEvent type extension** (`src/types/scenario.ts`): add `"delivery"` and `"action"` to `ScenarioEventType`. `"action"` is the catch-all for obligations whose verb doesn't map to an existing type; the matcher falls back to `metadata.clauseId` for these.

- **Tests** (`tests/generic-executor.test.ts`, new): four cases for the matcher in isolation (explicit clauseId, actor+verb fallback inside window, out-of-window no-match, no-obligations trivial) plus one end-to-end test that runs the generic executor on a minimal procurement-shaped IR and asserts a non-empty ledger with at least one `performed` and one `missed` entry.

**Scope guard:**

- Do not touch the CC or lease branches. Only add the new generic path and the discriminator.
- Do not add new `Breach["type"]` values beyond `"obligation_missed"` for this task. Rich breach taxonomy is a follow-up.
- No business-day holiday calendar; weekend skip only. Documented limitation.
- The 7-day match window is a single constant. Per-family tuning is out of scope.
- No extractor or decompiler changes. Decompiler already honors `modeled: false`; generic obligations are already `modeled: true` in the IR.

**Done when:**

- `src/core/match-obligation.ts` exists, exports `matchEventToObligation`, and has ≥4 unit tests covering the hybrid rule.
- `executeGenericObligations` runs on any IR without CC or lease markers and produces a non-empty ledger.
- `isCreditCardScenario` discriminator keeps existing CC artifacts byte-identical (determinism hashes unchanged for WesTex).
- Lease artifacts stay byte-identical (determinism hashes unchanged for Galleria).
- End-to-end test shows a synthetic procurement IR + scenario producing at least one `performed` and one `missed` obligation in execution.
- `pnpm test` + `pnpm demo` green.

**Explicit non-goals:** cure periods, definitions resolution, cross-references between clauses, rich breach taxonomy, multi-obligation scheduling (one obligation → one due date → one match-or-miss).

---

## P2 — Strengthen the executor enough to support real contract logic

These tasks increase expressiveness, but should only follow the core pipeline fixes above.

### [x] T7 — Evaluate formulas through a reusable expression evaluator

**Goal:** Move formula execution onto explicit IR-driven evaluation rather than scattered ad hoc logic.

**Why this matters:** The brief rewards actual computation from the executable representation. A reusable evaluator makes that more defensible.

**Done when:**

- `formula` clauses can be evaluated from IR expressions
- execution uses that evaluator for at least the currently modeled formulas
- tests cover basic arithmetic and variable lookup cases

**Outcome:** Added reusable formula evaluation in `src/core/eval-expr.ts`, wired executor formula paths through it in `src/core/executor.ts`, and added arithmetic/variable tests in `src/core/eval-expr.test.ts`.

### [x] T8 — Make conditional obligations real

**Goal:** Support `condition` on obligations so conditional logic in the IR is not decorative.

**Why this matters:** Conditions are part of the required contract shape in the brief.

**Done when:**

- `BoolExpr` is evaluated programmatically
- at least one obligation or default path uses a condition
- execution behavior changes correctly when the condition is true vs false

**Outcome:** Added BoolExpr evaluation in `src/core/eval-bool.ts`, enforced obligation conditions in `src/core/executor.ts`, introduced a conditional lease obligation in `src/pipeline/extract-ir.ts`, and validated true/false behavior with `src/core/condition-exec.test.ts`.

**Priority note:** This matters, but it is less urgent than fixing extraction honesty, scenario generation, and determinism.

### [ ] T15 — Replace implicit family dispatch in the executor

**Goal:** Make the lease-vs-credit-card branch in `src/core/executor.ts` explicit rather than string-sniffing a clause id.

**Why this matters:** `isLeaseScenario` currently decides execution strategy by looking for `clause.obligation.monthly_rent` or the string `"lease"` in `scenario.initialState.contractFamily` (commit 77ebb7b). That is a load-bearing magic string. Adding a third family (e.g. SaaS, services) will require a parallel branch and another heuristic, and the ordering between heuristics becomes fragile.

**Done when:**

- contract family is a first-class, explicit field on either the IR or the scenario (single source of truth)
- executor dispatch keys off that field, not off clause ids or substring matches
- existing credit-card and lease samples continue to produce identical execution artifacts
- adding a new family is a clear, documented extension point

**Scope note:** Only tackle this when a third family is imminent or the current heuristic has caused a real bug. Premature generalization is the failure mode here.

---

## P3 — Add the minimum quality and judging support around the pipeline

These tasks make the repo safer to change and easier for judges to trust.

### [x] T9 — Add a real test runner and focused unit/integration tests

**Goal:** Protect the core pipeline with small, high-signal tests.

**Why this matters:** The brief explicitly calls out testing and properties as useful, and this repo needs confidence around the core execution path.

**Done when:**

- there is a standard `test` command
- core pipeline behavior has focused unit coverage
- at least one end-to-end test verifies artifact generation
- determinism has a direct test

**Initial coverage target:**

- extraction honesty
- scenario generation shape
- executor outcomes
- deterministic English generation
- determinism command behavior

**Outcome:** Added standard `pnpm test` coverage via Node test mode in `package.json` with focused unit/integration checks in `tests/pipeline.test.ts`, including run-artifact and determinism command assertions.

### [x] T10 — Tighten the README into a judge-proof base demo

**Goal:** Make the repo runnable and verifiable in fewer than 10 clear steps.

**Why this matters:** This is an explicit submission requirement in the brief.

**Done when:**

- README has a numbered base demo under 10 steps
- it shows exact commands and exact artifact paths
- it explains how to inspect scenario inputs and execution outputs
- it explains how to verify deterministic English
- it states limits clearly so the demo does not overclaim

**Outcome:** Updated `README.md` to a 9-step judge-demo flow with explicit commands/artifact paths, deterministic checks, Node version guidance, limits, and writeup links.

### [x] T11 — Judge-facing dossier UI over existing artifacts

**Goal:** Give a judge a single-page browser view of any `out/<run>/` bundle that makes the Markdown → IR → scenario → execution → English round-trip legible at a glance.

**Why this matters:** The decision rule in `END_STATE.md` explicitly lists "judge clarity and inspectability" as a priority. The CLI artifacts are honest but slow to reason about when jumping between five files. A read-only UI that cross-links clauses across all five artifacts makes the deterministic round-trip visceral in one gesture without touching the pipeline.

**Scope guard:** UI must remain read-only over artifacts the CLI already produces. It must not run the pipeline, call an LLM, or introduce a second source of truth.

**Done when:**

- a minimal Next.js App Router app lives under `web/` with its own `package.json`
- a Server Component reads `../out/<run>/{ir,scenario,execution}.json`, `english.txt`, `contract.md` via `fs/promises`
- all five artifacts render side-by-side with clause-id cross-linking on hover and click
- the page lists every run directory under `out/` that contains an `ir.json` and supports `?run=<dirname>` deep-linking
- `pnpm build` and `pnpm typecheck` in `web/` are clean
- README documents the optional browser view

**Outcome:** Added `web/` Next.js 15 / React 19 app with Server Component run loader in `web/app/page.tsx`, client dossier with React-state cross-linking in `web/app/Dossier.tsx`, editorial CSS in `web/app/globals.css`, and a "Browser demo (optional)" section in `README.md`. Build and typecheck clean.

### [x] T12 — Simplify web/ to foreground the scenario as the variable

**Goal:** Rework `web/` so a judge reads the round-trip story in one glance: the contract and its regenerated English are the fixed anchors, the scenario is the knob, and the execution reacts to it. Cut the editorial styling.

**Why this matters:** The current dossier (`Dossier.tsx`, 5 sections, Fraunces/Newsreader headers, "Vol. I" masthead, roman numerals, reveal animations) is an aesthetic object. It gives equal visual weight to Document / Reading / Representation / Stipulated Facts / Findings, which hides what the hackathon actually asks to see — that one IR drives many scenarios, and English is a deterministic function of IR alone. Judge comprehension, not typography, is the goal.

**Shape of the change:**

- Three-zone layout, top-to-bottom, no columns-of-equal-weight framing:
  1. **Inputs row** (fixed): `contract.md` on the left, `english.txt` on the right, labeled "input text" and "regenerated text (deterministic, no LLM)". Equal width. These don't change when the scenario changes — that's the point.
  2. **Scenario strip** (variable, prominent): horizontal row of scenario cards, one per `out/<run>/`, each showing contract title + 2–3 key events + ending balance + breach flag. Selected card is highlighted. Replaces the current `<select>` run-picker.
  3. **Execution pane**: ledger + obligations + breaches for the selected scenario. Tied by `?run=` param.
- IR moves to a collapsible "show representation" drawer below execution — still one click away for the curious judge, but not competing for first-glance attention.
- Strip the stylistic chrome: drop "Vol. I" masthead, roman numerals, `renderTitleWithAmp`, reveal animations, Fraunces/Newsreader font stack. Use one sans (system stack) + one mono. Keep color palette to 3–4 values.
- Keep the clause↔ledger↔english hover-link wiring — it's the one piece of the current UI that *does* serve the round-trip story, not the style. Scope it to execution + english panes only.

**Scope guard:** Read-only over CLI artifacts, same as T11. No new routes, no pipeline execution, no LLM calls. `fs/promises` Server Component load stays. No new dependencies.

**Done when:**

- `web/app/page.tsx` still loads all runs under `out/` with `ir.json`; no data-loading regression
- new layout is inputs / scenario strip / execution, in that visual order
- switching scenarios updates the execution pane (via `?run=` as today)
- IR is reachable but not the primary visual element
- Fraunces/Newsreader, roman numerals, "Vol. I", and reveal animations are gone
- `pnpm build` and `pnpm typecheck` in `web/` are clean
- README "Browser demo" section still accurate (update wording if it references the old sections)

**Explicit non-goals:** dark mode, diffing scenarios side-by-side, in-browser scenario editing, animations on scenario switch, branding.

**Outcome:** Reworked `web/` to inputs / scenario strip / execution / collapsible IR drawer. Stripped Fraunces/Newsreader/JetBrains Mono imports in `web/app/layout.tsx`, rewrote `web/app/globals.css` to a minimal system-font palette, loaded per-run summaries in `web/app/page.tsx` so scenario cards show run id / title / first events / ending balance / breach badge, and rebuilt `web/app/Dossier.tsx` around the three zones with clause↔ledger↔english hover linking preserved. Updated README's "Browser demo (optional)" to describe the new layout. `pnpm typecheck` and `pnpm build` in `web/` are clean; visually verified in Playwright at `localhost:3001`.

---

## Not A Priority Right Now

These may be worthwhile later, but they should not displace the backlog above.

- broad legal ontology work
- generic contract frameworks
- large abstraction layers
- UI polish before the CLI/artifact pipeline is solid
- modeling every clause in a complex contract

## Practical Definition Of Success

This backlog is succeeding if it gets the repo to this state:

1. A Markdown contract goes in.
2. The repo emits an honest executable IR.
3. The pipeline generates explicit scenario data, including an LLM-based path for unseen contracts.
4. The executor computes visible outcomes from those facts.
5. The executable representation deterministically compiles back to English with no LLM.
6. A judge can verify all of that in fewer than 10 steps.
