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
