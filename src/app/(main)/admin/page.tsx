"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Ticket,
  DollarSign,
  TrendingUp,
  Calendar,
  ArrowRight,
  Loader2,
  MapPin,
  Clock,
  X,
  Calculator,
} from "lucide-react";
import { formatDate, formatPrice } from "@/lib/utils";
import { PROTECTION_PLANS, PROTECTION_PLAN_CODES } from "@/lib/parkguard/plans";

interface Stats {
  bookings: {
    total: number;
    today: number;
    thisWeek: number;
    thisMonth: number;
    confirmed: number;
    cancelled: number;
  };
  revenue: {
    gross: {
      total: number;
      today: number;
      thisWeek: number;
      thisMonth: number;
    };
    triply: {
      total: number;
      today: number;
      thisWeek: number;
      thisMonth: number;
    };
  };
  parkGuard: {
    count: { total: number; today: number; thisWeek: number; thisMonth: number };
    confirmedTotal: { total: number; today: number; thisWeek: number; thisMonth: number };
    conversionRate: { total: number; today: number; thisWeek: number; thisMonth: number };
    revenue: { total: number; today: number; thisWeek: number; thisMonth: number };
    cost: { total: number; today: number; thisWeek: number; thisMonth: number };
    margin: { total: number; today: number; thisWeek: number; thisMonth: number };
  };
  attribution?: {
    byChannel: Array<{ key: string; bookings: number; gross: number; triply: number; protected: number }>;
    byAirport: Array<{ key: string; bookings: number; gross: number; triply: number; protected: number }>;
    byAirportTotal: number;
    byPromo: Array<{
      code: string;
      bookings: number;
      discount: number;
      gross: number;
      triply: number;
      currentUses: number | null;
      maxUses: number | null;
      active: boolean | null;
      discountPercent: number | null;
      expired: boolean;
    }> | null;
    presentRate7d: number | null;
    invalidRate7d: number | null;
    recentBookings7d: number | null;
    warnings: string[];
  } | null;
  attributionWarnings?: string[];
}

interface Booking {
  id: string;
  reslab_reservation_number: string;
  location_name: string;
  check_in: string;
  check_out: string;
  grand_total: string;
  triply_service_fee: string | null;
  protection_plan_price: string | null;
  status: string;
  created_at: string;
  customers: {
    email: string;
    first_name: string;
    last_name: string;
  };
}

function formatTime(dateString: string): string {
  return new Date(dateString).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function StatCard({
  title,
  value,
  subValue,
  icon: Icon,
  color,
}: {
  title: string;
  value: string | number;
  subValue?: string;
  icon: React.ElementType;
  color: "orange" | "green" | "blue" | "purple";
}) {
  const colorClasses = {
    orange: "bg-orange-100 text-orange-600",
    green: "bg-green-100 text-green-600",
    blue: "bg-blue-100 text-blue-600",
    purple: "bg-purple-100 text-purple-600",
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-medium text-gray-500">{title}</span>
        <div className={`p-2 rounded-lg ${colorClasses[color]}`}>
          <Icon size={20} />
        </div>
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {subValue && (
        <p className="text-sm text-gray-500 mt-1">{subValue}</p>
      )}
    </div>
  );
}

function BreakdownTable({
  rows,
  moneyHeader,
  emptyText,
  total: totalProp,
}: {
  rows: Array<{ label: string; bookings: number; money: number }>;
  moneyHeader: string;
  emptyText: string;
  /** Denominator for Share. Pass it when rows are truncated server-side so the
   *  column is a share of ALL bookings, not of the displayed rows. */
  total?: number;
}) {
  if (rows.length === 0) return <p className="text-sm text-gray-500">{emptyText}</p>;
  const total = totalProp ?? rows.reduce((n, r) => n + r.bookings, 0);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-gray-500 uppercase">
          <th className="pb-2">&nbsp;</th>
          <th className="pb-2 text-right">Bookings</th>
          <th className="pb-2 text-right">Share</th>
          <th className="pb-2 text-right">{moneyHeader}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-t border-gray-100">
            {/* Text only — labels can originate from visitor-typed values. */}
            <td className="py-1.5 text-gray-700">{r.label}</td>
            <td className="py-1.5 text-right">{r.bookings}</td>
            <td className="py-1.5 text-right text-gray-500">
              {total === 0 ? "—" : `${Math.round((r.bookings / total) * 100)}%`}
            </td>
            <td className="py-1.5 text-right">{formatPrice(r.money)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusBadge({ status }: { status: string }) {
  const statusStyles: Record<string, string> = {
    confirmed: "bg-green-100 text-green-800",
    cancelled: "bg-red-100 text-red-800",
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

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentBookings, setRecentBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState("all");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [showCustomDatePicker, setShowCustomDatePicker] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        const params = new URLSearchParams();
        const bookingParams = new URLSearchParams({ limit: "5" });

        // Date range filtering
        if (dateRange !== "all") {
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          if (dateRange === "today") {
            params.set("startDate", today.toISOString());
            bookingParams.set("startDate", today.toISOString());
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            params.set("endDate", tomorrow.toISOString());
            bookingParams.set("endDate", tomorrow.toISOString());
          } else if (dateRange === "week") {
            const weekStart = new Date(today);
            weekStart.setDate(weekStart.getDate() - weekStart.getDay());
            params.set("startDate", weekStart.toISOString());
            bookingParams.set("startDate", weekStart.toISOString());
          } else if (dateRange === "month") {
            const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
            params.set("startDate", monthStart.toISOString());
            bookingParams.set("startDate", monthStart.toISOString());
          } else if (dateRange === "custom" && customStartDate) {
            params.set("startDate", new Date(customStartDate).toISOString());
            bookingParams.set("startDate", new Date(customStartDate).toISOString());
            if (customEndDate) {
              const endDate = new Date(customEndDate);
              endDate.setDate(endDate.getDate() + 1);
              params.set("endDate", endDate.toISOString());
              bookingParams.set("endDate", endDate.toISOString());
            }
          }
        }

        const [statsRes, bookingsRes] = await Promise.all([
          fetch(`/api/admin/stats?${params}`),
          fetch(`/api/admin/bookings?${bookingParams}`),
        ]);

        const statsData = await statsRes.json();
        const bookingsData = await bookingsRes.json();

        setStats(statsData);
        setRecentBookings(bookingsData.bookings || []);
      } catch (error) {
        console.error("Failed to fetch admin data:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [dateRange, customStartDate, customEndDate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-brand-orange" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-600">Overview of your parking business</p>
        </div>

        {/* Date Filter */}
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/admin/accounting"
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Calculator size={16} />
            Accounting
          </Link>
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
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none bg-white text-sm"
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
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none bg-white text-sm"
              />
              <span className="text-gray-400 text-sm">to</span>
              <input
                type="date"
                value={customEndDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none bg-white text-sm"
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
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatCard
          title="Total Bookings"
          value={stats?.bookings.total || 0}
          subValue={`${stats?.bookings.thisMonth || 0} this month`}
          icon={Ticket}
          color="orange"
        />
        <StatCard
          title="Gross Revenue"
          value={formatPrice(stats?.revenue.gross.total || 0)}
          subValue={`Triply: ${formatPrice(stats?.revenue.triply.total || 0)}`}
          icon={DollarSign}
          color="green"
        />
        <StatCard
          title="Today's Bookings"
          value={stats?.bookings.today || 0}
          subValue={`${formatPrice(stats?.revenue.gross.today || 0)} gross`}
          icon={Calendar}
          color="blue"
        />
        <StatCard
          title="This Week"
          value={stats?.bookings.thisWeek || 0}
          subValue={`${formatPrice(stats?.revenue.gross.thisWeek || 0)} gross`}
          icon={TrendingUp}
          color="purple"
        />
      </div>

      {/* Attribution — where bookings come from (migration 023) */}
      {stats && !stats.attribution && (
        <div className="mb-8 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Attribution breakdowns unavailable
          {stats.attributionWarnings?.length ? ` (${stats.attributionWarnings.join("; ")})` : ""} — the
          booking counts above are unaffected. Check Sentry.
        </div>
      )}
      {stats?.attribution && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-baseline justify-between mb-4">
              <h3 className="font-semibold text-gray-900">Bookings by channel</h3>
              <span
                className={`text-xs ${
                  (stats.attribution.invalidRate7d ?? 0) > 0 ? "text-red-600 font-medium" : "text-gray-500"
                }`}
                title="Last 7 days, independent of the date filter. Captured = bookings whose attribution cookie parsed. Invalid = cookie present but unreadable — a bug. A drop in captured or any invalid means capture broke."
              >
                captured (7d):{" "}
                {stats.attribution.presentRate7d === null
                  ? "unavailable"
                  : `${Math.round(stats.attribution.presentRate7d * 100)}%`}
                {(stats.attribution.invalidRate7d ?? 0) > 0 &&
                  ` · invalid ${Math.round((stats.attribution.invalidRate7d ?? 0) * 100)}%`}
              </span>
            </div>
            <BreakdownTable
              rows={stats.attribution.byChannel.map((r) => ({
                label: r.key.replace(/_/g, " "),
                bookings: r.bookings,
                money: r.gross,
              }))}
              moneyHeader="Gross"
              emptyText="No bookings in range"
            />
            <p className="mt-3 text-xs text-gray-400">
              &ldquo;unknown&rdquo; = booked before capture existed or with no cookie; &ldquo;invalid&rdquo; = cookie
              present but unreadable (a bug — check Sentry).
            </p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="font-semibold text-gray-900 mb-4">Top airports</h3>
            <BreakdownTable
              rows={stats.attribution.byAirport.map((r) => ({
                label: r.key,
                bookings: r.bookings,
                money: r.gross,
              }))}
              total={stats.attribution.byAirportTotal}
              moneyHeader="Gross"
              emptyText="No bookings in range"
            />
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="font-semibold text-gray-900 mb-4">Promo codes</h3>
            {stats.attribution.byPromo === null ? (
              <p className="text-sm text-amber-700">Promo data unavailable — check Sentry.</p>
            ) : stats.attribution.byPromo.length === 0 ? (
              <p className="text-sm text-gray-500">No promo activity in range</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase">
                    <th className="pb-2">Code</th>
                    <th className="pb-2 text-right">Bookings</th>
                    <th className="pb-2 text-right">Discount</th>
                    <th className="pb-2 text-right" title="promo_codes.current_uses (DB counter) — should track Bookings from the deploy of the trigger onward">
                      Uses
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stats.attribution.byPromo.map((p) => (
                    <tr key={p.code} className="border-t border-gray-100">
                      <td className="py-1.5 font-mono">
                        {p.code}
                        {p.discountPercent !== null && (
                          <span className="ml-1 text-xs text-gray-400">{p.discountPercent}%</span>
                        )}
                        {p.active === false && (
                          <span className="ml-1 text-xs text-red-500">inactive</span>
                        )}
                        {p.expired && p.active && (
                          <span className="ml-1 text-xs text-amber-600">expired</span>
                        )}
                      </td>
                      <td className="py-1.5 text-right">{p.bookings}</td>
                      <td className="py-1.5 text-right">{formatPrice(p.discount)}</td>
                      <td
                        className={`py-1.5 text-right ${
                          // The DB counter only increments from the trigger's deploy
                          // onward, so a lag behind the derived count is expected
                          // for older bookings — but a counter that is LOWER than the
                          // bookings made since then means the trigger's UPDATE is
                          // matching 0 rows (casing mismatch / deleted code).
                          p.currentUses !== null && p.currentUses < p.bookings ? "text-amber-600" : "text-gray-500"
                        }`}
                        title={
                          p.currentUses !== null && p.currentUses < p.bookings
                            ? "DB counter is behind the derived booking count — expected for bookings before the counter trigger shipped; otherwise the trigger's UPDATE may be matching 0 rows."
                            : undefined
                        }
                      >
                        {p.currentUses ?? "—"}
                        {p.maxUses !== null && <span className="text-gray-400">/{p.maxUses}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-3 text-xs text-gray-400">
              Margin per code lives on the Accounting page (this view does not model ResLab settlement).
            </p>
          </div>
        </div>
      )}

      {/* Booking Status */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="font-semibold text-gray-900 mb-4">Booking Status</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-gray-600">Confirmed</span>
              <span className="font-semibold text-green-600">
                {stats?.bookings.confirmed || 0}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-600">Cancelled</span>
              <span className="font-semibold text-red-600">
                {stats?.bookings.cancelled || 0}
              </span>
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="font-semibold text-gray-900 mb-4">Revenue Summary</h3>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-gray-500">Today</p>
              <p className="text-lg font-semibold text-gray-900">
                {formatPrice(stats?.revenue.gross.today || 0)}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Triply: {formatPrice(stats?.revenue.triply.today || 0)}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">This Week</p>
              <p className="text-lg font-semibold text-gray-900">
                {formatPrice(stats?.revenue.gross.thisWeek || 0)}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Triply: {formatPrice(stats?.revenue.triply.thisWeek || 0)}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">This Month</p>
              <p className="text-lg font-semibold text-gray-900">
                {formatPrice(stats?.revenue.gross.thisMonth || 0)}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Triply: {formatPrice(stats?.revenue.triply.thisMonth || 0)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Park Guard conversions */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-8">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">Park Guard Conversions</h3>
          <p className="text-xs text-gray-500">
            {/* Rendered from PROTECTION_PLANS so it can't drift from checkout.
                The Margin column below sums per-row price − wholesale, so
                historical bookings at a different price still report accurately. */}
            Current tiers:{" "}
            {PROTECTION_PLAN_CODES.map((code, i) => {
              const plan = PROTECTION_PLANS[code];
              return (
                <span key={code}>
                  {i > 0 ? " · " : ""}
                  {`Plan ${code} $${plan.price.toFixed(2)} − $${plan.wholesalePrice.toFixed(2)} = $${(plan.price - plan.wholesalePrice).toFixed(2)}`}
                </span>
              );
            })}
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {(["total", "today", "thisWeek", "thisMonth"] as const).map((window) => {
            const labels = {
              total: "All Time",
              today: "Today",
              thisWeek: "This Week",
              thisMonth: "This Month",
            };
            const count = stats?.parkGuard.count[window] ?? 0;
            const confirmed = stats?.parkGuard.confirmedTotal[window] ?? 0;
            const rate = stats?.parkGuard.conversionRate[window] ?? 0;
            const margin = stats?.parkGuard.margin[window] ?? 0;
            return (
              <div key={window} className="bg-gray-50 rounded-lg p-4">
                <p className="text-sm text-gray-500 mb-1">{labels[window]}</p>
                <p className="text-2xl font-bold text-gray-900">{count}</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {(rate * 100).toFixed(1)}% of {confirmed} confirmed
                </p>
                <div className="mt-3 pt-3 border-t border-gray-200">
                  <p className="text-xs text-gray-500">Triply margin</p>
                  <p className="text-lg font-semibold text-emerald-700">
                    {formatPrice(margin)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent Bookings */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">Recent Bookings</h3>
          <Link
            href="/admin/bookings"
            className="text-sm text-brand-orange hover:text-orange-600 flex items-center gap-1"
          >
            View All
            <ArrowRight size={16} />
          </Link>
        </div>

        {recentBookings.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No bookings yet
          </div>
        ) : (
          <>
            {/* Mobile card view */}
            <div className="md:hidden divide-y divide-gray-200">
              {recentBookings.map((booking) => (
                <div key={booking.id} className="p-4">
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <span className="font-mono text-sm text-brand-orange truncate">
                      {booking.reslab_reservation_number}
                    </span>
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
                    <span className="font-semibold text-gray-900 flex-shrink-0">
                      {formatPrice(
                        parseFloat(booking.grand_total) +
                          parseFloat(booking.triply_service_fee || "0") +
                          parseFloat(booking.protection_plan_price || "0")
                      )}
                    </span>
                  </div>
                </div>
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
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {recentBookings.map((booking) => (
                  <tr key={booking.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="font-mono text-sm text-brand-orange">
                        {booking.reslab_reservation_number}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {booking.customers?.first_name} {booking.customers?.last_name}
                        </p>
                        <p className="text-sm text-gray-500">
                          {booking.customers?.email}
                        </p>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1 text-sm text-gray-900">
                        <MapPin size={14} className="text-gray-400" />
                        {booking.location_name}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-1 text-sm text-gray-600">
                        <Clock size={14} className="text-gray-400" />
                        {formatDate(booking.check_in, { month: "short", day: "numeric", year: "numeric" })} - {formatDate(booking.check_out, { month: "short", day: "numeric", year: "numeric" })}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="font-semibold text-gray-900">
                        {formatPrice(
                        parseFloat(booking.grand_total) +
                          parseFloat(booking.triply_service_fee || "0") +
                          parseFloat(booking.protection_plan_price || "0")
                      )}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <StatusBadge status={booking.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
