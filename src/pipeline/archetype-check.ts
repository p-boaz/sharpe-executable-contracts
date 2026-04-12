import type { Scenario } from "../types/scenario.js";
import type { ExecutionResult } from "../types/execution.js";
import type { ContractIR } from "../types/ir.js";
import type { Archetype } from "./archetypes.js";

function feeClauseId(ir: ContractIR, feeType: "late_payment" | "over_limit"): string | undefined {
  return ir.clauses.find(
    (c): c is Extract<ContractIR["clauses"][number], { kind: "fee" }> =>
      c.kind === "fee" && c.feeType === feeType,
  )?.id;
}

function hasFeeForClause(execution: ExecutionResult, clauseId: string | undefined): boolean {
  if (!clauseId) return false;
  return execution.ledger.some((e) => e.kind === "fee" && e.clauseId === clauseId);
}

export function validateArchetype(
  scenario: Scenario,
  archetype: Archetype,
  execution: ExecutionResult,
  ir: ContractIR,
): string | null {
  const events = scenario.events;
  const dueDateRaw = scenario.initialState.dueDate;
  const dueDate = typeof dueDateRaw === "string" ? dueDateRaw : undefined;

  if (archetype.id === "late-payment") {
    if (!dueDate) return "late-payment archetype requires initialState.dueDate";
    const hasLatePayment = events.some(
      (e) => e.type === "payment" && e.date > dueDate,
    );
    if (!hasLatePayment) {
      return "late-payment archetype requires a payment event after dueDate";
    }
    const lateFeeId = feeClauseId(ir, "late_payment");
    if (!lateFeeId) {
      return "late-payment archetype requires IR to model a late_payment fee clause";
    }
    if (!hasFeeForClause(execution, lateFeeId)) {
      return "late-payment archetype requires execution ledger to contain a late-fee entry";
    }
  }

  if (archetype.id === "over-limit") {
    const limitRaw = scenario.initialState.creditLimit;
    const limit = typeof limitRaw === "number" ? limitRaw : undefined;
    if (limit === undefined) {
      return "over-limit archetype requires numeric initialState.creditLimit";
    }
    const purchaseTotal = events
      .filter((e) => e.type === "purchase" && typeof e.amount === "number")
      .reduce((sum, e) => sum + (e.amount ?? 0), 0);
    if (purchaseTotal <= limit) {
      return `over-limit archetype requires purchases > creditLimit (purchases=${purchaseTotal}, limit=${limit})`;
    }
    const overLimitFeeId = feeClauseId(ir, "over_limit");
    if (!overLimitFeeId) {
      return "over-limit archetype requires IR to model an over_limit fee clause";
    }
    if (!hasFeeForClause(execution, overLimitFeeId)) {
      return "over-limit archetype requires execution ledger to contain an over-limit-fee entry";
    }
  }

  if (archetype.id === "on-time") {
    if (dueDate) {
      const hasLatePayment = events.some(
        (e) => e.type === "payment" && e.date > dueDate,
      );
      if (hasLatePayment) {
        return "on-time archetype must not include a payment after dueDate";
      }
    }
    const rentDueRaw = scenario.initialState.rentDueDate;
    const rentDue = typeof rentDueRaw === "string" ? rentDueRaw : undefined;
    if (rentDue) {
      const hasLateRent = events.some(
        (e) => e.type === "payment" && e.date > rentDue,
      );
      if (hasLateRent) {
        return "on-time archetype must not include a rent payment after rentDueDate";
      }
    }
    const lateFeeId = feeClauseId(ir, "late_payment");
    if (lateFeeId && hasFeeForClause(execution, lateFeeId)) {
      return "on-time archetype must not produce a late-fee ledger entry";
    }
    const rentRaw = scenario.initialState.monthlyRent;
    const rent = typeof rentRaw === "number" ? rentRaw : undefined;
    if (rent !== undefined) {
      const paymentTotal = events
        .filter((e) => e.type === "payment" && typeof e.amount === "number")
        .reduce((sum, e) => sum + (e.amount ?? 0), 0);
      if (paymentTotal < rent) {
        return `on-time lease archetype requires full rent paid (payments=${paymentTotal}, rent=${rent})`;
      }
      const rentMet = execution.obligations.some(
        (o) => o.status === "met" && o.amountDue >= rent,
      );
      if (execution.obligations.length > 0 && !rentMet) {
        return "on-time lease archetype requires rent obligation status=met in execution";
      }
    }
  }

  if (archetype.id === "partial-payment") {
    const rentRaw = scenario.initialState.monthlyRent;
    const rent = typeof rentRaw === "number" ? rentRaw : undefined;
    if (rent === undefined) {
      return "partial-payment archetype requires numeric initialState.monthlyRent";
    }
    const paymentTotal = events
      .filter((e) => e.type === "payment" && typeof e.amount === "number")
      .reduce((sum, e) => sum + (e.amount ?? 0), 0);
    if (paymentTotal <= 0 || paymentTotal >= rent) {
      return `partial-payment archetype requires 0 < payments < monthlyRent (payments=${paymentTotal}, rent=${rent})`;
    }
    if (execution.summary.endingBalance <= 0) {
      return "partial-payment archetype requires unpaid balance carried forward (endingBalance > 0)";
    }
  }

  if (archetype.id === "baseline") {
    const modeledIds = new Set(
      ir.clauses.filter((c) => c.modeled).map((c) => c.id),
    );
    const modeledFired = execution.ledger.some(
      (e) => typeof e.clauseId === "string" && modeledIds.has(e.clauseId),
    );
    if (!modeledFired) {
      return "baseline archetype requires at least one modeled clause to fire in execution";
    }
  }

  return null;
}
