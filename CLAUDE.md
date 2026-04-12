# Claude Instructions

## Foundational Premise

Use the Sharpe Hackathon executable-contracts track as the source constraint for this repository:

<https://github.com/hdubugras/sharpe-hackathon>

Work in this repo should preserve the required round-trip:

- contract Markdown -> executable representation
- executable representation + scenario data -> computed execution result
- executable representation -> deterministic English

Important constraint:

- LLMs may help with parsing and scenario generation.
- The executable-to-English path must stay deterministic and must not call an LLM.

## Repository Expectations

- Keep the project as a compact MVP.
- Favor real computation over decorative structure.
- Prefer code that is easy to inspect, run, and debug locally.
- Keep generated artifacts explicit and human-checkable.
- Be honest about scope limits and unsupported clause patterns.

## Engineering Preferences

- Prefer small, direct implementations.
- Use clear names and explicit data flow.
- Avoid unnecessary abstraction and large new dependencies.
- Keep CLI behavior simple and stable.
- Update related pipeline pieces together when contract semantics change.

## What Good Changes Look Like

- They improve the pipeline from Markdown to runnable outputs.
- They strengthen determinism and reproducibility.
- They make scenario assumptions clearer.
- They preserve or improve readability of the generated English.
- They keep the repo understandable for the next engineer.

## Working with PLAN/

The `PLAN/` directory holds the project's live planning state. Consult it by intent:

- About to start work? → read `PLAN/TODOS.md`, pick the highest unchecked P0.
- Unsure if a design choice is allowed? → read `PLAN/DESIGN_DECISIONS.md`.
- Unsure if work still matches the goal? → read `PLAN/END_STATE.md`.
- Want a fresh spec-vs-repo diff? → regenerate `PLAN/SPEC_AUDIT.md` (only on explicit request).

As you make progress, update `PLAN/TODOS.md` inline:

- Flip `[ ]` to `[~]` when starting a TODO.
- Flip `[~]` to `[x]` when it is genuinely done — tests pass, artifacts produced.
- Append an `**Outcome:**` line under the TODO's `Done when:` block: one sentence naming what shipped plus a commit SHA or key file path.
- If a new task surfaces mid-work, add it to `TODOS.md` under the right priority bucket (P0–P3).

Do not edit `END_STATE.md` or `DESIGN_DECISIONS.md` without explicit user approval. Do not create new docs under `PLAN/` without asking.
