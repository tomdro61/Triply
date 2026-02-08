"use client";

import { Star } from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";

interface Testimonial {
  id: number;
  name: string;
  image: string;
  rating: number;
  text: string;
  tripType: string;
}

const testimonials: Testimonial[] = [
  {
    id: 1,
    name: "Sarah Jenkins",
    image: "https://i.pravatar.cc/150?u=sarah-jenkins-triply",
    rating: 5,
    text: "I saved over $150 on my JFK parking for a 10-day trip. The comparison tool made it so easy to find the best deal. Will definitely use again!",
    tripType: "Family Vacation",
  },
  {
    id: 2,
    name: "Michael Chen",
    image: "https://i.pravatar.cc/150?u=michael-chen-triply",
    rating: 5,
    text: "Triply is my go-to for business travel. The interface is clean, and I love being able to compare all my options in one place. Highly recommended.",
    tripType: "Business Trip",
  },
  {
    id: 3,
    name: "Emma Wilson",
    image: "https://i.pravatar.cc/150?u=emma-wilson-triply",
    rating: 5,
    text: "The free cancellation policy gave me peace of mind when my flight plans changed. Customer support was super responsive too!",
    tripType: "Solo Travel",
  },
];

export function TestimonialsRedesign() {
  return (
    <section className="py-16 lg:py-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <ScrollReveal className="text-center mb-12">
          <p className="text-brand-orange font-bold text-sm uppercase tracking-wider mb-3">
            Testimonials
          </p>
          <h2 className="text-3xl md:text-4xl font-bold text-gray-900">
            Loved by Travelers
          </h2>
        </ScrollReveal>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {testimonials.map((review, index) => (
            <ScrollReveal key={review.id} delay={index * 0.15}>
              <div className="bg-white rounded-2xl p-8 shadow-sm hover:shadow-lg transition-shadow border border-gray-100 h-full flex flex-col">
                {/* Decorative quote */}
                <span className="text-brand-orange/20 text-6xl font-serif leading-none select-none">
                  &ldquo;
                </span>

                {/* Stars */}
                <div className="flex gap-0.5 mt-2 mb-4">
                  {[...Array(5)].map((_, i) => (
                    <Star
                      key={i}
                      size={16}
                      className={
                        i < review.rating
                          ? "text-yellow-400 fill-yellow-400"
                          : "text-gray-300"
                      }
                    />
                  ))}
                </div>

                {/* Quote text */}
                <p className="text-gray-700 leading-relaxed text-[15px] flex-1">
                  {review.text}
                </p>

                {/* Author */}
                <div className="flex items-center gap-3 mt-6 pt-5 border-t border-gray-100">
                  <img
                    src={review.image}
                    alt={review.name}
                    className="w-10 h-10 rounded-full object-cover"
                  />
                  <div>
                    <p className="font-bold text-gray-900 text-sm">{review.name}</p>
                    <p className="text-gray-500 text-xs">{review.tripType}</p>
                  </div>
                </div>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
