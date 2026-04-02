import Link from "next/link";
import Image from "next/image";
import { format } from "date-fns";

interface BlogFeaturedPostProps {
  post: {
    slug: string;
    title: string;
    excerpt: string;
    category?: { name: string } | null;
    featuredImage?: { url: string; alt?: string } | null;
    author?: { name?: string; email?: string } | null;
    publishedAt?: string | null;
  };
}

export function BlogFeaturedPost({ post }: BlogFeaturedPostProps) {
  return (
    <article className="bg-white rounded-xl shadow-sm overflow-hidden hover:shadow-md transition-shadow mb-8">
      <Link href={`/blog/${post.slug}`} className="block md:flex">
        {post.featuredImage?.url ? (
          <div className="relative h-64 md:h-80 md:w-1/2">
            <Image
              src={post.featuredImage.url}
              alt={post.featuredImage.alt || post.title}
              fill
              className="object-cover"
            />
          </div>
        ) : (
          <div className="h-64 md:h-80 md:w-1/2 bg-gray-200 flex items-center justify-center">
            <span className="text-gray-400">No image</span>
          </div>
        )}

        <div className="p-6 md:p-8 md:w-1/2 flex flex-col justify-center">
          {post.category && (
            <span className="inline-block w-fit px-3 py-1 bg-coral/10 text-coral text-sm font-medium rounded-full mb-3">
              {post.category.name}
            </span>
          )}

          <h2 className="text-2xl md:text-3xl font-heading font-bold text-navy mb-3 hover:text-coral transition-colors">
            {post.title}
          </h2>

          <p className="text-gray-600 mb-4 line-clamp-3">{post.excerpt}</p>

          <div className="flex items-center gap-3 text-sm text-gray-500">
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
      </Link>
    </article>
  );
}
