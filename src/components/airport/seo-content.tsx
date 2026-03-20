import { SEOSection } from "@/lib/airport-page/content";

interface SEOContentProps {
  sections: SEOSection[];
}

export function SEOContent({ sections }: SEOContentProps) {
  if (sections.length === 0) return null;

  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="max-w-3xl">
        {sections.map((section, idx) => (
          <div key={idx} className="mb-8 last:mb-0">
            <h2 className="text-xl font-bold text-gray-900 mb-3">
              {section.heading}
            </h2>
            <div className="text-gray-600 leading-relaxed text-sm whitespace-pre-line prose prose-sm prose-gray">
              {section.body.split("\n").map((line, i) => {
                // Render bold text within lines
                const parts = line.split(/(\*\*.*?\*\*)/g);
                return (
                  <p key={i} className={line.startsWith("•") ? "mb-1" : "mb-0"}>
                    {parts.map((part, j) =>
                      part.startsWith("**") && part.endsWith("**") ? (
                        <strong key={j} className="text-gray-800">
                          {part.slice(2, -2)}
                        </strong>
                      ) : (
                        <span key={j}>{part}</span>
                      )
                    )}
                  </p>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
