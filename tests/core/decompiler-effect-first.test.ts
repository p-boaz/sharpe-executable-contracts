import { test } from "node:test";
import assert from "node:assert/strict";
import { decompileIrToEnglish } from "../../src/core/decompiler.js";
import type { ContractIR } from "../../src/types/ir.js";

// Minimal ContractIR builder for decompiler tests. Only the fields that
// clauseParagraph and decompileIrToEnglish read are populated.
function makeIr(overrides: Partial<ContractIR["clauses"][number]>): ContractIR {
  return {
    contractId: "test-contract",
    title: "Test Contract",
    currency: "USD",
    parties: [],
    definitions: [],
    clauses: [
      {
        id: "clause.payment.min",
        title: "Minimum Payment",
        sourceText: "ORIGINAL MARKDOWN TEXT THAT SHOULD NOT BE THE BODY.",
        modeled: true,
        semanticTag: "minimum_payment",
        effect: {
          kind: "payment",
          payer: "party-cardholder",
          payee: "party-issuer",
          amount: { op: "const", value: 25 },
        },
        ...overrides,
      },
    ],
    metadata: {
      sourceFile: "test.md",
      extractionHash: "abc123",
      extractorVersion: "1.0.0",
      clauseCount: 1,
      modeledClauseCount: 1,
      extraction: {
        llmRequested: true,
        llmUsed: true,
        mode: "llm",
      },
    },
  };
}

test("decompiler: body is rendered from effect, not verbatim sourceText", () => {
  const ir = makeIr({});
  const output = decompileIrToEnglish(ir);

  // effectToText for { kind: "payment", payer: "party-cardholder", payee: "party-issuer",
  //   amount: { op: "const", value: 25 } } produces:
  //   "party-cardholder pays party-issuer 25"
  assert.match(
    output,
    /party-cardholder pays party-issuer 25/,
    "output must contain the effect-derived body",
  );

  // The effect body line must NOT be the raw sourceText. We confirm by checking
  // that "party-cardholder pays" appears on its own line (not surrounded by
  // source text markers), and that the body section doesn't lead with the
  // all-caps marker text. The sourceText may appear as a secondary citation
  // but must not be the primary body.
  assert.doesNotMatch(
    output,
    /^ORIGINAL MARKDOWN TEXT/m,
    "sourceText must not appear as a standalone body line",
  );
});

test("decompiler: sourceText is preserved as a citation, not the body", () => {
  const ir = makeIr({
    sourceText: "Cardholder shall pay $25.",
    sourceSpan: { start: 10, end: 34 },
  });
  const output = decompileIrToEnglish(ir);

  // Effect-derived body must appear
  assert.match(
    output,
    /party-cardholder pays party-issuer 25/,
    "output must contain the effect-derived body",
  );

  // sourceText must appear as a parenthetical citation, not as the body
  assert.match(
    output,
    /\(source text: "Cardholder shall pay \$25\."\)/,
    'output must contain sourceText as (source text: "...") parenthetical',
  );

  // citationFor helper emits "source: chars <start>–<end>"
  assert.match(
    output,
    /source: chars 10/,
    "output must contain the source-span citation",
  );
});
