"use client";

import { SettingsHeader } from "@/components/settings/SettingsHeader";
import { StorageSection } from "@/components/settings/StorageSection";

/** Storage durability — eviction, persistence, and installing to the Home Screen. */
export default function StorageSettingsPage() {
  return (
    <main className="px-4 pt-3 safe-t">
      <SettingsHeader title="Storage on this device" />
      <StorageSection />
    </main>
  );
}
