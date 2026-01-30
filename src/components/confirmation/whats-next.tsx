"use client";

import {
  Car,
  QrCode,
  Bus,
  Plane,
  Clock,
  Phone,
  HelpCircle,
} from "lucide-react";
import { UnifiedLot } from "@/types/lot";

interface WhatsNextProps {
  lot: UnifiedLot;
  checkIn: string;
  checkInTime?: string;
}

export function WhatsNext({ lot, checkIn, checkInTime = "10:00 AM" }: WhatsNextProps) {
  const checkInDate = new Date(checkIn + "T00:00:00");
  const formattedDate = checkInDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const steps = [
    {
      icon: Car,
      title: "Arrive at the Facility",
      description: `On ${formattedDate} at ${checkInTime}, drive to ${lot.name}. Follow signs for check-in parking.`,
      color: "bg-blue-100 text-blue-600",
    },
    {
      icon: QrCode,
      title: "Scan Your QR Code",
      description:
        "At the entrance gate, scan your QR code or enter your confirmation number for quick access.",
      color: "bg-purple-100 text-purple-600",
    },
    {
      icon: Bus,
      title: "Take the Shuttle",
      description:
        lot.shuttleInfo?.summary ||
        "Board the complimentary shuttle to your terminal. Shuttles run frequently.",
      color: "bg-green-100 text-green-600",
    },
    {
      icon: Plane,
      title: "Enjoy Your Trip!",
      description:
        "Your vehicle is safe and secure. Focus on your journey and we'll see you when you return.",
      color: "bg-brand-orange/20 text-brand-orange",
    },
  ];

  const tips = [
    {
      icon: Clock,
      text: "Arrive 15-20 minutes before you need to be at the terminal",
    },
    {
      icon: Phone,
      text: `Keep your confirmation number handy: it's your ticket`,
    },
  ];

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <h3 className="font-bold text-gray-900 text-lg mb-6">What's Next</h3>

      {/* Steps */}
      <div className="space-y-4 mb-8">
        {steps.map((step, index) => (
          <div key={index} className="flex gap-4">
            <div
              className={`w-10 h-10 rounded-full ${step.color} flex items-center justify-center shrink-0`}
            >
              <step.icon size={20} />
            </div>
            <div>
              <h4 className="font-semibold text-gray-900">{step.title}</h4>
              <p className="text-sm text-gray-600">{step.description}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Tips */}
      <div className="bg-amber-50 rounded-lg p-4 border border-amber-100">
        <h4 className="font-semibold text-amber-800 mb-3 flex items-center gap-2">
          <HelpCircle size={18} />
          Helpful Tips
        </h4>
        <ul className="space-y-2">
          {tips.map((tip, index) => (
            <li key={index} className="flex items-start gap-2 text-sm text-amber-700">
              <tip.icon size={16} className="shrink-0 mt-0.5" />
              <span>{tip.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Contact Support */}
      <div className="mt-6 pt-6 border-t border-gray-200">
        <p className="text-sm text-gray-600 mb-3">
          Questions about your reservation?
        </p>
        <div className="flex flex-wrap gap-3">
          <a
            href="/help"
            className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors"
          >
            <HelpCircle size={16} />
            Help Center
          </a>
          {lot.phone && (
            <a
              href={`tel:${lot.phone}`}
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors"
            >
              <Phone size={16} />
              Call Facility
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
