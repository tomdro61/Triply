import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STAGE_FAILED_AFTER_CONFIRM_MESSAGE,
  STAGE_FAILED_MESSAGE,
  STAGE_UNREACHABLE_AFTER_CONFIRM_MESSAGE,
  STAGE_UNREACHABLE_MESSAGE,
  SUBMIT_FAILED_MESSAGE,
  StageUnreachableError,
  shouldReportSubmitError,
  submitErrorFingerprint,
  submitErrorLabel,
} from "../submit-report";

describe("StageUnreachableError", () => {
  const browserTexts = [
    new TypeError("Failed to fetch"), // Chrome / Edge
    new TypeError("Load failed"), // Safari
    new TypeError("NetworkError when attempting to fetch resource."), // Firefox
  ];

  it("keeps the browser's error as the cause and names itself", () => {
    const err = new StageUnreachableError(browserTexts[0]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("StageUnreachableError");
    expect(err.cause).toBe(browserTexts[0]);
    expect(err.message).toContain("TypeError");
  });

  it("its own message matches none of the client Sentry ignoreErrors strings (or the event is dropped)", () => {
    const init = readFileSync(resolve(__dirname, "../../../instrumentation-client.ts"), "utf8");
    const ignoredStrings = [...init.matchAll(/^\s*"([^"]+)",\s*$/gm)].map((m) => m[1]);
    const ignoredPatterns = [...init.matchAll(/^\s*\/(.+)\/([a-z]*),\s*$/gm)].map(
      (m) => new RegExp(m[1], m[2])
    );
    expect(ignoredStrings).toContain("Failed to fetch"); // the list is where we think it is
    expect(ignoredPatterns.length).toBeGreaterThan(0);
    for (const cause of [...browserTexts, "offline", undefined]) {
      const message = new StageUnreachableError(cause).message;
      for (const needle of ignoredStrings) expect(message).not.toContain(needle);
      for (const pattern of ignoredPatterns) expect(message).not.toMatch(pattern);
    }
  });
});

describe("stage messages", () => {
  it("claim 'not charged' only before any confirm attempt", () => {
    expect(STAGE_UNREACHABLE_MESSAGE).toMatch(/not been charged/);
    expect(STAGE_FAILED_MESSAGE).toMatch(/not been charged/);
    expect(STAGE_UNREACHABLE_AFTER_CONFIRM_MESSAGE).not.toMatch(/not been charged/);
    expect(STAGE_FAILED_AFTER_CONFIRM_MESSAGE).not.toMatch(/not been charged/);
    expect(STAGE_UNREACHABLE_AFTER_CONFIRM_MESSAGE).toMatch(/don't pay again/);
    expect(STAGE_FAILED_AFTER_CONFIRM_MESSAGE).toMatch(/don't pay again/);
  });
});

describe("shouldReportSubmitError", () => {
  it("customer-side card field codes are not incidents", () => {
    expect(shouldReportSubmitError({ type: "validation_error", code: "incomplete_number" })).toBe(false);
    expect(shouldReportSubmitError({ type: "validation_error", code: "incomplete_cvc" })).toBe(false);
    expect(shouldReportSubmitError({ type: "validation_error", code: "invalid_expiry_year" })).toBe(false);
  });

  it("a validation_error with any other code IS reported (e.g. the sheet could not be shown)", () => {
    expect(
      shouldReportSubmitError({
        type: "validation_error",
        code: "payment_intent_authentication_failure",
        message: "Unable to show Apple Pay.",
      })
    ).toBe(true);
  });

  it("a type-only error (no code) is reported", () => {
    expect(shouldReportSubmitError({ type: "api_error" })).toBe(true);
    expect(shouldReportSubmitError({ type: "validation_error" })).toBe(true);
  });
});

describe("submitErrorLabel / submitErrorFingerprint", () => {
  it("with code and message", () => {
    const err = { type: "validation_error", code: "payment_sheet_dismissed", message: "Closed." };
    expect(submitErrorLabel(err)).toBe(
      "elements.submit failed: validation_error/payment_sheet_dismissed: Closed."
    );
    expect(submitErrorFingerprint(err)).toEqual([
      "elements-submit",
      "validation_error",
      "payment_sheet_dismissed",
    ]);
  });

  it("without code or message: '-' placeholders, never 'undefined'", () => {
    const err = { type: "api_error" };
    expect(submitErrorLabel(err)).toBe("elements.submit failed: api_error/-: -");
    expect(submitErrorFingerprint(err)).toEqual(["elements-submit", "api_error", "-"]);
  });
});

describe("SUBMIT_FAILED_MESSAGE", () => {
  it("tells the customer they have not been charged (true: nothing staged or confirmed yet)", () => {
    expect(SUBMIT_FAILED_MESSAGE).toMatch(/not been charged/);
  });
});
