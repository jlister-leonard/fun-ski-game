"use client";

import { useEffect, useState } from "react";
import { SettingsHeader } from "@/components/settings/SettingsHeader";
import {
  BackupSection,
  RestoreSection,
} from "@/components/settings/BackupSection";
import {
  DangerSection,
  PassphraseSection,
  RecoveryCodeSection,
} from "@/components/settings/SecuritySection";
import { PasskeySection } from "@/components/settings/PasskeySection";
import { countAllRows } from "@/lib/db";

/** Backup, restore, and the keys that open the vault. */
export default function VaultSettingsPage() {
  const [records, setRecords] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    countAllRows()
      .then(({ total }) => {
        if (!cancelled) setRecords(total);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="px-4 pt-3 safe-t">
      <SettingsHeader
        title="Backup & restore"
        subtitle={
          records === null
            ? undefined
            : `${records.toLocaleString()} records on this device`
        }
      />

      <div className="flex flex-col gap-4 pb-4">
        <BackupSection />
        <RestoreSection />
        <PassphraseSection />
        <RecoveryCodeSection />
        <PasskeySection />
        <DangerSection recordCount={records} />

        <p className="px-1 pb-2 text-xs text-ink-3 leading-relaxed">
          Backups never leave this device on their own. Where you put the file
          afterwards — iCloud Drive, a laptop, a USB stick — is your choice, and
          it stays encrypted wherever it lands.
        </p>
      </div>
    </main>
  );
}
