import type { Clause, ContractIR, Expr, TemporalRule } from "../types/ir.js";

function temporalToText(rule: TemporalRule): string {
  if (rule.type === "on_date") return `on ${String(rule.value)}`;
  if (rule.type === "business_days") return `within ${String(rule.value)} business day(s)`;
  return `within ${String(rule.value)} calendar day(s)`;
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

function clauseToText(clause: Clause): string {
  const prefix = clause.modeled ? "" : "[UNMODELED] ";
  if (clause.kind === "obligation") {
    return `${prefix}${clause.id}: ${clause.actor} must ${clause.action} ${temporalToText(clause.due)}.`;
  }
  if (clause.kind === "formula") {
    return `${prefix}${clause.id}: ${clause.outputVar} is computed as ${exprToText(clause.expr)}.`;
  }
  if (clause.kind === "fee") {
    const amount =
      clause.amountType === "fixed"
        ? `$${clause.amountValue.toFixed(2)}`
        : `${clause.amountValue}%`;
    return `${prefix}${clause.id}: ${clause.feeType} fee is ${amount} when ${clause.triggerDescription}.`;
  }

  return `${prefix}${clause.id}: default is triggered when ${clause.triggerDescription}. Consequences: ${clause.consequences.join(
    "; ",
  )}.`;
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
