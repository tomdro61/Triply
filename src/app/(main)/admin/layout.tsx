"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/client";
import {
  LayoutDashboard,
  Ticket,
  MessageCircle,
  Users,
  LogOut,
  Loader2,
  ShieldAlert,
  Menu,
  X,
} from "lucide-react";
import { isAdminEmail } from "@/config/admin";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    async function checkAuth() {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        router.push("/auth/login?redirect=/admin");
        return;
      }

      const email = user.email?.toLowerCase() || "";
      setUserEmail(email);

      if (isAdminEmail(email)) {
        setAuthorized(true);
      }

      setLoading(false);
    }

    checkAuth();
  }, [router]);

  // Close the mobile drawer whenever the route changes so navigation taps
  // close the menu without the user having to tap-outside.
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  // TEMP: Sentry connectivity probe — fires once per browser session on first
  // admin page visit. Remove after confirming Sentry is receiving events.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("triply-sentry-probe-2026-05-05")) return;
    Sentry.captureMessage(
      `Sentry connectivity probe from admin layout @ ${new Date().toISOString()}`,
      "info"
    );
    sessionStorage.setItem("triply-sentry-probe-2026-05-05", "true");
  }, []);

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-orange" />
      </div>
    );
  }

  if (!authorized) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">
        <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <ShieldAlert className="h-8 w-8 text-red-600" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Access Denied</h1>
          <p className="text-gray-600 mb-4">
            You don't have permission to access the admin dashboard.
          </p>
          <p className="text-sm text-gray-500 mb-6 break-all">
            Signed in as: {userEmail}
          </p>
          <div className="flex gap-3 justify-center">
            <Link
              href="/"
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
            >
              Go Home
            </Link>
            <button
              onClick={handleSignOut}
              className="px-4 py-2 bg-brand-orange text-white rounded-lg hover:bg-orange-600 transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  const navLinks = [
    { href: "/admin", icon: LayoutDashboard, label: "Dashboard" },
    { href: "/admin/bookings", icon: Ticket, label: "Bookings" },
    { href: "/admin/chats", icon: MessageCircle, label: "Chat Sessions" },
    { href: "/admin/partners", icon: Users, label: "Partners" },
  ];

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Mobile top bar — visible below lg */}
      <header className="lg:hidden fixed top-0 left-0 right-0 h-16 bg-brand-dark text-white flex items-center justify-between px-4 z-30 shadow-md">
        <button
          onClick={() => setSidebarOpen(true)}
          aria-label="Open navigation menu"
          className="p-3 -ml-3 rounded-lg hover:bg-white/10 transition-colors"
        >
          <Menu size={24} />
        </button>
        <Link href="/admin" className="flex items-center gap-2">
          <span className="text-xl font-bold text-brand-orange">Triply</span>
          <span className="text-xs bg-white/20 px-2 py-0.5 rounded">Admin</span>
        </Link>
        {/* Spacer to keep brand centered */}
        <div className="w-12" aria-hidden="true" />
      </header>

      {/* Backdrop when drawer open on mobile */}
      {sidebarOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — fixed on lg, off-canvas drawer below lg */}
      <aside
        className={`fixed left-0 top-0 h-full w-64 bg-brand-dark text-white z-50 transform transition-transform duration-200 lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-6 flex items-center justify-between">
          <Link href="/admin" className="flex items-center gap-2">
            <span className="text-2xl font-bold text-brand-orange">Triply</span>
            <span className="text-xs bg-white/20 px-2 py-0.5 rounded">Admin</span>
          </Link>
          <button
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation menu"
            className="lg:hidden p-3 -mr-3 rounded-lg hover:bg-white/10 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="px-4 space-y-1">
          {navLinks.map(({ href, icon: Icon, label }) => {
            const isActive = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                  isActive
                    ? "bg-white/20 text-white"
                    : "text-white/80 hover:bg-white/10 hover:text-white"
                }`}
              >
                <Icon size={20} />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-white/10">
          <div className="px-4 py-2 mb-2">
            <p className="text-sm text-white/60">Signed in as</p>
            <p className="text-sm truncate">{userEmail}</p>
          </div>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 px-4 py-3 w-full rounded-lg hover:bg-white/10 transition-colors text-white/80 hover:text-white"
          >
            <LogOut size={20} />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content — pushed right on lg by the fixed sidebar; full-width
          on mobile with top padding to clear the mobile top bar. */}
      <main className="lg:ml-64 p-4 sm:p-6 lg:p-8 pt-20 lg:pt-8">
        {children}
      </main>
    </div>
  );
}
