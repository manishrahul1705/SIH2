import { describe, expect, it } from "vitest";
import { istDaysBetween } from "../src/modules/jobs/run.js";

describe("IST calendar-day calculations", () => {
  it("does not mistake a UTC midnight boundary for an IST day change", () => {
    expect(istDaysBetween("2026-10-28T00:00:00.000Z", "2026-10-27T23:00:00.000Z")).toBe(0);
  });

  it("counts a full IST date boundary as one day", () => {
    expect(istDaysBetween("2026-10-28T20:00:00.000Z", "2026-10-27T20:00:00.000Z")).toBe(1);
  });
});
