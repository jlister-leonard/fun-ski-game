"use client";

import { ChartGallery } from "@/components/charts/__gallery__/ChartGallery";

/**
 * Visual reference for the chart layer — every chart, every state, seeded
 * sample data. Not linked from the app; it exists so the design system can be
 * reviewed on a real device at a real width rather than in isolation.
 */
export default function GalleryPage() {
  return (
    <main className="px-4 pt-4 safe-t">
      <h1 className="text-2xl font-semibold text-ink mb-4">Charts</h1>
      <ChartGallery />
    </main>
  );
}
