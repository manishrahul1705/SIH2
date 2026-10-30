function isolatedDatabaseName(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("E2E requires a valid MONGODB_URI for its isolated disposable database.");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, "").split("/")[0] || "");
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (!localHost || !/^approvaltrack_e2e_[a-f0-9]{12,32}$/.test(database)) {
    throw new Error("E2E is restricted to localhost MongoDB databases named approvaltrack_e2e_<12-32 hex characters>.");
  }
  return database;
}

export default async function globalSetup() {
  isolatedDatabaseName(process.env.MONGODB_URI || "");
  process.env.DEMO_PASSWORD = process.env.E2E_DEMO_PASSWORD;
  const { seedDatabase } = await import("../../backend/src/models/seed.js");
  await seedDatabase();
}

export { isolatedDatabaseName };
