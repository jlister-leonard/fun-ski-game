'use client';

import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ListGroup, ListRow } from '@/components/ui/ListRow';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { addDays, toDateKey } from '@/lib/db/repos';
import { useUnits } from '@/lib/hooks/useUnits';
import {
  detectSustainedUnderEating,
  type DayIntake,
  type PersonContext,
} from '@/lib/algorithms';
import { getSeedFood, type FoodItem } from '@/data/foods';
import type { FoodLog, MealSlot } from '@/lib/db/types';

import { DIARY_COPY, SLOT_ORDER } from './copy';
import { Note } from './atoms';
import { AdequacyCard } from './AdequacyCard';
import { EatenCard } from './EatenCard';
import { MealSection } from './MealSection';
import { QuickActions } from './QuickActions';
import { FoodSearchSheet } from './FoodSearchSheet';
import { PortionSheet } from './PortionSheet';
import { CustomFoodSheet } from './CustomFoodSheet';
import { SafetySettingsSheet } from './SafetySettingsSheet';
import { UnderEatingNotice } from './UnderEatingNotice';
import { BarcodeScannerSheet } from './BarcodeScannerSheet';
import { WeekView } from './WeekView';
import { useNutritionPrefs } from './prefs';
import {
  assessMicronutrients,
  defaultSlotForHour,
  diaryPeriodStatus,
  frequencyFromLogs,
  groupBySlot,
  recentIdsFromLogs,
  resolveLogs,
  totalEaten,
} from './model';
import {
  createCustomFood,
  logFoodItem,
  removeLog,
  repeatDay,
  todayKey,
  updateLogQuantity,
  useDayLogs,
  useRecentLogs,
  useUserFoods,
  useWeekLogs,
} from './useDiary';
import { useTargets, useTargetInputs } from './useTargets';

/**
 * @file The Food screen.
 *
 * ## Reading order is the design
 *
 * The screen is ordered adequacy → energy → what you ate → quick add. That is
 * not aesthetics: `validateTrackingSafety()` requires
 * `adequacyProminence: 'equal-or-greater'`, and the cheapest way to satisfy it
 * honestly is to put adequacy first, at the same type scale, with nothing
 * about it conditional on energy numbers being visible.
 *
 * ## What the screen never renders
 *
 * A remainder. A streak. A badge. A celebration. A five-week weight
 * projection. A red number for going over. Each of those is either a
 * `block`-level finding in `validateTrackingSafety()` or a documented review
 * item, and the test suite in `__tests__/` asserts the ones a machine can see.
 */

/** Days of history the search ranking and under-eating detector look at. */
const HISTORY_DAYS = 60;

export function DiaryScreen() {
  const [dateKey, setDateKey] = useState<string>(() => todayKey());
  const [view, setView] = useState<'day' | 'week'>('day');
  const { system } = useUnits();
  const prefs = useNutritionPrefs();

  const dayLogs = useDayLogs(dateKey);
  const weekLogs = useWeekLogs(dateKey);
  const history = useRecentLogs(HISTORY_DAYS);
  const userFoods = useUserFoods();

  const logs = dayLogs.data;
  const eaten = useMemo(() => totalEaten(logs), [logs]);

  // Daily intake totals feed the expenditure estimator. A day with no entries
  // is simply absent from this map, and `useTargets` turns that into `null`
  // rather than 0 — "did not log" and "ate nothing" are different facts.
  const intakeByDate = useMemo(() => {
    const out = new Map<string, number>();
    for (const log of history.data) {
      out.set(log.dateKey, (out.get(log.dateKey) ?? 0) + log.nutrients.kcal);
    }
    return out;
  }, [history.data]);

  const targets = useTargets(intakeByDate);
  const inputs = useTargetInputs(intakeByDate);

  // Age is resolved inside the vault query rather than here: the current date
  // is not a pure input, and deriving it during render is both a purity
  // violation and a value that silently goes stale.
  const person: PersonContext | null = useMemo(() => {
    const profile = inputs.data.profile;
    const ageYears = inputs.data.ageYears;
    if (!profile?.sex || ageYears === null) return null;
    return { sex: profile.sex, ageYears, energyKcal: targets.targets?.kcal };
  }, [inputs.data.profile, inputs.data.ageYears, targets.targets?.kcal]);

  const resolved = useMemo(
    () => resolveLogs(logs, userFoods.data),
    [logs, userFoods.data],
  );

  const micronutrients = useMemo(
    () => assessMicronutrients(resolved, person),
    [resolved, person],
  );

  const frequency = useMemo(() => frequencyFromLogs(history.data), [history.data]);
  const recentIds = useMemo(() => recentIdsFromLogs(history.data), [history.data]);

  const recentItems = useMemo(() => {
    const byId = new Map(userFoods.data.map((f) => [f.id, f]));
    const out: FoodItem[] = [];
    for (const id of recentIds) {
      const item = getSeedFood(id) ?? byId.get(id);
      if (item) out.push(item);
      if (out.length >= 8) break;
    }
    return out;
  }, [recentIds, userFoods.data]);

  const yesterday = useMemo(() => {
    const key = addDays(dateKey, -1);
    return history.data.filter((l) => l.dateKey === key);
  }, [history.data, dateKey]);

  // --- under-eating -------------------------------------------------------
  const underEating = useMemo(() => {
    const targetKcal = targets.targets?.kcal;
    if (!targetKcal) return null;
    const today = toDateKey(new Date());
    const days: DayIntake[] = [];
    for (let i = 13; i >= 0; i -= 1) {
      const key = addDays(today, -i);
      days.push({
        date: key,
        kcal: intakeByDate.get(key) ?? null,
        targetKcal,
      });
    }
    return detectSustainedUnderEating(days);
  }, [intakeByDate, targets.targets?.kcal]);

  const underEatingFiring =
    underEating !== null && underEating.findings.some((f) => !f.ok);

  // --- sheets -------------------------------------------------------------
  const [searchOpen, setSearchOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customName, setCustomName] = useState<string | null>(null);
  const [portion, setPortion] = useState<
    { item: FoodItem; slot: MealSlot; log?: FoodLog } | null
  >(null);

  const openPortionFor = useCallback(
    (item: FoodItem) => {
      setSearchOpen(false);
      setPortion({ item, slot: defaultSlotForHour(new Date().getHours()) });
    },
    [],
  );

  const openEntry = useCallback(
    (log: FoodLog) => {
      const byId = new Map(userFoods.data.map((f) => [f.id, f]));
      const item = log.foodId ? (getSeedFood(log.foodId) ?? byId.get(log.foodId)) : undefined;
      if (!item) return;
      setPortion({ item, slot: log.slot, log });
    },
    [userFoods.data],
  );

  const submitPortion = useCallback(
    async ({ grams, slot }: { grams: number; slot: MealSlot }) => {
      if (!portion) return;
      if (portion.log) {
        await updateLogQuantity(portion.log, portion.item, grams);
      } else {
        await logFoodItem({ dateKey, slot, item: portion.item, grams });
      }
      setPortion(null);
    },
    [portion, dateKey],
  );

  const grouped = useMemo(() => groupBySlot(logs), [logs]);
  const isToday = dateKey === todayKey();
  const visibleDiaryStatus = diaryPeriodStatus(view, dayLogs.status, weekLogs.status);
  const movePeriod = (direction: -1 | 1) => {
    const step = view === 'week' ? 7 : 1;
    setDateKey((current) => {
      const candidate = addDays(current, direction * step);
      const today = todayKey();
      return candidate > today ? today : candidate;
    });
  };

  return (
    <main className="px-4 pt-3 pb-8 safe-t">
      <header className="pt-2 pb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold text-ink tracking-[-0.02em]">
            {DIARY_COPY.title}
          </h1>
          <p className="text-sm text-ink-2 mt-1">
            {view === 'week'
              ? `Seven days ending ${isToday ? 'today' : dateKey}`
              : isToday
                ? DIARY_COPY.subtitle
                : dateKey}
          </p>
        </div>
        <div className="flex gap-1 pt-1">
          <Button
            variant="ghost"
            size="sm"
            // 29px wide as measured. `size="sm"` carries a 44pt hit region,
            // but these two sit 4px apart, so the expansions would overlap and
            // the later one would swallow taps meant for the earlier. A real
            // 44px width is the fix that survives being next to a neighbour.
            className="w-11 shrink-0"
            aria-label={view === 'week' ? 'Previous week' : 'Previous day'}
            onClick={() => movePeriod(-1)}
          >
            ‹
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-11 shrink-0"
            aria-label={view === 'week' ? 'Next week' : 'Next day'}
            disabled={isToday}
            onClick={() => movePeriod(1)}
          >
            ›
          </Button>
        </div>
      </header>

      <SegmentedControl
        role="tablist"
        label="Diary period"
        value={view}
        onChange={setView}
        options={[
          { value: 'day', label: 'Day' },
          { value: 'week', label: 'Week' },
        ]}
        className="mb-4"
      />

      {visibleDiaryStatus !== 'ready' ? (
        <Card>
          <Note>
            {visibleDiaryStatus === 'locked'
              ? DIARY_COPY.locked
              : visibleDiaryStatus === 'loading'
                ? DIARY_COPY.loading
                : DIARY_COPY.unavailable}
          </Note>
        </Card>
      ) : (
        <div role="tabpanel" className="space-y-4">
          {view === 'week' ? (
            <WeekView
              endingDate={dateKey}
              logs={weekLogs.data}
              hideCalories={prefs.hideCalories}
              onSelectDay={(selected) => {
                setDateKey(selected);
                setView('day');
              }}
            />
          ) : (
          <>
          {/* Adequacy first, at parity with energy. See the file header. */}
          <AdequacyCard
            eaten={eaten}
            proteinFloorG={targets.targets?.proteinG ?? null}
            fiberFloorG={targets.targets?.fiberG ?? null}
            energyTargetKcal={targets.targets?.kcal ?? null}
            micronutrients={micronutrients}
            person={person}
          />

          <EatenCard
            eaten={eaten}
            targets={targets.targets}
            targetStatus={targets.status}
            hideCalories={prefs.hideCalories}
            entryCount={logs.length}
          />

          {targets.status === 'insufficient' && targets.missing.length > 0 && (
            <Card>
              <div className="text-base text-ink">{DIARY_COPY.targetsHeading}</div>
              <Note className="mt-1">{DIARY_COPY.targetsInsufficient}</Note>
              <Note className="mt-2 text-ink-3">
                {DIARY_COPY.targetsInsufficientDetail(targets.missing)}
              </Note>
            </Card>
          )}

          {targets.status === 'blocked' && (
            <Card>
              <div className="text-base text-ink">{DIARY_COPY.targetsHeading}</div>
              <Note className="mt-1">{DIARY_COPY.targetsBlocked}</Note>
              <div className="mt-2 space-y-2">
                {targets.findings.map((f) => (
                  <Note key={f.code} className="text-ink-3">
                    {f.message}
                  </Note>
                ))}
              </div>
            </Card>
          )}

          {targets.status === 'ready' && (
            <Note className="px-1 text-ink-3">
              {targets.basis === 'cold-start'
                ? DIARY_COPY.targetsColdStart
                : DIARY_COPY.targetsSource(targets.confidence ?? 'low')}
            </Note>
          )}

          {underEating && (
            <UnderEatingNotice
              findings={underEating.findings}
              showSafetyReOffer={
                underEatingFiring &&
                !prefs.hideCalories &&
                prefs.safetyReOfferDismissedAt === null
              }
              onOpenSettings={() => setSettingsOpen(true)}
              onDismissReOffer={prefs.dismissSafetyReOffer}
            />
          )}

          <Button variant="primary" size="lg" block onClick={() => setSearchOpen(true)}>
            {DIARY_COPY.addFood}
          </Button>

          {SLOT_ORDER.map((slot) => (
            <MealSection
              key={slot}
              slot={slot}
              logs={grouped.get(slot) ?? []}
              hideCalories={prefs.hideCalories}
              onPressEntry={openEntry}
            />
          ))}

          <QuickActions
            yesterday={yesterday}
            recent={recentItems}
            hideCalories={prefs.hideCalories}
            onRepeatYesterday={async () => {
              await repeatDay(addDays(dateKey, -1), dateKey);
            }}
            onPickRecent={openPortionFor}
            onCreateCustom={() => setCustomName('')}
          />

          <ListGroup>
            <ListRow
              title={DIARY_COPY.settingsRow}
              onPress={() => setSettingsOpen(true)}
            />
          </ListGroup>

          <Note className="px-1 text-ink-3">{DIARY_COPY.notMedicalAdvice}</Note>
          </>
          )}
        </div>
      )}

      <FoodSearchSheet
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        userFoods={userFoods.data}
        recentIds={recentIds}
        frequency={frequency}
        onPick={openPortionFor}
        onCreateCustom={(name) => {
          setSearchOpen(false);
          setCustomName(name);
        }}
        onScanBarcode={() => {
          setSearchOpen(false);
          setScannerOpen(true);
        }}
      />

      <BarcodeScannerSheet
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onPick={(item) => {
          setScannerOpen(false);
          openPortionFor(item);
        }}
        onCreateCustom={() => {
          setScannerOpen(false);
          setCustomName('');
        }}
      />

      <PortionSheet
        open={portion !== null}
        onClose={() => setPortion(null)}
        item={portion?.item ?? null}
        slot={portion?.slot ?? 'snack'}
        initialGrams={portion?.log?.grams}
        editing={portion?.log !== undefined}
        hideCalories={prefs.hideCalories}
        imperial={system === 'imperial'}
        onSubmit={submitPortion}
        onRemove={
          portion?.log
            ? async () => {
                await removeLog(portion.log!.id);
                setPortion(null);
              }
            : undefined
        }
      />

      <CustomFoodSheet
        open={customName !== null}
        onClose={() => setCustomName(null)}
        initialName={customName ?? ''}
        onSave={async (input) => {
          const item = await createCustomFood(input);
          setCustomName(null);
          setPortion({ item, slot: defaultSlotForHour(new Date().getHours()) });
        }}
      />

      <SafetySettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        hideCalories={prefs.hideCalories}
        onChangeHideCalories={prefs.setHideCalories}
      />
    </main>
  );
}
