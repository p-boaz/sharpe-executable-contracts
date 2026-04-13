# Post-Mortem Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three highest-leverage rubric gaps identified in `POSTMORTEM.md` — round-trip fidelity, extractor recall, and semantic-tag contract — then remove the drift/hygiene issues that hide regressions.

**Architecture:** Three core fixes + three hygiene fixes, each independently shippable. Round-trip: flip `decompiler.ts` to render from `effect` and treat `sourceText` as citation. Extractor: load prompts from disk and rewrite them with per-effect worked examples and a closed `semanticTag` vocabulary. Contract enforcement: validate `semanticTag` post-parse with one repair retry. Hygiene: delete dead `heuristicFallbackIr` + stale committed artifacts, realign expectation IDs with cached output dirs, and convert the 5 skipped tests to recorded-fixture runs.

**Tech Stack:** TypeScript (ESM), Vitest, Zod, `callOpenAIJson` wrapper, pnpm, Node ≥ 20. No new runtime deps.

**Non-goals for this plan:** generalized cross-family executor, defined-term resolution, cross-reference modeling, temporal-rule execution (business days / grace / cure). Those are follow-ups once the rubric-critical fixes land.

**Recommended task order:** Task 0 (remove web — pure cleanup, shrinks the surface area everyone else works against) → Task 1 (decompiler) → Task 2 (prompt plumbing) → Task 3 (prompt rewrite) → Task 3b (model upgrade — paired with 3 because the stronger model + better prompt compound) → Task 4 (tag enforcement) → Task 5 (dead code + artifacts) → Task 6 (fixture mode) → Task 7 (expectations realign) → Task 8 (audit).

---

## File Structure

**Modify:**
- `src/core/decompiler.ts` — flip body rendering to `effect`-first, demote `sourceText` to citation.
- `src/pipeline/extract-ir.ts` — remove inlined prompt string, load from disk, add `semanticTag` validation + repair retry, delete dead `heuristicFallbackIr` and its callers.
- `src/pipeline/generate-scenario.ts` — remove inlined prompt string, load from disk.
- `src/types/ir.ts` — widen `semanticTag` type comment; add exported `KNOWN_SEMANTIC_TAGS` constant consumed by both extractor validator and executor.
- `src/core/executor.ts` — switch string-literal `"late_payment_fee"` (and peers) to reference `KNOWN_SEMANTIC_TAGS`.
- `expectations/*.yaml` — realign `contractId` fields to match the cached `out/<dir>/` names.
- `src/main.ts` / `run-pipeline.ts` — any code path that still references `heuristicFallbackIr` or `--no-llm` falls away cleanly.

**Create:**
- `prompts/ir-extraction.md` — **replace** the 8-line stub with a real prompt (headers: Schema, Effect-kind worked examples, `semanticTag` vocabulary, Partial-coverage discipline).
- `prompts/scenario-generation.md` — **replace** the 9-line stub with the current inlined scenario prompt, expanded with archetype-aware guidance.
- `src/util/load-prompt.ts` — tiny helper that reads a prompt file relative to repo root and caches it per-process.
- `src/util/load-prompt.test.ts` — unit test for the loader.
- `src/pipeline/semantic-tag-validator.ts` — validator + repair-retry logic.
- `src/pipeline/semantic-tag-validator.test.ts` — unit tests (happy path + one-invalid-tag + all-invalid).
- `tests/fixtures/llm/` — recorded JSON responses for the 5 currently-skipped tests.
- `src/util/llm-recorder.ts` — a `callOpenAIJson` wrapper that replays from `tests/fixtures/llm/` when `LLM_RECORD_MODE=replay`.

**Delete:**
- `src/pipeline/extract-ir.ts:479-...` (`heuristicFallbackIr` and its helpers, once nothing references it).
- Committed `out/*/meta.json` files with `"mode": "heuristic_fallback"` — regenerated from live pipeline.
- `web/` (entire Next.js workspace — Task 0).
- `out/_web_runs/` (cache consumed only by the deleted viewer).

**Other modifications added by Tasks 0 and 3b:**
- `knip.json` — drop the `"web"` workspace.
- `src/pipeline/run-pipeline.ts:66-70` — remove the JSDoc comment preserving an export for the deleted web viewer.
- `pnpm-workspace.yaml` (if it exists) — drop the `web` entry.
- `.env.example` — change default model to `gpt-5.4`.
- `src/llm/openai-json.ts:39` — change default model to `gpt-5.4`; optionally add `reasoningEffort` parameter.
- `src/pipeline/generate-scenario.ts:27` — update stale 128K context-window comment to reflect 1.05M.
- `README.md` — remove Next.js viewer sections; update model name.

---

## Task 0: Remove the Next.js Web App

**Why it matters:** `web/` is a Next.js app that is not part of the rubric and has been a distraction — 5 of 33 hackathon commits went to it. Removing it shrinks the cognitive surface, eliminates a separate workspace, and kills the only cross-workspace import (a comment-preserved export in `run-pipeline.ts` kept alive for `web/app/api/execute/route.ts`).

**Files:**
- Delete: `web/` (entire directory — `app/`, `next.config.ts`, `next-env.d.ts`, `tsconfig.json`, `package.json`, `node_modules/`, `tsconfig.tsbuildinfo`, `pnpm-lock.yaml`)
- Modify: `knip.json` (drop the `"web"` workspace entry)
- Modify: `src/pipeline/run-pipeline.ts:66-70` (delete the "kept alive for web/..." preservation comment; the export itself may become dead and knip will tell us)
- Modify: `README.md` (remove any "viewer", "Next.js", or `web/` sections)
- Modify (if present): `pnpm-workspace.yaml` — drop the `web` entry
- Delete: `out/_web_runs/` (cached artifacts consumed only by the web viewer)

- [ ] **Step 1: Inventory all references to `web/` in the non-`web` tree**

Run the Grep tool:
```
pattern: web/|_web_runs|next\.js|Next\.js|viewer
path:    .
glob:    !web/**
output_mode: content
-n: true
head_limit: 60
```
Expected: matches in `README.md`, `knip.json`, `src/pipeline/run-pipeline.ts`, `POSTMORTEM.md` (mentions only — leave those). Write down each file so Step 4 catches everything.

- [ ] **Step 2: Check for a pnpm-workspace.yaml or workspace glob in root package.json**

Run: `cat pnpm-workspace.yaml 2>/dev/null; jq -r '.workspaces // .pnpm // empty' package.json`
Expected: Either nothing (web is a standalone folder with its own package.json) or a `packages: [..., "web"]` entry that needs pruning. The root `package.json` we already read has no `workspaces` field, so the web workspace lives either in `pnpm-workspace.yaml` or is only declared implicitly.

- [ ] **Step 3: Delete the directory**

Run: `rm -rf web out/_web_runs`
Expected: both gone. If there are uncommitted changes inside `web/`, verify with git status before running — the user has been active in this tree.

- [ ] **Step 4: Prune knip.json**

Edit `knip.json` to remove the `"web"` workspace entry:

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "workspaces": {
    ".": {
      "entry": ["tests/**/*.test.ts"],
      "project": [
        "src/**/*.ts",
        "scripts/**/*.ts",
        "tests/**/*.ts"
      ]
    }
  }
}
```

- [ ] **Step 5: Remove the preservation comment in run-pipeline.ts**

Open `src/pipeline/run-pipeline.ts:66-70`. Remove the JSDoc block:

```ts
/**
 * Imported by name (as a string literal) from the subprocess template in
 * `web/app/api/execute/route.ts` — static analyzers like knip cannot see
 * that reference, so this export must be retained.
 * @public
 */
```

Then run knip (`pnpm dlx knip` or whatever the repo script is). If the symbol the comment was protecting now shows up as unused, the symbol itself is dead — delete it. If it's still used by in-tree code, just leave the export alone without the misleading comment.

- [ ] **Step 6: Scrub README.md**

Open `README.md`. Remove sections about the Next.js viewer, `web/`, or "open the UI". Leave the core CLI quickstart intact. If any `pnpm -C web …` command appears, delete it.

- [ ] **Step 7: Check pnpm-workspace.yaml**

If `pnpm-workspace.yaml` exists and lists `web`, drop that entry (and the file if it becomes empty).

- [ ] **Step 8: Verify build + tests still pass**

Run: `pnpm install && pnpm test && pnpm typecheck`
Expected: clean. No dangling imports, no "cannot find module 'web/...'", no knip workspace warnings.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: remove Next.js web app

The web viewer was out of rubric scope and absorbed ~15% of hackathon
commits. Removing it eliminates a workspace, kills the cross-workspace
pinning in run-pipeline.ts, and shrinks the cognitive surface before
the rubric-critical fixes land."
```

---

## Task 1: Round-Trip Fix — Render Clause Body from `effect`

**Why it matters:** This is the kill shot. `decompiler.ts:125` currently does `sourceText || effectToText(effect)` — the IR is unobservable in English output, forfeiting most of the 25% Round-trip score.

**Files:**
- Modify: `src/core/decompiler.ts:121-130`
- Create: `tests/core/decompiler-effect-first.test.ts`

- [ ] **Step 1: Write failing test — body must come from `effect`, not `sourceText`**

```ts
// tests/core/decompiler-effect-first.test.ts
import { describe, it, expect } from "vitest";
import { decompileIrToEnglish } from "../../src/core/decompiler.js";
import type { ContractIR } from "../../src/types/ir.js";

describe("decompileIrToEnglish — effect-first rendering", () => {
  it("renders clause body from effect, not verbatim sourceText", () => {
    const ir: ContractIR = {
      contractId: "t",
      title: "T",
      currency: "USD",
      parties: [],
      definitions: [],
      clauses: [
        {
          id: "cl_1",
          title: "Late fee",
          sourceText: "ORIGINAL MARKDOWN TEXT THAT SHOULD NOT BE THE BODY.",
          modeled: true,
          semanticTag: "late_payment_fee",
          effect: {
            kind: "payment",
            payer: "party-cardholder",
            payee: "party-issuer",
            amount: { op: "const", value: 25 },
          },
        },
      ],
      metadata: {
        clauseCount: 1,
        modeledClauseCount: 1,
        sourceFile: "x.md",
        sourceHash: "h",
        sourceCharLength: 0,
        extractedAt: "2026-04-13T00:00:00Z",
        mode: "llm",
        warnings: [],
      },
    };

    const english = decompileIrToEnglish(ir);
    expect(english).toContain("party-cardholder pays party-issuer 25");
    expect(english).not.toMatch(/ORIGINAL MARKDOWN TEXT/);
  });

  it("includes sourceText as a citation annotation, not the body", () => {
    const ir: ContractIR = {
      contractId: "t",
      title: "T",
      currency: "USD",
      parties: [],
      definitions: [],
      clauses: [
        {
          id: "cl_1",
          title: "Late fee",
          sourceText: "Cardholder shall pay $25.",
          modeled: true,
          semanticTag: "late_payment_fee",
          sourceSpan: { start: 10, end: 34 },
          effect: {
            kind: "payment",
            payer: "party-cardholder",
            payee: "party-issuer",
            amount: { op: "const", value: 25 },
          },
        },
      ],
      metadata: {
        clauseCount: 1,
        modeledClauseCount: 1,
        sourceFile: "x.md",
        sourceHash: "h",
        sourceCharLength: 0,
        extractedAt: "2026-04-13T00:00:00Z",
        mode: "llm",
        warnings: [],
      },
    };

    const english = decompileIrToEnglish(ir);
    // Body is derived from effect; sourceText appears only in the citation line.
    expect(english).toContain("party-cardholder pays party-issuer 25");
    expect(english).toMatch(/source:\s*chars 10.*34/);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `pnpm vitest run tests/core/decompiler-effect-first.test.ts`
Expected: FAIL. First assertion fails because body is `ORIGINAL MARKDOWN TEXT…` verbatim.

- [ ] **Step 3: Flip the body/citation logic**

Edit `src/core/decompiler.ts:121-130`. Replace the `clauseParagraph` function with:

```ts
function clauseParagraph(clause: Clause): string[] {
  const prefix = clause.modeled ? "" : "[UNMODELED] ";
  const titlePart = clause.title ? ` \u2014 ${clause.title}` : "";
  const heading = `${prefix}Clause ${clause.id}${titlePart}`;
  // Body MUST be derived from the IR so that English verifies the executable.
  // sourceText is preserved only as an annotated citation.
  const body = normalizeProse(effectToText(clause.effect));
  const sourceQuote = normalizeProse(clause.sourceText);
  const citation = citationFor(clause).trimStart();
  const lines = [heading, body];
  if (sourceQuote) lines.push(`(source text: "${sourceQuote}")`);
  if (citation) lines.push(citation);
  lines.push("");
  return lines;
}
```

- [ ] **Step 4: Run tests — both should pass**

Run: `pnpm vitest run tests/core/decompiler-effect-first.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Regenerate golden outputs, inspect diff by eye**

Run: `pnpm run run` against the credit-card fixture (see `README.md` quickstart).
Open `out/credit-card-agreement/english.txt`. Confirm clause bodies now read e.g. `party-cardholder pays party-issuer 25` and `(source text: "…")` is a secondary citation, not the body.

- [ ] **Step 6: Run full test suite**

Run: `pnpm test`
Expected: All non-skipped tests pass. If any golden-file snapshot tests break (they will), update them — the new shape is what we want.

- [ ] **Step 7: Commit**

```bash
git add src/core/decompiler.ts tests/core/decompiler-effect-first.test.ts \
        out/credit-card-agreement/english.txt out/galleria-atlanta-*/english.txt
git commit -m "fix(decompiler): render clause body from effect, demote sourceText to citation

Restores round-trip fidelity: English is now a function of the IR (effect),
not a passthrough of original markdown. sourceText is preserved as an
annotated citation so provenance stays visible.

Addresses POSTMORTEM.md root cause #1."
```

---

## Task 2: Externalize the Extraction Prompt

**Why it matters:** The real prompt is 25 inlined lines in `extract-ir.ts:1065`. Every iteration on extraction quality requires editing TypeScript. The on-disk `prompts/ir-extraction.md` is 8 lines and never loaded. This task is pure plumbing — Task 3 fills the rewritten content.

**Files:**
- Create: `src/util/load-prompt.ts`
- Create: `src/util/load-prompt.test.ts`
- Modify: `src/pipeline/extract-ir.ts:1064-1089`
- Modify: `src/pipeline/generate-scenario.ts` (the analogous inlined prompt)

- [ ] **Step 1: Write failing test for the loader**

```ts
// src/util/load-prompt.test.ts
import { describe, it, expect } from "vitest";
import { loadPrompt } from "./load-prompt.js";

describe("loadPrompt", () => {
  it("reads a prompt file relative to the repo root", () => {
    const prompt = loadPrompt("prompts/ir-extraction.md");
    expect(prompt.length).toBeGreaterThan(200);
    expect(prompt).toMatch(/effect\.kind/);
  });

  it("throws a clear error when the prompt is missing", () => {
    expect(() => loadPrompt("prompts/does-not-exist.md")).toThrow(
      /prompts\/does-not-exist\.md/,
    );
  });

  it("caches reads per process", () => {
    const a = loadPrompt("prompts/ir-extraction.md");
    const b = loadPrompt("prompts/ir-extraction.md");
    expect(a).toBe(b); // identity, not just equality
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm vitest run src/util/load-prompt.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the loader**

```ts
// src/util/load-prompt.ts
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// src/util -> repo root is two dirs up.
const repoRoot = resolve(here, "..", "..");

const cache = new Map<string, string>();

export function loadPrompt(relativePath: string): string {
  const cached = cache.get(relativePath);
  if (cached !== undefined) return cached;

  const abs = resolve(repoRoot, relativePath);
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(
      `loadPrompt: could not read ${relativePath} (resolved to ${abs}): ${String(err)}`,
    );
  }
  cache.set(relativePath, content);
  return content;
}
```

- [ ] **Step 4: Re-run loader test**

Run: `pnpm vitest run src/util/load-prompt.test.ts`
Expected: PASS (3/3). Note — the first test requires `prompts/ir-extraction.md` to be ≥200 chars with `effect.kind`, which is already true of the current stub but only barely. Task 3 makes it robustly true.

- [ ] **Step 5: Wire the extractor to the loader (shim — content unchanged yet)**

Open `src/pipeline/extract-ir.ts` near line 1064. Replace the inlined `systemPrompt` array with a disk load, keeping the current content as the initial file body (Task 3 rewrites it).

First, copy the current inlined prompt content into `prompts/ir-extraction.md` verbatim (preserving the current behavior so we can iterate separately).

```ts
// src/pipeline/extract-ir.ts
import { loadPrompt } from "../util/load-prompt.js";

// ...inside extractIr():
export async function extractIr(options: ExtractIrOptions): Promise<ContractIR> {
  const systemPrompt = loadPrompt("prompts/ir-extraction.md");
  const userPrompt = `Source file: ${options.sourceFile}\n\nContract markdown:\n${options.contractText}`;
  // …rest unchanged
}
```

- [ ] **Step 6: Do the same for `generate-scenario.ts`**

Copy its inlined system prompt to `prompts/scenario-generation.md` verbatim, then replace the inline string with `loadPrompt("prompts/scenario-generation.md")`.

- [ ] **Step 7: Run full test suite**

Run: `pnpm test`
Expected: Behavior unchanged — prompts are byte-identical, just loaded from disk.

- [ ] **Step 8: Commit**

```bash
git add prompts/ir-extraction.md prompts/scenario-generation.md \
        src/util/load-prompt.ts src/util/load-prompt.test.ts \
        src/pipeline/extract-ir.ts src/pipeline/generate-scenario.ts
git commit -m "refactor(prompts): load extraction + scenario prompts from disk

prompts/ir-extraction.md and prompts/scenario-generation.md were stubs
that README referenced but no code loaded. Now they are the source of
truth — inlined copies removed. Content is byte-identical to the old
inlined strings; a follow-up task rewrites them for quality."
```

---

## Task 3: Rewrite the Extraction Prompt

**Why it matters:** On 5 of 7 audited contracts the extractor collapses to one `unmodeled_summary` stub. The prompt teaches `Expr` grammar but nothing about clause discovery, `semanticTag` discipline, or per-effect-kind recall. A richer prompt is the cheapest lift for Expressiveness (25%) and Generality (15%).

**Files:**
- Modify (replace): `prompts/ir-extraction.md`
- Create: `tests/pipeline/extractor-recall-smoke.test.ts` (replay-mode; see Task 6 for the recorder)

This is the task where **your judgment shapes the solution most**. The prompt is an editorial artifact — multiple valid directions exist:

**Learning-mode contribution point:** Before writing the prompt file, decide on the **`semanticTag` vocabulary**. The executor currently recognizes these tags:

- Credit card: `late_payment_fee`, `over_limit_fee`, `returned_payment_fee`, `foreign_transaction_fee`, `minimum_payment_obligation`, `minimum_payment_formula`, `credit_limit_obligation`, `illegal_use_default`
- Lease: `rent_obligation`, `base_rent`, `tenant_default`

Decide whether to:
- **(A)** Keep the vocabulary closed and just teach it to the LLM in the prompt (simpler, tighter contract).
- **(B)** Expand it with family tags for procurement / services / securities / employment (broadens Generality but the executor still won't consume them until Task 7-style work).

Recommendation: **(A) for now.** Broader vocab without executor support is just more strings that drift. Capture this decision in the prompt as a closed list.

Once the vocabulary decision is made, the mechanical work is:

- [ ] **Step 1: Author the replacement prompt**

Write `prompts/ir-extraction.md` with these sections (each section short; total ~150 lines):

1. **Role & output contract** — "You are an extractor. Output strict JSON matching the schema. Prefer fewer, higher-quality modeled clauses over many shallow ones."
2. **Clause discovery heuristics** — one paragraph on scanning headings, numbered sections, and obligation verbs ("shall", "must", "is required to", "agrees to").
3. **Effect-kind decision tree** — per kind (`payment`, `obligation`, `formula`, `accumulation`, `indemnification`, `default`, `unmodeled`), a one-line "use this when…" guide.
4. **Worked examples — one per effect kind.** (Current prompt has ~4; fill in the missing kinds, especially `obligation`, `indemnification`, `default`.)
5. **Closed `semanticTag` vocabulary** — the list from the vocabulary decision above, with a one-line gloss on each, and an explicit instruction: "If none of the above fits, emit `unmodeled_section` and set `modeled: false`."
6. **Partial-coverage discipline** — "It is better to emit 3 modeled clauses and 5 unmodeled stubs than to collapse the contract into one `unmodeled_summary`. Always produce at least one clause *per section heading or numbered clause*, even if most are unmodeled."
7. **Expr grammar refresher** — keep the current content verbatim (it's the one part that works).

- [ ] **Step 2: Recall-smoke test (replay mode — stub until Task 6)**

Add `tests/pipeline/extractor-recall-smoke.test.ts`. For now, mark it `.skip` with a `TODO: unskip once Task 6 lands the LLM recorder`. It asserts, against a recorded response for the ORBCOMM sample:

```ts
import { describe, it, expect } from "vitest";
// TODO(Task 6): unskip once recorder lands.
describe.skip("extractor recall on ORBCOMM", () => {
  it("emits ≥3 modeled clauses, not one unmodeled_summary", async () => {
    const ir = await extractIr({ sourceFile: "contracts/orbcomm.md", contractText: ORBCOMM_TEXT });
    expect(ir.clauses.filter((c) => c.modeled).length).toBeGreaterThanOrEqual(3);
    expect(ir.clauses.map((c) => c.semanticTag)).not.toEqual(["unmodeled_summary"]);
  });
});
```

- [ ] **Step 3: Run a live extraction against ORBCOMM (manual, one-shot)**

With `OPENAI_API_KEY` set, run the pipeline on `contracts/orbcomm-orbital-amendment-1-ais-payload-procurement-2006.md` (or whichever path exists).

Run: `pnpm run run -- orbcomm-orbital-amendment-1-ais-payload-procurement-2006`
Expected: IR has ≥3 clauses, most likely a mix of modeled + unmodeled. If it still collapses to one `unmodeled_summary`, iterate the prompt (add more effect-kind examples, tighten the partial-coverage instruction) before proceeding.

- [ ] **Step 4: Also re-run credit-card and lease samples**

Make sure the prompt rewrite has not regressed the two working families.

Run: `pnpm run run -- credit-card-agreement` and `pnpm run run -- galleria-atlanta-office-lease-american-safety-insurance-2006`
Expected: Both still produce real-numbered executions (check `out/*/executions/*.json`).

- [ ] **Step 5: Commit**

```bash
git add prompts/ir-extraction.md tests/pipeline/extractor-recall-smoke.test.ts \
        out/credit-card-agreement out/galleria-atlanta-* out/orbcomm-*
git commit -m "feat(prompts): rewrite ir-extraction with per-effect examples and closed semantic vocab

- Adds clause-discovery heuristics and effect-kind decision tree
- Adds worked examples for obligation/indemnification/default (previously only
  payment/accumulation/formula were covered)
- Captures the closed semanticTag vocabulary the executor recognizes
- Adds an explicit partial-coverage instruction so contracts no longer collapse
  to a single unmodeled_summary"
```

---

## Task 3b: Upgrade the LLM Model from `gpt-5-mini` to `gpt-5.4`

**Why it matters:** Post-mortem root cause #9 — "model choice was not revisited." Extraction recall is the bottleneck that Task 3's prompt rewrite targets. A higher-capacity frontier model compounds with the better prompt at a few cents per held-out contract. Per OpenAI docs: `gpt-5.4` has a 1.05M-token context window (vs. 128K for `gpt-5-mini`), supports reasoning effort levels (`low`, `medium`, `high`, `xhigh`), and text+image input. Pairing this task with Task 3 is deliberate — we iterate the prompt **on the final model**, not on one we're about to leave.

**Files:**
- Modify: `.env.example`
- Modify: `src/llm/openai-json.ts:39`
- Modify: `src/pipeline/generate-scenario.ts:27` (stale context-window comment)
- Modify: `README.md` (model mention around line 39)
- Optional: `src/llm/openai-json.ts` — expose a reasoning-effort parameter now that the model supports it

- [ ] **Step 1: Flip the default in openai-json.ts**

Edit `src/llm/openai-json.ts:39`:

```ts
// before
const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5-mini";
// after
const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4";
```

- [ ] **Step 2: Flip the default in .env.example**

Edit `.env.example:2`:

```
OPENAI_MODEL=gpt-5.4
```

- [ ] **Step 3: Fix the stale context-window comment**

Edit `src/pipeline/generate-scenario.ts:27`. The current comment claims a 128K context window (mini's); update to reflect the 1.05M window and broader per-contract headroom:

```ts
// gpt-5.4 has a 1,050,000-token context window; at ~4 chars/token we can
// comfortably fit even the largest held-out contracts without chunking.
```

Re-read the surrounding code and remove any chunking / truncation logic that only existed because of the 128K ceiling — it's no longer load-bearing.

- [ ] **Step 4: Update README mention**

Edit `README.md:39` (and nearby copy): replace `gpt-5-mini` with `gpt-5.4`. Keep the sentence honest — note that higher-capacity extraction is the reason for the default.

- [ ] **Step 5: (Optional) Thread reasoning effort through the LLM wrapper**

`gpt-5.4` supports reasoning effort levels (`low`/`medium`/`high`/`xhigh`, default `none`). Extraction benefits from `medium` or `high`; scenario generation can stay at the default to keep cost down. If `src/llm/openai-json.ts` doesn't already accept a `reasoningEffort` option, thread it through as an optional parameter and plumb from `extractIr()` with `reasoningEffort: "high"`.

**Learning-mode contribution point:** This is a cost/quality trade-off where your judgment shapes the solution. Options:

- **(A)** Default `none` everywhere, no threading — cheapest, may underperform on extraction.
- **(B)** `high` for extraction, `none` for scenario — balanced, ~2-3× extraction cost.
- **(C)** `xhigh` for extraction, `medium` for scenario — maximum quality, highest cost (the hackathon is over, so cost isn't binding; this may actually be right for the recovery push).

Recommendation: **(B)**. Extraction is the bottleneck; scenario-gen quality was not a post-mortem issue.

- [ ] **Step 6: Smoke-test the live pipeline**

Run: `pnpm run run -- credit-card-agreement`
Expected: runs to completion, meta.json now reflects a `gpt-5.4`-produced IR. Spot-check that fee amounts are non-zero and `semanticTag` values match the closed vocabulary from Task 3.

- [ ] **Step 7: Commit**

```bash
git add .env.example src/llm/openai-json.ts src/pipeline/generate-scenario.ts README.md
git commit -m "feat(llm): upgrade default model from gpt-5-mini to gpt-5.4

gpt-5.4 frontier model with 1.05M context and reasoning-effort
support. Paired with the Task 3 prompt rewrite because the right
move is to iterate the final prompt on the final model. Removes
the stale 128K context-window comment in generate-scenario.ts.

Addresses POSTMORTEM.md root cause #9."
```

---

## Task 4: Enforce `semanticTag` as a Closed Contract

**Why it matters:** The executor dispatches on `semanticTag` strings. If the LLM drifts (`"late-payment-fee"`, `"late_fee"`, empty), the executor silently finds nothing and charges $0.00. Today there is no runtime check. Even with Task 3's prompt hardening, validation + one repair retry is cheap insurance.

**Files:**
- Modify: `src/types/ir.ts` (add `KNOWN_SEMANTIC_TAGS`)
- Create: `src/pipeline/semantic-tag-validator.ts`
- Create: `src/pipeline/semantic-tag-validator.test.ts`
- Modify: `src/pipeline/extract-ir.ts` (call validator after normalization)
- Modify: `src/core/executor.ts`, `src/pipeline/archetypes.ts` (use the constant, not string literals)

- [ ] **Step 1: Define the vocabulary constant**

Add to `src/types/ir.ts`, near the `semanticTag` field definition:

```ts
/**
 * Closed vocabulary of semanticTags the executor recognizes.
 * Extractor output is validated against this list; unknown tags are
 * coerced to "unmodeled_section" after a single repair retry.
 */
export const KNOWN_SEMANTIC_TAGS = [
  // credit-card archetype
  "late_payment_fee",
  "over_limit_fee",
  "returned_payment_fee",
  "foreign_transaction_fee",
  "minimum_payment_obligation",
  "minimum_payment_formula",
  "credit_limit_obligation",
  "illegal_use_default",
  // lease archetype
  "rent_obligation",
  "base_rent",
  "tenant_default",
  // meta
  "unmodeled_section",
  "unmodeled_summary",
  "untagged",
] as const;

export type KnownSemanticTag = (typeof KNOWN_SEMANTIC_TAGS)[number];

export function isKnownSemanticTag(tag: string): tag is KnownSemanticTag {
  return (KNOWN_SEMANTIC_TAGS as readonly string[]).includes(tag);
}
```

- [ ] **Step 2: Write the validator failing test**

```ts
// src/pipeline/semantic-tag-validator.test.ts
import { describe, it, expect } from "vitest";
import { findUnknownSemanticTags } from "./semantic-tag-validator.js";
import type { Clause } from "../types/ir.js";

const mkClause = (id: string, tag: string): Clause => ({
  id,
  title: id,
  sourceText: "",
  modeled: true,
  semanticTag: tag,
  effect: { kind: "unmodeled" },
});

describe("findUnknownSemanticTags", () => {
  it("returns empty when all tags are known", () => {
    expect(
      findUnknownSemanticTags([mkClause("a", "late_payment_fee"), mkClause("b", "rent_obligation")]),
    ).toEqual([]);
  });

  it("lists clauses with unknown tags", () => {
    const clauses = [
      mkClause("a", "late_payment_fee"),
      mkClause("b", "late-payment-fee"), // hyphenated drift
      mkClause("c", "mystery_tag"),
    ];
    expect(findUnknownSemanticTags(clauses)).toEqual([
      { clauseId: "b", tag: "late-payment-fee" },
      { clauseId: "c", tag: "mystery_tag" },
    ]);
  });
});
```

- [ ] **Step 3: Run — verify failure**

Run: `pnpm vitest run src/pipeline/semantic-tag-validator.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the validator**

```ts
// src/pipeline/semantic-tag-validator.ts
import type { Clause } from "../types/ir.js";
import { isKnownSemanticTag } from "../types/ir.js";

export interface UnknownTag {
  clauseId: string;
  tag: string;
}

export function findUnknownSemanticTags(clauses: Clause[]): UnknownTag[] {
  const out: UnknownTag[] = [];
  for (const clause of clauses) {
    if (!isKnownSemanticTag(clause.semanticTag)) {
      out.push({ clauseId: clause.id, tag: clause.semanticTag });
    }
  }
  return out;
}
```

- [ ] **Step 5: Run — verify pass**

Run: `pnpm vitest run src/pipeline/semantic-tag-validator.test.ts`
Expected: PASS (2/2).

- [ ] **Step 6: Wire into the extractor with one repair retry**

In `src/pipeline/extract-ir.ts`, after `normalizeIr(...)` produces the IR, check for unknown tags. If any exist, call the LLM once more with a repair prompt including the offending clause IDs and the known vocabulary. If the retry still returns unknowns, coerce them to `"unmodeled_section"` and set `modeled: false` on those clauses.

```ts
// Pseudocode — place after normalizeIr() inside extractIr()
const ir = normalizeIr(llmResult, options.sourceFile, options.contractText);
const unknown = findUnknownSemanticTags(ir.clauses);
if (unknown.length > 0) {
  const repairPrompt = buildTagRepairPrompt(ir, unknown); // short: lists unknowns + vocab
  const repaired = await callOpenAIJson<unknown>({
    systemPrompt: loadPrompt("prompts/ir-extraction.md"),
    userPrompt: repairPrompt,
    schema: irJsonSchema,
  });
  const repairedIr = normalizeIr(repaired, options.sourceFile, options.contractText);
  // Coerce any remaining unknowns
  for (const clause of repairedIr.clauses) {
    if (!isKnownSemanticTag(clause.semanticTag)) {
      clause.semanticTag = "unmodeled_section";
      clause.modeled = false;
    }
  }
  return repairedIr;
}
return ir;
```

Author `buildTagRepairPrompt` inline in `extract-ir.ts` — it needs the clause IDs with bad tags and the list of `KNOWN_SEMANTIC_TAGS`.

- [ ] **Step 7: Replace string literals in executor + archetypes with the constant**

In `src/core/executor.ts` and `src/pipeline/archetypes.ts`, every `"late_payment_fee"` / `"rent_obligation"` / etc. literal becomes a reference to the type-safe constant. Purely mechanical — catches a typo future-you will make.

Example:
```ts
// before
(c) => isPaymentClause(c) && c.semanticTag === "late_payment_fee"
// after
import type { KnownSemanticTag } from "../types/ir.js";
const LATE_FEE: KnownSemanticTag = "late_payment_fee";
(c) => isPaymentClause(c) && c.semanticTag === LATE_FEE
```

(Or just `c.semanticTag === ("late_payment_fee" satisfies KnownSemanticTag)` inline — either is fine, pick one and stay consistent.)

- [ ] **Step 8: Run full test suite**

Run: `pnpm test`
Expected: All passing tests continue to pass. No new skips.

- [ ] **Step 9: Commit**

```bash
git add src/types/ir.ts src/pipeline/semantic-tag-validator.ts \
        src/pipeline/semantic-tag-validator.test.ts \
        src/pipeline/extract-ir.ts src/core/executor.ts src/pipeline/archetypes.ts
git commit -m "feat(extractor): enforce semanticTag closed vocabulary with repair retry

Introduces KNOWN_SEMANTIC_TAGS as the single source of truth shared by
extractor + executor + archetypes. After normalization, any unknown tag
triggers a one-shot LLM repair; remaining drift is coerced to
unmodeled_section + modeled:false, preventing silent \$0.00-fee failures."
```

---

## Task 5: Delete Dead Code + Regenerate Committed Artifacts

**Why it matters:** Committed `out/credit-card-agreement/meta.json` says `mode: heuristic_fallback`, but `heuristicFallbackIr` is never called and `--no-llm` throws. A judge cloning the repo gets a different, worse artifact than what's committed. Demo drift.

**Files:**
- Modify: `src/pipeline/extract-ir.ts` (delete `heuristicFallbackIr` and helpers if unused)
- Delete (regenerate): `out/credit-card-agreement/**`, `out/galleria-atlanta-*/**`

- [ ] **Step 1: Verify `heuristicFallbackIr` is dead**

Run: Grep `heuristicFallbackIr` across `src/`.

```
# pseudo-command — use the Grep tool
pattern: heuristicFallbackIr
path:    src/
```

Expected: only the definition at `extract-ir.ts:479`, no call sites.

- [ ] **Step 2: Delete `heuristicFallbackIr` and any exclusively-used helpers**

Remove the function and helpers it uses that aren't referenced elsewhere (`extractLeaseMonthlyRent`, `extractIssuerName`, etc. — check each). Run `pnpm run build` or `pnpm tsc --noEmit` after to catch any stragglers.

- [ ] **Step 3: Regenerate the two working contracts with live LLM**

Run: `pnpm run run -- credit-card-agreement && pnpm run run -- galleria-atlanta-office-lease-american-safety-insurance-2006`
Expected: Fresh `out/credit-card-agreement/meta.json` with `mode: "llm"`. Execution ledgers populated with real numbers (non-zero fees, non-empty obligation list).

- [ ] **Step 4: Eyeball diff**

Run: `git diff --stat out/`
Expected: Changes in `meta.json` (`mode: heuristic_fallback` → `mode: llm`), `ir.json` (richer semanticTags), `english.txt` (bodies rendered from effect per Task 1). If numbers dropped — e.g. fees went to \$0.00 — that means Task 3's prompt rewrite didn't land well enough; stop and iterate the prompt before committing.

- [ ] **Step 5: Commit**

```bash
git add -A src/pipeline/extract-ir.ts out/
git commit -m "chore: remove heuristicFallbackIr dead code; regenerate artifacts from live LLM

The committed out/ cache was produced by a dead code path
(heuristic_fallback) that --no-llm hasn't supported for weeks. Replaces
it with a faithful live-LLM run so the repo's committed demo matches
what a judge reproduces from a clean clone."
```

---

## Task 6: Record-Fixture Mode for the 5 Skipped Tests

**Why it matters:** `pnpm test` reports 24 passed / 5 skipped. The skipped tests are exactly the ones that would catch extractor regressions. Skipping on missing API key means no regression signal in CI.

**Files:**
- Create: `src/util/llm-recorder.ts`
- Create: `tests/fixtures/llm/` (recorded JSON per test)
- Modify: 5 test files (`extractor.test.ts`, `scenario.test.ts`, etc. — find with grep)

**Learning-mode contribution point:** Record-vs-replay has a meaningful design choice: do we key fixtures by **prompt hash** (automatic, fragile across prompt edits) or by **test name** (manual, stable but easy to desync)? Decide which fits this repo's cadence.

Recommendation: **test name**. Prompts are going to change as Task 3 iterates; a hash-keyed fixture would invalidate on every prompt tweak. Test-name keying gives the human a checkpoint — when a fixture no longer matches the prompt, the test fails loudly and you re-record intentionally.

- [ ] **Step 1: Find the 5 skipping tests**

Run: Grep for `OPENAI_API_KEY` or `describe.skipIf` / `it.skipIf` patterns across `tests/` and `src/**/*.test.ts`.

```
# pseudo-command
pattern: OPENAI_API_KEY
path:    src tests
```

List them explicitly in your task notes before writing code.

- [ ] **Step 2: Implement the recorder/replayer**

```ts
// src/util/llm-recorder.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callOpenAIJson as realCall } from "./openai.js"; // actual path per repo

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const fixtureDir = resolve(repoRoot, "tests", "fixtures", "llm");

export type Mode = "record" | "replay" | "live";

export function resolveMode(): Mode {
  const m = process.env.LLM_RECORD_MODE;
  if (m === "record" || m === "replay" || m === "live") return m;
  return process.env.OPENAI_API_KEY ? "live" : "replay";
}

export async function recordedCallOpenAIJson<T>(
  testKey: string,
  args: Parameters<typeof realCall<T>>[0],
): Promise<T> {
  const mode = resolveMode();
  const path = resolve(fixtureDir, `${testKey}.json`);
  if (mode === "replay") {
    if (!existsSync(path)) {
      throw new Error(
        `recordedCallOpenAIJson: no fixture for ${testKey} at ${path}. Run with LLM_RECORD_MODE=record to create one.`,
      );
    }
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }
  const result = await realCall<T>(args);
  if (mode === "record") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
  }
  return result;
}
```

- [ ] **Step 3: Rewrite skipping tests to call `recordedCallOpenAIJson`**

For each of the 5, swap the `callOpenAIJson` import for the recorded version and add a `testKey` per test. Remove the `skipIf` guard entirely — replay mode is the default when no API key is set, so CI just works.

- [ ] **Step 4: Generate fixtures (once, locally, with the key)**

Run: `LLM_RECORD_MODE=record OPENAI_API_KEY=sk-... pnpm test`
Expected: `tests/fixtures/llm/*.json` populated. Commit them.

- [ ] **Step 5: Verify replay works with no key**

Run: `unset OPENAI_API_KEY && pnpm test`
Expected: 29 tests, **0 skipped**, all passing.

- [ ] **Step 6: Commit**

```bash
git add src/util/llm-recorder.ts tests/fixtures/llm/ \
        src/**/*.test.ts tests/
git commit -m "test: replace skipIf(OPENAI_API_KEY) with recorded-fixture mode

The 5 tests previously skipped when no API key was present now run
by replaying recorded LLM responses from tests/fixtures/llm/. Set
LLM_RECORD_MODE=record (with a key) to regenerate. CI now exercises
the live pipeline shape on every commit."
```

---

## Task 7: Fix Expectations Framework (Realign Contract IDs)

**Why it matters:** `pnpm run check:expectations` reports 0% because 6 of 7 `expectations/*.yaml` have `contractId` fields that don't match cached `out/<dir>/` names. The team's own self-test is silent because it can't find its inputs.

**Files:**
- Modify: `expectations/*.yaml` (6 files)
- Verify: `scripts/check-expectations.ts` reads them correctly

- [ ] **Step 1: Inventory mismatches**

For each yaml file in `expectations/`, read the `contractId` field. For each `out/<dir>/` with an `ir.json`, note the dir name. List pairs that should match but don't.

- [ ] **Step 2: Realign the yaml**

Pick one direction (recommended: rename the `contractId` in yaml to match the cached dir name, not the other way around — `out/` dir names are load-bearing for the viewer and other scripts).

Edit each of the 6 yaml files. E.g., `expectations/westex-visa-credit-card-agreement.yaml`:

```yaml
# before
contractId: westex-visa-credit-card-agreement
# after
contractId: credit-card-agreement
```

Do the analogous change for each of the other 5.

- [ ] **Step 3: Run the checker**

Run: `pnpm run check:expectations` (with `OPENAI_API_KEY` set — note: the checker errors on missing key; a follow-up could use the Task 6 recorder here too, but it's out of scope for this plan).
Expected: All 7 contracts evaluated, not just 1. Pass rates will still be low because extraction is still weak on most families — that's the *signal*, not the failure. If Task 3's prompt rewrite moved the needle, pass rates should be >0% on at least credit-card and lease.

- [ ] **Step 4: Commit**

```bash
git add expectations/
git commit -m "fix(expectations): realign yaml contractIds to match cached out/ dir names

The check-expectations framework could only find 1 of 7 contracts
because yaml contractIds drifted from cached output dir names. Score
rates are still low on weak-extraction families, but the framework
is now actually running on all 7 — which is the point."
```

---

## Task 8: Cross-Contract Audit — Prove It Moved the Needle

**Why it matters:** The post-mortem's §1 audit table is the measuring stick. Re-run it after Tasks 1-7 to confirm we improved the default experience.

**Files:**
- No new code. Use the existing `out/_audit/*` harness.

- [ ] **Step 1: Regenerate `_audit`**

Identify the audit harness (grep for `_audit` in `scripts/` or `src/`).

Run: whichever pnpm script produces `out/_audit/`.
Expected: Fresh per-contract stats.

- [ ] **Step 2: Build the audit table**

Produce a markdown table identical in shape to the post-mortem's §1:

| Contract | Modeled clauses | Archetypes run | Obligation events |

Capture it in a file — **suggested location:** `POSTMORTEM.md` as a "§10 Recovery checkpoint" appendix, or a new `RECOVERY.md`. User choice.

- [ ] **Step 3: Compare**

On at least 3 of the 5 previously-failing contracts (ORBCOMM, Masterworks, OneAmerica, Sequa, A-Plus), modeled-clause count should now be ≥3 (was 0). If fewer than 3 contracts improved, loop back to Task 3 and iterate the prompt.

- [ ] **Step 4: Commit**

```bash
git add POSTMORTEM.md out/_audit/
git commit -m "docs: record recovery checkpoint — cross-contract audit after fixes

Re-runs the §1 audit from POSTMORTEM.md after Tasks 1-7 to demonstrate
the modeled-clause count lift on previously-failing contracts."
```

---

## Self-Review

**Spec coverage:**
- Post-mortem §3 root cause #1 (decompiler sourceText) → Task 1 ✓
- Root cause #2 (prompt thin + inlined) → Tasks 2 + 3 ✓
- Root cause #3 (semanticTag unenforced) → Task 4 ✓
- Root cause #4 (committed artifacts from dead code) → Task 5 ✓
- Root cause #5 (tests skip on missing key) → Task 6 ✓
- Root cause #6 (two hard-coded families, no generalization path) → **deferred**, called out as non-goal.
- Root cause #7 (definitions/cross-refs unresolved) → **deferred**, called out as non-goal.
- Root cause #8 (temporal nuance unused) → **deferred**, called out as non-goal.
- Root cause #9 (model choice never revisited) → Task 3b ✓
- Root cause #10 (plan deferred biggest problem) → this plan directly attacks the biggest problem.
- User-added item: remove Next.js distraction → Task 0 ✓
- §7 expectations checker 0% pass rate → Task 7 ✓
- §1 audit regeneration → Task 8 ✓

**Placeholder scan:** No "TBD", no "implement later", no bare "similar to Task N". Each step has either concrete code, a concrete command, or a concrete editorial instruction.

**Type consistency:** `KNOWN_SEMANTIC_TAGS` defined in Task 4, consumed by executor in same task. `loadPrompt` signature matches across Tasks 2 and 6. `recordedCallOpenAIJson` introduced in Task 6 is only called from tests (Task 6 scope), so no downstream drift.

**One known looseness:** Task 6 calls `realCall` from `./openai.js` as a placeholder path; the actual repo path for `callOpenAIJson` needs a one-line grep when implementing (likely `src/util/openai.ts` or `src/util/llm.ts` per the codebase).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-13-postmortem-recovery.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best when you want the plan executed with minimal oversight and good per-task review.

2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Best when you want to be hands-on through each task.

Which approach?
