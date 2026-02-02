"use client";

import { useState } from "react";
import Link from "next/link";
import { Navbar, Footer } from "@/components/shared";
import {
  Search,
  ChevronDown,
  Mail,
  Car,
  CreditCard,
  Calendar,
  Shield,
  HelpCircle,
  ArrowLeft,
} from "lucide-react";

interface FAQItem {
  question: string;
  answer: string;
}

interface FAQCategory {
  id: string;
  title: string;
  icon: React.ReactNode;
  faqs: FAQItem[];
}

const faqCategories: FAQCategory[] = [
  {
    id: "booking",
    title: "Booking & Reservations",
    icon: <Calendar className="h-5 w-5" />,
    faqs: [
      {
        question: "How do I make a reservation?",
        answer:
          "Simply enter your airport, travel dates, and times on our homepage or search page. Browse available parking options, select your preferred lot, and complete the checkout process. You'll receive a confirmation email with all the details you need.",
      },
      {
        question: "Can I modify my reservation?",
        answer:
          "Yes, you can modify your reservation up to 24 hours before your scheduled check-in time. Log into your account, go to My Reservations, and select the booking you want to modify. Changes may affect pricing based on availability.",
      },
      {
        question: "How do I cancel my reservation?",
        answer:
          "To cancel, log into your account and go to My Reservations. Select the booking you want to cancel and click 'Cancel Reservation'. Cancellations made more than 24 hours before check-in receive a full refund. Cancellations within 24 hours may be subject to a cancellation fee.",
      },
      {
        question: "What if I need to extend my parking?",
        answer:
          "If you need to extend your parking, contact the parking facility directly using the phone number on your confirmation. Extensions are subject to availability and will be charged at the daily rate.",
      },
      {
        question: "Do I need to print my confirmation?",
        answer:
          "No, you don't need to print anything. Simply show your confirmation email or the QR code from your booking on your phone when you arrive at the parking facility.",
      },
    ],
  },
  {
    id: "payment",
    title: "Payment & Pricing",
    icon: <CreditCard className="h-5 w-5" />,
    faqs: [
      {
        question: "What payment methods do you accept?",
        answer:
          "We accept all major credit cards (Visa, Mastercard, American Express, Discover), as well as Apple Pay and Google Pay for a seamless checkout experience.",
      },
      {
        question: "When will I be charged?",
        answer:
          "Your card is charged at the time of booking. The amount includes all taxes and fees with no hidden charges. Some facilities may place a hold for incidentals which is released after your stay.",
      },
      {
        question: "Are there any hidden fees?",
        answer:
          "No, the price you see is the price you pay. All taxes, fees, and charges are included in the total shown at checkout. We believe in transparent pricing.",
      },
      {
        question: "How do promo codes work?",
        answer:
          "Enter your promo code during checkout in the designated field. Valid codes will automatically apply the discount to your total. Promo codes cannot be combined and have specific terms and expiration dates.",
      },
      {
        question: "What is your refund policy?",
        answer:
          "Cancellations made more than 24 hours before your check-in time receive a full refund. Cancellations within 24 hours may incur a fee. Refunds are processed within 5-7 business days to your original payment method.",
      },
    ],
  },
  {
    id: "parking",
    title: "Parking & Check-in",
    icon: <Car className="h-5 w-5" />,
    faqs: [
      {
        question: "How do I find the parking facility?",
        answer:
          "Your confirmation email includes the facility address and a link to get directions via Google Maps. Most facilities also have clear signage near the airport. You can also access directions from your booking confirmation page.",
      },
      {
        question: "What do I do when I arrive?",
        answer:
          "When you arrive, show your confirmation QR code or email to the attendant. They'll verify your reservation and direct you to park your vehicle. Some facilities have self-service kiosks where you can scan your QR code.",
      },
      {
        question: "How does the shuttle service work?",
        answer:
          "Most of our partner facilities offer free shuttle service to and from the airport terminal. Shuttles typically run every 10-15 minutes. Check your specific facility's details for shuttle schedule and pickup locations.",
      },
      {
        question: "What if I arrive earlier or later than my reservation?",
        answer:
          "Most facilities accommodate early arrivals and late returns within reason. However, if you arrive significantly earlier, you may be charged for the additional time. Contact the facility if you expect major changes to your schedule.",
      },
      {
        question: "Is my vehicle safe?",
        answer:
          "All our partner facilities have security measures in place including surveillance cameras, security patrols, and well-lit areas. Many offer covered or indoor parking options for additional protection.",
      },
    ],
  },
  {
    id: "security",
    title: "Safety & Security",
    icon: <Shield className="h-5 w-5" />,
    faqs: [
      {
        question: "Is my personal information secure?",
        answer:
          "Yes, we use industry-standard SSL encryption to protect your personal and payment information. We never store your full credit card details on our servers. Your data is handled in compliance with privacy regulations.",
      },
      {
        question: "What if my car is damaged while parked?",
        answer:
          "All our partner facilities carry liability insurance. If you notice any damage to your vehicle, report it immediately to the facility staff before leaving. Document the damage with photos and obtain an incident report.",
      },
      {
        question: "Are the parking facilities insured?",
        answer:
          "Yes, all parking facilities we partner with are required to maintain adequate insurance coverage. However, we recommend checking your own auto insurance policy for coverage details during third-party parking.",
      },
      {
        question: "What items should I remove from my car?",
        answer:
          "We recommend removing all valuables, electronics, and important documents from your vehicle. While facilities have security measures, it's best practice to not leave tempting items visible in your car.",
      },
    ],
  },
  {
    id: "account",
    title: "Account & Support",
    icon: <HelpCircle className="h-5 w-5" />,
    faqs: [
      {
        question: "Do I need an account to book?",
        answer:
          "No, you can book as a guest without creating an account. However, creating an account lets you easily view and manage your reservations, save your information for faster checkout, and access exclusive deals.",
      },
      {
        question: "How do I reset my password?",
        answer:
          "Click 'Forgot your password?' on the login page and enter your email address. We'll send you a link to reset your password. The link expires after 24 hours for security.",
      },
      {
        question: "How can I contact customer support?",
        answer:
          "You can reach us by email at support@triplypro.com or call us at 1-888-TRIPLY1. Our support team is available Monday-Friday, 9 AM - 6 PM EST. For urgent parking issues, contact the facility directly using the number on your confirmation.",
      },
      {
        question: "Where can I see my past reservations?",
        answer:
          "Log into your account and go to My Reservations. You'll see all your upcoming and past bookings. You can view details, download receipts, and rebook previous parking spots.",
      },
    ],
  },
];

function FAQAccordion({ faq, isOpen, onToggle }: { faq: FAQItem; isOpen: boolean; onToggle: () => void }) {
  return (
    <div className="border-b border-gray-200 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between py-4 text-left hover:text-brand-orange transition-colors"
      >
        <span className="font-medium text-gray-900 pr-4">{faq.question}</span>
        <ChevronDown
          className={`h-5 w-5 text-gray-400 flex-shrink-0 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>
      {isOpen && (
        <div className="pb-4 pr-8">
          <p className="text-gray-600 leading-relaxed">{faq.answer}</p>
        </div>
      )}
    </div>
  );
}

function FAQCategorySection({ category }: { category: FAQCategory }) {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div id={category.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden scroll-mt-24">
      <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-brand-orange/10 rounded-lg text-brand-orange">
            {category.icon}
          </div>
          <h2 className="text-lg font-semibold text-gray-900">{category.title}</h2>
        </div>
      </div>
      <div className="px-6">
        {category.faqs.map((faq, index) => (
          <FAQAccordion
            key={index}
            faq={faq}
            isOpen={openIndex === index}
            onToggle={() => setOpenIndex(openIndex === index ? null : index)}
          />
        ))}
      </div>
    </div>
  );
}

export default function HelpPage() {
  const [searchQuery, setSearchQuery] = useState("");

  // Filter FAQs based on search
  const filteredCategories = searchQuery
    ? faqCategories
        .map((category) => ({
          ...category,
          faqs: category.faqs.filter(
            (faq) =>
              faq.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
              faq.answer.toLowerCase().includes(searchQuery.toLowerCase())
          ),
        }))
        .filter((category) => category.faqs.length > 0)
    : faqCategories;

  return (
    <>
      <Navbar forceSolid />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white border-b border-gray-200">
          <div className="max-w-4xl mx-auto px-4 py-8">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Home
            </Link>
            <div className="flex items-center gap-3 mb-6">
              <div className="p-3 bg-brand-orange/10 rounded-xl">
                <HelpCircle className="h-8 w-8 text-brand-orange" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Help Center</h1>
                <p className="text-gray-600">Find answers to common questions</p>
              </div>
            </div>

            {/* Search */}
            <div className="relative max-w-xl">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search for help..."
                className="w-full pl-12 pr-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
              />
            </div>
          </div>
        </div>

        {/* Quick Links */}
        <div className="max-w-4xl mx-auto px-4 py-6">
          <div className="flex flex-wrap gap-2">
            {faqCategories.map((category) => (
              <a
                key={category.id}
                href={`#${category.id}`}
                className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-full text-sm font-medium text-gray-700 hover:border-brand-orange hover:text-brand-orange transition-colors"
              >
                {category.icon}
                {category.title}
              </a>
            ))}
          </div>
        </div>

        {/* FAQ Sections */}
        <div className="max-w-4xl mx-auto px-4 pb-12 space-y-6">
          {filteredCategories.length > 0 ? (
            filteredCategories.map((category) => (
              <FAQCategorySection key={category.id} category={category} />
            ))
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
              <Search className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-gray-900 mb-2">No results found</h3>
              <p className="text-gray-600 mb-4">
                We couldn't find any FAQs matching "{searchQuery}"
              </p>
              <button
                onClick={() => setSearchQuery("")}
                className="text-brand-orange font-medium hover:text-orange-600"
              >
                Clear search
              </button>
            </div>
          )}

          {/* Contact Section */}
          <div className="bg-brand-orange rounded-xl p-8 text-white">
            <h2 className="text-xl font-bold mb-2">Still need help?</h2>
            <p className="text-white/80 mb-6">
              Can't find what you're looking for? Our support team is here to assist you.
            </p>
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 bg-white text-brand-orange font-semibold px-6 py-3 rounded-lg hover:bg-white/90 transition-colors"
            >
              <Mail className="h-5 w-5" />
              Contact Us
            </Link>
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
}
