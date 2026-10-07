"use client";

import { useState } from "react";
import { productionAirports } from "@/config/airports";
import { trackPartnerInquirySubmit } from "@/lib/analytics/gtag";
import {
  OTHER_AIRPORT,
  PARTNER_NAME_MAX,
  PARTNER_LOT_NAME_MAX,
  PARTNER_PHONE_MAX,
  PARTNER_NOTES_MAX,
  buildPartnerInquiryPayload,
  partnerInquiryMissingField,
  type PartnerInquiryFields,
} from "@/lib/partners/inquiry";
import { CONTACT_HONEYPOT_FIELD } from "@/lib/validation/schemas";
import { Send, Loader2, Check, AlertCircle } from "lucide-react";

const MISSING_FIELD_MESSAGE: Record<NonNullable<ReturnType<typeof partnerInquiryMissingField>>, string> = {
  name: "Please enter your name.",
  email: "Please enter your work email.",
  lotName: "Please enter your lot or company name.",
  airport: "Please choose the airport you serve.",
};

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
  // Honeypot — hidden from people, filled by bots; /api/contact drops the
  // submission silently when it is non-empty.
  const [website, setWebsite] = useState("");
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
    if (submitting) return;
    setError(null);

    // `required` lets "   " through; the builder trims, so check what it will send.
    const missing = partnerInquiryMissingField(fields);
    if (missing) {
      setError(MISSING_FIELD_MESSAGE[missing]);
      return;
    }
    setSubmitting(true);

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...buildPartnerInquiryPayload(fields), [CONTACT_HONEYPOT_FIELD]: website }),
      });

      if (!response.ok) {
        // A 504/413 arrives as HTML, not JSON — never show a parser error.
        const data: { error?: string } | null = await response.json().catch(() => null);
        throw new Error(
          data?.error ||
            (response.status === 429
              ? "Too many messages from this connection. Please try again in a few minutes."
              : "We couldn't send your inquiry right now. Please try again, or email support@triplypro.com.")
        );
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
          We&apos;ve received your details and will be in touch within 24-48
          hours on business days.
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
      className="relative bg-white rounded-xl border border-gray-200 p-6 space-y-4"
    >
      {/* Honeypot: off-screen, skipped by tab, autofill and password managers, invisible to screen readers. */}
      <div aria-hidden="true" className="absolute -left-[9999px] top-auto w-px h-px overflow-hidden">
        <input
          id={`partner-${CONTACT_HONEYPOT_FIELD}`}
          name={CONTACT_HONEYPOT_FIELD}
          type="text"
          tabIndex={-1}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

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
            maxLength={PARTNER_NAME_MAX}
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
            maxLength={PARTNER_LOT_NAME_MAX}
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
            maxLength={PARTNER_PHONE_MAX}
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
        <div
          role="alert"
          className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm"
        >
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
