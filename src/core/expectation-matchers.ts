import type { Expr, Party } from "../types/ir.js";

// Operators whose argument order does not change meaning. The checker
// treats their args as a multiset so `mul(var(x), const(0.03))` and
// `mul(const(0.03), var(x))` are equivalent.
export const COMMUTATIVE_OPS = new Set(["mul", "add", "max", "min"]);

export type ShapeNode =
  | { kind: "const"; value: number }
  | { kind: "var"; name: string }
  | { kind: "op"; op: string; args: ShapeNode[] };

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number(value).toString();
}

export function exprShape(expr: Expr): string {
  if (expr.op === "const") {
    return `const(${canonicalNumber(typeof expr.value === "number" ? expr.value : 0)})`;
  }
  if (expr.op === "var") {
    return `var(${expr.name ?? "var"})`;
  }
  const args = Array.isArray(expr.args) ? expr.args : [];
  const rendered = args.map(exprShape);
  const ordered = COMMUTATIVE_OPS.has(expr.op) ? [...rendered].sort() : rendered;
  return `${expr.op}(${ordered.join(",")})`;
}

// Parses shape strings like `max(mul(var(new_balance), const(0.03)), const(15))`.
// Recognizes `var(*)` as a wildcard and is tolerant of whitespace.
export function parseShape(raw: string): ShapeNode | null {
  const src = raw.replace(/\s+/g, "");
  let i = 0;
  function parseNode(): ShapeNode | null {
    const start = i;
    while (i < src.length && /[a-z_*0-9.\-]/i.test(src[i]!)) i += 1;
    const head = src.slice(start, i);
    if (!head) return null;
    if (src[i] !== "(") {
      const num = Number(head);
      if (Number.isFinite(num)) return { kind: "const", value: num };
      return { kind: "var", name: head };
    }
    i += 1;
    const args: ShapeNode[] = [];
    if (src[i] !== ")") {
      while (true) {
        const arg = parseNode();
        if (!arg) return null;
        args.push(arg);
        if (src[i] === ",") {
          i += 1;
          continue;
        }
        break;
      }
    }
    if (src[i] !== ")") return null;
    i += 1;
    const op = head.toLowerCase();
    if (op === "const" && args.length === 1 && args[0]!.kind === "const") {
      return args[0]!;
    }
    if (op === "var" && args.length === 1 && args[0]!.kind === "var") {
      return args[0]!;
    }
    return { kind: "op", op, args };
  }
  const root = parseNode();
  if (!root || i !== src.length) return null;
  return root;
}

export function exprToShapeNode(expr: Expr): ShapeNode {
  if (expr.op === "const") {
    return {
      kind: "const",
      value: typeof expr.value === "number" ? expr.value : 0,
    };
  }
  if (expr.op === "var") {
    return { kind: "var", name: expr.name ?? "var" };
  }
  const args = Array.isArray(expr.args) ? expr.args : [];
  return { kind: "op", op: expr.op, args: args.map(exprToShapeNode) };
}

export function shapesMatch(expected: ShapeNode, actual: ShapeNode): boolean {
  if (expected.kind === "const") {
    return actual.kind === "const" && Math.abs(expected.value - actual.value) <= 1e-9;
  }
  if (expected.kind === "var") {
    if (actual.kind !== "var") return false;
    if (expected.name === "*") return true;
    // Variable names are contract-specific; the expectation writes a
    // portable name (`grossOfferingProceeds`), IRs surface the document's
    // own identifier (`aggregate_gross_offering_proceeds`). A lenient
    // substring match on the normalized identifier keeps the shape check
    // structural without going fully wild.
    return lenientNameMatches(expected.name, actual.name);
  }
  if (actual.kind !== "op" || expected.op !== actual.op) return false;
  if (expected.args.length !== actual.args.length) return false;
  if (!COMMUTATIVE_OPS.has(expected.op)) {
    return expected.args.every((arg, idx) => shapesMatch(arg, actual.args[idx]!));
  }
  const remaining = [...actual.args];
  for (const want of expected.args) {
    const idx = remaining.findIndex((cand) => shapesMatch(want, cand));
    if (idx < 0) return false;
    remaining.splice(idx, 1);
  }
  return true;
}

// Synonyms for canonical family roles. Expectations are written in
// family-standard terms (`employer`, `issuer`, `landlord`); IRs sometimes
// record a contract-specific surface role (`company`, `credit_union`,
// `lessor`). This table is a small, intentional safety net on top of the
// prompt's canonical-role guidance — extend only when a contract genuinely
// uses a non-standard surface role.
const ROLE_SYNONYMS: Record<string, string[]> = {
  employer: ["company", "corporation", "employer"],
  employee: ["employee", "executive", "contractor"],
  issuer: ["issuer", "bank", "creditor", "credit_union", "card_issuer"],
  cardholder: ["cardholder", "borrower"],
  landlord: ["landlord", "lessor", "owner"],
  tenant: ["tenant", "lessee"],
  buyer: ["buyer", "purchaser", "customer"],
  seller: ["seller", "vendor", "supplier", "target_shareholders", "target"],
  acquirer: ["acquirer", "parent"],
  target: ["target", "target_shareholders"],
  service_provider: ["service_provider", "manager", "advisor"],
  client: ["client", "fund", "distributor"],
  // Pseudo-actor terms contracts use when either side may act.
  any_party: ["any_party", "either_party", "each_party", "all_parties", "both_parties"],
  either_party: ["either_party", "any_party", "each_party", "all_parties", "both_parties"],
  all_parties: ["all_parties", "each_party", "both_parties", "any_party", "either_party"],
  each_party: ["each_party", "all_parties", "both_parties", "any_party", "either_party"],
  indemnitee: ["indemnitee", "either_party", "any_party"],
};

function normalizeRole(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]/g, "_");
}

function roleMatches(expected: string, actualRole: string): boolean {
  const want = normalizeRole(expected);
  const got = normalizeRole(actualRole);
  if (want === got) return true;
  const synonyms = ROLE_SYNONYMS[want];
  if (synonyms && synonyms.includes(got)) return true;
  const reverseKey = Object.entries(ROLE_SYNONYMS).find(([, values]) =>
    values.includes(want),
  );
  if (reverseKey && (reverseKey[0] === got || reverseKey[1].includes(got))) {
    return true;
  }
  return false;
}

// Resolves the expectation's role-based party reference (e.g. `cardholder`,
// `issuer`) against IR's party-id form (e.g. `party-cardholder`,
// `party-credit_union` with role `issuer`). Matches by id (with/without
// `party-` prefix), by registered role, or via a small synonym table for
// family-standard roles that contracts surface under local names.
// Pseudo-actors like `any_party` / `either_party` / `all_parties` /
// `each_party` are treated as equivalent — they describe the same
// universal-quantifier actor.
export function partyMatches(
  expected: string,
  actual: string,
  parties: Party[],
): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/^party-/, "");
  const want = norm(expected);
  if (!want) return expected === actual;
  if (norm(actual) === want) return true;
  // Pseudo-actor synonyms (neither side is necessarily a registered party).
  if (roleMatches(expected, actual)) return true;
  const party = parties.find((p) => p.id === actual);
  if (!party) return false;
  if (norm(party.id) === want) return true;
  if (roleMatches(expected, party.role)) return true;
  return false;
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s-]+/g, "");
}

// Unit conversion for `TemporalRule.type` so an expectation of
// `{type: months, value: 12}` matches an IR emitting
// `{type: calendar_days, value: 365}`. Approximate — calendar_days and
// business_days drift past ~2 months — but close enough to distinguish
// "1 year" from "30 days".
const DAYS_PER_UNIT: Record<string, number> = {
  calendar_days: 1,
  business_days: 1.4,
  days: 1,
  weeks: 7,
  months: 30,
  years: 365,
};

function daysFromDue(type: string, value: unknown): number | null {
  const perDay = DAYS_PER_UNIT[type.toLowerCase()];
  if (perDay === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value * perDay;
}

// True when two `TemporalRule`-ish {type, value} pairs describe the same
// duration within ~5% tolerance, regardless of unit.
export function durationsEquivalent(
  expected: { type: unknown; value: unknown },
  actual: { type: unknown; value: unknown },
): boolean {
  if (typeof expected.type !== "string" || typeof actual.type !== "string") return false;
  const a = daysFromDue(expected.type, expected.value);
  const b = daysFromDue(actual.type, actual.value);
  if (a === null || b === null || a === 0) return false;
  return Math.abs(a - b) / a <= 0.05;
}

function identifierTokens(value: string): string[] {
  // Split snake_case / kebab-case / camelCase into lowercase word tokens.
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((t) => t.length >= 2);
}

// Bidirectional substring plus token-overlap fallback for variable-name
// fields. `annualBaseSalary` ↔ `then_applicable_annual_base_salary`
// matches via substring after normalization; token-overlap catches cases
// where expected and actual use differently-ordered compound names.
export function lenientNameMatches(expected: string, actual: string): boolean {
  const wantRaw = expected.trim().toLowerCase();
  const gotRaw = actual.trim().toLowerCase();
  if (!wantRaw) return true;
  if (wantRaw === gotRaw) return true;
  if (gotRaw.includes(wantRaw) || wantRaw.includes(gotRaw)) return true;
  const wantN = normalizeIdentifier(wantRaw);
  const gotN = normalizeIdentifier(gotRaw);
  if (wantN && gotN && (gotN.includes(wantN) || wantN.includes(gotN))) {
    return true;
  }
  const wantTokens = identifierTokens(expected);
  const gotTokens = identifierTokens(actual);
  if (wantTokens.length === 0) return false;
  const gotSet = new Set(gotTokens);
  const hits = wantTokens.filter((t) => gotSet.has(t)).length;
  return hits / wantTokens.length >= 0.6;
}

const PROSE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "by",
  "at",
  "or",
  "nor",
  "not",
  "any",
  "all",
  "each",
  "such",
  "as",
  "be",
  "been",
  "is",
  "are",
  "was",
  "were",
  "shall",
  "will",
  "may",
  "from",
  "into",
]);

// Cheap morphology normalizer so "soliciting" / "solicits" / "solicited"
// all collapse to the same stem. Not a real Porter stemmer — just strips
// common English inflections that make exact-token comparison miss
// semantic equivalence in legal prose.
function stem(token: string): string {
  if (token.length < 5) return token;
  if (token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.endsWith("ing")) return token.slice(0, -3);
  if (token.endsWith("ed")) return token.slice(0, -2);
  if (token.endsWith("es")) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  if (token.endsWith("ly")) return token.slice(0, -2);
  return token;
}

function proseTokens(value: string): Set<string> {
  const tokens = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(
    tokens
      .filter((t) => t.length >= 3 && !PROSE_STOP_WORDS.has(t))
      .map(stem),
  );
}

// Natural-language fields (`action`, `scope`, items of `consequences`)
// drift by paraphrase: "provide 2 weeks' written notice" vs "provide
// written notice of termination at least two weeks before the effective
// date". Token-overlap with stop-words removed gives a stable signal that
// two strings describe the same clause without demanding exact wording.
export function proseOverlapMatches(
  expected: string,
  actual: string,
  threshold = 0.6,
): boolean {
  if (!expected.trim()) return true;
  const want = proseTokens(expected);
  const got = proseTokens(actual);
  if (want.size === 0) return true;
  let hits = 0;
  for (const token of want) if (got.has(token)) hits += 1;
  return hits / want.size >= threshold;
}
