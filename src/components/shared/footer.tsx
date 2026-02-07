import Link from "next/link";
import { Plane, Facebook, Twitter, Instagram, Linkedin, ShieldCheck, CreditCard } from "lucide-react";

export function Footer() {
  const footerLinks = [
    {
      header: "Company",
      links: [
        { label: "About Us", href: "/about" },
        { label: "Careers", href: "/careers" },
        { label: "Press", href: "/press" },
        { label: "Blog", href: "/blog" },
      ],
    },
    {
      header: "Support",
      links: [
        { label: "FAQs", href: "/help" },
        { label: "Contact Us", href: "/contact" },
        { label: "Terms of Service", href: "/terms" },
        { label: "Privacy Policy", href: "/privacy" },
      ],
    },
    {
      header: "Airports",
      links: [
        { label: "JFK Parking", href: "/new-york-jfk/airport-parking" },
        { label: "LaGuardia Parking", href: "/new-york-lga/airport-parking" },
      ],
    },
  ];

  const socialIcons = [
    { icon: Facebook, href: "#" },
    { icon: Twitter, href: "#" },
    { icon: Instagram, href: "#" },
    { icon: Linkedin, href: "#" },
  ];

  return (
    <footer className="bg-brand-dark text-white py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12">
          {/* Brand */}
          <div className="col-span-1">
            <div className="flex items-center mb-6">
              <div className="bg-brand-orange p-1.5 rounded-md mr-2">
                <Plane size={20} fill="currentColor" className="text-white" />
              </div>
              <span className="text-2xl font-bold tracking-tight">Triply</span>
            </div>
            <p className="text-gray-400 text-sm leading-relaxed mb-4">
              Making travel simple, affordable, and smart. Compare hundreds of
              parking options in one click.
            </p>
            <div className="flex items-center text-sm text-brand-orange font-medium mb-4">
              <ShieldCheck size={16} className="mr-1.5" />
              100+ Verified Parking Partners
            </div>
            <div className="flex space-x-4">
              {socialIcons.map((social, i) => (
                <a
                  key={i}
                  href={social.href}
                  className="text-gray-400 hover:text-brand-orange transition-colors"
                >
                  <social.icon size={20} />
                </a>
              ))}
            </div>
          </div>

          {/* Links */}
          {footerLinks.map((column, idx) => (
            <div key={idx}>
              <h4 className="font-bold text-lg mb-6">{column.header}</h4>
              <ul className="space-y-3">
                {column.links.map((link, lIdx) => (
                  <li key={lIdx}>
                    <Link
                      href={link.href}
                      className="text-gray-400 hover:text-white transition-colors text-sm"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Payment Methods & Trust */}
        <div className="border-t border-gray-800 mt-12 pt-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-6">
            {/* Payment Methods */}
            <div className="flex items-center gap-3">
              <span className="text-gray-500 text-xs mr-2">We accept:</span>
              <div className="flex items-center gap-2">
                <div className="bg-gray-800 px-3 py-1.5 rounded text-xs text-gray-300 font-medium">
                  Visa
                </div>
                <div className="bg-gray-800 px-3 py-1.5 rounded text-xs text-gray-300 font-medium">
                  Mastercard
                </div>
                <div className="bg-gray-800 px-3 py-1.5 rounded text-xs text-gray-300 font-medium">
                  Amex
                </div>
                <div className="bg-gray-800 px-3 py-1.5 rounded text-xs text-gray-300 font-medium flex items-center">
                  <CreditCard size={12} className="mr-1" />
                  Apple Pay
                </div>
              </div>
            </div>

            {/* Security Badges */}
            <div className="flex items-center space-x-2">
              <div className="bg-gray-800 px-2 py-1 rounded text-xs text-gray-400 font-mono">
                SSL Secured
              </div>
              <div className="bg-gray-800 px-2 py-1 rounded text-xs text-gray-400 font-mono">
                PCI DSS
              </div>
            </div>
          </div>
        </div>

        {/* Copyright */}
        <div className="border-t border-gray-800 mt-6 pt-6 text-center">
          <p className="text-gray-500 text-sm">
            &copy; {new Date().getFullYear()} Triply Inc. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
