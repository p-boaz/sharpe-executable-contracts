import { evaluateExpr } from "./eval-expr.js";
import { evaluateBoolExpr } from "./eval-bool.js";
import { resolveTermToDate } from "./definition-resolver.js";
import { matchEventToObligation } from "./match-obligation.js";
import { addBusinessDays, addCalendarDays, daysBetween } from "../util/date.js";
import { max, round2 } from "../util/math.js";
import type { ExecutionResult, Breach, LedgerEntry } from "../types/execution.js";
import type { BoolExpr, Clause, ContractIR, KnownSemanticTag, TemporalRule } from "../types/ir.js";
import type { Scenario } from "../types/scenario.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type ClauseWithObligation = Clause & { effect: Extract<Clause["effect"], { kind: "obligation" }> };
type ClauseWithFormula = Clause & { effect: Extract<Clause["effect"], { kind: "formula" }> };
type ClauseWithPayment = Clause & { effect: Extract<Clause["effect"], { kind: "payment" }> };
type ClauseWithDefault = Clause & { effect: Extract<Clause["effect"], { kind: "default" }> };

function isObligationClause(clause: Clause): clause is ClauseWithObligation {
  return clause.effect.kind === "obligation";
}
function isFormulaClause(clause: Clause): clause is ClauseWithFormula {
  return clause.effect.kind === "formula";
}
function isPaymentClause(clause: Clause): clause is ClauseWithPayment {
  return clause.effect.kind === "payment";
}
function isDefaultClause(clause: Clause): clause is ClauseWithDefault {
  return clause.effect.kind === "default";
}

interface MutableObligation {
  id: string;
  clauseId: string;
  dueDate: string;
  amountDue: number;
  amountPaid: number;
  status: "open" | "met" | "missed" | "partial";
}

function primitiveState(
  state: Scenario["initialState"],
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(state)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
    }
  }
  return result;
}

function numericEnv(state: Scenario["initialState"]): Record<string, number> {
  const env: Record<string, number> = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === "number" && Number.isFinite(value)) env[key] = value;
  }
  return env;
}

function numberState(
  state: Scenario["initialState"],
  key: string,
  fallback: number,
): number {
  const value = state[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringState(
  state: Scenario["initialState"],
  key: string,
  fallback: string,
): string {
  const value = state[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

// Resolves a payment-effect amount to a dollar value when the amount expression
// is a const. Non-const amounts (e.g. percent fees needing a transaction amount)
// return undefined and are expected to be computed at fire-time.
function findPaymentAmount(ir: ContractIR, semanticTag: string): number {
  const clause = ir.clauses.find((c) => isPaymentClause(c) && c.semanticTag === semanticTag);
  if (!clause || !isPaymentClause(clause)) return 0;
  const amount = clause.effect.amount;
  return amount.op === "const" && typeof amount.value === "number" ? amount.value : 0;
}

function findClauseId(
  ir: ContractIR,
  matcher: (clause: Clause) => boolean,
): string | undefined {
  return ir.clauses.find(matcher)?.id;
}

function findPaymentDefaultClauseId(ir: ContractIR): string | undefined {
  return findClauseId(
    ir,
    (clause) =>
      isDefaultClause(clause) &&
      clause.modeled &&
      /payment|nonpayment|late/i.test(
        `${clause.semanticTag} ${clause.sourceText} ${clause.effect.kind === "default" ? clause.effect.consequences.join(" ") : ""}`,
      ),
  );
}

function evaluateFormulaOutput(
  ir: ContractIR,
  outputVar: string,
  vars: Record<string, number>,
): number | undefined {
  const formula = ir.clauses.find(
    (clause): clause is ClauseWithFormula =>
      isFormulaClause(clause) && clause.modeled && clause.effect.outputVar === outputVar,
  );
  if (!formula) return undefined;

  const value = evaluateExpr(formula.effect.expr, vars);
  if (!Number.isFinite(value)) return undefined;
  return value;
}

function conditionIsMet(condition: BoolExpr | undefined, scenario: Scenario): boolean {
  if (!condition) return true;
  return evaluateBoolExpr(condition, primitiveState(scenario.initialState));
}

export function isLeaseScenario(ir: ContractIR, scenario: Scenario): boolean {
  const family = scenario.initialState.contractFamily;
  if (family === "lease") return true;

  return ir.clauses.some(
    (clause) =>
      isObligationClause(clause) &&
      clause.modeled &&
      clause.semanticTag === ("rent_obligation" satisfies KnownSemanticTag),
  );
}

function monthlyRentFromIr(ir: ContractIR): number {
  const value = evaluateFormulaOutput(ir, "monthly_rent_due", {});
  if (typeof value !== "number") return 0;
  return value;
}

function executeLeaseContract(
  ir: ContractIR,
  scenario: Scenario,
  events: Scenario["events"],
): ExecutionResult {
  const ledger: LedgerEntry[] = [];
  const breaches: Breach[] = [];
  const obligations: MutableObligation[] = [];

  const monthlyRent = round2(
    numberState(scenario.initialState, "monthlyRent", monthlyRentFromIr(ir)),
  );
  const lateFee = findPaymentAmount(ir, "late_payment_fee" satisfies KnownSemanticTag);
  const lateFeeClauseId = findClauseId(
    ir,
    (clause) => isPaymentClause(clause) && clause.semanticTag === ("late_payment_fee" satisfies KnownSemanticTag),
  );
  const rentObligationClause = ir.clauses.find(
    (clause): clause is ClauseWithObligation =>
      isObligationClause(clause) &&
      clause.modeled &&
      clause.semanticTag === ("rent_obligation" satisfies KnownSemanticTag),
  );
  const rentClauseId = rentObligationClause?.id || "clause.obligation.monthly_rent";
  const rentDueDate = stringState(
    scenario.initialState,
    "rentDueDate",
    events.find((event) => event.type === "due_check")?.date || "2026-02-01",
  );
  const rentConditionMet = conditionIsMet(rentObligationClause?.condition, scenario);

  let balance = 0;
  let totalPaid = 0;
  let totalFeesCharged = 0;
  let rentObligation: MutableObligation | null = null;

  if (rentConditionMet && monthlyRent > 0) {
    balance = monthlyRent;
    rentObligation = {
      id: "obl-lease-rent-001",
      clauseId: rentClauseId,
      dueDate: rentDueDate,
      amountDue: monthlyRent,
      amountPaid: 0,
      status: "open",
    };
    obligations.push(rentObligation);

    ledger.push(
      asLedger(
        "stmt-lease-rent-001",
        rentDueDate,
        "statement",
        monthlyRent,
        balance,
        `Lease rent due: $${monthlyRent.toFixed(2)}`,
        rentClauseId,
      ),
    );
  } else {
    ledger.push(
      asLedger(
        "stmt-lease-rent-001",
        rentDueDate,
        "notice",
        0,
        balance,
        "Lease rent obligation condition evaluated false; no rent due in this cycle",
        rentClauseId,
      ),
    );
  }

  for (const event of events) {
    switch (event.type) {
      case "payment": {
        const amount = round2(event.amount || 0);
        balance = round2(Math.max(0, balance - amount));
        totalPaid = round2(totalPaid + amount);

        if (rentObligation && rentObligation.status === "open") {
          rentObligation.amountPaid = round2(rentObligation.amountPaid + amount);
        }

        ledger.push(
          asLedger(event.id, event.date, "payment", -amount, balance, "Lease payment posted"),
        );
        break;
      }
      case "due_check": {
        if (!rentObligation || rentObligation.status !== "open") break;

        if (rentObligation.amountPaid >= rentObligation.amountDue) {
          rentObligation.status = "met";
        } else if (rentObligation.amountPaid > 0) {
          rentObligation.status = "partial";
        } else {
          rentObligation.status = "missed";
        }

        if (rentObligation.status !== "met") {
          if (lateFee > 0) {
            balance = round2(balance + lateFee);
            totalFeesCharged = round2(totalFeesCharged + lateFee);
            ledger.push(
              asLedger(
                `fee-late-${event.id}`,
                event.date,
                "fee",
                lateFee,
                balance,
                "Late fee applied for unpaid lease rent",
                lateFeeClauseId,
              ),
            );
          }

          pushBreach(
            breaches,
            `breach-rent-late-${event.id}`,
            event.date,
            "late_payment",
            "Monthly rent was not fully paid by due-check date",
            rentClauseId,
          );
        }
        break;
      }
      case "notice": {
        ledger.push(
          asLedger(event.id, event.date, "notice", 0, balance, "Lease notice event recorded"),
        );
        break;
      }
      default:
        break;
    }
  }

  return {
    ledger,
    breaches,
    obligations: obligations.map((obligation) => ({
      id: obligation.id,
      clauseId: obligation.clauseId,
      dueDate: obligation.dueDate,
      amountDue: round2(obligation.amountDue),
      amountPaid: round2(obligation.amountPaid),
      status: obligation.status === "open" ? "partial" : obligation.status,
    })),
    summary: {
      endingBalance: round2(balance),
      totalInterestCharged: 0,
      totalFeesCharged: round2(totalFeesCharged),
      totalPaid: round2(totalPaid),
      breached: breaches.length > 0,
    },
  };
}

function minimumPayment(balance: number): number {
  if (balance <= 15) return round2(balance);
  return max(round2(balance * 0.03), 15);
}

function asLedger(
  id: string,
  date: string,
  kind: LedgerEntry["kind"],
  amount: number,
  balanceAfter: number,
  description: string,
  clauseId?: string,
): LedgerEntry {
  const base: LedgerEntry = {
    id,
    date,
    kind,
    amount: round2(amount),
    balanceAfter: round2(balanceAfter),
    description,
  };
  if (clauseId) base.clauseId = clauseId;
  return base;
}

function pushBreach(
  list: Breach[],
  id: string,
  date: string,
  type: Breach["type"],
  description: string,
  clauseId?: string,
): void {
  const base: Breach = {
    id,
    date,
    type,
    description,
  };
  if (clauseId) base.clauseId = clauseId;
  list.push(base);
}

export function isCreditCardScenario(ir: ContractIR, scenario: Scenario): boolean {
  if (scenario.initialState.contractFamily === "credit-card") return true;
  const hasMinPaymentObligation = ir.clauses.some(
    (clause) =>
      isObligationClause(clause) &&
      clause.semanticTag === ("minimum_payment_obligation" satisfies KnownSemanticTag),
  );
  const hasMinPaymentFormula = ir.clauses.some(
    (clause) =>
      (isFormulaClause(clause) &&
        clause.semanticTag === ("minimum_payment_formula" satisfies KnownSemanticTag)) ||
      (isFormulaClause(clause) && clause.effect.outputVar === "minimum_payment_due"),
  );
  const hasLatePaymentFee = ir.clauses.some(
    (clause) => isPaymentClause(clause) && clause.semanticTag === ("late_payment_fee" satisfies KnownSemanticTag),
  );
  return hasMinPaymentObligation || (hasLatePaymentFee && hasMinPaymentFormula);
}

function resolveDueDate(
  rule: TemporalRule,
  contractStart: string,
  ir?: ContractIR,
): string {
  if (rule.type === "on_date" && typeof rule.value === "string") {
    // Try to resolve symbolic anchors ("closing_date", "effective_date")
    // against the definitions table. Fall back to the symbolic string so
    // the obligation status surface stays truthful (§executeGenericContract
    // converts non-ISO due-dates to "pending", not "missed").
    if (ir && !ISO_DATE.test(rule.value)) {
      const resolved = resolveTermToDate(rule.value, ir);
      if (resolved) return resolved;
    }
    return rule.value;
  }
  const anchor = rule.anchor === "contractEnd" ? contractStart : contractStart;
  const days = typeof rule.value === "number" ? rule.value : 0;
  if (rule.type === "business_days") return addBusinessDays(anchor, days);
  return addCalendarDays(anchor, days);
}

function executeGenericContract(
  ir: ContractIR,
  scenario: Scenario,
  events: Scenario["events"],
): ExecutionResult {
  const ledger: LedgerEntry[] = [];
  const breaches: Breach[] = [];
  const obligations: MutableObligation[] = [];

  const contractStart =
    stringState(scenario.initialState, "contractStart", events[0]?.date || "2026-01-01");

  // Scheduled payment statements: every modeled `payment` clause with a
  // resolvable const amount produces a dated ledger entry. Percent/variable
  // formulas without scenario bindings emit a $0 placeholder so the clause
  // still shows as planned activity rather than disappearing.
  const modeledPayments = ir.clauses.filter(
    (c): c is ClauseWithPayment => isPaymentClause(c) && c.modeled,
  );
  for (const [index, clause] of modeledPayments.entries()) {
    if (!conditionIsMet(clause.condition, scenario)) continue;
    const amount = evaluateExpr(clause.effect.amount, numericEnv(scenario.initialState));
    ledger.push(
      asLedger(
        `stmt-payment-${index + 1}-${clause.id}`,
        contractStart,
        "statement",
        amount,
        0,
        `Scheduled payment: ${clause.effect.payer} → ${clause.effect.payee} (${clause.semanticTag})`,
        clause.id,
      ),
    );
  }

  // Definitional formulas resolvable from scenario.initialState emit a
  // statement entry carrying the computed value. Unresolved formulas (vars
  // missing from initialState) just log the intent.
  const modeledFormulas = ir.clauses.filter(
    (c): c is ClauseWithFormula => isFormulaClause(c) && c.modeled,
  );
  for (const [index, clause] of modeledFormulas.entries()) {
    if (!conditionIsMet(clause.condition, scenario)) continue;
    const value = evaluateExpr(clause.effect.expr, numericEnv(scenario.initialState));
    ledger.push(
      asLedger(
        `stmt-formula-${index + 1}-${clause.id}`,
        contractStart,
        "statement",
        Number.isFinite(value) ? value : 0,
        0,
        `Computed ${clause.effect.outputVar} = ${Number.isFinite(value) ? value : "<needs scenario vars>"} (${clause.semanticTag})`,
        clause.id,
      ),
    );
  }

  const modeledObligations = ir.clauses.filter(
    (c): c is ClauseWithObligation => isObligationClause(c) && c.modeled,
  );

  const resolvedDueDates = new Map<string, string>();
  for (const [index, clause] of modeledObligations.entries()) {
    if (!conditionIsMet(clause.condition, scenario)) continue;

    const obligation = clause.effect;
    const dueRule = obligation.due || { type: "on_date" as const, value: "see_source_text" };
    const dueDate = resolveDueDate(dueRule, contractStart, ir);
    resolvedDueDates.set(clause.id, dueDate);

    obligations.push({
      id: `obl-generic-${index + 1}`,
      clauseId: clause.id,
      dueDate,
      amountDue: 0,
      amountPaid: 0,
      status: "open",
    });

    ledger.push(
      asLedger(
        `stmt-${clause.id}`,
        dueDate,
        "statement",
        0,
        0,
        `Obligation due: ${obligation.action} (by ${dueDate})`,
        clause.id,
      ),
    );
  }

  for (const event of events) {
    let matchedClauseId: string | undefined;
    for (const clause of modeledObligations) {
      const dueDate = resolvedDueDates.get(clause.id);
      if (!dueDate) continue;
      const tracker = obligations.find((o) => o.clauseId === clause.id);
      if (!tracker || tracker.status !== "open") continue;

      const obligation = clause.effect;
      const result = matchEventToObligation(event, {
        id: clause.id,
        actor: obligation.actor,
        action: obligation.action,
      }, dueDate);
      if (result.matched) {
        tracker.status = "met";
        matchedClauseId = clause.id;
        break;
      }
    }

    ledger.push(
      asLedger(
        event.id,
        event.date,
        "notice",
        event.amount ?? 0,
        0, // balanceAfter filled in by the accumulation pass below
        matchedClauseId
          ? `Event ${event.id} performed obligation ${matchedClauseId}`
          : `Event ${event.id} recorded (no obligation matched)`,
        matchedClauseId,
      ),
    );
  }

  // Only promote "open" → "missed" when the due date is a concrete ISO
  // date. Symbolic placeholders like "see_source_text" mean the extractor
  // couldn't pin a deadline, so asserting a breach against them produces
  // false-positive failures that swamp the UI (e.g. generic service
  // agreements with 20+ clauses all flagged "missed by see_source_text").
  for (const tracker of obligations) {
    if (tracker.status !== "open") continue;
    if (!ISO_DATE.test(tracker.dueDate)) continue;
    tracker.status = "missed";
    pushBreach(
      breaches,
      `breach-missed-${tracker.clauseId}`,
      tracker.dueDate,
      "obligation_missed",
      `No scenario event performed obligation ${tracker.clauseId} by ${tracker.dueDate}`,
      tracker.clauseId,
    );
  }

  // Accumulation pass: walk the ledger in chronological order, track a
  // running balance, and backfill each entry's balanceAfter. Statement rows
  // (scheduled charges) raise the balance; notice rows with a positive amount
  // are payments that reduce it. This mirrors the lease/credit-card executors
  // which perform their own inline balance math.
  let runningBalance = 0;
  let totalPaid = 0;
  for (const entry of ledger) {
    if (entry.kind === "statement" && entry.amount > 0) {
      runningBalance += entry.amount; // scheduled charge raises the balance
    } else if (entry.kind === "notice" && entry.amount > 0) {
      runningBalance = Math.max(0, runningBalance - entry.amount);
      totalPaid += entry.amount;
    }
    entry.balanceAfter = round2(runningBalance);
  }

  return {
    ledger,
    breaches,
    obligations: obligations.map((o) => ({
      id: o.id,
      clauseId: o.clauseId,
      dueDate: o.dueDate,
      amountDue: round2(o.amountDue),
      amountPaid: round2(o.amountPaid),
      // At this point any remaining "open" obligation has a non-ISO due
      // date (e.g. "see_source_text"); surface it as "pending" rather than
      // silently renaming to "missed", which would lie to the UI.
      status: o.status === "open" ? "pending" : o.status,
    })),
    summary: {
      endingBalance: round2(runningBalance),
      totalInterestCharged: 0,
      totalFeesCharged: 0,
      totalPaid: round2(totalPaid),
      breached: breaches.length > 0,
    },
  };
}

export function executeContract(ir: ContractIR, scenario: Scenario): ExecutionResult {
  const events = [...scenario.events].sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date);
    if (dateCompare !== 0) return dateCompare;
    return a.id.localeCompare(b.id);
  });

  if (isLeaseScenario(ir, scenario)) {
    return executeLeaseContract(ir, scenario, events);
  }

  if (!isCreditCardScenario(ir, scenario)) {
    return executeGenericContract(ir, scenario, events);
  }

  const ledger: LedgerEntry[] = [];
  const breaches: Breach[] = [];
  const obligations: MutableObligation[] = [];

  const aprFormulaValue = evaluateFormulaOutput(ir, "apr_nominal", {});
  const apr = numberState(
    scenario.initialState,
    "apr",
    typeof aprFormulaValue === "number" ? aprFormulaValue : 7.9,
  );
  const dailyRate = apr / 100 / 365;
  const lateFee = findPaymentAmount(ir, "late_payment_fee" satisfies KnownSemanticTag);
  const overLimitFee = findPaymentAmount(ir, "over_limit_fee" satisfies KnownSemanticTag);
  const creditLimit = numberState(scenario.initialState, "creditLimit", 0);
  const statementDate = stringState(scenario.initialState, "statementDate", "2026-01-31");
  const dueDate = stringState(scenario.initialState, "dueDate", "2026-02-25");
  const minimumPaymentClauseId = findClauseId(
    ir,
    (c) =>
      isObligationClause(c) &&
      c.semanticTag === ("minimum_payment_obligation" satisfies KnownSemanticTag),
  );
  const lateFeeClauseId = findClauseId(
    ir,
    (c) => isPaymentClause(c) && c.semanticTag === ("late_payment_fee" satisfies KnownSemanticTag),
  );
  const overLimitClauseId = findClauseId(
    ir,
    (c) => isPaymentClause(c) && c.semanticTag === ("over_limit_fee" satisfies KnownSemanticTag),
  );
  const paymentDefaultClauseId = findPaymentDefaultClauseId(ir);

  let balance = round2(numberState(scenario.initialState, "balance", 0));
  let totalInterestCharged = 0;
  let totalFeesCharged = 0;
  let totalPaid = 0;
  let lastAccrualDate = events[0]?.date || statementDate;
  let activeObligation: MutableObligation | null = null;

  for (const event of events) {
    const elapsedDays = daysBetween(lastAccrualDate, event.date);
    if (elapsedDays > 0 && balance > 0) {
      const accruedInterest = round2(balance * dailyRate * elapsedDays);
      if (accruedInterest > 0) {
        balance = round2(balance + accruedInterest);
        totalInterestCharged = round2(totalInterestCharged + accruedInterest);
        ledger.push(
          asLedger(
            `interest-${event.id}`,
            event.date,
            "interest",
            accruedInterest,
            balance,
            `Interest accrued for ${elapsedDays} day(s) at APR ${apr}%`,
            findClauseId(ir, (c) => isFormulaClause(c) && c.effect.outputVar === "apr_nominal"),
          ),
        );
      }
    }
    lastAccrualDate = event.date;

    switch (event.type) {
      case "purchase": {
        const amount = round2(event.amount || 0);
        balance = round2(balance + amount);
        ledger.push(
          asLedger(event.id, event.date, "purchase", amount, balance, "Purchase posted"),
        );
        break;
      }
      case "cash_advance": {
        const amount = round2(event.amount || 0);
        balance = round2(balance + amount);
        ledger.push(
          asLedger(
            event.id,
            event.date,
            "cash_advance",
            amount,
            balance,
            "Cash advance posted",
          ),
        );
        break;
      }
      case "payment": {
        const amount = round2(event.amount || 0);
        balance = round2(Math.max(0, balance - amount));
        totalPaid = round2(totalPaid + amount);

        if (activeObligation) {
          activeObligation.amountPaid = round2(activeObligation.amountPaid + amount);
        }

        ledger.push(asLedger(event.id, event.date, "payment", -amount, balance, "Payment posted"));
        break;
      }
      case "statement_close": {
        const evaluatedMinimumPayment = evaluateFormulaOutput(ir, "minimum_payment_due", {
          new_balance: balance,
        });
        const amountDue = round2(
          typeof evaluatedMinimumPayment === "number" && evaluatedMinimumPayment > 0
            ? evaluatedMinimumPayment
            : minimumPayment(balance),
        );
        activeObligation = {
          id: `obl-${event.id}`,
          clauseId: minimumPaymentClauseId || "clause.obligation.minimum_payment",
          dueDate,
          amountDue,
          amountPaid: 0,
          status: "open",
        };
        obligations.push(activeObligation);

        ledger.push(
          asLedger(
            event.id,
            event.date,
            "statement",
            amountDue,
            balance,
            `Statement closed. Minimum due: $${amountDue.toFixed(2)}`,
            activeObligation.clauseId,
          ),
        );

        if (creditLimit > 0 && balance > creditLimit && overLimitFee > 0) {
          balance = round2(balance + overLimitFee);
          totalFeesCharged = round2(totalFeesCharged + overLimitFee);
          ledger.push(
            asLedger(
              `fee-over-limit-${event.id}`,
              event.date,
              "fee",
              overLimitFee,
              balance,
              "Over-limit fee applied",
              overLimitClauseId,
            ),
          );
          pushBreach(
            breaches,
            `breach-over-limit-${event.id}`,
            event.date,
            "over_limit",
            "Balance exceeded credit limit at statement close",
            overLimitClauseId,
          );
        }
        break;
      }
      case "due_check": {
        if (!activeObligation) break;

        if (activeObligation.amountPaid >= activeObligation.amountDue) {
          activeObligation.status = "met";
        } else if (activeObligation.amountPaid > 0) {
          activeObligation.status = "partial";
        } else {
          activeObligation.status = "missed";
        }

        if (activeObligation.status !== "met") {
          if (lateFee > 0) {
            balance = round2(balance + lateFee);
            totalFeesCharged = round2(totalFeesCharged + lateFee);
            ledger.push(
              asLedger(
                `fee-late-${event.id}`,
                event.date,
                "fee",
                lateFee,
                balance,
                "Late payment fee applied",
                lateFeeClauseId,
              ),
            );
          }

          pushBreach(
            breaches,
            `breach-late-${event.id}`,
            event.date,
            "late_payment",
            "Minimum payment was not fully paid by due-check date",
            minimumPaymentClauseId,
          );
          if (paymentDefaultClauseId) {
            pushBreach(
              breaches,
              `breach-default-${event.id}`,
              event.date,
              "default",
              "Default condition triggered by late payment",
              paymentDefaultClauseId,
            );
          }
        }

        break;
      }
      case "notice": {
        ledger.push(asLedger(event.id, event.date, "notice", 0, balance, "Notice event recorded"));
        break;
      }
      default:
        break;
    }
  }

  const finalizedObligations = obligations.map((o) => ({
    id: o.id,
    clauseId: o.clauseId,
    dueDate: o.dueDate,
    amountDue: round2(o.amountDue),
    amountPaid: round2(o.amountPaid),
    status: o.status === "open" ? "partial" : o.status,
  }));

  return {
    ledger,
    breaches,
    obligations: finalizedObligations,
    summary: {
      endingBalance: round2(balance),
      totalInterestCharged: round2(totalInterestCharged),
      totalFeesCharged: round2(totalFeesCharged),
      totalPaid: round2(totalPaid),
      breached: breaches.length > 0,
    },
  };
}
