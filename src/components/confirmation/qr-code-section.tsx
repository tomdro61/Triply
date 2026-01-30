"use client";

import { useState } from "react";
import { Download, Copy, Check, Smartphone } from "lucide-react";

interface QRCodeSectionProps {
  confirmationId: string;
  lotName: string;
}

// Simple QR code pattern generator (demo purposes)
// In production, use a proper QR code library like 'qrcode' or 'qrcode.react'
function generateQRPattern(data: string): boolean[][] {
  const size = 21; // 21x21 for Version 1 QR code
  const pattern: boolean[][] = [];

  // Create a deterministic pattern based on the data
  const hash = data.split("").reduce((acc, char) => {
    return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
  }, 0);

  for (let y = 0; y < size; y++) {
    pattern[y] = [];
    for (let x = 0; x < size; x++) {
      // Position detection patterns (corners)
      const isFinderPattern =
        (x < 7 && y < 7) || // Top-left
        (x >= size - 7 && y < 7) || // Top-right
        (x < 7 && y >= size - 7); // Bottom-left

      if (isFinderPattern) {
        // Create finder pattern
        const inOuter =
          x === 0 ||
          x === 6 ||
          y === 0 ||
          y === 6 ||
          x === size - 7 ||
          x === size - 1 ||
          y === size - 7 ||
          y === size - 1;
        const inInner =
          (x >= 2 && x <= 4 && y >= 2 && y <= 4) ||
          (x >= size - 5 && x <= size - 3 && y >= 2 && y <= 4) ||
          (x >= 2 && x <= 4 && y >= size - 5 && y <= size - 3);
        pattern[y][x] = inOuter || inInner;
      } else {
        // Generate pseudo-random data pattern
        const seed = (hash + x * 31 + y * 17) >>> 0;
        pattern[y][x] = seed % 3 !== 0;
      }
    }
  }

  return pattern;
}

export function QRCodeSection({ confirmationId, lotName }: QRCodeSectionProps) {
  const [copied, setCopied] = useState(false);

  const qrData = `TRIPLY:${confirmationId}`;
  const pattern = generateQRPattern(qrData);
  const cellSize = 8;
  const padding = 16;
  const qrSize = pattern.length * cellSize + padding * 2;

  const handleCopyCode = async () => {
    await navigator.clipboard.writeText(confirmationId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadQR = () => {
    // Create SVG string
    const svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${qrSize}" height="${qrSize}" viewBox="0 0 ${qrSize} ${qrSize}">
        <rect width="100%" height="100%" fill="white"/>
        ${pattern
          .map((row, y) =>
            row
              .map((cell, x) =>
                cell
                  ? `<rect x="${padding + x * cellSize}" y="${padding + y * cellSize}" width="${cellSize}" height="${cellSize}" fill="black"/>`
                  : ""
              )
              .join("")
          )
          .join("")}
      </svg>
    `;

    const blob = new Blob([svgContent], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `triply-${confirmationId}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <div className="text-center mb-6">
        <h3 className="font-bold text-gray-900 text-lg mb-1">
          Your Check-in QR Code
        </h3>
        <p className="text-gray-500 text-sm">
          Show this code at the parking facility for quick check-in
        </p>
      </div>

      {/* QR Code Display */}
      <div className="flex justify-center mb-6">
        <div className="bg-white p-4 rounded-xl border-2 border-gray-200 shadow-inner">
          <svg
            width={qrSize}
            height={qrSize}
            viewBox={`0 0 ${qrSize} ${qrSize}`}
            className="block"
          >
            <rect width="100%" height="100%" fill="white" />
            {pattern.map((row, y) =>
              row.map(
                (cell, x) =>
                  cell && (
                    <rect
                      key={`${x}-${y}`}
                      x={padding + x * cellSize}
                      y={padding + y * cellSize}
                      width={cellSize}
                      height={cellSize}
                      fill="black"
                    />
                  )
              )
            )}
          </svg>
        </div>
      </div>

      {/* Confirmation ID */}
      <div className="bg-gray-50 rounded-lg p-4 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">
              Confirmation Code
            </p>
            <p className="font-mono font-bold text-lg text-gray-900">
              {confirmationId}
            </p>
          </div>
          <button
            onClick={handleCopyCode}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            {copied ? (
              <>
                <Check size={16} className="text-green-500" />
                Copied!
              </>
            ) : (
              <>
                <Copy size={16} />
                Copy
              </>
            )}
          </button>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={handleDownloadQR}
          className="flex items-center justify-center gap-2 py-3 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition-colors"
        >
          <Download size={18} />
          Download QR
        </button>
        <button
          onClick={() => {
            // In a real app, this would open the mobile wallet
            alert("Add to Wallet feature coming soon!");
          }}
          className="flex items-center justify-center gap-2 py-3 bg-black text-white rounded-lg font-medium hover:bg-gray-800 transition-colors"
        >
          <Smartphone size={18} />
          Add to Wallet
        </button>
      </div>

      {/* Facility Name */}
      <p className="text-center text-sm text-gray-500 mt-4">
        Valid for check-in at <strong>{lotName}</strong>
      </p>
    </div>
  );
}
