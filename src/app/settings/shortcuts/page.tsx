"use client";

import { SettingsHeader } from "@/components/settings/SettingsHeader";
import { ShortcutsWizard } from "@/components/settings/ShortcutsWizard";

/** The Shortcuts automation, rendered as followable steps. */
export default function ShortcutsSettingsPage() {
  return (
    <main className="px-4 pt-3 safe-t">
      <SettingsHeader
        title="Daily sync shortcut"
        subtitle="A daily top-up between full imports. Nothing leaves the phone."
      />
      <ShortcutsWizard />
    </main>
  );
}
