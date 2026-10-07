import type { Metadata } from "next";
import Link from "next/link";
// Direct file imports, not the @/components/shared barrel: the barrel re-exports
// Hero, which would pull the date picker into this page's bundle.
import { Navbar } from "@/components/shared/navbar";
import { Footer } from "@/components/shared/footer";
import { JsonLd } from "@/components/seo/JsonLd";
import { PartnerInquiryForm } from "@/components/partners/partner-inquiry-form";
import {
  ArrowLeft,
  Building2,
  Search,
  BookOpen,
  CreditCard,
  LayoutDashboard,
  ChevronDown,
} from "lucide-react";

const title = "List Your Parking Lot";
const description = `Own or operate an airport parking lot or garage? List it on Triply to reach travelers comparing parking at 80+ airports across the US and Canada.`;

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/partners" },
  openGraph: {
    title: `${title} | Triply`,
    description,
    url: "/partners",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${title} | Triply`,
    description,
  },
};

const benefits = [
  {
    icon: Search,
    title: "In front of travelers who are ready to book",
    body: `Your lot appears in Triply search results and on our airport parking pages, where travelers compare options side by side at 80+ airports across the US and Canada.`,
  },
  {
    icon: BookOpen,
    title: "Search traffic from our airport guides",
    body: "Our blog publishes airport parking guides that answer the questions travelers search for and link straight to booking at that airport.",
  },
  {
    icon: CreditCard,
    title: "Prepaid reservations, monthly payouts",
    body: "Travelers pay online when they reserve, and the reservation is only confirmed once payment goes through. Triply pays partners monthly.",
  },
  {
    icon: LayoutDashboard,
    title: "Every reservation, straight to your inbox",
    body: "Each booking is emailed to your lot with the confirmation number, guest name, vehicle and dates, so your team always knows who is arriving. A partner dashboard for direct partners is on the way.",
  },
];

const steps = [
  {
    title: "Tell us about your lot",
    body: "Send the short form below with your lot, the airport you serve and roughly how many spaces you have.",
  },
  {
    title: "We get in touch",
    body: "Our team reviews your details and contacts you directly to talk through your facility and how listing works. You list directly with Triply: your agreement is with us, not a third-party booking network.",
  },
  {
    title: "Your lot goes live",
    body: "Once set up, your lot appears in search results for your airport so travelers can compare and book it.",
  },
  {
    title: "Receive reservations",
    body: "Every booking is emailed to your lot as it happens, with everything your team needs to check the guest in.",
  },
];

const faqs = [
  {
    question: "Who can list a lot on Triply?",
    answer:
      "Operators of parking lots, garages and park-and-fly facilities that serve airport travelers and want to work directly with Triply. If you run parking near an airport, send us your details and we will follow up. (If your lot already reaches Triply through a booking network such as Reservations Lab, it is listed through that channel and there is nothing you need to do.)",
  },
  {
    question: "Which airports does Triply cover?",
    answer: `Travelers can compare parking at 80+ airports across the US and Canada on Triply. If your airport is not listed yet, choose "Other / not listed" on the form and tell us where you are.`,
  },
  {
    question: "How do travelers pay?",
    answer:
      "Travelers pay online through Triply when they book. A reservation is only confirmed once the payment goes through.",
  },
  {
    question: "How often are partners paid?",
    answer: "Direct partners are paid by Triply monthly for the reservations completed at their lot.",
  },
  {
    question: "How will I see my Triply reservations?",
    answer:
      "Every reservation is emailed to your lot as soon as it is booked, with the confirmation number, guest name, vehicle details, dates and times. A partner dashboard for direct partners is on the way.",
  },
  {
    question: "What are the terms for listing?",
    answer:
      "You list directly with Triply, and the listing agreement is between you and Triply. We go through the commission, payout schedule and the rest of the terms with each operator once we know more about the facility. Send the form and we will contact you.",
  },
  {
    question: "How quickly will you get back to me?",
    answer:
      "We typically respond within 24-48 hours on business days. You can also email support@triplypro.com.",
  },
];

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((faq) => ({
    "@type": "Question",
    name: faq.question,
    acceptedAnswer: { "@type": "Answer", text: faq.answer },
  })),
};

export default function PartnersPage() {
  return (
    <>
      <JsonLd data={faqSchema} />
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
                <Building2 className="h-8 w-8 text-brand-orange" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">
                  List your lot with Triply
                </h1>
                <p className="text-gray-600">
                  For airport parking lot and garage operators
                </p>
              </div>
            </div>
            <p className="mt-6 text-gray-700 leading-relaxed">
              Triply is an airport parking marketplace. Travelers come to us to
              compare lots near their airport and book a space before they
              fly. If you operate airport parking, listing directly with Triply
              puts your lot in that comparison — travelers pay online when they
              reserve, and you are paid monthly.
            </p>
            <a
              href="#partner-inquiry"
              className="mt-6 inline-flex items-center gap-2 bg-brand-orange text-white font-bold px-6 py-3 rounded-full hover:bg-brand-orange/90 transition-all shadow-md hover:shadow-lg"
            >
              Get in touch
            </a>
          </div>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-8 space-y-12">
          {/* What Triply does for you */}
          <section aria-labelledby="partners-benefits">
            <h2
              id="partners-benefits"
              className="text-xl font-bold text-gray-900 mb-4"
            >
              What Triply does for your lot
            </h2>
            <div className="grid sm:grid-cols-2 gap-4">
              {benefits.map((b) => (
                <div
                  key={b.title}
                  className="bg-white rounded-xl border border-gray-200 p-6"
                >
                  <div className="inline-flex items-center justify-center w-10 h-10 bg-brand-orange/10 rounded-lg mb-3">
                    <b.icon className="w-5 h-5 text-brand-orange" />
                  </div>
                  <h3 className="font-semibold text-gray-900 mb-1">
                    {b.title}
                  </h3>
                  <p className="text-sm text-gray-600 leading-relaxed">
                    {b.body}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* How it works */}
          <section aria-labelledby="partners-steps">
            <h2
              id="partners-steps"
              className="text-xl font-bold text-gray-900 mb-4"
            >
              How it works
            </h2>
            <ol className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
              {steps.map((s, i) => (
                <li key={s.title} className="flex gap-4 p-6">
                  <span className="flex-shrink-0 w-8 h-8 rounded-full bg-brand-orange text-white font-bold flex items-center justify-center">
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="font-semibold text-gray-900">{s.title}</h3>
                    <p className="text-sm text-gray-600 mt-1">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* Inquiry form */}
          <section
            id="partner-inquiry"
            aria-labelledby="partners-form"
            className="scroll-mt-24"
          >
            <h2
              id="partners-form"
              className="text-xl font-bold text-gray-900 mb-1"
            >
              Tell us about your lot
            </h2>
            <p className="text-gray-600 mb-4">
              This form is for operators who want to list directly with Triply.
              Already have a partner dashboard login?{" "}
              <Link
                href="/partner"
                className="text-brand-orange hover:text-orange-600 font-medium"
              >
                Sign in here
              </Link>
              .
            </p>
            <PartnerInquiryForm />
          </section>

          {/* FAQ */}
          <section aria-labelledby="partners-faq">
            <h2
              id="partners-faq"
              className="text-xl font-bold text-gray-900 mb-4"
            >
              Partner FAQ
            </h2>
            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
              {faqs.map((faq) => (
                <details key={faq.question} className="group p-6">
                  <summary className="flex items-center justify-between gap-4 cursor-pointer list-none font-semibold text-gray-900">
                    {faq.question}
                    <ChevronDown className="h-5 w-5 flex-shrink-0 text-gray-400 transition-transform group-open:rotate-180" />
                  </summary>
                  <p className="mt-3 text-sm text-gray-600 leading-relaxed">
                    {faq.answer}
                  </p>
                </details>
              ))}
            </div>
          </section>

          {/* Related Links */}
          <div className="flex flex-wrap gap-4">
            <Link
              href="/about"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-gray-700 hover:border-brand-orange hover:text-brand-orange transition-colors"
            >
              About Triply
            </Link>
            <Link
              href="/airport-parking"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-gray-700 hover:border-brand-orange hover:text-brand-orange transition-colors"
            >
              Airports we cover
            </Link>
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-gray-700 hover:border-brand-orange hover:text-brand-orange transition-colors"
            >
              Contact Us
            </Link>
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
}
