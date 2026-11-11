"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { formatLiteralDateTime } from "@/lib/booking/literal-time";
import { getAirportByCode } from "@/config/airports";
import {
  MATCH_STATEMENT,
  bookingStatusLabel,
  evidenceZone,
  formatInstant,
  formatInstantUtc,
  type EvidenceBooking,
  type EvidenceBookingMatch,
} from "@/lib/support/evidence";

/**
 * /admin/support/[id]/evidence — a printable record of one support ticket:
 * when the customer contacted us, what they wrote, and the booking it is about.
 * "Download PDF" opens the browser's print dialog (choose "Save as PDF"); the
 * print stylesheet below prints this record only, without the admin chrome.
 * Attach the PDF to a late-cancellation refund request.
 */

interface EvidenceTicket {
  id: string;
  ticket_number: number;
  name: string;
  email: string;
  subject: string;
  message: string;
  reservation_number: string | null;
  booking_match: EvidenceBookingMatch;
  status: string;
  first_response_at: string | null;
  resolved_at: string | null;
  notes: string;
  created_at: string;
  livemode: boolean;
}

type Loaded = { ticket: EvidenceTicket; booking: EvidenceBooking | null; bookingError: boolean };

const PRINT_CSS = `
@media print {
  @page { margin: 16mm; }
  body * { visibility: hidden !important; }
  #support-evidence, #support-evidence * { visibility: visible !important; }
  #support-evidence { position: absolute; left: 0; top: 0; width: 100%; border: 0 !important; box-shadow: none !important; padding: 0 !important; }
}`;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr className="align-top">
      <td className="w-48 py-1.5 pr-4 text-gray-500">{label}</td>
      <td className="py-1.5 text-gray-900">{children}</td>
    </tr>
  );
}

export default function SupportEvidencePage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [generatedAt] = useState(() => new Date().toISOString());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/support/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ticket) throw new Error(body?.error || `Failed to load ticket (${res.status})`);
        if (!cancelled) setData(body as Loaded);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load ticket");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>;
  }
  if (!data) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-brand-orange" />
      </div>
    );
  }

  const { ticket, booking, bookingError } = data;
  const zone = evidenceZone(booking, booking?.airport_code ? getAirportByCode(booking.airport_code)?.timezone : null);
  const notes = ticket.notes.trim();

  return (
    <div className="mx-auto max-w-3xl">
      <style>{PRINT_CSS}</style>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link href="/admin/support" className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900">
          <ArrowLeft className="h-4 w-4" /> Back to Support
        </Link>
        <div className="flex flex-wrap items-center gap-4">
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} />
            Include internal notes
          </label>
          <button
            onClick={() => window.print()}
            disabled={bookingError}
            title={bookingError ? "The reservation didn't load: reload the page first" : undefined}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-orange px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
          >
            <Download className="h-4 w-4" /> Download PDF
          </button>
        </div>
      </div>
      <p className="mb-4 text-xs text-gray-500">In the print window, choose &quot;Save as PDF&quot; as the destination.</p>

      <div id="support-evidence" className="rounded-xl border border-gray-200 bg-white p-8 text-sm">
        {!ticket.livemode && (
          <p className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 font-semibold text-amber-800">
            TEST TICKET (made on staging): not a real customer request.
          </p>
        )}
        <div className="border-b border-gray-200 pb-4">
          <p className="text-xl font-bold text-gray-900">
            <span className="text-brand-orange">Triply</span> · Customer contact record
          </p>
          <p className="mt-1 text-gray-600">
            Support ticket #{ticket.ticket_number} · triplypro.com · support@triplypro.com
          </p>
        </div>

        <h2 className="mt-5 mb-2 font-bold text-gray-900">The request</h2>
        <table className="w-full">
          <tbody>
            <Row label="Received">
              {formatInstant(ticket.created_at, zone)}
              <span className="block text-xs text-gray-500">{formatInstantUtc(ticket.created_at)}</span>
            </Row>
            <Row label="How it arrived">A web form on triplypro.com (stored by our system when it was submitted)</Row>
            <Row label="From (as entered on the form)">
              {ticket.name} &lt;{ticket.email}&gt;
            </Row>
            <Row label="Topic chosen">{ticket.subject}</Row>
            <Row label="Reservation number given">{ticket.reservation_number ?? "none"}</Row>
            <Row label="Reservation check">{MATCH_STATEMENT[ticket.booking_match]}</Row>
          </tbody>
        </table>

        <h2 className="mt-5 mb-2 font-bold text-gray-900">The customer&apos;s message, exactly as sent</h2>
        <div className="whitespace-pre-wrap rounded border border-gray-200 bg-gray-50 p-4 leading-relaxed text-gray-800">
          {ticket.message}
        </div>

        {(booking || bookingError) && (
          <>
            <h2 className="mt-5 mb-2 font-bold text-gray-900">The reservation</h2>
            {bookingError || !booking ? (
              <p className="text-red-700">The reservation details couldn&apos;t be loaded. Reload this page before saving it.</p>
            ) : (
              <table className="w-full">
                <tbody>
                  <Row label="Reservation">{booking.reslab_reservation_number ?? "not recorded"}</Row>
                  <Row label="Parking">
                    {booking.location_name ?? "not recorded"}
                    {booking.airport_code ? ` (${booking.airport_code})` : ""}
                    {booking.location_address && <span className="block text-gray-600">{booking.location_address}</span>}
                  </Row>
                  <Row label="Check-in (lot local time)">
                    {booking.check_in ? formatLiteralDateTime(booking.check_in) : "not recorded"}
                  </Row>
                  <Row label="Check-out (lot local time)">
                    {booking.check_out ? formatLiteralDateTime(booking.check_out) : "not recorded"}
                  </Row>
                  <Row label="Booked">{formatInstant(booking.created_at, zone)}</Row>
                  <Row label="Status now">{bookingStatusLabel(booking)}</Row>
                  {booking.cancel_claimed_at && <Row label="Cancellation recorded (latest attempt)">{formatInstant(booking.cancel_claimed_at, zone)}</Row>}
                  {booking.cancelled_by && <Row label="Cancelled by">{booking.cancelled_by}</Row>}
                  {booking.cancellation_reason && <Row label="Cancellation reason">{booking.cancellation_reason}</Row>}
                </tbody>
              </table>
            )}
          </>
        )}

        <h2 className="mt-5 mb-2 font-bold text-gray-900">Our handling</h2>
        <table className="w-full">
          <tbody>
            <Row label="Marked replied by our team">{ticket.first_response_at ? formatInstant(ticket.first_response_at, zone) : "not recorded"}</Row>
            <Row label="Closed">{ticket.resolved_at ? formatInstant(ticket.resolved_at, zone) : "still open"}</Row>
          </tbody>
        </table>

        {includeNotes && (
          <>
            <h2 className="mt-5 mb-2 font-bold text-gray-900">Team notes</h2>
            <div className="whitespace-pre-wrap rounded border border-gray-200 p-4 text-gray-800">{notes || "none"}</div>
          </>
        )}

        <p className="mt-6 border-t border-gray-200 pt-3 text-xs text-gray-500">
          {zone
            ? `Times are shown in the lot's time zone (${zone}).`
            : "The lot's time zone isn't recorded: check-in and check-out are the lot's local time; all other times are UTC."}{" "}
          Record generated {formatInstant(generatedAt, zone)} from Triply&apos;s support system.
        </p>
      </div>
    </div>
  );
}
