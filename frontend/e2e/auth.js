import { expect } from "@playwright/test";

export async function signIn(page, email) {
  await page.goto("/login");
  const loginResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/auth/login") && response.request().method() === "POST");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(process.env.E2E_DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  const loginResponse = await loginResponsePromise;
  if (!loginResponse.ok()) {
    const result = await loginResponse.json().catch(() => null);
    throw new Error(`Sign-in failed with HTTP ${loginResponse.status()}: ${result?.error?.code || "UNKNOWN_ERROR"}`);
  }
  await expect(page).not.toHaveURL(/\/login$/);
}
