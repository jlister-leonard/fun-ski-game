'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ActiveSession, groupSets } from '@/components/training/ActiveSession';
import { ExercisePicker } from '@/components/training/ExercisePicker';
import {
  HistoryList,
  PersonalRecordList,
  TrainerCoverage,
} from '@/components/training/HistoryList';
import { SetEntrySheet } from '@/components/training/SetEntrySheet';
import { TrainerSessionSheet } from '@/components/training/TrainerSessionSheet';
import { loadHealthIntake, loadTrainingIntake } from '@/components/onboarding/store';
import { trainingReadinessState } from '@/components/program/personalize';
import { WeeklyVolume } from '@/components/training/WeeklyVolume';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import {
  addDays,
  exercises as exerciseRepo,
  personalRecords as prRepo,
  workoutSessions,
  workoutSets,
  readiness,
} from '@/lib/db/repos';
import { cn } from '@/lib/cn';
import { exerciseBySlug } from '@/lib/training/library';
import { painFindings, suggestNextSet } from '@/lib/training/guardrails';
import {
  isTrainerDay,
  todayKey,
  useAsyncAction,
  useLibrarySeeded,
  useTrainingWeek,
  useVaultQuery,
} from '@/lib/training/hooks';
import {
  deleteSet,
  detectPersonalRecords,
  discardSession,
  exerciseForSlug,
  finishSession,
  lastPerformance,
  logSet,
  logTrainerSession,
  setsForSession,
  startOrResumeSession,
  type LogSetInput,
  type TrainerSessionInput,
} from '@/lib/training/store';
import { coveredByTrainer } from '@/lib/training/volume';
import { priorFromFocus, regionEffortFromFocus } from '@/lib/training/trainer-estimate';
import type { LibraryExercise } from '@/lib/training/types';

type Tab = 'log' | 'history';

/** The segmented control at the top of the screen. */
function Tabs({ tab, onChange }: { tab: Tab; onChange: (next: Tab) => void }) {
  return (
    <div
      className="mb-4 flex gap-1 rounded-[var(--radius-md)] bg-surface-2 p-1"
      role="tablist"
      aria-label="Training views"
    >
      {(['log', 'history'] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={tab === value}
          onClick={() => onChange(value)}
          className={cn(
            'flex-1 rounded-[var(--radius-sm)] py-2 text-sm capitalize tap',
            'transition-colors duration-[var(--duration-fast)]',
            tab === value ? 'bg-surface text-ink shadow-[var(--shadow-1)]' : 'text-ink-2',
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );
}

/**
 * Train — the workout logger (task graph node **S4**).
 *
 * Two jobs, both first-class:
 *
 * 1. **Log the sessions the app programs.** Thumb-only, no iOS keyboard, last
 *    session's numbers on screen, repeat in one tap.
 * 2. **Observe the sessions it doesn't.** If the athlete trains in person with a
 *    trainer, the app cannot program those
 *    days and must not pretend otherwise — but if it counts them as zero it
 *    can stack more work on top of muscles the trainer already covered. So a
 *    trainer session is captured post-hoc in
 *    about fifteen seconds, and its estimate is what weekly volume budgeting
 *    subtracts.
 */
export default function TrainPage() {
  useLibrarySeeded();

  const [tab, setTab] = useState<Tab>('log');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [trainerOpen, setTrainerOpen] = useState(false);
  const [active, setActive] = useState<{ slug: string; exerciseId: string } | null>(null);

  // ---- data ---------------------------------------------------------------
  const open = useVaultQuery(() => workoutSessions.getOpen(), []);
  const sessionId = open.data?.id ?? null;

  const sets = useVaultQuery(
    () => (sessionId ? setsForSession(sessionId) : Promise.resolve([])),
    [sessionId],
  );

  const library = useVaultQuery(() => exerciseRepo.listAll(), []);
  const week = useTrainingWeek();
  const trainingContext = useVaultQuery(async () => {
    const [health, training, todayReadiness] = await Promise.all([
      loadHealthIntake(),
      loadTrainingIntake(),
      readiness.getToday(),
    ]);
    return { health, training, todayReadiness };
  }, []);

  const recent = useVaultQuery(async () => {
    const sessions = await workoutSessions.recent(12);
    const counts = new Map<string, number>();
    for (const session of sessions) {
      if (session.kind === 'personal_trainer') continue;
      counts.set(session.id, (await workoutSets.getForSession(session.id)).length);
    }
    return { sessions, counts };
  }, [tab]);

  const records = useVaultQuery(
    () => prRepo.getForRange(addDays(todayKey(), -60), todayKey()),
    [tab],
  );

  const activeExerciseSets = active
    ? (sets.data ?? []).filter((s) => s.exerciseId === active.exerciseId)
    : [];

  const last = useVaultQuery(
    () =>
      active
        ? lastPerformance(active.exerciseId, { excludeSessionId: sessionId ?? undefined })
        : Promise.resolve(null),
    [active?.exerciseId, sessionId],
  );

  const rows = library.data ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const nameById = new Map(rows.map((r) => [r.id, r.name]));
  const recentSlugs = [...rows]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8)
    .map((r) => r.slug);

  const groups = groupSets(sets.data ?? [], (id) => {
    const row = byId.get(id);
    return row ? { slug: row.slug, name: row.name } : null;
  });

  const activeLibraryEntry: LibraryExercise | null = active
    ? exerciseBySlug(active.slug)
    : null;
  const painFlag = trainingContext.data?.todayReadiness?.subjective?.painFlag ?? false;
  const readinessState = trainingReadinessState(trainingContext.data?.todayReadiness ?? null);
  const setSuggestion = activeLibraryEntry && !readinessState.programmingSuppressed
    ? suggestNextSet(last.data?.topSet ?? null, {
        repRange: activeLibraryEntry.default_rep_range,
        readiness: readinessState.decision?.adjustment.applied
          ? readinessState.decision.band
          : undefined,
        painFlag,
      })
    : null;
  const loggerGuidance = activeLibraryEntry
    ? readinessState.programmingSuppressed
      ? [{
          ok: false,
          level: 'block' as const,
          code: 'readiness.programming_suppressed',
          message: readinessState.suppressionReason === 'illness'
            ? 'No training suggestion is available because you flagged illness today.'
            : 'Training suggestions are paused because of the symptoms you reported.',
        }]
      : painFlag
        ? painFindings({ hasSubstitutes: activeLibraryEntry.regressions.length > 0 })
        : []
    : [];

  // ---- actions ------------------------------------------------------------
  const pick = useAsyncAction(async (exercise: LibraryExercise) => {
    const row = await exerciseForSlug(exercise.slug);
    if (!row) return;
    await startOrResumeSession();
    setPickerOpen(false);
    setActive({ slug: exercise.slug, exerciseId: row.id });
  });

  const openExisting = useAsyncAction(async (slug: string) => {
    const row = await exerciseForSlug(slug);
    if (row) setActive({ slug, exerciseId: row.id });
  });

  const log = useAsyncAction(
    async (input: Omit<LogSetInput, 'sessionId' | 'exerciseId'>) => {
      if (!active) return;
      const session = await startOrResumeSession();
      const stored = await logSet({
        ...input,
        sessionId: session.id,
        exerciseId: active.exerciseId,
      });
      await detectPersonalRecords(stored);
    },
  );

  const removeSet = useAsyncAction(async (setId: string) => {
    await deleteSet(setId);
  });

  const finish = useAsyncAction(async () => {
    if (sessionId) await finishSession(sessionId);
  });

  const discard = useAsyncAction(async () => {
    if (sessionId) await discardSession(sessionId);
  });

  const saveTrainer = useAsyncAction(async (input: TrainerSessionInput) => {
    await logTrainerSession(input, {
      prior: priorFromFocus(trainingContext.data?.training.trainerFocus ?? ''),
    });
    setTrainerOpen(false);
  });

  const covered = week.data ? coveredByTrainer(week.data.muscles) : [];
  const offerTrainerCapture =
    isTrainerDay(trainingContext.data?.training.trainerDays ?? []) &&
    !(week.data?.sessions ?? []).some(
      (s) => s.kind === 'personal_trainer' && s.dateKey === todayKey(),
    );

  // ---- render -------------------------------------------------------------
  return (
    <main className="px-4 pt-3 safe-t">
      <header className="pb-4 pt-2">
        <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink">Train</h1>
        <p className="mt-1 text-sm text-ink-2">Log a session, or record your trainer&apos;s</p>
      </header>

      <Tabs tab={tab} onChange={setTab} />

      {tab === 'log' ? (
        <div className="space-y-4 pb-8">
          {open.data ? (
            <ActiveSession
              session={open.data}
              groups={groups}
              onAddExercise={() => setPickerOpen(true)}
              onOpenExercise={openExisting.run}
              onFinish={finish.run}
              onDiscard={discard.run}
              pending={finish.pending || discard.pending}
            />
          ) : (
            <Card>
              <CardHeader
                title="Nothing in progress"
                subtitle="Start when you pick up the first weight"
              />
              <Button block className="mt-4" onClick={() => setPickerOpen(true)}>
                Start a session
              </Button>
            </Card>
          )}

          <Card>
            <CardHeader
              title="Trainer session"
              subtitle={
                offerTrainerCapture
                  ? 'Your profile marks today as a trainer day — did you train?'
                  : 'Record a session your trainer ran'
              }
            />
            <p className="mt-2 text-sm text-ink-2">
              I can&apos;t program these days and I wasn&apos;t in the room. Fifteen
              seconds here tells me what to leave alone for the rest of the week.
            </p>
            <Button
              block
              variant={offerTrainerCapture ? 'primary' : 'secondary'}
              className="mt-3"
              onClick={() => setTrainerOpen(true)}
            >
              Log a trainer session
            </Button>
          </Card>

          <Card>
            <CardHeader
              title="Programme"
              subtitle="Build a block around your trainer's days"
            />
            <p className="mt-2 text-sm text-ink-2">
              Generates your available days around what your trainer already
              covers, so the week doesn&apos;t stack more work on the same
              muscles.
            </p>
            <Link
              href="/train/program/"
              className="mt-3 inline-flex h-11 w-full items-center justify-center rounded-[var(--radius-md)] border border-line bg-surface-2 px-4 text-base font-medium text-ink tap active:bg-elevated"
            >
              Open the planner
            </Link>
          </Card>

          <WeeklyVolume week={week.data} loading={week.loading} />
          <TrainerCoverage muscles={covered} />
        </div>
      ) : (
        <div className="space-y-4 pb-8">
          <HistoryList
            sessions={recent.data?.sessions ?? []}
            setCounts={recent.data?.counts ?? new Map()}
          />
          <PersonalRecordList records={records.data ?? []} nameById={nameById} />
          <WeeklyVolume week={week.data} loading={week.loading} limit={22} />
        </div>
      )}

      <ExercisePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={pick.run}
        recentSlugs={recentSlugs}
      />

      {activeLibraryEntry && (
        <SetEntrySheet
          key={activeLibraryEntry.slug}
          open
          onClose={() => setActive(null)}
          exercise={activeLibraryEntry}
          last={last.data}
          current={activeExerciseSets}
          onLog={log.run}
          onDelete={removeSet.run}
          pending={log.pending}
          suggestion={setSuggestion}
          guidance={loggerGuidance}
        />
      )}

      <TrainerSessionSheet
        key={trainingContext.data?.training.trainerFocus ?? 'trainer-session'}
        open={trainerOpen}
        onClose={() => setTrainerOpen(false)}
        onSave={saveTrainer.run}
        pending={saveTrainer.pending}
        initialEffort={regionEffortFromFocus(trainingContext.data?.training.trainerFocus ?? '')}
      />
    </main>
  );
}
