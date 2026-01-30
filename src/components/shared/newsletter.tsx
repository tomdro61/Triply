"use client";

import { useState } from "react";
import { Mail, ArrowRight, Check } from "lucide-react";
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

  return (
    <section className="py-20 bg-brand-dark">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-brand-orange/20 mb-6">
          <Mail className="w-8 h-8 text-brand-orange" />
        </div>

        <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
          Get Exclusive Deals
        </h2>
        <p className="text-gray-400 mb-8 max-w-xl mx-auto">
          Subscribe to our newsletter and be the first to know about special
          offers, new parking locations, and travel tips.
        </p>

        {isSubmitted ? (
          <div className="flex items-center justify-center space-x-2 text-green-400 animate-fade-in">
            <Check className="w-6 h-6" />
            <span className="font-medium">Thanks for subscribing!</span>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="flex flex-col sm:flex-row gap-4 max-w-md mx-auto"
          >
            <Input
              type="email"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1 bg-white/10 border-white/20 text-white placeholder:text-gray-400 focus:border-brand-orange focus:ring-brand-orange"
              required
            />
            <Button
              type="submit"
              className="bg-brand-orange hover:bg-brand-orange/90 text-white font-bold px-6"
            >
              Subscribe
              <ArrowRight className="ml-2 w-4 h-4" />
            </Button>
          </form>
        )}

        <p className="text-gray-500 text-sm mt-4">
          No spam, unsubscribe anytime.
        </p>
      </div>
    </section>
  );
}
