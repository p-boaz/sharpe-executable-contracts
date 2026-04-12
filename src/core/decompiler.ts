import type { BoolExpr, Clause, ContractIR, Effect, Expr, TemporalRule } from "../types/ir.js";

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
