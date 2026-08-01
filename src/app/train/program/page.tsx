'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { DayCard } from '@/components/program/DayCard';
import {
  applyReadinessToDay,
  canSaveProgram,
  profileFromOnboarding,
  trainingReadinessState,
} from '@/components/program/personalize';
import {
  endMesocycle,
  gymAvailability,
  observedPace,
  startMesocycle,
} from '@/components/program/persist';
import {
  loadHealthIntake,
  loadSecondaryGoals,
  loadTrainingIntake,
} from '@/components/onboarding/store';
import { TemplatePicker } from '@/components/program/TemplatePicker';
import { FindingList, GoalConflicts } from '@/components/program/TradeoffPanel';
import { VolumeBudget } from '@/components/program/VolumeBudget';
import { StatTile } from '@/components/charts';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { goals, mesocycles, readiness } from '@/lib/db/repos';
import type { Muscle } from '@/lib/db/types';
import { activeProfile, loadGyms } from '@/lib/gyms/store';
import { DEFAULT_MESO, mesoLength } from '@/lib/training/mesocycle';
import {
  DEFAULT_PACE,
  expectedTrainerWeek,
  generateWeek,
  PROGRAM_TEMPLATES,
  prescribedByMuscle,
  SESSION_TIME,
  type PlannedDay,
  type ProgramTemplate,
  type WeekPlan,
} from '@/lib/training/program';
import { useAsyncAction, useTrainingWeek, useVaultQuery } from '@/lib/training/hooks';
import { learnedTrainerWeek } from '@/lib/training/store';
import type { TrainerWeekLoad } from '@/lib/training/volume';

/**
 * Train → Program — the planner (task graph node **S5**).
 *
 * ## What this screen is for
 *
 * The onboarding profile identifies trainer-owned and app-owned days. This
 * screen shows what the app is going to do with its days and — more usefully —
 * **what it is deliberately not going to do**, because the trainer owns it.
 *
 * Four things, in the order the screen presents them:
 *
 * 1. **The honest framing first.** Fat loss and VO2max fit together. Fat loss
 *    and getting bigger do not, at this rate. Saying that before showing a plan
 *    is the whole point of `athlete-profile.md` §3.3.
 * 2. **The week.** Mon, Fri, Sat, Sun from the app; Tue–Thu shown as the
 *    trainer's, blank on purpose.
 * 3. **The volume budget.** Per muscle, against the landmarks, with the
 *    trainer's estimated share drawn apart from the app's prescription so a
 *    guess never masquerades as a measurement.
 * 4. **Edit, then start the block.**
 *
 * ## What it will not do
 *
 * Nothing on this screen rewards volume for its own sake. There is no total to
 * maximise, no streak, and no state in which a fuller bar is a better one — MRV
 * is drawn as a limit and the plan aims below it. And nothing here is medical
 * advice; a pain flag stops progression and routes to a clinician rather than
 * offering a workaround.
 */
export default function ProgramPage() {
  const [templateId, setTemplateId] = useState(PROGRAM_TEMPLATES[0].id);
  const [week, setWeek] = useState(1);
  const [sessionOverride, setSessionOverride] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Readonly<Record<string, number>>>({});
  const [started, setStarted] = useState<string | null>(null);

  // The trainer's estimated week is what the whole budget hangs off. It comes
  // from the logger's live view of confirmed and unconfirmed sessions — never
  // from an assumption that nothing happened.
  const observed = useTrainingWeek();
  const active = useVaultQuery(() => mesocycles.getActive(), [started]);
  const context = useVaultQuery(async () => {
    const training = await loadTrainingIntake();
    const [health, activeGoal, secondaryGoals, gyms, todayReadiness, learnedTrainer] =
      await Promise.all([
        loadHealthIntake(),
        goals.getActive(),
        loadSecondaryGoals(),
        loadGyms(),
        readiness.getToday(),
        learnedTrainerWeek(training.trainerDays.length || 3),
      ]);
    return {
      training,
      health,
      activeGoal,
      secondaryGoals,
      gyms,
      todayReadiness,
      learnedTrainer,
    };
  }, []);
  // The clock the plan is fitted to has to be the athlete's real one, not a
  // theoretical one, so it is learned from sessions they actually finished.
  const pace = useVaultQuery(() => observedPace(), []);

  const profile = useMemo(
    () => profileFromOnboarding({
      training: context.data?.training ?? {
        trainingAge: null, daysPerWeek: null, sessionMinutes: null,
        trainerDays: [], trainerFocus: '', workingWeights: [],
      },
      health: context.data?.health ?? {
        injuries: [], injuryNote: '', dietaryRestrictions: [], dietaryNote: '',
      },
      activeGoal: context.data?.activeGoal ?? null,
      secondaryGoals: context.data?.secondaryGoals ?? [],
    }),
    [context.data],
  );

  const trainer = useMemo<Partial<Record<Muscle, TrainerWeekLoad>>>(() => {
    // Nothing logged is *not* the same as nothing happened. If the athlete has
    // not confirmed this week's sessions, the cautious prior stands at full value —
    // treating missing data as zero volume is the exact failure this whole
    // model exists to prevent (`program-personalized.md` §2.2).
    if ((observed.data?.trainerSessions ?? 0) === 0) {
      const learned = context.data?.learnedTrainer ?? {};
      return Object.keys(learned).length > 0 ? learned : expectedTrainerWeek(profile);
    }
    const out: Partial<Record<Muscle, TrainerWeekLoad>> = {};
    for (const row of observed.data?.muscles ?? []) {
      if (row.trainerUpperBound <= 0) continue;
      out[row.muscle] = {
        stimulusMean: row.trainerMean,
        stimulusUpperBound: row.trainerUpperBound,
        fatigueUpperBound: row.trainerFatigueUpperBound,
      };
    }
    return out;
  }, [observed.data, profile, context.data?.learnedTrainer]);

  const usingPrior = (observed.data?.trainerSessions ?? 0) === 0;
  const usingLearnedTrainer = usingPrior && Object.keys(context.data?.learnedTrainer ?? {}).length > 0;

  const gym = context.data ? activeProfile(context.data.gyms) : null;
  const sessionMinutes = sessionOverride ?? context.data?.training.sessionMinutes ?? SESSION_TIME.targetMinutes;
  const readinessState = useMemo(
    () => trainingReadinessState(context.data?.todayReadiness ?? null),
    [context.data?.todayReadiness],
  );
  const personalizedSourcesReady =
    context.data !== null && context.error === null && !context.loading &&
    observed.data !== null && observed.error === null && !observed.loading &&
    pace.data !== null && pace.error === null && !pace.loading;
  const plannerReady = canSaveProgram({
    contextReady: context.data !== null && context.error === null && !context.loading,
    trainingHistoryReady: observed.data !== null && observed.error === null && !observed.loading,
    paceReady: pace.data !== null && pace.error === null && !pace.loading,
    programmingSuppressed: readinessState.programmingSuppressed,
  });
  const plan = useMemo(() => {
      const generated = generateWeek(profile, {
        week,
        trainer,
        sessionMinutes,
        pace: pace.data ?? DEFAULT_PACE,
        canPerform: gymAvailability(gym),
      });
      return applyReadinessToDay(
        generated,
        new Date().getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6,
        readinessState,
      );
    }, [
      week,
      trainer,
      sessionMinutes,
      pace.data,
      profile,
      gym,
      readinessState,
    ]);
  const edited = useMemo(() => applyEdits(plan, edits), [plan, edits]);

  const template = PROGRAM_TEMPLATES.find((t) => t.id === templateId) ?? PROGRAM_TEMPLATES[0];
  const appDays = edited.days.filter((d) => d.owner === 'app');
  const appSets = appDays.reduce(
    (total, day) => total + day.items.filter((i) => i.role !== 'conditioning' && i.role !== 'mobility')
      .reduce((n, i) => n + i.sets, 0),
    0,
  );
  const trainerSets = edited.budgets.reduce((n, b) => n + b.trainerStimulus, 0);

  const start = useAsyncAction(async () => {
    if (!plannerReady) return;
    const { mesocycle } = await startMesocycle(edited, { name: template.name });
    setStarted(mesocycle.id);
    setEditing(false);
  });

  const stop = useAsyncAction(async (id: string) => {
    await endMesocycle(id, 'abandoned');
    setStarted(null);
  });

  const running = active.data;

  return (
    <main className="px-4 pt-3 safe-t">
      <header className="pb-4 pt-2">
        <Link
          href="/train"
          className="-ml-2 inline-flex h-11 items-center px-2 text-sm text-ink-2 tap"
        >
          ← Train
        </Link>
        <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink">Program</h1>
        <p className="mt-1 text-sm text-ink-2">
          {profile.appDays.length} app day{profile.appDays.length === 1 ? '' : 's'}, built around{' '}
          {profile.trainerDays.length} trainer day{profile.trainerDays.length === 1 ? '' : 's'}
        </p>
      </header>

      <div className="space-y-4 pb-10">
        {!personalizedSourcesReady && (
          <Card>
            <CardHeader
              title={context.error || observed.error || pace.error ? 'Your plan could not be loaded' : 'Loading your plan'}
              subtitle={context.error || observed.error || pace.error
                ? 'Nothing can be saved until your encrypted profile and training history are available.'
                : 'Keel is reading your encrypted profile and training history before it enables saving.'}
            />
          </Card>
        )}
        <GoalConflicts goals={profile.goals.map((goal) => goal.id)} />

        {running && (
          <Card>
            <CardHeader
              title={running.name}
              subtitle={`Started ${running.startDateKey} · ${running.accumulationWeeks} + ${running.deloadWeek ? 1 : 0} weeks`}
              accessory={
                <Button size="sm" variant="ghost" onClick={() => stop.run(running.id)}>
                  End
                </Button>
              }
            />
            <p className="mt-2 text-sm text-ink-2">
              This block is running. Ending it early is a normal thing to do — a premature
              deload costs almost nothing and a late one costs weeks.
            </p>
          </Card>
        )}

        <TemplatePicker
          selectedId={templateId}
          onSelect={(next: ProgramTemplate) => setTemplateId(next.id)}
          trainerDays={profile.trainerDays}
        />

        <WeekSelector week={week} onChange={setWeek} />

        <SessionLength
          minutes={sessionMinutes}
          onChange={setSessionOverride}
          samples={pace.data?.samples ?? 0}
        />

        {gym && (
          <Card>
            <CardHeader title={`Equipment: ${gym.name}`} subtitle="The plan only uses movements this gym supports" />
            <Link href="/settings/gyms/" className="mt-2 inline-block text-sm text-accent tap">
              Change active gym →
            </Link>
          </Card>
        )}

        <div className="grid grid-cols-3 gap-3">
          <StatTile bare label="My sets" value={appSets} />
          <StatTile
            bare
            label="Trainer's (est.)"
            value={Math.round(trainerSets)}
            emptyHint="—"
          >
            {usingPrior && (
              <span className="text-[11px] text-ink-3">
                {usingLearnedTrainer ? 'from recent reports' : 'from my prior'}
              </span>
            )}
          </StatTile>
          <StatTile
            bare
            label="Target RIR"
            value={edited.isDeload ? `${edited.targetRir}` : edited.targetRir}
          />
        </div>

        {usingPrior && !usingLearnedTrainer && (
          <Card>
            <CardHeader
              title="I'm guessing at your trainer's week"
              subtitle="Nothing confirmed yet, so I'm counting my prior at full value"
            />
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              You haven&apos;t confirmed this week&apos;s trainer work yet. I am <em>not</em>{' '}
              treating that as zero — I&apos;d rather over-estimate it and prescribe a little
              less than under-estimate it and stack work on muscles your trainer already hit.
              Confirming sessions replaces this cautious estimate with your reports.
            </p>
            <Link
              href="/train"
              className="mt-3 inline-block text-sm text-accent tap"
            >
              Log a trainer session →
            </Link>
          </Card>
        )}

        <VolumeBudget plan={edited} />

        <div className="flex items-center justify-between gap-3 pt-1">
          <h2 className="text-base font-semibold text-ink">The week</h2>
          <Button size="sm" variant="secondary" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Done' : 'Edit sets'}
          </Button>
        </div>

        {editing && (
          <p className="-mt-2 text-xs leading-relaxed text-ink-3">
            Your call always wins over mine. If you take a slot above what I budgeted, the
            volume bars will show it going past the ceiling — that is information, not a
            telling-off.
          </p>
        )}

        {edited.days.map((day) => (
          <DayCard
            key={day.day}
            day={day}
            editing={editing && day.owner === 'app'}
            onChangeSets={(dayIndex, slug, sets) =>
              setEdits((prev) => ({ ...prev, [`${dayIndex}:${slug}`]: sets }))
            }
          />
        ))}

        <FindingList findings={edited.findings} />

        <Card>
          <CardHeader
            title={running ? 'Replace the running block' : 'Start this block'}
            subtitle={`${DEFAULT_MESO.accumulationWeeks} accumulation weeks, then a deload — ${mesoLength(DEFAULT_MESO)} in total`}
          />
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            The deload week is not a week off. Your trainer cannot deload with you, so it
            keeps trainer-owned days intact and reduces only what the app controls. That
            makes the constraint visible instead of pretending the app can deload someone
            else&apos;s sessions.
          </p>
          <Button
            block
            className="mt-4"
            loading={start.pending}
            disabled={!plannerReady}
            onClick={() => start.run()}
          >
            {running ? 'Start a new block' : 'Start the mesocycle'}
          </Button>
          {started !== null && (
            <p className="mt-2 text-center text-xs text-ink-3">Saved. It starts today.</p>
          )}
        </Card>
      </div>
    </main>
  );
}

/**
 * How long the athlete has today.
 *
 * The plan is fitted to this silently — no "this session wants 62 minutes, you
 * have 45, here is what I would cut" negotiation. It just arrives the right
 * length, with a quiet line on each day showing what came out.
 *
 * The one thing the slider never buys is shorter rest. Trimming rest to fit a
 * clock converts a strength session into a conditioning one, and in a sustained
 * deficit strength retention is the thing most at risk — so exercises give way
 * and rest does not.
 */
function SessionLength({
  minutes,
  onChange,
  samples,
}: {
  minutes: number;
  onChange: (next: number) => void;
  samples: number;
}) {
  return (
    <Card>
      <CardHeader
        title="Session length"
        subtitle={
          samples > 0
            ? `Fitted to your pace over ${samples} session${samples === 1 ? '' : 's'}`
            : 'Fitted to an estimate for now'
        }
        accessory={<span className="tnum text-sm text-ink">{minutes} min</span>}
      />
      <input
        type="range"
        min={30}
        max={90}
        step={5}
        value={minutes}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="mt-3 w-full accent-[var(--c-accent)]"
        aria-label="Session length in minutes"
      />
      <div className="mt-1 flex justify-between text-xs text-ink-3">
        <span>30</span>
        <span>90</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-3">
        I fit the session to this by dropping exercises, never by shortening rest — cutting
        rest would quietly turn a strength day into a conditioning day. Longer sessions buy
        more volume; that is a real trade and it is yours to make.
      </p>
    </Card>
  );
}

/** Week 1 … deload, as a segmented control. */
function WeekSelector({ week, onChange }: { week: number; onChange: (next: number) => void }) {
  const total = mesoLength(DEFAULT_MESO);
  return (
    <div
      className="flex gap-1 rounded-[var(--radius-md)] bg-surface-2 p-1"
      role="tablist"
      aria-label="Week of the block"
    >
      {Array.from({ length: total }, (_, i) => i + 1).map((value) => {
        const deload = value > DEFAULT_MESO.accumulationWeeks;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={week === value}
            onClick={() => onChange(value)}
            className={cn(
              'flex-1 rounded-[var(--radius-sm)] py-2 text-sm tap',
              'transition-colors duration-[var(--duration-fast)]',
              week === value ? 'bg-surface text-ink shadow-[var(--shadow-1)]' : 'text-ink-2',
            )}
          >
            {deload ? 'Deload' : `Wk ${value}`}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Apply the user's set edits on top of a generated plan.
 *
 * Overrides win — §8.5 rule 8, *user override always wins* — including
 * overrides that take a muscle past what the budget allowed. The volume bars
 * then show it going over, which is the honest outcome: the app reports, it
 * does not veto the person doing the training.
 */
function applyEdits(plan: WeekPlan, edits: Readonly<Record<string, number>>): WeekPlan {
  if (Object.keys(edits).length === 0) return plan;

  const days: PlannedDay[] = plan.days.map((day) => ({
    ...day,
    items: day.items
      .map((item) => {
        const override = edits[`${day.day}:${item.slug}`];
        if (override === undefined || override === item.sets) return item;
        const ratio = item.sets > 0 ? override / item.sets : 0;
        return {
          ...item,
          sets: override,
          charges: Object.fromEntries(
            Object.entries(item.charges).map(([muscle, value]) => [muscle, value * ratio]),
          ) as typeof item.charges,
        };
      })
      .filter((item) => item.sets > 0),
  }));

  // The budgets are unchanged — an override does not rewrite what the app
  // thought there was room for, it just does something different with it. Only
  // the *prescription* moves, and the bars read off that.
  return { ...plan, days, prescribed: prescribedByMuscle(days) };
}
