"use client";

import { useState } from "react";
import { Send, Sparkles } from "lucide-react";
import { useChatContext } from "./chat-context";

export function HeroChatInput() {
  const { sendMessage, setIsOpen } = useChatContext();
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage(input);
    setIsOpen(true); // Open the chat bubble to show the response
    setInput("");
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-white/70 text-sm">
        <Sparkles size={16} className="text-brand-orange" />
        <span>Ask me anything about airport parking</span>
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Try &quot;Parking at JFK next week&quot; or ask about our policies"
          className="flex-1 bg-white/10 backdrop-blur-sm text-white placeholder:text-white/50 border border-white/20 rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-brand-orange/50 focus:border-brand-orange"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="flex-shrink-0 bg-brand-orange text-white px-6 py-3 rounded-xl font-semibold text-sm hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <Send size={16} />
          Ask
        </button>
      </form>

      <div className="flex flex-wrap gap-2">
        {["Parking at JFK next week", "Cancellation policy", "How does booking work?"].map(
          (suggestion) => (
            <button
              key={suggestion}
              onClick={() => {
                sendMessage(suggestion);
                setIsOpen(true);
              }}
              className="text-xs px-3 py-1.5 bg-white/10 text-white/80 rounded-full hover:bg-white/20 transition-colors"
            >
              {suggestion}
            </button>
          )
        )}
      </div>
    </div>
  );
}
