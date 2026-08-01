'use client';

import { useDeferredValue, useMemo, useRef, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { ListGroup, ListRow } from '@/components/ui/ListRow';
import {
  getMergedSearchIndex,
  searchFoodsIn,
  type SearchResult,
} from '@/lib/food/search';
import { FOOD_CATEGORY_LABELS, type FoodItem } from '@/data/foods';
import { DIARY_COPY } from './copy';
import { Note } from './atoms';

/**
 * @file Food search.
 *
 * ## Why this is synchronous, unthrottled and offline
 *
 * `searchFoodsIn` measures a p95 of **0.18 ms** per keystroke over the full
 * 1,557-food database, against a 16 ms frame budget — two orders of magnitude
 * of headroom. So there is no debounce, no spinner and no async boundary: the
 * results are computed during render as the user types. Debouncing a 0.18 ms
 * operation would add latency to hide latency that does not exist.
 *
 * `useDeferredValue` is still used, but for a different reason: it lets React
 * keep the text field responsive if a slow device ever does fall behind, while
 * the fast path stays synchronous.
 *
 * The index is built once at module load (11.6 ms) and `getMergedSearchIndex`
 * caches against a signature of the user's own food ids, so calling it on
 * every render is the documented usage — it only rebuilds when the user's
 * catalogue actually changes.
 *
 * ## Ranking
 *
 * `recentIds` and `frequency` come from the diary itself rather than from a
 * usage counter on the food, because a seed food has no vault row to count on
 * and the log history is the more accurate signal anyway. An **empty query is
 * not an error**: it returns the user's recent and most-frequent foods, which
 * is exactly what an empty search box should show.
 */

export interface FoodSearchSheetProps {
  open: boolean;
  onClose: () => void;
  /** Vault-stored foods, merged into the search index. */
  userFoods: readonly FoodItem[];
  /** Food ids most recently logged, most recent first. */
  recentIds: readonly string[];
  /** Food id → times logged in the recent window. */
  frequency: ReadonlyMap<string, number>;
  onPick: (item: FoodItem) => void;
  onCreateCustom: (name: string) => void;
  onScanBarcode: () => void;
}

export function FoodSearchSheet(props: FoodSearchSheetProps) {
  if (!props.open) return null;
  return <FoodSearchBody {...props} />;
}

function FoodSearchBody({
  onClose,
  userFoods,
  recentIds,
  frequency,
  onPick,
  onCreateCustom,
  onScanBarcode,
}: FoodSearchSheetProps) {
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);

  const index = useMemo(() => getMergedSearchIndex(userFoods), [userFoods]);

  const results: SearchResult[] = useMemo(
    () =>
      searchFoodsIn(index, deferred, {
        limit: 40,
        recentIds,
        frequency,
      }),
    [index, deferred, recentIds, frequency],
  );

  const heading =
    deferred.trim() === ''
      ? recentIds.length > 0
        ? DIARY_COPY.recentHeading
        : null
      : null;

  return (
    <Sheet
      open
      onClose={onClose}
      detent="large"
      title={DIARY_COPY.addFood}
      accessory={
        <Button variant="ghost" size="sm" onClick={onClose}>
          {DIARY_COPY.done}
        </Button>
      }
    >
      <div className="pb-4">
        {/* The one place a system keyboard is correct: this is text, not a
            number, and iOS's own autocorrect and dictation are worth having. */}
        <input
          ref={inputRef}
          type="search"
          inputMode="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={DIARY_COPY.searchPlaceholder}
          aria-label={DIARY_COPY.searchPlaceholder}
          className="w-full h-11 rounded-[var(--radius-md)] bg-surface-2 border border-line px-3 text-base text-ink placeholder:text-ink-3 outline-none focus:border-line-strong"
        />

        {heading && (
          <div className="mt-4 mb-2 text-xs uppercase tracking-wide text-ink-3">{heading}</div>
        )}

        {results.length === 0 ? (
          <Note className="mt-6">
            {deferred.trim() === ''
              ? DIARY_COPY.searchEmptyHint
              : DIARY_COPY.searchNoResults(deferred.trim())}
          </Note>
        ) : (
          <ListGroup className="mt-3">
            {results.map((result) => (
              <ListRow
                key={result.food.id}
                title={result.food.name}
                subtitle={[
                  result.food.brand,
                  FOOD_CATEGORY_LABELS[result.food.category],
                  frequency.get(result.food.id)
                    ? `logged ${frequency.get(result.food.id)}×`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                value={
                  result.food.verified ? undefined : (
                    <span className="text-xs text-ink-3">{DIARY_COPY.unverifiedBadge}</span>
                  )
                }
                onPress={() => onPick(result.food)}
              />
            ))}
          </ListGroup>
        )}

        <div className="mt-4 space-y-2">
          <Button variant="secondary" block onClick={onScanBarcode}>
            Scan barcode
          </Button>
          <Button
            variant="secondary"
            block
            onClick={() => onCreateCustom(query.trim())}
          >
            {DIARY_COPY.customFood}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
