import test from "node:test";
import assert from "node:assert/strict";
import { authApi, backendRoleToWorkspace, workspaceRoleFor } from "./auth.js";

test("maps the authenticated backend role to the correct workspace", () => {
  assert.equal(workspaceRoleFor({ role: "INSTITUTION" }), "Institution user");
  assert.equal(workspaceRoleFor({ role: "SCRUTINY_OFFICER" }), "Scrutiny / Regional officer");
  assert.equal(workspaceRoleFor({ role: "EVC" }), "EVC member");
  assert.equal(workspaceRoleFor({ role: "EVC_CHAIRMAN" }), "EVC chairman");
  assert.equal(workspaceRoleFor({ role: "SAC_SHC" }), "SAC/SHC member");
  assert.equal(workspaceRoleFor({ role: "BUREAU_OFFICER" }), "Competent authority");
  assert.equal(workspaceRoleFor({ role: "SENIOR_AUTHORITY" }), "Senior authority");
  assert.equal(workspaceRoleFor({ role: "ADMIN" }), "Admin");
  assert.equal(workspaceRoleFor({ role: "STUDENT" }), "Student");
  assert.equal(workspaceRoleFor({ role: "FACULTY" }), "Faculty");
  assert.equal(workspaceRoleFor({ role: "GRIEVANCE_OFFICER" }), "Grievance officer");
  assert.equal(workspaceRoleFor({ role: "OMBUDSPERSON" }), "Ombudsperson");
  assert.equal(workspaceRoleFor({ role: "UNIVERSITY_DTE_OFFICER" }), "University/DTE Officer");
});

test("does not accept an unknown account role", () => {
  assert.throws(() => workspaceRoleFor({ role: "UNKNOWN" }), /unsupported role/i);
  assert.equal(Object.keys(backendRoleToWorkspace).length, 13);
});

test("login sends only email and password and includes the backend session cookie", async (context) => {
  let requestUrl;
  let requestOptions;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return new Response(JSON.stringify({ data: { user: { role: "ADMIN" } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const result = await authApi.login("admin@approvaltrack.demo", "test-password");
  assert.equal(requestUrl, "http://localhost:4000/api/v1/auth/login");
  assert.equal(requestOptions.credentials, "include");
  assert.deepEqual(JSON.parse(requestOptions.body), {
    email: "admin@approvaltrack.demo",
    password: "test-password",
  });
  assert.equal(result.user.role, "ADMIN");
});
