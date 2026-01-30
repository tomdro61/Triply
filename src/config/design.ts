export const design = {
  colors: {
    primary: "#f87356", // Coral Orange
    secondary: "#1A1A2E", // Dark Navy
    accent: "#FFFFFF", // White
    text: "#1e293b", // Dark Slate
    muted: "#64748b", // Gray
    success: "#22c55e",
    warning: "#f59e0b",
    error: "#ef4444",
  },
  fonts: {
    heading: "Poppins",
    body: "Inter",
  },
} as const;

export type Design = typeof design;
