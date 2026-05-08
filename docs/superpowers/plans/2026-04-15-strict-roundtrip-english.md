# Strict Round-Trip English Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a strict decompilation of `english.txt` that is a pure function of the IR — no inline `(source text: "...")` quotes, no `(source: chars ...)` citations. Leave the current annotated view available as a sidecar file for human inspection.

**Architecture:** All work is in `src/core/decompiler.ts` and the pipeline runner (`src/main.ts` / `src/pipeline/run-pipeline.ts`). The existing `decompileIrToEnglish(ir)` gains a `{ mode: "strict" | "annotated" }` option. The pipeline writes `english.txt` (strict) and `english-annotated.txt` (current behavior) into each `out/<slug>/`.

**Tech Stack:** TypeScript, Node test runner.

**Rationale:** The hackathon rubric scores Round-trip fidelity at 25% and the spec requires English to be "a function of the IR." The current `english.txt` pastes `sourceText` inline for every clause, which means a judge cannot distinguish "the IR reconstructed this" from "we printed the original Markdown back." A strict mode makes the IR's actual fluency observable.

---

## File Structure

- Modify: `src/core/decompiler.ts` — add a mode parameter to `decompileIrToEnglish` and `clauseParagraph`.
- Modify: `src/main.ts` — write both files, default naming keeps strict at `english.txt`.
- Modify: `src/pipeline/run-pipeline.ts` — same as above if decompile is invoked there.
- Create: `tests/decompiler-strict.test.ts` — assert that strict output contains no verbatim substrings from `sourceText`.

---

### Task 1: Add strict mode to `decompileIrToEnglish`

**Files:**
- Modify: `src/core/decompiler.ts` (`clauseParagraph` at ~L122, `decompileIrToEnglish` at ~L146)
- Create: `tests/decompiler-strict.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/decompiler-strict.test.ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { decompileIrToEnglish } from "../src/core/decompiler.js";
import type { ContractIR } from "../src/types/ir.js";

const ir: ContractIR = {
  contractId: "roundtrip-fixture",
  title: "Round-trip fixture",
  currency: "USD",
  jurisdiction: "NY",
  parties: [
    { id: "party-a", name: "Alpha Inc.", role: "buyer" },
    { id: "party-b", name: "Beta LLC", role: "seller" },
  ],
  definitions: [],
  clauses: [
    {
      id: "clause.1.payment",
      title: "1. Payment",
      sourceText:
        "XYZZY-MARKER: Buyer shall pay Seller one thousand dollars ($1,000) within thirty (30) days of delivery.",
      modeled: true,
      semanticTag: "fixed_fee",
      sourceSpan: { start: 0, end: 110 },
      effect: {
        kind: "payment",
        payer: "party-a",
        payee: "party-b",
        amount: { op: "const", value: 1000 },
      },
    },
  ],
  metadata: { clauseCount: 1, modeledClauseCount: 1, sourceFile: "fixture" },
};

test("strict decompile omits inline sourceText and char citations", () => {
  const strict = decompileIrToEnglish(ir, { mode: "strict" });
  assert.equal(strict.includes("XYZZY-MARKER"), false, "sourceText should not appear");
  assert.equal(strict.includes("(source text:"), false, "quoted source must be gone");
  assert.equal(strict.includes("(source: chars"), false, "char citation must be gone");
  // Core IR content still present:
  assert.equal(strict.includes("party-a"), true);
  assert.equal(strict.includes("1000"), true);
});

test("annotated decompile preserves current behavior", () => {
  const annotated = decompileIrToEnglish(ir, { mode: "annotated" });
  assert.equal(annotated.includes("XYZZY-MARKER"), true);
  assert.equal(annotated.includes("(source text:"), true);
});

test("default mode is annotated (back-compat)", () => {
  assert.equal(decompileIrToEnglish(ir), decompileIrToEnglish(ir, { mode: "annotated" }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --test-name-pattern "strict decompile"`
Expected: FAIL — `decompileIrToEnglish` doesn't accept a second argument.

- [ ] **Step 3: Add the mode parameter**

In `src/core/decompiler.ts`:

```ts
export type DecompileMode = "strict" | "annotated";
export interface DecompileOptions { mode?: DecompileMode }

function clauseParagraph(clause: Clause, ir: ContractIR, mode: DecompileMode): string[] {
  const prefix = clause.modeled ? "" : "[UNMODELED] ";
  const titlePart = clause.title ? ` \u2014 ${clause.title}` : "";
  const heading = `${prefix}Clause ${clause.id}${titlePart}`;
  const body = normalizeProse(effectToText(clause.effect));
  const lines = [heading, body];
  if (mode === "annotated") {
    const sourceQuote = normalizeProse(clause.sourceText);
    if (sourceQuote) lines.push(`(source text: "${sourceQuote}")`);
    const citation = citationFor(clause).trimStart();
    if (citation) lines.push(citation);
  }
  const referenced = findReferencedTerms(clause.sourceText, ir);
  if (referenced.length > 0) {
    const terms = referenced.map((d) => `"${d.term}"`).join(", ");
    lines.push(`(defined terms referenced: ${terms})`);
  }
  lines.push("");
  return lines;
}

export function decompileIrToEnglish(ir: ContractIR, opts: DecompileOptions = {}): string {
  const mode = opts.mode ?? "annotated"; // keep default for back-compat
  // ... existing body, passing `mode` through to clauseParagraph ...
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --test-name-pattern "decompile"`
Expected: all three new tests PASS, existing decompiler tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/core/decompiler.ts tests/decompiler-strict.test.ts
git commit -m "feat(decompiler): add strict mode that omits inline sourceText"
```

---

### Task 2: Emit both files from the pipeline

**Files:**
- Modify: `src/main.ts` and/or `src/pipeline/run-pipeline.ts` — wherever `decompileIrToEnglish` is currently called and `english.txt` is written.

- [ ] **Step 1: Locate the current write site**

Run: `grep -rn "decompileIrToEnglish\|english.txt" src/`
Note the caller file and line; Task 2 edits are confined to that one call site.

- [ ] **Step 2: Write the failing test**

```ts
// tests/pipeline.test.ts — append
import { existsSync, readFileSync } from "node:fs";
test("pipeline emits strict english.txt and annotated sidecar", () => {
  // pnpm run run on a fixture contract ahead of this test, or assert
  // against a pre-populated out/ dir for Sequa:
  const base = "out/sequa-employment-agreement-2005";
  const strict = readFileSync(`${base}/english.txt`, "utf8");
  assert.equal(strict.includes("(source text:"), false);
  assert.equal(existsSync(`${base}/english-annotated.txt`), true);
  const annotated = readFileSync(`${base}/english-annotated.txt`, "utf8");
  assert.equal(annotated.includes("(source text:"), true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- --test-name-pattern "strict english.txt"`
Expected: FAIL — `english.txt` currently contains `(source text:` and the sidecar doesn't exist.

- [ ] **Step 4: Update the pipeline write site**

Swap the single `writeFileSync` call for two calls:

```ts
import { decompileIrToEnglish } from "./core/decompiler.js";
// ...
writeFileSync(
  path.join(outDir, "english.txt"),
  decompileIrToEnglish(ir, { mode: "strict" }),
);
writeFileSync(
  path.join(outDir, "english-annotated.txt"),
  decompileIrToEnglish(ir, { mode: "annotated" }),
);
```

- [ ] **Step 5: Regenerate one contract's outputs to verify**

Run: `pnpm run run --contract contracts/Sequa-employment-agreement-2005.md --out out/sequa-employment-agreement-2005`
Open `out/sequa-employment-agreement-2005/english.txt` — should have no `(source text:` and no `(source: chars`. Open `english-annotated.txt` — should match the prior `english.txt` output.

- [ ] **Step 6: Run tests**

Run: `pnpm test`
Expected: PASS. If an existing fixture-replay test asserted on the old `english.txt` format, update the assertion (or point it at `english-annotated.txt`).

- [ ] **Step 7: Commit**

```bash
git add src/main.ts src/pipeline/run-pipeline.ts tests/pipeline.test.ts out/
git commit -m "feat(pipeline): write strict english.txt and annotated sidecar"
```

---

### Task 3: Regenerate all committed contract outputs

**Files:**
- Modify: `out/*/english.txt` and `out/*/english-annotated.txt` (only contracts tracked by `.gitignore`).

- [ ] **Step 1: Identify which contracts are committed**

Run: `git ls-files out/ | grep english | sort`
Note the set; avoid regenerating untracked ones.

- [ ] **Step 2: Re-run each tracked contract**

Run for each slug:
```bash
pnpm run run --contract contracts/<Name>.md --out out/<slug>
```

- [ ] **Step 3: Verify strict outputs**

Run: `grep -l "(source text:" out/*/english.txt`
Expected: empty — no strict file should contain that marker.

- [ ] **Step 4: Commit**

```bash
git add out/
git commit -m "chore: regenerate english outputs under strict+annotated split"
```

---

## Self-review notes

- The plan preserves back-compat: `decompileIrToEnglish(ir)` with no options still returns annotated output, so any internal caller that doesn't pass `mode` keeps working.
- `english-annotated.txt` exists so we don't lose the human-readable sidecar — judges who want to cross-check IR against source still can.
- Task 3 is deliberately narrow: only regenerate contracts already tracked in git, not every `out/` dir (per `.gitignore` note in the repo).
- This plan does **not** touch `decompileExecutionToEnglish` (the execution narrative renderer at `decompiler.ts:223`). If/when the executor correctness plan lands, the execution English will naturally carry the new totals without further changes here.
