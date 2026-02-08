"use client";

import { Star, ShieldCheck, Clock, RefreshCw } from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";

const trustItems = [
  { icon: Star, label: "4.9 Rating", color: "text-yellow-400" },
  { icon: ShieldCheck, label: "Verified Partners", color: "text-brand-orange" },
  { icon: Clock, label: "24/7 Support", color: "text-brand-blue" },
  { icon: RefreshCw, label: "Free Cancellation", color: "text-green-500" },
];

export function SocialProofStrip() {
  return (
    <section className="relative bg-white">
      {/* Dark-to-light gradient transition from hero */}
      <div className="absolute top-0 left-0 right-0 h-24 bg-gradient-to-b from-[#0a0a1a] to-transparent pointer-events-none" />

      <div className="pt-16 pb-8 md:pb-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-2 md:flex md:justify-center md:items-center gap-6 md:gap-12">
            {trustItems.map((item, index) => (
              <ScrollReveal key={item.label} delay={index * 0.1} className="flex items-center justify-center gap-2.5">
                <item.icon size={20} className={item.color} />
                <span className="text-gray-600 text-sm font-medium">{item.label}</span>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
