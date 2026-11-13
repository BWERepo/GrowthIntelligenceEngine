import { describe, expect, it } from "vitest";
import { dayStatus, dueDailyJobs, localMoment, type WorkSchedule } from "@/lib/schedule";

const bwe: WorkSchedule = {
  timezone: "America/New_York",
  workingDays: [1, 2, 3, 4, 5],
  morningTime: "08:00:00",
  eveningTime: "17:00",
  closedDates: ["2026-11-26"], // Thanksgiving
};

describe("localMoment", () => {
  it("converts to the tenant's wall clock", () => {
    // 13:15 UTC on Mon 16 Nov 2026 is 08:15 in New York (EST, UTC-5).
    expect(localMoment(new Date("2026-11-16T13:15:00Z"), "America/New_York")).toEqual({ date: "2026-11-16", isoWeekday: 1, minutes: 8 * 60 + 15 });
  });
  it("handles the local date differing from the UTC date", () => {
    expect(localMoment(new Date("2026-11-17T03:00:00Z"), "America/New_York").date).toBe("2026-11-16");
  });
  it("follows daylight saving time", () => {
    // 12:00 UTC is 08:00 in New York in summer (EDT, UTC-4) but 07:00 in winter.
    expect(localMoment(new Date("2026-07-06T12:00:00Z"), "America/New_York").minutes).toBe(8 * 60);
    expect(localMoment(new Date("2026-11-16T12:00:00Z"), "America/New_York").minutes).toBe(7 * 60);
  });
});

describe("dueDailyJobs", () => {
  it("nothing is due before 8:00 local", () => {
    expect(dueDailyJobs(new Date("2026-11-16T12:59:00Z"), bwe, [])).toEqual([]);
  });
  it("morning package is due from 8:00 local", () => {
    expect(dueDailyJobs(new Date("2026-11-16T13:00:00Z"), bwe, [])).toEqual([{ job: "morning_package", localDate: "2026-11-16", late: false }]);
  });
  it("is not due again once it has run for that local date", () => {
    expect(dueDailyJobs(new Date("2026-11-16T13:15:00Z"), bwe, [{ job: "morning_package", localDate: "2026-11-16" }])).toEqual([]);
  });
  it("a missed morning run is still produced later, flagged late", () => {
    const due = dueDailyJobs(new Date("2026-11-16T16:00:00Z"), bwe, []); // 11:00 local
    expect(due).toEqual([{ job: "morning_package", localDate: "2026-11-16", late: true }]);
  });
  it("end-of-day review is due from 17:00 local", () => {
    const due = dueDailyJobs(new Date("2026-11-16T22:00:00Z"), bwe, [{ job: "morning_package", localDate: "2026-11-16" }]);
    expect(due).toEqual([{ job: "end_of_day_review", localDate: "2026-11-16", late: false }]);
  });
  it("nothing runs on weekends or closed dates", () => {
    expect(dueDailyJobs(new Date("2026-11-14T15:00:00Z"), bwe, [])).toEqual([]); // Saturday
    expect(dueDailyJobs(new Date("2026-11-26T15:00:00Z"), bwe, [])).toEqual([]); // Thanksgiving
    expect(dayStatus(localMoment(new Date("2026-11-26T15:00:00Z"), bwe.timezone), bwe)).toBe("closed_date");
  });
  it("runs at 8:00 local on both sides of the DST change", () => {
    // Fri 6 Mar 2026 (EST) 08:00 = 13:00 UTC; Mon 9 Mar 2026 (EDT) 08:00 = 12:00 UTC.
    expect(dueDailyJobs(new Date("2026-03-06T12:59:00Z"), bwe, [])).toEqual([]);
    expect(dueDailyJobs(new Date("2026-03-06T13:00:00Z"), bwe, [])).toHaveLength(1);
    expect(dueDailyJobs(new Date("2026-03-09T11:59:00Z"), bwe, [])).toEqual([]);
    expect(dueDailyJobs(new Date("2026-03-09T12:00:00Z"), bwe, [])).toHaveLength(1);
  });
  it("respects each tenant's own time zone", () => {
    const chicago = { ...bwe, timezone: "America/Chicago", closedDates: [] };
    expect(dueDailyJobs(new Date("2026-11-16T13:30:00Z"), chicago, [])).toEqual([]); // 07:30 in Chicago
    expect(dueDailyJobs(new Date("2026-11-16T14:00:00Z"), chicago, [])).toHaveLength(1);
  });
});
