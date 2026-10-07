"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  Clock,
  Filter,
  Download,
  Eye,
  Calendar,
  X,
  ShieldCheck,
} from "lucide-react";
import { formatDate, formatDateTime, formatPrice } from "@/lib/utils";
import { parseMoneyColumn, pgWholesaleWithheld } from "@/lib/utils/money";
import { csvEscape } from "@/lib/utils/csv";
import { attributionSourceLabel as sourceLabel, type AttributionRow } from "@/lib/attribution/display";
import { PG_WHOLESALE_SHORT_SUMMARY } from "@/lib/parkguard/plans";
import {
  ADMIN_CANCELLATION_REASONS,
  CANCELLATION_REASON_LABELS,
  adminReasonSchema,
  type AdminCancellationReason,
  type CancellationReason,
} from "@/lib/cancellation/reason-codes";

interface Booking {
  id: string;
  reslab_reservation_number: string;
  reslab_location_id: number;
  location_name: string;
  check_in: string;
  check_out: string;
  subtotal: string;
  tax_total: string;
  fees_total: string;
  grand_total: string;
  triply_service_fee: string;
  due_at_location: string | null;
  discount_amount: string | null;
  promo_code: string | null;
  stripe_payment_intent_id: string | null;
  status: string;
  protection_plan: string | null;
  protection_plan_price: string | null;
  /** PG wholesale snapshotted per row at fulfilment (migration 021). */
  protection_plan_wholesale: string | null;
  pg_identifier: string | null;
  pg_sync_status: "pending" | "synced" | "skipped_missing_data" | null;
  /** Marketing attribution (migration 023). channel is the derived first-touch
   *  channel; attribution.first.cmp is the utm_campaign. Visitor-controlled
   *  strings — render as text only, never as an href. */
  channel: AttributionRow["channel"];
  airport_code: string | null;
  attribution: AttributionRow["attribution"];
  vehicle_info: {
    make: string;
    model: string;
    color: string;
    licensePlate: string;
    state: string;
  };
  created_at: string;
  /** Migration 032. Absent until 032 is applied; NULL = unknown. */
  cancellation_reason?: CancellationReason | null;
  cancellation_note?: string | null;
  cancelled_by?: "customer" | "admin" | "system" | null;
  customers: {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    phone: string;
  };
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function StatusBadge({ status }: { status: string }) {
  const statusStyles: Record<string, string> = {
    confirmed: "bg-green-100 text-green-800",
    cancelled: "bg-red-100 text-red-800",
    refunded: "bg-yellow-100 text-yellow-800",
    completed: "bg-gray-100 text-gray-800",
  };

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
        statusStyles[status] || "bg-gray-100 text-gray-800"
      }`}
    >
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export default function AdminBookingsPage() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  // Degraded-search notices from the API (customer lookup failed / truncated).
  const [searchWarnings, setSearchWarnings] = useState<string[]>([]);
  const [status, setStatus] = useState("all");
  const [dateRange, setDateRange] = useState("all");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [showCustomDatePicker, setShowCustomDatePicker] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // Which cancel path is in flight, so only the clicked button shows its
  // spinner label while both are disabled.
  const [cancellingMode, setCancellingMode] = useState<"standard" | "full" | null>(null);
  // Required reason + optional admin note for the cancel (migration 032).
  const [cancelReason, setCancelReason] = useState<AdminCancellationReason | "">("");
  const [cancelNote, setCancelNote] = useState("");
  const [cancelResult, setCancelResult] = useState<{
    success: boolean;
    message: string;
    parkGuardSyncFailed?: boolean;
    // The cancel went through but the reason / note did not get saved
    // (migration 032 not applied, or a transient write failure).
    reasonNotRecorded?: boolean;
    noteNotRecorded?: boolean;
  } | null>(null);

  async function handleCancelBooking(booking: Booking, refundServiceFee = false) {
    if (!cancelReason) {
      setCancelResult({ success: false, message: "Pick a cancellation reason first." });
      return;
    }
    const fee = parseFloat(booking.triply_service_fee) || 0;
    // Park Guard's wholesale (snapshotted per row in protection_plan_wholesale
    // — migration 021) is non-refundable to Triply, so a STANDARD cancel
    // withholds it — the SAME helper the route uses, so the dialog quotes the
    // figure the server will refund. A FULL refund returns the whole premium
    // and Triply eats the wholesale. A row with no wholesale withholds $0 (the
    // route flags it).
    const hasPG = !!booking.protection_plan;
    const pgPremium = parseMoneyColumn(booking.protection_plan_price);
    const pgWholesale = parseMoneyColumn(booking.protection_plan_wholesale);
    const pgWithheld = hasPG ? pgWholesaleWithheld(pgPremium, pgWholesale) : 0;
    const confirmMsg = refundServiceFee
      ? `FULL refund for ${booking.reslab_reservation_number} — refunds everything the customer paid Triply online, INCLUDING the $${fee.toFixed(2)} service fee${hasPG ? ` and the full $${pgPremium.toFixed(2)} Park Guard premium` : ""}. Use this when the lot turned the customer away. This cannot be undone.`
      : `Cancel ${booking.reslab_reservation_number} and refund the customer, RETAINING the $${fee.toFixed(2)} Triply service fee${hasPG ? ` and $${pgWithheld.toFixed(2)} of the $${pgPremium.toFixed(2)} Park Guard premium (its non-refundable wholesale — customer gets $${(pgPremium - pgWithheld).toFixed(2)} back)` : ""} (standard cancellation). This cannot be undone.`;
    if (!confirm(confirmMsg)) {
      return;
    }
    setCancelling(true);
    setCancellingMode(refundServiceFee ? "full" : "standard");
    setCancelResult(null);
    try {
      const response = await fetch("/api/admin/bookings/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reservationNumber: booking.reslab_reservation_number,
          stripePaymentIntentId: booking.stripe_payment_intent_id,
          refundServiceFee,
          reason: cancelReason,
          note: cancelNote.trim() || undefined,
        }),
      });
      const data = await response.json();
      const cancelled = !!(data.success || data.results?.supabase);
      // The route says whether the reason / note actually landed. Only trust a
      // true; a missing field (older bundle / unexpected body) counts as not
      // recorded so the screen never claims more than the database holds.
      const reasonRecorded = data.reasonRecorded === true;
      const noteRecorded = data.noteRecorded === true;
      const noteGiven = cancelNote.trim().length > 0;
      setCancelResult({
        success: !!data.success,
        // 4xx/5xx bodies carry `error`, not `message` — without this fallback a
        // refused cancel rendered an empty red box.
        message: data.message ?? data.error ?? `Cancel failed (HTTP ${response.status})`,
        parkGuardSyncFailed: data.results?.parkGuard === false,
        reasonNotRecorded: cancelled && !reasonRecorded,
        noteNotRecorded: cancelled && noteGiven && !noteRecorded,
      });
      if (cancelled) {
        const newStatus = data.newStatus || "cancelled";
        // Show only what was saved; an unsaved reason renders as "Unknown /
        // not given", matching what the report will show. Patched into the
        // list row too, so reopening the booking from the list (no refetch)
        // shows the same thing as the panel.
        const patch = (b: Booking): Booking => ({
          ...b,
          status: newStatus,
          cancellation_reason: reasonRecorded ? cancelReason : b.cancellation_reason ?? null,
          cancellation_note: noteRecorded ? cancelNote.trim() : b.cancellation_note ?? null,
          cancelled_by: reasonRecorded ? "admin" : b.cancelled_by ?? null,
        });
        setBookings((prev) => prev.map((b) => (b.id === booking.id ? patch(b) : b)));
        setSelectedBooking((prev) => (prev?.id === booking.id ? patch(prev) : prev));
      }
    } catch {
      setCancelResult({ success: false, message: "Network error — could not reach cancel API" });
    } finally {
      setCancelling(false);
      setCancellingMode(null);
    }
  }

  async function fetchBookings(page = 1) {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: "20",
      });

      if (status !== "all") {
        params.set("status", status);
      }

      if (search) {
        params.set("search", search);
      }

      // Date range filtering
      if (dateRange !== "all") {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (dateRange === "today") {
          params.set("startDate", today.toISOString());
          const tomorrow = new Date(today);
          tomorrow.setDate(tomorrow.getDate() + 1);
          params.set("endDate", tomorrow.toISOString());
        } else if (dateRange === "week") {
          const weekStart = new Date(today);
          weekStart.setDate(weekStart.getDate() - weekStart.getDay());
          params.set("startDate", weekStart.toISOString());
        } else if (dateRange === "month") {
          const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
          params.set("startDate", monthStart.toISOString());
        } else if (dateRange === "custom" && customStartDate) {
          params.set("startDate", new Date(customStartDate).toISOString());
          if (customEndDate) {
            const endDate = new Date(customEndDate);
            endDate.setDate(endDate.getDate() + 1);
            params.set("endDate", endDate.toISOString());
          }
        }
      }

      const res = await fetch(`/api/admin/bookings?${params}`);
      const data = await res.json();

      setBookings(data.bookings || []);
      setPagination(data.pagination);
      setSearchWarnings(Array.isArray(data.warnings) ? data.warnings : []);
    } catch (error) {
      console.error("Failed to fetch bookings:", error);
      setSearchWarnings([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBookings(1);
  }, [status, dateRange, customStartDate, customEndDate]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchBookings(1);
  };

  const handlePageChange = (newPage: number) => {
    fetchBookings(newPage);
  };

  const exportCSV = () => {
    const headers = [
      "Confirmation #",
      "Customer Name",
      "Email",
      "Phone",
      "Location",
      "Check In",
      "Check Out",
      "Booking Total",
      "Promo Code",
      "Discount",
      "Paid Online",
      "Status",
      "Protection Plan",
      "Protection Premium",
      "Park Guard ID",
      "Created",
      "Source",
      "Airport",
      "UTM Source",
      "UTM Medium",
      "UTM Campaign",
    ];

    const rows = bookings.map((b) => {
      const bookingTotal =
        parseFloat(b.grand_total) +
        parseFloat(b.triply_service_fee || "0") +
        parseFloat(b.protection_plan_price || "0");
      const discount = parseFloat(b.discount_amount || "0");
      const dueAtLocation = parseFloat(b.due_at_location || "0");
      const paidOnline = Math.max(0, bookingTotal - dueAtLocation - discount);
      return [
        b.reslab_reservation_number,
        `${b.customers?.first_name} ${b.customers?.last_name}`,
        b.customers?.email,
        b.customers?.phone,
        b.location_name,
        formatDateTime(b.check_in),
        formatDateTime(b.check_out),
        bookingTotal.toFixed(2),
        b.promo_code || "",
        discount > 0 ? discount.toFixed(2) : "",
        paidOnline.toFixed(2),
        b.status,
        b.protection_plan || "",
        b.protection_plan_price ? parseFloat(b.protection_plan_price).toFixed(2) : "",
        b.pg_identifier || "",
        formatDateTime(b.created_at),
        sourceLabel(b),
        b.airport_code || "",
        b.attribution?.first?.src || "",
        b.attribution?.first?.med || "",
        b.attribution?.first?.cmp || "",
      ];
    });

    // csvEscape neutralises formula injection — utm_* values are typed by the
    // visitor and would otherwise execute in an admin's spreadsheet.
    const csv = [headers, ...rows]
      .map((row) => row.map(csvEscape).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `triply-bookings-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Bookings</h1>
        <p className="text-gray-600">Manage all parking reservations</p>
      </div>

      {/* Filters */}
      {searchWarnings.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {searchWarnings.includes("customer_search_unavailable") && (
            <p>
              <strong>Name/email search is unavailable right now</strong> — results below match only
              the confirmation number and lot name. Check Sentry.
            </p>
          )}
          {searchWarnings.includes("customer_search_truncated") && (
            <p>
              <strong>Too many customers match that term</strong> — results are incomplete. Narrow the
              search (full name or full email).
            </p>
          )}
        </div>
      )}
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <div className="flex flex-wrap items-center gap-4">
          <form onSubmit={handleSearch} className="flex-1 min-w-[200px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, email, confirmation # (RTL…), or lot…"
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
              />
            </div>
          </form>

          <div className="flex items-center gap-2">
            <Filter size={18} className="text-gray-400" />
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none bg-white"
            >
              <option value="all">All Status</option>
              <option value="confirmed">Confirmed</option>
              <option value="cancelled">Cancelled</option>
              <option value="completed">Completed</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <Calendar size={18} className="text-gray-400" />
            <select
              value={dateRange}
              onChange={(e) => {
                setDateRange(e.target.value);
                if (e.target.value === "custom") {
                  setShowCustomDatePicker(true);
                } else {
                  setShowCustomDatePicker(false);
                  setCustomStartDate("");
                  setCustomEndDate("");
                }
              }}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none bg-white"
            >
              <option value="all">All Time</option>
              <option value="today">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="custom">Custom Range</option>
            </select>
          </div>

          {showCustomDatePicker && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none bg-white"
              />
              <span className="text-gray-400">to</span>
              <input
                type="date"
                value={customEndDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none bg-white"
              />
              <button
                onClick={() => {
                  setDateRange("all");
                  setShowCustomDatePicker(false);
                  setCustomStartDate("");
                  setCustomEndDate("");
                }}
                className="p-2 text-gray-400 hover:text-gray-600"
                title="Clear dates"
              >
                <X size={18} />
              </button>
            </div>
          )}

          <button
            onClick={exportCSV}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <Download size={18} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Bookings Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-brand-orange" />
          </div>
        ) : bookings.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No bookings found
          </div>
        ) : (
          <>
            {/* Mobile card view */}
            <div className="md:hidden divide-y divide-gray-200">
              {bookings.map((booking) => (
                <button
                  key={booking.id}
                  onClick={() => { setSelectedBooking(booking); setCancelResult(null); setCancelReason(""); setCancelNote(""); }}
                  className="w-full text-left p-4 hover:bg-gray-50 active:bg-gray-100 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-sm text-brand-orange truncate">
                        {booking.reslab_reservation_number}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {formatDateTime(booking.created_at)}
                      </p>
                    </div>
                    <StatusBadge status={booking.status} />
                  </div>
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {booking.customers?.first_name} {booking.customers?.last_name}
                  </p>
                  <p className="text-sm text-gray-500 truncate">
                    {booking.customers?.email}
                  </p>
                  <div className="flex items-center gap-1 text-sm text-gray-600 mt-2">
                    <MapPin size={14} className="text-gray-400 flex-shrink-0" />
                    <span className="truncate">{booking.location_name}</span>
                  </div>
                  <div className="flex items-center justify-between mt-2 gap-2">
                    <div className="flex items-center gap-1 text-xs text-gray-500 min-w-0">
                      <Clock size={14} className="text-gray-400 flex-shrink-0" />
                      <span className="truncate">
                        {formatDate(booking.check_in, { month: "short", day: "numeric" })} – {formatDate(booking.check_out, { month: "short", day: "numeric" })}
                      </span>
                    </div>
                    <span className="font-semibold text-gray-900 flex-shrink-0 flex items-center gap-1">
                      {formatPrice(
                        parseFloat(booking.grand_total) +
                          parseFloat(booking.triply_service_fee || "0") +
                          parseFloat(booking.protection_plan_price || "0")
                      )}
                      {booking.protection_plan && (
                        <ShieldCheck size={12} className="text-emerald-600" />
                      )}
                    </span>
                  </div>
                </button>
              ))}
            </div>

            {/* Desktop table view */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Confirmation #
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Customer
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Location
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Dates
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Total
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Source
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {bookings.map((booking) => (
                    <tr key={booking.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="font-mono text-sm text-brand-orange">
                          {booking.reslab_reservation_number}
                        </span>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {formatDateTime(booking.created_at)}
                        </p>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {booking.customers?.first_name} {booking.customers?.last_name}
                          </p>
                          <p className="text-sm text-gray-500">
                            {booking.customers?.email}
                          </p>
                          <p className="text-xs text-gray-400">
                            {booking.customers?.phone}
                          </p>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1 text-sm text-gray-900">
                          <MapPin size={14} className="text-gray-400 flex-shrink-0" />
                          <span className="truncate max-w-[200px]">
                            {booking.location_name}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm">
                          <div className="flex items-center gap-1 text-gray-600">
                            <Clock size={14} className="text-gray-400" />
                            {formatDate(booking.check_in, { month: "short", day: "numeric", year: "numeric" })}
                          </div>
                          <div className="text-gray-400 text-xs mt-0.5">
                            to {formatDate(booking.check_out, { month: "short", day: "numeric", year: "numeric" })}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-gray-900">
                            {formatPrice(
                              parseFloat(booking.grand_total) +
                                parseFloat(booking.triply_service_fee || "0") +
                                parseFloat(booking.protection_plan_price || "0")
                            )}
                          </span>
                          {booking.protection_plan && (
                            <span title="Parking Protection opt-in">
                              <ShieldCheck size={14} className="text-emerald-600" />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <StatusBadge status={booking.status} />
                      </td>
                      <td
                        className="px-6 py-4 whitespace-nowrap text-sm text-gray-600"
                        title={
                          booking.attribution?.first?.cmp
                            ? `Campaign: ${booking.attribution.first.cmp}`
                            : undefined
                        }
                      >
                        {sourceLabel(booking)}
                        {booking.airport_code && booking.airport_code !== "RESLAB" && (
                          <span className="ml-1 text-xs text-gray-400">· {booking.airport_code}</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <button
                          onClick={() => { setSelectedBooking(booking); setCancelResult(null); setCancelReason(""); setCancelNote(""); }}
                          className="text-brand-orange hover:text-orange-600 p-1"
                          title="View Details"
                        >
                          <Eye size={18} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="px-4 sm:px-6 py-4 border-t border-gray-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-sm text-gray-600">
                Showing {((pagination.page - 1) * pagination.limit) + 1} to{" "}
                {Math.min(pagination.page * pagination.limit, pagination.total)} of{" "}
                {pagination.total} bookings
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handlePageChange(pagination.page - 1)}
                  disabled={pagination.page === 1}
                  className="p-2 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft size={18} />
                </button>
                <span className="text-sm text-gray-600">
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <button
                  onClick={() => handlePageChange(pagination.page + 1)}
                  disabled={pagination.page === pagination.totalPages}
                  className="p-2 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Booking Detail Modal */}
      {selectedBooking && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">
                Booking Details
              </h2>
              <button
                onClick={() => { setSelectedBooking(null); setCancelResult(null); }}
                className="text-gray-400 hover:text-gray-600"
              >
                &times;
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Confirmation */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Confirmation Number</p>
                  <p className="text-xl font-mono font-bold text-brand-orange">
                    {selectedBooking.reslab_reservation_number}
                  </p>
                </div>
                <StatusBadge status={selectedBooking.status} />
              </div>

              {/* Customer Info */}
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">Customer</h3>
                <div className="bg-gray-50 rounded-lg p-4 space-y-1">
                  <p>
                    <span className="text-gray-500">Name:</span>{" "}
                    {selectedBooking.customers?.first_name} {selectedBooking.customers?.last_name}
                  </p>
                  <p>
                    <span className="text-gray-500">Email:</span>{" "}
                    {selectedBooking.customers?.email}
                  </p>
                  <p>
                    <span className="text-gray-500">Phone:</span>{" "}
                    {selectedBooking.customers?.phone}
                  </p>
                </div>
              </div>

              {/* Booking Info */}
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">Reservation</h3>
                <div className="bg-gray-50 rounded-lg p-4 space-y-1">
                  <p>
                    <span className="text-gray-500">Location:</span>{" "}
                    {selectedBooking.location_name}
                  </p>
                  <p>
                    <span className="text-gray-500">Check-in:</span>{" "}
                    {formatDateTime(selectedBooking.check_in)}
                  </p>
                  <p>
                    <span className="text-gray-500">Check-out:</span>{" "}
                    {formatDateTime(selectedBooking.check_out)}
                  </p>
                </div>
              </div>

              {/* Payment Breakdown */}
              {(() => {
                const subtotal = parseFloat(selectedBooking.subtotal || "0");
                const fees = parseFloat(selectedBooking.fees_total || "0");
                const taxes = parseFloat(selectedBooking.tax_total || "0");
                const serviceFee = parseFloat(selectedBooking.triply_service_fee || "0");
                const protectionPremium = parseFloat(
                  selectedBooking.protection_plan_price || "0"
                );
                const dueAtLocation = parseFloat(selectedBooking.due_at_location || "0");
                // Promo (migration 016). discount_amount is the dollars taken off
                // the subtotal, already reflected in the Stripe charge.
                const discountAmount = parseFloat(selectedBooking.discount_amount || "0");
                const promoCode = selectedBooking.promo_code || null;
                const bookingTotal =
                  parseFloat(selectedBooking.grand_total) +
                  serviceFee +
                  protectionPremium;
                // Subtract the discount so "Paid online" matches the actual Stripe
                // charge — grand_total is the pre-discount ResLab parking total.
                const paidOnline = Math.max(
                  0,
                  bookingTotal - dueAtLocation - discountAmount
                );

                return (
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">Payment Breakdown</h3>
                    <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-500">Subtotal (to location)</span>
                        <span>{formatPrice(subtotal)}</span>
                      </div>
                      {fees > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-500">Fees</span>
                          <span>{formatPrice(fees)}</span>
                        </div>
                      )}
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-500">Taxes</span>
                        <span>{formatPrice(taxes)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-500">Triply service fee</span>
                        <span className="text-green-600 font-medium">
                          {formatPrice(serviceFee)}
                        </span>
                      </div>
                      {protectionPremium > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-500">Parking Protection premium</span>
                          <span>{formatPrice(protectionPremium)}</span>
                        </div>
                      )}
                      <div className="border-t border-gray-200 pt-2 mt-2 flex justify-between font-semibold">
                        <span>Booking total</span>
                        <span>{formatPrice(bookingTotal)}</span>
                      </div>
                      {discountAmount > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-500">
                            Promo discount
                            {promoCode && (
                              <span className="ml-1.5 inline-block rounded bg-purple-100 px-1.5 py-0.5 text-xs font-semibold text-purple-700 align-middle">
                                {promoCode}
                              </span>
                            )}
                          </span>
                          <span className="text-purple-700 font-medium">
                            −{formatPrice(discountAmount)}
                          </span>
                        </div>
                      )}
                      <div className="border-t border-gray-200 pt-2 mt-2 flex justify-between text-sm">
                        <span className="text-gray-500">Paid online</span>
                        <span className="font-medium">{formatPrice(paidOnline)}</span>
                      </div>
                      {dueAtLocation > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-500">Due at location</span>
                          <span className="text-amber-700 font-medium">
                            {formatPrice(dueAtLocation)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Parking Protection */}
              {selectedBooking.protection_plan && (
                <div>
                  <h3 className="font-semibold text-gray-900 mb-2">Parking Protection</h3>
                  <div className="bg-gray-50 rounded-lg p-4 space-y-1">
                    <p>
                      <span className="text-gray-500">Plan:</span>{" "}
                      {selectedBooking.protection_plan}
                    </p>
                    <p>
                      <span className="text-gray-500">Premium:</span>{" "}
                      {selectedBooking.protection_plan_price != null ? (
                        formatPrice(parseFloat(selectedBooking.protection_plan_price))
                      ) : (
                        <span className="text-amber-700 text-sm font-medium">
                          Price not recorded
                        </span>
                      )}
                    </p>
                    <p>
                      <span className="text-gray-500">Park Guard ID:</span>{" "}
                      {selectedBooking.pg_identifier ? (
                        <span className="font-mono text-sm">{selectedBooking.pg_identifier}</span>
                      ) : selectedBooking.pg_sync_status === "skipped_missing_data" ? (
                        <span className="text-red-700 text-sm font-medium">
                          Permanently skipped — required address fields were missing on the lot record at booking time. Fix the lot data in ResLab and manually add this booking to the Coverage Hub.
                        </span>
                      ) : selectedBooking.pg_sync_status === "synced" ? (
                        // pg_identifier was cleared by the webhook partial-refund branch
                        // after PG was successfully cancelled. Do NOT re-enroll via the
                        // resync script — PG already has this as cancelled and a new
                        // capture would create a duplicate they'd bill us for.
                        <span className="text-gray-700 text-sm font-medium">
                          Cancelled with Park Guard via Stripe refund webhook. Do not re-enroll.
                        </span>
                      ) : (
                        <span className="text-amber-700 text-sm font-medium">
                          Not confirmed with Park Guard. If more than a few minutes old, check Sentry — reconciliation retries transient failures.
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              )}

              {/* Vehicle Info */}
              {selectedBooking.vehicle_info && (
                <div>
                  <h3 className="font-semibold text-gray-900 mb-2">Vehicle</h3>
                  <div className="bg-gray-50 rounded-lg p-4 space-y-1">
                    <p>
                      <span className="text-gray-500">Vehicle:</span>{" "}
                      {selectedBooking.vehicle_info.make} {selectedBooking.vehicle_info.model}
                    </p>
                    <p>
                      <span className="text-gray-500">Color:</span>{" "}
                      {selectedBooking.vehicle_info.color}
                    </p>
                    <p>
                      <span className="text-gray-500">License Plate:</span>{" "}
                      {selectedBooking.vehicle_info.licensePlate} ({selectedBooking.vehicle_info.state})
                    </p>
                  </div>
                </div>
              )}

              {/* Recorded cancellation reason (migration 032) */}
              {(selectedBooking.status === "cancelled" || selectedBooking.status === "refunded") && (
                <div className="p-3 rounded-lg text-sm bg-gray-50 text-gray-700">
                  <span className="font-medium">Cancellation reason:</span>{" "}
                  {CANCELLATION_REASON_LABELS[selectedBooking.cancellation_reason ?? "unknown"]}
                  {selectedBooking.cancelled_by && (
                    <span className="text-gray-500"> · by {selectedBooking.cancelled_by}</span>
                  )}
                  {selectedBooking.cancellation_note && (
                    <p className="mt-1 text-gray-600 whitespace-pre-wrap">{selectedBooking.cancellation_note}</p>
                  )}
                </div>
              )}

              {/* Cancel reason — required before either cancel button works */}
              {selectedBooking.status === "confirmed" && (
                <div className="space-y-2">
                  <label htmlFor="admin-cancel-reason" className="block text-sm font-medium text-gray-700">
                    Cancellation reason <span className="text-red-600">*</span>
                  </label>
                  <select
                    id="admin-cancel-reason"
                    value={cancelReason}
                    onChange={(e) => {
                      const parsed = adminReasonSchema.safeParse(e.target.value);
                      setCancelReason(parsed.success ? parsed.data : "");
                    }}
                    disabled={cancelling}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                  >
                    <option value="">Select a reason…</option>
                    {ADMIN_CANCELLATION_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {CANCELLATION_REASON_LABELS[r]}
                      </option>
                    ))}
                  </select>
                  <textarea
                    value={cancelNote}
                    onChange={(e) => setCancelNote(e.target.value)}
                    maxLength={500}
                    rows={2}
                    disabled={cancelling}
                    placeholder="Note (optional, staff only — stored apart from the booking, not readable by the customer)"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                </div>
              )}

              {/* Cancel Result */}
              {cancelResult && (
                <>
                  <div className={`p-3 rounded-lg text-sm ${cancelResult.success ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
                    {cancelResult.message}
                  </div>
                  {cancelResult.parkGuardSyncFailed && (
                    <div className="mt-2 p-3 rounded-lg text-sm bg-amber-50 text-amber-900 border border-amber-200">
                      <strong>Park Guard sync pending —</strong> the cancellation refund went through, but Park Guard wasn&apos;t notified. Manually mark the reservation cancelled in the Coverage Hub or check Sentry for details.
                    </div>
                  )}
                  {(cancelResult.reasonNotRecorded || cancelResult.noteNotRecorded) && (
                    <div className="mt-2 p-3 rounded-lg text-sm bg-amber-50 text-amber-900 border border-amber-200">
                      <strong>
                        {cancelResult.reasonNotRecorded ? "Cancellation reason" : "Admin note"} not saved —
                      </strong>{" "}
                      the cancellation itself went through, but the{" "}
                      {cancelResult.reasonNotRecorded && cancelResult.noteNotRecorded
                        ? "reason and note were"
                        : cancelResult.reasonNotRecorded
                        ? "reason was"
                        : "note was"}{" "}
                      not written to the database (check Sentry; if migration 032 isn&apos;t applied, apply it).
                      {cancelResult.noteNotRecorded && cancelNote.trim() && (
                        <>
                          {" "}Your note, so it isn&apos;t lost:
                          <p className="mt-1 whitespace-pre-wrap font-mono text-xs">{cancelNote.trim()}</p>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Actions */}
              <div className="flex flex-wrap gap-3 pt-4 border-t border-gray-200">
                <Link
                  href={`/confirmation/${selectedBooking.reslab_reservation_number}`}
                  target="_blank"
                  className="flex-1 text-center px-4 py-2 bg-brand-orange text-white rounded-lg hover:bg-orange-600 transition-colors"
                >
                  View Confirmation Page
                </Link>
                {selectedBooking.status === "confirmed" && (
                  <>
                    {/* Standard cancel: refunds the customer but RETAINS the
                        Triply service fee + the per-row Park Guard wholesale
                        (a partial protection refund on PG bookings). */}
                    <button
                      onClick={() => handleCancelBooking(selectedBooking, false)}
                      disabled={cancelling || !cancelReason}
                      title={`Refunds parking; keeps the Triply service fee and, on Park Guard bookings, its non-refundable wholesale (${PG_WHOLESALE_SHORT_SUMMARY} by plan)`}
                      className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                    >
                      {cancelling && cancellingMode === "standard" ? "Cancelling..." : "Cancel & Refund"}
                    </button>
                    {/* Full refund: also returns the Triply service fee AND the
                        full Park Guard premium. Use when the lot turned the
                        customer away and Triply eats its fee + the PG wholesale. */}
                    <button
                      onClick={() => handleCancelBooking(selectedBooking, true)}
                      disabled={cancelling || !cancelReason}
                      title="Refunds everything incl. the Triply service fee and the full Park Guard premium — use when the lot turned the customer away"
                      className="px-4 py-2 bg-red-800 text-white rounded-lg hover:bg-red-900 transition-colors disabled:opacity-50"
                    >
                      {cancelling && cancellingMode === "full" ? "Refunding..." : "Cancel & Full Refund"}
                    </button>
                  </>
                )}
                <button
                  onClick={() => { setSelectedBooking(null); setCancelResult(null); }}
                  className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
