import type { BoolExpr } from "../types/ir.js";

export type BoolEnv = Record<string, string | number | boolean>;

function toComparableValue(
  value: string | number | boolean | BoolExpr | undefined,
  env: BoolEnv,
): string | number | boolean {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value in env) return env[value] as string | number | boolean;
    return value;
  }
  if (value && typeof value === "object") {
    return evaluateBoolExpr(value, env);
  }
  return "";
}

function toFiniteNumber(value: string | number | boolean): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

export function evaluateBoolExpr(expr: BoolExpr, env: BoolEnv): boolean {
  switch (expr.op) {
    case "eq":
      return toComparableValue(expr.left, env) === toComparableValue(expr.right, env);
    case "neq":
      return toComparableValue(expr.left, env) !== toComparableValue(expr.right, env);
    case "gt": {
      const left = toFiniteNumber(toComparableValue(expr.left, env));
      const right = toFiniteNumber(toComparableValue(expr.right, env));
      if (left == null || right == null) return false;
      return left > right;
    }
    case "gte": {
      const left = toFiniteNumber(toComparableValue(expr.left, env));
      const right = toFiniteNumber(toComparableValue(expr.right, env));
      if (left == null || right == null) return false;
      return left >= right;
    }
    case "lt": {
      const left = toFiniteNumber(toComparableValue(expr.left, env));
      const right = toFiniteNumber(toComparableValue(expr.right, env));
      if (left == null || right == null) return false;
      return left < right;
    }
    case "lte": {
      const left = toFiniteNumber(toComparableValue(expr.left, env));
      const right = toFiniteNumber(toComparableValue(expr.right, env));
      if (left == null || right == null) return false;
      return left <= right;
    }
    case "and": {
      const args = expr.args || [];
      if (args.length === 0) return false;
      return args.every((arg) => evaluateBoolExpr(arg, env));
    }
    case "or": {
      const args = expr.args || [];
      if (args.length === 0) return false;
      return args.some((arg) => evaluateBoolExpr(arg, env));
    }
    case "not": {
      const args = expr.args || [];
      if (args.length !== 1) return false;
      return !evaluateBoolExpr(args[0]!, env);
    }
    default:
      return false;
  }
}
