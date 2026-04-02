import Link from "next/link";

interface BlogFilterBarProps {
  categories: Array<{ name: string; slug: string }>;
  activeSlug?: string;
}

export function BlogFilterBar({ categories, activeSlug }: BlogFilterBarProps) {
  return (
    <div className="flex flex-wrap gap-2">
      <Link
        href="/blog"
        className={`px-4 py-2 text-sm font-medium rounded-full transition-colors ${
          !activeSlug
            ? "bg-coral text-white"
            : "bg-gray-100 text-gray-700 hover:bg-gray-200"
        }`}
      >
        All
      </Link>
      {categories.map((cat) => (
        <Link
          key={cat.slug}
          href={`/blog/category/${cat.slug}`}
          className={`px-4 py-2 text-sm font-medium rounded-full transition-colors ${
            activeSlug === cat.slug
              ? "bg-coral text-white"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200"
          }`}
        >
          {cat.name}
        </Link>
      ))}
    </div>
  );
}
