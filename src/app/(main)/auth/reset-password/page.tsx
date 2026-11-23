"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  MIN_PASSWORD_LENGTH,
  RECOVERY_COPY,
  directVisitOutcome,
  newPasswordProblem,
  verifyNeedsPageReport,
  verifyOutcome,
  type AuthFailure,
  type DirectVisitOutcome,
  type SaveGuard,
  type VerifyOutcome,
} from "@/lib/auth/recovery";
import { reportRecovery, thrownFailure } from "@/lib/auth/recovery-report";
import { saveNewPassword } from "@/lib/auth/recovery-save";

type Step =
  | "loading"
  | "ready"
  | "verifying"
  | "saving"
  | "done"
  | VerifyOutcome["step"]
  | DirectVisitOutcome["step"]
  | Extract<SaveGuard, { ok: false }>["step"];

const VERIFY_TIMEOUT_MS = 25_000;

/** What we keep of a Supabase error: never its message, which can quote the email. */
function kept(error: { status?: number; code?: string; name?: string } | null): AuthFailure | null {
  return error ? { status: error.status, code: error.code, name: error.name } : null;
}

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Set by /auth/confirm when it stored a link's token. Not a secret.
  const cameFromLink = searchParams.get("link") === "1";

  const [step, setStep] = useState<Step>(cameFromLink ? "ready" : "loading");
  const [account, setAccount] = useState<{ email: string; userId: string } | null>(null);
  const [switched, setSwitched] = useState(false);
  const [linkRefused, setLinkRefused] = useState(false);
  // Set while "Sign out" runs: its own SIGNED_OUT event must not be read as
  // "your link expired".
  const leaving = useRef(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const doneHeading = useRef<HTMLHeadingElement>(null);

  // Opened without a link: someone signed in may set a password for their own
  // account (as the account page allows); anyone else needs a link.
  // Decided once, on the first render: after Continue the address loses
  // `link=1`, and that must not start this check over a form already shown.
  const openedWithoutLink = useRef(!cameFromLink);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Who is signed in, for a visit with no link. Also the retry after it failed. */
  const checkDirectVisit = async () => {
    let outcome: ReturnType<typeof directVisitOutcome>;
    try {
      const { data, error } = await createClient().auth.getUser();
      outcome = directVisitOutcome(data.user, kept(error));
    } catch (thrown) {
      reportRecovery(
        { message: "password reset: the session could not be read on the reset page", key: "reset-page-session" },
        { endpoint: "supabase.auth.getUser", method: "GET" },
        thrownFailure(thrown)
      );
      outcome = { step: "check_failed" };
    }
    if (!mounted.current) return;
    if (outcome.step === "form") setAccount({ email: outcome.email, userId: outcome.userId });
    setStep(outcome.step);
  };

  useEffect(() => {
    if (openedWithoutLink.current) void checkDirectVisit();
    // Runs once: the choice was fixed on the first render (see above).
  }, []);

  // While the form is open, another tab can sign this browser in to a
  // different account, or out. The form must not then save under a name it no
  // longer matches.
  const formOpen = step === "form";
  const expectedUserId = account?.userId;
  useEffect(() => {
    if (!formOpen || !expectedUserId) return;
    const { data } = createClient().auth.onAuthStateChange((event, session) => {
      if (leaving.current) return;
      // Someone who never had a link is not told one expired.
      if (event === "SIGNED_OUT") setStep(openedWithoutLink.current ? "needs_link" : "expired");
      else if (session?.user?.id && session.user.id !== expectedUserId) setStep("account_changed");
    });
    return () => data.subscription.unsubscribe();
  }, [formOpen, expectedUserId]);

  // A step change removes the button that had focus: move it somewhere useful.
  useEffect(() => {
    if (step === "form") passwordInput.current?.focus();
    if (step === "done") doneHeading.current?.focus();
  }, [step]);

  const handleContinue = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStep("verifying");

    // No link was ever stored for this visit: the retry is the session check
    // again, not the route that spends a link.
    if (openedWithoutLink.current) {
      await checkDirectVisit();
      inFlight.current = false;
      return;
    }

    let status = 0;
    let body: unknown = null;
    let thrownName: string | null = null;
    try {
      const res = await fetch("/auth/recover/verify", {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      status = res.status;
      // A reply that is not JSON reads as "could not check" (verifyOutcome).
      body = await res.json().catch(() => null);
    } catch (thrown) {
      // No answer at all (offline, timed out): status stays 0, "could not check".
      thrownName = thrownFailure(thrown).name ?? null;
    }

    const outcome = verifyOutcome(status, body);
    if (outcome.step === "form") {
      setAccount({ email: outcome.email, userId: outcome.userId });
      setSwitched(outcome.switched);
      setLinkRefused(outcome.linkRefused);
      setStep("form");
      // Drop `link=1`, so a refresh shows the form instead of Continue.
      router.replace("/auth/reset-password");
    } else {
      if (outcome.step === "check_failed" && verifyNeedsPageReport(status)) {
        // The route reports its own faults; this covers the ones it never saw.
        reportRecovery(
          { message: "password reset: Continue got no usable answer", key: "reset-page-verify" },
          { endpoint: "/auth/recover/verify", method: "POST" },
          { status, name: thrownName ?? undefined }
        );
      }
      setStep(outcome.step);
    }
    inFlight.current = false;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight.current || !account) return;

    const problem = newPasswordProblem(password, confirm);
    if (problem) {
      setFormError(problem);
      return;
    }

    inFlight.current = true;
    setFormError(null);
    setStep("saving");

    try {
      // The check that this is still the form's account and the save itself
      // use one captured token (lib/auth/recovery-save.ts). Supabase signs out
      // every other session of the account itself.
      const result = await saveNewPassword({
        auth: createClient().auth,
        expectedUserId: account.userId,
        password,
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
        anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      });
      reportRecovery(result.report, { endpoint: "supabase.auth.updateUser", method: "PUT" }, result.failure);

      switch (result.step) {
        case "done":
          setPassword("");
          setConfirm("");
          setStep("done");
          break;
        case "expired":
        case "account_changed":
          setStep(result.step);
          break;
        case "check_failed":
        case "form":
          setFormError(result.message ?? RECOVERY_COPY.saveFailed);
          setStep("form");
          break;
        default: {
          const unhandled: never = result.step;
          throw new Error(`unhandled save step: ${String(unhandled)}`);
        }
      }
    } catch (thrown) {
      // supabase-js returns network failures as errors, so this is a fault of
      // another kind (a browser lock, storage). Say so; never "expired".
      reportRecovery(
        { message: "password reset: saving threw", key: "save-threw" },
        { endpoint: "supabase.auth.updateUser", method: "PUT" },
        thrownFailure(thrown)
      );
      setFormError(RECOVERY_COPY.saveFailed);
      setStep("form");
    } finally {
      inFlight.current = false;
    }
  };

  const handleNotMe = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    leaving.current = true;
    let failure: AuthFailure | null;
    try {
      const { error } = await createClient().auth.signOut({ scope: "local" });
      failure = kept(error);
    } catch (thrown) {
      failure = thrownFailure(thrown);
    }
    if (failure) {
      // Still signed in to the account they said is not theirs: say so, and
      // keep them on the form instead of sending them on as if it had worked.
      reportRecovery(
        { message: "password reset: sign-out from the form failed", key: "reset-page-signout" },
        { endpoint: "supabase.auth.signOut", method: "POST" },
        failure
      );
      setFormError(RECOVERY_COPY.signOutFailed);
      leaving.current = false;
      inFlight.current = false;
      return;
    }
    router.replace("/auth/login");
  };

  const saving = step === "saving";

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <Link href="/" className="flex justify-center">
          <img src="/Coral-logo.png" alt="Triply" className="h-12 w-auto" />
        </Link>
        <h1 className="mt-6 text-center text-3xl font-bold text-gray-900">Choose a new password</h1>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow-lg sm:rounded-lg sm:px-10">
          {step === "loading" && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-8 w-8 animate-spin text-brand-orange" />
            </div>
          )}

          {(step === "ready" || step === "verifying" || step === "check_failed") && (
            <div className="text-center">
              <p className="text-gray-600">
                Press Continue to confirm it&apos;s you, then choose your new password.
              </p>
              {step === "check_failed" && (
                <div
                  role="alert"
                  className="mt-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm text-left"
                >
                  {RECOVERY_COPY.checkFailed}
                </div>
              )}
              <button
                type="button"
                onClick={handleContinue}
                disabled={step === "verifying"}
                className="mt-6 w-full flex items-center justify-center gap-2 bg-brand-orange text-white font-bold py-3 px-4 rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {step === "verifying" && <Loader2 className="h-5 w-5 animate-spin" />}
                {step === "check_failed" ? "Try again" : "Continue"}
              </button>
            </div>
          )}

          {(step === "expired" || step === "needs_link" || step === "account_changed") && (
            <div className="text-center">
              <div
                role="alert"
                className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm text-left"
              >
                {step === "expired"
                  ? RECOVERY_COPY.expired
                  : step === "needs_link"
                    ? RECOVERY_COPY.needsLink
                    : RECOVERY_COPY.accountChanged}
              </div>
              <Link
                href="/auth/forgot-password"
                className="mt-6 w-full flex items-center justify-center bg-brand-orange text-white font-bold py-3 px-4 rounded-lg hover:bg-orange-600 transition-colors"
              >
                {step === "needs_link" ? "Get a reset link" : "Get a new link"}
              </Link>
            </div>
          )}

          {(step === "form" || step === "saving") && account && (
            <form onSubmit={handleSave} className="space-y-4" data-clarity-mask="true">
              {linkRefused && (
                <div
                  role="status"
                  className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm"
                >
                  That link had expired or was already used. You&apos;re signed in, so you can set a new
                  password for the account below. If it isn&apos;t the one you meant, sign out and ask for a
                  new link.
                </div>
              )}
              {switched && (
                <div
                  role="status"
                  className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm"
                >
                  This link signed you in to a different account than the one this browser was using.
                </div>
              )}
              <p className="text-sm text-gray-600">
                Setting a new password for{" "}
                <span className="font-semibold text-gray-900 break-all">{account.email}</span>
              </p>

              <div>
                <label htmlFor="new-password" className="block text-sm font-medium text-gray-700">
                  New password
                </label>
                <div className="mt-1 relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <input
                    id="new-password"
                    ref={passwordInput}
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    aria-describedby="new-password-hint"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                    className="block w-full pl-10 pr-10 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
                <p id="new-password-hint" className="mt-1 text-xs text-gray-500">
                  At least {MIN_PASSWORD_LENGTH} characters.
                </p>
              </div>

              <div>
                <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700">
                  Type it again
                </label>
                <div className="mt-1 relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <input
                    id="confirm-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    className="block w-full pl-10 pr-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
                  />
                </div>
              </div>

              {formError && (
                <div
                  role="alert"
                  className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm"
                >
                  {formError}
                </div>
              )}

              <button
                type="submit"
                disabled={saving}
                className="w-full flex items-center justify-center gap-2 bg-brand-orange text-white font-bold py-3 px-4 rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving && <Loader2 className="h-5 w-5 animate-spin" />}
                Save new password
              </button>

              <p className="text-center text-sm text-gray-600">
                Not your account?{" "}
                <button
                  type="button"
                  onClick={handleNotMe}
                  disabled={saving}
                  className="text-brand-orange hover:text-orange-500 disabled:opacity-50"
                >
                  Sign out
                </button>
              </p>
            </form>
          )}

          {step === "done" && (
            <div className="text-center py-2">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="h-8 w-8 text-green-600" />
              </div>
              <h2 ref={doneHeading} tabIndex={-1} className="text-xl font-bold text-gray-900 mb-2 outline-none">
                Your password has been changed
              </h2>
              <p className="text-gray-600 mb-6">
                You&apos;re signed in on this device. Other devices have been signed out.
              </p>
              <Link
                href="/"
                className="w-full flex items-center justify-center bg-brand-orange text-white font-bold py-3 px-4 rounded-lg hover:bg-orange-600 transition-colors"
              >
                Continue
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-brand-orange" />
        </div>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
