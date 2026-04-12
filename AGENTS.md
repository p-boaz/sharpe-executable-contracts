# Agents Instructions

## Foundational Premise

This repository exists to implement the core premise of the Sharpe Hackathon executable-contracts track:

<https://github.com/hdubugras/sharpe-hackathon>

The project should stay aligned with that premise:

- Input is contract Markdown.
- The system must produce an executable representation of the contract.
- The system must run that representation against scenario data and compute outcomes.
- The system must deterministically compile executable state back into readable English.
- `executable -> English` must remain programmatic and LLM-free.
- LLM usage is allowed for extraction and scenario generation, but not for deterministic decompilation.

## Project Intent

This repo is an MVP, not a full legal reasoning platform.

- Optimize for a working end-to-end pipeline over broad legal coverage.
- Prefer explicit behavior over ambitious abstraction.
- Keep outputs inspectable: `ir.json`, `scenario.json`, `execution.json`, `english.txt`.
- Preserve determinism where the hackathon requires it.
- Treat legal correctness claims conservatively. This is software for a hackathon demo, not legal advice.

## Working Style

- Keep the implementation small, readable, and production-friendly.
- Prefer simple TypeScript and plain data structures.
- Avoid heavy dependencies unless they clearly reduce complexity.
- Do not add speculative frameworks, orchestration layers, or generic abstractions.
- Make behavior obvious at the CLI and file-output level.

## Change Priorities

When making changes, prioritize:

1. End-to-end executability
2. Deterministic English regeneration
3. Clear contract IR and scenario shape
4. Robustness on unseen Markdown
5. Ease of debugging and extension

## Practical Guardrails

- Do not break the `run` and `determinism` flows.
- If changing IR or execution behavior, keep the decompiler in sync.
- Prefer adding small focused logic over trying to formalize every clause type.
- Surface limitations explicitly instead of hiding them behind vague outputs.
- Keep prompts, parsing, IR, execution, and decompilation boundaries clear.
