/**
 * /api/contact is public and sends two emails per request from our verified
 * Resend domain. The /partners page (PR #56) makes it a lead-gen target, so
 * these pin the three guards added with it: the honeypot, the per-IP limit,
 * and the confirmation email no longer echoing caller-supplied text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const resendSend = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resend/client", () => ({
  resend: { emails: { send: resendSend } },
  FROM_EMAIL: "Triply <support@triplypro.com>",
}));
vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));

import { POST } from "../route";
import { CONTACT_HONEYPOT_FIELD } from "@/lib/validation/schemas";
import { __resetContactRateLimitForTests } from "@/lib/attribution/limiter";

const valid = {
  name: "Pat Operator",
  email: "pat@example.com",
  subject: "Partnership Inquiry",
  message: "Partner inquiry from triplypro.com/partners\n\nLot / company: Runway Park & Fly",
};

function req(body: unknown, ip = "203.0.113.7") {
  return new NextRequest("https://www.triplypro.com/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resendSend.mockReset();
  resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
  __resetContactRateLimitForTests();
});

describe("POST /api/contact", () => {
  it("sends the team copy and a confirmation that names the subject but never echoes the message", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
    const [team, confirmation] = resendSend.mock.calls.map((c) => c[0]);
    expect(team.html).toContain("Runway Park &amp; Fly");
    expect(confirmation.to).toEqual(["pat@example.com"]);
    expect(confirmation.html).toContain("Partnership Inquiry");
    expect(confirmation.html).not.toContain("Runway Park");
  });

  it("answers a filled honeypot with the same 200 and sends nothing", async () => {
    const res = await POST(req({ ...valid, [CONTACT_HONEYPOT_FIELD]: "http://spam.example" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("an empty honeypot (what both real forms send) is not a trap", async () => {
    const res = await POST(req({ ...valid, [CONTACT_HONEYPOT_FIELD]: "" }));
    expect(res.status).toBe(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
  });

  it("rate-limits per IP after 5 messages in 10 minutes, with Retry-After, and other IPs are unaffected", async () => {
    for (let i = 0; i < 5; i++) expect((await POST(req(valid))).status).toBe(200);
    const sixth = await POST(req(valid));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("Retry-After")).toBe("600");
    expect(resendSend).toHaveBeenCalledTimes(10);
    expect((await POST(req(valid, "198.51.100.9"))).status).toBe(200);
  });

  it("still 400s invalid input", async () => {
    const res = await POST(req({ ...valid, email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(resendSend).not.toHaveBeenCalled();
  });
});
