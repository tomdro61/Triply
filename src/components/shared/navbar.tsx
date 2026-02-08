"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Menu, X, User, Plane, LogOut, ChevronDown, Ticket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import type { User as SupabaseUser } from "@supabase/supabase-js";

interface NavbarProps {
  forceSolid?: boolean;
}

export function Navbar({ forceSolid = false }: NavbarProps) {
  const router = useRouter();
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [user, setUser] = useState<SupabaseUser | null>(null);
  const [loading, setLoading] = useState(true);

  const supabase = createClient();

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    // Get initial user
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
      setLoading(false);
    };
    getUser();

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, [supabase.auth]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setIsUserMenuOpen(false);
    router.push("/");
    router.refresh();
  };

  const showSolid = isScrolled || forceSolid;

  const navLinks = [
    { label: "Find Parking", href: "/search" },
    { label: "Deals", href: "/deals" },
    { label: "Blog", href: "/blog" },
    { label: "FAQs", href: "/help" },
    { label: "Support", href: "/help" },
  ];

  const getUserDisplayName = () => {
    if (!user) return "";
    if (user.user_metadata?.full_name) return user.user_metadata.full_name;
    if (user.user_metadata?.name) return user.user_metadata.name;
    if (user.email) return user.email.split("@")[0];
    return "User";
  };

  const getUserInitial = () => {
    const name = getUserDisplayName();
    return name.charAt(0).toUpperCase();
  };

  return (
    <nav
      className={`fixed w-full z-50 transition-all duration-300 ${
        showSolid ? "bg-white shadow-md py-3" : "bg-transparent py-5"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center">
          {/* Left side: Hamburger + Logo */}
          <div className="flex items-center gap-4">
            {/* Hamburger Menu Button */}
            <div className="relative">
              <button
                onClick={() => {
                  setIsMobileMenuOpen(!isMobileMenuOpen);
                  setIsUserMenuOpen(false);
                }}
                className={`cursor-pointer ${showSolid ? "text-gray-900" : "text-white"}`}
              >
                {isMobileMenuOpen ? <X size={28} /> : <Menu size={28} />}
              </button>

              {/* Nav Dropdown */}
              {isMobileMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setIsMobileMenuOpen(false)}
                  />
                  <div className="absolute left-0 mt-4 w-48 bg-white rounded-lg shadow-lg border border-gray-100 py-2 z-20 animate-fade-in">
                    {navLinks.map((item) => (
                      <Link
                        key={item.label}
                        href={item.href}
                        className="block px-4 py-2.5 text-gray-700 font-medium hover:bg-gray-50 transition-colors"
                        onClick={() => setIsMobileMenuOpen(false)}
                      >
                        {item.label}
                      </Link>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Logo */}
            <Link href="/" className="flex items-center">
              <div className="bg-brand-orange text-white p-2 rounded-lg mr-2">
                <Plane size={24} fill="currentColor" />
              </div>
              <span
                className={`text-2xl font-bold tracking-tight ${
                  showSolid ? "text-gray-900" : "text-white"
                }`}
              >
                Triply
              </span>
            </Link>
          </div>

          {/* Right side: Account */}
          <div className="flex items-center">
            {/* Account */}
            {loading ? (
              <div className="w-8 h-8 bg-gray-200 animate-pulse rounded-full" />
            ) : user ? (
              <div className="relative">
                <button
                  onClick={() => {
                    setIsUserMenuOpen(!isUserMenuOpen);
                    setIsMobileMenuOpen(false);
                  }}
                  className={`flex items-center gap-1.5 cursor-pointer font-medium transition-colors ${
                    showSolid ? "text-gray-700" : "text-white"
                  }`}
                >
                  <div className="w-8 h-8 bg-brand-orange text-white rounded-full flex items-center justify-center text-sm font-bold">
                    {getUserInitial()}
                  </div>
                  <ChevronDown size={16} className={`transition-transform ${isUserMenuOpen ? "rotate-180" : ""}`} />
                </button>

                {isUserMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setIsUserMenuOpen(false)}
                    />
                    <div className="absolute right-0 mt-4 w-48 bg-white rounded-lg shadow-lg border border-gray-100 py-2 z-20 animate-fade-in">
                      <div className="px-4 py-2 border-b border-gray-100">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {getUserDisplayName()}
                        </p>
                        <p className="text-xs text-gray-500 truncate">{user.email}</p>
                      </div>
                      <Link
                        href="/reservations"
                        className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                        onClick={() => setIsUserMenuOpen(false)}
                      >
                        <Ticket size={16} />
                        My Reservations
                      </Link>
                      <Link
                        href="/account"
                        className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                        onClick={() => setIsUserMenuOpen(false)}
                      >
                        <User size={16} />
                        My Account
                      </Link>
                      <button
                        onClick={handleSignOut}
                        className="flex items-center gap-2 w-full px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 cursor-pointer"
                      >
                        <LogOut size={16} />
                        Sign Out
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <Link href="/auth/login">
                <Button className="bg-brand-orange text-white px-5 py-2 rounded-full font-semibold hover:bg-brand-orange/90 transition-all shadow-sm hover:shadow-md cursor-pointer">
                  Sign In
                </Button>
              </Link>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
