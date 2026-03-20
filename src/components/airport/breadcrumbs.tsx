import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Airport } from "@/config/airports";
import { JsonLd } from "@/components/seo/JsonLd";

interface BreadcrumbsProps {
  airport: Airport;
}

export function Breadcrumbs({ airport }: BreadcrumbsProps) {
  const baseUrl = "https://www.triplypro.com";

  const items = [
    { name: "Home", href: "/" },
    { name: "Airport Parking", href: "/airport-parking" },
    { name: `${airport.city} Airport (${airport.code})`, href: null },
  ];

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      ...(item.href ? { item: `${baseUrl}${item.href}` } : {}),
    })),
  };

  return (
    <>
      <JsonLd data={breadcrumbSchema} />
      <nav aria-label="Breadcrumb" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-2">
        <ol className="flex items-center text-sm text-gray-500 flex-wrap">
          {items.map((item, idx) => (
            <li key={idx} className="flex items-center">
              {idx > 0 && <ChevronRight className="w-4 h-4 mx-2 text-gray-400" />}
              {item.href ? (
                <Link href={item.href} className="hover:text-brand-orange transition-colors">
                  {item.name}
                </Link>
              ) : (
                <span className="text-gray-700 font-medium">{item.name}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}
