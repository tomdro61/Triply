import { describe, it, expect } from "vitest";
import { renderAutoReply, renderTeamEmail } from "../reply";
import type { MatchedBooking, ReplyKind } from "../triage";

const B: MatchedBooking = {
  id: "b1",
  reservationNumber: "TRP1234",
  status: "confirmed",
  checkIn: "2026-11-20 08:00:00",
  checkOut: "2026-11-25T18:30:00",
  timezone: "America/New_York",
  locationName: "Runway <Park>",
  locationAddress: "1 Airport Rd",
  airportCode: "EWR",
};

const KINDS: ReplyKind[] = [
  "self_cancel",
  "already_cancelled",
  "cancel_support",
  "change",
  "at_lot",
  "booking_details",
  "payment",
  "partner",
  "generic",
];

describe("renderAutoReply", () => {
  it("puts the ticket number in the subject", () => {
    expect(renderAutoReply({ kind: "generic", subject: "Other", ticketNumber: 1042, booking: null, canSelfCancel: false }).subject).toBe(
      "We received your message (Triply #1042) - Triply"
    );
    expect(renderAutoReply({ kind: "generic", subject: "Other", ticketNumber: null, booking: null, canSelfCancel: false }).subject).toBe(
      "We received your message - Triply"
    );
  });

  it("every kind renders, escapes booking facts and shows literal airport-local times", () => {
    for (const kind of KINDS) {
      const { html } = renderAutoReply({ kind, subject: "Booking Help", ticketNumber: 1, booking: B, canSelfCancel: true });
      expect(html, kind).toContain("The Triply Team");
      expect(html, kind).not.toContain("<Park>");
      if (!["partner", "generic"].includes(kind)) {
        expect(html, kind).toContain("Runway &lt;Park&gt; (EWR)");
        expect(html, kind).toContain("Nov 20, 2026 at 8:00 AM");
        expect(html, kind).toContain("Nov 25, 2026 at 6:30 PM");
      }
    }
  });

  it("self_cancel gives the steps; change mentions self-cancel only when it applies", () => {
    expect(renderAutoReply({ kind: "self_cancel", subject: "Cancellation Request", ticketNumber: 1, booking: B, canSelfCancel: true }).html).toContain(
      "triplypro.com/reservations"
    );
    const can = renderAutoReply({ kind: "change", subject: "Change My Reservation", ticketNumber: 1, booking: B, canSelfCancel: true }).html;
    const cannot = renderAutoReply({ kind: "change", subject: "Change My Reservation", ticketNumber: 1, booking: B, canSelfCancel: false }).html;
    expect(can).toContain("cancel this reservation yourself");
    expect(cannot).not.toContain("cancel this reservation yourself");
  });

  it("without a booking, asks for the reservation number instead", () => {
    const { html } = renderAutoReply({ kind: "at_lot", subject: "Problem at the Lot", ticketNumber: 1, booking: null, canSelfCancel: false });
    expect(html).toContain("reply with your reservation number");
    expect(html).not.toContain("TRP1234");
  });
});

describe("renderTeamEmail", () => {
  const base = {
    ticketNumber: 1042,
    name: "Pat <script>",
    email: "pat@example.com",
    subject: "Problem at the Lot" as const,
    message: "Shuttle <b>never</b> came",
    reservationNumber: "TRP1234",
    bookingMatch: "matched" as const,
    booking: B,
    priority: "urgent" as const,
    reasons: ["problem at the lot", "shuttle"],
    replyKind: "at_lot" as const,
  };

  it("tags urgent tickets in the subject and escapes everything the caller typed", () => {
    const { subject, html } = renderTeamEmail(base);
    expect(subject).toBe("[Contact Form] [URGENT] #1042 Problem at the Lot");
    expect(html).toContain("Pat &lt;script&gt;");
    expect(html).toContain("Shuttle &lt;b&gt;never&lt;/b&gt; came");
    expect(html).toContain("problem at the lot, shuttle");
  });

  it("warns when the reservation is under another email", () => {
    const { html } = renderTeamEmail({ ...base, bookingMatch: "email_mismatch", booking: null, priority: "normal", reasons: [] });
    expect(html).toContain("DIFFERENT email");
    expect(renderTeamEmail({ ...base, priority: "normal", reasons: [] }).subject).toBe("[Contact Form] #1042 Problem at the Lot");
  });
});
