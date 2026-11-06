import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { hasRecordedUrlSecret } from "../recorded-url-params";

describe("hasRecordedUrlSecret", () => {
  it("matches the guest email and the Stripe client secret by param name", () => {
    expect(hasRecordedUrlSecret("https://www.triplypro.com/confirmation/RTL1?email=a%40b.co")).toBe(true);
    expect(hasRecordedUrlSecret("/checkout/complete?payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_x")).toBe(true);
    expect(hasRecordedUrlSecret("/confirmation/RTL1?lot=reslab-2")).toBe(false);
  });

  it("never matches on text: utm_medium=email and look-alike names are not secrets", () => {
    expect(hasRecordedUrlSecret("/blog/x?utm_source=triply&utm_medium=email")).toBe(false);
    expect(hasRecordedUrlSecret("/x?customer_email=a&payment_intent=pi_1")).toBe(false);
  });
});

/**
 * No page may navigate in-app to a URL carrying the guest's email: Clarity and
 * Sentry are already running and record it. The hand-off goes through
 * lib/confirmation/guest-email.ts (sessionStorage; a full page load when that
 * fails). Only the confirmation EMAIL may build an ?email= link.
 */
describe("no in-app ?email= links", () => {
  const SRC = path.resolve(__dirname, "../../..");
  // The confirmation email's link, and the storage-blocked fallback (which
  // always goes through a FULL page load — see confirmationHandOff).
  const ALLOWED = new Set([
    path.join("lib", "resend", "templates", "booking-confirmation.tsx"),
    path.join("lib", "confirmation", "guest-email.ts"),
  ]);

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it("only the email template and the hand-off helper build a URL carrying the email", () => {
    // Template literals (?email=${…}), concatenation ("&email=" + …) and
    // URLSearchParams / searchParams .set("email", …) / .append("email", …).
    const BUILDS_EMAIL_URL = /[?&]email=(?:\$\{|["'`]\s*\+)|\.(?:set|append)\(\s*["'`]email["'`]/;
    const offenders = sourceFiles(SRC)
      .filter((file) => !ALLOWED.has(path.relative(SRC, file)))
      .filter((file) => BUILDS_EMAIL_URL.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
