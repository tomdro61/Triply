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
    { label: "Deals", href: "/deals" },
    { label: "Blog", href: "/blog" },
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

          {/* Desktop Nav */}
          <div className="hidden md:flex items-center space-x-8">
            {navLinks.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className={`font-medium hover:text-brand-orange transition-colors ${
                  showSolid ? "text-gray-600" : "text-white/90"
                }`}
              >
                {item.label}
              </Link>
            ))}

            {loading ? (
              <div className="w-24 h-10 bg-gray-200 animate-pulse rounded-full" />
            ) : user ? (
              /* User Menu */
              <div className="relative">
                <button
                  onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                  className={`flex items-center gap-2 font-medium transition-colors ${
                    showSolid ? "text-gray-700" : "text-white"
                  }`}
                >
                  <div className="w-8 h-8 bg-brand-orange text-white rounded-full flex items-center justify-center text-sm font-bold">
                    {getUserInitial()}
                  </div>
                  <span className="hidden lg:inline">{getUserDisplayName()}</span>
                  <ChevronDown size={16} className={`transition-transform ${isUserMenuOpen ? "rotate-180" : ""}`} />
                </button>

                {isUserMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setIsUserMenuOpen(false)}
                    />
                    <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-100 py-2 z-20">
                      <div className="px-4 py-2 border-b border-gray-100">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {getUserDisplayName()}
                        </p>
                        <p className="text-xs text-gray-500 truncate">{user.email}</p>
                      </div>
                      <Link
                        href="/reservations"
                        className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                        onClick={() => setIsUserMenuOpen(false)}
                      >
                        <Ticket size={16} />
                        My Reservations
                      </Link>
                      <Link
                        href="/account"
                        className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                        onClick={() => setIsUserMenuOpen(false)}
                      >
                        <User size={16} />
                        My Account
                      </Link>
                      <button
                        onClick={handleSignOut}
                        className="flex items-center gap-2 w-full px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                      >
                        <LogOut size={16} />
                        Sign Out
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              /* Sign In Button */
              <Link href="/auth/login">
                <Button className="bg-brand-orange text-white px-5 py-2 rounded-full font-semibold hover:bg-brand-orange/90 transition-all shadow-sm hover:shadow-md">
                  Sign In
                </Button>
              </Link>
            )}
          </div>

          {/* Mobile Menu Button */}
          <div className="md:hidden flex items-center">
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className={`${showSolid ? "text-gray-900" : "text-white"}`}
            >
              {isMobileMenuOpen ? <X size={28} /> : <Menu size={28} />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      {isMobileMenuOpen && (
        <div className="md:hidden absolute top-full left-0 w-full bg-white shadow-lg py-4 px-4 flex flex-col space-y-4 animate-fade-in">
          {navLinks.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className="text-gray-800 font-medium py-2 border-b border-gray-100"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              {item.label}
            </Link>
          ))}

          {user ? (
            <>
              <div className="flex items-center gap-3 py-2 border-b border-gray-100">
                <div className="w-10 h-10 bg-brand-orange text-white rounded-full flex items-center justify-center font-bold">
                  {getUserInitial()}
                </div>
                <div>
                  <p className="font-medium text-gray-900">{getUserDisplayName()}</p>
                  <p className="text-sm text-gray-500">{user.email}</p>
                </div>
              </div>
              <Link
                href="/reservations"
                className="text-gray-800 font-medium py-2 flex items-center gap-2"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <Ticket size={18} />
                My Reservations
              </Link>
              <Link
                href="/account"
                className="text-gray-800 font-medium py-2 flex items-center gap-2"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <User size={18} />
                My Account
              </Link>
              <button
                onClick={() => {
                  handleSignOut();
                  setIsMobileMenuOpen(false);
                }}
                className="text-red-600 font-medium py-2 text-left flex items-center gap-2"
              >
                <LogOut size={18} />
                Sign Out
              </button>
            </>
          ) : (
            <Link href="/auth/login" onClick={() => setIsMobileMenuOpen(false)}>
              <Button className="bg-brand-orange text-white px-5 py-3 rounded-lg font-bold w-full flex justify-center items-center">
                <User size={20} className="mr-2" /> Sign In
              </Button>
            </Link>
          )}
        </div>
      )}
    </nav>
  );
}
