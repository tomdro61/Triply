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
        "Triply aggregates real-time pricing from parking facilities near major airports. By comparing all available options instantly, we highlight exclusive deals and lower rates that you might miss by booking directly. Most customers save 40-60% compared to drive-up rates.",
    },
    {
      question: "What airports do you serve?",
      answer:
        "We currently serve JFK (John F. Kennedy International Airport) and LGA (LaGuardia Airport) in New York. We're actively expanding to more airports across the country - subscribe to our newsletter to be notified when we add your airport!",
    },
    {
      question: "Is cancellation really free?",
      answer:
        "Yes, for the vast majority of our bookings! Look for the 'Free Cancellation' tag on any parking option. You can usually cancel up to 24-48 hours before your check-in time for a full refund.",
    },
    {
      question: "How do I get to the parking lot?",
      answer:
        "Each parking lot provides detailed directions in your booking confirmation. Most lots offer free shuttle service to and from the airport terminal. Shuttle frequency and hours vary by lot - check the lot details before booking to find the best option for your flight time.",
    },
    {
      question: "Is my car safe?",
      answer:
        "Absolutely! We only partner with verified, reputable parking facilities. Most lots feature 24/7 security, surveillance cameras, fenced perimeters, and well-lit areas. Look for security amenities listed on each lot's detail page.",
    },
    {
      question: "How do I modify my booking?",
      answer:
        "You can manage your booking through the confirmation email we send you. If you need help, our 24/7 support team is available to assist with any changes.",
    },
    {
      question: "How far in advance should I book?",
      answer:
        "We recommend booking at least a few days in advance, especially during peak travel seasons and holidays. However, we often have same-day availability depending on the lot.",
    },
    {
      question: "What if my flight is delayed?",
      answer:
        "Most of our parking partners offer flexibility for flight delays. Your spot is reserved for your entire booking period, so a delayed return won't affect your reservation. If you need to extend your stay, contact our support team.",
    },
  ];

  const toggle = (index: number) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  return (
    <section className="py-20 bg-brand-gray">
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
                    ? "max-h-40 pb-6 opacity-100"
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
