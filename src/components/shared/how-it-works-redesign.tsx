"use client";

import { useEffect, useRef, useState } from "react";
import { Search, MousePointerClick, CreditCard, Plane, ArrowRight } from "lucide-react";

interface Step {
  number: number;
  title: string;
  description: string;
  icon: React.ElementType;
}

const steps: Step[] = [
  {
    number: 1,
    title: "Search",
    description: "Enter your airport and travel dates to see all options",
    icon: Search,
  },
  {
    number: 2,
    title: "Compare",
    description: "Filter by price, distance, and amenities",
    icon: MousePointerClick,
  },
  {
    number: 3,
    title: "Book",
    description: "Secure checkout with instant confirmation",
    icon: CreditCard,
  },
  {
    number: 4,
    title: "Travel",
    description: "Park and catch your flight stress-free",
    icon: Plane,
  },
];

export function HowItWorksRedesign() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
        }
      },
      { threshold: 0.2 }
    );

    if (sectionRef.current) {
      observer.observe(sectionRef.current);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      className="py-20 lg:py-24 relative overflow-hidden"
      style={{
        backgroundImage: `url('https://images.unsplash.com/photo-1436491865332-7a61a109db05?auto=format&fit=crop&w=2000&q=80')`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {/* Dark overlay */}
      <div className="absolute inset-0 bg-[#1A1A2E]/[0.92]" />

      {/* Subtle background decoration */}
      <div className="absolute inset-0">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-brand-orange/5 rounded-full blur-3xl" />
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        {/* Header */}
        <div className="text-center mb-16">
          <span className="inline-block text-brand-orange font-bold text-sm uppercase tracking-wider mb-3">
            How It Works
          </span>
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-white">
            Book in 4 Simple Steps
          </h2>
        </div>

        {/* Steps */}
        <div className="relative">
          {/* Connecting line - desktop only */}
          <div className="hidden lg:block absolute top-16 left-[12%] right-[12%] h-0.5 bg-gradient-to-r from-brand-orange/20 via-brand-orange/40 to-brand-orange/20" />

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 lg:gap-6">
            {steps.map((step, index) => {
              const Icon = step.icon;

              return (
                <div
                  key={step.number}
                  className={`relative text-center group ${
                    isVisible ? "animate-fade-in-up" : "opacity-0"
                  }`}
                  style={{
                    animationDelay: isVisible ? `${index * 100}ms` : "0ms",
                    animationFillMode: "forwards",
                  }}
                >
                  {/* Icon Circle */}
                  <div className="relative inline-flex mb-6">
                    <div className="w-32 h-32 rounded-full bg-white/5 border border-white/10 flex items-center justify-center group-hover:bg-brand-orange/10 group-hover:border-brand-orange/30 transition-all duration-300">
                      <div className="w-20 h-20 rounded-full bg-brand-orange/10 flex items-center justify-center group-hover:bg-brand-orange group-hover:scale-110 transition-all duration-300">
                        <Icon className="w-9 h-9 text-brand-orange group-hover:text-white transition-colors duration-300" />
                      </div>
                    </div>

                    {/* Step Number */}
                    <div className="absolute -top-1 -right-1 w-9 h-9 bg-brand-orange rounded-full flex items-center justify-center shadow-lg shadow-brand-orange/30">
                      <span className="font-bold text-white text-sm">{step.number}</span>
                    </div>
                  </div>

                  {/* Content */}
                  <h3 className="text-xl font-bold text-white mb-2">{step.title}</h3>
                  <p className="text-gray-400 text-sm leading-relaxed max-w-[200px] mx-auto">
                    {step.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Bottom CTA */}
        <div className="text-center mt-16">
          <button
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="inline-flex items-center gap-2 bg-brand-orange text-white font-bold px-8 py-4 rounded-full hover:bg-white hover:text-brand-dark transition-all duration-300 shadow-lg shadow-brand-orange/30 hover:shadow-xl hover:scale-105 cursor-pointer"
          >
            Find Parking Now
            <ArrowRight size={20} />
          </button>
        </div>
      </div>

    </section>
  );
}
