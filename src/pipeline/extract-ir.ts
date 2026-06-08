import { createHash } from "node:crypto";
import { z } from "zod";
import { callOpenAIJson } from "../llm/openai-json.js";
import { loadPrompt } from "../util/load-prompt.js";
import { findUnknownSemanticTags, buildTagRepairPrompt } from "./semantic-tag-validator.js";
import { KNOWN_SEMANTIC_TAGS, isKnownSemanticTag } from "../types/ir.js";
import type {
  AccumulationUnit,
  BoolExpr,
  Clause,
  ContractIR,
  Definition,
  Effect,
  Expr,
  SourceSpan,
  TemporalRule,
} from "../types/ir.js";

export interface ExtractIrOptions {
  contractText: string;
  sourceFile: string;
}

const extractorVersion = "contract-ir-v1";
type ContractMetadata = ContractIR["metadata"];
type ExtractionMode = ContractMetadata["extraction"]["mode"];

const IrTopSchema = z.object({
  contractId: z.string().min(1),
  title: z.string().min(1),
  jurisdiction: z.string().optional(),
  // Default to USD when the LLM omits or empties currency: many contracts
  // (securities exchanges, service agreements) don't state one explicitly.
  // Rejecting the whole IR is worse than a defaulted USD with a warning.
  currency: z.string().optional().default(""),
  parties: z.array(
    z.object({
      id: z.string().min(1),
      role: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
  definitions: z.array(
    z.object({
      id: z.string().min(1),
      term: z.string().min(1),
      meaning: z.string().min(1),
      sourceText: z.string().min(1),
    }),
  ),
  clauses: z.array(
    z
      .object({
        id: z.string().min(1),
        title: z.string().min(1),
        sourceText: z.string().min(1),
        modeled: z.boolean(),
        // Default "unmodeled_section" if the LLM omits the tag — normalizer still
        // coerces, so this guards against a hard crash on malformed LLM output
        // and lets the pipeline surface the missing tag rather than 500 out.
        semanticTag: z.string().min(1).optional().default("unmodeled_section"),
      })
      .passthrough(),
  ),
});

const irJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "contractId",
    "title",
    "currency",
    "parties",
    "definitions",
    "clauses",
  ],
  properties: {
    contractId: { type: "string" },
    title: { type: "string" },
    jurisdiction: { type: "string" },
    currency: { type: "string" },
    parties: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "role", "name"],
        properties: {
          id: { type: "string" },
          role: { type: "string" },
          name: { type: "string" },
        },
      },
    },
    definitions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "term", "meaning", "sourceText"],
        properties: {
          id: { type: "string" },
          term: { type: "string" },
          meaning: { type: "string" },
          sourceText: { type: "string" },
        },
      },
    },
    clauses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "title", "sourceText", "modeled", "effect"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          sourceText: { type: "string" },
          modeled: { type: "boolean" },
          semanticTag: { type: "string" },
          // `effect` and `condition` are passed through; the normalizer validates them.
          effect: { type: "object" },
          condition: { type: "object" },
        },
      },
    },
  },
};

interface NormalizedSourceIndex {
  normalized: string;
  rawByNormalized: number[];
}

function buildNormalizedSourceIndex(text: string): NormalizedSourceIndex {
  const normalizedChars: string[] = [];
  const rawByNormalized: number[] = [];
  let lastWasSpace = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char == null) continue;
    if (/\s/.test(char)) {
      if (!lastWasSpace && normalizedChars.length > 0) {
        normalizedChars.push(" ");
        rawByNormalized.push(i);
      }
      lastWasSpace = true;
      continue;
    }

    normalizedChars.push(char);
    rawByNormalized.push(i);
    lastWasSpace = false;
  }

  if (normalizedChars[normalizedChars.length - 1] === " ") {
    normalizedChars.pop();
    rawByNormalized.pop();
  }

  return {
    normalized: normalizedChars.join(""),
    rawByNormalized,
  };
}

function normalizeSourceSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function attachSourceSpans(contractText: string, clauses: Clause[]): Clause[] {
  const index = buildNormalizedSourceIndex(contractText);
  let searchFrom = 0;

  return clauses.map((clause) => {
    if (clause.sourceSpan) return clause;

    const snippet = normalizeSourceSnippet(clause.sourceText);
    if (!snippet) return clause;

    let normalizedStart = index.normalized.indexOf(snippet, searchFrom);
    if (normalizedStart < 0) {
      normalizedStart = index.normalized.indexOf(snippet);
    }
    if (normalizedStart < 0) return clause;

    const normalizedEnd = normalizedStart + snippet.length - 1;
    const rawStart = index.rawByNormalized[normalizedStart];
    const rawEnd = index.rawByNormalized[normalizedEnd];
    if (rawStart == null || rawEnd == null) return clause;

    searchFrom = normalizedStart + snippet.length;
    return {
      ...clause,
      sourceSpan: {
        start: rawStart,
        end: rawEnd + 1,
      },
    };
  });
}

function normalizeContractText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function extractionHashFor(text: string, sourceFile: string): string {
  return createHash("sha256")
    .update(`${extractorVersion}\n${sourceFile}\n${normalizeContractText(text)}`)
    .digest("hex");
}

function buildMetadata(
  text: string,
  sourceFile: string,
  clauses: Clause[],
  extractionMode: ExtractionMode,
  extractionWarnings: string[] = [],
): ContractMetadata {
  const llmUsed = extractionMode === "llm";
  return {
    sourceFile,
    extractionHash: extractionHashFor(text, sourceFile),
    extractorVersion,
    clauseCount: clauses.length,
    modeledClauseCount: clauses.filter((clause) => clause.modeled).length,
    extraction: {
      llmRequested: llmUsed,
      llmUsed,
      mode: extractionMode,
    },
    ...(extractionWarnings.length > 0 ? { extractionWarnings } : {}),
  };
}

function normalizeSourceSpan(raw: unknown): SourceSpan | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  const start = candidate.start;
  const end = candidate.end;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  if ((start as number) < 0 || (end as number) < (start as number)) return undefined;
  return { start: start as number, end: end as number };
}

function normalizeTemporalRule(raw: unknown, depth = 0): TemporalRule {
  if (raw && typeof raw === "object" && depth < 3) {
    const candidate = raw as Record<string, unknown>;
    const type = candidate.type;
    const value = candidate.value;
    const isValidType =
      type === "calendar_days" ||
      type === "business_days" ||
      type === "months" ||
      type === "years" ||
      type === "on_date";
    const isValidValue = typeof value === "string" || typeof value === "number";
    if (isValidType && isValidValue) {
      const anchor = candidate.anchor;
      const directionRaw = candidate.direction;
      const direction: TemporalRule["direction"] | undefined =
        directionRaw === "before" || directionRaw === "after" ? directionRaw : undefined;
      const graceAfter =
        candidate.graceAfter && typeof candidate.graceAfter === "object"
          ? normalizeTemporalRule(candidate.graceAfter, depth + 1)
          : undefined;
      return {
        type,
        value,
        ...(typeof anchor === "string" && anchor ? { anchor } : {}),
        ...(direction ? { direction } : {}),
        ...(graceAfter ? { graceAfter } : {}),
      };
    }
  }
  return { type: "on_date", value: "see_source_text" };
}

// `warnings` / `path` are threaded through so that every silent-zero
// fallback becomes visible in metadata.extractionWarnings. Without this,
// malformed LLM output (e.g. bare numbers, missing `op`) would collapse
// to {op:"const",value:0} and execute as $0 with no trace.
function normalizeExpr(raw: unknown, warnings: string[], path: string, depth = 0): Expr {
  const fallback = (reason: string): Expr => {
    warnings.push(`${path}: ${reason}; defaulting to {op:const,value:0}`);
    return { op: "const", value: 0 };
  };

  if (!raw || typeof raw !== "object") {
    return fallback("missing or non-object Expr");
  }
  if (depth > 4) {
    return fallback("Expr nesting exceeds max depth (4)");
  }
  const candidate = raw as Record<string, unknown>;
  const op = candidate.op;
  if (
    op !== "const" &&
    op !== "var" &&
    op !== "add" &&
    op !== "sub" &&
    op !== "mul" &&
    op !== "div" &&
    op !== "max" &&
    op !== "min"
  ) {
    return fallback(`unknown Expr op ${JSON.stringify(op)}`);
  }

  if (op === "const") {
    const value = candidate.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback(`const Expr missing numeric value (got ${JSON.stringify(value)})`);
    }
    return { op: "const", value };
  }
  if (op === "var") {
    return {
      op: "var",
      name: typeof candidate.name === "string" && candidate.name ? candidate.name : "var",
    };
  }

  const args = Array.isArray(candidate.args)
    ? candidate.args.map((item, i) =>
        normalizeExpr(item, warnings, `${path}.args[${i}]`, depth + 1),
      )
    : [];
  return {
    op,
    args,
  };
}

function normalizeBoolOperand(
  raw: unknown,
  depth: number,
): string | number | boolean | BoolExpr | undefined {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return raw;
  }
  return normalizeBoolExpr(raw, depth + 1);
}

function normalizeBoolExpr(raw: unknown, depth = 0): BoolExpr | undefined {
  if (!raw || typeof raw !== "object" || depth > 4) return undefined;
  const candidate = raw as Record<string, unknown>;
  const op = candidate.op;
  if (
    op !== "eq" &&
    op !== "neq" &&
    op !== "gt" &&
    op !== "gte" &&
    op !== "lt" &&
    op !== "lte" &&
    op !== "and" &&
    op !== "or" &&
    op !== "not"
  ) {
    return undefined;
  }

  if (op === "and" || op === "or") {
    const args = Array.isArray(candidate.args)
      ? candidate.args
          .map((item) => normalizeBoolExpr(item, depth + 1))
          .filter((item): item is BoolExpr => item != null)
      : [];
    if (args.length === 0) return undefined;
    return { op, args };
  }

  if (op === "not") {
    const args = Array.isArray(candidate.args)
      ? candidate.args
          .map((item) => normalizeBoolExpr(item, depth + 1))
          .filter((item): item is BoolExpr => item != null)
      : [];
    if (args.length !== 1) return undefined;
    return { op, args };
  }

  const left = normalizeBoolOperand(candidate.left, depth);
  const right = normalizeBoolOperand(candidate.right, depth);

  if (left == null || right == null) return undefined;
  return {
    op,
    left,
    right,
  };
}

const ACCUMULATION_UNITS: AccumulationUnit[] = [
  "day",
  "month",
  "year",
  "kg",
  "watt",
  "usd_raised",
  "unit",
];

function normalizeEffect(
  rawClause: Record<string, unknown>,
  warnings: string[],
  clauseId: string,
): Effect {
  const rawEffect = rawClause.effect;
  if (!rawEffect || typeof rawEffect !== "object") {
    // Legacy or malformed clauses fall through to unmodeled.
    return { kind: "unmodeled" };
  }
  const candidate = rawEffect as Record<string, unknown>;
  const kind = candidate.kind;
  const path = `${clauseId}.effect`;

  if (kind === "payment") {
    const assetKind = typeof candidate.assetKind === "string" ? candidate.assetKind : undefined;
    const cap =
      candidate.cap && typeof candidate.cap === "object"
        ? normalizeExpr(candidate.cap, warnings, `${path}.cap`)
        : undefined;
    return {
      kind: "payment",
      payer: String(candidate.payer || "party"),
      payee: String(candidate.payee || "counterparty"),
      amount: normalizeExpr(candidate.amount, warnings, `${path}.amount`),
      ...(cap ? { cap } : {}),
      ...(assetKind ? { assetKind } : {}),
    };
  }

  if (kind === "obligation") {
    const due =
      candidate.due && typeof candidate.due === "object"
        ? normalizeTemporalRule(candidate.due)
        : undefined;
    const curePeriod =
      candidate.curePeriod && typeof candidate.curePeriod === "object"
        ? normalizeTemporalRule(candidate.curePeriod)
        : undefined;
    return {
      kind: "obligation",
      actor: String(candidate.actor || "party"),
      action: String(candidate.action || "Perform obligation"),
      ...(due ? { due } : {}),
      ...(curePeriod ? { curePeriod } : {}),
    };
  }

  if (kind === "formula") {
    const cap =
      candidate.cap && typeof candidate.cap === "object"
        ? normalizeExpr(candidate.cap, warnings, `${path}.cap`)
        : undefined;
    return {
      kind: "formula",
      outputVar: String(candidate.outputVar || "derived_value"),
      expr: normalizeExpr(candidate.expr, warnings, `${path}.expr`),
      ...(cap ? { cap } : {}),
    };
  }

  if (kind === "accumulation") {
    const per = ACCUMULATION_UNITS.includes(candidate.per as AccumulationUnit)
      ? (candidate.per as AccumulationUnit)
      : "day";
    const cap =
      candidate.cap && typeof candidate.cap === "object"
        ? normalizeExpr(candidate.cap, warnings, `${path}.cap`)
        : undefined;
    return {
      kind: "accumulation",
      per,
      rate: normalizeExpr(candidate.rate, warnings, `${path}.rate`),
      ...(cap ? { cap } : {}),
    };
  }

  if (kind === "indemnification") {
    return {
      kind: "indemnification",
      indemnifier: String(candidate.indemnifier || "party"),
      indemnitee: String(candidate.indemnitee || "counterparty"),
      scope: String(candidate.scope || "see source text"),
      carveOuts: Array.isArray(candidate.carveOuts)
        ? candidate.carveOuts.map((v) => String(v))
        : [],
    };
  }

  if (kind === "default") {
    return {
      kind: "default",
      consequences: Array.isArray(candidate.consequences)
        ? candidate.consequences.map((v) => String(v))
        : [],
    };
  }

  return { kind: "unmodeled" };
}

function normalizeClause(rawClause: Record<string, unknown>, warnings: string[]): Clause {
  const sourceSpan = normalizeSourceSpan(rawClause.sourceSpan);
  const condition = normalizeBoolExpr(rawClause.condition);
  const semanticTag =
    typeof rawClause.semanticTag === "string" && rawClause.semanticTag
      ? rawClause.semanticTag
      : "unmodeled_section";
  const clauseId = String(rawClause.id);
  const rawModeled = Boolean(rawClause.modeled);
  // Honest-posture coercion: an "unmodeled_section" tag means the extractor
  // couldn't pick a real slot in the closed vocab. A modeled:true flag on
  // top of that is self-contradictory — the executor has nothing to dispatch
  // on. Coerce to modeled:false so downstream ledgers/English reflect reality.
  const modeled = rawModeled && semanticTag !== "unmodeled_section";
  if (rawModeled && !modeled) {
    warnings.push(
      `${clauseId}: modeled=true with semanticTag=unmodeled_section; coerced to modeled=false`,
    );
  }
  return {
    id: clauseId,
    title: String(rawClause.title),
    sourceText: String(rawClause.sourceText),
    ...(sourceSpan ? { sourceSpan } : {}),
    modeled,
    semanticTag,
    ...(condition ? { condition } : {}),
    effect: normalizeEffect(rawClause, warnings, clauseId),
  };
}

function normalizeIr(raw: unknown, sourceFile: string, contractText: string): ContractIR {
  const parsed = IrTopSchema.parse(raw);
  const warnings: string[] = [];
  const clauses = parsed.clauses.map((c) => normalizeClause(c, warnings));
  const clausesWithSpans = attachSourceSpans(contractText, clauses);

  let currency = parsed.currency.trim();
  if (!currency) {
    warnings.push("currency: LLM omitted or empty; defaulting to USD");
    currency = "USD";
  }

  return {
    contractId: parsed.contractId,
    title: parsed.title,
    currency,
    parties: parsed.parties,
    definitions: parsed.definitions,
    clauses: clausesWithSpans,
    ...(parsed.jurisdiction ? { jurisdiction: parsed.jurisdiction } : {}),
    metadata: buildMetadata(contractText, sourceFile, clausesWithSpans, "llm", warnings),
  };
}

export async function extractIr(options: ExtractIrOptions): Promise<ContractIR> {
  const systemPrompt = loadPrompt("prompts/ir-extraction.md");

  const userPrompt = `Source file: ${options.sourceFile}\n\nContract markdown:\n${options.contractText}`;

  try {
    const llmResult = await callOpenAIJson<unknown>({
      systemPrompt,
      userPrompt,
      schema: irJsonSchema,
      // gpt-5.4 with reasoning="high" can exceed Node fetch's 5-min
      // headersTimeout on full contracts + complex schema. "medium" is
      // the cost/quality sweet spot that stays within default timeouts.
      reasoningEffort: "medium",
    });

    const ir = normalizeIr(llmResult, options.sourceFile, options.contractText);

    // Validate semanticTags against the closed vocabulary.
    const unknown = findUnknownSemanticTags(ir.clauses);
    if (unknown.length === 0) {
      return ir;
    }

    console.warn(
      `[extract-ir] semanticTag drift detected (${unknown.length} clause(s)); retrying once. Offenders:`,
      unknown,
    );

    // One repair retry — ask the LLM to fix the offending tags.
    const repairPrompt = buildTagRepairPrompt(unknown, KNOWN_SEMANTIC_TAGS);
    const repairedResult = await callOpenAIJson<unknown>({
      systemPrompt,
      userPrompt: `${userPrompt}\n\n---\nREPAIR INSTRUCTIONS:\n${repairPrompt}`,
      schema: irJsonSchema,
      reasoningEffort: "medium",
    });
    const repairedIr = normalizeIr(repairedResult, options.sourceFile, options.contractText);

    // Coerce any remaining unknowns to unmodeled_section.
    const coercedIds: string[] = [];
    for (const clause of repairedIr.clauses) {
      if (!isKnownSemanticTag(clause.semanticTag)) {
        coercedIds.push(`${clause.id} (${clause.semanticTag})`);
        clause.semanticTag = "unmodeled_section";
        clause.modeled = false;
      }
    }
    if (coercedIds.length > 0) {
      console.warn(
        `[extract-ir] coerced ${coercedIds.length} clause(s) to unmodeled_section after repair retry failed. ` +
        `This is the signal the prompt needs tightening. Clauses:`,
        coercedIds,
      );
    }
    return repairedIr;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`IR extraction failed in LLM-required mode: ${message}`);
  }
}
