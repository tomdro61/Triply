import Link from "next/link";
import Image from "next/image";
import { format } from "date-fns";

interface BlogPostCardProps {
  post: {
    id: string;
    slug: string;
    title: string;
    excerpt: string;
    category?: { name: string } | null;
    featuredImage?: { url: string; alt?: string } | null;
    author?: { name?: string; email?: string } | null;
    publishedAt?: string | null;
  };
}

export function BlogPostCard({ post }: BlogPostCardProps) {
  return (
    <article className="bg-white rounded-xl shadow-sm overflow-hidden hover:shadow-md transition-shadow">
      <Link href={`/blog/${post.slug}`}>
        {post.featuredImage?.url ? (
          <div className="relative h-48 w-full">
            <Image
              src={post.featuredImage.url}
              alt={post.featuredImage.alt || post.title}
              fill
              className="object-cover"
            />
          </div>
        ) : (
          <div className="h-48 w-full bg-gray-200 flex items-center justify-center">
            <span className="text-gray-400">No image</span>
          </div>
        )}
      </Link>

      <div className="p-6">
        {post.category && (
          <span className="inline-block px-3 py-1 bg-coral/10 text-coral text-sm font-medium rounded-full mb-3">
            {post.category.name}
          </span>
        )}

        <Link href={`/blog/${post.slug}`}>
          <h2 className="text-xl font-heading font-semibold text-navy mb-2 hover:text-coral transition-colors">
            {post.title}
          </h2>
        </Link>

        <p className="text-gray-600 text-sm mb-4 line-clamp-3">
          {post.excerpt}
        </p>

        <div className="flex items-center justify-between text-sm text-gray-500">
          {post.author && (
            <span>{post.author.name || post.author.email}</span>
          )}
          {post.publishedAt && (
            <time dateTime={post.publishedAt}>
              {format(new Date(post.publishedAt), "MMM d, yyyy")}
            </time>
          )}
        </div>
      </div>
    </article>
  );
}
