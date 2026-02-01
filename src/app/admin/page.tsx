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
} from "lucide-react";

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
    total: number;
    today: number;
    thisWeek: number;
    thisMonth: number;
  };
}

interface Booking {
  id: string;
  reslab_reservation_number: string;
  location_name: string;
  check_in: string;
  check_out: string;
  grand_total: string;
  status: string;
  created_at: string;
  customers: {
    email: string;
    first_name: string;
    last_name: string;
  };
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
        <div className="flex items-center gap-3">
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
            <div className="flex items-center gap-2">
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
          title="Total Revenue"
          value={formatCurrency(stats?.revenue.total || 0)}
          subValue={`${formatCurrency(stats?.revenue.thisMonth || 0)} this month`}
          icon={DollarSign}
          color="green"
        />
        <StatCard
          title="Today's Bookings"
          value={stats?.bookings.today || 0}
          subValue={`${formatCurrency(stats?.revenue.today || 0)} revenue`}
          icon={Calendar}
          color="blue"
        />
        <StatCard
          title="This Week"
          value={stats?.bookings.thisWeek || 0}
          subValue={`${formatCurrency(stats?.revenue.thisWeek || 0)} revenue`}
          icon={TrendingUp}
          color="purple"
        />
      </div>

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
                {formatCurrency(stats?.revenue.today || 0)}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">This Week</p>
              <p className="text-lg font-semibold text-gray-900">
                {formatCurrency(stats?.revenue.thisWeek || 0)}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">This Month</p>
              <p className="text-lg font-semibold text-gray-900">
                {formatCurrency(stats?.revenue.thisMonth || 0)}
              </p>
            </div>
          </div>
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
          <div className="overflow-x-auto">
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
                        {formatDate(booking.check_in)} - {formatDate(booking.check_out)}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="font-semibold text-gray-900">
                        {formatCurrency(parseFloat(booking.grand_total))}
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
        )}
      </div>
    </div>
  );
}
