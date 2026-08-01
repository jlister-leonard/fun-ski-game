"use client";

import { SettingsHeader } from "@/components/settings/SettingsHeader";
import { ProfileSection } from "@/components/settings/ProfileSection";
import {
  AutoLockSection,
  PreferencesSection,
} from "@/components/settings/PreferencesSection";
import { GoalSection } from "@/components/settings/GoalSection";
import { StackSection } from "@/components/settings/StackSection";

/** Profile, display preferences, goal, and what the user takes. */
export default function ProfileSettingsPage() {
  return (
    <main className="px-4 pt-3 safe-t">
      <SettingsHeader title="Profile & preferences" />

      <div className="flex flex-col gap-4 pb-4">
        <PreferencesSection />
        <ProfileSection />
        <GoalSection />
        <StackSection />
        <AutoLockSection />

        <p className="px-1 pb-2 text-xs text-ink-3 leading-relaxed">
          None of this is medical advice, and nothing here is sent anywhere. The
          interaction checks come from tables that ship inside the app.
        </p>
      </div>
    </main>
  );
}
