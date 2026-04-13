import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { extractIr } from "../src/pipeline/extract-ir.js";
import type { Clause, ContractIR, Expr } from "../src/types/ir.js";

type MatchStatus = "PASS" | "WEAK" | "FAIL";

interface ExpectedClause {
  id: string;
  sourceQuote?: string;
  mustMatch?: Record<string, unknown>;
}

interface ExpectedUnmodeled {
  intent?: string;
  sourceHeading?: string;
  mustAppearAs?: string;
}

interface CoverageTargets {
  critical: string[];
  supporting: string[];
}

interface ExpectationDoc {
  contractId: string;
  contractFile: string;
  expectedClauses: ExpectedClause[];
  expectedUnmodeled: ExpectedUnmodeled[];
  coverageTargets: CoverageTargets;
}

interface CliOptions {
  expectationFiles: string[];
  irRoot: string;
  forceExtract: boolean;
  strictSupporting: boolean;
}

interface ClauseMatch {
  expectationId: string;
  status: MatchStatus;
  matchedClauseId?: string;
  reason: string;
}

interface BucketSummary {
  total: number;
  pass: number;
  weak: number;
  fail: number;
  weightedScore: number;
}

interface ContractSummary {
  contractId: string;
  expectationFile: string;
  irSource: string;
  critical: BucketSummary;
  supporting: BucketSummary;
  unmodeledFound: number;
  unmodeledTotal: number;
  criticalRows: ClauseMatch[];
  supportingRows: ClauseMatch[];
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "such",
  "shall",
  "must",
  "have",
  "under",
  "than",
  "then",
  "they",
  "them",
  "their",
  "upon",
  "your",
  "you",
  "are",
  "was",
  "were",
  "been",
  "being",
  "will",
  "not",
  "any",
  "all",
  "but",
  "can",
  "its",
  "our",
  "his",
  "her",
  "may",
  "has",
  "had",
  "each",
  "per",
  "due",
  "after",
  "before",
  "through",
  "until",
  "without",
]);

function parseArgs(argv: string[]): CliOptions {
  const expectationFiles: string[] = [];
  let irRoot = "out";
  let forceExtract = false;
  let strictSupporting = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--") continue;
    const next = argv[i + 1];

    if (arg === "--extract") {
      forceExtract = true;
      continue;
    }
    if (arg === "--strict-supporting") {
      strictSupporting = true;
      continue;
    }
    if (arg === "--ir-root" && next) {
      irRoot = next;
      i += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      expectationFiles.push(arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    expectationFiles,
    irRoot,
    forceExtract,
    strictSupporting,
  };
}

async function defaultExpectationFiles(repoRoot: string): Promise<string[]> {
  const expectationsDir = path.resolve(repoRoot, "expectations");
  const files = await readdir(expectationsDir);
  return files
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .sort()
    .map((file) => path.resolve(expectationsDir, file));
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function parseExpectationDoc(raw: unknown, filePath: string): ExpectationDoc {
  const obj = asObject(raw);
  if (!obj) throw new Error(`Expectation file is not an object: ${filePath}`);

  const contractId = asString(obj.contractId);
  const contractFile = asString(obj.contractFile);
  if (!contractId) throw new Error(`Missing contractId in ${filePath}`);
  if (!contractFile) throw new Error(`Missing contractFile in ${filePath}`);

  const expectedClauses = Array.isArray(obj.expectedClauses)
    ? obj.expectedClauses
        .map((entry): ExpectedClause | undefined => {
          const clauseObj = asObject(entry);
          if (!clauseObj) return undefined;
          const id = asString(clauseObj.id);
          if (!id) return undefined;
          const sourceQuote = asString(clauseObj.sourceQuote);
          const mustMatch = asObject(clauseObj.mustMatch);
          return {
            id,
            ...(sourceQuote ? { sourceQuote } : {}),
            ...(mustMatch ? { mustMatch } : {}),
          };
        })
        .filter((entry): entry is ExpectedClause => entry != null)
    : [];

  const expectedUnmodeled = Array.isArray(obj.expectedUnmodeled)
    ? obj.expectedUnmodeled
        .map((entry): ExpectedUnmodeled | undefined => {
          const row = asObject(entry);
          if (!row) return undefined;
          return {
            ...(asString(row.intent) ? { intent: asString(row.intent) } : {}),
            ...(asString(row.sourceHeading) ? { sourceHeading: asString(row.sourceHeading) } : {}),
            ...(asString(row.mustAppearAs) ? { mustAppearAs: asString(row.mustAppearAs) } : {}),
          };
        })
        .filter((entry): entry is ExpectedUnmodeled => entry != null)
    : [];

  const coverageObj = asObject(obj.coverageTargets);
  const coverageTargets: CoverageTargets = {
    critical: asStringArray(coverageObj?.critical),
    supporting: asStringArray(coverageObj?.supporting),
  };

  return { contractId, contractFile, expectedClauses, expectedUnmodeled, coverageTargets };
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number(value).toString();
}

function exprShape(expr: Expr): string {
  if (expr.op === "const") {
    return `const(${canonicalNumber(typeof expr.value === "number" ? expr.value : 0)})`;
  }
  if (expr.op === "var") {
    return `var(${expr.name ?? "var"})`;
  }
  const args = Array.isArray(expr.args) ? expr.args : [];
  return `${expr.op}(${args.map(exprShape).join(",")})`;
}

function normalizeShapeString(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/-?\d+(?:\.\d+)?/g, (num) => canonicalNumber(Number(num)));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function quoteTokens(quote: string): string[] {
  const tokens = quote.toLowerCase().match(/[a-z0-9$%]+/g) ?? [];
  return tokens.filter((token) => token.length >= 4 || /\d/.test(token) || token.includes("$"));
}

function quoteScore(sourceText: string, quote: string): number {
  const source = normalizeText(sourceText);
  const anchor = normalizeText(quote);
  if (!source || !anchor) return 0;
  if (source.includes(anchor)) return 100;
  if (anchor.includes(source) && source.length > 30) return 95;

  const tokens = quoteTokens(anchor);
  if (tokens.length === 0) return 0;
  const hits = tokens.filter((token) => source.includes(token)).length;
  const ratio = hits / tokens.length;
  if (hits >= 3 && ratio >= 0.55) return 60 + ratio * 30;
  if (hits >= 2 && ratio >= 0.45) return 40 + ratio * 20;
  return 0;
}

function deepSubsetCompare(
  expected: unknown,
  actual: unknown,
  fieldPath: string,
  mismatches: string[],
): void {
  if (expected == null) return;

  if (
    typeof expected === "string" ||
    typeof expected === "boolean" ||
    typeof expected === "number"
  ) {
    if (typeof expected === "number" && typeof actual === "number") {
      const diff = Math.abs(expected - actual);
      if (diff <= 1e-9) return;
    }
    if (expected !== actual) {
      mismatches.push(`${fieldPath} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
    }
    return;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      mismatches.push(`${fieldPath} expected array`);
      return;
    }

    const used = new Set<number>();
    for (const expectedItem of expected) {
      let found = false;
      for (let i = 0; i < actual.length; i += 1) {
        if (used.has(i)) continue;
        const local: string[] = [];
        deepSubsetCompare(expectedItem, actual[i], `${fieldPath}[?]`, local);
        if (local.length === 0) {
          used.add(i);
          found = true;
          break;
        }
      }
      if (!found) {
        mismatches.push(`${fieldPath} missing expected item ${JSON.stringify(expectedItem)}`);
      }
    }
    return;
  }

  if (typeof expected === "object") {
    if (!actual || typeof actual !== "object") {
      mismatches.push(`${fieldPath} expected object`);
      return;
    }
    const expectedObj = expected as Record<string, unknown>;
    const actualObj = actual as Record<string, unknown>;
    for (const [key, expectedValue] of Object.entries(expectedObj)) {
      deepSubsetCompare(expectedValue, actualObj[key], `${fieldPath}.${key}`, mismatches);
    }
  }
}

function matchTriggerKeywords(
  expectedKeywords: unknown,
  clause: Clause,
  mismatches: string[],
): void {
  const keywords = asStringArray(expectedKeywords);
  if (keywords.length === 0) {
    mismatches.push("effect.triggerKeywords expected non-empty string array");
    return;
  }
  const consequences =
    clause.effect.kind === "default" ? clause.effect.consequences.join(" ") : "";
  const haystack = normalizeText(`${clause.title} ${clause.sourceText} ${consequences}`);
  for (const keyword of keywords) {
    if (!haystack.includes(normalizeText(keyword))) {
      mismatches.push(`effect.triggerKeywords missing "${keyword}"`);
    }
  }
}

function matchExprShape(expectedShapeRaw: unknown, clause: Clause, mismatches: string[]): void {
  const expectedShape = asString(expectedShapeRaw);
  if (!expectedShape) {
    mismatches.push("effect.exprShape expected non-empty string");
    return;
  }

  let actualExpr: Expr | undefined;
  if (clause.effect.kind === "payment") actualExpr = clause.effect.amount;
  if (clause.effect.kind === "formula") actualExpr = clause.effect.expr;
  if (clause.effect.kind === "accumulation") actualExpr = clause.effect.rate;

  if (!actualExpr) {
    mismatches.push(`effect.exprShape not available for effect.kind=${clause.effect.kind}`);
    return;
  }

  const got = normalizeShapeString(exprShape(actualExpr));
  const want = normalizeShapeString(expectedShape);
  if (got !== want) {
    mismatches.push(`effect.exprShape expected ${expectedShape} got ${exprShape(actualExpr)}`);
  }
}

function evaluateClauseMatch(
  clause: Clause,
  expected: ExpectedClause,
): { mismatches: string[] } {
  const mismatches: string[] = [];
  const mustMatch = expected.mustMatch;
  if (!mustMatch) return { mismatches };

  for (const [key, value] of Object.entries(mustMatch)) {
    if (key === "effect") {
      const expectedEffect = asObject(value);
      if (!expectedEffect) {
        mismatches.push("mustMatch.effect expected object");
        continue;
      }
      for (const [effectKey, effectValue] of Object.entries(expectedEffect)) {
        if (effectKey === "exprShape") {
          matchExprShape(effectValue, clause, mismatches);
          continue;
        }
        if (effectKey === "triggerKeywords") {
          matchTriggerKeywords(effectValue, clause, mismatches);
          continue;
        }
        deepSubsetCompare(
          effectValue,
          (clause.effect as Record<string, unknown>)[effectKey],
          `effect.${effectKey}`,
          mismatches,
        );
      }
      continue;
    }
    deepSubsetCompare(value, (clause as Record<string, unknown>)[key], key, mismatches);
  }

  return { mismatches };
}

interface Candidate {
  clause: Clause;
  quoteScore: number;
}

function expectedSemanticTag(expected: ExpectedClause): string | undefined {
  const mustMatch = expected.mustMatch;
  if (!mustMatch) return undefined;
  return asString(mustMatch.semanticTag);
}

function buildCandidates(clauses: Clause[], expected: ExpectedClause): Candidate[] {
  const quote = expected.sourceQuote;
  if (quote) {
    const quoteMatches = clauses
      .map((clause) => ({ clause, quoteScore: quoteScore(clause.sourceText, quote) }))
      .filter((candidate) => candidate.quoteScore > 0)
      .sort((a, b) => b.quoteScore - a.quoteScore);
    if (quoteMatches.length > 0) return quoteMatches;
  }

  const semanticTag = expectedSemanticTag(expected);
  if (semanticTag) {
    const tagMatches = clauses
      .filter((clause) => clause.semanticTag === semanticTag)
      .map((clause) => ({ clause, quoteScore: 0 }));
    if (tagMatches.length > 0) return tagMatches;
  }

  return clauses.map((clause) => ({ clause, quoteScore: 0 }));
}

function matchExpectedClause(clauses: Clause[], expected: ExpectedClause): ClauseMatch {
  if (clauses.length === 0) {
    return {
      expectationId: expected.id,
      status: "FAIL",
      reason: "IR has no clauses",
    };
  }

  const candidates = buildCandidates(clauses, expected);
  if (candidates.length === 0) {
    return {
      expectationId: expected.id,
      status: "FAIL",
      reason: "No candidate clause found",
    };
  }

  const scored = candidates.map((candidate) => {
    const evaluation = evaluateClauseMatch(candidate.clause, expected);
    const semanticTag = expectedSemanticTag(expected);
    const semanticBoost = semanticTag && candidate.clause.semanticTag === semanticTag ? 1 : 0;
    return {
      ...candidate,
      mismatches: evaluation.mismatches,
      semanticBoost,
    };
  });

  scored.sort((a, b) => {
    if (a.mismatches.length !== b.mismatches.length) {
      return a.mismatches.length - b.mismatches.length;
    }
    if (a.quoteScore !== b.quoteScore) return b.quoteScore - a.quoteScore;
    if (a.semanticBoost !== b.semanticBoost) return b.semanticBoost - a.semanticBoost;
    return a.clause.id.localeCompare(b.clause.id);
  });

  const best = scored[0];
  if (!best) {
    return {
      expectationId: expected.id,
      status: "FAIL",
      reason: "No candidate clause found",
    };
  }

  if (best.mismatches.length > 0) {
    return {
      expectationId: expected.id,
      status: "FAIL",
      matchedClauseId: best.clause.id,
      reason: best.mismatches.slice(0, 3).join("; "),
    };
  }

  const hasSourceQuote = Boolean(expected.sourceQuote);
  const sourceMatchedExactly = best.quoteScore >= 95;
  const status: MatchStatus = hasSourceQuote && !sourceMatchedExactly ? "WEAK" : "PASS";
  const reason = hasSourceQuote
    ? sourceMatchedExactly
      ? "sourceQuote match"
      : "matched without exact sourceQuote"
    : "mustMatch satisfied";

  return {
    expectationId: expected.id,
    status,
    matchedClauseId: best.clause.id,
    reason,
  };
}

function bucketSummary(rows: ClauseMatch[]): BucketSummary {
  const total = rows.length;
  const pass = rows.filter((row) => row.status === "PASS").length;
  const weak = rows.filter((row) => row.status === "WEAK").length;
  const fail = rows.filter((row) => row.status === "FAIL").length;
  const weightedScore = total === 0 ? 1 : (pass + weak * 0.5) / total;
  return { total, pass, weak, fail, weightedScore };
}

function keywordsFromText(value: string): string[] {
  const words = value
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  if (!words) return [];
  return Array.from(new Set(words));
}

function keywordHitCount(haystack: string, keywords: string[]): number {
  const normalized = normalizeText(haystack);
  return keywords.filter((keyword) => normalized.includes(keyword)).length;
}

function expectedUnmodeledFound(ir: ContractIR, expected: ExpectedUnmodeled): boolean {
  const clauseTexts = ir.clauses
    .filter((clause) => clause.modeled === false)
    .map((clause) => `${clause.title} ${clause.sourceText}`);
  const definitionTexts = ir.definitions.map(
    (definition) => `${definition.term} ${definition.meaning} ${definition.sourceText}`,
  );
  const corpus = [...clauseTexts, ...definitionTexts];
  if (corpus.length === 0) return false;

  const heading = asString(expected.sourceHeading);
  if (heading) {
    const headingNorm = normalizeText(heading);
    if (corpus.some((text) => normalizeText(text).includes(headingNorm))) {
      return true;
    }
    const headingKeywords = keywordsFromText(heading);
    if (
      headingKeywords.length > 0 &&
      corpus.some((text) => keywordHitCount(text, headingKeywords) >= Math.min(2, headingKeywords.length))
    ) {
      return true;
    }
  }

  const intent = asString(expected.intent);
  if (intent) {
    const intentKeywords = keywordsFromText(intent);
    if (
      intentKeywords.length > 0 &&
      corpus.some((text) => keywordHitCount(text, intentKeywords) >= Math.min(2, intentKeywords.length))
    ) {
      return true;
    }
  }

  return false;
}

async function loadIrForExpectation(
  repoRoot: string,
  doc: ExpectationDoc,
  options: CliOptions,
): Promise<{ ir: ContractIR; source: string }> {
  const irPath = path.resolve(repoRoot, options.irRoot, doc.contractId, "ir.json");
  if (!options.forceExtract && existsSync(irPath)) {
    const fromOut = JSON.parse(await readFile(irPath, "utf8")) as ContractIR;
    return { ir: fromOut, source: path.relative(repoRoot, irPath) };
  }

  const contractPath = path.resolve(repoRoot, doc.contractFile);
  const contractText = await readFile(contractPath, "utf8");
  const extracted = await extractIr({
    contractText,
    sourceFile: path.basename(contractPath),
  });
  return { ir: extracted, source: "live-extraction" };
}

function rowsForTargets(
  targets: string[],
  byId: Map<string, ClauseMatch>,
  bucket: "critical" | "supporting",
): ClauseMatch[] {
  return targets.map((targetId) => {
    const row = byId.get(targetId);
    if (row) return row;
    return {
      expectationId: targetId,
      status: "FAIL",
      reason: `Missing expectation id in ${bucket} coverageTargets`,
    };
  });
}

function printBucket(label: string, summary: BucketSummary): void {
  const pct = (summary.weightedScore * 100).toFixed(1);
  process.stdout.write(
    `  ${label}: pass=${summary.pass} weak=${summary.weak} fail=${summary.fail} total=${summary.total} score=${pct}%\n`,
  );
}

function printRows(rows: ClauseMatch[]): void {
  for (const row of rows) {
    const clauseRef = row.matchedClauseId ? ` -> ${row.matchedClauseId}` : "";
    process.stdout.write(`    [${row.status}] ${row.expectationId}${clauseRef}: ${row.reason}\n`);
  }
}

async function runForExpectationFile(
  repoRoot: string,
  expectationFile: string,
  options: CliOptions,
): Promise<ContractSummary> {
  const raw = await readFile(expectationFile, "utf8");
  const parsed = parseYaml(raw);
  const doc = parseExpectationDoc(parsed, expectationFile);

  const { ir, source } = await loadIrForExpectation(repoRoot, doc, options);
  const clauseMatches = doc.expectedClauses.map((expected) => matchExpectedClause(ir.clauses, expected));
  const byId = new Map(clauseMatches.map((row) => [row.expectationId, row]));

  const criticalRows = rowsForTargets(doc.coverageTargets.critical, byId, "critical");
  const supportingRows = rowsForTargets(doc.coverageTargets.supporting, byId, "supporting");
  const critical = bucketSummary(criticalRows);
  const supporting = bucketSummary(supportingRows);

  const unmodeledFound = doc.expectedUnmodeled.filter((row) => expectedUnmodeledFound(ir, row)).length;

  return {
    contractId: doc.contractId,
    expectationFile,
    irSource: source,
    critical,
    supporting,
    unmodeledFound,
    unmodeledTotal: doc.expectedUnmodeled.length,
    criticalRows,
    supportingRows,
  };
}

function printContractSummary(summary: ContractSummary, repoRoot: string): void {
  process.stdout.write(`\n${summary.contractId}\n`);
  process.stdout.write(`  expectation: ${path.relative(repoRoot, summary.expectationFile)}\n`);
  process.stdout.write(`  ir source: ${summary.irSource}\n`);
  printBucket("critical", summary.critical);
  printBucket("supporting", summary.supporting);
  process.stdout.write(
    `  unmodeled coverage: ${summary.unmodeledFound}/${summary.unmodeledTotal}\n`,
  );

  const interestingRows = [
    ...summary.criticalRows.filter((row) => row.status !== "PASS"),
    ...summary.supportingRows.filter((row) => row.status !== "PASS"),
  ];
  if (interestingRows.length > 0) {
    process.stdout.write("  findings:\n");
    printRows(interestingRows);
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required. Expectation checks now run in LLM-required mode only.",
    );
  }

  const repoRoot = process.cwd();
  const options = parseArgs(process.argv.slice(2));
  const expectationFiles =
    options.expectationFiles.length > 0
      ? options.expectationFiles.map((file) => path.resolve(repoRoot, file))
      : await defaultExpectationFiles(repoRoot);

  if (expectationFiles.length === 0) {
    throw new Error("No expectation YAML files found.");
  }

  process.stdout.write(
    [
      `Expectation checker`,
      `  files: ${expectationFiles.length}`,
      `  llm mode: on (required)`,
      `  ir root: ${options.irRoot}`,
      `  force extract: ${String(options.forceExtract)}`,
      `  strict supporting: ${String(options.strictSupporting)}`,
    ].join("\n"),
  );
  process.stdout.write("\n");

  const summaries: ContractSummary[] = [];
  let hadError = false;
  for (const expectationFile of expectationFiles) {
    try {
      const summary = await runForExpectationFile(repoRoot, expectationFile, options);
      summaries.push(summary);
      printContractSummary(summary, repoRoot);
    } catch (error) {
      hadError = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`\n[ERROR] ${path.relative(repoRoot, expectationFile)}: ${message}\n`);
    }
  }

  const totalCritical = summaries.reduce((acc, item) => acc + item.critical.total, 0);
  const totalCriticalFail = summaries.reduce((acc, item) => acc + item.critical.fail, 0);
  const totalSupporting = summaries.reduce((acc, item) => acc + item.supporting.total, 0);
  const totalSupportingFail = summaries.reduce((acc, item) => acc + item.supporting.fail, 0);
  const weightedCritical = summaries.reduce(
    (acc, item) => acc + item.critical.weightedScore * item.critical.total,
    0,
  );
  const weightedSupporting = summaries.reduce(
    (acc, item) => acc + item.supporting.weightedScore * item.supporting.total,
    0,
  );
  const criticalScore = totalCritical === 0 ? 1 : weightedCritical / totalCritical;
  const supportingScore = totalSupporting === 0 ? 1 : weightedSupporting / totalSupporting;

  process.stdout.write("\nOverall\n");
  process.stdout.write(`  contracts checked: ${summaries.length}/${expectationFiles.length}\n`);
  process.stdout.write(
    `  critical score: ${(criticalScore * 100).toFixed(1)}% (fails=${totalCriticalFail}/${totalCritical})\n`,
  );
  process.stdout.write(
    `  supporting score: ${(supportingScore * 100).toFixed(1)}% (fails=${totalSupportingFail}/${totalSupporting})\n`,
  );

  const shouldFail =
    hadError || totalCriticalFail > 0 || (options.strictSupporting && totalSupportingFail > 0);
  if (shouldFail) {
    process.exitCode = 1;
    process.stdout.write("  result: FAIL\n");
    return;
  }
  process.stdout.write("  result: PASS\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
