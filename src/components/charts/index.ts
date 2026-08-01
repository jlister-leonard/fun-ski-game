/**
 * Chart primitives — hand-written SVG, zero dependencies.
 *
 * Every colour is a CSS custom property (`var(--c-…)`), so charts follow the
 * app theme with no JavaScript and no re-render. Every chart ships an
 * accessible table twin, handles its own empty state, and keeps wide content
 * inside its own horizontal scroller so the page body never scrolls sideways.
 */

export { ChartFrame, Legend, EmptyState, SrTable, GridLines, XAxisLabels, YAxisLabels, useElementWidth } from "./ChartFrame";
export type { ChartFrameProps, ChartTable, EmptyStateProps, LegendItem } from "./ChartFrame";

export { LineChart } from "./LineChart";
export type { LineChartProps, LineChartBand, LineSeries, LineSeriesKind, RefLine } from "./LineChart";

export { MacroRing } from "./MacroRing";
export type { MacroRingProps, MacroRingDatum } from "./MacroRing";

export { BarChart } from "./BarChart";
export type { BarChartProps, BarSeries } from "./BarChart";

export { HeatmapCalendar } from "./HeatmapCalendar";
export type { HeatmapCalendarProps, HeatmapValue } from "./HeatmapCalendar";

export { RangeBar } from "./RangeBar";
export type { RangeBarProps, RangeSegment } from "./RangeBar";

export { Sparkline } from "./Sparkline";
export type { SparklineProps } from "./Sparkline";

export { StatTile } from "./StatTile";
export type { StatTileProps, StatTileDelta, DeltaTone } from "./StatTile";

export {
  MARK,
  DAY_MS,
  extent,
  padDomain,
  linearScale,
  niceTicks,
  niceStep,
  labelBudget,
  thin,
  formatCompact,
  formatNumber,
  formatSigned,
  formatDayMonth,
  formatWeekday,
  formatFullDate,
  startOfDay,
} from "./geometry";
export type { Point, BandPoint, Domain, Insets } from "./geometry";
