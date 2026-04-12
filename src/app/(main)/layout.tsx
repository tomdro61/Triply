import "../globals.css";
import { CookieBanner } from "@/components/shared";
import { ChatProvider, ChatBubble } from "@/components/chat";
import { AnalyticsProvider } from "@/components/analytics/analytics-provider";

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
    </ChatProvider>
  );
}
