import Link from "next/link";
import { Navbar, Footer } from "@/components/shared";
import { ArrowLeft, FileText } from "lucide-react";

export const metadata = {
  title: "Terms of Service | Triply",
  description: "Terms and conditions for using Triply airport parking services.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <>
      <Navbar forceSolid />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white border-b border-gray-200">
          <div className="max-w-3xl mx-auto px-4 py-8">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Home
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-3 bg-brand-orange/10 rounded-xl">
                <FileText className="h-8 w-8 text-brand-orange" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Terms of Service</h1>
                <p className="text-gray-600">Last updated: January 31, 2026</p>
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-3xl mx-auto px-4 py-8">
          <div className="bg-white rounded-xl border border-gray-200 p-8 prose prose-gray max-w-none">
            <h2>1. Acceptance of Terms</h2>
            <p>
              By accessing or using the Triply website and services ("Services"), you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, please do not use our Services.
            </p>
            <p>
              Triply ("we," "us," or "our") operates the website triplypro.com and provides airport parking reservation services. These Terms govern your use of our website and services.
            </p>

            <h2>2. Description of Services</h2>
            <p>
              Triply is a platform that allows users to search for, compare, and book airport parking spaces at third-party parking facilities. We act as an intermediary between you and parking facility operators. We do not own or operate any parking facilities ourselves.
            </p>

            <h2>3. User Accounts</h2>
            <p>
              You may create an account to access certain features of our Services. When creating an account, you agree to:
            </p>
            <ul>
              <li>Provide accurate, current, and complete information</li>
              <li>Maintain and promptly update your account information</li>
              <li>Keep your password confidential and secure</li>
              <li>Accept responsibility for all activities under your account</li>
              <li>Notify us immediately of any unauthorized use of your account</li>
            </ul>

            <h2>4. Reservations and Payments</h2>
            <h3>4.1 Making Reservations</h3>
            <p>
              When you make a reservation through Triply, you are entering into a contract with the parking facility operator. We facilitate the reservation process but are not a party to the parking agreement.
            </p>

            <h3>4.2 Pricing</h3>
            <p>
              All prices displayed on our website include applicable taxes and fees unless otherwise stated. Prices are subject to change without notice until a reservation is confirmed.
            </p>

            <h3>4.3 Payment</h3>
            <p>
              Payment is required at the time of booking. We accept major credit cards, Apple Pay, and Google Pay. By providing payment information, you represent that you are authorized to use the payment method.
            </p>

            <h2>5. Cancellation and Refund Policy</h2>
            <p>
              Our cancellation policy is as follows:
            </p>
            <ul>
              <li><strong>More than 24 hours before check-in:</strong> Full refund</li>
              <li><strong>Within 24 hours of check-in:</strong> May be subject to cancellation fee</li>
              <li><strong>No-shows:</strong> No refund</li>
            </ul>
            <p>
              Refunds are processed to your original payment method within 5-7 business days. Some parking facilities may have different cancellation policies, which will be displayed at the time of booking.
            </p>

            <h2>6. User Responsibilities</h2>
            <p>
              When using our Services and parking facilities, you agree to:
            </p>
            <ul>
              <li>Arrive and depart during the facility's operating hours</li>
              <li>Follow all rules and regulations of the parking facility</li>
              <li>Ensure your vehicle is in safe operating condition</li>
              <li>Remove all valuables from your vehicle</li>
              <li>Provide accurate vehicle information</li>
              <li>Not use the parking space for any illegal purpose</li>
            </ul>

            <h2>7. Limitation of Liability</h2>
            <p>
              Triply acts solely as an intermediary between you and parking facility operators. We are not responsible for:
            </p>
            <ul>
              <li>The condition or safety of any parking facility</li>
              <li>Loss, theft, or damage to your vehicle or its contents</li>
              <li>Personal injury occurring at a parking facility</li>
              <li>Actions or omissions of parking facility operators</li>
              <li>Accuracy of information provided by parking facilities</li>
            </ul>
            <p>
              To the maximum extent permitted by law, Triply shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of our Services.
            </p>

            <h2>8. Intellectual Property</h2>
            <p>
              All content on the Triply website, including text, graphics, logos, images, and software, is the property of Triply or its licensors and is protected by copyright and other intellectual property laws. You may not reproduce, distribute, or create derivative works without our express written permission.
            </p>

            <h2>9. Privacy</h2>
            <p>
              Your use of our Services is also governed by our <Link href="/privacy" className="text-brand-orange hover:text-orange-600">Privacy Policy</Link>, which describes how we collect, use, and protect your personal information.
            </p>

            <h2>10. Modifications to Terms</h2>
            <p>
              We reserve the right to modify these Terms at any time. Changes will be effective immediately upon posting to our website. Your continued use of our Services after any changes constitutes acceptance of the new Terms.
            </p>

            <h2>11. Governing Law</h2>
            <p>
              These Terms shall be governed by and construed in accordance with the laws of the State of New York, without regard to its conflict of law provisions.
            </p>

            <h2>12. Dispute Resolution</h2>
            <p>
              Any disputes arising from these Terms or your use of our Services shall first be attempted to be resolved through good-faith negotiation. If negotiation fails, disputes shall be resolved through binding arbitration in accordance with the rules of the American Arbitration Association.
            </p>

            <h2>13. Contact Information</h2>
            <p>
              If you have any questions about these Terms, please contact us at:
            </p>
            <ul>
              <li>Email: legal@triplypro.com</li>
              <li>Address: Triply, Inc., New York, NY</li>
            </ul>
          </div>

          {/* Related Links */}
          <div className="mt-8 flex flex-wrap gap-4">
            <Link
              href="/privacy"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-gray-700 hover:border-brand-orange hover:text-brand-orange transition-colors"
            >
              Privacy Policy
            </Link>
            <Link
              href="/help"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-gray-700 hover:border-brand-orange hover:text-brand-orange transition-colors"
            >
              Help Center
            </Link>
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
}
