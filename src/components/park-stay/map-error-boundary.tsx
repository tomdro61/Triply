"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { MapPlaceholder } from "@/components/map/map-placeholder";

/**
 * If the lazy map chunk fails to load (a deploy swapped the chunks, a flaky
 * network) or mapbox throws while rendering, the map area falls back to the
 * blank placeholder and the list keeps working (review round 1, item 8).
 * Logged once to the console; the map is optional, the list is not.
 */
export class MapErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("[park-stay] map failed to load:", error.message, info.componentStack ?? "");
  }

  render(): ReactNode {
    return this.state.failed ? <MapPlaceholder /> : this.props.children;
  }
}
