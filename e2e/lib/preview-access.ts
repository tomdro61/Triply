/**
 * How the smoke test gets through Vercel's Deployment Protection.
 *
 * No stored secret. The CI job proves it is this repository's GitHub Actions
 * run with a GitHub OIDC token, and the Vercel project trusts that identity
 * for Preview deployments only (Vercel > Settings > Deployment Protection >
 * Trusted Sources). The token lasts about five minutes, so it is minted here,
 * in Node, and re-minted when it gets old.
 *
 * The token is sent ONLY on requests to the preview host (see guard.ts). It is
 * never put in the browser context's default headers: those would go to
 * Stripe and every other third party the page calls. Never log it.
 */

/** Header Vercel reads the trusted OIDC token from. */
export const TRUSTED_TOKEN_HEADER = "x-vercel-trusted-oidc-idp-token";

/** Re-mint well before GitHub's ~5 minute expiry. */
const MAX_TOKEN_AGE_MS = 2 * 60 * 1000;

let cached: { value: string; mintedAt: number } | null = null;

/** Every failure this test can name carries one of these, for the CI summary. */
export type FailureKind = "APP" | "UPSTREAM" | "CONFIG";

export function failure(kind: FailureKind, message: string): Error {
  return new Error(`[${kind}] ${message}`);
}

export async function previewToken(): Promise<string> {
  if (cached && Date.now() - cached.mintedAt < MAX_TOKEN_AGE_MS) return cached.value;

  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    // Red, never a silent pass: a job without the credential proves nothing.
    throw failure(
      "CONFIG",
      "no GitHub OIDC credential in this job (needs `permissions: id-token: write`; fork and Dependabot PRs do not get one)"
    );
  }

  // No audience parameter: GitHub then uses https://github.com/<owner>, which
  // is the audience the Vercel rule expects.
  const response = await fetch(requestUrl, { headers: { authorization: `Bearer ${requestToken}` } });
  if (!response.ok) {
    throw failure("CONFIG", `GitHub refused to mint an OIDC token (HTTP ${response.status})`);
  }
  const body: unknown = await response.json();
  const value =
    typeof body === "object" && body !== null && "value" in body && typeof body.value === "string" ? body.value : "";
  if (!value) throw failure("CONFIG", "GitHub's OIDC response had no token");

  cached = { value, mintedAt: Date.now() };
  return value;
}

/** The preview this run tests. Refuses anything that is not a Vercel deployment URL. */
export function previewOrigin(): URL {
  const raw = process.env.SMOKE_BASE_URL;
  if (!raw) throw failure("CONFIG", "SMOKE_BASE_URL is not set");
  const url = new URL(raw);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".vercel.app")) {
    // Not localhost (it books against production ResLab) and never the live site.
    throw failure("CONFIG", "SMOKE_BASE_URL must be an https *.vercel.app preview URL");
  }
  return url;
}
