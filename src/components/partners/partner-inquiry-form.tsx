"use client";

import { useState } from "react";
import { productionAirports } from "@/config/airports";
import { trackPartnerInquirySubmit } from "@/lib/analytics/gtag";
import {
  OTHER_AIRPORT,
  PARTNER_NOTES_MAX,
  buildPartnerInquiryPayload,
  type PartnerInquiryFields,
} from "@/lib/partners/inquiry";
import { Send, Loader2, Check, AlertCircle } from "lucide-react";

const airportOptions = [...productionAirports].sort((a, b) =>
  a.city.localeCompare(b.city)
);

const EMPTY: PartnerInquiryFields = {
  name: "",
  email: "",
  phone: "",
  lotName: "",
  airport: "",
  spaces: "",
  notes: "",
};

const inputClass =
  "w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none";
const labelClass = "block text-sm font-medium text-gray-700 mb-1";

export function PartnerInquiryForm() {
  const [fields, setFields] = useState<PartnerInquiryFields>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >
  ) => {
    const { name, value } = e.target;
    setFields((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPartnerInquiryPayload(fields)),
      });

      const data: { error?: string } = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to send your inquiry");
      }

      trackPartnerInquirySubmit(fields.airport);
      setSuccess(true);
      setFields(EMPTY);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <Check className="h-8 w-8 text-green-600" />
        </div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">
          Thanks — we&apos;ve got your details
        </h3>
        <p className="text-gray-600 mb-6">
          We&apos;ve sent a confirmation to your email and will be in touch
          within 24-48 hours on business days.
        </p>
        <button
          type="button"
          onClick={() => setSuccess(false)}
          className="px-6 py-2 bg-gray-100 text-gray-700 font-semibold rounded-lg hover:bg-gray-200 transition-colors"
        >
          Send another inquiry
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white rounded-xl border border-gray-200 p-6 space-y-4"
    >
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="partner-name" className={labelClass}>
            Your Name *
          </label>
          <input
            id="partner-name"
            name="name"
            type="text"
            autoComplete="name"
            value={fields.name}
            onChange={handleChange}
            required
            maxLength={200}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="partner-email" className={labelClass}>
            Work Email *
          </label>
          <input
            id="partner-email"
            name="email"
            type="email"
            autoComplete="email"
            value={fields.email}
            onChange={handleChange}
            required
            maxLength={254}
            className={inputClass}
          />
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="partner-lot" className={labelClass}>
            Lot or Company Name *
          </label>
          <input
            id="partner-lot"
            name="lotName"
            type="text"
            autoComplete="organization"
            value={fields.lotName}
            onChange={handleChange}
            required
            maxLength={200}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="partner-phone" className={labelClass}>
            Phone
          </label>
          <input
            id="partner-phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            value={fields.phone}
            onChange={handleChange}
            maxLength={40}
            className={inputClass}
          />
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="partner-airport" className={labelClass}>
            Airport Served *
          </label>
          <select
            id="partner-airport"
            name="airport"
            value={fields.airport}
            onChange={handleChange}
            required
            className={`${inputClass} bg-white`}
          >
            <option value="">Select an airport</option>
            {airportOptions.map((a) => (
              <option key={a.code} value={a.code}>
                {a.city} ({a.code})
              </option>
            ))}
            <option value={OTHER_AIRPORT}>Other / not listed</option>
          </select>
        </div>
        <div>
          <label htmlFor="partner-spaces" className={labelClass}>
            Approx. Number of Spaces
          </label>
          <input
            id="partner-spaces"
            name="spaces"
            type="number"
            inputMode="numeric"
            min={1}
            max={100000}
            value={fields.spaces}
            onChange={handleChange}
            className={inputClass}
          />
        </div>
      </div>

      <div>
        <label htmlFor="partner-notes" className={labelClass}>
          Anything else we should know?
        </label>
        <textarea
          id="partner-notes"
          name="notes"
          value={fields.notes}
          onChange={handleChange}
          rows={4}
          maxLength={PARTNER_NOTES_MAX}
          className={`${inputClass} resize-none`}
          placeholder="Shuttle or valet, covered spaces, other booking sites you list on…"
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full flex items-center justify-center gap-2 bg-brand-orange text-white font-semibold py-3 rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin" />
            Sending...
          </>
        ) : (
          <>
            <Send className="h-5 w-5" />
            Send Partner Inquiry
          </>
        )}
      </button>
      <p className="text-xs text-gray-500 text-center">
        We&apos;ll only use these details to follow up about listing your lot.
      </p>
    </form>
  );
}
