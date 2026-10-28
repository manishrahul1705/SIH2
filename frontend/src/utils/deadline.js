import { isBefore, isSameDay, parseISO, startOfDay } from "date-fns";

export function getDeadlineState(value, now = new Date()) {
  if (!value) return { kind: "missing", label: "No deadline set" };
  const hasTime = /T\d{2}:\d{2}/.test(value);
  if (!hasTime) {
    const deadlineDay = startOfDay(parseISO(value));
    const currentDay = startOfDay(now);
    const days = Math.round((deadlineDay.getTime() - currentDay.getTime()) / 86400000);
    if (days < 0) return { kind: "overdue", label: `Overdue by ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"}` };
    if (days === 0) return { kind: "due", label: "Due now" };
    return { kind: "upcoming", label: `Due in ${days} ${days === 1 ? "day" : "days"}` };
  }
  const deadline = new Date(value);
  if (deadline.getTime() === now.getTime()) return { kind: "due", label: "Due now" };
  if (isBefore(deadline, now)) {
    const days = Math.max(1, Math.ceil((now.getTime() - deadline.getTime()) / 86400000));
    return { kind: "overdue", label: `Overdue by ${days} ${days === 1 ? "day" : "days"}` };
  }
  const days = Math.ceil((startOfDay(deadline).getTime() - startOfDay(now).getTime()) / 86400000);
  if (days === 0 || isSameDay(deadline, now)) return { kind: "due", label: "Due now" };
  return { kind: "upcoming", label: `Due in ${days} ${days === 1 ? "day" : "days"}` };
}
