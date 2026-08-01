"use client";

import { useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { ListGroup } from "@/components/ui/ListRow";
import { ButtonLink } from "@/components/ui/Button";
import { LinkRow } from "@/components/settings/LinkRow";
import {
  nutritionTiles,
  recoverySummary,
  visibleInsights,
  type MacroTile,
} from "@/components/today/model";
import { useTodayDashboard } from "@/components/today/useTodayDashboard";
import type { Insight } from "@/lib/db/types";

function greeting(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Late one";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const WEEKDAY = new Intl.DateTimeFormat("en", {
  weekday: "long",
  month: "long",
  day: "numeric",
});

export default function TodayPage() {
  const [openedAt] = useState(() => new Date());
  const dashboard = useTodayDashboard();

  return (
    <main className="px-4 pt-3 safe-t">
      <header className="pt-2 pb-5">
        <p className="text-sm text-ink-2">{WEEKDAY.format(openedAt)}</p>
        <h1 className="text-3xl font-semibold text-ink tracking-[-0.02em] mt-0.5">
          {greeting(openedAt)}
        </h1>
      </header>

      <div className="flex flex-col gap-4">
        <NutritionCard nutrition={dashboard.nutrition} />
        <TrainingCard training={dashboard.training} />
        <RecoveryCard recovery={dashboard.recovery} />
        <CoachCard
          coach={dashboard.coach}
          hideCalories={
            dashboard.nutrition.hideCalories || dashboard.nutrition.status !== "ready"
          }
        />

        <ListGroup>
          <LinkRow
            href="/body/"
            title="Log weight"
            subtitle="Daily is best — the trend filter handles the noise"
          />
          <LinkRow
            href="/train/"
            title="Log a workout"
            subtitle="Including sessions with your trainer"
          />
          <LinkRow
            href="/review/"
            title="Weekly review"
            subtitle="What happened, and what I'd change"
          />
          <LinkRow
            href="/settings/"
            title="Settings"
            subtitle="Vault, backup, integrations"
          />
        </ListGroup>

        <p className="px-1 pb-2 text-xs text-ink-3 leading-relaxed">
          Keel is a tracking and planning tool, not medical advice. It
          doesn&rsquo;t diagnose or treat anything.
        </p>
      </div>
    </main>
  );
}

type Dashboard = ReturnType<typeof useTodayDashboard>;

function NutritionCard({ nutrition }: { nutrition: Dashboard["nutrition"] }) {
  if (nutrition.status === "loading") return <LoadingCard label="Loading today’s food" />;
  if (nutrition.status === "unavailable") {
    return (
      <UnavailableCard
        title="Today’s food is unavailable"
        detail="Keel could not read the local vault. Nothing has been replaced with zero."
      />
    );
  }

  const targets = nutrition.targets.targets;
  const tiles = nutritionTiles(nutrition.eaten, targets, nutrition.hideCalories);
  const targetNote =
    nutrition.targets.status === "ready"
      ? nutrition.targets.basis === "cold-start"
        ? "Targets use your profile and current weight until enough history exists to estimate expenditure."
        : `Targets use your ${nutrition.targets.confidence ?? "current"} expenditure estimate.`
      : nutrition.targets.status === "blocked"
        ? "Numeric targets are hidden because the safety checks did not clear them."
        : nutrition.targets.missing.length > 0
          ? `Targets still need ${nutrition.targets.missing.join(", ")}.`
          : "There is not enough data to set targets yet.";

  return (
    <Card>
      <CardHeader
        title="Today’s food"
        subtitle={
          nutrition.logs.length === 0
            ? "Nothing logged yet"
            : `${nutrition.logs.length} ${nutrition.logs.length === 1 ? "entry" : "entries"} logged`
        }
        accessory={
          <ButtonLink href="/nutrition/" size="sm" variant="quiet">
            Log
          </ButtonLink>
        }
      />
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map((tile) => <Macro key={tile.label} tile={tile} />)}
      </div>
      {nutrition.hideCalories && (
        <p className="mt-3 text-xs text-ink-3">Energy numbers are hidden in Food settings.</p>
      )}
      <p className="mt-3 text-sm text-ink-2 leading-relaxed">{targetNote}</p>
    </Card>
  );
}

function TrainingCard({ training }: { training: Dashboard["training"] }) {
  if (training.loading) return <LoadingCard label="Loading training" />;
  if (training.error || !training.summary) {
    return (
      <UnavailableCard
        title="Training is unavailable"
        detail="Keel could not read sessions and programs from the local vault."
      />
    );
  }
  const summary = training.summary;
  const active = summary.kind === "active";
  const empty = summary.kind === "empty";
  return (
    <Card>
      <CardHeader title="Training" subtitle={summary.subtitle} />
      <p className="mt-3 text-lg font-semibold text-ink leading-snug">{summary.title}</p>
      {summary.detail && <p className="mt-1.5 text-sm text-ink-2">{summary.detail}</p>}
      <div className="mt-4">
        <ButtonLink
          href={empty ? "/train/program/" : "/train/"}
          size="sm"
          variant={active ? "primary" : "secondary"}
        >
          {active ? "Resume workout" : empty ? "Build a program" : "Open training"}
        </ButtonLink>
      </div>
    </Card>
  );
}

function RecoveryCard({ recovery }: { recovery: Dashboard["recovery"] }) {
  if (recovery.status === "loading") return <LoadingCard label="Loading recovery" />;
  if (recovery.status === "unavailable" || recovery.status === "locked") {
    return (
      <UnavailableCard
        title="Recovery is unavailable"
        detail="Keel could not read today’s check-in or baseline data from the local vault."
      />
    );
  }
  const summary = recoverySummary(recovery.assessment, recovery.snapshot);
  return (
    <Card>
      <CardHeader title="Recovery" subtitle={summary.title} />
      <p className="mt-3 text-sm text-ink leading-relaxed">{summary.subtitle}</p>
      {summary.detail && <p className="mt-2 text-xs text-ink-3">{summary.detail}</p>}
      <div className="mt-4">
        <ButtonLink href="/recovery/" size="sm" variant="secondary">
          {summary.hasAssessment ? "See why" : "Check in"}
        </ButtonLink>
      </div>
    </Card>
  );
}

function CoachCard({
  coach,
  hideCalories,
}: {
  coach: Dashboard["coach"];
  hideCalories: boolean;
}) {
  if (coach.loading) return <LoadingCard label="Loading coach insights" />;
  if (coach.error || !coach.data) {
    return (
      <UnavailableCard
        title="Coach insights are unavailable"
        detail="Keel could not read today’s ranked insights from the local vault."
      />
    );
  }
  const visible = visibleInsights(coach.data, hideCalories);
  const hiddenByPreference = hideCalories && coach.data.length > visible.length;
  return (
    <Card>
      <CardHeader
        title="Coach"
        subtitle={visible.length > 0 ? "Ranked for today" : "No visible insight today"}
        accessory={
          <ButtonLink href="/review/" size="sm" variant="quiet">
            Review
          </ButtonLink>
        }
      />
      {visible.length > 0 ? (
        <ol className="mt-3 divide-y divide-line">
          {visible.map((insight) => <InsightRow key={insight.id} insight={insight} />)}
        </ol>
      ) : (
        <p className="mt-3 text-sm text-ink-2 leading-relaxed">
          {hiddenByPreference
            ? "Today’s energy-number insight is hidden with your Food preference."
            : "The rules engine has not stored an insight for today. That does not mean everything is perfect; it means there is nothing supported to rank yet."}
        </p>
      )}
    </Card>
  );
}

function InsightRow({ insight }: { insight: Insight }) {
  const labels: Record<Insight["severity"], string> = {
    info: "Information",
    suggestion: "Suggestion",
    warning: "Take care",
    critical: "Needs a person",
  };
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <p className="text-2xs uppercase tracking-[0.08em] text-ink-3">
        {labels[insight.severity]} · {insight.type}
      </p>
      <p className="mt-1 text-sm font-semibold text-ink">{insight.title}</p>
      <p className="mt-1 text-sm text-ink-2 leading-relaxed">{insight.body}</p>
    </li>
  );
}

function LoadingCard({ label }: { label: string }) {
  return <Card aria-busy="true" aria-label={label} className="h-32 animate-pulse" />;
}

function UnavailableCard({ title, detail }: { title: string; detail: string }) {
  return (
    <Card>
      <CardHeader title={title} subtitle="Local data was not replaced" />
      <p role="status" className="mt-3 text-sm text-ink-2 leading-relaxed">{detail}</p>
    </Card>
  );
}

const TONES = {
  calories: "bg-calories",
  protein: "bg-protein",
  carbs: "bg-carbs",
  fat: "bg-fat",
} as const;

function Macro({ tile }: { tile: MacroTile }) {
  return (
    <div className="rounded-[var(--radius-sm)] bg-surface-2 px-2.5 py-3 min-w-0">
      <div className="flex items-center gap-1.5">
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${TONES[tile.tone]}`} />
        <span className="truncate text-xl font-semibold tnum text-ink">{tile.value}</span>
      </div>
      <div className="text-2xs text-ink-3 mt-1">
        {tile.label}{tile.unit ? ` · ${tile.unit}` : ""}
      </div>
      {tile.target && <div className="text-2xs text-ink-3 mt-0.5 tnum">{tile.target}</div>}
    </div>
  );
}
