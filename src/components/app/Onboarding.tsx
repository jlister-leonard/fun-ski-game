"use client";

import { useCallback, useMemo, useState } from "react";
import { assessPassphrase, initializeVault } from "@/lib/vault";
import { Button } from "@/components/ui/Button";
import { Intake } from "@/components/onboarding/Intake";
import {
  InstallStep,
  requiresInstallBeforeVault,
} from "@/components/onboarding/InstallStep";
import { beginIntake } from "@/components/onboarding/store";
import { cn } from "@/lib/cn";

type Step = "intro" | "install" | "passphrase" | "recovery" | "intake";

export interface OnboardingProps {
  /** Fired the moment the vault exists, so the gate keeps this flow on screen
   *  through the recovery-code step instead of jumping to the app. */
  onVaultCreated: () => void;
  /** Fired when the user has confirmed they've saved the recovery code. */
  onComplete: () => void;
}

/**
 * First run.
 *
 * On iOS, installation has to land before either security step. A Home Screen
 * app has separate IndexedDB storage from the browser that installed it, so a
 * vault created first would be stranded in the browser. The gate is checked
 * both when setup begins and again immediately before vault creation.
 *
 * The passphrase and recovery code are also correctness requirements rather
 * than onboarding filler. Once the code is saved, control passes to
 * `@/components/onboarding/Intake` for the answers the engines need — body
 * composition, goal and rate, training, and health context. Those profile
 * steps can be skipped, are resumable, and state what skipping turns off.
 */
export function Onboarding({ onVaultCreated, onComplete }: OnboardingProps) {
  const [step, setStep] = useState<Step>("intro");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const assessment = useMemo(
    () => (passphrase ? assessPassphrase(passphrase) : null),
    [passphrase]
  );

  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const canSubmit =
    !!assessment?.acceptable && confirm === passphrase && !busy;

  const startSetup = useCallback(() => {
    // This is the normal iOS gate: never even show the passphrase form in a
    // browser storage container that the installed app will not inherit.
    setStep(requiresInstallBeforeVault() ? "install" : "passphrase");
  }, []);

  const create = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // Re-check at the write boundary. This protects stale tabs restored on
      // iOS and future navigation changes from bypassing the visible gate.
      if (requiresInstallBeforeVault()) {
        setPassphrase("");
        setConfirm("");
        setStep("install");
        return;
      }
      const { recoveryCode: code } = await initializeVault(passphrase, {
        issueRecoveryCode: true,
      });
      setRecoveryCode(code);
      setPassphrase("");
      setConfirm("");
      setStep("recovery");
      // Tell the gate to hold this flow on screen — the vault is now unlocked,
      // and without this it would swap to the app before the code is shown.
      onVaultCreated();
    } catch (err) {
      setError((err as Error)?.message ?? "Could not create the vault.");
    } finally {
      setBusy(false);
    }
  }, [canSubmit, passphrase, onVaultCreated]);

  if (step === "intro") {
    return (
      <Shell>
        <h1 className="text-3xl font-semibold text-ink tracking-[-0.02em]">
          Everything stays
          <br />
          on this phone.
        </h1>
        <p className="mt-4 text-base text-ink-2 leading-relaxed">
          Keel has no server and no account. Your training, food and health data
          are encrypted and stored on this device only — there is nowhere else
          for them to go.
        </p>
        <p className="mt-3 text-base text-ink-2 leading-relaxed">
          That means the passphrase you&rsquo;re about to choose is the only way
          in. Nobody can reset it for you, because there is no &ldquo;us&rdquo;
          to ask.
        </p>
        <div className="mt-8">
          <Button size="lg" block onClick={startSetup}>
            Continue
          </Button>
        </div>
      </Shell>
    );
  }

  if (step === "install") {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold text-ink">
          Install Keel before setup
        </h1>
        <div className="mt-4">
          <InstallStep required />
        </div>
      </Shell>
    );
  }

  if (step === "passphrase") {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold text-ink">
          Choose a passphrase
        </h1>
        <p className="mt-2 text-sm text-ink-2 leading-relaxed">
          Several unrelated words beat one clever word. Save it in your password
          manager now — you will not get a second chance.
        </p>

        <div className="mt-6 flex flex-col gap-3">
          <Field
            id="pass"
            label="Passphrase"
            value={passphrase}
            onChange={setPassphrase}
            autoComplete="new-password"
          />
          {assessment && (
            <StrengthMeter
              score={assessment.score}
              bits={assessment.entropyBits}
              advice={assessment.advice}
            />
          )}
          <Field
            id="confirm"
            label="Confirm"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            invalid={mismatch}
          />
          {mismatch && (
            <p className="text-sm text-danger px-1">
              These don&rsquo;t match yet.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger px-1">
              {error}
            </p>
          )}
        </div>

        <div className="mt-7">
          <Button
            size="lg"
            block
            onClick={create}
            disabled={!canSubmit}
            loading={busy}
          >
            Create my vault
          </Button>
        </div>
      </Shell>
    );
  }

  if (step === "intake") {
    return <Intake onFinish={onComplete} />;
  }

  return (
    <Shell>
      <h1 className="text-2xl font-semibold text-ink">Your recovery code</h1>
      <p className="mt-2 text-sm text-ink-2 leading-relaxed">
        This unlocks your vault if you forget the passphrase. It is shown once.
        Write it down or put it somewhere physical — a screenshot on this same
        phone is not a backup.
      </p>

      <div className="mt-6 rounded-[var(--radius-md)] border border-line bg-surface p-4">
        <code className="block text-center text-lg font-mono tracking-[0.12em] text-ink break-all">
          {recoveryCode}
        </code>
      </div>

      <label className="mt-5 flex items-start gap-3 tap cursor-pointer">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="mt-1 h-5 w-5 accent-[var(--c-accent)]"
        />
        <span className="text-sm text-ink-2 leading-relaxed">
          I&rsquo;ve saved this somewhere I can get to it without this phone.
        </span>
      </label>

      <div className="mt-7">
        {/* Marking the intake as started here, rather than inside it, is what
            makes it resumable: if the app is closed on the first question, the
            next unlock picks up where it stopped instead of dropping the user
            into an app full of empty states with no way back to the flow. */}
        <Button
          size="lg"
          block
          disabled={!saved}
          onClick={() => {
            void beginIntake();
            setStep("intake");
          }}
        >
          Next
        </Button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-[100svh] flex flex-col justify-center px-6 py-10 safe-t safe-b">
      <div className="w-full max-w-sm mx-auto">{children}</div>
    </main>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  autoComplete,
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  invalid?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        type="password"
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        // 16px or iOS zooms the viewport on focus.
        style={{ fontSize: 16 }}
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "w-full px-4 py-3 rounded-[var(--radius-md)] outline-none",
          "bg-surface border text-ink placeholder:text-ink-3",
          "transition-colors duration-[var(--duration-fast)]",
          invalid ? "border-danger" : "border-line focus:border-accent"
        )}
      />
    </div>
  );
}

const STRENGTH_LABELS = ["Very weak", "Weak", "Fair", "Good", "Strong"];

function StrengthMeter({
  score,
  bits,
  advice,
}: {
  score: 0 | 1 | 2 | 3 | 4;
  bits: number;
  advice: string;
}) {
  return (
    <div className="px-1">
      <div className="flex gap-1.5" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors duration-[var(--duration-base)]",
              i < score ? "bg-accent" : "bg-[var(--c-border)]"
            )}
          />
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-2">
        <span className="text-ink">{STRENGTH_LABELS[score]}</span>
        <span className="text-ink-3"> · ~{Math.round(bits)} bits</span>
        {advice ? ` — ${advice}` : null}
      </p>
    </div>
  );
}
