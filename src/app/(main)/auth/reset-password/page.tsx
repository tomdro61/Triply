"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { captureAPIError } from "@/lib/sentry";
import {
  MIN_PASSWORD_LENGTH,
  RECOVERY_COPY,
  newPasswordProblem,
  saveOutcome,
  verifyOutcome,
} from "@/lib/auth/recovery";

type Step =
  | "loading"
  | "ready"
  | "verifying"
  | "form"
  | "saving"
  | "done"
  | "expired"
  | "check_failed";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Set by /auth/confirm when it stored a link's token. Not a secret.
  const cameFromLink = searchParams.get("link") === "1";

  const [step, setStep] = useState<Step>(cameFromLink ? "ready" : "loading");
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const inFlight = useRef(false);

  // Opened without a link: someone signed in may set a password for their own
  // account (as the account page allows); anyone else needs a link.
  // Decided once, on the first render: after Continue the address loses
  // `link=1`, and that must not start this check over a form already shown.
  const openedWithoutLink = useRef(!cameFromLink);
  useEffect(() => {
    if (!openedWithoutLink.current) return;
    let cancelled = false;
    createClient()
      .auth.getUser()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (data.user?.email) {
          setAccountEmail(data.user.email);
          setStep("form");
        } else if (error && (error.status === undefined || error.status === 0 || error.status >= 500)) {
          setStep("check_failed");
        } else {
          setStep("expired");
        }
      })
      .catch(() => {
        if (!cancelled) setStep("check_failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleContinue = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStep("verifying");

    let status = 0;
    let body: unknown = null;
    try {
      const res = await fetch("/auth/recover/verify", { method: "POST", cache: "no-store" });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch {
      // No answer at all: status stays 0, which reads as "could not check".
    }

    const outcome = verifyOutcome(status, body);
    if (outcome.step === "form") {
      setAccountEmail(outcome.email);
      setStep("form");
      // Drop `link=1`, so a refresh shows the form instead of Continue.
      router.replace("/auth/reset-password");
    } else {
      setStep(outcome.step);
    }
    inFlight.current = false;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;

    const problem = newPasswordProblem(password, confirm);
    if (problem) {
      setFormError(problem);
      return;
    }

    inFlight.current = true;
    setFormError(null);
    setStep("saving");

    let failure: { status?: number; code?: string } | null;
    try {
      // Supabase signs out every other session of this account itself.
      const { error } = await createClient().auth.updateUser({ password });
      failure = error ? { status: error.status, code: error.code } : null;
    } catch {
      failure = { status: 0 };
    }

    const outcome = saveOutcome(failure);
    if (outcome.step !== "done" && outcome.report !== "none") {
      captureAPIError(
        new Error(
          outcome.report === "info"
            ? "password reset: the session was gone when saving"
            : "password reset: the new password could not be saved"
        ),
        {
          endpoint: "supabase.auth.updateUser",
          method: "PUT",
          statusCode: failure?.status,
          code: failure?.code,
          ...(outcome.report === "info" ? { level: "info" as const } : {}),
        }
      );
    }

    if (outcome.step === "done") {
      setPassword("");
      setConfirm("");
      setStep("done");
    } else if (outcome.step === "expired") {
      setStep("expired");
    } else {
      setFormError(outcome.message);
      setStep("form");
    }
    inFlight.current = false;
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

          {step === "expired" && (
            <div className="text-center">
              <div
                role="alert"
                className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm text-left"
              >
                {RECOVERY_COPY.expired}
              </div>
              <Link
                href="/auth/forgot-password"
                className="mt-6 w-full flex items-center justify-center bg-brand-orange text-white font-bold py-3 px-4 rounded-lg hover:bg-orange-600 transition-colors"
              >
                Get a new link
              </Link>
            </div>
          )}

          {(step === "form" || step === "saving") && (
            <form onSubmit={handleSave} className="space-y-4" data-clarity-mask="true">
              <p className="text-sm text-gray-600">
                Setting a new password for{" "}
                <span className="font-semibold text-gray-900 break-all">{accountEmail}</span>
              </p>

              <div>
                <label htmlFor="new-password" className="block text-sm font-medium text-gray-700">
                  New password
                </label>
                <div className="mt-1 relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <input
                    id="new-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
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
                <p className="mt-1 text-xs text-gray-500">At least {MIN_PASSWORD_LENGTH} characters.</p>
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
            </form>
          )}

          {step === "done" && (
            <div className="text-center py-2">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="h-8 w-8 text-green-600" />
              </div>
              <h2 className="text-xl font-bold text-gray-900 mb-2">Your password is changed</h2>
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
