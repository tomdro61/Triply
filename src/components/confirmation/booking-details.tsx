"use client";

import Image from "next/image";
import {
  Calendar,
  Clock,
  MapPin,
  Car,
  User,
  Phone,
  Mail,
  Navigation,
  Wallet,
} from "lucide-react";
import { UnifiedLot } from "@/types/lot";
import { formatDate as sharedFormatDate } from "@/lib/utils";
import {
  formatUsd,
  toCents,
  type CostBreakdown,
  type CostBreakdownResult,
  type FallbackDue,
} from "@/lib/booking/cost-breakdown";
import type { CardSummary } from "@/lib/booking/confirmation-payment";

/**
 * What the plain fallback shows when the breakdown was refused (`ok: false`),
 * both decided server-side: the card side as Stripe reports it (charged +
 * refunds / released / unknown — never an amount computed from the booking
 * and called "charged") and what may be said about money due at the
 * location / lot (core `fallbackDue`: an amount, unconfirmed, or none).
 */
export interface PaymentFallback {
  card: CardSummary;
  due: FallbackDue;
  /** Labels the due line: ResLab's recorded figure, or the direct lot's estimate + its size/tax note. */
  dueContext:
    | { source: "reslab" }
    | {
        source: "direct";
        estimate: { vehicleSizeLabel: string; surcharge: number; surchargeTax: number } | null;
      };
}

function directDueNote(estimate: { vehicleSizeLabel: string; surcharge: number; surchargeTax: number } | null): string {
  const surcharge = estimate ? toCents(estimate.surcharge) : null;
  const tax = estimate ? toCents(estimate.surchargeTax) : null;
  if (!estimate || surcharge === null || tax === null) return "Paid at drop-off. Not charged online.";
  return `${estimate.vehicleSizeLabel}: ${formatUsd(surcharge)}${tax > 0 ? ` + ${formatUsd(tax)} tax` : ""}, paid at drop-off. Not charged online.`;
}

interface BookingDetailsProps {
  lot: UnifiedLot;
  checkIn: string;
  checkOut: string;
  checkInTime: string;
  checkOutTime: string;
  days: number;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  vehicleInfo?: string;
  /**
   * The Payment summary, built and checked server-side by
   * `GET /api/reservations/[id]` (plan notes/2026-10-12-cost-breakdown-plan.md).
   * This component renders it — it never adds anything up itself.
   */
  costBreakdown: CostBreakdownResult;
  fallback: PaymentFallback;
  /**
   * The booking was cancelled: keep the record (lot, dates, amounts, refund)
   * but drop what only applies to a live reservation — money still due at the
   * location and Get Directions. Required, never defaulted (see ConfirmationHeader).
   */
  cancelled: boolean;
}

function Row({
  label,
  cents,
  credit = false,
  className = "text-gray-700",
}: {
  label: string;
  cents: number;
  credit?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex justify-between gap-3 ${className}`}>
      <span>{label}</span>
      <span className="tabular-nums whitespace-nowrap">{formatUsd(cents, credit)}</span>
    </div>
  );
}

function DueRow({ label, cents, note }: { label: string; cents: number; note: string }) {
  return (
    <div>
      <div className="flex justify-between gap-3 font-medium text-amber-700">
        <span className="flex items-center gap-1.5">
          <Wallet size={14} />
          {label}
        </span>
        <span className="tabular-nums whitespace-nowrap font-semibold">{formatUsd(cents)}</span>
      </div>
      <p className="text-xs text-gray-500 mt-0.5">{note}</p>
    </div>
  );
}

/** The checked breakdown: lines → rule → total → (paid online / due) → refund. */
function BreakdownSummary({ b }: { b: CostBreakdown }) {
  // "Booking total" only where the card line IS the total; ResLab's "Total"
  // (the whole booking, incl. the share due at the location) keeps its label.
  const totalLabel = b.cancelled && b.totalLabel !== "Total" ? "Booking total" : b.totalLabel;
  return (
    <div className="space-y-1.5 text-sm">
      {b.lines.map((line) => (
        <Row key={line.key} label={line.label} cents={line.cents} credit={line.credit} />
      ))}
      <div className="border-t border-gray-200 pt-2 mt-2">
        <Row label={totalLabel} cents={b.totalCents} className="font-semibold text-gray-900" />
      </div>
      {b.totalLabel === "Total" && (
        <div className="space-y-1.5 pl-3">
          <Row label="Paid online (card)" cents={b.paidOnlineCents} className="text-gray-600" />
          {b.dueAtLocationCents > 0 && (
            <DueRow label="Due at location" cents={b.dueAtLocationCents} note="Paid when you arrive." />
          )}
        </div>
      )}
      {b.atLot && (
        <div className="space-y-1.5 pt-1">
          <DueRow
            label="Due at the lot (est.)"
            cents={b.atLot.cents}
            note={`${b.atLot.vehicleSizeLabel}: ${formatUsd(b.atLot.surchargeCents)}${
              b.atLot.surchargeTaxCents > 0 ? ` + ${formatUsd(b.atLot.surchargeTaxCents)} tax` : ""
            }, paid at drop-off. Not charged online.`}
          />
          {b.tripTotalCents !== null && (
            <div className="border-t border-gray-200 pt-2 mt-2">
              <Row
                label={b.tripTotalIsEstimate ? "Trip total (est.)" : "Trip total"}
                cents={b.tripTotalCents}
                className="font-semibold text-gray-900"
              />
            </div>
          )}
        </div>
      )}
      {b.refundedCents > 0 && b.netPaidCents !== null && (
        <div className="border-t border-gray-200 pt-2 mt-2 space-y-1.5">
          <Row label="Refunded" cents={b.refundedCents} credit className="text-emerald-700" />
          <Row label="Net paid" cents={b.netPaidCents} className="font-semibold text-gray-900" />
        </div>
      )}
    </div>
  );
}

/**
 * The plain layout when the breakdown was refused — no itemisation, no
 * guesses. "Charged to card" appears ONLY for Stripe's own amount.
 */
function FallbackSummary({ fallback, cancelled }: { fallback: PaymentFallback; cancelled: boolean }) {
  const { card, due } = fallback;
  return (
    <div className="space-y-1.5 text-sm">
      {card.status === "charged" ? (
        <>
          <Row label="Charged to card" cents={card.chargedCents} className="font-semibold text-gray-900" />
          {card.refundedCents > 0 && card.netPaidCents !== null && (
            <div className="border-t border-gray-200 pt-2 mt-2 space-y-1.5">
              <Row label="Refunded" cents={card.refundedCents} credit className="text-emerald-700" />
              <Row label="Net paid" cents={card.netPaidCents} className="font-semibold text-gray-900" />
            </div>
          )}
        </>
      ) : card.status === "released" ? (
        <p className="font-medium text-gray-900">Not charged — the card hold was released.</p>
      ) : (
        <p className="text-gray-600">
          The full payment details are in your confirmation email.
        </p>
      )}
      {!cancelled && due.kind === "amount" && (
        fallback.dueContext.source === "direct" ? (
          <DueRow label="Due at the lot (est.)" cents={due.cents} note={directDueNote(fallback.dueContext.estimate)} />
        ) : (
          <DueRow label="Due at location (as recorded)" cents={due.cents} note="Paid when you arrive." />
        )
      )}
      {!cancelled && due.kind === "unconfirmed" && (
        // The recorded due amount is missing, implausible, or a $0 the refusal
        // puts in doubt — never printed as fact, never turned into "nothing due".
        <p className="text-gray-600">
          The lot will confirm any amount due when you arrive. Questions? support@triplypro.com
        </p>
      )}
    </div>
  );
}

export function BookingDetails({
  lot,
  checkIn,
  checkOut,
  checkInTime,
  checkOutTime,
  days,
  customerName,
  customerEmail,
  customerPhone,
  vehicleInfo,
  costBreakdown,
  fallback,
  cancelled,
}: BookingDetailsProps) {
  const mainImage = lot.photos[0]?.url || "/placeholder-lot.jpg";

  const formatLongDate = (dateStr: string) => {
    return sharedFormatDate(dateStr + "T00:00:00", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatShortDate = (dateStr: string) => {
    return sharedFormatDate(dateStr + "T00:00:00", {
      month: "short",
      day: "numeric",
    });
  };

  const handleGetDirections = () => {
    const address = encodeURIComponent(
      `${lot.address}, ${lot.city}, ${lot.state} ${lot.zipCode || ""}`
    );
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${address}`, "_blank");
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Lot Header */}
      <div className="relative h-48">
        <Image
          src={mainImage}
          alt={lot.name}
          fill
          className="object-cover"
          sizes="(max-width: 768px) 100vw, 600px"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
        <div className="absolute bottom-4 left-4 right-4">
          <h2 className="text-xl font-bold text-white mb-1">{lot.name}</h2>
          <div className="flex items-center text-white/90 text-sm">
            <MapPin size={14} className="mr-1" />
            {lot.address}, {lot.city}, {lot.state}
          </div>
        </div>
      </div>

      {/* Details Grid */}
      <div className="p-6">
        {/* Dates */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center text-gray-500 text-sm mb-1">
              <Calendar size={14} className="mr-2" />
              Check-in
            </div>
            <p className="font-bold text-gray-900">{formatShortDate(checkIn)}</p>
            <p className="text-sm text-gray-600">{formatLongDate(checkIn)}</p>
            {checkInTime && (
              <p className="text-sm text-brand-orange font-medium mt-1">{checkInTime}</p>
            )}
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center text-gray-500 text-sm mb-1">
              <Calendar size={14} className="mr-2" />
              Check-out
            </div>
            <p className="font-bold text-gray-900">{formatShortDate(checkOut)}</p>
            <p className="text-sm text-gray-600">{formatLongDate(checkOut)}</p>
            {checkOutTime && (
              <p className="text-sm text-brand-orange font-medium mt-1">{checkOutTime}</p>
            )}
          </div>
        </div>

        {/* Duration */}
        <div className="flex items-center p-4 bg-brand-orange/10 rounded-lg mb-6">
          <Clock size={20} className="text-brand-orange mr-3" />
          <div>
            <p className="text-sm text-gray-600">Duration</p>
            <p className="font-bold text-gray-900">
              {days} {days === 1 ? "day" : "days"}
            </p>
          </div>
        </div>

        {/* Payment summary — rendered from the server's checked breakdown,
            or the plain fallback when it was refused. */}
        <div className="p-4 border border-gray-200 rounded-lg mb-6">
          <h3 className="font-semibold text-gray-900 mb-3">Payment summary</h3>
          {costBreakdown.ok ? (
            <BreakdownSummary b={costBreakdown} />
          ) : (
            <FallbackSummary fallback={fallback} cancelled={cancelled} />
          )}
        </div>

        {/* Customer & Vehicle Info */}
        {(customerName || vehicleInfo) && (
          <div className="border-t border-gray-200 pt-6 space-y-4">
            <h3 className="font-semibold text-gray-900">Booking Information</h3>

            {customerName && (
              <div className="flex items-center text-gray-700">
                <User size={18} className="mr-3 text-gray-400" />
                <span>{customerName}</span>
              </div>
            )}

            {customerEmail && (
              <div className="flex items-center text-gray-700">
                <Mail size={18} className="mr-3 text-gray-400" />
                <span>{customerEmail}</span>
              </div>
            )}

            {customerPhone && (
              <div className="flex items-center text-gray-700">
                <Phone size={18} className="mr-3 text-gray-400" />
                <span>{customerPhone}</span>
              </div>
            )}

            {vehicleInfo && (
              <div className="flex items-center text-gray-700">
                <Car size={18} className="mr-3 text-gray-400" />
                <span>{vehicleInfo}</span>
              </div>
            )}
          </div>
        )}

        {/* Get Directions Button */}
        {!cancelled && (
          <button
            onClick={handleGetDirections}
            className="w-full mt-6 flex items-center justify-center gap-2 py-3 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 transition-colors"
          >
            <Navigation size={18} />
            Get Directions
          </button>
        )}
      </div>
    </div>
  );
}
