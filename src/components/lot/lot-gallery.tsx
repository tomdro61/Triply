"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { Photo } from "@/types/lot";

interface LotGalleryProps {
  photos: Photo[];
  lotName: string;
  tag?: string;
}

function Lightbox({
  images,
  currentIndex,
  onClose,
  onPrev,
  onNext,
  lotName,
}: {
  images: string[];
  currentIndex: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  lotName: string;
}) {
  const showNav = images.length > 1;

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        backgroundColor: "rgba(0, 0, 0, 0.92)",
        overflow: "hidden",
      }}
    >
      {/* X button */}
      <button
        onClick={onClose}
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          zIndex: 10,
          padding: 8,
          backgroundColor: "rgba(255,255,255,0.2)",
          borderRadius: "50%",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <X size={22} color="white" />
      </button>

      {/* Previous button */}
      {showNav && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          style={{
            position: "absolute",
            left: 8,
            top: "50%",
            transform: "translateY(-50%)",
            zIndex: 10,
            padding: 8,
            backgroundColor: "rgba(255,255,255,0.15)",
            borderRadius: "50%",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ChevronLeft size={28} color="white" />
        </button>
      )}

      {/* Next button */}
      {showNav && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          style={{
            position: "absolute",
            right: 8,
            top: "50%",
            transform: "translateY(-50%)",
            zIndex: 10,
            padding: 8,
            backgroundColor: "rgba(255,255,255,0.15)",
            borderRadius: "50%",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ChevronRight size={28} color="white" />
        </button>
      )}

      {/* Centered image */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={images[currentIndex]}
        alt={`${lotName} - Photo ${currentIndex + 1}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          maxWidth: "90vw",
          maxHeight: "85vh",
          objectFit: "contain",
        }}
      />

      {/* Counter */}
      {showNav && (
        <div
          style={{
            position: "absolute",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            color: "white",
            fontSize: 14,
          }}
        >
          {currentIndex + 1} / {images.length}
        </div>
      )}
    </div>,
    document.body
  );
}

export function LotGallery({ photos, lotName, tag }: LotGalleryProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);

  // Only use photos from the API
  const galleryImages = photos.map((p) => p.url);

  // If no photos, don't render the gallery
  if (galleryImages.length === 0) {
    return null;
  }

  const extraPhotos = Math.max(0, galleryImages.length - 5);

  const openLightbox = (index: number) => {
    setCurrentIndex(index);
    setLightboxOpen(true);
  };

  const closeLightbox = () => {
    setLightboxOpen(false);
  };

  // Lock body scroll when lightbox is open
  useEffect(() => {
    if (lightboxOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [lightboxOpen]);

  const nextImage = () => {
    setCurrentIndex((prev) => (prev + 1) % galleryImages.length);
  };

  const prevImage = () => {
    setCurrentIndex(
      (prev) => (prev - 1 + galleryImages.length) % galleryImages.length
    );
  };

  // Single image layout
  if (galleryImages.length === 1) {
    return (
      <>
        <div className="h-96 rounded-xl overflow-hidden shadow-sm">
          <div
            className="relative w-full h-full cursor-pointer group"
            onClick={() => openLightbox(0)}
          >
            <Image
              src={galleryImages[0]}
              alt={`${lotName} - Main view`}
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-300"
              sizes="(max-width: 768px) 100vw, 100vw"
              priority
            />
            {tag && (
              <div className="absolute top-4 left-4 bg-white/90 backdrop-blur px-3 py-1 rounded-full text-xs font-bold text-gray-800 shadow-sm">
                {tag}
              </div>
            )}
          </div>
        </div>

        {lightboxOpen && (
          <Lightbox
            images={galleryImages}
            currentIndex={0}
            onClose={closeLightbox}
            onPrev={prevImage}
            onNext={nextImage}
            lotName={lotName}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="grid grid-cols-4 grid-rows-2 gap-2 h-96 rounded-xl overflow-hidden shadow-sm">
        {/* Main Image */}
        <div
          className="col-span-2 row-span-2 relative cursor-pointer group"
          onClick={() => openLightbox(0)}
        >
          <Image
            src={galleryImages[0]}
            alt={`${lotName} - Main view`}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-300"
            sizes="(max-width: 768px) 100vw, 50vw"
            priority
          />
          {tag && (
            <div className="absolute top-4 left-4 bg-white/90 backdrop-blur px-3 py-1 rounded-full text-xs font-bold text-gray-800 shadow-sm">
              {tag}
            </div>
          )}
        </div>

        {/* Gallery Thumbnails - show up to 4 more images */}
        {galleryImages.slice(1, 5).map((image, index) => (
          <div
            key={index}
            className="col-span-1 row-span-1 relative cursor-pointer group"
            onClick={() => openLightbox(index + 1)}
          >
            <Image
              src={image}
              alt={`${lotName} - Gallery ${index + 1}`}
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-300"
              sizes="(max-width: 768px) 50vw, 25vw"
            />
            {index === 3 && extraPhotos > 0 && (
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center group-hover:bg-black/50 transition-colors">
                <span className="text-white font-bold text-sm">
                  +{extraPhotos} More
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {lightboxOpen && (
        <Lightbox
          images={galleryImages}
          currentIndex={currentIndex}
          onClose={closeLightbox}
          onPrev={prevImage}
          onNext={nextImage}
          lotName={lotName}
        />
      )}
    </>
  );
}
