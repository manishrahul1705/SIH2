import { APPLICATION_TYPES } from "./checklist.js";
import { DEFAULT_CASE_ROUTES } from "./policyDefaults.js";

export function buildCaseRoute(applicationType, policyRoutes = {}, flags = {}) {
  if (!APPLICATION_TYPES.includes(applicationType)) {
    throw new TypeError(`Unsupported application type: ${applicationType}`);
  }
  const configured = policyRoutes[applicationType];
  if (configured !== undefined && (!Array.isArray(configured) || configured.some((stage) => typeof stage !== "string"))) {
    throw new TypeError(`Invalid route configuration for ${applicationType}`);
  }
  const stages = configured ? [...configured] : [...DEFAULT_CASE_ROUTES[applicationType]];
  if (flags.evcRandomOrRequired === true && !stages.includes("evc")) stages.splice(stages.indexOf("decision"), 0, "evc");
  if (applicationType === "restoration_of_intake" && flags.hearingRequired === true && !stages.includes("shc")) stages.splice(stages.indexOf("decision"), 0, "shc");
  if (applicationType === "restoration_of_intake" && flags.appealRequired === true && !stages.includes("sac")) stages.splice(stages.indexOf("decision"), 0, "sac");
  if (stages[0] !== "submitted" || stages[1] !== "self_disclosure" || stages.at(-1) !== "decision") {
    throw new TypeError(`Route for ${applicationType} must start with submitted/self_disclosure and end with decision`);
  }
  if (new Set(stages).size !== stages.length || stages.includes("re_scrutiny")) {
    throw new TypeError(`Route for ${applicationType} contains duplicate or return-only stages`);
  }
  return stages;
}

export function returnTargetIsEarlier(route, currentStage, targetStage) {
  const currentIndex = route.indexOf(currentStage);
  const targetIndex = route.indexOf(targetStage);
  return currentIndex > 0 && targetIndex >= 0 && targetIndex < currentIndex;
}
