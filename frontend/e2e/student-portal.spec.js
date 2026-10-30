import { expect, test } from "@playwright/test";
import { signIn } from "./auth.js";

test("student views official notices and submits a complaint visible in the tracker", async ({ page }) => {
  const subject = `E2E student complaint ${crypto.randomUUID()}`;
  await signIn(page, "student@approvaltrack.demo");

  await page.getByRole("link", { name: "AICTE Announcements" }).click();
  await expect(page.getByRole("heading", { name: "Announcements & Circulars" })).toBeVisible();
  await expect(page.getByText("No published announcements")).toBeVisible();

  await page.getByRole("link", { name: "Lodge a Complaint" }).click();
  await page.getByRole("combobox", { name: "Category" }).selectOption("FEES");
  await page.getByLabel("Subject").fill(subject);
  await page.getByLabel("Describe the issue").fill("E2E validation complaint submitted only to the disposable test database.");
  await page.getByRole("button", { name: "Submit complaint" }).click();

  await expect(page).toHaveURL(/\/student\/complaints$/);
  await expect(page.getByRole("heading", { name: "My Complaints & Tracker" })).toBeVisible();
  await expect(page.getByText(subject)).toBeVisible();
  await expect(page.getByText("SUBMITTED", { exact: true })).toBeVisible();
});

test("student login displays an error for invalid credentials", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email address").fill("student@approvaltrack.demo");
  await page.getByLabel("Password").fill("invalid-e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});
