"use client";

import { useState } from "react";
import Link from "next/link";
import { Navbar, Footer } from "@/components/shared";
import { trackContactFormSubmit } from "@/lib/analytics/gtag";
import { CONTACT_HONEYPOT_FIELD, CONTACT_SUBJECTS } from "@/lib/validation/schemas";
import {
  ArrowLeft,
  Mail,
  Send,
  Loader2,
  Check,
  AlertCircle,
  Clock,
  MessageSquare,
} from "lucide-react";

/** Subjects about one reservation — these show the reservation-number field. */
const BOOKING_SUBJECTS = new Set<string>([
  "Booking Help",
  "Change My Reservation",
  "Cancellation Request",
  "Problem at the Lot",
  "Payment Issue",
]);

/** The subjects (and order) the form had before the support inbox — used while it's off. */
const LEGACY_SUBJECTS = [
  "General Inquiry",
  "Booking Help",
  "Cancellation Request",
  "Payment Issue",
  "Feedback",
  "Partnership Inquiry",
  "Other",
] as const satisfies ReadonlyArray<(typeof CONTACT_SUBJECTS)[number]>;

const EMPTY_FORM = { name: "", email: "", subject: "", message: "", reservationNumber: "" };

const linkClass = "text-brand-orange hover:text-orange-600 font-medium";

/**
 * Self-service first: before someone writes to us, show the fastest way to do
 * it themselves. Shown under the subject; the form stays usable either way.
 */
function SelfServiceTip({
  subject,
  selfCancelEnabled,
  supportInboxEnabled,
}: {
  subject: string;
  selfCancelEnabled: boolean;
  supportInboxEnabled: boolean;
}) {
  let tip: React.ReactNode = null;
  // With the inbox off only the self-cancel tip shows: it describes a feature
  // that is on, while the others describe the inbox's workflow.
  if (!supportInboxEnabled && subject !== "Cancellation Request") return null;
  if (subject === "Cancellation Request" && selfCancelEnabled) {
    tip = (
      <>
        <strong>Fastest:</strong> cancel it yourself in{" "}
        <Link href="/reservations" className={linkClass}>
          My Reservations
        </Link>{" "}
        (sign in with the email you booked with). You&apos;ll see your refund before you confirm. Online
        cancellation closes 24 hours before check-in — inside that window, send us a message and we&apos;ll
        handle it.
      </>
    );
  } else if (subject === "Change My Reservation") {
    tip = (
      <>
        Tell us the new dates, times or vehicle and we&apos;ll reply with your options.
        {selfCancelEnabled && (
          <>
            {" "}
            In a hurry and more than 24 hours before check-in? You can also cancel in{" "}
            <Link href="/reservations" className={linkClass}>
              My Reservations
            </Link>{" "}
            and book the new dates yourself.
          </>
        )}
      </>
    );
  } else if (subject === "Problem at the Lot") {
    tip = (
      <>
        On your trip right now? Add your reservation number — we flag urgent messages to our team
        straight away. Your confirmation email has the lot&apos;s address and directions.
      </>
    );
  } else if (subject === "Booking Help") {
    tip = (
      <>
        Your booking details and the lot&apos;s address are in{" "}
        <Link href="/reservations" className={linkClass}>
          My Reservations
        </Link>{" "}
        (sign in with the email you booked with).
      </>
    );
  }
  if (!tip) return null;
  return <p className="mt-2 rounded-lg bg-orange-50 px-3 py-2 text-sm text-gray-700">{tip}</p>;
}

export default function ContactPageClient({
  selfCancelEnabled,
  supportInboxEnabled,
}: {
  selfCancelEnabled: boolean;
  supportInboxEnabled: boolean;
}) {
  const [formData, setFormData] = useState(EMPTY_FORM);
  // The reservation-number field only exists when /api/contact will use it.
  const askReservation = supportInboxEnabled && BOOKING_SUBJECTS.has(formData.subject);
  // Set from the API response: the ticket number we emailed, and whether the team was paged.
  const [ticket, setTicket] = useState<{ number: number | null; urgent: boolean; replied: boolean }>({
    number: null,
    urgent: false,
    replied: false,
  });
  // Honeypot — hidden from people, filled by bots; /api/contact drops the
  // submission silently when it is non-empty.
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          subject: formData.subject,
          message: formData.message,
          // Only for a reservation subject — never a stale value from an earlier choice.
          ...(askReservation && formData.reservationNumber.trim()
            ? { reservationNumber: formData.reservationNumber.trim() }
            : {}),
          [CONTACT_HONEYPOT_FIELD]: website,
        }),
      });

      if (!response.ok) {
        // A 504/413 arrives as HTML, not JSON — never show a parser error.
        const data: { error?: string } | null = await response.json().catch(() => null);
        throw new Error(
          data?.error ||
            (response.status === 429
              ? "Too many messages from this connection. Please try again in a few minutes."
              : "We couldn't send your message right now. Please try again, or email support@triplypro.com.")
        );
      }

      const data: { ticketNumber?: unknown; urgent?: unknown; confirmationSent?: unknown } | null = await response
        .json()
        .catch(() => null);
      setTicket({
        number: typeof data?.ticketNumber === "number" ? data.ticketNumber : null,
        urgent: data?.urgent === true,
        replied: data?.confirmationSent === true,
      });
      setSuccess(true);
      trackContactFormSubmit();
      setFormData(EMPTY_FORM);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  // The server validates against the same list (contactFormSchema). With the
  // inbox off, the form is main's: its subjects in its order, so nothing on the
  // page promises a workflow (urgent paging, booking lookup) that isn't running.
  const subjectOptions = supportInboxEnabled ? CONTACT_SUBJECTS : LEGACY_SUBJECTS;

  return (
    <>
      <Navbar forceSolid />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white border-b border-gray-200">
          <div className="max-w-3xl mx-auto px-4 py-8">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Home
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-3 bg-brand-orange/10 rounded-xl">
                <Mail className="h-8 w-8 text-brand-orange" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Contact Us</h1>
                <p className="text-gray-600">We&apos;d love to hear from you</p>
              </div>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="max-w-3xl mx-auto px-4 py-8">
          <div className="grid md:grid-cols-3 gap-8">
            {/* Contact Form */}
            <div className="md:col-span-2">
              {success ? (
                <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
                  <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Check className="h-8 w-8 text-green-600" />
                  </div>
                  <h2 className="text-xl font-bold text-gray-900 mb-2">
                    Message Sent!
                  </h2>
                  {ticket.number !== null ? (
                    <p className="text-gray-600 mb-6">
                      Your request is <strong>Triply #{ticket.number}</strong>.{" "}
                      {ticket.replied
                        ? "We've emailed you a reply with next steps (check your spam folder too)."
                        : "We'll reply by email as soon as possible."}
                      {/* The alert runs after this response — claim the flag, not a delivered page. */}
                      {ticket.urgent && " We've flagged it as urgent for our team."}
                    </p>
                  ) : (
                    <p className="text-gray-600 mb-6">
                      Thank you for reaching out. We&apos;ve received your message and will
                      respond within 24-48 hours.
                    </p>
                  )}
                  <div className="flex flex-wrap justify-center gap-4">
                    <button
                      onClick={() => setSuccess(false)}
                      className="px-6 py-2 bg-brand-orange text-white font-semibold rounded-lg hover:bg-orange-600 transition-colors"
                    >
                      Send Another Message
                    </button>
                    <Link
                      href="/help"
                      className="px-6 py-2 bg-gray-100 text-gray-700 font-semibold rounded-lg hover:bg-gray-200 transition-colors"
                    >
                      View FAQs
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
                    <div className="flex items-center gap-2">
                      <MessageSquare className="h-5 w-5 text-gray-600" />
                      <h2 className="font-semibold text-gray-900">Send us a message</h2>
                    </div>
                  </div>
                  <form onSubmit={handleSubmit} className="relative p-6 space-y-4">
                    {/* Honeypot: off-screen, skipped by tab, autofill and password managers, invisible to screen readers. */}
                    <div aria-hidden="true" className="absolute -left-[9999px] top-auto w-px h-px overflow-hidden">
                      <input
                        id={`contact-${CONTACT_HONEYPOT_FIELD}`}
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
                        <label
                          htmlFor="name"
                          className="block text-sm font-medium text-gray-700 mb-1"
                        >
                          Your Name *
                        </label>
                        <input
                          id="name"
                          name="name"
                          type="text"
                          value={formData.name}
                          onChange={handleChange}
                          required
                          className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
                          placeholder="John Doe"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="email"
                          className="block text-sm font-medium text-gray-700 mb-1"
                        >
                          Email Address *
                        </label>
                        <input
                          id="email"
                          name="email"
                          type="email"
                          value={formData.email}
                          onChange={handleChange}
                          required
                          className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
                          placeholder="john@example.com"
                        />
                      </div>
                    </div>

                    <div>
                      <label
                        htmlFor="subject"
                        className="block text-sm font-medium text-gray-700 mb-1"
                      >
                        Subject *
                      </label>
                      <select
                        id="subject"
                        name="subject"
                        value={formData.subject}
                        onChange={handleChange}
                        required
                        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none bg-white"
                      >
                        <option value="">Select a topic</option>
                        {subjectOptions.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                      <SelfServiceTip subject={formData.subject} selfCancelEnabled={selfCancelEnabled} supportInboxEnabled={supportInboxEnabled} />
                      {formData.subject === "Partnership Inquiry" && (
                        <p className="mt-2 text-sm text-gray-600">
                          Own or operate a parking lot?{" "}
                          <Link
                            href="/partners"
                            className="text-brand-orange hover:text-orange-600 font-medium"
                          >
                            See how to list it on Triply
                          </Link>
                          .
                        </p>
                      )}
                    </div>

                    {askReservation && (
                      <div>
                        <label
                          htmlFor="reservationNumber"
                          className="block text-sm font-medium text-gray-700 mb-1"
                        >
                          Reservation number{" "}
                          <span className="font-normal text-gray-500">(from your confirmation email)</span>
                        </label>
                        <input
                          id="reservationNumber"
                          name="reservationNumber"
                          type="text"
                          inputMode="text"
                          autoComplete="off"
                          maxLength={40}
                          value={formData.reservationNumber}
                          onChange={handleChange}
                          className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
                          placeholder="Helps us find your booking right away"
                        />
                      </div>
                    )}

                    <div>
                      <label
                        htmlFor="message"
                        className="block text-sm font-medium text-gray-700 mb-1"
                      >
                        Message *
                      </label>
                      <textarea
                        id="message"
                        name="message"
                        value={formData.message}
                        onChange={handleChange}
                        required
                        rows={5}
                        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none resize-none"
                        placeholder="How can we help you?"
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
                          Send Message
                        </>
                      )}
                    </button>
                  </form>
                </div>
              )}
            </div>

            {/* Sidebar */}
            <div className="space-y-6">
              {/* Response Time */}
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 bg-brand-orange/10 rounded-lg">
                    <Clock className="h-5 w-5 text-brand-orange" />
                  </div>
                  <h3 className="font-semibold text-gray-900">Response Time</h3>
                </div>
                <p className="text-sm text-gray-600">
                  We typically respond within 24-48 hours during business days.
                </p>
              </div>

              {/* Quick Links */}
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="font-semibold text-gray-900 mb-4">Quick Links</h3>
                <ul className="space-y-3">
                  <li>
                    <Link
                      href="/help"
                      className="text-brand-orange hover:text-orange-600 text-sm font-medium"
                    >
                      Check our FAQs
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/reservations"
                      className="text-brand-orange hover:text-orange-600 text-sm font-medium"
                    >
                      View My Reservations
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/partners"
                      className="text-brand-orange hover:text-orange-600 text-sm font-medium"
                    >
                      Own a parking lot? List it on Triply
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/terms"
                      className="text-brand-orange hover:text-orange-600 text-sm font-medium"
                    >
                      Terms of Service
                    </Link>
                  </li>
                </ul>
              </div>

              {/* Email Directly */}
              <div className="bg-gray-100 rounded-xl p-6">
                <h3 className="font-semibold text-gray-900 mb-2">
                  Prefer email?
                </h3>
                <p className="text-sm text-gray-600 mb-3">
                  You can also reach us directly at:
                </p>
                <a
                  href="mailto:support@triplypro.com"
                  className="text-brand-orange hover:text-orange-600 font-medium"
                >
                  support@triplypro.com
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
}
