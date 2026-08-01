"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Segmented, SettingRow } from "@/components/settings/Field";
import { useUnits } from "@/lib/hooks/useUnits";
import { settings } from "@/lib/db/repos";
import { configureAutoLock, DEFAULT_AUTOLOCK } from "@/lib/vault";
import type { UnitSystem } from "@/lib/units";

/** The key `ThemeScript` reads before first paint. Must not drift from it. */
const THEME_KEY = "keel.theme";

type ThemeChoice = "system" | "light" | "dark";

function readTheme(): ThemeChoice {
  if (typeof localStorage === "undefined") return "system";
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** Nothing else writes the theme, so there is nothing to subscribe to. */
const NO_SUBSCRIBE = () => () => {};

/**
 * Display preferences.
 *
 * ## Two of these are stored outside the vault, on purpose
 *
 * The theme lives in `localStorage`, not in the encrypted settings row,
 * because `ThemeScript` has to apply it **synchronously in `<head>` before the
 * first paint** — long before the vault could be unlocked. A theme read after
 * unlock would mean every launch flashes the wrong one. "Which theme" is not
 * health data, so this is a cost worth paying and a line worth not crossing
 * for anything else.
 *
 * Units and auto-lock are ordinary vault-stored preferences.
 */
export function PreferencesSection() {
  const { system, setSystem } = useUnits();
  const theme = useSyncExternalStore(
    NO_SUBSCRIBE,
    readTheme,
    () => "system" as ThemeChoice
  );
  const [themeOverride, setThemeOverride] = useState<ThemeChoice | null>(null);
  const current = themeOverride ?? theme;

  const chooseTheme = useCallback((next: ThemeChoice) => {
    setThemeOverride(next);
    const resolved =
      next === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : next;
    if (next === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, []);

  return (
    <Card flush>
      <div className="px-4 pt-4">
        <CardHeader title="Display" />
      </div>
      <div className="mt-2 divide-y divide-[var(--c-border)]">
        <SettingRow
          title="Units"
          subtitle="Display only — everything is stored in metric either way"
        >
          <Segmented<UnitSystem>
            label="Units"
            value={system}
            onChange={(next) => void setSystem(next)}
            options={[
              { value: "imperial", label: "lb / ft" },
              { value: "metric", label: "kg / cm" },
            ]}
          />
        </SettingRow>
        <SettingRow title="Theme">
          <Segmented<ThemeChoice>
            label="Theme"
            value={current}
            onChange={chooseTheme}
            options={[
              { value: "system", label: "Auto" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </SettingRow>
      </div>
    </Card>
  );
}

/** Idle timeouts offered, in minutes. `0` means "never lock on idle". */
const IDLE_CHOICES = [1, 5, 15, 60] as const;

/**
 * Auto-lock.
 *
 * Locking is not a nuisance setting here: unlocking is the only thing standing
 * between a borrowed phone and every lab result the user has. The controls are
 * therefore explicit about what each timer does rather than offering one
 * opaque "security" toggle.
 */
export function AutoLockSection() {
  const [enabled, setEnabled] = useState(DEFAULT_AUTOLOCK.enabled);
  const [idleMs, setIdleMs] = useState(DEFAULT_AUTOLOCK.idleMs);
  const [hiddenGraceMs, setHiddenGraceMs] = useState(
    DEFAULT_AUTOLOCK.hiddenGraceMs
  );
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    settings
      .load()
      .then((stored) => {
        if (cancelled || !stored) {
          if (!cancelled) setReady(true);
          return;
        }
        setEnabled(stored.autoLockEnabled);
        setIdleMs(stored.autoLockIdleMs);
        setHiddenGraceMs(stored.autoLockHiddenGraceMs);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(
    (patch: {
      autoLockEnabled?: boolean;
      autoLockIdleMs?: number;
      autoLockHiddenGraceMs?: number;
    }) => {
      // The running controller and the stored row are updated together, so a
      // change takes effect on this session rather than at the next launch.
      configureAutoLock({
        ...(patch.autoLockEnabled !== undefined
          ? { enabled: patch.autoLockEnabled }
          : {}),
        ...(patch.autoLockIdleMs !== undefined
          ? { idleMs: patch.autoLockIdleMs }
          : {}),
        ...(patch.autoLockHiddenGraceMs !== undefined
          ? { hiddenGraceMs: patch.autoLockHiddenGraceMs }
          : {}),
      });
      void settings.save(patch);
    },
    []
  );

  return (
    <Card flush>
      <div className="px-4 pt-4">
        <CardHeader
          title="Auto-lock"
          subtitle="Locking clears the key from memory; your data stays encrypted"
        />
      </div>
      <div className="mt-2 divide-y divide-[var(--c-border)]">
        <SettingRow title="Lock automatically">
          <Segmented<"on" | "off">
            label="Auto-lock"
            value={enabled ? "on" : "off"}
            onChange={(next) => {
              const on = next === "on";
              setEnabled(on);
              persist({ autoLockEnabled: on });
            }}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
        </SettingRow>

        {enabled && (
          <>
            <SettingRow
              title="After no activity for"
              subtitle="Counted from the last tap, key press or scroll"
            >
              <select
                aria-label="Idle timeout"
                disabled={!ready}
                value={String(idleMs)}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setIdleMs(next);
                  persist({ autoLockIdleMs: next });
                }}
                // 16px or iOS zooms the viewport on focus and never zooms back.
                style={{ fontSize: 16 }}
                className="tap-target-y rounded-[var(--radius-sm)] border border-[var(--c-control-border)] bg-surface-2 px-2 py-1.5 text-ink"
              >
                {IDLE_CHOICES.map((minutes) => (
                  <option key={minutes} value={minutes * 60_000}>
                    {minutes === 60 ? "1 hour" : `${minutes} min`}
                  </option>
                ))}
              </select>
            </SettingRow>

            <SettingRow
              title="After switching apps for"
              subtitle="A handed-over phone is the case this covers"
            >
              <select
                aria-label="Background grace period"
                disabled={!ready}
                value={String(hiddenGraceMs)}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setHiddenGraceMs(next);
                  persist({ autoLockHiddenGraceMs: next });
                }}
                // 16px or iOS zooms the viewport on focus and never zooms back.
                style={{ fontSize: 16 }}
                className="tap-target-y rounded-[var(--radius-sm)] border border-[var(--c-control-border)] bg-surface-2 px-2 py-1.5 text-ink"
              >
                <option value={10_000}>10 sec</option>
                <option value={30_000}>30 sec</option>
                <option value={120_000}>2 min</option>
                <option value={600_000}>10 min</option>
              </select>
            </SettingRow>
          </>
        )}
      </div>

      {!enabled && (
        <p className="px-4 pb-4 pt-1 text-xs text-ink-3 leading-relaxed">
          With auto-lock off, the vault stays unlocked until you close the app
          or lock it by hand. Anyone who picks up this phone unlocked can read
          everything in it.
        </p>
      )}
    </Card>
  );
}
