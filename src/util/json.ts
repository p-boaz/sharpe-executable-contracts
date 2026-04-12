function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const output: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      output[key] = sortValue(entryValue);
    }
    return output;
  }

  return value;
}

export function stableStringify(value: unknown, spaces = 2): string {
  return JSON.stringify(sortValue(value), null, spaces);
}
