export const ROLES = Object.freeze([
  "INSTITUTION",
  "SCRUTINY_OFFICER",
  "EVC",
  "SAC_SHC",
  "BUREAU_OFFICER",
  "SENIOR_AUTHORITY",
  "ADMIN",
  "STUDENT",
  "FACULTY",
]);

export const APPLICATION_TYPES = Object.freeze([
  "NEW",
  "EXTENSION_OF_APPROVAL",
  "INCREASE_INTAKE",
  "NEW_COURSE",
  "CLOSURE",
]);

export const APPLICATION_STAGES = Object.freeze([
  "SUBMITTED",
  "SCRUTINY",
  "RE_SCRUTINY",
  "EVC",
  "SAC_SHC",
  "DECISION",
  "COMPLETED",
]);

export const API_PREFIX = "/api/v1";
export const SESSION_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;
