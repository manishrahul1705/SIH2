import { dueStatus, isWithinReminderWindow } from "./timeRules.js";

const priority = (item, now) => {
  const status = dueStatus({ dueAt: item.dueAt, dueKind: item.dueKind, now });
  if (status === "overdue" || item.unresolvedEscalation) return 0;
  if (item.dueAt && isWithinReminderWindow(item.dueAt, now, 1)) return 1;
  if (item.ready) return 2;
  if (item.dueAt && isWithinReminderWindow(item.dueAt, now, 30)) return 3;
  return 4;
};

export function orderOfficerQueue(items, now = new Date()) {
  return [...items]
    .filter((item) => item.ownerType === "officer" || item.ownerType === "unassigned")
    .sort((left, right) => (
      priority(left, now) - priority(right, now)
      || (left.dueAt ? new Date(left.dueAt).getTime() : Number.MAX_SAFE_INTEGER)
        - (right.dueAt ? new Date(right.dueAt).getTime() : Number.MAX_SAFE_INTEGER)
      || String(left.id).localeCompare(String(right.id))
    ));
}

export function institutionRollupCount(items) {
  return items.filter((item) => item.ownerType === "institution").length;
}
