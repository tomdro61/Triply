"use client";

import { useEffect, useState } from "react";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Calendar,
  X,
  MessageCircle,
  User,
  Bot,
  Shield,
} from "lucide-react";
import { formatDateTime } from "@/lib/utils";

interface ChatSession {
  id: string;
  session_id: string;
  user_id: string | null;
  user_email: string | null;
  ip_address: string;
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
}

interface ChatMessage {
  role: string;
  content?: string;
  parts?: { type: string; text?: string }[];
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface Stats {
  total: number;
  today: number;
  authenticated: number;
}

function getMessageText(msg: ChatMessage): string {
  // Handle AI SDK v6 UIMessage format (parts array)
  if (msg.parts) {
    return msg.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join(" ");
  }
  // Handle simple { role, content } format
  if (typeof msg.content === "string") return msg.content;
  return "";
}

function getFirstUserMessage(messages: ChatMessage[]): string {
  const userMsg = messages.find((m) => m.role === "user");
  if (!userMsg) return "—";
  const text = getMessageText(userMsg);
  return text.length > 60 ? text.slice(0, 60) + "..." : text || "—";
}

function countMessages(messages: ChatMessage[]): number {
  return messages.filter((m) => m.role === "user" || m.role === "assistant").length;
}

export default function AdminChatsPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, today: 0, authenticated: 0 });
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState("all");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [showCustomDatePicker, setShowCustomDatePicker] = useState(false);
  const [selectedSession, setSelectedSession] = useState<ChatSession | null>(null);

  async function fetchSessions(page = 1) {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: "20",
      });

      if (search) {
        params.set("search", search);
      }

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

      const res = await fetch(`/api/admin/chats?${params}`);
      const data = await res.json();

      setSessions(data.sessions || []);
      setStats(data.stats || { total: 0, today: 0, authenticated: 0 });
      setPagination(data.pagination);
    } catch (error) {
      console.error("Failed to fetch chat sessions:", error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSessions(1);
  }, [dateRange, customStartDate, customEndDate]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchSessions(1);
  };

  const handlePageChange = (newPage: number) => {
    fetchSessions(newPage);
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Chat Sessions</h1>
        <p className="text-gray-600">Review AI chat conversations</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
              <MessageCircle size={20} className="text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
              <p className="text-sm text-gray-500">Total Sessions</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
              <Calendar size={20} className="text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.today}</p>
              <p className="text-sm text-gray-500">Today</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
              <Shield size={20} className="text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.authenticated}</p>
              <p className="text-sm text-gray-500">Authenticated Users</p>
            </div>
          </div>
        </div>
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
                placeholder="Search by session ID or IP..."
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
              />
            </div>
          </form>

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
        </div>
      </div>

      {/* Sessions Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-brand-orange" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No chat sessions found
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Date
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      User
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Messages
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Preview
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {sessions.map((session) => (
                    <tr
                      key={session.id}
                      className="hover:bg-gray-50 cursor-pointer"
                      onClick={() => setSelectedSession(session)}
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <p className="text-sm text-gray-900">
                          {formatDateTime(session.updated_at)}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {session.ip_address}
                        </p>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {session.user_email ? (
                          <div>
                            <p className="text-sm font-medium text-gray-900">
                              {session.user_email}
                            </p>
                            <p className="text-xs text-green-600">Authenticated</p>
                          </div>
                        ) : (
                          <span className="text-sm text-gray-400">Anonymous</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 text-sm text-gray-700">
                          <MessageCircle size={14} className="text-gray-400" />
                          {countMessages(session.messages || [])}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <p className="text-sm text-gray-600 truncate max-w-[300px]">
                          {getFirstUserMessage(session.messages || [])}
                        </p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
              <p className="text-sm text-gray-600">
                Showing {(pagination.page - 1) * pagination.limit + 1} to{" "}
                {Math.min(pagination.page * pagination.limit, pagination.total)} of{" "}
                {pagination.total} sessions
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

      {/* Conversation Modal */}
      {selectedSession && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  Chat Conversation
                </h2>
                <p className="text-sm text-gray-500">
                  {formatDateTime(selectedSession.created_at)}
                  {selectedSession.user_email && (
                    <span> &middot; {selectedSession.user_email}</span>
                  )}
                </p>
              </div>
              <button
                onClick={() => setSelectedSession(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                &times;
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {(selectedSession.messages || [])
                .filter((msg) => msg.role === "user" || msg.role === "assistant")
                .map((msg, index) => {
                  const isUser = msg.role === "user";
                  const text = getMessageText(msg);
                  if (!text) return null;

                  return (
                    <div
                      key={index}
                      className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}
                    >
                      <div
                        className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                          isUser
                            ? "bg-brand-orange text-white"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {isUser ? <User size={16} /> : <Bot size={16} />}
                      </div>
                      <div
                        className={`max-w-[75%] px-4 py-3 rounded-xl text-sm leading-relaxed ${
                          isUser
                            ? "bg-brand-orange text-white rounded-tr-sm"
                            : "bg-gray-100 text-gray-800 rounded-tl-sm"
                        }`}
                      >
                        {text.split("\n").map((line, i) => (
                          <p key={i} className={i > 0 ? "mt-1" : ""}>
                            {line}
                          </p>
                        ))}
                      </div>
                    </div>
                  );
                })}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between flex-shrink-0">
              <p className="text-xs text-gray-400">
                Session: {selectedSession.session_id.slice(0, 8)}...
                {" "}&middot;{" "}IP: {selectedSession.ip_address}
              </p>
              <button
                onClick={() => setSelectedSession(null)}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
