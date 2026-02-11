"use client";

import Link from "next/link";
import { LogIn } from "lucide-react";

export function ChatAuthGate() {
  return (
    <div className="flex flex-col items-center gap-3 py-4 px-3 text-center">
      <div className="w-10 h-10 bg-brand-orange/10 rounded-full flex items-center justify-center">
        <LogIn size={20} className="text-brand-orange" />
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-900">
          Sign in to keep chatting
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Create a free account to continue the conversation
        </p>
      </div>
      <Link
        href="/auth/login?next=/"
        className="inline-flex items-center gap-2 bg-brand-orange text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-orange-600 transition-colors"
      >
        <LogIn size={14} />
        Sign In
      </Link>
    </div>
  );
}
