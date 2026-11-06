import ContactPageClient from "./contact-page-client";

/**
 * Server wrapper so the form knows — without NEXT_PUBLIC flags — whether
 * online cancellation is on (only then does it tell people they can cancel
 * themselves) and whether the support inbox is on (only then does it ask for a
 * reservation number: with the inbox off the route would not use it).
 */
export default function ContactPage() {
  return (
    <ContactPageClient
      selfCancelEnabled={process.env.ENABLE_SELF_SERVE_CANCEL === "true"}
      supportInboxEnabled={process.env.ENABLE_SUPPORT_INBOX === "true"}
    />
  );
}
