"use client";

import type { UIMessage } from "ai";
import { ChatParkingResults } from "./chat-parking-results";
import { ChatBlogResults } from "./chat-blog-results";
import { Bot, User } from "lucide-react";

/**
 * Simple markdown-to-JSX renderer for chat messages.
 * Handles: **bold**, *italic*, `code`, line breaks, and bullet lists.
 */
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];

  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();

    // Skip empty lines but add spacing
    if (!trimmed) {
      if (lineIndex > 0 && lineIndex < lines.length - 1) {
        elements.push(<div key={`br-${lineIndex}`} className="h-1.5" />);
      }
      return;
    }

    // Bullet list item (- or *)
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      elements.push(
        <div key={lineIndex} className="flex gap-1.5 pl-1">
          <span className="text-brand-orange mt-0.5">•</span>
          <span>{renderInlineMarkdown(bulletMatch[1])}</span>
        </div>
      );
      return;
    }

    // Regular line
    elements.push(
      <div key={lineIndex}>{renderInlineMarkdown(trimmed)}</div>
    );
  });

  return elements;
}

/**
 * Render inline markdown: **bold**, *italic*, `code`
 */
function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Match **bold**, *italic*, `code`, or plain text
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|([^*`]+))/g;
  let match;
  let i = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      // **bold**
      parts.push(
        <strong key={i++} className="font-semibold">
          {match[2]}
        </strong>
      );
    } else if (match[3]) {
      // *italic*
      parts.push(
        <em key={i++}>{match[3]}</em>
      );
    } else if (match[4]) {
      // `code`
      parts.push(
        <code
          key={i++}
          className="bg-gray-200 text-gray-800 px-1 py-0.5 rounded text-xs"
        >
          {match[4]}
        </code>
      );
    } else if (match[5]) {
      // plain text
      parts.push(<span key={i++}>{match[5]}</span>);
    }
  }

  return parts;
}

interface ChatMessageProps {
  message: UIMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {/* Avatar */}
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
          isUser ? "bg-brand-orange text-white" : "bg-gray-100 text-gray-600"
        }`}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>

      {/* Message content */}
      <div
        className={`max-w-[80%] space-y-2 ${
          isUser ? "items-end" : "items-start"
        }`}
      >
        {message.parts.map((part, index) => {
          // Text part
          if (part.type === "text" && part.text) {
            return (
              <div
                key={index}
                className={`px-3 py-2 rounded-xl text-sm leading-relaxed ${
                  isUser
                    ? "bg-brand-orange text-white rounded-tr-sm"
                    : "bg-gray-100 text-gray-800 rounded-tl-sm"
                }`}
              >
                {isUser ? part.text : renderMarkdown(part.text)}
              </div>
            );
          }

          // Tool invocation parts (search results)
          if (part.type.startsWith("tool-") && "state" in part) {
            const toolPart = part as {
              type: string;
              state: string;
              toolCallId: string;
              input: Record<string, unknown>;
              output?: Record<string, unknown>;
            };

            if (toolPart.state === "call") {
              return (
                <div
                  key={index}
                  className="text-xs text-gray-400 italic px-1"
                >
                  Searching...
                </div>
              );
            }

            if (toolPart.state === "result" && toolPart.output) {
              const toolName = toolPart.type.replace("tool-", "");

              if (toolName === "searchParking" && toolPart.output.lots) {
                return (
                  <ChatParkingResults
                    key={index}
                    result={toolPart.output as Record<string, unknown>}
                  />
                );
              }

              if (toolName === "searchBlog" && toolPart.output.posts) {
                return (
                  <ChatBlogResults
                    key={index}
                    result={toolPart.output as Record<string, unknown>}
                  />
                );
              }
            }
          }

          return null;
        })}
      </div>
    </div>
  );
}
