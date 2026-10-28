const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_MS = 86_400_000;

function parseDate(value, name) {
  if (value instanceof Date || typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${name} must be an ISO date YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${name} is not a valid calendar date`);
  }
  return date;
}

function iso(date) {
  return date.toISOString().slice(0, 10);
}

export function addMonthsAnniversary(startValue, months) {
  const start = parseDate(startValue, "start");
  if (!Number.isInteger(months) || months < 0) throw new RangeError("months must be an integer >= 0");
  const total = start.getUTCFullYear() * 12 + start.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (start.getUTCDate() <= lastDay) return new Date(Date.UTC(year, month, start.getUTCDate()));
  return new Date(Date.UTC(year, month + 1, 1));
}

export function leaseEndDate(startValue, termMonths) {
  if (!Number.isInteger(termMonths) || termMonths < 1) throw new RangeError("termMonths must be an integer >= 1");
  return iso(new Date(addMonthsAnniversary(startValue, termMonths).getTime() - DAY_MS));
}

export function monthsBetweenLease(startValue, endValue) {
  const start = parseDate(startValue, "start");
  const end = parseDate(endValue, "end");
  if (end < start) return null;
  const after = new Date(end.getTime() + DAY_MS);
  const approximate = (after.getUTCFullYear() - start.getUTCFullYear()) * 12
    + after.getUTCMonth() - start.getUTCMonth();
  for (const months of [approximate, approximate - 1, approximate + 1]) {
    if (months >= 1 && leaseEndDate(iso(start), months) === iso(end)) return months;
  }
  return null;
}

export function reconcileLease(startValue, endValue, termMonths, { startAmbiguous = false, endAmbiguous = false } = {}) {
  const start = startValue && !startAmbiguous ? iso(parseDate(startValue, "start")) : "";
  const end = endValue && !endAmbiguous ? iso(parseDate(endValue, "end")) : "";
  let term = termMonths == null || termMonths === "" ? 0 : Number(termMonths);
  if (!Number.isInteger(term)) throw new TypeError("termMonths must be an integer");
  const flags = [];
  if (term < 1) term = 0;
  if (startAmbiguous) flags.push("start_ambiguous");
  if (endAmbiguous) flags.push("end_ambiguous");
  if (!start || startAmbiguous) return { start: "", end: endAmbiguous ? "" : end, term_months: term, state: "needs_review", reason: startAmbiguous ? "start_ambiguous" : "start_missing", flags };
  if (endAmbiguous) return { start, end: "", term_months: term, state: "needs_review", reason: "end_ambiguous", flags };
  if (end && end <= start) return { start: "", end: "", term_months: term, state: "needs_review", reason: "end_not_after_start", flags: [...flags, "end_not_after_start"] };
  if (!end && !term) return { start, end: "", term_months: 0, state: "needs_review", reason: "end_and_term_missing", flags };
  if (end && term) {
    const computed = leaseEndDate(start, term);
    return end === computed
      ? { start, end, term_months: term, state: "ok", reason: "consistent", flags }
      : { start, end, term_months: term, state: "inconsistent", reason: "stated_end_disagrees_with_term", flags: [...flags, "end_disagrees_with_term"], computed_end: computed };
  }
  if (!end) {
    const computedEnd = leaseEndDate(start, term);
    return { start, end: computedEnd, term_months: term, state: "derived", reason: "end_derived_from_term", flags, end_derived: true };
  }
  const derivedTerm = monthsBetweenLease(start, end);
  return derivedTerm
    ? { start, end, term_months: derivedTerm, state: "derived", reason: "term_derived_from_dates", flags, term_derived: true }
    : { start, end, term_months: 0, state: "ok", reason: "term_not_whole_months", flags: [...flags, "term_not_whole_months"] };
}

export function computeLease({ start, end, termMonths, asOf, reminderDays = 90, oneDayTolerance = true }) {
  const reconciled = reconcileLease(start, end, termMonths);
  const asOfDate = parseDate(asOf, "asOf");
  let status = "needs_review";
  let daysRemaining = null;
  const flags = [];
  let consistency = reconciled.state;
  if (reconciled.state === "needs_review") flags.push(reconciled.reason.toUpperCase());
  if (reconciled.state !== "needs_review") {
    const effectiveEnd = parseDate(reconciled.end, "end");
    const statedEnd = end ? parseDate(end, "end") : null;
    const computedEnd = reconciled.computed_end ? parseDate(reconciled.computed_end, "computed_end") : null;
    const withinTolerance = oneDayTolerance && statedEnd && computedEnd
      && Math.abs((statedEnd - computedEnd) / DAY_MS) <= 1;
    if (withinTolerance) consistency = "consistent";
    if (reconciled.state === "inconsistent" && !withinTolerance) {
      status = "mismatch";
      flags.push("TERM_END_MISMATCH");
    } else if (asOfDate < parseDate(reconciled.start, "start")) {
      status = "not_started";
    } else if (asOfDate > effectiveEnd) {
      status = "expired";
      flags.push("EXPIRED");
    } else {
      daysRemaining = Math.floor((effectiveEnd - asOfDate) / DAY_MS);
      status = daysRemaining <= reminderDays ? "expires_soon" : "live";
      if (status === "expires_soon") flags.push("EXPIRING_SOON");
    }
  }
  return {
    start: reconciled.start,
    end: reconciled.end,
    term_months: reconciled.term_months,
    consistency,
    status,
    days_remaining: daysRemaining,
    proposed_review_flag: flags.length > 0,
    flag_reasons: flags,
    flag_state: "under_review",
    points_until_official_confirms: 0,
  };
}

export function displayDate(isoDate) {
  const date = parseDate(isoDate, "date");
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth() + 1]} ${date.getUTCFullYear()}`;
}
