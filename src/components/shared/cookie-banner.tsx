"use client";

import { useState, useEffect } from "react";
import { getConsent, setConsent, hasConsent } from "@/lib/cookies/consent";
import { updateGtagConsent } from "@/lib/analytics/gtag";
import { Button } from "@/components/ui/button";

export function CookieBanner() {
  const [show, setShow] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [analytics, setAnalytics] = useState(true);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    // Check if consent already given
    if (!hasConsent()) {
      setShow(true);
    } else {
      const consent = getConsent();
      if (consent) {
        updateGtagConsent(consent.analytics, consent.marketing);
      }
    }
  }, []);

  const handleAcceptAll = () => {
    setConsent({ analytics: true, marketing: true });
    updateGtagConsent(true, true);
    setShow(false);
  };

  const handleAcceptNecessary = () => {
    setConsent({ analytics: false, marketing: false });
    updateGtagConsent(false, false);
    setShow(false);
  };

  const handleSavePreferences = () => {
    setConsent({ analytics, marketing });
    updateGtagConsent(analytics, marketing);
    setShow(false);
    setShowSettings(false);
  };

  if (!show) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 p-4 bg-background border-t shadow-lg">
      <div className="max-w-4xl mx-auto">
        {!showSettings ? (
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <p className="text-sm text-muted-foreground flex-1">
              We use cookies to improve your experience and analyze site
              traffic. By clicking &quot;Accept All&quot;, you consent to our
              use of cookies.{" "}
              <a href="/privacy" className="text-primary underline">
                Privacy Policy
              </a>
            </p>
            <div className="flex gap-2 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSettings(true)}
              >
                Customize
              </Button>
              <Button variant="outline" size="sm" onClick={handleAcceptNecessary}>
                Necessary Only
              </Button>
              <Button size="sm" onClick={handleAcceptAll}>
                Accept All
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <h3 className="font-semibold">Cookie Preferences</h3>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Necessary Cookies</p>
                  <p className="text-sm text-muted-foreground">
                    Required for the site to function
                  </p>
                </div>
                <span className="text-sm text-muted-foreground">Always On</span>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Analytics Cookies</p>
                  <p className="text-sm text-muted-foreground">
                    Help us understand how you use the site
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={analytics}
                  onChange={(e) => setAnalytics(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Marketing Cookies</p>
                  <p className="text-sm text-muted-foreground">
                    Used for targeted advertising
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={marketing}
                  onChange={(e) => setMarketing(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSettings(false)}
              >
                Back
              </Button>
              <Button size="sm" onClick={handleSavePreferences}>
                Save Preferences
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
