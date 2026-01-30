import Image from "next/image";
import { Search, CheckCircle2, Zap, ShieldCheck } from "lucide-react";

export function HowItWorks() {
  const steps = [
    {
      title: "Search & Compare",
      description:
        "Compare prices for parking options near major airports all in one place.",
      icon: Search,
    },
    {
      title: "Select Your Spot",
      description:
        "Choose the best deals based on price, distance, and amenities.",
      icon: CheckCircle2,
    },
    {
      title: "Book Instantly",
      description:
        "Get instant confirmation with free cancellation up to 24 hours before your trip.",
      icon: Zap,
    },
    {
      title: "Travel With Confidence",
      description:
        "Your spot is reserved. We handle the details so you can focus on your journey.",
      icon: ShieldCheck,
    },
  ];

  return (
    <section className="py-24 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          {/* Left Column: Steps */}
          <div className="order-2 lg:order-1">
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-12 leading-tight">
              Streamline your travel planning from search to booking
            </h2>

            <div className="space-y-12 relative">
              {/* Vertical Line */}
              <div className="absolute left-6 top-8 bottom-8 w-0.5 bg-gray-200 hidden md:block"></div>

              {steps.map((step, index) => (
                <div key={index} className="relative flex items-start group">
                  {/* Icon Bubble */}
                  <div className="flex-shrink-0 relative z-10">
                    <div className="w-12 h-12 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center group-hover:border-brand-orange group-hover:scale-110 transition-all duration-300">
                      <step.icon className="text-brand-orange w-6 h-6" />
                    </div>
                  </div>

                  {/* Text */}
                  <div className="ml-6 pt-1">
                    <h3 className="text-xl font-bold text-gray-900 mb-2">
                      {step.title}
                    </h3>
                    <p className="text-gray-600 leading-relaxed">
                      {step.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right Column: Image Grid */}
          <div className="order-1 lg:order-2 grid grid-cols-2 gap-4">
            <div className="relative h-48 rounded-2xl shadow-lg overflow-hidden transform translate-y-8 hover:scale-105 transition-transform duration-500">
              <Image
                src="https://images.unsplash.com/photo-1470224114660-3f6686c562eb?auto=format&fit=crop&w=600&q=80"
                alt="Airport Parking"
                fill
                className="object-cover"
              />
            </div>
            <div className="relative h-48 rounded-2xl shadow-lg overflow-hidden hover:scale-105 transition-transform duration-500">
              <Image
                src="https://images.unsplash.com/photo-1512428559087-560fa5ce7d87?auto=format&fit=crop&w=600&q=80"
                alt="Mobile Booking"
                fill
                className="object-cover"
              />
            </div>
            <div className="relative h-48 rounded-2xl shadow-lg overflow-hidden transform translate-y-8 hover:scale-105 transition-transform duration-500">
              <Image
                src="https://images.unsplash.com/photo-1523906834658-6e24ef2386f9?auto=format&fit=crop&w=600&q=80"
                alt="Traveler at Airport"
                fill
                className="object-cover"
              />
            </div>
            <div className="relative h-48 rounded-2xl shadow-lg overflow-hidden hover:scale-105 transition-transform duration-500">
              <Image
                src="https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=600&q=80"
                alt="Airplane Taking Off"
                fill
                className="object-cover"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
