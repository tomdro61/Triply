"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { captureAPIError } from "@/lib/sentry";
import { RECOVERY_COPY, RESEND_COOLDOWN_MS, forgotOutcome } from "@/lib/auth/recovery";

type Status = "idle" | "sending" | "sent" | "invalid" | "failed";

function ForgotPasswordForm() {
  const searchParams = useSearchParams();
  // A fixed word set by our own routes; nothing from the URL is shown.
  const linkExpired = searchParams.get("error") === "expired";

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [coolingDown, setCoolingDown] = useState(false);
  const inFlight = useRef(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight.current || coolingDown) return;
    inFlight.current = true;
    setStatus("sending");

    let failure: { status?: number; code?: string } | null;
    try {
      const { error } = await createClient().auth.resetPasswordForEmail(email.trim());
      failure = error ? { status: error.status, code: error.code } : null;
    } catch {
      // The request never got an answer (offline, blocked).
      failure = { status: 0 };
    }

    const outcome = forgotOutcome(failure);
    if (outcome.report !== "none") {
      // A fixed message: Supabase's own text can quote the email address.
      captureAPIError(
        new Error(
          outcome.report === "info"
            ? "password reset: email rate limit reached"
            : "password reset: the email could not be requested"
        ),
        {
          endpoint: "supabase.auth.resetPasswordForEmail",
          method: "POST",
          statusCode: failure?.status,
          code: failure?.code,
          ...(outcome.report === "info" ? { level: "info" as const } : {}),
        }
      );
    }

    setStatus(outcome.view);
    if (outcome.view === "sent") {
      // A second request inside a minute is refused, and it would also stop
      // the first email's link from working.
      setCoolingDown(true);
      cooldownTimer.current = setTimeout(() => setCoolingDown(false), RESEND_COOLDOWN_MS);
    }
    inFlight.current = false;
  };

  const busy = status === "sending";

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <Link href="/" className="flex justify-center">
          <img src="/Coral-logo.png" alt="Triply" className="h-12 w-auto" />
        </Link>
        <h1 className="mt-6 text-center text-3xl font-bold text-gray-900">Reset your password</h1>
        <p className="mt-2 text-center text-sm text-gray-600">
          Enter your email and we&apos;ll send you a link to choose a new one.
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow-lg sm:rounded-lg sm:px-10">
          {linkExpired && status === "idle" && (
            <div
              role="alert"
              className="mb-4 bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm"
            >
              {RECOVERY_COPY.expired}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" data-clarity-mask="true">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email address
              </label>
              <div className="mt-1 relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="block w-full pl-10 pr-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
                  placeholder="you@example.com"
                />
              </div>
            </div>

            {status === "sent" && (
              <div
                role="status"
                className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm"
              >
                {RECOVERY_COPY.sent}
              </div>
            )}
            {(status === "invalid" || status === "failed") && (
              <div
                role="alert"
                className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm"
              >
                {status === "invalid" ? RECOVERY_COPY.invalidEmail : RECOVERY_COPY.sendFailed}
              </div>
            )}

            <button
              type="submit"
              disabled={busy || coolingDown}
              className="w-full flex items-center justify-center gap-2 bg-brand-orange text-white font-bold py-3 px-4 rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy && <Loader2 className="h-5 w-5 animate-spin" />}
              {coolingDown ? "Email sent" : "Send reset link"}
            </button>
            {coolingDown && (
              <p className="text-center text-xs text-gray-500">
                You can ask for another link in a minute.
              </p>
            )}
          </form>

          <div className="mt-6 border-t border-gray-200 pt-4 text-sm text-gray-600">
            <p className="font-medium text-gray-900">Booked without an account?</p>
            <p className="mt-1">
              Then there is no password to reset. Open your booking from your confirmation email,
              or{" "}
              <Link href="/auth/login" className="text-brand-orange hover:text-orange-500">
                create an account
              </Link>{" "}
              with the email you booked with.
            </p>
          </div>

          <p className="mt-4 text-center text-sm text-gray-600">
            <Link href="/auth/login" className="text-brand-orange hover:text-orange-500">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-brand-orange" />
        </div>
      }
    >
      <ForgotPasswordForm />
    </Suspense>
  );
}
