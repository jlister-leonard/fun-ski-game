"use client";

import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import {
  daysBetween,
  perturbationOffsetKg,
  type PerturbationEvent,
  type PerturbationType,
} from "@/lib/algorithms";
import { formatBodyMassDelta, type UnitSystem } from "@/lib/units";
import { LOGGABLE_TYPES, settlingWindowDays } from "./perturbations";

export interface PerturbationCardProps {
  events: readonly PerturbationEvent[];
  /** Today, local calendar day, `YYYY-MM-DD`. */
  todayKey: string;
  system: UnitSystem;
  /**
   * The filter saw a level step in the scale it cannot explain from energy
   * balance. Not proof of anything — a reason to ask.
   */
  stepSuspected: boolean;
  onLogChange: () => void;
  onRemove: (startDate: string, type: PerturbationType) => void;
}

function labelFor(type: PerturbationType): string {
  return LOGGABLE_TYPES.find((t) => t.type === type)?.label ?? "Change";
}

/**
 * Logged non-energetic changes — the creatine defence, made visible.
 *
 * The user takes 5 g of creatine daily. Roughly 1.5 kg of water loads into
 * muscle over about four weeks, and during those weeks the scale can sit
 * completely flat while fat is still coming off. Without something on screen
 * saying so, that reads as a failed diet — which is the moment people eat less
 * than they should.
 *
 * So the card states the modelled offset in the user's own units, as a signed
 * quantity of *water*, next to how far through the settling window they are.
 * The claim is deliberately modest: this is a model of a typical response, not
 * a measurement of their body.
 */
export function PerturbationCard({
  events,
  todayKey,
  system,
  stepSuspected,
  onLogChange,
  onRemove,
}: PerturbationCardProps) {
  const rows = events.map((event) => {
    const age = daysBetween(event.startDate, todayKey);
    const window = settlingWindowDays(event.type);
    return {
      event,
      age,
      settling: age >= 0 && age <= window,
      offsetKg: perturbationOffsetKg(event, todayKey),
    };
  });

  const settling = rows.filter((r) => r.settling);

  return (
    <Card>
      <CardHeader
        title="Water, not fat"
        subtitle={
          settling.length > 0
            ? `${settling.length} change${settling.length === 1 ? "" : "s"} still settling`
            : "Nothing logged"
        }
        accessory={
          <Button size="sm" variant="quiet" onClick={onLogChange}>
            Log a change
          </Button>
        }
      />

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          Creatine, a carb refeed, a salty meal, travel, illness — each moves a
          pound or two of water without moving a gram of fat. Log one and the
          trend filter expects the shift instead of mistaking it for a stalled
          cut.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--c-border)]">
          {rows.map(({ event, age, settling: isSettling, offsetKg }) => {
            const offset = formatBodyMassDelta(offsetKg, system);
            return (
              <li
                key={`${event.type}:${event.startDate}`}
                className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <div className="text-base text-ink">{labelFor(event.type)}</div>
                  <div className="text-sm text-ink-2 mt-0.5 leading-snug">
                    {age === 0
                      ? "Started today"
                      : `Started ${age} day${age === 1 ? "" : "s"} ago`}
                    {isSettling
                      ? ` · about ${offset.text} of water so far`
                      : " · settled, already in the baseline"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(event.startDate, event.type)}
                  className="shrink-0 text-sm text-ink-2 px-2 py-1 tap active:text-ink"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {settling.length > 0 && (
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          While a change is settling, the chart draws a second, dashed line with
          the modelled water removed. That dashed line is the one your energy
          balance actually moved along.
        </p>
      )}

      {stepSuspected && settling.length === 0 && (
        <p className="mt-3 text-sm text-ink leading-relaxed">
          The scale stepped recently in a way food and training don&rsquo;t
          explain. If something changed, logging it keeps the trend and the
          expenditure estimate honest. If nothing did, ignore this — it is a
          guess, and a slow water shift is not reliably detectable from scale
          weight alone.
        </p>
      )}
    </Card>
  );
}
