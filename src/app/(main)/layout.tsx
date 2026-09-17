import "../globals.css";
import { Suspense } from "react";
import { CookieBanner } from "@/components/shared";
import { ChatProvider, ChatBubble } from "@/components/chat";
import { AnalyticsProvider } from "@/components/analytics/analytics-provider";
import { AttributionCapture } from "@/components/analytics/attribution-capture";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ChatProvider>
      {children}
      <CookieBanner />
      <ChatBubble />
      <AnalyticsProvider />
      {/* Suspense is load-bearing: AttributionCapture uses useSearchParams(),
          which without a boundary would deopt the ISR airport pages to dynamic. */}
      <Suspense fallback={null}>
        <AttributionCapture />
      </Suspense>
    </ChatProvider>
  );
}
