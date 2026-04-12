"use client";

import { useState, useEffect } from "react";
import {
  hasAnalyticsOptOut,
  optOutAnalytics,
  optInAnalytics,
} from "@/lib/cookies/consent";
import { revokeAnalyticsConsent, grantAnalyticsConsent } from "@/lib/analytics/gtag";
import { grantClarityConsent, revokeClarityConsent } from "@/lib/analytics/clarity";

export function CookieSettings() {
  const [analyticsEnabled, setAnalyticsEnabled] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setAnalyticsEnabled(!hasAnalyticsOptOut());
  }, []);

  const handleToggle = () => {
    const newValue = !analyticsEnabled;
    setAnalyticsEnabled(newValue);

    if (newValue) {
      optInAnalytics();
      grantAnalyticsConsent();
      grantClarityConsent();
    } else {
      optOutAnalytics();
      revokeAnalyticsConsent();
      revokeClarityConsent();
    }

    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 not-prose">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-gray-900">Analytics Cookies</p>
          <p className="text-sm text-gray-500">
            Google Analytics and Microsoft Clarity help us understand how you use the site.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-sm text-green-600 font-medium">Saved</span>
          )}
          <button
            onClick={handleToggle}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              analyticsEnabled ? "bg-brand-orange" : "bg-gray-300"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                analyticsEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
