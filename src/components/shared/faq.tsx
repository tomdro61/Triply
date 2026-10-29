"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

interface FAQItem {
  question: string;
  answer: string;
}

export function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const questions: FAQItem[] = [
    {
      question: "How does Triply save me money?",
      answer:
        "Triply aggregates real-time pricing from parking facilities near major airports, so you compare every available lot in one place instead of hunting for them one by one. Off-airport lots often cost 40-60% less than parking at the airport itself.",
    },
    {
      question: "What airports do you serve?",
      answer:
        "Triply covers 85+ airports across the United States and Canada — JFK, LaGuardia, Newark, Boston, Los Angeles and many more. Search your airport to see the lots available for your dates; a few airports have no online availability yet.",
    },
    {
      question: "Is cancellation really free?",
      answer:
        "Yes, on the vast majority of bookings. Cancel up to 24 hours before check-in from the account the booking is linked to and you get back everything you paid online — if you booked as a guest, sign in with the same email first. If you added Park Guard protection, its small non-refundable portion stays. Within 24 hours of check-in, email support@triplypro.com.",
    },
    {
      question: "How do I get to the parking lot?",
      answer:
        "Each parking lot provides detailed directions in your booking confirmation. Most lots offer free shuttle service to and from the airport terminal. Shuttle frequency and hours vary by lot - check the lot details before booking to find the best option for your flight time.",
    },
    {
      question: "Is my car safe?",
      answer:
        "Our lots come from established booking partners, and we remove any lot that lets customers down. Many lots have 24/7 security, surveillance cameras, fenced perimeters, and well-lit areas — check the security amenities listed on each lot's detail page before you book.",
    },
    {
      question: "How do I modify my booking?",
      answer:
        "There's no edit option yet. More than 24 hours before check-in, cancel the booking from My Reservations for free and book again with the new details. Otherwise email support@triplypro.com — we reply within 24-48 hours on business days.",
    },
    {
      question: "How far in advance should I book?",
      answer:
        "We recommend booking at least a few days in advance, especially during peak travel seasons and holidays. However, we often have same-day availability depending on the lot.",
    },
    {
      question: "What if my flight is delayed?",
      answer:
        "Your spot is reserved for your whole booking period, and most lots are used to delayed flights. Some charge on site for staying past your booked time (see the lot's details), so if you'll be back late, contact the lot using the number on your confirmation.",
    },
  ];

  const toggle = (index: number) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  return (
    <section className="py-20 lg:py-24 bg-brand-gray">
      <div className="max-w-3xl mx-auto px-4 sm:px-6">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-gray-900">
            Frequently Asked Questions
          </h2>
        </div>

        <div className="space-y-4">
          {questions.map((item, index) => (
            <div
              key={index}
              className={`bg-white rounded-xl overflow-hidden transition-all duration-300 border ${
                openIndex === index
                  ? "border-brand-orange shadow-md"
                  : "border-gray-200"
              }`}
            >
              <button
                onClick={() => toggle(index)}
                className="w-full flex justify-between items-center p-6 text-left focus:outline-none"
              >
                <span
                  className={`font-bold text-lg ${
                    openIndex === index ? "text-brand-orange" : "text-gray-900"
                  }`}
                >
                  {item.question}
                </span>
                {openIndex === index ? (
                  <ChevronUp className="text-brand-orange flex-shrink-0" />
                ) : (
                  <ChevronDown className="text-gray-400 flex-shrink-0" />
                )}
              </button>

              <div
                className={`px-6 transition-all duration-300 ease-in-out overflow-hidden ${
                  openIndex === index
                    ? "max-h-[40rem] pb-6 opacity-100"
                    : "max-h-0 opacity-0"
                }`}
              >
                <p className="text-gray-600 leading-relaxed">{item.answer}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
