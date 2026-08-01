"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field } from "@/components/settings/Field";
import { useStack } from "@/components/settings/stack";
import {
  AGENTS,
  checkStack,
  resolveAgentId,
  resolveSupplementId,
  resolveStack,
  PRESCRIPTION_BOUNDARY_SHORT,
  type MedicationEntry,
  type SupplementEntry,
} from "@/lib/algorithms/medication-interactions";
import type { Finding } from "@/lib/algorithms/guardrails";
import { cn } from "@/lib/cn";

/**
 * Medications and supplements.
 *
 * ## Why these two lists are one screen
 *
 * Because the reason to collect either of them is the interaction between
 * them. `medication-interactions.ts` exists to answer "is anything in this
 * stack a problem given what you are prescribed", and it cannot answer that
 * from half the data. Splitting them into two screens would make the empty
 * medication list — the state in which every check silently passes — the
 * normal one.
 *
 * ## What this screen will not do
 *
 * Tier 3 rule 1, from `medication-effects.json`: nothing here may read as a
 * suggestion to start, stop, re-dose or re-time a **prescribed** medication.
 * Supplement timing is fair game and the engine produces it; medication timing
 * is not, and the engine does not. This screen only renders what
 * `checkStack()` returns, so that boundary is enforced in the data rather than
 * re-litigated in copy.
 */
export function StackSection() {
  const { stack, ready, setMedications, setSupplements } = useStack();

  const findings = useMemo(() => {
    if (!ready) return [];
    const { resolved } = resolveStack(stack.supplements);
    return checkStack(stack.medications, resolved).filter((f) => !f.ok);
  }, [ready, stack]);

  return (
    <div className="flex flex-col gap-4">
      <MedicationList
        entries={stack.medications}
        onChange={setMedications}
        disabled={!ready}
      />
      <SupplementList
        entries={stack.supplements}
        onChange={setSupplements}
        disabled={!ready}
      />

      {findings.length > 0 && (
        <Card>
          <CardHeader
            title="What this combination means"
            subtitle="From the interaction tables, not from your data"
          />
          <div className="mt-3 flex flex-col gap-2">
            {findings.map((finding) => (
              <FindingNotice key={finding.code} finding={finding} />
            ))}
          </div>
          <p className="mt-4 text-xs text-ink-3 leading-relaxed">
            {PRESCRIPTION_BOUNDARY_SHORT}
          </p>
        </Card>
      )}
    </div>
  );
}

function MedicationList({
  entries,
  onChange,
  disabled,
}: {
  entries: MedicationEntry[];
  onChange: (next: MedicationEntry[]) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const [startedOn, setStartedOn] = useState("");
  const [adding, setAdding] = useState(false);

  const add = useCallback(() => {
    const label = text.trim();
    if (!label) return;
    const id = resolveAgentId(label) ?? label.toLowerCase().replace(/\s+/g, "-");
    onChange([
      ...entries,
      { id, label, ...(startedOn ? { startedOn } : {}) },
    ]);
    setText("");
    setStartedOn("");
    setAdding(false);
  }, [text, startedOn, entries, onChange]);

  const remove = useCallback(
    (index: number) => onChange(entries.filter((_, i) => i !== index)),
    [entries, onChange]
  );

  const stop = useCallback(
    (index: number) =>
      onChange(
        entries.map((entry, i) =>
          i === index
            ? { ...entry, stoppedOn: new Date().toISOString().slice(0, 10) }
            : entry
        )
      ),
    [entries, onChange]
  );

  return (
    <Card>
      <CardHeader
        title="Medications"
        subtitle="What you are prescribed, and when you started"
      />

      <p className="mt-3 text-sm text-ink-2 leading-relaxed">
        Keel uses this for two things only: flagging supplement interactions, and
        noting where a medication is known to shift a lab value so a result is
        not read as a change in you. It never infers a diagnosis from a drug.
      </p>

      {entries.length > 0 && (
        <ul className="mt-4 flex flex-col divide-y divide-[var(--c-border)]">
          {entries.map((entry, index) => (
            <li key={`${entry.id}-${index}`} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-base text-ink truncate">
                  {entry.label ?? entry.id}
                </div>
                <div className="text-xs text-ink-3">
                  {entry.stoppedOn
                    ? `Stopped ${entry.stoppedOn}`
                    : entry.startedOn
                      ? `Since ${entry.startedOn}`
                      : "Start date not recorded"}
                </div>
              </div>
              {!entry.stoppedOn && (
                <button
                  type="button"
                  className="shrink-0 text-sm text-accent tap"
                  onClick={() => stop(index)}
                >
                  Stopped
                </button>
              )}
              <button
                type="button"
                className="shrink-0 text-sm text-danger tap"
                onClick={() => remove(index)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="mt-4 flex flex-col gap-3">
          <Field
            label="Name"
            value={text}
            onChange={setText}
            placeholder="e.g. Sertraline"
            hint={hintFor(text)}
          />
          <Field
            label="Started on (optional)"
            type="date"
            value={startedOn}
            onChange={setStartedOn}
            hint="Only needed for checks that depend on how long you have been taking it."
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={add} disabled={text.trim() === ""}>
              Add
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => setAdding(true)}
          >
            Add a medication
          </Button>
        </div>
      )}
    </Card>
  );
}

function SupplementList({
  entries,
  onChange,
  disabled,
}: {
  entries: SupplementEntry[];
  onChange: (next: SupplementEntry[]) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState("mg");
  const [adding, setAdding] = useState(false);

  const unrecognised = useMemo(
    () => resolveStack(entries).unrecognised,
    [entries]
  );

  const add = useCallback(() => {
    const label = text.trim();
    if (!label) return;
    const id = resolveSupplementId(label) ?? label.toLowerCase().replace(/\s+/g, "-");
    const amountPerDay = Number.parseFloat(amount);
    onChange([
      ...entries,
      {
        id,
        label,
        ...(Number.isFinite(amountPerDay) && amountPerDay > 0
          ? { amountPerDay, unit }
          : {}),
      },
    ]);
    setText("");
    setAmount("");
    setAdding(false);
  }, [text, amount, unit, entries, onChange]);

  const remove = useCallback(
    (index: number) => onChange(entries.filter((_, i) => i !== index)),
    [entries, onChange]
  );

  return (
    <Card>
      <CardHeader title="Supplement stack" subtitle="Everything you take daily" />

      {entries.length > 0 ? (
        <ul className="mt-4 flex flex-col divide-y divide-[var(--c-border)]">
          {entries.map((entry, index) => (
            <li key={`${entry.id}-${index}`} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-base text-ink truncate">
                  {entry.label ?? entry.id}
                </div>
                {entry.amountPerDay !== undefined && (
                  <div className="text-xs text-ink-3 tnum">
                    {entry.amountPerDay} {entry.unit ?? ""} per day
                  </div>
                )}
              </div>
              <button
                type="button"
                className="shrink-0 text-sm text-danger tap"
                onClick={() => remove(index)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          Nothing listed. Adding what you take lets Keel check it against your
          medications and against the upper limits for the nutrients it covers.
        </p>
      )}

      {unrecognised.length > 0 && (
        <p className="mt-3 text-xs text-ink-3 leading-relaxed">
          Kept but not checked, because they are not in the interaction tables:{" "}
          {unrecognised.join(", ")}. Absence of a warning here is not evidence
          of absence of an interaction.
        </p>
      )}

      {adding ? (
        <div className="mt-4 flex flex-col gap-3">
          <Field
            label="Product"
            value={text}
            onChange={setText}
            placeholder="e.g. Creatine monohydrate"
          />
          <div className="flex gap-3">
            <div className="flex-1">
              <Field
                label="Amount per day (optional)"
                value={amount}
                onChange={setAmount}
                inputMode="decimal"
              />
            </div>
            <div className="w-24">
              <Field label="Unit" value={unit} onChange={setUnit} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={add} disabled={text.trim() === ""}>
              Add
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => setAdding(true)}
          >
            Add a supplement
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Tell the user when free text matched a known agent, and when it did not. */
function hintFor(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 3) return undefined;
  const id = resolveAgentId(trimmed);
  if (!id) {
    return "Not in the interaction tables — it will be saved and shown, but not checked.";
  }
  const agent = AGENTS.find((a) => a.id === id);
  return agent ? `Recognised as ${agent.displayName} (${agent.drugClass}).` : undefined;
}

const TONE: Record<Finding["level"], string> = {
  block: "border-danger/35 bg-danger-quiet",
  warn: "border-warn/35 bg-warn-quiet",
  info: "border-line bg-surface-2",
};

const HEADING: Record<Finding["level"], string> = {
  block: "Stop",
  warn: "Take care",
  info: "Note",
};

function FindingNotice({ finding }: { finding: Finding }) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-md)] border px-3 py-2.5",
        TONE[finding.level]
      )}
      role={finding.level === "block" ? "alert" : undefined}
    >
      <div className="text-2xs uppercase tracking-wide text-ink-3">
        {HEADING[finding.level]}
      </div>
      <p className="mt-1 text-sm text-ink leading-relaxed">{finding.message}</p>
    </div>
  );
}
