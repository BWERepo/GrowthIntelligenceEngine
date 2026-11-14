// Tenant-local scheduling: which daily jobs are due for a tenant right now.
// Pure, so it is tested without a database or a clock. The dispatcher (Phase 3)
// claims a due job by inserting gie_job_runs (tenant, kind, local_date); the
// unique key makes a second claim for the same local date a no-op.

export type WorkSchedule = {
  timezone: string; // IANA name
  workingDays: number[]; // ISO weekdays, 1 = Monday ... 7 = Sunday
  morningTime: string; // "HH:MM" or "HH:MM:SS"
  eveningTime: string;
  closedDates: string[]; // "YYYY-MM-DD", tenant-local
};

export type DailyJob = "morning_package" | "end_of_day_review";

export type LocalMoment = { date: string; isoWeekday: number; minutes: number };

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Wall-clock date, weekday and minute-of-day in `timezone` at instant `now`. DST-correct via Intl. */
export function localMoment(now: Date, timezone: string): LocalMoment {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    isoWeekday: WEEKDAYS[parts.weekday as string] ?? 0,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export type DayStatus = "business_day" | "non_working_weekday" | "closed_date";

export function dayStatus(local: LocalMoment, schedule: WorkSchedule): DayStatus {
  if (schedule.closedDates.includes(local.date)) return "closed_date";
  if (!schedule.workingDays.includes(local.isoWeekday)) return "non_working_weekday";
  return "business_day";
}

/**
 * Daily jobs whose local start time has passed today and that have not run yet.
 * A job found due well after its time (e.g. after an outage) is flagged late
 * rather than skipped, so a missed 08:00 still produces that day's package.
 */
export function dueDailyJobs(
  now: Date,
  schedule: WorkSchedule,
  alreadyRun: ReadonlyArray<{ job: DailyJob; localDate: string }>,
  lateAfterMinutes = 60,
): Array<{ job: DailyJob; localDate: string; late: boolean }> {
  const local = localMoment(now, schedule.timezone);
  if (dayStatus(local, schedule) !== "business_day") return [];
  const jobs: Array<[DailyJob, string]> = [
    ["morning_package", schedule.morningTime],
    ["end_of_day_review", schedule.eveningTime],
  ];
  return jobs
    .filter(([job, at]) => local.minutes >= toMinutes(at) && !alreadyRun.some((r) => r.job === job && r.localDate === local.date))
    .map(([job, at]) => ({ job, localDate: local.date, late: local.minutes - toMinutes(at) > lateAfterMinutes }));
}

/**
 * The UTC instant at which local date `localDate` ("YYYY-MM-DD") begins in
 * `timezone`. Two passes of the offset correction handle DST changes.
 */
export function startOfLocalDayUtc(localDate: string, timezone: string): Date {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const local = localMoment(new Date(guess), timezone);
    const [ly, lm, ld] = local.date.split("-").map(Number) as [number, number, number];
    const shownAsUtc = Date.UTC(ly, lm - 1, ld) + local.minutes * 60_000;
    guess += target - shownAsUtc;
  }
  return new Date(guess);
}

/** The UTC instant at which the tenant-local month containing `now` began (for monthly budgets). */
export function startOfLocalMonthUtc(now: Date, timezone: string): Date {
  const local = localMoment(now, timezone);
  return startOfLocalDayUtc(`${local.date.slice(0, 7)}-01`, timezone);
}

/** Overnight discovery window, tenant-local: searches start at 02:00 and may start until 06:00. */
export function inDiscoveryWindow(now: Date, timezone: string, startMinutes = 120, endMinutes = 360): boolean {
  const { minutes } = localMoment(now, timezone);
  return minutes >= startMinutes && minutes < endMinutes;
}
