import Link from "next/link";
import { Navbar, Footer } from "@/components/shared";
import { ArrowLeft, Shield } from "lucide-react";

export const metadata = {
  title: "Privacy Policy | Triply",
  description: "How Triply collects, uses, and protects your personal information.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
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
                <Shield className="h-8 w-8 text-brand-orange" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Privacy Policy</h1>
                <p className="text-gray-600">Last updated: January 31, 2026</p>
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-3xl mx-auto px-4 py-8">
          <div className="bg-white rounded-xl border border-gray-200 p-8 prose prose-gray max-w-none">
            <h2>1. Introduction</h2>
            <p>
              Triply ("we," "us," or "our") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you visit our website triplypro.com and use our services.
            </p>
            <p>
              Please read this Privacy Policy carefully. By using our Services, you consent to the practices described in this policy.
            </p>

            <h2>2. Information We Collect</h2>

            <h3>2.1 Information You Provide</h3>
            <p>We collect information you voluntarily provide, including:</p>
            <ul>
              <li><strong>Account Information:</strong> Name, email address, password, phone number</li>
              <li><strong>Booking Information:</strong> Travel dates, airport, vehicle details (make, model, color, license plate)</li>
              <li><strong>Payment Information:</strong> Credit card number, billing address (processed securely through Stripe)</li>
              <li><strong>Communications:</strong> Messages you send us through email or support channels</li>
            </ul>

            <h3>2.2 Information Collected Automatically</h3>
            <p>When you visit our website, we automatically collect:</p>
            <ul>
              <li><strong>Device Information:</strong> Browser type, operating system, device type</li>
              <li><strong>Usage Information:</strong> Pages visited, time spent, clicks, search queries</li>
              <li><strong>Location Information:</strong> General location based on IP address</li>
              <li><strong>Cookies and Tracking:</strong> See Section 6 for details</li>
            </ul>

            <h2>3. How We Use Your Information</h2>
            <p>We use your information to:</p>
            <ul>
              <li>Process and manage your parking reservations</li>
              <li>Send booking confirmations and updates</li>
              <li>Provide customer support</li>
              <li>Process payments securely</li>
              <li>Improve our website and services</li>
              <li>Send promotional emails (with your consent)</li>
              <li>Prevent fraud and ensure security</li>
              <li>Comply with legal obligations</li>
            </ul>

            <h2>4. How We Share Your Information</h2>
            <p>We may share your information with:</p>

            <h3>4.1 Parking Facility Operators</h3>
            <p>
              We share necessary booking details (name, contact info, vehicle details, reservation dates) with parking facilities to fulfill your reservation.
            </p>

            <h3>4.2 Service Providers</h3>
            <p>We work with trusted third parties who help us operate our business:</p>
            <ul>
              <li><strong>Stripe:</strong> Payment processing</li>
              <li><strong>Supabase:</strong> Database and authentication</li>
              <li><strong>Resend:</strong> Email delivery</li>
              <li><strong>Vercel:</strong> Website hosting</li>
              <li><strong>Google Analytics:</strong> Website analytics</li>
            </ul>

            <h3>4.3 Legal Requirements</h3>
            <p>
              We may disclose your information if required by law, court order, or government request, or to protect the rights, property, or safety of Triply, our users, or others.
            </p>

            <h2>5. Data Security</h2>
            <p>
              We implement appropriate technical and organizational security measures to protect your personal information, including:
            </p>
            <ul>
              <li>SSL/TLS encryption for data in transit</li>
              <li>Secure password hashing</li>
              <li>PCI-compliant payment processing through Stripe</li>
              <li>Regular security assessments</li>
              <li>Access controls and authentication</li>
            </ul>
            <p>
              While we strive to protect your information, no method of transmission over the Internet is 100% secure. We cannot guarantee absolute security.
            </p>

            <h2>6. Cookies and Tracking Technologies</h2>
            <p>We use cookies and similar technologies to:</p>
            <ul>
              <li>Keep you signed in to your account</li>
              <li>Remember your preferences</li>
              <li>Understand how you use our website</li>
              <li>Improve our services</li>
              <li>Show relevant advertisements (with consent)</li>
            </ul>

            <h3>Types of Cookies We Use:</h3>
            <ul>
              <li><strong>Essential Cookies:</strong> Required for basic website functionality</li>
              <li><strong>Functional Cookies:</strong> Remember your preferences</li>
              <li><strong>Analytics Cookies:</strong> Help us understand usage patterns (Google Analytics)</li>
              <li><strong>Marketing Cookies:</strong> Used for advertising (only with consent)</li>
            </ul>
            <p>
              You can manage cookie preferences through our cookie consent banner or your browser settings.
            </p>

            <h2>7. Your Rights and Choices</h2>
            <p>You have the right to:</p>
            <ul>
              <li><strong>Access:</strong> Request a copy of your personal data</li>
              <li><strong>Correction:</strong> Update or correct inaccurate information</li>
              <li><strong>Deletion:</strong> Request deletion of your personal data</li>
              <li><strong>Opt-out:</strong> Unsubscribe from marketing emails</li>
              <li><strong>Data Portability:</strong> Receive your data in a portable format</li>
            </ul>
            <p>
              To exercise these rights, contact us at privacy@triplypro.com.
            </p>

            <h2>8. Data Retention</h2>
            <p>
              We retain your personal information for as long as necessary to provide our services and fulfill the purposes described in this policy. Specifically:
            </p>
            <ul>
              <li><strong>Account data:</strong> Until you delete your account</li>
              <li><strong>Booking records:</strong> 7 years for tax and legal compliance</li>
              <li><strong>Analytics data:</strong> 26 months</li>
            </ul>

            <h2>9. Children's Privacy</h2>
            <p>
              Our Services are not intended for children under 18. We do not knowingly collect personal information from children. If you believe we have collected information from a child, please contact us immediately.
            </p>

            <h2>10. International Data Transfers</h2>
            <p>
              Your information may be transferred to and processed in countries other than your own. We ensure appropriate safeguards are in place to protect your information in accordance with this Privacy Policy.
            </p>

            <h2>11. California Privacy Rights (CCPA)</h2>
            <p>
              If you are a California resident, you have additional rights under the California Consumer Privacy Act (CCPA):
            </p>
            <ul>
              <li>Right to know what personal information is collected</li>
              <li>Right to know if personal information is sold or disclosed</li>
              <li>Right to say no to the sale of personal information</li>
              <li>Right to equal service and price</li>
            </ul>
            <p>
              We do not sell your personal information.
            </p>

            <h2>12. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. We will notify you of any material changes by posting the new policy on our website and updating the "Last updated" date. Your continued use of our Services after changes constitutes acceptance of the updated policy.
            </p>

            <h2>13. Contact Us</h2>
            <p>
              If you have questions about this Privacy Policy or our privacy practices, please contact us:
            </p>
            <ul>
              <li>Email: privacy@triplypro.com</li>
              <li>Address: Triply, Inc., New York, NY</li>
            </ul>
          </div>

          {/* Related Links */}
          <div className="mt-8 flex flex-wrap gap-4">
            <Link
              href="/terms"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-gray-700 hover:border-brand-orange hover:text-brand-orange transition-colors"
            >
              Terms of Service
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
