"use client";

export default function OfflinePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-secondary text-white p-4">
      <div className="text-center max-w-md">
        <div className="text-6xl mb-4">📶</div>
        <h1 className="text-2xl font-bold mb-2 font-heading">
          You&apos;re Offline
        </h1>
        <p className="text-muted-foreground mb-6">
          It looks like you&apos;ve lost your internet connection. Please check
          your connection and try again.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="bg-primary hover:bg-primary/90 text-white px-6 py-3 rounded-lg font-medium transition-colors"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
