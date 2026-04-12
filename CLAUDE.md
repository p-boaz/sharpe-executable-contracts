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
