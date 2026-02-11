"use client";

import { useState, useRef, useEffect } from "react";
import { MessageCircle, X, Send, AlertTriangle } from "lucide-react";
import { useChatContext } from "./chat-context";
import { ChatMessage } from "./chat-message";
import { ChatAuthGate } from "./chat-auth-gate";

const SUGGESTIONS = [
  "Parking at JFK next week",
  "What's your cancellation policy?",
  "How does booking work?",
  "Compare JFK lots",
];

export function ChatBubble() {
  const {
    messages,
    status,
    sendMessage,
    isOpen,
    setIsOpen,
    authRequired,
    rateLimited,
  } = useChatContext();

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isLoading = status === "submitted" || status === "streaming";

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage(input);
    setInput("");
  };

  const handleSuggestion = (suggestion: string) => {
    sendMessage(suggestion);
  };

  return (
    <>
      {/* Chat Panel */}
      {isOpen && (
        <div className="fixed bottom-20 right-4 z-50 w-[380px] max-w-[calc(100vw-2rem)] h-[520px] max-h-[calc(100vh-6rem)] bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden sm:bottom-20 sm:right-4 max-sm:inset-0 max-sm:bottom-0 max-sm:right-0 max-sm:w-full max-sm:max-w-full max-sm:h-full max-sm:max-h-full max-sm:rounded-none">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gradient-to-r from-brand-orange to-orange-500">
            <div className="flex items-center gap-2">
              <MessageCircle size={18} className="text-white" />
              <span className="font-semibold text-white text-sm">
                Triply AI
              </span>
              <span className="text-white/70 text-xs">Assistant</span>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-white/80 hover:text-white transition-colors p-1"
              aria-label="Close chat"
            >
              <X size={18} />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="text-center py-6">
                <MessageCircle
                  size={32}
                  className="text-gray-300 mx-auto mb-3"
                />
                <p className="text-sm font-medium text-gray-700 mb-1">
                  Hi! I&apos;m your Triply assistant.
                </p>
                <p className="text-xs text-gray-500 mb-4">
                  Ask me about parking, policies, or anything Triply.
                </p>
                <div className="flex flex-wrap gap-1.5 justify-center">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => handleSuggestion(suggestion)}
                      className="text-xs px-3 py-1.5 bg-gray-100 text-gray-700 rounded-full hover:bg-brand-orange/10 hover:text-brand-orange transition-colors"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}

            {/* Auth gate */}
            {authRequired && <ChatAuthGate />}

            {/* Rate limit warning */}
            {rateLimited && (
              <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">
                <AlertTriangle size={14} />
                <span>
                  {rateLimited === "day"
                    ? "Daily limit reached. Please try again tomorrow."
                    : "Slow down — too many messages. Please wait a moment."}
                </span>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <form
            onSubmit={handleSubmit}
            className="px-3 py-2 border-t border-gray-200 bg-gray-50 max-sm:pb-[env(safe-area-inset-bottom,1rem)]"
          >
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  authRequired
                    ? "Sign in to continue..."
                    : "Ask me anything..."
                }
                disabled={isLoading || authRequired}
                className="flex-1 text-base sm:text-sm bg-white border border-gray-200 rounded-full px-4 py-2 outline-none focus:ring-2 focus:ring-brand-orange/30 focus:border-brand-orange disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <button
                type="submit"
                disabled={!input.trim() || isLoading}
                className="flex-shrink-0 w-8 h-8 bg-brand-orange text-white rounded-full flex items-center justify-center hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Send message"
              >
                <Send size={14} />
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Floating Bubble */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`fixed bottom-4 right-4 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-300 ${
          isOpen
            ? "bg-gray-600 hover:bg-gray-700 scale-90 max-sm:hidden"
            : "bg-brand-orange hover:bg-orange-600 scale-100 hover:scale-105"
        }`}
        aria-label={isOpen ? "Close chat" : "Open chat"}
      >
        {isOpen ? (
          <X size={22} className="text-white" />
        ) : (
          <MessageCircle size={22} className="text-white" />
        )}
      </button>
    </>
  );
}
