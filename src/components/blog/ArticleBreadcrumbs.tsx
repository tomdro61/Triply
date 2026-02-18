import Link from 'next/link'

interface BreadcrumbItem {
  label: string
  href?: string
}

interface ArticleBreadcrumbsProps {
  items: BreadcrumbItem[]
}

export function ArticleBreadcrumbs({ items }: ArticleBreadcrumbsProps) {
  const breadcrumbList = [
    { label: 'Blog', href: '/blog' },
    ...items,
  ]

  return (
    <>
      {/* BreadcrumbList JSON-LD */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: breadcrumbList.map((item, index) => ({
              '@type': 'ListItem',
              position: index + 1,
              name: item.label,
              item: item.href ? `https://www.triplypro.com${item.href}` : undefined,
            })),
          }),
        }}
      />

      <nav className="flex items-center gap-2 text-sm text-gray-500 mb-4">
        {breadcrumbList.map((item, index) => (
          <span key={index} className="flex items-center gap-2">
            {index > 0 && <span>/</span>}
            {item.href ? (
              <Link href={item.href} className="hover:text-coral transition-colors">
                {item.label}
              </Link>
            ) : (
              <span className="text-navy font-medium">{item.label}</span>
            )}
          </span>
        ))}
      </nav>
    </>
  )
}
