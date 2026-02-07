"use client";

import { useEffect, useRef, useState } from "react";
import { Star, Quote, CheckCircle } from "lucide-react";

interface Testimonial {
  id: number;
  name: string;
  image: string;
  rating: number;
  text: string;
  tripType: string;
  date: string;
}

const testimonials: Testimonial[] = [
  {
    id: 1,
    name: "Sarah Jenkins",
    image: "https://i.pravatar.cc/150?u=sarah-jenkins-triply",
    rating: 5,
    text: "I saved over $150 on my JFK parking for a 10-day trip. The comparison tool made it so easy to find the best deal. Will definitely use again!",
    tripType: "Family Vacation",
    date: "Jan 2026",
  },
  {
    id: 2,
    name: "Michael Chen",
    image: "https://i.pravatar.cc/150?u=michael-chen-triply",
    rating: 5,
    text: "Triply is my go-to for business travel. The interface is clean, and I love being able to compare all my options in one place. Highly recommended.",
    tripType: "Business Trip",
    date: "Jan 2026",
  },
  {
    id: 3,
    name: "Emma Wilson",
    image: "https://i.pravatar.cc/150?u=emma-wilson-triply",
    rating: 5,
    text: "The free cancellation policy gave me peace of mind when my flight plans changed. Customer support was super responsive too!",
    tripType: "Solo Travel",
    date: "Feb 2026",
  },
];

export function Testimonials() {
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
    <section ref={sectionRef} className="py-20 lg:py-24 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-gray-900">
            What Our Travelers Say
          </h2>
          <p className="text-gray-500 mt-3 text-lg">
            Join thousands of happy travelers using Triply
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {testimonials.map((review, index) => (
            <div
              key={review.id}
              className={`bg-gray-50 p-8 rounded-2xl relative hover:shadow-lg transition-shadow shadow-sm group ${
                isVisible ? "animate-fade-in-up" : "opacity-0"
              }`}
              style={{
                animationDelay: isVisible ? `${index * 150}ms` : "0ms",
                animationFillMode: "forwards",
              }}
            >
              <Quote className="absolute top-6 right-6 text-brand-orange opacity-20 w-10 h-10 group-hover:opacity-30 transition-opacity" />

              <div className="flex items-center mb-4">
                <img
                  src={review.image}
                  alt={review.name}
                  className="w-12 h-12 rounded-full border-2 border-white shadow-sm mr-4"
                />
                <div>
                  <h4 className="font-bold text-gray-900">{review.name}</h4>
                  <div className="flex items-center text-xs text-green-600 font-medium">
                    <CheckCircle size={12} className="mr-1" /> Verified Traveler
                  </div>
                </div>
              </div>

              <div className="flex mb-4">
                {[...Array(5)].map((_, i) => (
                  <Star
                    key={i}
                    size={16}
                    className={`${
                      i < review.rating
                        ? "text-yellow-400 fill-yellow-400"
                        : "text-gray-300"
                    }`}
                  />
                ))}
              </div>

              <p className="text-gray-700 mb-6 leading-relaxed">
                &ldquo;{review.text}&rdquo;
              </p>

              <div className="border-t border-gray-200 pt-4 flex justify-between text-xs text-gray-500 font-medium uppercase tracking-wide">
                <span>{review.tripType}</span>
                <span>{review.date}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <button className="px-8 py-3 border-2 border-brand-orange text-brand-orange rounded-full font-bold hover:bg-brand-orange hover:text-white transition-colors animate-subtle-pulse">
            View More Reviews
          </button>
        </div>
      </div>
    </section>
  );
}
