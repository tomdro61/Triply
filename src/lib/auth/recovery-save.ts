import {
  saveGuard,
  saveOutcome,
  type AuthFailure,
  type RecoveryReport,
  type SaveGuard,
  type SaveOutcome,
} from "./recovery";

/**
 * Saves the new password for ONE account: the account the form names.
 *
 * supabase-js's `updateUser` acts on whatever session the browser holds at
 * that moment, and another tab can change it between a check and the save. So
 * this takes the access token ONCE, asks Supabase whose token it is, and sends
 * the password with that same token. The check and the save cannot disagree.
 *
 * The password goes from the browser straight to Supabase, as `updateUser`
 * sends it; it never passes through our server.
 */

type AuthErrorLike = { status?: number; code?: string; name?: string } | null;

/** The two supabase-js calls this needs, so a test can stand in for them. */
export type SessionReader = {
  getSession: () => Promise<{ data: { session: { access_token: string } | null }; error: AuthErrorLike }>;
  getUser: (jwt: string) => Promise<{ data: { user: { id?: string } | null }; error: AuthErrorLike }>;
};

export type SaveResult = {
  step: "done" | SaveOutcome["step"] | Extract<SaveGuard, { ok: false }>["step"];
  /** Shown above the form when `step` is "form". */
  message: string | null;
  report: RecoveryReport | null;
  /** What the report is about; never a Supabase message. */
  failure: AuthFailure | null;
};

const SAVE_TIMEOUT_MS = 20_000;

function kept(error: AuthErrorLike): AuthFailure | null {
  return error ? { status: error.status, code: error.code, name: error.name } : null;
}

function stopped(guard: Extract<SaveGuard, { ok: false }>, failure: AuthFailure | null): SaveResult {
  return { step: guard.step, message: null, report: guard.report, failure };
}

/** GoTrue's error body: `error_code` is the machine-readable code. */
function errorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const code: unknown = Reflect.get(body, "error_code");
  return typeof code === "string" ? code : undefined;
}

export async function saveNewPassword(args: {
  auth: SessionReader;
  expectedUserId: string;
  password: string;
  supabaseUrl: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
}): Promise<SaveResult> {
  const { auth, expectedUserId, password, supabaseUrl, anonKey } = args;
  const fetchImpl = args.fetchImpl ?? fetch;

  // 1. The token, once.
  const { data: sessionData, error: sessionError } = await auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) {
    const failure = kept(sessionError);
    const guard = saveGuard(expectedUserId, null, failure);
    return guard.ok ? { step: "check_failed", message: null, report: null, failure } : stopped(guard, failure);
  }

  // 2. Whose token it is, asked of Supabase with that token.
  const { data: userData, error: userError } = await auth.getUser(token);
  const guard = saveGuard(expectedUserId, userData.user, kept(userError));
  if (!guard.ok) return stopped(guard, kept(userError));

  // 3. The password, sent with the same token.
  let failure: AuthFailure | null;
  try {
    const res = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
      method: "PUT",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json;charset=UTF-8",
        "X-Supabase-Api-Version": "2024-01-01",
      },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
    if (res.ok) {
      failure = null;
    } else {
      // The body is read for its code only. One that is not JSON has no code.
      const body: unknown = await res.json().catch(() => null);
      failure = { status: res.status, code: errorCode(body) };
    }
  } catch (thrown) {
    // No answer: offline, blocked, or the time limit. Whether the password
    // changed is then unknown, and the page says "couldn't save", never "done".
    failure = { status: 0, name: thrown instanceof Error ? thrown.name : typeof thrown };
  }

  const outcome = saveOutcome(failure);
  return {
    step: outcome.step,
    message: outcome.step === "form" ? outcome.message : null,
    report: outcome.report,
    failure,
  };
}
