import { streamText, stepCountIs, convertToModelMessages } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { NextRequest } from "next/server";
import { getSystemPrompt, AI_MODEL } from "@/lib/ai/config";
import { checkRateLimit } from "@/lib/ai/rate-limit";
import { checkUsageAnomaly } from "@/lib/ai/usage-alert";
import { searchParking } from "@/lib/reslab/search";
import { enabledAirports } from "@/config/airports";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";

// Build airport code enum from config
const airportCodes = enabledAirports.map((a) => a.code) as [string, ...string[]];

/**
 * Convert Payload CMS Lexical rich text content to plain text.
 * Handles the nested node structure recursively.
 */
function lexicalToPlainText(content: unknown): string {
  if (!content || typeof content !== "object") return "";

  const node = content as Record<string, unknown>;

  // Text node
  if (node.type === "text" && typeof node.text === "string") {
    return node.text;
  }

  // Node with children
  if (Array.isArray(node.children)) {
    const childText = node.children.map(lexicalToPlainText).join("");
    if (
      node.type === "paragraph" ||
      node.type === "heading" ||
      node.type === "listitem"
    ) {
      return childText + "\n";
    }
    return childText;
  }

  // Root node
  if (node.root && typeof node.root === "object") {
    return lexicalToPlainText(node.root);
  }

  return "";
}

export async function POST(request: NextRequest) {
  try {
    // Get client IP for rate limiting
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";

    // Rate limit check
    const rateLimit = checkRateLimit(ip);
    if (!rateLimit.allowed) {
      return Response.json(
        { error: "rate_limited", tier: rateLimit.tier },
        { status: 429 }
      );
    }

    const body = await request.json();
    const { messages, sessionId } = body;

    // Auth gate: after 5 user messages, require sign-in
    const userMessageCount = messages
      ? messages.filter((m: { role: string }) => m.role === "user").length
      : 0;
    if (userMessageCount > 5) {
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        return Response.json(
          {
            error: "auth_required",
            message: "Sign in to continue chatting",
          },
          { status: 401 }
        );
      }
    }

    // Convert UI messages to model messages format
    const modelMessages = await convertToModelMessages(messages);

    const result = streamText({
      model: anthropic(AI_MODEL),
      system: getSystemPrompt(),
      messages: modelMessages,
      stopWhen: stepCountIs(3),
      onFinish: async (event) => {
        // Log full conversation including AI response
        const fullMessages = [
          ...messages,
          { role: "assistant", content: event.text },
        ];
        logChatSession(sessionId, fullMessages, ip).catch(() => {});
        checkUsageAnomaly().catch(() => {});
      },
      tools: {
        searchParking: {
          description:
            "Search for available parking lots near an airport for specific dates. Use this when the user asks about parking availability, pricing, or wants to compare lots.",
          inputSchema: z.object({
            airport: z
              .enum(airportCodes)
              .describe("Airport code (e.g., JFK, LGA)"),
            checkin: z
              .string()
              .describe("Check-in date in YYYY-MM-DD format"),
            checkout: z
              .string()
              .describe("Check-out date in YYYY-MM-DD format"),
            checkinTime: z
              .string()
              .optional()
              .describe('Check-in time (e.g., "10:00 AM")'),
            checkoutTime: z
              .string()
              .optional()
              .describe('Check-out time (e.g., "2:00 PM")'),
            vehicleType: z
              .enum(["standard", "oversized", "suv", "truck"])
              .optional()
              .describe("Vehicle type if specified"),
            parkingType: z
              .enum(["self", "valet", "covered", "uncovered"])
              .optional()
              .describe("Preferred parking type"),
            amenities: z
              .array(z.string())
              .optional()
              .describe("Desired amenities (e.g., shuttle, EV charging)"),
          }),
          execute: async ({
            airport,
            checkin,
            checkout,
            checkinTime,
            checkoutTime,
          }: {
            airport: string;
            checkin: string;
            checkout: string;
            checkinTime?: string;
            checkoutTime?: string;
            vehicleType?: string;
            parkingType?: string;
            amenities?: string[];
          }) => {
            try {
              const result = await searchParking({
                airport,
                checkin,
                checkout,
                checkinTime,
                checkoutTime,
              });

              const lots = result.results.slice(0, 5).map((lot) => ({
                name: lot.name,
                pricePerDay: lot.pricing?.minPrice
                  ? `$${lot.pricing.minPrice.toFixed(2)}`
                  : "Price unavailable",
                totalPrice: lot.pricing?.grandTotal
                  ? `$${lot.pricing.grandTotal.toFixed(2)}`
                  : "N/A",
                distance: lot.distanceFromAirport
                  ? `${lot.distanceFromAirport.toFixed(1)} mi`
                  : "N/A",
                amenities: lot.amenities
                  .slice(0, 5)
                  .map((a) => a.displayName)
                  .join(", "),
                slug: lot.slug,
                numberOfDays: lot.pricing?.numberOfDays,
                searchUrl: `/search?airport=${airport}&checkin=${checkin}&checkout=${checkout}${checkinTime ? `&checkinTime=${encodeURIComponent(checkinTime)}` : ""}${checkoutTime ? `&checkoutTime=${encodeURIComponent(checkoutTime)}` : ""}`,
              }));

              return {
                success: true as const,
                airport: result.airport.name,
                checkin: result.checkin,
                checkout: result.checkout,
                totalResults: result.total,
                lots,
              };
            } catch {
              return {
                success: false as const,
                error:
                  "I couldn't search for parking right now. Please try using our regular search at triplypro.com/search.",
              };
            }
          },
        },

        searchBlog: {
          description:
            "Search for blog posts about travel tips, airport guides, or other topics. Use this when the user asks about a topic that might be covered in a blog post.",
          inputSchema: z.object({
            query: z.string().describe("Search keywords or topic"),
          }),
          execute: async ({ query }: { query: string }) => {
            try {
              const cmsUrl =
                process.env.NEXT_PUBLIC_CMS_URL || "http://localhost:3001";
              const res = await fetch(
                `${cmsUrl}/api/posts?where[status][equals]=published&sort=-publishedAt&depth=1&limit=5`,
                { next: { revalidate: 300 } }
              );

              if (!res.ok) {
                return {
                  success: false as const,
                  posts: [] as { title: string; excerpt: string; content: string; slug: string; publishedAt: string }[],
                  message: "Could not fetch blog posts",
                };
              }

              const data = await res.json();
              const allPosts = data.docs || [];

              if (allPosts.length === 0) {
                return {
                  success: true as const,
                  posts: [] as { title: string; excerpt: string; content: string; slug: string; publishedAt: string }[],
                  message: "No blog posts published yet",
                };
              }

              const queryLower = query.toLowerCase();
              const queryWords = queryLower
                .split(/\s+/)
                .filter((w: string) => w.length > 2);

              const scoredPosts = allPosts
                .map((post: Record<string, unknown>) => {
                  const title = ((post.title as string) || "").toLowerCase();
                  const excerpt = ((post.excerpt as string) || "").toLowerCase();
                  const plainContent = lexicalToPlainText(post.content);
                  const contentLower = plainContent.toLowerCase();

                  let score = 0;
                  for (const word of queryWords) {
                    if (title.includes(word)) score += 3;
                    if (excerpt.includes(word)) score += 2;
                    if (contentLower.includes(word)) score += 1;
                  }

                  return { post, score, plainContent };
                })
                .filter((item: { score: number }) => item.score > 0)
                .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
                .slice(0, 3);

              const posts = scoredPosts.map(
                (item: { post: Record<string, unknown>; plainContent: string }) => ({
                  title: item.post.title as string,
                  excerpt: (item.post.excerpt as string) || "",
                  content: item.plainContent.slice(0, 2500),
                  slug: item.post.slug as string,
                  publishedAt: item.post.publishedAt as string,
                })
              );

              return {
                success: true as const,
                posts,
                message:
                  posts.length === 0
                    ? "No blog posts found matching your query"
                    : undefined,
              };
            } catch {
              return {
                success: false as const,
                posts: [] as { title: string; excerpt: string; content: string; slug: string; publishedAt: string }[],
                message: "Could not search blog posts right now",
              };
            }
          },
        },
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    captureAPIError(
      error instanceof Error ? error : new Error(String(error)),
      { endpoint: "/api/chat", method: "POST" }
    );
    return Response.json(
      { error: "Failed to process chat request" },
      { status: 500 }
    );
  }
}

async function logChatSession(
  sessionId: string | undefined,
  messages: unknown[],
  ip: string
): Promise<void> {
  if (!sessionId) return;

  try {
    const supabase = await createAdminClient();

    const userClient = await createClient();
    const {
      data: { user },
    } = await userClient.auth.getUser();

    const { error } = await supabase.from("chat_sessions").upsert(
      {
        session_id: sessionId,
        user_id: user?.id || null,
        ip_address: ip,
        messages: messages,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_id" }
    );

    if (error) {
      console.error("Failed to log chat session:", error.message);
    }
  } catch {
    // Non-blocking
  }
}
