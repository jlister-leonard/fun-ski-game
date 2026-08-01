"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import {
  enrollPasskey,
  listPasskeys,
  passkeyCapability,
  revokePasskey,
  type PasskeyCapability,
  type PasskeyDescriptor,
} from "@/lib/passkey";

/** Optional device-bound unlock without changing the passphrase path. */
export function PasskeySection() {
  const [capability, setCapability] = useState<PasskeyCapability | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyDescriptor[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextCapability, nextPasskeys] = await Promise.all([
      passkeyCapability(),
      listPasskeys(),
    ]);
    setCapability(nextCapability);
    setPasskeys(nextPasskeys);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([passkeyCapability(), listPasskeys()])
      .then(([nextCapability, nextPasskeys]) => {
        if (!cancelled) {
          setCapability(nextCapability);
          setPasskeys(nextPasskeys);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const enroll = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await enrollPasskey();
      await refresh();
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const revoke = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        await revokePasskey(id);
        await refresh();
      } catch (err) {
        setError((err as Error)?.message ?? "That passkey could not be removed.");
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const available = capability?.potentiallyAvailable === true;

  return (
    <Card>
      <CardHeader
        title="Face ID / passkey"
        subtitle={
          passkeys.length > 0
            ? `${passkeys.length} enrolled`
            : capability === null
              ? "Checking this device"
            : available
              ? "Optional faster unlock"
              : "Not available in this browser"
        }
      />

      <p className="mt-3 text-sm text-ink-2 leading-relaxed">
        A passkey can use Face ID, Touch ID, or your device unlock to open this
        vault. Your passphrase and recovery code keep working. Keel sends no
        account or health data anywhere.
      </p>

      {passkeys.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {passkeys.map((passkey) => (
            <li
              key={passkey.wrappingId}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-surface-2 px-3 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">
                  {passkey.label}
                </p>
                <p className="mt-0.5 text-xs text-ink-3">
                  Added {new Date(passkey.createdAt).toLocaleDateString()}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void revoke(passkey.wrappingId)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {capability && !available && (
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          {capability.topLevel
            ? "Use a device and browser that support passkey encryption, or keep using your passphrase."
            : "Open Keel directly or from its Home Screen icon to set up Face ID."}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger leading-relaxed">
          {error}
        </p>
      )}

      {available && (
        <div className="mt-4">
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            onClick={() => void enroll()}
          >
            {passkeys.length > 0 ? "Add this device" : "Set up Face ID or passkey"}
          </Button>
        </div>
      )}

      <p className="mt-3 text-xs text-ink-3 leading-relaxed">
        Keel verifies the passkey&rsquo;s encryption support during setup. Removing
        it here revokes vault access, though an inert passkey may remain in your
        device&rsquo;s password settings.
      </p>
    </Card>
  );
}

function passkeyErrorMessage(error: unknown): string {
  const err = error as Error;
  if (err?.name === "NotAllowedError") {
    return "Face ID or passkey setup was cancelled. Nothing changed.";
  }
  if (err?.name === "InvalidStateError") {
    return "This passkey is already enrolled on this device.";
  }
  return err?.message ?? "Face ID or passkey setup could not be completed.";
}
