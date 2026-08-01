'use client';

import { Card, CardHeader } from '@/components/ui/Card';
import type { Nutrients } from '@/lib/db/types';
import type { MacroTargets } from '@/lib/algorithms';
import { DIARY_COPY } from './copy';
import { EnergyValue, MacroRow, Note, ProgressTrack } from './atoms';
import type { TargetResult } from './useTargets';

/**
 * @file What has been eaten so far today.
 *
 * ## The one design decision that matters here
 *
 * This card reports **intake**. It does not report a remainder. There is no
 * "1,140 kcal remaining", no countdown, no budget bar draining toward zero.
 *
 * That is not a stylistic preference. Budget framing constructs eating as
 * spending and exceeding the budget as a failure, which is the specific
 * mechanism by which calorie trackers make restrictive eating worse. The
 * target still appears — it is genuinely useful — but as a quiet reference
 * point beside the number, in the same place a chart puts an axis label.
 *
 * Going past the target renders in the ordinary text colour with the ordinary
 * fill. There is no red in this palette for an exceeded nutrition target, on
 * purpose: see the note in `src/app/globals.css`.
 *
 * ## Hiding energy
 *
 * When energy numbers are switched off, this card keeps its carbohydrate and
 * fat rows and drops every kcal figure — including the progress track, whose
 * fill would otherwise communicate the same thing without the digits.
 */

export interface EatenCardProps {
  eaten: Nutrients;
  targets: MacroTargets | null;
  targetStatus: TargetResult['status'];
  hideCalories: boolean;
  /** How many entries the day has, to distinguish "empty" from "loading". */
  entryCount: number;
}

export function EatenCard({
  eaten,
  targets,
  targetStatus,
  hideCalories,
  entryCount,
}: EatenCardProps) {
  const energyTarget = targets?.kcal ?? null;
  const fraction = energyTarget && energyTarget > 0 ? eaten.kcal / energyTarget : null;
  const overBy = energyTarget !== null ? eaten.kcal - energyTarget : 0;

  return (
    <Card>
      <CardHeader
        title={DIARY_COPY.eatenHeading}
        accessory={
          hideCalories ? null : (
            <EnergyValue
              kcal={eaten.kcal}
              hidden={hideCalories}
              className="text-2xl font-semibold text-ink"
            />
          )
        }
      />

      {!hideCalories && (
        <div className="mt-3">
          <ProgressTrack
            fraction={fraction}
            colour="var(--c-calories)"
            label={`Energy eaten: ${Math.round(eaten.kcal)} kcal`}
          />
          <div className="mt-1.5 text-xs text-ink-3">
            {energyTarget !== null
              ? DIARY_COPY.targetReference(energyTarget)
              : targetStatus === 'insufficient'
                ? DIARY_COPY.targetsInsufficient
                : null}
          </div>
          {energyTarget !== null && overBy > 0 && (
            <Note className="mt-2">{DIARY_COPY.overTargetNote(overBy)}</Note>
          )}
        </div>
      )}

      {hideCalories && <Note className="mt-2">{DIARY_COPY.caloriesHiddenNote}</Note>}

      <div className="mt-2 divide-y divide-[var(--c-border)]">
        <MacroRow
          label={DIARY_COPY.carbLabel}
          eaten={eaten.carbG}
          target={targets?.carbG ?? null}
          colour="var(--c-carbs)"
        />
        <MacroRow
          label={DIARY_COPY.fatLabel}
          eaten={eaten.fatG}
          target={targets?.fatG ?? null}
          colour="var(--c-fat)"
        />
      </div>

      {entryCount === 0 && (
        <Note className="mt-3 text-ink-3">{DIARY_COPY.eatenNothingYet}</Note>
      )}
    </Card>
  );
}
