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
