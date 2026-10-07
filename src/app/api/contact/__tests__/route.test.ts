/**
 * /api/contact is public and sends two emails per request from our verified
 * Resend domain. The /partners page (PR #56) makes it a lead-gen target, so
 * these pin the guards added with it: the honeypot (recorded, never silent),
 * the per-IP limit (charged only on a valid submission), the enum subject,
 * and a confirmation email that repeats nothing the caller typed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const resendSend = vi.hoisted(() => vi.fn());
const sentry = vi.hoisted(() => ({ captureAPIError: vi.fn(), captureContactHoneypotDrop: vi.fn() }));
vi.mock("@/lib/resend/client", () => ({
  resend: { emails: { send: resendSend } },
  FROM_EMAIL: "Triply <support@triplypro.com>",
}));
vi.mock("@/lib/sentry", () => sentry);

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
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  resendSend.mockReset();
  resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
  sentry.captureAPIError.mockReset();
  sentry.captureContactHoneypotDrop.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  __resetContactRateLimitForTests();
});

describe("POST /api/contact", () => {
  it("sends the team copy and a confirmation that repeats nothing the caller typed except the enum subject", async () => {
    const res = await POST(req({ ...valid, name: "Verify at secure-pay.example" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, confirmationSent: true });
    expect(resendSend).toHaveBeenCalledTimes(2);
    const [team, confirmation] = resendSend.mock.calls.map((c) => c[0]);
    expect(team.html).toContain("Runway Park &amp; Fly");
    expect(team.html).toContain("secure-pay.example"); // the team sees what was sent
    expect(confirmation.to).toEqual(["pat@example.com"]);
    expect(confirmation.html).toContain("Partnership Inquiry");
    expect(confirmation.html).not.toContain("Runway Park");
    expect(confirmation.html).not.toContain("secure-pay"); // the greeting names nobody
  });

  it("refuses a free-text subject — the dropdown values are the only ones accepted", async () => {
    const res = await POST(req({ ...valid, subject: "Claim your $500 refund at refund-now.example" }));
    expect(res.status).toBe(400);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("answers a filled honeypot with the same 200, sends nothing, and RECORDS the drop", async () => {
    const res = await POST(req({ ...valid, [CONTACT_HONEYPOT_FIELD]: "http://spam.example" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(resendSend).not.toHaveBeenCalled();
    expect(sentry.captureContactHoneypotDrop).toHaveBeenCalledWith({
      subject: "Partnership Inquiry",
      emailDomain: "example.com",
      ipKey: "203.0.113.7",
    });
  });

  it("the honeypot path counts against the per-IP limit, so one source cannot push unlimited drops through the logs", async () => {
    const bot = { ...valid, [CONTACT_HONEYPOT_FIELD]: "x" };
    for (let i = 0; i < 5; i++) expect((await POST(req(bot))).status).toBe(200);
    expect((await POST(req(bot))).status).toBe(429);
    expect(sentry.captureContactHoneypotDrop).toHaveBeenCalledTimes(5);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("an empty honeypot (what both real forms send) is not a trap", async () => {
    const res = await POST(req({ ...valid, [CONTACT_HONEYPOT_FIELD]: "" }));
    expect(res.status).toBe(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
    expect(sentry.captureContactHoneypotDrop).not.toHaveBeenCalled();
  });

  it("rate-limits per IP after 5 valid messages in 10 minutes, with Retry-After; other IPs are unaffected", async () => {
    for (let i = 0; i < 5; i++) expect((await POST(req(valid))).status).toBe(200);
    const sixth = await POST(req(valid));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("Retry-After")).toBe("600");
    expect(resendSend).toHaveBeenCalledTimes(10);
    expect((await POST(req(valid, "198.51.100.9"))).status).toBe(200);
  });

  it("a 400 never consumes the sender's allowance", async () => {
    for (let i = 0; i < 20; i++) expect((await POST(req({ ...valid, email: "nope" }))).status).toBe(400);
    expect((await POST(req(valid))).status).toBe(200);
  });

  it("a non-JSON body is a 400, not a 500 with a Sentry event", async () => {
    const res = await POST(req("not json at all"));
    expect(res.status).toBe(400);
    expect(sentry.captureAPIError).not.toHaveBeenCalled();
  });

  it("a failed confirmation send is reported in the response, not hidden", async () => {
    resendSend
      .mockResolvedValueOnce({ data: { id: "team" }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "suppressed recipient", name: "x", statusCode: 422 } });
    const res = await POST(req(valid));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, confirmationSent: false });
  });
});
