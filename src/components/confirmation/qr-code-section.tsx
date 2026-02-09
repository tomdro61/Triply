"use client";

import { useRef, useState, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Download, Copy, Check, Smartphone } from "lucide-react";

interface QRCodeSectionProps {
  confirmationId: string;
  lotName: string;
}

export function QRCodeSection({ confirmationId, lotName }: QRCodeSectionProps) {
  const [copied, setCopied] = useState(false);
  const qrRef = useRef<HTMLDivElement>(null);

  const qrData = confirmationId;

  const handleCopyCode = async () => {
    await navigator.clipboard.writeText(confirmationId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadQR = useCallback(() => {
    const svgElement = qrRef.current?.querySelector("svg");
    if (!svgElement) return;

    const svgData = new XMLSerializer().serializeToString(svgElement);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const img = new Image();

    img.onload = () => {
      canvas.width = img.width * 2;
      canvas.height = img.height * 2;
      if (ctx) {
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }
      const pngUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = pngUrl;
      a.download = `triply-checkin-${confirmationId}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };

    img.src = "data:image/svg+xml;base64," + btoa(svgData);
  }, [confirmationId]);

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
        <div
          ref={qrRef}
          className="bg-white p-4 rounded-xl border-2 border-gray-200 shadow-inner"
        >
          <QRCodeSVG
            value={qrData}
            size={200}
            level="H"
            includeMargin={true}
          />
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
