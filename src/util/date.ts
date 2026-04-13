const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseIsoDate(date: string): Date {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO date: ${date}`);
  }
  return parsed;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function daysBetween(startDate: string, endDate: string): number {
  const start = parseIsoDate(startDate).getTime();
  const end = parseIsoDate(endDate).getTime();
  const delta = end - start;
  if (delta < 0) {
    throw new Error(`endDate must be >= startDate (${startDate} -> ${endDate})`);
  }
  return Math.floor(delta / MS_PER_DAY);
}

export function addCalendarDays(date: string, days: number): string {
  const base = parseIsoDate(date).getTime();
  return formatIsoDate(new Date(base + days * MS_PER_DAY));
}

export function addBusinessDays(date: string, days: number): string {
  let remaining = days;
  let current = parseIsoDate(date);

  while (remaining > 0) {
    current = new Date(current.getTime() + MS_PER_DAY);
    const day = current.getUTCDay();
    if (day !== 0 && day !== 6) {
      remaining -= 1;
    }
  }

  return formatIsoDate(current);
}
