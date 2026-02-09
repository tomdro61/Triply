import type { MetadataRoute } from "next";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://triplypro.com";

  // Static pages
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/help`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/contact`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${baseUrl}/blog`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/terms`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/privacy`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];

  // Blog posts from Payload CMS
  let blogPages: MetadataRoute.Sitemap = [];
  try {
    const cmsUrl = process.env.NEXT_PUBLIC_CMS_URL || "http://localhost:3001";
    const res = await fetch(
      `${cmsUrl}/api/posts?where[status][equals]=published&sort=-publishedAt&limit=100`,
      { next: { revalidate: 3600 } }
    );
    if (res.ok) {
      const data = await res.json();
      blogPages = (
        data.docs || []
      ).map((post: { slug: string; updatedAt: string }) => ({
        url: `${baseUrl}/blog/${post.slug}`,
        lastModified: new Date(post.updatedAt),
        changeFrequency: "monthly" as const,
        priority: 0.6,
      }));
    }
  } catch (error) {
    console.error("Error fetching blog posts for sitemap:", error);
  }

  return [...staticPages, ...blogPages];
}
