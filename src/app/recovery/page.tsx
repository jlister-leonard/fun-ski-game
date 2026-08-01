'use client';

/**
 * The Recovery screen.
 *
 * Everything here is one of four things: a reading, a reading compared with the
 * user's own baseline, an explanation of why something is missing, or the
 * readiness assessment with the reasons that produced it. There is no fifth
 * category — no streak, no ring, no number to beat. §8.5 rule 10 exists because
 * an opaque score encourages exactly the single-data-point fixation the whole
 * method is built to avoid, so nothing on this screen is shown without its
 * working.
 *
 * The screen's default state is "not enough to say anything", and that state is
 * rendered honestly rather than filled in. The assessment appears once the user
 * has done a check-in — which needs no wearable, no import and no baseline.
 *
 * All wiring, no logic: the scoring is `@/lib/algorithms/readiness`, the vault
 * reads are `useRecovery`, and the display conversions are `@/lib/units`.
 */

import { useCallback, useState } from 'react';
import { ActivityCard } from '@/components/recovery/ActivityCard';
import { BaselineCard } from '@/components/recovery/BaselineCard';
import { CheckInSheet } from '@/components/recovery/CheckInSheet';
import { EmptyState } from '@/components/recovery/EmptyState';
import { ReadinessCard } from '@/components/recovery/ReadinessCard';
import { SleepCard } from '@/components/recovery/SleepCard';
import { Note } from '@/components/recovery/atoms';
import {
  hrvView,
  rhrView,
  sleepDebt,
  type RecoveryCheckIn,
} from '@/components/recovery/model';
import { useRecovery } from '@/components/recovery/useRecovery';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useUnits } from '@/lib/hooks/useUnits';

export default function RecoveryPage() {
  const { system } = useUnits();
  const { todayKey, status, snapshot, checkIn, build, assessment, save } = useRecovery();
  const [sheetOpen, setSheetOpen] = useState(false);

  const openSheet = useCallback(() => setSheetOpen(true), []);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const onSave = useCallback(
    async (next: RecoveryCheckIn) => {
      await save(next);
    },
    [save],
  );

  const loading = status === 'loading';

  // Baselines are derived here as well as inside `build` so the metric card
  // still renders its readings when there is no check-in — the readings exist
  // whether or not the day has been scored.
  const hrv = hrvView(snapshot?.hrv ?? []);
  const rhr = rhrView(snapshot?.rhr ?? []);
  const nights = snapshot?.nights ?? [];
  const debt = build?.debt ?? sleepDebt(nights, todayKey);
  const lastNight =
    build?.lastNight ?? (nights.length > 0 ? nights[nights.length - 1] : null);

  return (
    <main className="px-4 pt-3 safe-t">
      <header className="pt-2 pb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold text-ink tracking-[-0.02em]">Recovery</h1>
          <p className="text-sm text-ink-2 mt-1">Sleep, baselines and readiness</p>
        </div>
        {!loading && (
          <Button size="sm" variant={checkIn ? 'secondary' : 'primary'} onClick={openSheet}>
            {checkIn ? 'Edit check-in' : 'Check in'}
          </Button>
        )}
      </header>

      <div className="flex flex-col gap-4 pb-6">
        {loading && <Card aria-busy className="h-28" />}

        {status === 'unavailable' && (
          <Card>
            <Note>
              This screen reads from the vault on your device, and the vault is
              not available right now. Nothing has been lost — reopen the app
              from the Home Screen and it will be here.
            </Note>
          </Card>
        )}

        {!loading && snapshot && (
          <>
            {assessment ? (
              <ReadinessCard assessment={assessment} />
            ) : (
              <EmptyState
                onCheckIn={openSheet}
                nights={nights.length}
                hrv={hrv}
                rhr={rhr}
              />
            )}

            <SleepCard
              nights={nights}
              lastNight={lastNight}
              todayKey={todayKey}
              debt={debt}
            />

            <BaselineCard hrv={hrv} rhr={rhr} todayKey={todayKey} />

            <ActivityCard
              activities={snapshot.activities}
              todayKey={todayKey}
              system={system}
            />
          </>
        )}
      </div>

      <CheckInSheet
        open={sheetOpen}
        onClose={closeSheet}
        dateKey={todayKey}
        initial={checkIn}
        onSave={onSave}
      />
    </main>
  );
}
