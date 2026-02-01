"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Navbar } from "@/components/shared/navbar";
import { Footer } from "@/components/shared/footer";
import {
  User,
  Mail,
  Phone,
  Lock,
  Shield,
  Loader2,
  ArrowLeft,
  Check,
  AlertCircle,
  Settings,
} from "lucide-react";

interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string;
  provider: string;
  createdAt: string;
}

interface CustomerProfile {
  firstName: string;
  lastName: string;
  phone: string;
}

export default function AccountPage() {
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);

  // Form state
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");

  // Password change state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  // Messages
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);

  useEffect(() => {
    checkAuthAndFetchProfile();
  }, []);

  const checkAuthAndFetchProfile = async () => {
    try {
      const {
        data: { user: authUser },
      } = await supabase.auth.getUser();

      if (!authUser) {
        router.push("/auth/login?redirect=/account");
        return;
      }

      // Fetch profile from API
      const response = await fetch("/api/user/profile");
      if (!response.ok) {
        if (response.status === 401) {
          router.push("/auth/login?redirect=/account");
          return;
        }
        throw new Error("Failed to fetch profile");
      }

      const data = await response.json();
      setUser(data.user);
      setCustomer(data.customer);

      // Set form values
      if (data.customer) {
        setFirstName(data.customer.firstName || "");
        setLastName(data.customer.lastName || "");
        setPhone(data.customer.phone || "");
      } else if (data.user.fullName) {
        // Try to split full name into first/last
        const parts = data.user.fullName.split(" ");
        setFirstName(parts[0] || "");
        setLastName(parts.slice(1).join(" ") || "");
      }
    } catch (err) {
      console.error("Error fetching profile:", err);
      setErrorMessage("Failed to load your profile. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSuccessMessage(null);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName, lastName, phone }),
      });

      if (!response.ok) {
        throw new Error("Failed to update profile");
      }

      setSuccessMessage("Profile updated successfully!");

      // Update local state
      setCustomer({ firstName, lastName, phone });
    } catch (err) {
      console.error("Error updating profile:", err);
      setErrorMessage("Failed to update profile. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(null);

    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match");
      return;
    }

    if (newPassword.length < 6) {
      setPasswordError("Password must be at least 6 characters");
      return;
    }

    setChangingPassword(true);

    try {
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) throw error;

      setPasswordSuccess("Password updated successfully!");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      console.error("Error changing password:", err);
      setPasswordError(
        err instanceof Error ? err.message : "Failed to change password"
      );
    } finally {
      setChangingPassword(false);
    }
  };

  if (loading) {
    return (
      <>
        <Navbar forceSolid />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="h-12 w-12 animate-spin text-brand-orange mx-auto" />
            <p className="mt-4 text-gray-600">Loading your account...</p>
          </div>
        </div>
        <Footer />
      </>
    );
  }

  const isOAuthUser = user?.provider !== "email";

  return (
    <>
      <Navbar forceSolid />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white border-b border-gray-200">
          <div className="max-w-3xl mx-auto px-4 py-6">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Home
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-3 bg-brand-orange/10 rounded-xl">
                <Settings className="h-8 w-8 text-brand-orange" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Account Settings</h1>
                <p className="text-gray-600">Manage your profile and preferences</p>
              </div>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
          {/* Profile Section */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
              <div className="flex items-center gap-2">
                <User className="h-5 w-5 text-gray-600" />
                <h2 className="font-semibold text-gray-900">Profile Information</h2>
              </div>
            </div>
            <form onSubmit={handleSaveProfile} className="p-6 space-y-4">
              {/* Avatar and Email (read-only) */}
              <div className="flex items-center gap-4 pb-4 border-b border-gray-100">
                {user?.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt="Profile"
                    className="w-16 h-16 rounded-full"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-full bg-brand-orange text-white flex items-center justify-center text-2xl font-bold">
                    {firstName.charAt(0) || user?.email?.charAt(0).toUpperCase()}
                  </div>
                )}
                <div>
                  <p className="font-medium text-gray-900">
                    {firstName} {lastName}
                  </p>
                  <p className="text-sm text-gray-500 flex items-center gap-1">
                    <Mail className="h-3.5 w-3.5" />
                    {user?.email}
                  </p>
                  {isOAuthUser && (
                    <p className="text-xs text-gray-400 mt-1">
                      Signed in with {user?.provider === "google" ? "Google" : user?.provider}
                    </p>
                  )}
                </div>
              </div>

              {/* Editable Fields */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="firstName"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    First Name
                  </label>
                  <input
                    id="firstName"
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
                    placeholder="John"
                  />
                </div>
                <div>
                  <label
                    htmlFor="lastName"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Last Name
                  </label>
                  <input
                    id="lastName"
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
                    placeholder="Doe"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="phone"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Phone Number
                </label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <input
                    id="phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
                    placeholder="(555) 555-5555"
                  />
                </div>
              </div>

              {successMessage && (
                <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
                  <Check className="h-5 w-5" />
                  {successMessage}
                </div>
              )}

              {errorMessage && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                  <AlertCircle className="h-5 w-5" />
                  {errorMessage}
                </div>
              )}

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="flex items-center justify-center gap-2 bg-brand-orange text-white font-semibold px-6 py-2.5 rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save Changes
                </button>
              </div>
            </form>
          </div>

          {/* Password Section (only for email users) */}
          {!isOAuthUser && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
                <div className="flex items-center gap-2">
                  <Lock className="h-5 w-5 text-gray-600" />
                  <h2 className="font-semibold text-gray-900">Change Password</h2>
                </div>
              </div>
              <form onSubmit={handleChangePassword} className="p-6 space-y-4">
                <div>
                  <label
                    htmlFor="newPassword"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    New Password
                  </label>
                  <input
                    id="newPassword"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
                    placeholder="••••••••"
                    minLength={6}
                    required
                  />
                </div>

                <div>
                  <label
                    htmlFor="confirmPassword"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Confirm New Password
                  </label>
                  <input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
                    placeholder="••••••••"
                    minLength={6}
                    required
                  />
                </div>

                {passwordError && (
                  <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                    <AlertCircle className="h-5 w-5" />
                    {passwordError}
                  </div>
                )}

                {passwordSuccess && (
                  <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
                    <Check className="h-5 w-5" />
                    {passwordSuccess}
                  </div>
                )}

                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={changingPassword}
                    className="flex items-center justify-center gap-2 bg-gray-900 text-white font-semibold px-6 py-2.5 rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {changingPassword && <Loader2 className="h-4 w-4 animate-spin" />}
                    Update Password
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Security Section */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
              <div className="flex items-center gap-2">
                <Shield className="h-5 w-5 text-gray-600" />
                <h2 className="font-semibold text-gray-900">Account Security</h2>
              </div>
            </div>
            <div className="p-6">
              <div className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium text-gray-900">Sign-in Method</p>
                  <p className="text-sm text-gray-500">
                    {isOAuthUser
                      ? `You're signed in with ${user?.provider === "google" ? "Google" : user?.provider}`
                      : "You're signed in with email and password"}
                  </p>
                </div>
                {isOAuthUser && (
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-full text-sm">
                    <svg className="w-4 h-4" viewBox="0 0 24 24">
                      <path
                        fill="currentColor"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      />
                      <path
                        fill="currentColor"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                    </svg>
                    Google
                  </div>
                )}
              </div>

              <div className="border-t border-gray-100 pt-4 mt-4">
                <p className="text-sm text-gray-500">
                  Member since{" "}
                  {user?.createdAt
                    ? new Date(user.createdAt).toLocaleDateString("en-US", {
                        month: "long",
                        year: "numeric",
                      })
                    : "N/A"}
                </p>
              </div>
            </div>
          </div>

          {/* Quick Links */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="font-semibold text-gray-900 mb-4">Quick Links</h3>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/reservations"
                className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
              >
                My Reservations
              </Link>
              <Link
                href="/help"
                className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Help & Support
              </Link>
              <Link
                href="/"
                className="inline-flex items-center gap-2 px-4 py-2 bg-brand-orange text-white rounded-lg hover:bg-orange-600 transition-colors"
              >
                Book Parking
              </Link>
            </div>
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
}
