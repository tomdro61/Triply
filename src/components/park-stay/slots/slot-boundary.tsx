"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportParkStayFailure } from "../use-park-stay-access";

/**
 * Every lazy Park & Stay slot on a shared page sits inside this (CX plan
 * §12.5, R12-H3): if its chunk fails to load (a deploy swapped the chunks, a
 * flaky network) or it throws while rendering, the slot renders NOTHING —
 * the customer page around it is never blanked. The failure is logged,
 * reported to Sentry (throttled to once per page session, tag
 * `feature: park_stay_slot`), and `onError` lets the owner undo any state
 * that assumed the slot was showing (the Hero's active tab).
 */
export class SlotBoundary extends Component<{ children: ReactNode; onError?: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("[park-stay] slot failed:", error.message, info.componentStack ?? "");
    reportParkStayFailure("park_stay_slot", error, { componentStack: (info.componentStack ?? "").slice(0, 2000) });
    this.props.onError?.();
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
