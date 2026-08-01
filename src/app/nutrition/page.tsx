"use client";

import { DiaryScreen } from "@/components/nutrition/DiaryScreen";

/**
 * The Food tab (task graph node **S2**).
 *
 * The route is a thin shell; everything lives in `@/components/nutrition` so
 * the screen can be composed and tested without a router. See
 * `DiaryScreen.tsx` for the reading order and the safety constraints it
 * encodes.
 */
export default function FoodPage() {
  return <DiaryScreen />;
}
