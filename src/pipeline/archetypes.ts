import type { ContractIR } from "../types/ir.js";

export type ContractFamily = "credit_card" | "lease" | "generic";

export interface Archetype {
  id: string;
  label: string;
  intent: string;
}

const CREDIT_CARD_ARCHETYPES: Archetype[] = [
  {
    id: "on-time",
    label: "On-time full payment",
    intent:
      "Payment clears at or above the minimum before the due date; no late fee, no over-limit fee.",
  },
  {
    id: "late-payment",
    label: "Late payment, below minimum",
    intent:
      "Payment posted after the due date and below the required minimum, triggering the late-payment path.",
  },
  {
    id: "over-limit",
    label: "Over credit limit at statement close",
    intent:
      "Opening activity drives balance above the credit limit at statement close, triggering over-limit behavior.",
  },
];

const LEASE_ARCHETYPES: Archetype[] = [
  {
    id: "on-time",
    label: "On-time rent payment",
    intent: "Tenant pays full rent on or before the rent due date; no default.",
  },
  {
    id: "partial-payment",
    label: "Partial rent, triggers default review",
    intent:
      "Tenant pays less than the monthly rent, leaving a shortfall at the due-check and triggering the lease nonpayment path.",
  },
];

const GENERIC_ARCHETYPES: Archetype[] = [
  {
    id: "baseline",
    label: "Baseline review",
    intent:
      "Minimal timeline that exercises any modeled clause; safe default when contract family is unknown.",
  },
];

export function archetypesFor(family: ContractFamily): Archetype[] {
  switch (family) {
    case "credit_card":
      return CREDIT_CARD_ARCHETYPES;
    case "lease":
      return LEASE_ARCHETYPES;
    default:
      return GENERIC_ARCHETYPES;
  }
}

function hasModeledClause(
  ir: ContractIR,
  matcher: (clause: ContractIR["clauses"][number]) => boolean,
): boolean {
  return ir.clauses.some((clause) => clause.modeled && matcher(clause));
}

export function contractFamily(ir: ContractIR): ContractFamily {
  const title = `${ir.title} ${ir.contractId}`.toLowerCase();
  const hasCreditSignals =
    title.includes("credit") ||
    title.includes("card") ||
    hasModeledClause(
      ir,
      (clause) =>
        clause.effect.kind === "payment" &&
        (clause.semanticTag === "late_payment_fee" ||
          clause.semanticTag === "over_limit_fee"),
    ) ||
    hasModeledClause(
      ir,
      (clause) =>
        clause.effect.kind === "formula" &&
        clause.effect.outputVar === "minimum_payment_due",
    );
  const hasLeaseSignals =
    title.includes("lease") ||
    hasModeledClause(
      ir,
      (clause) =>
        clause.effect.kind === "obligation" &&
        clause.id === "clause.obligation.monthly_rent",
    ) ||
    hasModeledClause(
      ir,
      (clause) =>
        clause.effect.kind === "formula" &&
        clause.effect.outputVar === "monthly_rent_due",
    );

  if (hasCreditSignals) return "credit_card";
  if (hasLeaseSignals) return "lease";
  return "generic";
}
