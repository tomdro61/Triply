import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Triply - Your Trip Simplified";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "linear-gradient(135deg, #f87356 0%, #e05535 100%)",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "16px",
            marginBottom: "24px",
          }}
        >
          <svg
            width="64"
            height="64"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
          </svg>
        </div>
        <div
          style={{
            fontSize: 80,
            fontWeight: 700,
            color: "white",
            letterSpacing: "-2px",
          }}
        >
          Triply
        </div>
        <div
          style={{
            fontSize: 32,
            color: "rgba(255, 255, 255, 0.9)",
            marginTop: "12px",
            fontWeight: 400,
          }}
        >
          Your Trip Simplified
        </div>
        <div
          style={{
            display: "flex",
            gap: "32px",
            marginTop: "48px",
            fontSize: 20,
            color: "rgba(255, 255, 255, 0.8)",
          }}
        >
          <span>Compare Parking</span>
          <span>|</span>
          <span>Book Online</span>
          <span>|</span>
          <span>Save Money</span>
        </div>
      </div>
    ),
    { ...size }
  );
}
