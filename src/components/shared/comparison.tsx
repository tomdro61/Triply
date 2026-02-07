"use client";

import { XCircle, CheckCircle2 } from "lucide-react";

const painPoints = [
  "Limited options from single providers",
  "Hours of research across multiple tabs",
  "Hidden fees added at checkout",
  "No guarantee you found the lowest price",
];

const benefits = [
  "Compare 100s of providers instantly",
  "Transparent pricing with no surprises",
  "Best Price Guarantee",
  "Free cancellation on most bookings",
  "Verified, trusted parking partners",
  "24/7 customer support",
];

export function Comparison() {
  return (
    <section className="py-20 lg:py-24 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-gray-900">
            Why Choose Triply?
          </h2>
          <p className="text-gray-500 mt-3 text-lg">
            See the difference smart travel booking makes
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8 max-w-5xl mx-auto">
          {/* Before Triply */}
          <div className="bg-gray-50 rounded-2xl p-8 border border-gray-200 relative overflow-hidden shadow-sm">
            <div className="absolute top-0 left-0 w-full h-1.5 bg-gray-300" />
            <h3 className="text-xl font-bold text-gray-500 mb-6">
              Booking Without Triply
            </h3>
            <ul className="space-y-4">
              {painPoints.map((item, idx) => (
                <li key={idx} className="flex items-start text-gray-500">
                  <XCircle className="text-red-400 w-6 h-6 mr-3 flex-shrink-0 mt-0.5" />
                  <span className="line-through decoration-gray-400">
                    {item}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* With Triply */}
          <div className="bg-white rounded-2xl p-8 shadow-xl border-t-4 border-brand-orange relative transform md:-translate-y-4">
            <div className="absolute -top-3 right-8 bg-brand-orange text-white text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wide shadow-md">
              Recommended
            </div>
            <h3 className="text-xl font-bold text-gray-900 mb-6">
              Booking With Triply
            </h3>
            <ul className="space-y-4">
              {benefits.map((item, idx) => (
                <li
                  key={idx}
                  className="flex items-start text-gray-800 font-medium"
                >
                  <CheckCircle2 className="text-brand-orange w-6 h-6 mr-3 flex-shrink-0 mt-0.5" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
