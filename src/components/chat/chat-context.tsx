"use client";

import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { DefaultChatTransport } from "ai";
import { createClient } from "@/lib/supabase/client";

interface ChatContextValue {
  messages: UIMessage[];
  status: "submitted" | "streaming" | "ready" | "error";
  error: Error | undefined;
  sendMessage: (text: string) => void;
  setMessages: (messages: UIMessage[]) => void;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  sessionId: string;
  authRequired: boolean;
  rateLimited: string | null; // null or tier name
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChatContext() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return context;
}

export function ChatContextProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [rateLimited, setRateLimited] = useState<string | null>(null);
  const sessionIdRef = useRef(crypto.randomUUID());

  const {
    messages,
    sendMessage: aiSendMessage,
    setMessages,
    status,
    error,
  } = useChat({
    id: sessionIdRef.current,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: { sessionId: sessionIdRef.current },
      credentials: "same-origin",
    }),
    onError: (err) => {
      // Check for auth gate or rate limit errors
      const message = err.message || "";
      if (message.includes("auth_required")) {
        setAuthRequired(true);
      } else if (message.includes("rate_limited")) {
        // Try to extract tier from error
        setRateLimited("minute");
      }
    },
  });

  // Clear auth gate when user signs in (layout persists across navigation)
  useEffect(() => {
    const supabase = createClient();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") {
        setAuthRequired(false);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const sendMessage = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      // Clear error states on new message attempt
      setAuthRequired(false);
      setRateLimited(null);
      aiSendMessage({ text });
    },
    [aiSendMessage]
  );

  return (
    <ChatContext.Provider
      value={{
        messages,
        status,
        error,
        sendMessage,
        setMessages,
        isOpen,
        setIsOpen,
        sessionId: sessionIdRef.current,
        authRequired,
        rateLimited,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}
