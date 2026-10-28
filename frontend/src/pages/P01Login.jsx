import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, CheckCircle2, ShieldCheck } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { roleHome } from "../layouts/AppShell";
import { authApi } from "../services/auth";

const schema = z.object({
  identity: z.string().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const setAuthenticatedUser = useAppStore((state) => state.setAuthenticatedUser);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { register, handleSubmit, formState: { errors } } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { identity: "", password: "" },
  });
  async function submit(values) {
    setError("");
    setSubmitting(true);
    try {
      const { user } = await authApi.login(values.identity.trim(), values.password);
      setAuthenticatedUser(user);
      navigate(location.state?.from || roleHome[useAppStore.getState().role], { replace: true });
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setSubmitting(false);
    }
  }
  return <div className="login-page">
    <header className="login-strip">
      <strong>AICTE <span>|</span> ApprovalTrack</strong>
      <span className="login-strip-status"><i /> Secure account access</span>
    </header>
    <div className="saffron-rule" />
    <main className="login-layout">
      <section className="login-brand">
        <div className="agency-emblem login-emblem"><ShieldCheck size={23} /></div>
        <p className="eyebrow">ALL INDIA COUNCIL FOR TECHNICAL EDUCATION</p>
        <h1>Clarity at every stage.</h1>
        <p className="login-tagline">A more connected way to manage applications, reviews and institutional obligations.</p>
        <div className="trust-list">
          <div><CheckCircle2 size={18} /><span>Clear, stage-based application tracking</span></div>
          <div><CheckCircle2 size={18} /><span>Ownership-aware timelines and obligations</span></div>
          <div><CheckCircle2 size={18} /><span>Secure access for every authorised role</span></div>
        </div>
        <div className="login-brand-foot"><span>Accountable review, made clearer.</span><span><ShieldCheck size={15} /> Secure access</span></div>
      </section>
      <section className="login-card">
        <p className="eyebrow">YOUR WORKSPACE</p>
        <h2>Welcome back</h2>
        <p>Sign in with your account to continue.</p>
        <form onSubmit={handleSubmit(submit)}>
          <label className="field-label">Email address<input {...register("identity")} type="email" autoComplete="username" />{errors.identity && <small className="field-error">{errors.identity.message}</small>}</label>
          <label className="field-label">Password<input {...register("password")} type="password" autoComplete="current-password" />{errors.password && <small className="field-error">{errors.password.message}</small>}</label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button className="button button-primary login-submit" type="submit" disabled={submitting}>{submitting ? "Signing in..." : "Sign in"} {!submitting && <ArrowRight size={17} />}</button>
        </form>
        <div className="credentials-box">Your workspace is assigned automatically from your account.</div>
        <div className="login-note"><ShieldCheck size={15} /> Your account role determines the workspace available to you.</div>
      </section>
    </main>
    <footer className="login-footer">ApprovalTrack <span>•</span> Secure institutional access</footer>
  </div>;
}
