"use client";

import Link from "next/link";
import { ShieldCheck, FileText } from "lucide-react";

interface ProtectionPlanStatusProps {
  planName: string;
  price: number;
  /**
   * Park Guard's identifier for the reservation. When null, the customer
   * paid the premium but Park Guard hasn't acknowledged the booking yet —
   * either pending sync or skipped (missing data). The claim CTA is hidden
   * in that state because clicking it leads to a confused PG support call.
   */
  pgIdentifier: string | null;
}

const CLAIM_URL = "https://www.parkguardcoveragehub.com/triplyproclaims";
const TERMS_URL = "https://www.parkguard.com/terms-of-use-triplypro";

export function ProtectionPlanStatus({
  planName,
  price,
  pgIdentifier,
}: ProtectionPlanStatusProps) {
  const isActive = pgIdentifier !== null;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <div className="flex items-start gap-3 mb-4">
        <ShieldCheck size={24} className="text-emerald-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="font-semibold text-gray-900">
              {isActive ? "Parking Protection Active" : "Parking Protection Pending"}
            </h3>
            <span className="text-sm font-medium text-gray-700">
              ${price.toFixed(2)}
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-1">
            {isActive
              ? `Your booking includes the ${planName} plan. If your vehicle is damaged or something is stolen while parked at the lot, you can file a claim with Park Guard.`
              : `Your booking includes the ${planName} plan. We're finalizing your protection record with Park Guard. If you need to file a claim before your trip, please contact support@triplypro.com so we can confirm your protection is active.`}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 ml-9">
        {isActive && (
          <Link
            href={CLAIM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors"
          >
            <FileText size={16} />
            Start a Claim
          </Link>
        )}
        <Link
          href={TERMS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
        >
          View Full Terms
        </Link>
      </div>
    </div>
  );
}
