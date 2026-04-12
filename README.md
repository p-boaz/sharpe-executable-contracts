# Sharpe Executable Contracts MVP

Standalone repo for the Sharpe hackathon track (`Markdown -> executable IR -> deterministic English`).

## What this does

1. Ingests contract markdown.
2. Produces an executable IR (`ir.json`).
3. Produces scenario data (`scenario.json`) with:
   - LLM mode (`--use-llm`) when `OPENAI_API_KEY` is present.
   - deterministic fallback scenario otherwise.
4. Executes contract logic on the scenario (`execution.json`).
5. Deterministically decompiles IR back to English (`english.txt`).
6. Verifies deterministic output (`determinism` command).

## Quickstart (7 steps)

1. Install dependencies:
   - `pnpm install`
2. (Optional) enable LLM mode:
   - `cp .env.example .env`
   - set `OPENAI_API_KEY`
3. Run pipeline (fallback mode):
   - `pnpm run run --contract contracts/WesTex-VISA-credit-card-agreement.md --out out/run`
4. Inspect outputs:
   - `out/run/ir.json`
   - `out/run/scenario.json`
   - `out/run/execution.json`
   - `out/run/english.txt`
5. Run deterministic check:
   - `pnpm run determinism --contract contracts/WesTex-VISA-credit-card-agreement.md --out out/determinism`
6. Verify determinism artifact:
   - `out/determinism/determinism.json`
7. (Optional) run with LLM:
   - append `--use-llm` to `run`/`determinism` commands.

## Notes

- `executable -> English` is deterministic and LLM-free (`src/core/decompiler.ts`).
- Current executor focuses on credit-card style clauses (APR, minimum payment, late fee, over-limit fee, default trigger).
- This is intentionally small and hackathon-oriented, not legal advice.
