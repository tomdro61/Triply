"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle, Mail } from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";

export function FinalCTA() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubscribe = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setSubmitted(true);
  };

  const handleSearchClick = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <section
      className="pt-20 lg:pt-24 pb-0 relative overflow-hidden"
      style={{
        backgroundImage: `url('https://images.unsplash.com/photo-1464037866556-6812c9d1c72e?auto=format&fit=crop&w=2000&q=80')`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {/* Dark overlay - fades to solid brand-dark at bottom for seamless footer transition */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#1A1A2E]/85 via-[#1A1A2E]/90 to-[#1A1A2E]" />
      {/* Ambient orb */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] rounded-full bg-brand-orange/10 blur-[150px] pointer-events-none" />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 pb-20 lg:pb-24 text-center relative z-10">
        {/* Primary CTA */}
        <ScrollReveal>
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-white">
            Ready to Save on Parking?
          </h2>
          <p className="text-gray-400 text-lg mt-4 max-w-xl mx-auto">
            Compare prices at JFK and LaGuardia. Book in minutes.
          </p>
          <button
            onClick={handleSearchClick}
            className="mt-8 inline-flex items-center gap-2 bg-brand-orange text-white font-bold px-8 py-4 rounded-full hover:bg-white hover:text-gray-900 transition-all duration-300 shadow-lg shadow-brand-orange/25 text-lg cursor-pointer"
          >
            Find Parking Now
            <ArrowRight size={20} />
          </button>
        </ScrollReveal>

        {/* Divider */}
        <div className="border-t border-white/10 mt-16 pt-12" />

        {/* Newsletter */}
        <ScrollReveal delay={0.2}>
          <div className="flex items-center justify-center gap-2 mb-2">
            <Mail size={18} className="text-brand-orange" />
            <h3 className="text-xl font-bold text-white">
              Get 10% Off Your First Booking
            </h3>
          </div>
          <p className="text-gray-400 text-sm mb-6">
            Subscribe for exclusive deals. No spam, unsubscribe anytime.
          </p>

          {submitted ? (
            <div className="inline-flex items-center gap-2 bg-green-500/10 border border-green-500/20 text-green-400 px-6 py-3 rounded-xl text-sm font-medium">
              <CheckCircle size={18} />
              Check your email for your 10% off code!
            </div>
          ) : (
            <form
              onSubmit={handleSubscribe}
              className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto"
            >
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email"
                required
                className="flex-1 bg-white/10 border border-white/20 text-white placeholder:text-gray-500 rounded-xl h-12 px-4 focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none"
              />
              <button
                type="submit"
                className="bg-brand-orange hover:bg-brand-orange/90 text-white font-bold px-6 h-12 rounded-xl transition-colors whitespace-nowrap"
              >
                Get 10% Off
              </button>
            </form>
          )}
        </ScrollReveal>
      </div>
    </section>
  );
}
