"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";

interface FAQItem {
  question: string;
  answer: string;
}

const questions: FAQItem[] = [
  {
    question: "How does Triply save me money?",
    answer:
      "Triply aggregates real-time pricing from parking facilities near major airports. By comparing all available options instantly, we highlight exclusive deals and lower rates that you might miss by booking directly. Most customers save 40-60% compared to on-site airport parking rates.",
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
];

export function FAQRedesign() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const toggle = (index: number) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  return (
    <section className="py-16 lg:py-20 bg-white">
      <div className="max-w-3xl mx-auto px-4 sm:px-6">
        <ScrollReveal className="text-center mb-10">
          <p className="text-brand-orange font-bold text-sm uppercase tracking-wider mb-3">
            FAQ
          </p>
          <h2 className="text-3xl font-bold text-gray-900">
            Common Questions
          </h2>
        </ScrollReveal>

        <ScrollReveal delay={0.1}>
          <div className="space-y-3">
            {questions.map((item, index) => (
              <div
                key={index}
                className={`bg-white rounded-xl overflow-hidden transition-all duration-300 border ${
                  openIndex === index
                    ? "border-brand-orange shadow-md"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <button
                  onClick={() => toggle(index)}
                  className="w-full flex justify-between items-center p-5 text-left focus:outline-none cursor-pointer"
                >
                  <span
                    className={`font-semibold ${
                      openIndex === index ? "text-brand-orange" : "text-gray-900"
                    }`}
                  >
                    {item.question}
                  </span>
                  <ChevronDown
                    size={20}
                    className={`flex-shrink-0 transition-transform duration-300 ${
                      openIndex === index
                        ? "rotate-180 text-brand-orange"
                        : "text-gray-400"
                    }`}
                  />
                </button>

                <div
                  className={`px-5 transition-all duration-300 ease-in-out overflow-hidden ${
                    openIndex === index
                      ? "max-h-48 pb-5 opacity-100"
                      : "max-h-0 opacity-0"
                  }`}
                >
                  <p className="text-gray-600 leading-relaxed text-[15px]">
                    {item.answer}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
