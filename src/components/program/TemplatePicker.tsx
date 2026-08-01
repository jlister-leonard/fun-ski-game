'use client';

import { Card, CardHeader } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { PROGRAM_TEMPLATES, type DayOfWeek, type ProgramTemplate } from '@/lib/training/program';

export interface TemplatePickerProps {
  selectedId: string;
  onSelect: (template: ProgramTemplate) => void;
  trainerDays: readonly DayOfWeek[];
}

/**
 * Pick a starting point.
 *
 * The personalized block leads, because it is the only one that knows about
 * the locally configured trainer days. The published templates are offered
 * honestly rather than hidden: they are good programs that assume the app owns
 * the whole week, which here it does not — and the card says so instead of
 * letting the user find out in week three.
 */
export function TemplatePicker({ selectedId, onSelect, trainerDays }: TemplatePickerProps) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const trainerSchedule = trainerDays.map((day) => dayNames[day]).join(', ');
  return (
    <Card>
      <CardHeader
        title="Starting point"
        subtitle="One of these is built around your trainer days"
      />

      <ul className="mt-2 divide-y divide-[var(--c-border)]" role="radiogroup" aria-label="Program template">
        {PROGRAM_TEMPLATES.map((template) => {
          const selected = template.id === selectedId;
          return (
            <li key={template.id}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onSelect(template)}
                className={cn(
                  'flex w-full items-start gap-3 py-3 text-left tap',
                  'transition-colors duration-[var(--duration-fast)]',
                )}
              >
                <span
                  className={cn(
                    'mt-1 h-4 w-4 shrink-0 rounded-full border-2',
                    selected ? 'border-accent bg-accent' : 'border-[var(--c-control-border)]',
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm text-ink">{template.name}</span>
                    {template.personalized && (
                      <span className="shrink-0 rounded-[var(--radius-full)] bg-accent-quiet px-2 py-0.5 text-[11px] text-accent">
                        Yours
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-2">{template.who}</span>
                  <span className="mt-1 block tnum text-xs text-ink-3">
                    {template.daysPerWeek} days/wk · {template.accumulationWeeks} +{' '}
                    {template.deloadWeeks} weeks · RIR {template.rirRamp.join(' → ')}
                  </span>
                  {selected && (
                    <span className="mt-1.5 block text-xs leading-relaxed text-ink-3">
                      {template.note}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 border-t border-line pt-3 text-xs text-ink-3">
        Only the first one can actually be generated right now — it is the one that knows
        {trainerSchedule ? ` your trainer days are ${trainerSchedule}` : ' you have not configured trainer days'}.
        {' '}The others are here so you can
        see what you are choosing between, not as a promise that I can run them around
        fixed trainer days.
      </p>
    </Card>
  );
}
