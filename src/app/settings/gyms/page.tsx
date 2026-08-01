"use client";

import { SettingsHeader } from "@/components/settings/SettingsHeader";
import { GymsScreen } from "@/components/gyms/GymsScreen";

/**
 * Gyms & equipment.
 *
 * One route rather than a route per profile: profile ids live only in
 * encrypted IndexedDB and do not belong in a server URL. The editor is state
 * inside this page instead, which also makes "back" mean "back to the list"
 * rather than "out of Settings".
 */
export default function GymsSettingsPage() {
  return (
    <main className="px-4 pt-3 safe-t">
      <SettingsHeader
        title="Gyms & equipment"
        subtitle="What each place you train has, so a session is never planned around kit you cannot reach."
      />
      <GymsScreen />
    </main>
  );
}
