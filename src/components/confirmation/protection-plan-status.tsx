"use client";

import Link from "next/link";
import { ShieldCheck, ShieldAlert, FileText } from "lucide-react";

export type PgSyncStatus = "pending" | "synced" | "skipped_missing_data" | null;

interface ProtectionPlanStatusProps {
  planName: string;
  price: number;
  pgSyncStatus: PgSyncStatus;
  pgIdentifier: string | null;
}

// Triply-controlled redirect (next.config.mjs) → Park Guard claim portal.
// Keeps the customer-visible URL on triplypro.com so the third-party domain
// containing "coverage" never appears in browser status bars / copied links.
const CLAIM_URL = "/claims";
const TERMS_URL = "https://www.parkguard.com/terms-of-use-triplypro";

// Render policy:
//   synced AND pgIdentifier  → "Active". PG holds the enrollment; claim link
//                              works.
//   everything else          → "Confirming with our partner". Includes:
//                              - null / pending / skipped_missing_data states
//                              - the captured-then-cancelled state
//                                (pgSyncStatus='synced' BUT pgIdentifier=null),
//                                which the webhook partial-refund branch
//                                produces after PG cancellation; PG already
//                                rejected the enrollment, so the claim link
//                                would 404 — route the customer to support.
export function ProtectionPlanStatus({
  planName,
  price,
  pgSyncStatus,
  pgIdentifier,
}: ProtectionPlanStatusProps) {
  const isUnconfirmed = pgSyncStatus !== "synced" || !pgIdentifier;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <div className="flex items-start gap-3 mb-4">
        {isUnconfirmed ? (
          <ShieldAlert size={24} className="text-amber-600 flex-shrink-0 mt-0.5" />
        ) : (
          <ShieldCheck size={24} className="text-emerald-600 flex-shrink-0 mt-0.5" />
        )}
        <div className="flex-1">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="font-semibold text-gray-900">
              {isUnconfirmed ? "Parking Protection — Confirming" : "Parking Protection Active"}
            </h3>
            <span className="text-sm font-medium text-gray-700">
              ${price.toFixed(2)}
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-1">
            {isUnconfirmed ? (
              <>
                You purchased the {planName} plan. We&apos;re still confirming it with our partner — if you need to file a claim, please contact our support team and we&apos;ll get it sorted.
              </>
            ) : (
              <>
                Your booking includes the {planName} plan. If your vehicle is damaged or something is stolen while parked at the lot, you can file a claim with Park Guard.
              </>
            )}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 ml-9">
        <Link
          href={isUnconfirmed ? "mailto:support@triplypro.com" : CLAIM_URL}
          target={isUnconfirmed ? undefined : "_blank"}
          rel={isUnconfirmed ? undefined : "noopener noreferrer"}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors"
        >
          <FileText size={16} />
          {isUnconfirmed ? "Contact Support" : "Start a Claim"}
        </Link>
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
