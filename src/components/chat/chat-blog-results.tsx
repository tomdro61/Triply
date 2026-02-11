"use client";

import Link from "next/link";
import { BookOpen, ExternalLink } from "lucide-react";

interface BlogPost {
  title: string;
  excerpt: string;
  slug: string;
  publishedAt: string;
}

interface ChatBlogResultsProps {
  result: Record<string, unknown>;
}

export function ChatBlogResults({ result }: ChatBlogResultsProps) {
  const posts = (result.posts as BlogPost[]) || [];

  if (!result.success || posts.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1.5 w-full">
      {posts.map((post, index) => (
        <Link
          key={index}
          href={`/blog/${post.slug}`}
          className="block bg-white border border-gray-200 rounded-lg p-2.5 text-xs hover:border-brand-orange/50 transition-colors"
        >
          <div className="flex items-start gap-2">
            <BookOpen
              size={14}
              className="text-brand-orange flex-shrink-0 mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-gray-900 line-clamp-1">
                {post.title}
              </p>
              {post.excerpt && (
                <p className="text-gray-500 line-clamp-2 mt-0.5">
                  {post.excerpt}
                </p>
              )}
              <div className="flex items-center gap-1 text-brand-orange mt-1">
                <span>Read more</span>
                <ExternalLink size={10} />
              </div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
