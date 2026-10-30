import { expect, test } from "@playwright/test";
import { signIn } from "./auth.js";

test("institution saves an annual-report draft and reads the persisted report", async ({ page }) => {
  const year = 2026;
  await signIn(page, "institution@approvaltrack.demo");

  await page.goto("/institution-annual-report");
  await expect(page.getByRole("heading", { name: "Internal Committee annual report" })).toBeVisible();
  await page.getByLabel("Action taken").fill(`E2E isolated-database draft for ${year}.`);
  await page.getByRole("button", { name: "Save draft" }).click();

  await expect(page.getByText(`Calendar year ${year}`, { exact: false }).last()).toBeVisible();
  await expect(page.getByText("DRAFT", { exact: true })).toBeVisible();
});
