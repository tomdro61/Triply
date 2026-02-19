"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  Ticket,
  LogOut,
  Loader2,
  ShieldAlert,
} from "lucide-react";

interface PartnerData {
  id: string;
  email: string;
  reslab_location_id: number;
  location_name: string;
  company_name: string | null;
}

export default function PartnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [partner, setPartner] = useState<PartnerData | null>(null);

  useEffect(() => {
    async function checkAuth() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/auth/login?redirect=/partner");
        return;
      }

      setUserEmail(user.email?.toLowerCase() || "");

      try {
        const res = await fetch("/api/partner/me");
        if (res.ok) {
          const data = await res.json();
          setPartner(data);
          setAuthorized(true);
        }
      } catch {
        // Not a partner
      }

      setLoading(false);
    }

    checkAuth();
  }, [router]);

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
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="bg-white rounded-xl shadow-lg p-8 max-w-md text-center">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <ShieldAlert className="h-8 w-8 text-red-600" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">
            Access Denied
          </h1>
          <p className="text-gray-600 mb-4">
            You don&apos;t have permission to access the partner dashboard.
          </p>
          <p className="text-sm text-gray-500 mb-6">
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

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Sidebar */}
      <aside className="fixed left-0 top-0 h-full w-64 bg-brand-navy text-white">
        <div className="p-6">
          <Link href="/partner" className="flex items-center gap-2">
            <span className="text-2xl font-bold text-brand-orange">Triply</span>
            <span className="text-xs bg-white/20 px-2 py-0.5 rounded">
              Partner
            </span>
          </Link>
        </div>

        <nav className="px-4 space-y-1">
          <Link
            href="/partner"
            className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-white/10 transition-colors"
          >
            <Ticket size={20} />
            Reservations
          </Link>
        </nav>

        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-white/10">
          <div className="px-4 py-2 mb-2">
            <p className="text-sm text-white/60">
              {partner?.location_name}
            </p>
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

      {/* Main Content */}
      <main className="ml-64 p-8">{children}</main>
    </div>
  );
}
