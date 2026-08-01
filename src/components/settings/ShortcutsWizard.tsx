"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { cn } from "@/lib/cn";

/**
 * The JSON template the Shortcut builds.
 *
 * Health Auto Export's own wire format, because `lib/ingest` already parses it
 * (`HAE_METRICS`, `HaeEnvelope`) and a bespoke shape would mean a second
 * parser. The `⟨…⟩` placeholders are where the user drops a magic-variable
 * chip; they are deliberately not `{{mustache}}`, which reads as something the
 * app will substitute rather than something the user must replace by hand.
 */
const PAYLOAD_TEMPLATE = `{
  "data": {
    "metrics": [
      { "name": "step_count", "units": "count",
        "data": [{ "date": "⟨timestamp⟩", "qty": ⟨steps⟩ }] },
      { "name": "active_energy", "units": "kcal",
        "data": [{ "date": "⟨timestamp⟩", "qty": ⟨activeCalories⟩ }] },
      { "name": "resting_heart_rate", "units": "count/min",
        "data": [{ "date": "⟨timestamp⟩", "qty": ⟨restingHR⟩ }] },
      { "name": "heart_rate_variability", "units": "ms",
        "data": [{ "date": "⟨timestamp⟩", "qty": ⟨hrv⟩ }] },
      { "name": "apple_exercise_time", "units": "min",
        "data": [{ "date": "⟨timestamp⟩", "qty": ⟨exerciseMinutes⟩ }] },
      { "name": "weight_body_mass", "units": "lb",
        "data": [{ "date": "⟨timestamp⟩", "qty": ⟨weight⟩ }] }
    ]
  }
}`;

/** One `Find Health Samples` action the user has to add. */
interface SampleRow {
  sample: string;
  aggregate: string;
  period: string;
  variable: string;
}

const SAMPLES: readonly SampleRow[] = [
  { sample: "Steps", aggregate: "Sum", period: "Today", variable: "steps" },
  {
    sample: "Active Energy Burned",
    aggregate: "Sum",
    period: "Today",
    variable: "activeCalories",
  },
  {
    sample: "Resting Heart Rate",
    aggregate: "Latest",
    period: "Last 7 days",
    variable: "restingHR",
  },
  {
    sample: "Heart Rate Variability",
    aggregate: "Average",
    period: "Last 24 hours",
    variable: "hrv",
  },
  {
    sample: "Apple Exercise Time",
    aggregate: "Sum",
    period: "Today",
    variable: "exerciseMinutes",
  },
  {
    sample: "Body Mass",
    aggregate: "Latest",
    period: "Last 30 days",
    variable: "weight",
  },
];

/**
 * The Shortcuts setup wizard.
 *
 * ## Why this exists at all, given the import screen
 *
 * `export.zip` is the high-fidelity path but it is a two-minute manual chore.
 * A Shortcut is the opposite: it runs on a schedule and gives you a handful of
 * daily aggregates. They are complements, and the spec is blunt about the
 * trade — Shortcuts is "a good daily-increment mechanism and a bad
 * backfill/fidelity mechanism". This screen says that up front so nobody builds
 * the automation expecting sleep stages out of it.
 *
 * ## Why the clipboard, and not a URL
 *
 * The original design opened a URL with the payload in the fragment. It was
 * abandoned because `Open URLs` opens **Safari**, and an installed Home Screen
 * web app has a **separate storage partition** from Safari — the data would
 * have landed in a different, empty vault than the one the user opens. The
 * clipboard has the identical privacy property (nothing leaves the device) with
 * none of that risk, and no URL-length ceiling.
 */
export function ShortcutsWizard() {
  return (
    <div className="flex flex-col gap-4 pb-4">
      <Card>
        <CardHeader
          title="What this gets you, and what it doesn’t"
          subtitle="Worth reading before you spend ten minutes on it"
        />
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          A Shortcut can read daily <em>totals and averages</em>: steps, active
          energy, resting heart rate, HRV, exercise minutes, body mass. That is
          genuinely useful as a daily top-up between full imports.
        </p>
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          It <strong className="text-ink">cannot</strong> read sleep stages,
          workout routes, or heart rate during a workout. Those only exist in
          the full export. If you want sleep detail, the file import is the only
          path — the Shortcut will not fill that gap later.
        </p>
      </Card>

      <Phase
        number={1}
        title="Create the shortcut"
        steps={[
          <>
            Open the <Strong>Shortcuts</Strong> app.
          </>,
          <>
            Tap <Strong>+</Strong> at the top right, then name it{" "}
            <Strong>Sync Health</Strong>.
          </>,
          <>Tap the search bar at the bottom to start adding actions.</>,
        ]}
      />

      <Card>
        <CardHeader
          title="Phase 2 — read the health data"
          subtitle="One Find Health Samples action per row"
        />
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          For each row: add <Strong>Find Health Samples</Strong>, set{" "}
          <Strong>Aggregate</Strong> and <Strong>Period</Strong>, then add a{" "}
          <Strong>Set Variable</Strong> action with the name in the last column.
        </p>
        <div className="mt-4 -mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[26rem] text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wide text-ink-3">
                <th className="pb-2 pr-3 font-medium">Sample</th>
                <th className="pb-2 pr-3 font-medium">Aggregate</th>
                <th className="pb-2 pr-3 font-medium">Period</th>
                <th className="pb-2 font-medium">Variable</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--c-border)]">
              {SAMPLES.map((row) => (
                <tr key={row.variable}>
                  <td className="py-2 pr-3 text-ink">{row.sample}</td>
                  <td className="py-2 pr-3 text-ink-2">{row.aggregate}</td>
                  <td className="py-2 pr-3 text-ink-2">{row.period}</td>
                  <td className="py-2">
                    <CopyChip text={row.variable} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Phase 3 — build the payload"
          subtitle="One Text action containing this"
        />
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          First add <Strong>Format Date</Strong>, set its input to{" "}
          <Strong>Current Date</Strong> and its format to{" "}
          <Strong>ISO 8601</Strong>. Save that as a variable named{" "}
          <Strong>timestamp</Strong>. Then add a <Strong>Text</Strong> action
          and paste this in. Replace
          each <code>⟨name⟩</code> with the matching magic variable — tap where
          it sits, then pick the variable from the bar above the keyboard.
          <Strong> Delete the angle brackets</Strong>; only the variable chip
          should remain.
        </p>
        <pre className="mt-4 -mx-4 overflow-x-auto px-4 text-2xs leading-relaxed text-ink-2">
          <code>{PAYLOAD_TEMPLATE}</code>
        </pre>
        <div className="mt-4">
          <CopyButton text={PAYLOAD_TEMPLATE} label="Copy the template" />
        </div>
        <p className="mt-3 text-xs text-ink-3 leading-relaxed">
          Leave out any row whose sample you skipped — a missing metric is fine,
          a metric with an empty value is not.
        </p>
      </Card>

      <Phase
        number={4}
        title="Deliver it to the clipboard"
        steps={[
          <>
            Add <Strong>Copy to Clipboard</Strong> and set its input to the{" "}
            <Strong>Text</Strong> action above.
          </>,
          <>
            Add <Strong>Show Notification</Strong> — title{" "}
            <Strong>Health synced</Strong>, body{" "}
            <Strong>Open Keel and tap Import</Strong>. This is what reminds you
            the one tap is waiting.
          </>,
          <>
            Do <strong className="text-ink">not</strong> add an{" "}
            <Strong>Open URLs</Strong> action. It opens Safari, which has
            separate storage from the app on your Home Screen, and the data
            would land in an empty vault.
          </>,
        ]}
      />

      <Phase
        number={5}
        title="Run it on a schedule"
        steps={[
          <>
            Go to the <Strong>Automation</Strong> tab, tap <Strong>+</Strong>,
            then <Strong>Time of Day</Strong>.
          </>,
          <>
            Pick a time, set it to <Strong>Daily</Strong>, and choose{" "}
            <Strong>Run Shortcut</Strong> → <Strong>Sync Health</Strong>.
          </>,
          <>
            Turn <Strong>Run Immediately</Strong> on. On older iOS the toggle is
            called <Strong>Ask Before Running</Strong> — turn that off.
          </>,
          <>
            Optional: repeat the automation at a few times of day. A single
            firing can be missed if the phone is locked, and running four times
            costs nothing.
          </>,
        ]}
      />

      <Card>
        <CardHeader title="Then, each day" />
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          Open Keel and tap Import when it offers. iOS requires a deliberate tap
          before any page may read the clipboard, and shows its own paste
          confirmation. That is one tap per day, and it is a restriction worth
          having — a page that could read your clipboard silently would be a
          much worse thing to install.
        </p>
      </Card>
    </div>
  );
}

function Strong({ children }: { children: React.ReactNode }) {
  return <strong className="font-medium text-ink">{children}</strong>;
}

function Phase({
  number,
  title,
  steps,
}: {
  number: number;
  title: string;
  steps: React.ReactNode[];
}) {
  return (
    <Card>
      <CardHeader title={`Phase ${number} — ${title}`} />
      <ol className="mt-3 flex flex-col gap-2 text-sm text-ink-2">
        {steps.map((step, index) => (
          <li key={index} className="flex gap-2.5 leading-relaxed">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-2xs font-medium text-ink-2">
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Copy helper shared by the chip and the button. */
function useCopy(text: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      } catch {
        // Clipboard write can be refused without a user gesture, or in an
        // insecure context. Selecting the text by hand still works, so this is
        // not worth an error state.
      }
    })();
  }, [text]);
  return { copied, copy };
}

function CopyChip({ text }: { text: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${text}`}
      className={cn(
        "rounded-[var(--radius-sm)] px-2 py-1 text-xs tnum tap",
        copied ? "bg-accent-quiet text-accent" : "bg-surface-2 text-ink-2"
      )}
    >
      {copied ? "Copied" : text}
      {/* The label swap is silent to a screen reader — the button's own name
          is pinned by aria-label, so the change never gets announced. */}
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <Button size="sm" variant="secondary" onClick={copy}>
      {copied ? "Copied" : label}
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </Button>
  );
}
