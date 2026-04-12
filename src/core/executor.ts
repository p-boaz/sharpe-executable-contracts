import { evaluateExpr } from "./eval-expr.js";
import { evaluateBoolExpr } from "./eval-bool.js";
import { daysBetween } from "../util/date.js";
import { max, round2 } from "../util/math.js";
import type { ExecutionResult, Breach, LedgerEntry } from "../types/execution.js";
import type { BoolExpr, ContractIR } from "../types/ir.js";
import type { Scenario } from "../types/scenario.js";

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

function findFeeAmount(ir: ContractIR, feeType: "late_payment" | "over_limit"): number {
  const feeClause = ir.clauses.find(
    (
      c,
    ): c is Extract<ContractIR["clauses"][number], { kind: "fee" }> =>
      c.kind === "fee" && c.feeType === feeType,
  );
  if (!feeClause) return 0;
  return feeClause.amountType === "fixed" ? feeClause.amountValue : 0;
}

function findClauseId(
  ir: ContractIR,
  matcher: (clause: ContractIR["clauses"][number]) => boolean,
): string | undefined {
  return ir.clauses.find(matcher)?.id;
}

function findPaymentDefaultClauseId(ir: ContractIR): string | undefined {
  return findClauseId(
    ir,
    (clause) =>
      clause.kind === "default" &&
      clause.modeled &&
      /payment|nonpayment|late/i.test(
        `${clause.triggerDescription} ${clause.consequences.join(" ")}`,
      ),
  );
}

function evaluateFormulaOutput(
  ir: ContractIR,
  outputVar: string,
  vars: Record<string, number>,
): number | undefined {
  const formula = ir.clauses.find(
    (
      clause,
    ): clause is Extract<ContractIR["clauses"][number], { kind: "formula" }> =>
      clause.kind === "formula" && clause.modeled && clause.outputVar === outputVar,
  );
  if (!formula) return undefined;

  const value = evaluateExpr(formula.expr, vars);
  if (!Number.isFinite(value)) return undefined;
  return value;
}

function conditionIsMet(condition: BoolExpr | undefined, scenario: Scenario): boolean {
  if (!condition) return true;
  return evaluateBoolExpr(condition, primitiveState(scenario.initialState));
}

function isLeaseScenario(ir: ContractIR, scenario: Scenario): boolean {
  const family = scenario.initialState.contractFamily;
  if (family === "lease") return true;

  return ir.clauses.some(
    (clause) =>
      clause.kind === "obligation" &&
      clause.modeled &&
      clause.id === "clause.obligation.monthly_rent",
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
  const lateFee = findFeeAmount(ir, "late_payment");
  const lateFeeClauseId = findClauseId(
    ir,
    (clause) => clause.kind === "fee" && clause.feeType === "late_payment",
  );
  const rentObligationClause = ir.clauses.find(
    (
      clause,
    ): clause is Extract<ContractIR["clauses"][number], { kind: "obligation" }> =>
      clause.kind === "obligation" &&
      clause.modeled &&
      clause.id === "clause.obligation.monthly_rent",
  );
  const rentClauseId =
    rentObligationClause?.id ||
    findClauseId(
      ir,
      (clause) =>
        clause.kind === "obligation" &&
        clause.modeled &&
        clause.id === "clause.obligation.monthly_rent",
    ) || "clause.obligation.monthly_rent";
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

export function executeContract(ir: ContractIR, scenario: Scenario): ExecutionResult {
  const events = [...scenario.events].sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date);
    if (dateCompare !== 0) return dateCompare;
    return a.id.localeCompare(b.id);
  });

  if (isLeaseScenario(ir, scenario)) {
    return executeLeaseContract(ir, scenario, events);
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
  const lateFee = findFeeAmount(ir, "late_payment");
  const overLimitFee = findFeeAmount(ir, "over_limit");
  const creditLimit = numberState(scenario.initialState, "creditLimit", 0);
  const statementDate = stringState(scenario.initialState, "statementDate", "2026-01-31");
  const dueDate = stringState(scenario.initialState, "dueDate", "2026-02-25");
  const minimumPaymentClauseId = findClauseId(
    ir,
    (c) => c.kind === "obligation" && c.id === "clause.obligation.minimum_payment",
  );
  const lateFeeClauseId = findClauseId(
    ir,
    (c) => c.kind === "fee" && c.feeType === "late_payment",
  );
  const overLimitClauseId = findClauseId(
    ir,
    (c) => c.kind === "fee" && c.feeType === "over_limit",
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
            findClauseId(ir, (c) => c.kind === "formula" && c.outputVar === "apr_nominal"),
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
