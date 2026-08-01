"use client";

import { useEffect, useState } from "react";
import { ListGroup, ListRow } from "@/components/ui/ListRow";
import { LinkRow } from "@/components/settings/LinkRow";
import { VideoSettingsSection } from "@/components/video";
import { daysSinceLastBackup } from "@/lib/vault";

/**
 * Settings.
 *
 * A hub, not a screen full of controls. Each section owns a route of its own so
 * that a long-running job — a half-hour Apple Health import — has somewhere to
 * live that is not a modal the user can dismiss by accident.
 */
export default function SettingsPage() {
  const [backupDays, setBackupDays] = useState<number | null | undefined>(
    undefined
  );

  useEffect(() => {
    let cancelled = false;
    daysSinceLastBackup()
      .then((days) => {
        if (!cancelled) setBackupDays(days);
      })
      .catch(() => {
        if (!cancelled) setBackupDays(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="px-4 pt-3 safe-t">
      <header className="pt-2 pb-5">
        <h1 className="text-3xl font-semibold text-ink tracking-[-0.02em]">
          Settings
        </h1>
      </header>

      <div className="flex flex-col gap-6 pb-4">
        <Section title="Your data">
          <ListGroup>
            <LinkRow
              href="/settings/health/"
              title="Apple Health"
              subtitle="Import an export.zip — steps, sleep, workouts, labs"
            />
            <LinkRow
              href="/settings/shortcuts/"
              title="Daily sync shortcut"
              subtitle="Set up the Shortcuts automation"
            />
          </ListGroup>
        </Section>

        <Section
          title="Vault"
          footer="A backup is the only way back if this phone is lost. There is no copy anywhere else."
        >
          <ListGroup>
            <LinkRow
              href="/settings/vault/"
              title="Backup & restore"
              subtitle={backupLabel(backupDays)}
            />
            <LinkRow
              href="/settings/storage/"
              title="Storage on this device"
              subtitle="Keep the browser from evicting your data"
            />
          </ListGroup>
        </Section>

        <Section title="You">
          <ListGroup>
            <LinkRow
              href="/settings/profile/"
              title="Profile & preferences"
              subtitle="Units, theme, auto-lock, goal, supplements"
            />
            <LinkRow
              href="/settings/gyms/"
              title="Gyms & equipment"
              subtitle="What's available where you train"
            />
          </ListGroup>
        </Section>

        {/* The video settings own their own heading and explanatory copy —
            including the honest statement of what tapping play discloses — so
            they are mounted bare rather than wrapped in a Section. */}
        <VideoSettingsSection />

        <Section
          title="Other services"
          footer="Both vendors write into Apple Health, so their data already arrives through the import above."
        >
          <ListGroup>
            <ListRow
              title="Oura"
              subtitle="No direct connection — Oura withdrew personal access tokens"
              muted
              value={<ClosedTag />}
            />
            <ListRow
              title="Strava"
              subtitle="No direct connection — API access needs a paid subscription"
              muted
              value={<ClosedTag />}
            />
          </ListGroup>
        </Section>

        <p className="px-1 pb-2 text-xs text-ink-3 leading-relaxed">
          Keel is a tracking and planning tool, not medical advice. It
          doesn&rsquo;t diagnose or treat anything.
        </p>
      </div>
    </main>
  );
}

/** How stale the last backup is, in words rather than a raw count. */
function backupLabel(days: number | null | undefined): string {
  if (days === undefined) return "Checking…";
  if (days === null) return "Never backed up";
  if (days === 0) return "Backed up today";
  if (days === 1) return "Backed up yesterday";
  return `Last backup ${days} days ago`;
}

function ClosedTag() {
  return (
    <span className="text-2xs uppercase tracking-wide text-ink-3">
      Unavailable
    </span>
  );
}

function Section({
  title,
  footer,
  children,
}: {
  title: string;
  footer?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="px-1 pb-2 text-sm font-medium text-ink-2">{title}</h2>
      {children}
      {footer && (
        <p className="px-1 pt-2 text-xs text-ink-3 leading-relaxed">{footer}</p>
      )}
    </section>
  );
}
