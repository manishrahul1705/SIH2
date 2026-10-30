const INDIA_OFFSET_MINUTES = 330;
const DAY_MS = 24 * 60 * 60 * 1000;

export function indiaCalendarDateEnd(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)
    || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError("year, month, and day must describe a valid calendar date");
  }
  return new Date(date.getTime() + DAY_MS - INDIA_OFFSET_MINUTES * 60_000 - 1);
}

export function dueStatus({ dueAt, dueKind = "timestamp", now = new Date(), dateCutoffHour = 0 }) {
  if (dueAt == null || dueAt === "") return "data_quality";
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) throw new TypeError("now must be a valid date");
  if (dueKind === "timestamp") {
    const deadline = dueAt instanceof Date ? dueAt : new Date(dueAt);
    if (Number.isNaN(deadline.getTime())) return "data_quality";
    if (deadline.getTime() < instant.getTime()) return "overdue";
    if (deadline.getTime() === instant.getTime()) return "due_now";
    return "upcoming";
  }
  if (dueKind !== "date") throw new TypeError("dueKind must be timestamp or date");
  if (!Number.isInteger(dateCutoffHour) || dateCutoffHour < 0 || dateCutoffHour > 23) {
    throw new RangeError("dateCutoffHour must be between 0 and 23");
  }
  const dateOnly = typeof dueAt === "string" ? dueAt.slice(0, 10) : dueAt.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly) || Number.isNaN(Date.parse(`${dateOnly}T00:00:00Z`))) return "data_quality";
  const [year, month, day] = dateOnly.split("-").map(Number);
  const parsedDate = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  if (parsedDate !== dateOnly) return "data_quality";
  const cutoffUtc = Date.UTC(year, month - 1, day + 1, dateCutoffHour) - INDIA_OFFSET_MINUTES * 60_000;
  return instant.getTime() >= cutoffUtc ? "overdue" : "upcoming";
}

export function splitOwnershipTime(history, asOf) {
  const totals = { institutionMs: 0, officerMs: 0, committeeMs: 0 };
  for (const entry of history) {
    const entered = new Date(entry.enteredAt).getTime();
    const left = entry.leftAt ? new Date(entry.leftAt).getTime() : asOf ? new Date(asOf).getTime() : NaN;
    if (!Number.isFinite(entered) || !Number.isFinite(left) || left < entered) {
      throw new RangeError("Stage history timestamps must be valid and ordered");
    }
    const key = `${entry.holderType}Ms`;
    if (!(key in totals)) throw new TypeError(`Unknown holder type: ${entry.holderType}`);
    totals[key] += left - entered;
  }
  return totals;
}

export function createAlertKey({ obligationId, deadlineRevision, ruleVersion, level, recipient, channel }) {
  for (const [name, value] of Object.entries({ obligationId, deadlineRevision, ruleVersion, level, recipient, channel })) {
    if (value === undefined || value === null || value === "") throw new TypeError(`${name} is required`);
  }
  return JSON.stringify([obligationId, deadlineRevision, ruleVersion, level, recipient, channel]);
}

export function isWithinReminderWindow(dueAt, now, days) {
  const remaining = new Date(dueAt).getTime() - new Date(now).getTime();
  return remaining >= 0 && remaining <= days * DAY_MS;
}

export function obligationReminderLevel({ dueAt, dueKind = "timestamp", now = new Date(), reminderDays = [], escalationAfterDays = [] }) {
  const status = dueStatus({ dueAt, dueKind, now });
  if (status === "data_quality") return null;
  const instant = now instanceof Date ? now : new Date(now);
  let daysUntilDue;
  if (dueKind === "date") {
    const dateOnly = typeof dueAt === "string" ? dueAt.slice(0, 10) : dueAt.toISOString().slice(0, 10);
    const [year, month, day] = dateOnly.split("-").map(Number);
    const localParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const localValue = (type) => Number(localParts.find((part) => part.type === type)?.value);
    const today = Date.UTC(localValue("year"), localValue("month") - 1, localValue("day"));
    daysUntilDue = Math.round((Date.UTC(year, month - 1, day) - today) / DAY_MS);
  } else {
    const remaining = new Date(dueAt).getTime() - instant.getTime();
    daysUntilDue = remaining >= 0 ? Math.ceil(remaining / DAY_MS) : -Math.floor(-remaining / DAY_MS);
  }
  if (status !== "overdue" && reminderDays.includes(daysUntilDue)) return `reminder_${daysUntilDue}d`;
  const overdueDays = Math.max(0, -daysUntilDue);
  if (status === "overdue" && escalationAfterDays.includes(overdueDays)) return `escalation_${overdueDays}d`;
  return null;
}

export function addOwnershipInterval(history, holderType, enteredAt, leftAt) {
  return [...history, { holderType, enteredAt: new Date(enteredAt), leftAt: new Date(leftAt) }];
}

export function closesRenewalObligation(renewal) {
  return renewal?.submission === "submitted" && renewal?.verification === "verified";
}
