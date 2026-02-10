"use client";

import { useState } from "react";
import { Mail, ArrowRight, Check, Tag, Bell, Lightbulb, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function Newsletter() {
  const [email, setEmail] = useState("");
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to subscribe");
      }

      setIsSubmitted(true);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const benefits = [
    { icon: Tag, text: "Weekly exclusive deals" },
    { icon: Bell, text: "New lot alerts" },
    { icon: Lightbulb, text: "Travel tips & guides" },
  ];

  return (
    <section
      className="relative overflow-hidden"
      style={{
        backgroundImage: `url('https://images.unsplash.com/photo-1464037866556-6812c9d1c72e?auto=format&fit=crop&w=2000&q=80')`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {/* Dark overlay fading to solid brand-dark at bottom for seamless footer transition */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#1A1A2E]/85 via-[#1A1A2E]/90 to-[#1A1A2E]" />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 relative z-10 pt-20 lg:pt-24 pb-16">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-brand-orange/20 mb-6">
            <Mail className="w-7 h-7 text-brand-orange" />
          </div>

          <h2 className="text-3xl md:text-4xl font-bold text-white mb-3">
            Get 10% Off Your First Booking
          </h2>
          <p className="text-gray-400 mb-8 max-w-lg mx-auto">
            Subscribe to our newsletter for exclusive deals and travel tips.
          </p>

          {/* Benefits */}
          <div className="flex flex-wrap justify-center gap-4 md:gap-8 mb-8">
            {benefits.map((benefit, idx) => (
              <div key={idx} className="flex items-center text-gray-300 text-sm">
                <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center mr-2">
                  <benefit.icon size={14} className="text-brand-orange" />
                </div>
                {benefit.text}
              </div>
            ))}
          </div>

          {isSubmitted ? (
            <div className="flex items-center justify-center space-x-2 text-green-400 bg-green-500/10 border border-green-500/20 rounded-full py-4 px-6 animate-fade-in max-w-md mx-auto">
              <Check className="w-6 h-6" />
              <span className="font-medium">Check your email for your 10% off code!</span>
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto"
            >
              <Input
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(null); }}
                className="flex-1 bg-white/10 border-white/20 text-white placeholder:text-gray-400 focus:border-brand-orange focus:ring-brand-orange h-12"
                required
                disabled={isLoading}
              />
              <Button
                type="submit"
                className="bg-brand-orange hover:bg-brand-orange/90 text-white font-bold px-6 h-12"
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    Get 10% Off
                    <ArrowRight className="ml-2 w-4 h-4" />
                  </>
                )}
              </Button>
            </form>
          )}
          {error && (
            <p className="text-red-400 text-sm mt-2">{error}</p>
          )}

          <p className="text-gray-500 text-sm mt-5">
            Join 5,000+ smart travelers. No spam, unsubscribe anytime.
          </p>
        </div>
      </div>

      {/* Divider */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-16 relative z-10">
        <div className="border-t border-gray-700/50" />
      </div>
    </section>
  );
}
