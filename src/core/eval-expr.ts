import type { Expr } from "../types/ir.js";

export type ExprEnv = Record<string, number>;

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function evaluateExpr(expr: Expr, env: ExprEnv): number {
  switch (expr.op) {
    case "const":
      return finiteOrZero(expr.value ?? 0);
    case "var":
      return finiteOrZero(env[expr.name || ""] ?? 0);
    case "add": {
      const args = expr.args || [];
      return finiteOrZero(args.reduce((sum, arg) => sum + evaluateExpr(arg, env), 0));
    }
    case "sub": {
      const args = expr.args || [];
      if (args.length === 0) return 0;
      const [first, ...rest] = args;
      if (!first) return 0;
      return finiteOrZero(
        rest.reduce((acc, arg) => acc - evaluateExpr(arg, env), evaluateExpr(first, env)),
      );
    }
    case "mul": {
      const args = expr.args || [];
      if (args.length === 0) return 0;
      return finiteOrZero(args.reduce((acc, arg) => acc * evaluateExpr(arg, env), 1));
    }
    case "div": {
      const args = expr.args || [];
      if (args.length === 0) return 0;
      const [first, ...rest] = args;
      if (!first) return 0;
      let value = evaluateExpr(first, env);
      for (const arg of rest) {
        const divisor = evaluateExpr(arg, env);
        if (divisor === 0) return 0;
        value /= divisor;
      }
      return finiteOrZero(value);
    }
    case "max": {
      const args = expr.args || [];
      if (args.length === 0) return 0;
      return finiteOrZero(Math.max(...args.map((arg) => evaluateExpr(arg, env))));
    }
    case "min": {
      const args = expr.args || [];
      if (args.length === 0) return 0;
      return finiteOrZero(Math.min(...args.map((arg) => evaluateExpr(arg, env))));
    }
    default:
      return 0;
  }
}
