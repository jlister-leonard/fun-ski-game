"use client";

import { HealthImport } from "@/components/settings/HealthImport";
import { SettingsHeader } from "@/components/settings/SettingsHeader";

/** Apple Health import. */
export default function HealthImportPage() {
  return (
    <main className="px-4 pt-3 safe-t">
      <SettingsHeader title="Apple Health" />
      <HealthImport />
    </main>
  );
}
