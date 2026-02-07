"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Car, Hotel, Bus, Package } from "lucide-react";

export function FeatureCards() {
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

  const features = [
    {
      title: "Airport Parking",
      description: "Secure, guaranteed spots at unbeatable rates near major hubs.",
      icon: Car,
      link: "#parking",
      color: "text-brand-orange",
    },
    {
      title: "Hotels",
      description: "Cozy stays, business suites, and luxury resorts for every budget.",
      icon: Hotel,
      link: "#hotels",
      color: "text-brand-blue",
    },
    {
      title: "Transfers",
      description: "Reliable shuttles and private rides to get you to your destination.",
      icon: Bus,
      link: "#transfers",
      color: "text-green-500",
    },
    {
      title: "Bundles",
      description: "Combine parking and hotel stays to save up to 40% instantly.",
      icon: Package,
      link: "#bundles",
      color: "text-purple-500",
    },
  ];

  return (
    <section ref={sectionRef} className="py-16 lg:py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, index) => (
            <Link
              key={index}
              href={feature.link}
              className={`group bg-white rounded-xl p-6 border border-gray-100 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-500 ease-out transform-gpu cursor-pointer block ${
                isVisible ? "animate-fade-in-up" : "opacity-0"
              }`}
              style={{
                animationDelay: isVisible ? `${index * 100}ms` : "0ms",
                animationFillMode: "forwards",
              }}
            >
              <div className="w-full h-28 flex items-center justify-center mb-4 overflow-visible">
                <div
                  className={`w-20 h-20 rounded-2xl bg-gray-50 flex items-center justify-center group-hover:scale-110 transition-transform duration-300 ${feature.color}`}
                >
                  <feature.icon size={40} strokeWidth={1.5} />
                </div>
              </div>

              <h3 className="text-xl font-bold text-gray-900 mb-2 text-center group-hover:text-brand-orange transition-colors">
                {feature.title}
              </h3>

              <p className="text-gray-500 text-sm mb-6 leading-relaxed text-center">
                {feature.description}
              </p>

              <div className="flex items-center justify-center text-brand-orange font-semibold text-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300 transform translate-y-2 group-hover:translate-y-0">
                <span className="mr-2">View Options</span>
                <ArrowRight size={16} />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
