/**
 * @file Turning a pile of overlapping Apple sleep segments into nights.
 *
 * ## Why this is not `segments.reduce((a, s) => a + duration(s), 0)`
 *
 * Two independent things overlap in a real export, and summing double-counts
 * both of them:
 *
 * 1. **`InBed` spans the stage segments.** `integration-apple-health.md` §3.6
 *    is explicit: sum stages, never stages *and* `InBed`. A user who wears a
 *    watch and keeps their phone on the nightstand would otherwise report
 *    fifteen hours of sleep on an eight-hour night.
 * 2. **Two sources describe the same minutes.** The iPhone writes `InBed` from
 *    pickup detection while the Watch writes `AsleepCore`; two Watches, or a
 *    third-party tracker, write overlapping *stage* segments. There is no
 *    source field in the canonical model to disambiguate later, so the overlap
 *    has to be resolved here.
 *
 * The resolution is a priority sweep rather than a sum: the timeline is cut at
 * every segment boundary, and each elementary interval is attributed **once**,
 * to the highest-fidelity stage claiming it. Deep beats REM beats light beats
 * awake, because a source that can distinguish deep sleep is a source that
 * knows more than one reporting undifferentiated "asleep".
 */

/** One `HKCategoryTypeIdentifierSleepAnalysis` record, already parsed. */
export interface SleepSegment {
  startMs: number;
  endMs: number;
  /** Bucket from {@link import('./hk-map').sleepStageOf}. */
  stage: 'inBed' | 'deep' | 'rem' | 'light' | 'awake';
  /** Local wall-clock day the segment *ended* on, from the source string. */
  endDateKey: string;
  /** `sourceName` off the record, for attribution. */
  source: string | null;
}

/** A night, resolved. Minutes throughout. */
export interface ResolvedNight {
  /** The **wake** day. */
  dateKey: string;
  bedtimeAt: number;
  wakeAt: number;
  asleepMin: number;
  inBedMin: number;
  efficiency: number | null;
  deepMin: number | null;
  remMin: number | null;
  lightMin: number | null;
  awakeMin: number | null;
  /** Pipe-joined contributing sources, as Health Auto Export spells them. */
  sourceLabel: string | null;
}

/**
 * Stage precedence. Higher wins when two sources claim the same minute.
 *
 * `inBed` is absent deliberately — it is not a stage and never competes.
 */
const PRIORITY: Readonly<Record<string, number>> = {
  deep: 4,
  rem: 3,
  light: 2,
  awake: 1,
};

/** A gap longer than this starts a new sleep session rather than continuing one. */
export const SESSION_GAP_MS = 3 * 60 * 60 * 1000;

/** Below this much resolved sleep a session is a nap, not a night. */
export const MIN_NIGHT_MIN = 45;

/**
 * Split a flat, unsorted segment list into sessions.
 *
 * @param segments every sleep segment in the export
 * @param gapMs how long a break must be to end a session. Default 3 hours.
 * @returns sessions, each ascending by start
 */
export function groupSleepSegments(
  segments: readonly SleepSegment[],
  gapMs: number = SESSION_GAP_MS,
): SleepSegment[][] {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const sessions: SleepSegment[][] = [];
  let current: SleepSegment[] = [sorted[0]];
  let reach = sorted[0].endMs;

  for (let i = 1; i < sorted.length; i++) {
    const seg = sorted[i];
    if (seg.startMs - reach > gapMs) {
      sessions.push(current);
      current = [seg];
      reach = seg.endMs;
      continue;
    }
    current.push(seg);
    if (seg.endMs > reach) reach = seg.endMs;
  }
  sessions.push(current);
  return sessions;
}

/** Total covered milliseconds of a set of possibly-overlapping intervals. */
function unionMs(intervals: readonly { startMs: number; endMs: number }[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let start = sorted[0].startMs;
  let end = sorted[0].endMs;
  for (let i = 1; i < sorted.length; i++) {
    const seg = sorted[i];
    if (seg.startMs > end) {
      total += end - start;
      start = seg.startMs;
      end = seg.endMs;
      continue;
    }
    if (seg.endMs > end) end = seg.endMs;
  }
  return total + (end - start);
}

/**
 * Resolve one session's segments into a single night.
 *
 * Each elementary interval between two consecutive segment boundaries is
 * attributed to exactly one stage — the highest-priority stage covering it —
 * so overlapping sources contribute their best information without inflating
 * the total.
 *
 * @param segments one session's segments, in any order
 * @returns the night, or `null` when nothing resolved as actual sleep
 */
export function resolveSleepSession(segments: readonly SleepSegment[]): ResolvedNight | null {
  if (segments.length === 0) return null;

  const stageSegments = segments.filter((s) => s.stage !== 'inBed' && s.endMs > s.startMs);
  const inBedSegments = segments.filter((s) => s.stage === 'inBed' && s.endMs > s.startMs);

  const minutes: Record<string, number> = { deep: 0, rem: 0, light: 0, awake: 0 };

  if (stageSegments.length > 0) {
    const bounds = new Set<number>();
    for (const seg of stageSegments) {
      bounds.add(seg.startMs);
      bounds.add(seg.endMs);
    }
    const cuts = [...bounds].sort((a, b) => a - b);

    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i];
      const to = cuts[i + 1];
      let best: string | null = null;
      let bestRank = 0;
      for (const seg of stageSegments) {
        if (seg.startMs > from || seg.endMs < to) continue;
        const rank = PRIORITY[seg.stage] ?? 0;
        if (rank > bestRank) {
          bestRank = rank;
          best = seg.stage;
        }
      }
      if (best !== null) minutes[best] += (to - from) / 60_000;
    }
  }

  const asleepMin = minutes.deep + minutes.rem + minutes.light;
  if (asleepMin < MIN_NIGHT_MIN) return null;

  // `InBed` is the union of the in-bed segments, or — when no source reported
  // any — the span of the sleep itself, which is the honest floor rather than
  // a zero that would make efficiency undefined.
  const inBedUnionMin = unionMs(inBedSegments) / 60_000;
  const inBedMin = inBedUnionMin > 0 ? inBedUnionMin : asleepMin + minutes.awake;

  let bedtimeAt = Number.POSITIVE_INFINITY;
  let wakeAt = Number.NEGATIVE_INFINITY;
  let wakeDateKey = segments[0].endDateKey;
  const sources = new Set<string>();
  for (const seg of segments) {
    if (seg.startMs < bedtimeAt) bedtimeAt = seg.startMs;
    if (seg.endMs > wakeAt) {
      wakeAt = seg.endMs;
      wakeDateKey = seg.endDateKey;
    }
    if (seg.source) sources.add(seg.source);
  }

  const efficiency = inBedMin > 0 ? Math.min(1, asleepMin / inBedMin) : null;

  return {
    dateKey: wakeDateKey,
    bedtimeAt,
    wakeAt,
    asleepMin: Math.round(asleepMin),
    inBedMin: Math.round(inBedMin),
    efficiency: efficiency === null ? null : Math.round(efficiency * 1000) / 1000,
    // A source that never reported stages should not be shown zero deep sleep,
    // which reads as "you got none" rather than "we don't know".
    deepMin: minutes.deep > 0 ? Math.round(minutes.deep) : null,
    remMin: minutes.rem > 0 ? Math.round(minutes.rem) : null,
    lightMin: minutes.light > 0 ? Math.round(minutes.light) : null,
    awakeMin: minutes.awake > 0 ? Math.round(minutes.awake) : null,
    sourceLabel: sources.size > 0 ? [...sources].join('|') : null,
  };
}

/**
 * Resolve every session, keeping one night per wake day.
 *
 * When two sessions land on the same day — a nap that cleared the threshold,
 * or a split night — the longer one wins. The vault holds one `sleepRecords`
 * row per day, so this decision has to be made here rather than left to
 * whichever upsert happens to run last.
 *
 * @param segments every sleep segment in the export
 * @returns one night per wake day, ascending
 */
export function resolveNights(segments: readonly SleepSegment[]): ResolvedNight[] {
  const byDay = new Map<string, ResolvedNight>();
  for (const session of groupSleepSegments(segments)) {
    const night = resolveSleepSession(session);
    if (!night) continue;
    const prior = byDay.get(night.dateKey);
    if (!prior || night.asleepMin > prior.asleepMin) byDay.set(night.dateKey, night);
  }
  return [...byDay.values()].sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
}
