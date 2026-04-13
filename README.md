# Sharpe Executable Contracts MVP

Standalone repo for the Sharpe hackathon track: `Markdown → executable IR → deterministic English`.

## What this does

1. Ingests a contract Markdown file.
2. Extracts an executable IR (`ir.json`) — an effect-union tree with
   `semanticTag`s, optional conditions, and `sourceSpan` offsets back into
   the Markdown.
3. Generates one scenario per detected archetype
   (`scenarios/<archetype>.json`) conditioned on both the contract and the
   IR, with post-condition validators.
4. Executes contract logic against each scenario
   (`executions/<archetype>.json`) — APR-driven balances, minimum
   payments, late/over-limit fees, breach flags, month-stepping for credit
   card; monthly-rent execution for lease.
5. Deterministically decompiles `(ir + scenario + execution)` back to
   English (`english.txt`), LLM-free, with `[source:start-end]` markers.
6. Verifies deterministic output (`determinism` command): `state → English`
   is stable across runs even though LLM stages are not.

## API key required

Every stage that runs the LLM needs `OPENAI_API_KEY`. The CLI fails fast if
it's missing. Here's exactly where it's needed and where it isn't:

| Stage | Needs `OPENAI_API_KEY`? | Where |
|---|---|---|
| IR extraction | yes | `src/core/extractor.ts` via `prompts/ir-extraction.md` |
| Scenario generation | yes | `src/core/scenario.ts` via `prompts/scenario-generation.md` |
| Execution (executor) | no | pure TypeScript, runs on extracted IR + scenario |
| Decompilation → English | no | pure TypeScript, deterministic |
| `pnpm run determinism` | yes (runs extract + scenario twice) | `scripts/` determinism driver |
| `pnpm run check:expectations` | only with `--extract` | defaults to cached `out/<contractId>/ir.json` |
| `pnpm test` | some cases | live-extract tests need it; IR-fixture tests don't |
| Web "Process Contract" | yes | `web/app/api/run-contract/route.ts` shells out to the CLI |

`OPENAI_MODEL` defaults to `gpt-5-mini` (see `.env.example`). Cached
artifacts ship under `out/` so reviewers can inspect shape without burning
tokens.

## Quickstart (9 steps)

1. `node -v` (≥20) and `pnpm install` at repo root.
2. `cp .env.example .env` and set `OPENAI_API_KEY`. LLM mode is required —
   the CLI exits early if the key is missing.
3. Run pipeline on the reference contract:
   `pnpm run run --contract contracts/WesTex-VISA-credit-card-agreement.md --out out/run`.
4. Verify artifacts:
   - `out/run/ir.json`
   - `out/run/scenarios/<archetype>.json`
   - `out/run/executions/<archetype>.json`
   - `out/run/english.txt`
   - `out/run/meta.json` (`extractIr` + per-archetype `generateScenario`
     status)
5. Spot-check `english.txt` — modeled clauses render with computed numbers;
   unmodeled clauses are prefixed `[UNMODELED]`; `[source:start-end]`
   markers trace back into the Markdown.
6. Run determinism check:
   `pnpm run determinism --contract contracts/WesTex-VISA-credit-card-agreement.md --out out/determinism`.
   In `out/determinism/determinism.json`: `irStable` / `scenarioStable` /
   `executionStable` are `null` by design (LLM nondeterminism is expected);
   `englishDecompilerStable` and `englishStable` are `true` (the actual
   guarantee).
7. (Optional) Run a second contract family (lease path):
   `pnpm run run --contract contracts/Galleria-Atlanta-office-lease-American-Safety-Insurance-2006.md --out out/lease-run`.
8. (Optional) `pnpm test` — Vitest covers extractor, executor, decompiler,
   and expectation YAMLs.
9. (Optional) `pnpm run check:expectations` — compares extracted IR against
   expectation YAMLs. Add `--extract` to re-extract live from
   `contractFile` instead of reading cached `out/<contractId>/ir.json`.

## Browser demo (optional)

A Next.js viewer lives in `web/`. Contract-first: the dropdown reads from
`contracts/*.md` (excluding `SOURCES.md`), and "Process Contract" POSTs to
`web/app/api/run-contract/route.ts`, which shells out to the same CLI
pipeline (`pnpm run run`) into `out/_web_runs/<contract-key>/`. A second
route (`web/app/api/upload-contract`) accepts held-out `.md` uploads;
`web/app/api/execute` re-runs execution only.

Layout is three zones, top to bottom: **Inputs** (`contract.md` ↔
`english.txt`), **Scenario**, **Execution**. The IR is available in a
collapsible "Show representation" drawer. Hovering a ledger row or English
clause line highlights its counterpart.

1. `cd web && pnpm install`
2. Ensure the Next.js process sees `OPENAI_API_KEY` (inherit from your
   shell or drop it in `web/.env.local`).
3. `pnpm dev` → open `http://localhost:3000`.
4. Pick any bundled contract, click "Process Contract", then inspect
   scenarios and execution.
5. (Optional) upload a held-out `.md` in the UI and process it the same way.

## Design choices

- **`modeled: true|false` per clause.** Partial coverage is surfaced as
  `[UNMODELED]` in the regenerated English rather than hidden. Converts
  coverage gaps from a weakness into an explicit contract with the reader,
  and lets the decompiler stay total (every clause renders) while staying
  honest (nothing fake-executes).
- **Determinism scoped to `state → English`.** LLM stages are allowed to
  drift across runs; the deterministic guarantee is only for the pure-TS
  decompiler. That's what `determinism.json` encodes, and it's what's
  actually testable.
- **Archetype-keyed scenarios.** One scenario/execution pair per archetype
  (credit-card, lease, …) with post-condition validators, so each contract
  family has its own ground-truth harness.
- **Fail-fast LLM stages.** No silent fallback path — if extraction or
  scenario generation fails, the CLI exits and the artifact is absent.
- **Source-span traceability.** IR clauses carry `sourceSpan` offsets and
  the decompiler emits `[source:start-end]` markers, so every rendered
  sentence is cross-linkable to the Markdown.
- **Deterministic `extractionHash`.** IR metadata includes a hash over
  contract markdown + extractor version, so cached IR can be invalidated
  when either changes.

## Limitations

- Executor covers credit-card clauses end-to-end and a minimal lease
  monthly-rent path. Engagement-letter, securities-exchange,
  service-agreement, and employment contracts round-trip through IR and
  decompilation but execute shallowly — most clauses land as
  `modeled: false`.
- LLM extraction is nondeterministic; IR/scenario/execution will drift
  run-to-run. Users who need stable IR should cache artifacts rather than
  re-extract.
- Prompt quality is currently the recall bottleneck, not IR expressiveness
  — the effect union can hold more than the extractor reliably produces.
- Every fresh run has a non-trivial OpenAI bill attached (extraction +
  scenario per archetype, ×2 for determinism).
- Hackathon-scoped. Not legal advice.

## Sample contracts

The repo bundles the full example-contract set referenced in the upstream
Sharpe Hackathon repo, plus a couple of extra Law Insider examples for
broader testing:

- `contracts/WesTex-VISA-credit-card-agreement.md`
- `contracts/ORBCOMM-Orbital-amendment-1-AIS-payload-procurement-2006.md`
- `contracts/Galleria-Atlanta-office-lease-American-Safety-Insurance-2006.md`
- `contracts/Masterworks084-IndieBrokers-Regulation-A-engagement-letter.md`
- `contracts/A-Plus-Xodtec-securities-exchange-agreement-2009.md`
- `contracts/Sequa-employment-agreement-2005.md`
- `contracts/OneAmerica-MBSC-service-agreement-2015.md`

See `contracts/SOURCES.md` for provenance.

## Notes

- `executable-state → English` is deterministic and LLM-free
  (`src/core/decompiler.ts`).
- CLI auto-loads `.env` from the repo root before parsing args.
- Longer writeups: `SPEC_WALKTHROUGH.md` (section-by-section mapping to
  the hackathon brief) and `SUBMISSION.md` (submission-form draft).
