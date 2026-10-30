import { describe, expect, it } from "vitest";
import { indiaCalendarDateEnd } from "../src/engine/timeRules.js";
import { istDaysBetween } from "../src/modules/jobs/run.js";

describe("IST calendar-day calculations", () => {
  it("does not mistake a UTC midnight boundary for an IST day change", () => {
    expect(istDaysBetween("2026-10-28T00:00:00.000Z", "2026-10-27T23:00:00.000Z")).toBe(0);
  });

  it("counts a full IST date boundary as one day", () => {
    expect(istDaysBetween("2026-10-28T20:00:00.000Z", "2026-10-27T20:00:00.000Z")).toBe(1);
  });

  it("keeps the institutional annual report deadline on June 30 in India", () => {
    const deadline = indiaCalendarDateEnd(2026, 6, 30);
    expect(deadline.toISOString()).toBe("2026-06-30T18:29:59.999Z");
    expect(istDaysBetween(deadline, "2026-06-30T18:00:00.000Z")).toBe(0);
    expect(istDaysBetween(deadline, "2026-06-30T18:30:00.000Z")).toBe(-1);
  });

  it("rejects impossible dates instead of producing a shifted deadline", () => {
    expect(() => indiaCalendarDateEnd(2026, 2, 30)).toThrow(/valid calendar date/i);
  });
});
