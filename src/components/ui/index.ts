/**
 * The UI primitive set.
 *
 * Everything here is either used by two or more screens today or was
 * hand-rolled in two or more places before it was extracted — nothing is here
 * on spec. The count of pre-existing implementations is recorded in each
 * component's own header so a later reader can tell an extraction from an
 * invention.
 *
 * Not here, deliberately:
 *
 * - **Skeleton** — zero instances in the app. Loading is a beat of nothing or
 *   a line of text, which is the right call on a local-first app where the
 *   slowest read is an IndexedDB round trip. A shimmer would advertise a wait
 *   that is not happening.
 * - **ProgressRing** — zero circular indicators outside `components/charts`,
 *   which already owns `MacroRing`.
 * - **Divider** — sixteen sites, but `divide-line` and
 *   `divide-[var(--c-border)]` resolve to the same value, so the only thing
 *   wrong is the spelling. A component would be ceremony around one class.
 * - **Select** — two uses, both in one file.
 */

export { Button } from "./Button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./Button";

export { Card, CardHeader } from "./Card";
export type { CardProps, CardHeaderProps } from "./Card";

export { ListRow, ListGroup } from "./ListRow";
export type { ListRowProps } from "./ListRow";

export { Sheet } from "./Sheet";
export type { SheetProps } from "./Sheet";

export { NumberPad } from "./NumberPad";
export type { NumberPadProps } from "./NumberPad";

export { TextField } from "./TextField";
export type { TextFieldProps } from "./TextField";

export { SegmentedControl } from "./SegmentedControl";
export type { SegmentedControlProps, SegmentedOption } from "./SegmentedControl";

export { Switch, CheckRow } from "./Switch";
export type { SwitchProps, CheckRowProps } from "./Switch";

export { Chip, ChipRow } from "./Chip";
export type { ChipProps } from "./Chip";

export { Badge, StepBadge, Eyebrow } from "./Badge";
export type { BadgeProps, BadgeTone } from "./Badge";

export { ProgressBar } from "./ProgressBar";
export type { ProgressBarProps } from "./ProgressBar";

export { EmptyState, EmptyNote } from "./EmptyState";
export type { EmptyStateProps, Milestone } from "./EmptyState";

export { Spinner } from "./Spinner";
export type { SpinnerProps } from "./Spinner";

export { toast, primeToasts } from "./Toast";
export type { ToastOptions, ToastTone } from "./Toast";

export { haptic, hapticsSupported, setHapticsEnabled } from "./haptics";
export type { Haptic } from "./haptics";
