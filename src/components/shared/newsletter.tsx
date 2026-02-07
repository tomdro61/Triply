"use client";

import { useState } from "react";
import { Mail, ArrowRight, Check, Tag, Bell, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function Newsletter() {
  const [email, setEmail] = useState("");
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email) {
      setIsSubmitted(true);
      setEmail("");
    }
  };

  const benefits = [
    { icon: Tag, text: "Weekly exclusive deals" },
    { icon: Bell, text: "New lot alerts" },
    { icon: Lightbulb, text: "Travel tips & guides" },
  ];

  return (
    <section className="pt-20 lg:pt-24 pb-16 bg-brand-dark">
      <div className="max-w-4xl mx-auto px-4 sm:px-6">
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
              <span className="font-medium">Thanks for subscribing! Check your email for your 10% off code.</span>
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
                onChange={(e) => setEmail(e.target.value)}
                className="flex-1 bg-white/10 border-white/20 text-white placeholder:text-gray-400 focus:border-brand-orange focus:ring-brand-orange h-12"
                required
              />
              <Button
                type="submit"
                className="bg-brand-orange hover:bg-brand-orange/90 text-white font-bold px-6 h-12"
              >
                Get 10% Off
                <ArrowRight className="ml-2 w-4 h-4" />
              </Button>
            </form>
          )}

          <p className="text-gray-500 text-sm mt-5">
            Join 5,000+ smart travelers. No spam, unsubscribe anytime.
          </p>
        </div>
      </div>

      {/* Divider */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-16">
        <div className="border-t border-gray-700/50" />
      </div>
    </section>
  );
}
