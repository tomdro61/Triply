"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Every lazy Park & Stay slot on a shared page sits inside this (CX plan
 * §12.5, R12-H3): if its chunk fails to load (a deploy swapped the chunks, a
 * flaky network) or it throws while rendering, the slot renders NOTHING —
 * the customer page around it is never blanked. Imports only react (the
 * shared-page import guard pins that).
 */
export class SlotBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("[park-stay] slot failed:", error.message, info.componentStack ?? "");
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
