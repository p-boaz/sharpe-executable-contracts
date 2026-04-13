import type { BoolExpr, Clause, ContractIR, Effect, Expr, TemporalRule } from "../types/ir.js";
import type { ExecutionResult } from "../types/execution.js";
import type { Scenario } from "../types/scenario.js";
import { stableStringify } from "../util/json.js";

function temporalToText(rule: TemporalRule): string {
  const anchorText = rule.anchor ? ` of ${rule.anchor}` : "";
  const directionText =
    rule.direction === "before" ? " before" : rule.direction === "after" ? " after" : "";
  const graceText = rule.graceAfter ? ` (grace: ${temporalToText(rule.graceAfter)})` : "";
  if (rule.type === "on_date") return `on ${String(rule.value)}${graceText}`;
  if (rule.type === "business_days")
    return `within ${String(rule.value)} business day(s)${directionText}${anchorText}${graceText}`;
  if (rule.type === "months")
    return `within ${String(rule.value)} month(s)${directionText}${anchorText}${graceText}`;
  if (rule.type === "years")
    return `within ${String(rule.value)} year(s)${directionText}${anchorText}${graceText}`;
  return `within ${String(rule.value)} calendar day(s)${directionText}${anchorText}${graceText}`;
}

function exprToText(expr: Expr): string {
  switch (expr.op) {
    case "const":
      return String(expr.value ?? 0);
    case "var":
      return expr.name || "var";
    case "add":
      return `(${(expr.args || []).map(exprToText).join(" + ")})`;
    case "sub":
      return `(${(expr.args || []).map(exprToText).join(" - ")})`;
    case "mul":
      return `(${(expr.args || []).map(exprToText).join(" * ")})`;
    case "div":
      return `(${(expr.args || []).map(exprToText).join(" / ")})`;
    case "max":
      return `max(${(expr.args || []).map(exprToText).join(", ")})`;
    case "min":
      return `min(${(expr.args || []).map(exprToText).join(", ")})`;
    default:
      return "expr";
  }
}

function boolOperandToText(operand: string | number | boolean | BoolExpr | undefined): string {
  if (operand == null) return "";
  if (typeof operand === "string" || typeof operand === "number" || typeof operand === "boolean") {
    return String(operand);
  }
  return boolExprToText(operand);
}

function boolExprToText(expr: BoolExpr): string {
  switch (expr.op) {
    case "eq":
      return `${boolOperandToText(expr.left)} == ${boolOperandToText(expr.right)}`;
    case "neq":
      return `${boolOperandToText(expr.left)} != ${boolOperandToText(expr.right)}`;
    case "gt":
      return `${boolOperandToText(expr.left)} > ${boolOperandToText(expr.right)}`;
    case "gte":
      return `${boolOperandToText(expr.left)} >= ${boolOperandToText(expr.right)}`;
    case "lt":
      return `${boolOperandToText(expr.left)} < ${boolOperandToText(expr.right)}`;
    case "lte":
      return `${boolOperandToText(expr.left)} <= ${boolOperandToText(expr.right)}`;
    case "and":
      return `(${(expr.args || []).map(boolExprToText).join(" AND ")})`;
    case "or":
      return `(${(expr.args || []).map(boolExprToText).join(" OR ")})`;
    case "not":
      return `NOT ${(expr.args || []).map(boolExprToText).join("")}`;
    default:
      return "condition";
  }
}

function effectToText(effect: Effect): string {
  switch (effect.kind) {
    case "payment": {
      const assetText = effect.assetKind ? ` [${effect.assetKind}]` : "";
      const capText = effect.cap ? ` (capped at ${exprToText(effect.cap)})` : "";
      return `${effect.payer} pays ${effect.payee} ${exprToText(effect.amount)}${assetText}${capText}`;
    }
    case "obligation": {
      const dueText = effect.due ? ` ${temporalToText(effect.due)}` : "";
      const cureText = effect.curePeriod
        ? ` (cure period: ${temporalToText(effect.curePeriod)})`
        : "";
      return `${effect.actor} must ${effect.action}${dueText}${cureText}`;
    }
    case "formula": {
      const capText = effect.cap ? ` (capped at ${exprToText(effect.cap)})` : "";
      return `${effect.outputVar} is computed as ${exprToText(effect.expr)}${capText}`;
    }
    case "accumulation": {
      const capText = effect.cap ? ` (capped at ${exprToText(effect.cap)})` : "";
      return `accumulate ${exprToText(effect.rate)} per ${effect.per}${capText}`;
    }
    case "indemnification": {
      const carveOutsText = effect.carveOuts.length
        ? `; except: ${effect.carveOuts.join(", ")}`
        : "";
      return `${effect.indemnifier} indemnifies ${effect.indemnitee} for ${effect.scope}${carveOutsText}`;
    }
    case "default":
      return `default consequences: ${effect.consequences.join("; ") || "see source text"}`;
    case "unmodeled":
      return "unmodeled (see source text)";
  }
}

function clauseToText(clause: Clause): string {
  const prefix = clause.modeled ? "" : "[UNMODELED] ";
  const sourceTrace =
    clause.sourceSpan != null
      ? ` [source:${clause.sourceSpan.start}-${clause.sourceSpan.end}]`
      : "";
  const conditionText = clause.condition ? ` if ${boolExprToText(clause.condition)}` : "";
  const tagText = clause.semanticTag ? ` {${clause.semanticTag}}` : "";
  return `${prefix}${clause.id}${tagText}: ${effectToText(clause.effect)}${conditionText}.${sourceTrace}`;
}

export function decompileIrToEnglish(ir: ContractIR): string {
  const lines: string[] = [];

  lines.push(`Contract: ${ir.title}`);
  lines.push(`Contract ID: ${ir.contractId}`);
  lines.push(`Currency: ${ir.currency}`);
  lines.push("");

  lines.push("Parties:");
  for (const party of [...ir.parties].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`- ${party.id} (${party.role}): ${party.name}`);
  }
  lines.push("");

  lines.push("Definitions:");
  for (const definition of [...ir.definitions].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`- ${definition.term}: ${definition.meaning}`);
  }
  lines.push("");

  lines.push("Executable Clauses:");
  for (const clause of [...ir.clauses].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`- ${clauseToText(clause)}`);
  }
  lines.push("");

  lines.push(
    `Modeled coverage: ${ir.metadata.modeledClauseCount}/${ir.metadata.clauseCount} clause(s) modeled.`,
  );

  return `${lines.join("\n")}\n`;
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "null";
  return stableStringify(value, 0);
}

export interface ExecutionEnglishRun {
  archetype: string;
  scenario: Scenario;
  execution: ExecutionResult;
}

export function decompileExecutionToEnglish(
  ir: ContractIR,
  runs: ExecutionEnglishRun[],
): string {
  const lines: string[] = [];
  lines.push(decompileIrToEnglish(ir).trimEnd());
  lines.push("");
  lines.push("Execution Outcomes:");

  const sortedRuns = [...runs].sort((a, b) => a.archetype.localeCompare(b.archetype));
  for (const run of sortedRuns) {
    const label = run.scenario.label ?? run.archetype;
    const scenarioId = run.scenario.scenarioId || "(unknown)";
    const assumptions = run.scenario.assumptions || [];
    const initialFacts = run.scenario.initialState || {};
    const initialFactEntries = Object.entries(initialFacts).sort(([a], [b]) => a.localeCompare(b));
    const events = run.scenario.events || [];

    lines.push(`- Archetype ${run.archetype}: ${label}`);
    lines.push("  Scenario Inputs:");
    lines.push(`  - Scenario ID: ${scenarioId}`);

    if (assumptions.length > 0) {
      lines.push(`  - Assumptions (${assumptions.length}):`);
      for (const assumption of assumptions) {
        lines.push(`    - ${assumption}`);
      }
    } else {
      lines.push("  - Assumptions: none.");
    }

    if (initialFactEntries.length > 0) {
      lines.push(`  - Initial facts (${initialFactEntries.length}):`);
      for (const [key, value] of initialFactEntries) {
        lines.push(`    - ${key}: ${valueToText(value)}`);
      }
    } else {
      lines.push("  - Initial facts: none.");
    }

    if (events.length > 0) {
      lines.push(`  - Events (${events.length}):`);
      for (const event of events) {
        const amountText =
          typeof event.amount === "number" ? `, amount=${money(event.amount)}` : "";
        const metadataText =
          event.metadata && Object.keys(event.metadata).length > 0
            ? `, metadata=${stableStringify(event.metadata, 0)}`
            : "";
        lines.push(`    - ${event.id}: ${event.type} on ${event.date}${amountText}${metadataText}`);
      }
    } else {
      lines.push("  - Events: none.");
    }

    lines.push("  Engine Outputs:");
    lines.push(
      `  - Summary: ending balance ${money(run.execution.summary.endingBalance)}, paid ${money(run.execution.summary.totalPaid)}, interest ${money(run.execution.summary.totalInterestCharged)}, fees ${money(run.execution.summary.totalFeesCharged)}, breached=${String(run.execution.summary.breached)}.`,
    );
    lines.push(
      `  - Evaluation evidence: ${run.execution.ledger.length} ledger entr${run.execution.ledger.length === 1 ? "y" : "ies"}, ${run.execution.obligations.length} obligation(s), ${run.execution.breaches.length} breach(es).`,
    );
    lines.push(`  - Ledger entries: ${run.execution.ledger.length}.`);

    if (run.execution.obligations.length > 0) {
      lines.push("  - Obligation status:");
      for (const obligation of run.execution.obligations) {
        lines.push(
          `  - ${obligation.id} (${obligation.clauseId}): status=${obligation.status}, due=${obligation.dueDate}, paid ${money(obligation.amountPaid)} of ${money(obligation.amountDue)}.`,
        );
      }
    } else {
      lines.push("  - Obligation status: none.");
    }

    if (run.execution.breaches.length > 0) {
      lines.push("  - Breaches:");
      for (const breach of run.execution.breaches) {
        const clauseText = breach.clauseId ? ` (clause ${breach.clauseId})` : "";
        lines.push(
          `  - ${breach.id}: ${breach.type}${clauseText} on ${breach.date}: ${breach.description}`,
        );
      }
    } else {
      lines.push("  - Breaches: none.");
    }
  }

  return `${lines.join("\n")}\n`;
}
