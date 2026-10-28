export const routeNames = ["Only Scrutiny", "Scrutiny + EVC", "EVC + SAC/SHC", "Only EVC", "Other"];

export function buildRoute(routeName, routes) {
  const stages = routes?.[routeName];
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error(`Unknown or empty policy route: ${routeName}`);
  }
  return [...stages];
}

export function routeForApplication(applicationType, applicationRoutes) {
  const routeName = applicationRoutes?.[applicationType];
  if (!routeName) throw new Error(`No signed-off route configured for: ${applicationType}`);
  return routeName;
}
