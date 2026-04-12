export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function max(a: number, b: number): number {
  return a > b ? a : b;
}

export function min(a: number, b: number): number {
  return a < b ? a : b;
}
