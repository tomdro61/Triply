import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const send = vi.fn();
const captureBookingError = vi.fn();
vi.mock("../client", () => ({ resend: { emails: { send } }, FROM_EMAIL: "Triply <bookings@example.com>" }));
vi.mock("@/lib/sentry", () => ({ captureBookingError }));

const { sendAdminBookingNotification, bookingAlertEmbed } = await import("../send-admin-booking-notification");

const HOOK = "https://discord.example/api/webhooks/1/secret";
const base = {
  confirmationNumber: "RTL870500",
  customerName: "Ada Lovelace",
  customerEmail: "ada@example.com",
  customerPhone: "555-0100",
  lotName: "Fox Parking",
  lotAddress: "1 Airport Rd",
  checkInDate: "2026-10-24",
  checkOutDate: "2026-10-27",
  totalAmount: 61.5,
  dueAtLocation: 0,
  vehicleInfo: "Honda Civic (Blue) - ABC123",
  airportCode: "EWR",
};

const fetchMock = vi.fn();
const posted = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

beforeEach(() => {
  send.mockReset().mockResolvedValue({ data: { id: "em_admin" }, error: null });
  captureBookingError.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("DISCORD_BOOKING_ALERTS_WEBHOOK_URL", HOOK);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("New Booking alert → Discord, email as the fallback", () => {
  it("posts to the webhook and sends NO email when Discord accepts it", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const r = await sendAdminBookingNotification(base);
    expect(r).toEqual({ success: true, channel: "discord" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(HOOK);
    expect(send).not.toHaveBeenCalled();
    expect(captureBookingError).not.toHaveBeenCalled();
    const body = posted();
    expect(body.username).toBe("Triply Bookings");
    expect(body.embeds[0].title).toBe("New booking — RTL870500");
  });

  it("the post carries the customer's name but never their email, phone or vehicle", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await sendAdminBookingNotification(base);
    const text = JSON.stringify(posted());
    expect(text).toContain("Ada Lovelace");
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toContain("555-0100");
    expect(text).not.toContain("ABC123");
  });

  it("a Discord error (500) → emailed instead, reported, not retried", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 500 }));
    const r = await sendAdminBookingNotification(base);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ success: true, emailId: "em_admin" });
    expect(captureBookingError).toHaveBeenCalledTimes(1);
    expect(String(captureBookingError.mock.calls[0][0].message)).toMatch(/RTL870500 \(500: .+\) — emailed instead/);
  });

  it("a rate limit (429) → emailed instead, no sleep", async () => {
    fetchMock.mockResolvedValue(new Response('{"retry_after": 1}', { status: 429 }));
    await sendAdminBookingNotification(base);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a network failure or timeout → emailed instead", async () => {
    fetchMock.mockRejectedValue(new Error("The operation was aborted due to timeout"));
    await sendAdminBookingNotification(base);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(captureBookingError.mock.calls[0][0].message)).toMatch(/no response: The operation was aborted/);
  });

  it("the webhook never appears in what is reported", async () => {
    fetchMock.mockResolvedValue(new Response("bad", { status: 400 }));
    await sendAdminBookingNotification(base);
    expect(JSON.stringify(captureBookingError.mock.calls)).not.toContain("secret");
  });

  it("no webhook configured → emailed exactly as before, nothing reported", async () => {
    vi.stubEnv("DISCORD_BOOKING_ALERTS_WEBHOOK_URL", "  ");
    await sendAdminBookingNotification(base);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(captureBookingError).not.toHaveBeenCalled();
  });
});

describe("bookingAlertEmbed", () => {
  it("customer text can't become a link, heading or bold", () => {
    const e = bookingAlertEmbed({ ...base, customerName: "# [View in Dashboard](https://evil.example) **x**" });
    const customer = e.fields.find((f) => f.name === "Customer")!.value;
    expect(customer).toBe("\\# \\[View in Dashboard\\]\\(https://evil.example\\) \\*\\*x\\*\\*");
  });

  it("multi-line input is one line", () => {
    const e = bookingAlertEmbed({ ...base, customerName: "Ada\n\nLovelace" });
    expect(e.fields.find((f) => f.name === "Customer")!.value).toBe("Ada Lovelace");
  });

  it("the plain money lines: total, protection, paid online, due at location", () => {
    const e = bookingAlertEmbed({ ...base, totalAmount: 80, dueAtLocation: 20, protectionPlan: "Plan A", protectionPlanPrice: 12.99 });
    expect(e.fields.find((f) => f.name === "Money")!.value).toBe(
      ["Total: **$80.00**", "Parking Protection: **Plan A — $12.99**", "Paid Online: **$60.00**", "Due at Location: **$20.00**"].join("\n")
    );
  });

  it("a direct booking shows its source and vehicle size; ResLab bookings don't", () => {
    const direct = bookingAlertEmbed({ ...base, sourceLine: "Direct lot (Triply number)", vehicleDeclaration: "Small SUV — $10.00 est." });
    expect(direct.fields.map((f) => f.name)).toEqual(["Location", "Check-in", "Check-out", "Money", "Customer", "Vehicle size", "Source"]);
    expect(bookingAlertEmbed(base).fields.map((f) => f.name)).toEqual(["Location", "Check-in", "Check-out", "Money", "Customer"]);
  });

  it("no empty field values (Discord rejects them)", () => {
    const e = bookingAlertEmbed({ ...base, lotAddress: "", customerName: "  " });
    for (const f of e.fields) expect(f.value.length).toBeGreaterThan(0);
  });
});
