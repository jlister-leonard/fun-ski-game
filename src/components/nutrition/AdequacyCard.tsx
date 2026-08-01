'use client';

import { Card, CardHeader } from '@/components/ui/Card';
import { energyScaledFiberTarget, resolveReference, type PersonContext } from '@/lib/algorithms';
import type { Nutrients } from '@/lib/db/types';
import { DIARY_COPY } from './copy';
import { FIBER } from './micronutrient-db';
import { floorProgress, type MicronutrientDay } from './model';
import { MacroRow, Note, ProgressTrack } from './atoms';

/**
 * @file Adequacy — the floors worth reaching.
 *
 * ## Why this card is first on the screen
 *
 * `docs/kg/specs/nutrition-personalization.md` §3.4 requirement 1, enforced by
 * `validateTrackingSafety()` as `adequacyProminence: 'equal-or-greater'`:
 *
 * > Adequacy floors are surfaced at least as prominently as deficit progress.
 * > Not a tab, not a drawer. If the only number with visual weight on the diary
 * > screen is "calories remaining", the product has taught that less is the
 * > goal.
 *
 * So this card sits **above** the energy card, uses the same type scale, and
 * keeps working in full when energy numbers are switched off. Nothing in it
 * depends on a kcal figure except the fibre floor's energy scaling, which
 * falls back to the tabulated DRI when there is no energy target.
 *
 * ## Why most micronutrients are absent
 *
 * The bundled food database carries a micronutrient panel for 126 of its 1,557
 * foods and explicitly `null` for the rest. `null` means unknown, not zero. So
 * an adequacy check is **switched off** whenever any logged item lacked a
 * value, and the card says how many items that was. The alternative — summing
 * the known part and comparing it to an RDA — would tell almost every user
 * they were deficient in almost everything.
 *
 * Upper-limit checks are *not* switched off, because a partial sum is a strict
 * lower bound and `known > UL` is therefore a true positive regardless. That
 * asymmetry is the whole reason `sumMicronutrients` returns a structure rather
 * than a number.
 */

export interface AdequacyCardProps {
  eaten: Nutrients;
  /** Protein floor in grams, or `null` when there is no target yet. */
  proteinFloorG: number | null;
  /** Fibre floor in grams from the target set, or `null`. */
  fiberFloorG: number | null;
  /** Energy target, used only to energy-scale the fibre DRI. */
  energyTargetKcal: number | null;
  micronutrients: MicronutrientDay;
  /** Sex and age, for the DRI lookup. `null` when the profile is incomplete. */
  person: PersonContext | null;
}

function formatAmount(value: number, unit: string): string {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded.toLocaleString('en-US')} ${unit}`;
}

export function AdequacyCard({
  eaten,
  proteinFloorG,
  fiberFloorG,
  energyTargetKcal,
  micronutrients,
  person,
}: AdequacyCardProps) {
  // Fibre has a floor even with no target set: the DRI is tabulated by sex and
  // age, and energy-scales at 14 g per 1,000 kcal when an energy figure exists.
  const fibreDri = person ? resolveReference(FIBER, person).value : null;
  const resolvedFibreFloor =
    fiberFloorG ??
    (fibreDri !== null
      ? energyScaledFiberTarget(fibreDri, energyTargetKcal ?? undefined)
      : null);

  const protein = floorProgress(DIARY_COPY.proteinLabel, eaten.proteinG, proteinFloorG);
  const fibre = floorProgress(DIARY_COPY.fiberLabel, eaten.fiberG ?? 0, resolvedFibreFloor);

  const assessable = micronutrients.panels.filter((p) => !p.adequacySuppressed);
  const suppressed = micronutrients.panels.filter((p) => p.adequacySuppressed);
  const overLimit = micronutrients.panels.filter(
    (p) => p.assessment.upperLimitStatus === 'exceeded',
  );
  const missingDataItems = suppressed.reduce(
    (most, p) => Math.max(most, p.unknownEntries),
    0,
  );

  return (
    <Card>
      <CardHeader
        title={DIARY_COPY.adequacyHeading}
        subtitle={DIARY_COPY.adequacySubtitle}
      />

      <div className="mt-2 divide-y divide-[var(--c-border)]">
        <MacroRow
          label={DIARY_COPY.proteinLabel}
          eaten={protein.eaten}
          target={protein.floor}
          colour="var(--c-protein)"
          note={
            protein.floor === null
              ? DIARY_COPY.targetsInsufficient
              : protein.met
                ? DIARY_COPY.proteinFloorMet
                : DIARY_COPY.proteinFloorShort(protein.shortBy ?? 0)
          }
        />
        <MacroRow
          label={DIARY_COPY.fiberLabel}
          eaten={fibre.eaten}
          target={fibre.floor}
          colour="var(--c-fiber)"
          note={
            fibre.floor === null
              ? DIARY_COPY.targetsInsufficient
              : fibre.met
                ? DIARY_COPY.fiberFloorMet
                : DIARY_COPY.fiberFloorShort(fibre.shortBy ?? 0)
          }
        />

        {assessable.map((panel) => {
          const a = panel.assessment;
          const fraction =
            a.reference !== null && a.reference > 0 ? a.intake / a.reference : null;
          return (
            <div key={a.nutrientId} className="py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-ink-2">{a.name}</span>
                <span className="text-base text-ink tnum">
                  {formatAmount(a.intake, a.unit)}
                  {a.reference !== null && (
                    <span className="text-ink-3 text-sm font-normal ml-1.5">
                      of {formatAmount(a.reference, a.unit)}
                    </span>
                  )}
                </span>
              </div>
              <ProgressTrack
                className="mt-1.5"
                fraction={fraction}
                colour="var(--c-neutral-data)"
                label={`${a.name}: ${formatAmount(a.intake, a.unit)}`}
              />
            </div>
          );
        })}
      </div>

      {overLimit.length > 0 && (
        <div className="mt-3 space-y-2">
          {overLimit.map((panel) => (
            <Note key={`ul-${panel.assessment.nutrientId}`}>
              {DIARY_COPY.upperLimitExceeded(
                panel.assessment.name,
                formatAmount(panel.assessment.intakeAgainstUpperLimit, panel.assessment.unit),
                formatAmount(panel.assessment.upperLimit ?? 0, panel.assessment.unit),
              )}
            </Note>
          ))}
        </div>
      )}

      <div className="mt-3 space-y-2">
        {micronutrients.noData ? (
          <Note>{DIARY_COPY.micronutrientNoData}</Note>
        ) : (
          // Only when the suppression is *because of missing data*. Adequacy
          // is also switched off when there is no profile to compare against,
          // and "0 items have no nutrient data" would be nonsense there — the
          // targets card explains that case.
          missingDataItems > 0 && (
            <Note>{DIARY_COPY.micronutrientSuppressed(missingDataItems)}</Note>
          )
        )}
        <Note className="text-ink-3">{DIARY_COPY.intakeNotStatus}</Note>
        <Note className="text-ink-3">{DIARY_COPY.supplementsNote}</Note>
      </div>
    </Card>
  );
}
