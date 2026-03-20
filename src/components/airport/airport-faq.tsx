"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { FAQItem } from "@/lib/airport-page/content";

interface AirportFAQProps {
  faqs: FAQItem[];
  airportCode: string;
}

function FAQAccordion({
  faq,
  isOpen,
  onToggle,
}: {
  faq: FAQItem;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-gray-200 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between py-4 text-left group"
        aria-expanded={isOpen}
      >
        <span className="text-sm font-medium text-gray-900 group-hover:text-brand-orange transition-colors pr-4">
          {faq.question}
        </span>
        <ChevronDown
          className={`w-5 h-5 text-gray-400 shrink-0 transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>
      {isOpen && (
        <div className="pb-4 text-sm text-gray-600 leading-relaxed">
          {faq.answer}
        </div>
      )}
    </div>
  );
}

export function AirportFAQ({ faqs, airportCode }: AirportFAQProps) {
  const [openIndex, setOpenIndex] = useState(0);

  if (faqs.length === 0) return null;

  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <h2 className="text-2xl font-bold text-gray-900 mb-6">
        {airportCode} Parking FAQs
      </h2>
      <div className="max-w-3xl bg-white rounded-xl border border-gray-200 px-6">
        {faqs.map((faq, idx) => (
          <FAQAccordion
            key={idx}
            faq={faq}
            isOpen={openIndex === idx}
            onToggle={() => setOpenIndex(openIndex === idx ? -1 : idx)}
          />
        ))}
      </div>
    </section>
  );
}
