import { startOfLocalDayUtc } from "@/lib/schedule";

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** [from, to) in UTC for a tenant-local calendar month, and its first and last local dates. */
export function monthRange(month: string, timezone: string) {
  if (!MONTH.test(month)) throw new Error("Invalid: month must look like 2026-11.");
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: startOfLocalDayUtc(`${month}-01`, timezone).toISOString(),
    to: startOfLocalDayUtc(`${next}-01`, timezone).toISOString(),
    firstDate: `${month}-01`,
    lastDate: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

/** The last `count` months ending with the tenant-local month of `today` ("YYYY-MM-DD"), newest first. */
export function recentMonths(today: string, count = 6): string[] {
  let [y, m] = today.split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}
