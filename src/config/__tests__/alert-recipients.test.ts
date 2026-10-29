import { describe, it, expect } from "vitest";
import { ADMIN_EMAILS, ALERT_EMAILS, PAYMENT_ALERT_EMAILS, isAdminEmail } from "../admin";

/**
 * Login and alert recipients are separate lists (Tom, 2026-10-22): Resend's
 * daily cap was being spent on duplicate team copies. These pin the defaults
 * production uses (no ADMIN_EMAILS / ALERT_EMAILS / PAYMENT_ALERT_EMAILS in Vercel).
 */
describe("admin login vs alert recipients", () => {
  it("tomjdigregorio@gmail.com can still sign in to /admin, but gets no alert emails", () => {
    expect(isAdminEmail("tomjdigregorio@gmail.com")).toBe(true);
    expect(ADMIN_EMAILS).toContain("tomjdigregorio@gmail.com");
    expect(ALERT_EMAILS).not.toContain("tomjdigregorio@gmail.com");
    expect(PAYMENT_ALERT_EMAILS).not.toContain("tomjdigregorio@gmail.com");
  });

  it("team alerts (New Booking, contact form) go to Vin, John and Tom", () => {
    expect(ALERT_EMAILS).toEqual(["vin@triplypro.com", "john@triplypro.com", "tom@triplypro.com"]);
  });

  it("payment monitor alerts go to Vin and Tom only", () => {
    expect(PAYMENT_ALERT_EMAILS).toEqual(["vin@triplypro.com", "tom@triplypro.com"]);
  });
});
