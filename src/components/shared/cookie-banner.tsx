"use client";

import { useState, useEffect } from "react";
import { isBannerDismissed, dismissBanner } from "@/lib/cookies/consent";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export function CookieBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isBannerDismissed()) {
      setShow(true);
    }
  }, []);

  const handleDismiss = () => {
    dismissBanner();
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 p-4 bg-background border-t shadow-lg">
      <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <p className="text-sm text-muted-foreground flex-1">
          We use cookies to improve your experience and analyze site traffic. By
          continuing to browse, you consent to our use of cookies.{" "}
          <Link href="/privacy" className="text-primary underline">
            Privacy Policy
          </Link>
        </p>
        <Button size="sm" onClick={handleDismiss}>
          Got it
        </Button>
      </div>
    </div>
  );
}
