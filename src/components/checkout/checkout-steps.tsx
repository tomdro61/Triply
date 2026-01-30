"use client";

import { Check, User, Car, CreditCard } from "lucide-react";
import { CheckoutStep } from "@/types/checkout";

interface CheckoutStepsProps {
  currentStep: CheckoutStep;
}

const steps = [
  { id: "details" as CheckoutStep, label: "Your Details", icon: User },
  { id: "vehicle" as CheckoutStep, label: "Vehicle Info", icon: Car },
  { id: "payment" as CheckoutStep, label: "Payment", icon: CreditCard },
];

export function CheckoutSteps({ currentStep }: CheckoutStepsProps) {
  const currentIndex = steps.findIndex((s) => s.id === currentStep);

  return (
    <div className="flex items-center justify-center mb-8">
      {steps.map((step, index) => {
        const isCompleted = index < currentIndex;
        const isCurrent = step.id === currentStep;
        const isUpcoming = index > currentIndex;

        return (
          <div key={step.id} className="flex items-center">
            {/* Step Circle */}
            <div className="flex flex-col items-center">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                  isCompleted
                    ? "bg-green-500 text-white"
                    : isCurrent
                    ? "bg-brand-orange text-white"
                    : "bg-gray-200 text-gray-500"
                }`}
              >
                {isCompleted ? (
                  <Check size={20} strokeWidth={3} />
                ) : (
                  <step.icon size={20} />
                )}
              </div>
              <span
                className={`mt-2 text-xs font-medium ${
                  isCurrent
                    ? "text-brand-orange"
                    : isCompleted
                    ? "text-green-600"
                    : "text-gray-500"
                }`}
              >
                {step.label}
              </span>
            </div>

            {/* Connector Line */}
            {index < steps.length - 1 && (
              <div
                className={`w-16 sm:w-24 h-1 mx-2 rounded ${
                  index < currentIndex ? "bg-green-500" : "bg-gray-200"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
