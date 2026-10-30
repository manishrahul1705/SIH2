import { expect, test } from "@playwright/test";
import { signIn } from "./auth.js";

test("faculty saves a yearly-report draft and reads it back from history", async ({ page }) => {
  const academicYear = "2026-27";
  await signIn(page, "faculty@approvaltrack.demo");

  await page.getByRole("link", { name: "Submit Yearly Report" }).click();
  await expect(page.getByRole("heading", { name: "Submit Yearly Report" })).toBeVisible();
  await expect(page.getByText("Verified faculty profile")).toBeVisible();
  await page.getByLabel("Academic year *").fill(academicYear);
  await page.getByLabel("Due date *").fill("2027-06-30");
  await page.getByLabel("Courses taught").fill("E2E course record");
  await page.getByRole("button", { name: "Save draft to backend" }).click();

  await expect(page).toHaveURL(/\/faculty\/yearly-reports$/);
  await expect(page.getByRole("heading", { name: "My Yearly Reports History" })).toBeVisible();
  await expect(page.getByText(`Academic year ${academicYear}`)).toBeVisible();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
});
