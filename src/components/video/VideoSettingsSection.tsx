"use client";

/**
 * @file The Video block for the Settings screen.
 *
 * Mount it from `src/app/settings/page.tsx` (owned by the settings agent):
 *
 * ```tsx
 * import { VideoSettingsSection } from "@/components/video";
 * <VideoSettingsSection />
 * ```
 *
 * Every control here states its actual consequence rather than a vague virtue.
 * "Stricter mode" that silently costs the user their Premium and hands them
 * pre-roll ads mid-set is not a privacy setting they consented to; it is a
 * surprise. So the nocookie toggle says what it does, in one line.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, Card, CardHeader, Switch } from "@/components/ui";
import {
  clearPinnedDemos,
  deleteAllUserDemos,
  setPreferNativeApp,
  setVideoEnabled,
  setVideoHost,
  userDemoStorageUsage,
  type DemoStorageUsage,
} from "@/lib/video";
import { formatBytes } from "./UserDemoSheet";
import { useVideoPreferences } from "./hooks";

/** One labelled row with a control on the right. */
function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-base text-ink">{title}</p>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{hint}</p>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

/**
 * Video preferences, storage usage, and the two destructive buttons.
 */
export function VideoSettingsSection() {
  const prefs = useVideoPreferences();
  const [usage, setUsage] = useState<DemoStorageUsage | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshUsage = useCallback(() => {
    userDemoStorageUsage()
      .then(setUsage)
      .catch(() => setUsage(null));
  }, []);

  useEffect(refreshUsage, [refreshUsage]);

  const pinnedCount = Object.keys(prefs.overrides).length;

  return (
    <Card flush>
      <div className="px-4 pt-4">
        <CardHeader
          title="Video"
          subtitle="Exercise demonstrations. The only feature here that talks to anyone else."
        />
      </div>

      <div className="mt-2 divide-y divide-[var(--c-border)]">
        <Row
          title="Demonstration video"
          hint={
            prefs.enabled
              ? "Nothing is requested from YouTube until you tap play."
              : "Off: no YouTube player is loaded anywhere in the app. Your own clips still play."
          }
        >
          <Switch
            checked={prefs.enabled}
            onChange={(next) => void setVideoEnabled(next)}
            label="Demonstration video"
          />
        </Row>

        <Row
          title="Sign-out mode"
          hint={
            prefs.host === "nocookie"
              ? "On: plays from youtube-nocookie.com. Stricter, but you are signed out — so your Premium does not apply and you will get ads."
              : "Off: the normal player, which uses your YouTube session. Premium applies, so no ads."
          }
        >
          <Switch
            checked={prefs.host === "nocookie"}
            onChange={(next) => void setVideoHost(next ? "nocookie" : "standard")}
            label="Sign-out mode"
            disabled={!prefs.enabled}
          />
        </Row>

        <Row
          title="Always open in YouTube"
          hint="Hands off to the YouTube app instead of playing in a card. Installed web apps have their own cookie store, so this is the reliable way to keep Premium."
        >
          <Switch
            checked={prefs.preferNativeApp}
            onChange={(next) => void setPreferNativeApp(next)}
            label="Always open in YouTube"
            disabled={!prefs.enabled}
          />
        </Row>

        <Row
          title="Pinned videos"
          hint={
            pinnedCount === 0
              ? "None yet. Pin one from any exercise and it sticks — pinned ids are in your encrypted backup."
              : `${pinnedCount} movement${pinnedCount === 1 ? "" : "s"} have a video you chose.`
          }
        >
          <Button
            size="sm"
            variant="quiet"
            disabled={pinnedCount === 0 || busy}
            onClick={() => {
              setBusy(true);
              void clearPinnedDemos().finally(() => setBusy(false));
            }}
          >
            Clear
          </Button>
        </Row>

        <Row
          title="Your recordings"
          hint={
            usage && usage.count > 0
              ? `${usage.count} clip${usage.count === 1 ? "" : "s"}, ${formatBytes(usage.bytes)}, encrypted on this device. Included when you choose “Back up vault and clips”; excluded from vault-only backups.`
              : "Clips you or your trainer film. Encrypted here, never uploaded."
          }
        >
          <Button
            size="sm"
            variant="destructive"
            disabled={!usage || usage.count === 0 || busy}
            onClick={() => {
              setBusy(true);
              void deleteAllUserDemos()
                .then(refreshUsage)
                .finally(() => setBusy(false));
            }}
          >
            Delete all
          </Button>
        </Row>
      </div>

      <p className="px-4 pb-4 pt-3 text-xs leading-relaxed text-ink-3">
        When you play a YouTube video, Google learns the video id, your IP address
        and the time. It cannot read anything in your vault — the player runs in a
        separate origin the browser keeps walled off from this app. Your weight,
        food, sleep and training data are never sent anywhere.
      </p>
    </Card>
  );
}
