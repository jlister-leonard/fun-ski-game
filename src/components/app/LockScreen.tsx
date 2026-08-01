"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { unlock, unlockWithRecoveryCode } from "@/lib/vault";
import {
  listPasskeys,
  passkeyCapability,
  unlockWithPasskey,
} from "@/lib/passkey";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

type Mode = "passphrase" | "recovery";
const NO_SUBSCRIBE = () => () => {};
type RestoreNotice = "complete" | "media-incomplete" | null;
let restoreNotice: RestoreNotice | undefined;

function readRestoreNotice(): RestoreNotice {
  if (restoreNotice !== undefined) return restoreNotice;
  try {
    if (sessionStorage.getItem("keel.media-restore-interrupted") === "1") {
      restoreNotice = "media-incomplete";
      sessionStorage.removeItem("keel.media-restore-interrupted");
    } else if (sessionStorage.getItem("keel.restore-complete") === "1") {
      restoreNotice = "complete";
      sessionStorage.removeItem("keel.restore-complete");
    } else {
      restoreNotice = null;
    }
  } catch {
    restoreNotice = null;
  }
  return restoreNotice;
}

/**
 * The lock screen.
 *
 * This is not a login form. There is no server and no account — the passphrase
 * derives the key that decrypts the local vault, so a wrong entry fails
 * because AES-GCM's authentication tag doesn't verify, not because something
 * said no. That distinction is why there's no "forgot password" link: nobody
 * can reset it.
 */
export function LockScreen() {
  const restored = useSyncExternalStore(
    NO_SUBSCRIBE,
    readRestoreNotice,
    () => null
  );
  const [mode, setMode] = useState<Mode>("passphrase");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeyReady, setPasskeyReady] = useState(false);
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([passkeyCapability(), listPasskeys()])
      .then(([capability, passkeys]) => {
        if (!cancelled) {
          setPasskeyReady(capability.potentiallyAvailable && passkeys.length > 0);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const faceUnlock = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await unlockWithPasskey();
    } catch (err) {
      const name = (err as Error)?.name;
      setError(
        name === "NotAllowedError"
          ? "Face ID or passkey unlock was cancelled. Use your passphrase instead."
          : (err as Error)?.message ??
              "Face ID could not unlock this vault. Use your passphrase instead."
      );
      setShake(true);
      window.setTimeout(() => setShake(false), 420);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!value || busy) return;
      setBusy(true);
      setError(null);
      try {
        if (mode === "passphrase") await unlock(value);
        else await unlockWithRecoveryCode(value);
        setValue("");
      } catch (err) {
        const name = (err as Error)?.name ?? "";
        setError(
          name === "RecoveryCodeError"
            ? "That recovery code doesn't look right — check for a mistyped character."
            : mode === "recovery"
              ? "That recovery code didn't unlock the vault."
              : "That passphrase didn't unlock the vault."
        );
        setShake(true);
        window.setTimeout(() => setShake(false), 420);
        inputRef.current?.select();
      } finally {
        setBusy(false);
      }
    },
    [value, busy, mode]
  );

  const swapMode = useCallback(() => {
    setMode((m) => (m === "passphrase" ? "recovery" : "passphrase"));
    setValue("");
    setError(null);
  }, []);

  return (
    <main className="min-h-[100svh] flex flex-col items-center justify-center px-6 safe-t safe-b">
      <div
        className={cn(
          "w-full max-w-sm",
          shake && "motion-safe:animate-[shake_0.4s_ease-in-out]"
        )}
      >
        <div className="flex flex-col items-center text-center mb-9">
          <Mark />
          <h1 className="mt-5 text-2xl font-semibold text-ink">Keel</h1>
          <p className="mt-1.5 text-sm text-ink-2 max-w-[26ch]">
            Your data is encrypted on this device. Nothing leaves it.
          </p>
        </div>

        {restored === "complete" && (
          <p
            role="status"
            className="mb-4 rounded-[var(--radius-md)] border border-accent bg-accent-quiet px-3.5 py-3 text-sm text-ink leading-relaxed"
          >
            Restore complete. Unlock with the backup&rsquo;s passphrase or
            recovery code.
          </p>
        )}

        {restored === "media-incomplete" && (
          <p
            role="status"
            className="mb-4 rounded-[var(--radius-md)] border border-danger/35 bg-danger-quiet px-3.5 py-3 text-sm text-ink leading-relaxed"
          >
            The vault restored, but clip restoration was interrupted. Keel
            safely removed the partial clips. Unlock, then run the same backup
            again to restore them.
          </p>
        )}

        {passkeyReady && (
          <>
            <Button
              type="button"
              size="lg"
              block
              loading={busy}
              onClick={() => void faceUnlock()}
            >
              Unlock with Face ID or passkey
            </Button>
            <div className="my-4 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-line" />
              <span className="text-xs text-ink-3">or use a secret</span>
              <span className="h-px flex-1 bg-line" />
            </div>
          </>
        )}

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label htmlFor="unlock" className="sr-only">
            {mode === "passphrase" ? "Passphrase" : "Recovery code"}
          </label>
          <input
            id="unlock"
            ref={inputRef}
            type={mode === "passphrase" ? "password" : "text"}
            inputMode={mode === "recovery" ? "text" : undefined}
            autoComplete={mode === "passphrase" ? "current-password" : "off"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            // 16px minimum, or iOS zooms the viewport on focus.
            style={{ fontSize: 16 }}
            className={cn(
              "w-full h-13 px-4 py-3 rounded-[var(--radius-md)]",
              "bg-surface border text-ink placeholder:text-ink-3",
              "transition-colors duration-[var(--duration-fast)]",
              error ? "border-danger" : "border-line focus:border-accent",
              "outline-none"
            )}
            placeholder={
              mode === "passphrase" ? "Passphrase" : "XXXX-XXXX-XXXX-XXXX"
            }
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            disabled={busy}
          />

          {error && (
            <p role="alert" className="text-sm text-danger px-1">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" block loading={busy} disabled={!value}>
            Unlock
          </Button>
        </form>

        <button
          type="button"
          onClick={swapMode}
          className="mt-5 w-full text-sm text-ink-2 active:text-ink tap"
        >
          {mode === "passphrase"
            ? "Use recovery code instead"
            : "Use passphrase instead"}
        </button>
      </div>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-7px); }
          40% { transform: translateX(6px); }
          60% { transform: translateX(-4px); }
          80% { transform: translateX(2px); }
        }
      `}</style>
    </main>
  );
}

function Mark() {
  return (
    <svg
      viewBox="0 0 100 100"
      className="h-16 w-16"
      role="img"
      aria-label="Keel"
    >
      <defs>
        <linearGradient id="keel-mark" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--c-accent)" />
          <stop offset="100%" stopColor="var(--c-info)" />
        </linearGradient>
      </defs>
      <path
        d="M 12 76 C 40 94, 62 50, 88 16"
        fill="none"
        stroke="url(#keel-mark)"
        strokeWidth="11"
        strokeLinecap="round"
      />
      <circle cx="88" cy="16" r="6.5" fill="var(--c-info)" />
    </svg>
  );
}
