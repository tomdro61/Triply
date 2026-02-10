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
} from "lucide-react";
import { formatDate, formatDateTime, formatPrice } from "@/lib/utils";

interface Booking {
  id: string;
  reslab_reservation_number: string;
  reslab_location_id: number;
  location_name: string;
  check_in: string;
  check_out: string;
  grand_total: string;
  status: string;
  vehicle_info: {
    make: string;
    model: string;
    color: string;
    licensePlate: string;
    state: string;
  };
  created_at: string;
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
  const [status, setStatus] = useState("all");
  const [dateRange, setDateRange] = useState("all");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [showCustomDatePicker, setShowCustomDatePicker] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);

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
    } catch (error) {
      console.error("Failed to fetch bookings:", error);
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
      "Total",
      "Status",
      "Created",
    ];

    const rows = bookings.map((b) => [
      b.reslab_reservation_number,
      `${b.customers?.first_name} ${b.customers?.last_name}`,
      b.customers?.email,
      b.customers?.phone,
      b.location_name,
      formatDateTime(b.check_in),
      formatDateTime(b.check_out),
      b.grand_total,
      b.status,
      formatDateTime(b.created_at),
    ]);

    const csv = [headers, ...rows].map((row) => row.join(",")).join("\n");
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
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <div className="flex flex-wrap items-center gap-4">
          <form onSubmit={handleSearch} className="flex-1 min-w-[200px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by confirmation # or location..."
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
            <div className="flex items-center gap-2">
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
                        <span className="font-semibold text-gray-900">
                          {formatPrice(parseFloat(booking.grand_total))}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <StatusBadge status={booking.status} />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <button
                          onClick={() => setSelectedBooking(booking)}
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
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
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
                onClick={() => setSelectedBooking(null)}
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
                  <p>
                    <span className="text-gray-500">Total:</span>{" "}
                    <span className="font-semibold">
                      {formatPrice(parseFloat(selectedBooking.grand_total))}
                    </span>
                  </p>
                </div>
              </div>

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

              {/* Actions */}
              <div className="flex gap-3 pt-4 border-t border-gray-200">
                <Link
                  href={`/confirmation/${selectedBooking.reslab_reservation_number}`}
                  target="_blank"
                  className="flex-1 text-center px-4 py-2 bg-brand-orange text-white rounded-lg hover:bg-orange-600 transition-colors"
                >
                  View Confirmation Page
                </Link>
                <button
                  onClick={() => setSelectedBooking(null)}
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
