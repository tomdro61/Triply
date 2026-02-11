/**
 * Knowledge base for Triply AI chat assistant.
 *
 * Contains all static site content baked into the system prompt
 * so the AI can answer common questions instantly without tool calls.
 *
 * When FAQ content or policies change on the site, update here too.
 */

import { enabledAirports } from "@/config/airports";

export function getKnowledgeBase(): string {
  const airportList = enabledAirports
    .map((a) => `${a.code} — ${a.name} (${a.city}, ${a.state})`)
    .join("\n  ");

  return `
=== TRIPLY KNOWLEDGE BASE ===

== ABOUT TRIPLY ==
Triply is an airport parking aggregator that helps travelers find and book affordable parking near airports. Our mission is to simplify the travel experience by offering transparent pricing and a seamless booking process.

Key facts:
- Tagline: "Your Trip Simplified"
- Customers save an average of 60% compared to on-site airport parking
- Founded on values of Transparency, Trust, and Simplicity
- Triply acts as an intermediary between customers and parking facility operators

== SUPPORTED AIRPORTS ==
  ${airportList || "No airports currently configured"}

Important: Only confirm coverage for airports listed above. If asked about an airport we don't cover, honestly say we don't currently serve that airport and suggest contacting support for updates on expansion.

== HOW BOOKING WORKS ==
1. Search — Enter your airport, travel dates, and times
2. Compare — Browse available parking lots, compare prices, amenities, and distance from the airport
3. Book — Select your preferred lot and complete checkout with secure payment
4. Park — Arrive at the facility, show your confirmation QR code, park your car, and take the free shuttle to the terminal

== FAQ: BOOKING & RESERVATIONS ==
Q: How do I make a reservation?
A: Enter your airport, travel dates, and times on our homepage or search page. Browse available parking options, select your preferred lot, and complete the checkout process. You'll receive a confirmation email with all the details you need.

Q: Can I modify my reservation?
A: Yes, you can modify your reservation up to 24 hours before your scheduled check-in time. Log into your account, go to My Reservations, and select the booking you want to modify. Changes may affect pricing based on availability.

Q: How do I cancel my reservation?
A: Log into your account and go to My Reservations. Select the booking you want to cancel and click "Cancel Reservation". Cancellations made more than 24 hours before check-in receive a full refund. Cancellations within 24 hours may be subject to a cancellation fee.

Q: What if I need to extend my parking?
A: Contact the parking facility directly using the phone number on your confirmation. Extensions are subject to availability and will be charged at the daily rate.

Q: Do I need to print my confirmation?
A: No, you don't need to print anything. Simply show your confirmation email or the QR code from your booking on your phone when you arrive at the parking facility.

== FAQ: PAYMENT & PRICING ==
Q: What payment methods do you accept?
A: We accept all major credit cards (Visa, Mastercard, American Express, Discover), as well as Apple Pay and Google Pay for a seamless checkout experience. All payments are processed securely through Stripe.

Q: When will I be charged?
A: Your card is charged at the time of booking. The amount includes all taxes and fees with no hidden charges. Some facilities may place a hold for incidentals which is released after your stay.

Q: Are there any hidden fees?
A: No, the price you see is the price you pay. All taxes, fees, and charges are included in the total shown at checkout. We believe in transparent pricing.

Q: How do promo codes work?
A: Enter your promo code during checkout in the designated field. Valid codes will automatically apply the discount to your total. Promo codes cannot be combined and have specific terms and expiration dates.

Q: What is your refund policy?
A: Cancellations made more than 24 hours before your check-in time receive a full refund. Cancellations within 24 hours may incur a fee. Refunds are processed within 5-7 business days to your original payment method.

== FAQ: PARKING & CHECK-IN ==
Q: How do I find the parking facility?
A: Your confirmation email includes the facility address and a link to get directions via Google Maps. Most facilities also have clear signage near the airport. You can also access directions from your booking confirmation page.

Q: What do I do when I arrive?
A: Show your confirmation QR code or email to the attendant. They'll verify your reservation and direct you to park your vehicle. Some facilities have self-service kiosks where you can scan your QR code.

Q: How does the shuttle service work?
A: Most of our partner facilities offer free shuttle service to and from the airport terminal. Shuttles typically run every 10-15 minutes. Check your specific facility's details for shuttle schedule and pickup locations.

Q: What if I arrive earlier or later than my reservation?
A: Most facilities accommodate early arrivals and late returns within reason. However, if you arrive significantly earlier, you may be charged for the additional time. Contact the facility if you expect major changes to your schedule.

Q: Is my vehicle safe?
A: All our partner facilities have security measures including surveillance cameras, security patrols, and well-lit areas. Many offer covered or indoor parking options for additional protection.

== FAQ: SAFETY & SECURITY ==
Q: Is my personal information secure?
A: Yes, we use industry-standard SSL encryption to protect your personal and payment information. We never store your full credit card details on our servers. Your data is handled in compliance with privacy regulations.

Q: What if my car is damaged while parked?
A: All our partner facilities carry liability insurance. If you notice any damage, report it immediately to the facility staff before leaving. Document the damage with photos and obtain an incident report.

Q: Are the parking facilities insured?
A: Yes, all parking facilities we partner with are required to maintain adequate insurance coverage. However, we recommend checking your own auto insurance policy for coverage details during third-party parking.

Q: What items should I remove from my car?
A: Remove all valuables, electronics, and important documents from your vehicle. While facilities have security measures, it's best practice to not leave tempting items visible in your car.

== FAQ: ACCOUNT & SUPPORT ==
Q: Do I need an account to book?
A: No, you can book as a guest without creating an account. However, creating an account lets you easily view and manage your reservations, save your information for faster checkout, and access exclusive deals.

Q: How do I reset my password?
A: Click "Forgot your password?" on the login page and enter your email address. We'll send you a link to reset your password. The link expires after 24 hours for security.

Q: How can I contact customer support?
A: You can reach us by email at support@triplypro.com. Our support team responds within 24-48 hours. For urgent parking issues, contact the facility directly using the number on your confirmation.

Q: Where can I see my past reservations?
A: Log into your account and go to My Reservations. You'll see all your upcoming and past bookings. You can view details, download receipts, and rebook previous parking spots.

== CONTACT INFORMATION ==
- General support: support@triplypro.com (24-48 hour response time)
- Legal inquiries: legal@triplypro.com
- Privacy inquiries: privacy@triplypro.com
- Contact page: triplypro.com/contact

== CANCELLATION & REFUND POLICY ==
- Cancel more than 24 hours before check-in → full refund
- Cancel within 24 hours → may incur a cancellation fee (varies by facility)
- Refunds processed within 5-7 business days to original payment method
- To cancel: Log in → My Reservations → select booking → Cancel Reservation

== PRIVACY SUMMARY ==
- Data collected: name, email, phone, payment info (processed by Stripe), booking details
- Data shared with: Stripe (payments), Supabase (database), Resend (emails), Vercel (hosting), Google Analytics (anonymized analytics, only after cookie consent)
- Data retention: 7 years for financial records
- Users can request data deletion by contacting privacy@triplypro.com
- Full policy at: triplypro.com/privacy

== TERMS SUMMARY ==
- Triply is an intermediary — we connect travelers with parking facility operators
- Triply is not responsible for the parking facility's services directly
- 24-hour cancellation window for full refund
- Disputes handled through support@triplypro.com
- Full terms at: triplypro.com/terms

=== END KNOWLEDGE BASE ===
`.trim();
}
