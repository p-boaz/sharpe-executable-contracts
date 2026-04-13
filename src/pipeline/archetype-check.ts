import type { Scenario } from "../types/scenario.js";
import type { ExecutionResult } from "../types/execution.js";
import type { ContractIR } from "../types/ir.js";
import type { Archetype } from "./archetypes.js";

// The validator only hard-fails on checks the LLM can plausibly repair by
// rewriting scenario JSON: dates, amounts, event presence, and clauseId
// bindings. Execution-outcome assertions (fee ledger rows, obligation
// statuses, ending balance) used to live here, but retrying a scenario
// cannot coerce the executor into firing a clause that isn't wired for the
// IR shape, so those retries just burn budget. Downstream UI still surfaces
// whatever the executor actually produced.

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
    const rentRaw = scenario.initialState.monthlyRent;
    const rent = typeof rentRaw === "number" ? rentRaw : undefined;
    if (rent !== undefined) {
      const paymentTotal = events
        .filter((e) => e.type === "payment" && typeof e.amount === "number")
        .reduce((sum, e) => sum + (e.amount ?? 0), 0);
      if (paymentTotal < rent) {
        return `on-time lease archetype requires full rent paid (payments=${paymentTotal}, rent=${rent})`;
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
  }

  if (archetype.id === "baseline") {
    const modeledClauses = ir.clauses.filter((c) => c.modeled);
    const modeledIds = new Set(modeledClauses.map((c) => c.id));
    const modeledFired = execution.ledger.some(
      (e) => typeof e.clauseId === "string" && modeledIds.has(e.clauseId),
    );
    if (!modeledFired) {
      return "baseline archetype requires at least one modeled clause to fire in execution";
    }

    const hasObligations = modeledClauses.some((c) => c.effect.kind === "obligation");
    if (hasObligations) {
      const metObligations = execution.obligations.filter((o) => o.status === "met");
      if (metObligations.length === 0) {
        return "baseline archetype requires at least one modeled obligation to be met in execution (bind an event via metadata.clauseId)";
      }
    }
  }

  return null;
}
