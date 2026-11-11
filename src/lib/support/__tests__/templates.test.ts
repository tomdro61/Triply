import { describe, it, expect } from "vitest";
import {
  REPLY_TEMPLATES,
  MAILTO_MAX_LENGTH,
  findTemplate,
  greetingName,
  mailtoHref,
  renderTemplate,
  replySubject,
  type TemplateContext,
} from "../templates";

const booking = {
  reservationNumber: "RL998877",
  locationName: "Park Fast",
  airportCode: "EWR",
  checkIn: "2026-11-25 05:30:00",
  checkOut: "2026-11-30 22:00:00",
};
const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  ticketNumber: 1042,
  subject: "Cancellation Request",
  customerName: "maria garcia",
  booking,
  ...over,
});

describe("saved reply templates", () => {
  it("ids are unique and every template renders", () => {
    expect(new Set(REPLY_TEMPLATES.map((t) => t.id)).size).toBe(REPLY_TEMPLATES.length);
    for (const t of REPLY_TEMPLATES) expect(renderTemplate(t, ctx()).length).toBeGreaterThan(50);
  });

  it("fills booking facts as stored, airport-local time untouched", () => {
    const text = renderTemplate(findTemplate("late_cancel")!, ctx());
    expect(text).toContain("Hi Maria,");
    expect(text).toContain("RL998877");
    expect(text).toContain("Park Fast (EWR)");
    expect(text).toContain("Nov 25, 2026 at 5:30 AM");
    expect(text).not.toMatch(/\[[^\]]+\]/);
  });

  it("without a matched booking, leaves [blanks] instead of guessing", () => {
    const text = renderTemplate(findTemplate("late_cancel")!, ctx({ booking: null }));
    expect(text).toContain("[reservation number]");
    expect(text).toContain("[parking lot]");
    expect(text).toContain("[check-in date and time]");
  });

  it("a booking missing one fact still fills the others", () => {
    const text = renderTemplate(findTemplate("late_cancel")!, ctx({ booking: { ...booking, checkIn: null, locationName: null } }));
    expect(text).toContain("[check-in date and time]");
    expect(text).toContain("[parking lot]");
    expect(text).toContain("RL998877");
    const declined = renderTemplate(findTemplate("change_dates")!, ctx({ booking: { ...booking, checkOut: null } }));
    expect(declined).toContain("Park Fast (EWR)");
  });

  it("the decline never says late cancellations are never refundable (terms 5.3: case by case)", () => {
    const text = renderTemplate(findTemplate("late_cancel_declined")!, ctx());
    expect(text).not.toMatch(/aren't refundable|not refundable|non-refundable/i);
    expect(text).toContain("case by case");
  });

  it("change dates never promises self-cancel unconditionally (it can be off, or the booking not eligible)", () => {
    const text = renderTemplate(findTemplate("change_dates")!, ctx());
    const selfCancel = text.split("\n").find((l) => l.includes("/reservations"));
    expect(selfCancel).toMatch(/^\[.*\]$/);
    expect(text).toContain("we'll cancel it for you");
  });

  it("greets by first name only, and never repeats something that isn't a name", () => {
    expect(greetingName("  anne-marie  o'neil ")).toBe("Anne-marie");
    expect(greetingName("José")).toBe("José");
    expect(greetingName("http://evil.example")).toBe("there");
    expect(greetingName("<b>x</b>")).toBe("there");
    expect(greetingName("")).toBe("there");
  });

  it("every template opens in a mail app for a long ticket subject + long lot name", () => {
    const long = ctx({
      subject: "Partnership Inquiry",
      booking: { ...booking, locationName: "Long Term Economy Parking Lot With A Very Long Operator Name" },
    });
    for (const t of REPLY_TEMPLATES) {
      const href = mailtoHref("someone.with.a.long.address@example.com", replySubject(1042, long.subject), renderTemplate(t, long));
      expect(href.length, t.id).toBeLessThanOrEqual(MAILTO_MAX_LENGTH);
    }
  });

  it("mailto encodes the address, subject and body", () => {
    const href = mailtoHref("a+b@x.com", "Re: Triply #1 - Hi & bye", "line1\nline2");
    expect(href).toBe("mailto:a%2Bb%40x.com?subject=Re%3A%20Triply%20%231%20-%20Hi%20%26%20bye&body=line1%0Aline2");
    expect(mailtoHref("a@x.com", "s")).not.toContain("body=");
  });
});
