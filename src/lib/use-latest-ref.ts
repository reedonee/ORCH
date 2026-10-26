// ── useLatestRef ───────────────────────────────────────────────
// A ref that always holds the most recent render's value.

import { useLayoutEffect, useRef } from 'react';

/**
 * Keep `value` reachable from callbacks without making them depend on it.
 *
 * The canvas layers all need the live pan/zoom and tool style inside
 * window-level mouse handlers. Listing those as dependencies would tear
 * down and re-attach the listeners on every pan frame — and in the
 * drawing layer it would remount the whole gesture mid-stroke.
 *
 * Assigning `ref.current` straight from the render body reads the same
 * but is a render side effect: React may render without committing, and
 * the ref would then describe a screen that never existed. A layout
 * effect with no dependency array runs after every committed render and
 * before the browser paints, so any user event sees a fresh value.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
