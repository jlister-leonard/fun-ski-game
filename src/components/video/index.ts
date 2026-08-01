/**
 * @file Public surface of the video components.
 *
 * Two entry points matter to other screens:
 *
 * - {@link DemoVideoCard} — drop it under an exercise. It handles resolution,
 *   click-to-load, the YouTube handoff and the user's own recordings.
 * - {@link VideoSettingsSection} — the Video block for the Settings screen.
 *
 * `YouTubeEmbed` is intentionally **not** exported. It is the only component
 * that mounts an iframe, and it must stay reachable through exactly one gate —
 * `DemoVideoCard`, which checks the master switch first. Exporting it would
 * make the "video off" setting a suggestion rather than a guarantee.
 */

export { DemoVideoCard, type DemoVideoCardProps } from "./DemoVideoCard";
export { VideoSettingsSection } from "./VideoSettingsSection";
export { DemoPoster, type DemoPosterProps } from "./DemoPoster";
export { PinVideoField, type PinVideoFieldProps } from "./PinVideoField";
export { UserDemoPlayer, type UserDemoPlayerProps } from "./UserDemoPlayer";
export { UserDemoSheet, formatBytes, type UserDemoSheetProps } from "./UserDemoSheet";
export {
  useUserDemoUrl,
  useUserDemos,
  useVideoPreferences,
  type UserDemoUrlState,
  type UserDemosState,
} from "./hooks";
