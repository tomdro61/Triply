"use client";

import { ChatContextProvider } from "./chat-context";

export function ChatProvider({ children }: { children: React.ReactNode }) {
  return <ChatContextProvider>{children}</ChatContextProvider>;
}
