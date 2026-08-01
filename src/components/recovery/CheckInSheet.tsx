'use client';

/**
 * @file The daily check-in — the only input this screen has that always works.
 *
 * §8.2: *"Subjective inputs are first-class, not fallbacks. The app must work
 * fully with zero wearable data."* This sheet is that promise kept. Soreness
 * and energy are the two fields `assessReadiness` requires, and with nothing
 * else at all they are enough to produce a banded, fully explained assessment.
 *
 * Three of the fields here are not scored at all — the pain flag, the illness
 * flag and the five red-flag questions. They exist because they drive §8.5's
 * hardest branches: rule 4 stops anything going up, rule 5 stops programming
 * entirely, and rule 7 replaces the whole prescription with a clinician
 * referral. An app that scores recovery but has no way to say "my chest hurts"
 * has automated the easy half of the problem.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { RECOVERY_COPY, type SubjectiveScale } from '@/lib/algorithms';
import { CheckField, Eyebrow, Note, ScaleField } from './atoms';
import {
  NO_SYMPTOMS,
  SYMPTOM_LABELS,
  type RecoveryCheckIn,
  type SymptomFlags,
} from './model';

export interface CheckInSheetProps {
  open: boolean;
  onClose: () => void;
  /** The day being answered for, `YYYY-MM-DD`. */
  dateKey: string;
  /** An existing answer to edit, or `null` for a fresh one. */
  initial: RecoveryCheckIn | null;
  onSave: (checkIn: RecoveryCheckIn) => void | Promise<void>;
}

export function CheckInSheet(props: CheckInSheetProps) {
  // Mounting fresh on open is what resets the form — no effect, no stale draft
  // surviving a cancel.
  if (!props.open) return null;
  return <CheckInForm {...props} />;
}

function CheckInForm({ onClose, dateKey, initial, onSave }: CheckInSheetProps) {
  const [soreness, setSoreness] = useState<SubjectiveScale | null>(initial?.soreness ?? null);
  const [energy, setEnergy] = useState<SubjectiveScale | null>(initial?.energy ?? null);
  const [sleepQuality, setSleepQuality] = useState<SubjectiveScale | null>(
    initial?.sleepQuality ?? null,
  );
  const [painFlag, setPainFlag] = useState(initial?.painFlag ?? false);
  const [illnessFlag, setIllnessFlag] = useState(initial?.illnessFlag ?? false);
  const [symptoms, setSymptoms] = useState<SymptomFlags>(initial?.symptoms ?? { ...NO_SYMPTOMS });
  const [saving, setSaving] = useState(false);

  const complete = soreness !== null && energy !== null;

  async function submit() {
    if (soreness === null || energy === null) return;
    setSaving(true);
    try {
      await onSave({
        dateKey,
        soreness,
        energy,
        sleepQuality,
        painFlag,
        illnessFlag,
        symptoms,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      detent="large"
      title="How are you today?"
      footer={
        <Button block size="lg" disabled={!complete} loading={saving} onClick={() => void submit()}>
          {complete ? 'Save check-in' : 'Answer soreness and energy'}
        </Button>
      }
    >
      <div className="flex flex-col gap-7 pb-2">
        <Note>
          Two answers are enough. Everything else is optional, and anything you
          leave blank is left out of the score rather than guessed at.
        </Note>

        <ScaleField
          label="Soreness"
          lowLabel="none"
          highLabel="severe"
          value={soreness}
          onChange={setSoreness}
        />

        <ScaleField
          label="Energy"
          lowLabel="wrecked"
          highLabel="great"
          value={energy}
          onChange={setEnergy}
        />

        <ScaleField
          label="Sleep quality"
          hint="How the night actually felt, whatever the hours say. Skip it if you would rather not guess."
          lowLabel="terrible"
          highLabel="excellent"
          value={sleepQuality}
          onChange={setSleepQuality}
        />

        <div className="flex flex-col gap-3">
          <Eyebrow>Flags</Eyebrow>
          <CheckField
            label="I have joint or muscle pain"
            hint="Pain, not soreness."
            checked={painFlag}
            onChange={setPainFlag}
          />
          {painFlag && <Note>{RECOVERY_COPY.pain}</Note>}

          <CheckField
            label="I am unwell"
            checked={illnessFlag}
            onChange={setIllnessFlag}
          />
          {illnessFlag && <Note>{RECOVERY_COPY.illness}</Note>}
        </div>

        <div className="flex flex-col gap-3">
          <Eyebrow>Anything else</Eyebrow>
          <Note>
            If any of these are true, the app stops suggesting sessions and
            points you at a clinician instead. It does not try to work out what
            they mean, and neither should it.
          </Note>
          {(Object.keys(SYMPTOM_LABELS) as (keyof SymptomFlags)[]).map((key) => (
            <CheckField
              key={key}
              label={SYMPTOM_LABELS[key]}
              checked={symptoms[key]}
              onChange={(next) => setSymptoms((s) => ({ ...s, [key]: next }))}
            />
          ))}
        </div>
      </div>
    </Sheet>
  );
}
