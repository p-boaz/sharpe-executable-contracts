# Design Decisions

These are the minimum early design commitments for this MVP.

They exist to keep implementation moving without reopening foundational questions on every change.

They are derived from the Sharpe hackathon ask and from the current repo plan.

## 1. IR Shape

**Decision:** Keep the IR as a small typed clause tree.

For this MVP, the executable representation remains:

- contract metadata
- parties
- definitions
- a list of typed clauses
- nested expression trees where needed

We are not switching to a graph, table model, or bytecode format unless the current shape clearly blocks end-to-end execution.

**Why:** The current clause-tree model is easy to inspect, easy to serialize to `ir.json`, and already fits the hackathon requirement for an executable representation.

**Follow-up:** Add an explicit IR schema version field so future changes are intentional and visible.

## 2. Scenario Artifact

**Decision:** `scenario.json` is the canonical runtime input for execution and judge inspection.

It must remain:

- explicit
- serializable
- human-inspectable
- reproducible across runs

The LLM scenario-generation step may populate this artifact, but execution must consume the artifact directly.

**Why:** Judges need to see what facts were used to run the contract.

## 3. Scenario Shape

**Decision:** Move the scenario format toward a generic fact-plus-events model, not a permanently credit-card-shaped state object.

Near-term direction:

- keep dated events as the primary time-ordered input
- keep a top-level assumptions list
- make initial facts more generic and tied to variables the executor actually uses

For the current repo, this means we should stop baking credit-card-only assumptions into the scenario layer more than necessary.

**Why:** This is the design decision most needed for `T2`.

## 4. Time Semantics

**Decision:** For the MVP, only `on_date` and `calendar_days` count as executable timing semantics unless and until we implement real business-day logic.

`business_days` may remain representable in the IR, but it is not considered fully supported today.

If a clause materially depends on business-day counting and we cannot execute that correctly, it should be marked unmodeled or partially modeled rather than silently treated as supported.

**Why:** Honest partial coverage is better than fake support.

## 5. Parties And Actor Binding

**Decision:** Executable obligations should bind to party identifiers, not arbitrary free-form actor strings.

Near-term rule:

- `parties[].id` is the canonical actor identifier
- executable clauses should reference those identifiers consistently

If extraction cannot confidently bind an actor, we should prefer an honest fallback over pretending the binding is certain.

**Why:** This keeps the IR internally coherent and reduces ambiguity in execution.

## 6. Partial Coverage Policy

**Decision:** Unsupported or only partially supported clauses must remain visible.

Current policy to keep:

- include them in IR where practical
- mark them `modeled: false`
- preserve source text snippets
- render them as `[UNMODELED]` in deterministic English

We do not silently drop unsupported clauses if we can identify them.

**Why:** This is the cleanest way to stay honest while still showing broad contract understanding.

## 7. Deterministic Decompiler

**Decision:** The executable-to-English step stays pure program logic and must not call an LLM.

The template/grammar lives in code.

Current location:

- `src/core/decompiler.ts`

Future work should verify determinism with repeated independent runs, but the architectural rule is already fixed:

- no LLM imports
- no network calls
- same IR in -> same English out

## 8. Scope Discipline

**Decision:** We are optimizing for a credible hackathon MVP, not a general legal platform.

That means:

- prefer small explicit structures
- prefer inspectable JSON artifacts
- prefer honest limited semantics
- avoid introducing major abstractions until the end-to-end path is solid

## Immediate Consequence For The Next Step

`T2` should be implemented against these assumptions:

- keep `scenario.json` as the canonical runtime input
- retain explicit events
- reduce hardcoded credit-card-only scenario assumptions
- make scenario generation respond to extracted IR features
- do not broaden executor semantics beyond what the current MVP can honestly run
