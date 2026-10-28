import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { supportsMongoTransactions } from "../src/middleware/audit.js";
import {
  Alert,
  Application,
  AuditLog,
  CaseObligation,
  Document,
  Faculty,
  NotificationJob,
  OutboxEvent,
  Session,
  StageHistory,
  Student,
} from "../src/models/index.js";

const app = createApp();

describe("foundation API", () => {
  it("returns the API envelope and request id", async () => {
    const response = await request(app).get("/api/v1");
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ name: "ApprovalTrack API", status: "ready" });
    expect(response.body.error).toBeNull();
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("returns a consistent not-found envelope", async () => {
    const response = await request(app).get("/not-a-route");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.meta.requestId).toBeTruthy();
  });

  it("exposes the requested application types without changing unknown-route behavior", async () => {
    const types = await request(app).get("/api/v1/application-types");
    const unknown = await request(app).get("/api/v1/not-a-case-route");
    expect(types.status).toBe(200);
    expect(types.body.data.map((item) => item.id)).toEqual([
      "new_institution",
      "new_course",
      "increase_in_intake",
      "extension_of_approval",
      "conversion_diploma_to_degree",
      "collaboration_twinning",
      "restoration_of_intake",
    ]);
    expect(unknown.status).toBe(404);
  });

  it("registers workflow obligation routes behind authentication", async () => {
    const response = await request(app).get("/api/v1/obligations");
    expect(response.status).toBe(401);
  });

  it("protects the case event stream with session authentication", async () => {
    const response = await request(app).get("/api/v1/cases/events");
    expect(response.status).toBe(401);
  });

  it("protects case document uploads with session authentication", async () => {
    const response = await request(app)
      .post("/api/v1/cases/507f1f77bcf86cd799439011/documents")
      .set("X-Requested-With", "XMLHttpRequest")
      .field("doc_type_slot", "fire");
    expect(response.status).toBe(401);
  });

  it("protects obligation evidence submission and verification routes", async () => {
    const headers = { "X-Requested-With": "XMLHttpRequest" };
    const submission = await request(app)
      .post("/api/v1/obligations/507f1f77bcf86cd799439011/submit-evidence")
      .set(headers)
      .send({ evidenceNote: "Evidence provided" });
    const verification = await request(app)
      .post("/api/v1/obligations/507f1f77bcf86cd799439011/verify")
      .set(headers)
      .send({ verification: "verified" });
    expect(submission.status).toBe(401);
    expect(verification.status).toBe(401);
  });

  it("keeps admin aliases protected without turning unknown routes into authentication errors", async () => {
    const users = await request(app).get("/api/v1/users");
    const unknown = await request(app).get("/api/v1/unknown-route");
    expect(users.status).toBe(401);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");
  });

  it("reports health dependencies without claiming database readiness", async () => {
    const response = await request(app).get("/health");
    expect([200, 503]).toContain(response.status);
    expect(response.body.data.checks).toEqual(expect.objectContaining({
      mongodb: expect.stringMatching(/^(ok|unavailable)$/),
      uploadDirectory: expect.stringMatching(/^(ok|unavailable)$/),
      python: expect.stringMatching(/^(ok|unavailable)$/),
    }));
    expect(response.body.data.status).toBe(response.status === 200 ? "ok" : "degraded");
  });
});

describe("foundation model indexes and safeguards", () => {
  it("detects standalone MongoDB separately from transaction-capable deployments", () => {
    expect(supportsMongoTransactions({ ok: 1, isWritablePrimary: true })).toBe(false);
    expect(supportsMongoTransactions({ ok: 1, setName: "rs0" })).toBe(true);
    expect(supportsMongoTransactions({ ok: 1, msg: "isdbgrid" })).toBe(true);
    expect(supportsMongoTransactions({ ok: 1, serviceId: "load-balanced" })).toBe(true);
  });

  it("declares required unique and compound indexes", () => {
    const hasIndex = (model, fields, options = {}) => model.schema.indexes().some(([candidate, candidateOptions]) => (
      JSON.stringify(candidate) === JSON.stringify(fields)
      && Object.entries(options).every(([key, value]) => candidateOptions[key] === value)
    ));
    expect(hasIndex(Session, { expires_at: 1 }, { expireAfterSeconds: 0 })).toBe(true);
    expect(hasIndex(NotificationJob, { dedupe_key: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(Application, { institution_id: 1, current_stage: 1, status: 1 })).toBe(true);
    expect(hasIndex(Alert, { target_user_id: 1, status: 1 })).toBe(true);
    expect(hasIndex(Student, { institution_id: 1, enrollment_no: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(Faculty, { institution_id: 1, employee_id: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(AuditLog, { entity: 1, entity_id: 1, createdAt: -1 })).toBe(true);
    expect(hasIndex(Document, { application_id: 1, doc_type_slot: 1, version: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(Document, { case_id: 1, doc_type_slot: 1, version: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(OutboxEvent, { entityId: 1, createdAt: 1, eventId: 1 })).toBe(true);
  });

  it("enables optimistic concurrency for applications and documents", async () => {
    expect(Application.schema.options.optimisticConcurrency).toBe(true);
    expect(Document.schema.options.optimisticConcurrency).toBe(true);
    expect(CaseObligation.schema.options.optimisticConcurrency).toBe(true);
  });

  it("requires each document to belong to exactly one application or case", async () => {
    const common = {
      uploaded_by: "507f1f77bcf86cd799439011",
      file_path: "private/document.pdf",
      original_name: "document.pdf",
      file_hash: "sha256",
      mime: "application/pdf",
    };
    await expect(new Document(common).validate()).rejects.toHaveProperty("errors.application_id");
    await expect(new Document({
      ...common,
      application_id: "507f1f77bcf86cd799439011",
      case_id: "507f1f77bcf86cd799439012",
    }).validate()).rejects.toHaveProperty("errors.application_id");
    await expect(new Document({
      ...common,
      application_id: "507f1f77bcf86cd799439011",
    }).validate()).resolves.toBeUndefined();
    await expect(new Document({
      ...common,
      case_id: "507f1f77bcf86cd799439012",
    }).validate()).resolves.toBeUndefined();
  });

  it("marks the append-only history schemas with mutation guards", () => {
    expect(StageHistory.schema.s.hooks._pres.get("findOneAndUpdate").length).toBeGreaterThan(0);
    expect(AuditLog.schema.s.hooks._pres.get("deleteMany").length).toBeGreaterThan(0);
  });
});
