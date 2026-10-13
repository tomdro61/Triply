"use client";

import { CustomerDetails } from "@/types/checkout";
import Link from "next/link";
import { User, Mail, Phone, CalendarX, UserCheck, Lock, MailCheck } from "lucide-react";

interface CustomerDetailsStepProps {
  data: CustomerDetails;
  onChange: (data: CustomerDetails) => void;
  onNext: () => void;
  errors: Partial<Record<keyof CustomerDetails, string>>;
  /**
   * Show "Free cancellation up to 24 hours before check-in". Only when the
   * check-in is at least two calendar days away: a same-day or next-day
   * booking can't use it, so the line would mislead. (The policy is Terms §5;
   * the 24 h gate itself is enforced server-side in lib/cancellation.)
   */
  showFreeCancellation: boolean;
}

export function CustomerDetailsStep({
  data,
  onChange,
  onNext,
  errors,
  showFreeCancellation,
}: CustomerDetailsStepProps) {
  const handleChange = (field: keyof CustomerDetails, value: string) => {
    onChange({ ...data, [field]: value });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onNext();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900 mb-1">Your Details</h2>
        <p className="text-gray-500 text-sm">
          We'll send your booking confirmation to this email
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* First Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            First Name *
          </label>
          <div className="relative">
            <User
              size={18}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              data-funnel-field="firstName"
              value={data.firstName}
              onChange={(e) => handleChange("firstName", e.target.value)}
              className={`w-full pl-10 pr-4 py-3 border rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors ${
                errors.firstName ? "border-red-500" : "border-gray-300"
              }`}
              placeholder="John"
              required
            />
          </div>
          {errors.firstName && (
            <p className="text-red-500 text-xs mt-1">{errors.firstName}</p>
          )}
        </div>

        {/* Last Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Last Name *
          </label>
          <div className="relative">
            <User
              size={18}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              data-funnel-field="lastName"
              value={data.lastName}
              onChange={(e) => handleChange("lastName", e.target.value)}
              className={`w-full pl-10 pr-4 py-3 border rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors ${
                errors.lastName ? "border-red-500" : "border-gray-300"
              }`}
              placeholder="Doe"
              required
            />
          </div>
          {errors.lastName && (
            <p className="text-red-500 text-xs mt-1">{errors.lastName}</p>
          )}
        </div>
      </div>

      {/* Email */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Email Address *
        </label>
        <div className="relative">
          <Mail
            size={18}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="email"
            data-funnel-field="email"
            value={data.email}
            onChange={(e) => handleChange("email", e.target.value)}
            className={`w-full pl-10 pr-4 py-3 border rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors ${
              errors.email ? "border-red-500" : "border-gray-300"
            }`}
            placeholder="john@example.com"
            required
          />
        </div>
        {errors.email && (
          <p className="text-red-500 text-xs mt-1">{errors.email}</p>
        )}
      </div>

      {/* Phone */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Phone Number *
        </label>
        <div className="relative">
          <Phone
            size={18}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="tel"
            data-funnel-field="phone"
            value={data.phone}
            onChange={(e) => handleChange("phone", e.target.value)}
            className={`w-full pl-10 pr-4 py-3 border rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors ${
              errors.phone ? "border-red-500" : "border-gray-300"
            }`}
            placeholder="(555) 123-4567"
            required
          />
        </div>
        {errors.phone && (
          <p className="text-red-500 text-xs mt-1">{errors.phone}</p>
        )}
        <p className="text-gray-500 text-xs mt-1">
          For booking updates and shuttle coordination
        </p>
      </div>

      <button
        type="submit"
        className="w-full bg-brand-orange text-white font-bold py-3.5 rounded-lg hover:bg-orange-600 transition-all shadow-md active:scale-[0.98]"
      >
        Continue to Vehicle Info
      </button>

      {/* Reassurance at the decision point: 43% of visitors left this step
          without trying the form (GA4, Oct 7–13). Every line must stay true. */}
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm text-gray-600">
        {showFreeCancellation && (
          <li className="flex items-start gap-2">
            <CalendarX className="w-4 h-4 mt-0.5 text-green-600 shrink-0" aria-hidden="true" />
            <span>
              Free cancellation up to 24 hours before check-in
              <span className="block text-xs text-gray-500">
                Cancel online from your Triply account (booking as a guest? sign up later with this email). Park
                Guard protection plans are partly non-refundable.{" "}
                <Link
                  href="/terms#cancellation"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Cancellation policy (opens in a new tab)"
                  className="underline hover:text-gray-700"
                >
                  Policy
                </Link>
              </span>
            </span>
          </li>
        )}
        <li className="flex items-start gap-2">
          <UserCheck className="w-4 h-4 mt-0.5 text-green-600 shrink-0" aria-hidden="true" />
          <span>No account needed — book as a guest</span>
        </li>
        <li className="flex items-start gap-2">
          <Lock className="w-4 h-4 mt-0.5 text-green-600 shrink-0" aria-hidden="true" />
          <span>Secure payment, processed by Stripe</span>
        </li>
        <li className="flex items-start gap-2">
          <MailCheck className="w-4 h-4 mt-0.5 text-green-600 shrink-0" aria-hidden="true" />
          <span>Confirmation emailed instantly</span>
        </li>
      </ul>
    </form>
  );
}
