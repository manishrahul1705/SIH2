import { randomBytes, randomUUID, createHash } from "node:crypto";
import argon2 from "argon2";
import { z } from "zod";
import { env } from "../config/env.js";
import { SESSION_MAX_AGE_MS } from "../config/constants.js";
import { EmailVerification, Institution, PasswordReset, Session, User } from "../models/index.js";
import { validate } from "./validate.js";
import express from "express";
import { NotificationService } from "../modules/notifications/service.js";
import { withTransaction } from "./audit.js";

const loginSchema = z.object({
  email: z.string().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(256),
}).strict();
const passwordSchema = z.string().min(12).max(128);
const forgotSchema = z.object({ email: z.string().email().max(254) }).strict();
const resetSchema = z.object({ token: z.string().min(32).max(256), password: passwordSchema }).strict();
const changeSchema = z.object({ current_password: z.string().min(1).max(256), password: passwordSchema }).strict();
const institutionRegistrationSchema = z.object({
  institution: z.object({
    aicte_id: z.string().trim().min(3).max(40),
    name: z.string().trim().min(2).max(200),
    state: z.string().trim().min(2).max(100),
    region: z.string().trim().min(2).max(100),
    contact_email: z.string().email().max(254),
    contact_phone: z.string().max(32).optional().default(""),
  }).strict(),
  name: z.string().trim().min(2).max(120),
  password: passwordSchema,
}).strict();
const verifyEmailSchema = z.object({ token: z.string().min(32).max(256) }).strict();

function cookieValue(req) {
  const prefix = `${env.SESSION_COOKIE_NAME}=`;
  const raw = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : "";
}

function cookieSiteAttributes(req) {
  const frontendHost = new URL(env.FRONTEND_ORIGIN).hostname.toLowerCase();
  const apiHost = String(req.get("host") || "").split(":")[0].toLowerCase();
  const frontendLabels = frontendHost.split(".").slice(-2).join(".");
  const apiLabels = apiHost.split(".").slice(-2).join(".");
  const sameSite = frontendHost === apiHost
    || frontendHost === "localhost" && apiHost === "localhost"
    || frontendLabels === apiLabels;
  return { sameSite: sameSite ? "Lax" : "None", secure: env.NODE_ENV === "production" || !sameSite };
}

function setSessionCookie(res, sessionId, req) {
  const cookieSite = cookieSiteAttributes(req);
  const attributes = [
    `${env.SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "Path=/",
    `SameSite=${cookieSite.sameSite}`,
    `Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`,
  ];
  if (cookieSite.secure) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function clearSessionCookie(res, req) {
  const cookieSite = cookieSiteAttributes(req);
  const attributes = [`${env.SESSION_COOKIE_NAME}=`, "HttpOnly", "Path=/", `SameSite=${cookieSite.sameSite}`, "Max-Age=0"];
  if (cookieSite.secure) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

const safeUser = (user) => ({
  id: user._id.toString(),
  role: user.role,
  name: user.name,
  email: user.email,
  phone: user.phone,
  institution_id: user.institution_id?.toString() || null,
  region: user.region,
  status: user.status,
  notify_email: user.notify_email,
  notify_sms: user.notify_sms,
});

async function recordFailedLogin(user, now) {
  user.failed_login_attempts += 1;
  if (user.failed_login_attempts >= 5) {
    user.failed_login_attempts = 0;
    user.locked_until = new Date(now.getTime() + 15 * 60 * 1000);
  }
  await user.save();
  if (user.locked_until > now) {
    await Session.updateMany({ user_id: user._id, revoked_at: null }, { $set: { revoked_at: now } });
  }
}

export async function authenticate(req, res, next) {
  try {
    const rawId = cookieValue(req);
    if (!rawId) return res.status(401).json({ data: null, error: { code: "UNAUTHENTICATED", message: "Sign in is required" }, meta: { requestId: req.id } });
    const sessionIdHash = createHash("sha256").update(rawId).digest("hex");
    const session = await Session.findOne({ id: sessionIdHash, revoked_at: null }).lean();
    if (!session) return res.status(401).json({ data: null, error: { code: "SESSION_EXPIRED", message: "Session is invalid or expired; sign in again" }, meta: { requestId: req.id } });
    if (session.expires_at <= new Date()) {
      await Session.updateOne({ _id: session._id, revoked_at: null }, { $set: { revoked_at: new Date() } });
      clearSessionCookie(res, req);
      return res.status(401).json({ data: null, error: { code: "SESSION_EXPIRED", message: "Session expired; sign in again" }, meta: { requestId: req.id } });
    }
    const user = await User.findOne({ _id: session.user_id, status: "ACTIVE", deleted_at: null });
    if (!user) return res.status(401).json({ data: null, error: { code: "ACCOUNT_UNAVAILABLE", message: "Account is unavailable" }, meta: { requestId: req.id } });
    if (user.locked_until && user.locked_until > new Date()) return res.status(401).json({ data: null, error: { code: "ACCOUNT_LOCKED", message: "Account is temporarily locked; try again later" }, meta: { requestId: req.id } });
    req.user = user;
    req.sessionRecord = session;
    req.sessionCookieId = rawId;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ data: null, error: { code: "UNAUTHENTICATED", message: "Sign in is required" }, meta: { requestId: req.id } });
    if (!roles.includes(req.user.role)) return res.status(403).json({ data: null, error: { code: "FORBIDDEN", message: "Your role cannot access this resource" }, meta: { requestId: req.id } });
    return next();
  };
}

export function csrfProtection(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.path === "/webhooks/resend") return next();
  if (req.get("x-requested-with") !== "XMLHttpRequest") {
    return res.status(403).json({ data: null, error: { code: "CSRF_HEADER_REQUIRED", message: "X-Requested-With: XMLHttpRequest is required" }, meta: { requestId: req.id } });
  }
  return next();
}

export function authRouter({ audit }) {
  const router = express.Router();
    router.post("/login", validate(loginSchema), async (req, res, next) => {
      try {
        const user = await User.findOne({ email: req.body.email, deleted_at: null }).select("+password_hash");
        const now = new Date();
        if (!user || user.status !== "ACTIVE") {
          return res.status(401).json({ data: null, error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" }, meta: { requestId: req.id } });
        }
        if (user.locked_until && user.locked_until > now) return res.status(401).json({ data: null, error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" }, meta: { requestId: req.id } });
        const matches = await argon2.verify(user.password_hash, req.body.password);
        if (!matches) {
          await recordFailedLogin(user, now);
          return res.status(401).json({ data: null, error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" }, meta: { requestId: req.id } });
        }
        const rawId = randomBytes(32).toString("base64url");
        const sessionId = createHash("sha256").update(rawId).digest("hex");
        await Session.create({
          id: sessionId,
          user_id: user._id,
          created_at: now,
          expires_at: new Date(now.getTime() + SESSION_MAX_AGE_MS),
          ip: req.ip,
          user_agent: req.get("user-agent") || "",
        });
        user.failed_login_attempts = 0;
        user.locked_until = null;
        await user.save();
        setSessionCookie(res, rawId, req);
        await audit({ actor_id: user._id, action: "AUTH_LOGIN", entity: "User", entity_id: user._id.toString(), ip: req.ip });
        return res.json({ data: { user: safeUser(user) }, error: null, meta: { requestId: req.id } });
      } catch (error) { return next(error); }
    });

    router.get("/me", authenticate, (req, res) => res.json({ data: { user: safeUser(req.user) }, error: null, meta: { requestId: req.id } }));
    router.post("/logout", authenticate, async (req, res, next) => {
      try {
        await Session.updateOne({ _id: req.sessionRecord._id, revoked_at: null }, { $set: { revoked_at: new Date() } });
        clearSessionCookie(res, req);
        await audit({ actor_id: req.user._id, action: "AUTH_LOGOUT", entity: "Session", entity_id: req.sessionRecord._id.toString(), ip: req.ip });
        return res.json({ data: { logged_out: true }, error: null, meta: { requestId: req.id } });
      } catch (error) { return next(error); }
    });
    router.post("/change-password", authenticate, validate(changeSchema), async (req, res, next) => {
      try {
        const user = await User.findById(req.user._id).select("+password_hash");
        if (!await argon2.verify(user.password_hash, req.body.current_password)) {
          return res.status(400).json({ data: null, error: { code: "INVALID_PASSWORD", message: "Current password is incorrect" }, meta: { requestId: req.id } });
        }
        user.password_hash = await argon2.hash(req.body.password, { type: argon2.argon2id });
        await user.save();
        await Session.updateMany({ user_id: user._id, _id: { $ne: req.sessionRecord._id }, revoked_at: null }, { $set: { revoked_at: new Date() } });
        await audit({ actor_id: user._id, action: "AUTH_PASSWORD_CHANGED", entity: "User", entity_id: user._id.toString(), ip: req.ip });
        return res.json({ data: { changed: true, other_sessions_revoked: true }, error: null, meta: { requestId: req.id } });
      } catch (error) { return next(error); }
    });
    router.post("/forgot-password", validate(forgotSchema), async (req, res, next) => {
      try {
        const user = await User.findOne({ email: req.body.email.toLowerCase(), status: { $in: ["ACTIVE", "PENDING_VERIFICATION"] }, deleted_at: null });
        if (user) {
          const resetToken = randomBytes(32).toString("base64url");
          const resetTokenHash = createHash("sha256").update(resetToken).digest("hex");
          await PasswordReset.create({ user_id: user._id, token_hash: resetTokenHash, expires_at: new Date(Date.now() + 30 * 60 * 1000) });
          await NotificationService.enqueue({
            type: "PASSWORD_RESET",
            channel: "EMAIL",
            userId: user._id,
            payload: { subject: "Reset your ApprovalTrack password", body: `Use this one-time link within 30 minutes: ${env.FRONTEND_ORIGIN}/reset-password?token=${encodeURIComponent(resetToken)}`, security: true },
            dedupeKey: `password-reset:${resetTokenHash}`,
          });
          await audit({ actor_id: user._id, action: "PASSWORD_RESET_REQUESTED", entity: "User", entity_id: user._id.toString(), ip: req.ip });
        }
        return res.json({ data: { accepted: true }, error: null, meta: { requestId: req.id } });
      } catch (error) { return next(error); }
    });
    router.post("/reset-password", validate(resetSchema), async (req, res, next) => {
      try {
        const tokenHash = createHash("sha256").update(req.body.token).digest("hex");
        const reset = await PasswordReset.findOne({ token_hash: tokenHash, used_at: null, expires_at: { $gt: new Date() } });
        if (!reset) return res.status(400).json({ data: null, error: { code: "INVALID_RESET_TOKEN", message: "Reset token is invalid or expired" }, meta: { requestId: req.id } });
        const user = await User.findById(reset.user_id).select("+password_hash");
        user.password_hash = await argon2.hash(req.body.password, { type: argon2.argon2id });
        await user.save();
        reset.used_at = new Date();
        await reset.save();
        await Session.updateMany({ user_id: user._id, revoked_at: null }, { $set: { revoked_at: new Date() } });
        await audit({ actor_id: user._id, action: "AUTH_PASSWORD_RESET", entity: "User", entity_id: user._id.toString(), ip: req.ip });
        return res.json({ data: { reset: true }, error: null, meta: { requestId: req.id } });
      } catch (error) { return next(error); }
    });
    router.post("/register-institution", validate(institutionRegistrationSchema), async (req, res, next) => {
      try {
        const token = randomBytes(32).toString("base64url");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        let createdUser;
        await withTransaction(async (session) => {
          const institution = await Institution.create([{
            ...req.body.institution,
            aicte_id: req.body.institution.aicte_id.toUpperCase(),
            contact_email: req.body.institution.contact_email.toLowerCase(),
            status: "PENDING_VERIFICATION",
          }], { session });
          [createdUser] = await User.create([{
            role: "INSTITUTION",
            name: req.body.name,
            email: req.body.institution.contact_email.toLowerCase(),
            password_hash: await argon2.hash(req.body.password, { type: argon2.argon2id }),
            phone: req.body.institution.contact_phone || "",
            institution_id: institution[0]._id,
            region: req.body.institution.region,
            status: "PENDING_VERIFICATION",
          }], { session });
          await EmailVerification.create([{ user_id: createdUser._id, token_hash: tokenHash, expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) }], { session });
        });
        await audit({ actor_id: createdUser._id, action: "INSTITUTION_REGISTRATION_REQUESTED", entity: "Institution", entity_id: createdUser.institution_id.toString(), after_json: { verification_required: true }, ip: req.ip });
        await NotificationService.enqueue({
          type: "INSTITUTION_EMAIL_VERIFICATION",
          channel: "EMAIL",
          userId: createdUser._id,
          payload: { subject: "Verify your ApprovalTrack institution email", body: `Verify your email within 24 hours: ${env.FRONTEND_ORIGIN}/verify-email?token=${encodeURIComponent(token)}`, security: true },
          dedupeKey: `institution-verify:${tokenHash}`,
        });
        return res.status(201).json({ data: { verification_required: true }, error: null, meta: { requestId: req.id } });
      } catch (error) { return next(error); }
    });
    router.post("/verify-email", validate(verifyEmailSchema), async (req, res, next) => {
      try {
        const tokenHash = createHash("sha256").update(req.body.token).digest("hex");
        const verification = await EmailVerification.findOne({ token_hash: tokenHash, used_at: null, expires_at: { $gt: new Date() } });
        if (!verification) return res.status(400).json({ data: null, error: { code: "INVALID_VERIFICATION_TOKEN", message: "Verification token is invalid or expired" }, meta: { requestId: req.id } });
        await withTransaction(async (session) => {
          verification.used_at = new Date();
          await verification.save({ session });
          const user = await User.findByIdAndUpdate(verification.user_id, { $set: { status: "ACTIVE", email_verified_at: new Date() } }, { new: true, session });
          if (user?.institution_id) await Institution.updateOne({ _id: user.institution_id }, { $set: { status: "ACTIVE" } }, { session });
        });
        await audit({ actor_id: verification.user_id, action: "INSTITUTION_EMAIL_VERIFIED", entity: "User", entity_id: verification.user_id.toString(), ip: req.ip });
        return res.json({ data: { verified: true }, error: null, meta: { requestId: req.id } });
      } catch (error) { return next(error); }
    });
  return router;
}
