"use client";

import { useState } from "react";
import Image from "next/image";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { Photo } from "@/types/lot";

interface LotGalleryProps {
  photos: Photo[];
  lotName: string;
  tag?: string;
}

// Default gallery images when lot doesn't have enough photos
const defaultGalleryImages = [
  "https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&q=80&w=400",
  "https://images.unsplash.com/photo-1582719508461-905c673771fd?auto=format&fit=crop&q=80&w=400",
  "https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?auto=format&fit=crop&q=80&w=400",
  "https://images.unsplash.com/photo-1596394516093-501ba68a0ba6?auto=format&fit=crop&q=80&w=400",
];

export function LotGallery({ photos, lotName, tag }: LotGalleryProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);

  // Build gallery images array
  const mainImage = photos[0]?.url || defaultGalleryImages[0];
  const galleryImages = [
    mainImage,
    ...defaultGalleryImages.slice(0, 4),
  ];

  const totalPhotos = photos.length || galleryImages.length;
  const extraPhotos = Math.max(0, totalPhotos - 5);

  const openLightbox = (index: number) => {
    setCurrentIndex(index);
    setLightboxOpen(true);
  };

  const closeLightbox = () => {
    setLightboxOpen(false);
  };

  const nextImage = () => {
    setCurrentIndex((prev) => (prev + 1) % galleryImages.length);
  };

  const prevImage = () => {
    setCurrentIndex(
      (prev) => (prev - 1 + galleryImages.length) % galleryImages.length
    );
  };

  return (
    <>
      <div className="grid grid-cols-4 grid-rows-2 gap-2 h-96 rounded-xl overflow-hidden shadow-sm">
        {/* Main Image */}
        <div
          className="col-span-2 row-span-2 relative cursor-pointer group"
          onClick={() => openLightbox(0)}
        >
          <Image
            src={mainImage}
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

        {/* Gallery Thumbnails */}
        {galleryImages.slice(1, 5).map((image, index) => (
          <div
            key={index}
            className={`col-span-1 row-span-1 relative cursor-pointer group ${
              index === 3 ? "relative" : ""
            }`}
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

      {/* Lightbox */}
      {lightboxOpen && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center">
          <button
            onClick={closeLightbox}
            className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors"
          >
            <X size={24} className="text-white" />
          </button>

          <button
            onClick={prevImage}
            className="absolute left-4 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors"
          >
            <ChevronLeft size={32} className="text-white" />
          </button>

          <div className="relative w-full max-w-4xl h-[80vh]">
            <Image
              src={galleryImages[currentIndex]}
              alt={`${lotName} - Photo ${currentIndex + 1}`}
              fill
              className="object-contain"
              sizes="100vw"
            />
          </div>

          <button
            onClick={nextImage}
            className="absolute right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors"
          >
            <ChevronRight size={32} className="text-white" />
          </button>

          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-sm">
            {currentIndex + 1} / {galleryImages.length}
          </div>
        </div>
      )}
    </>
  );
}
