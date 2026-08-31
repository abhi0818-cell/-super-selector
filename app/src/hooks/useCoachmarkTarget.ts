/**
 * Measures a ref in window coordinates for a Coachmark target, retrying for
 * a bit instead of giving up after one frame.
 *
 * Why this exists: a single requestAnimationFrame + measureInWindow() call
 * works fine when the target is already on screen, but several onboarding
 * moments measure right after a tab switch (e.g. Rules' "Replay
 * Walkthrough" -> Home, or -> MyXI with the picker modal opening). A
 * bottom-tab screen that was just unfocused can be detached by
 * react-native-screens, and reattaching + laying it back out can take more
 * than one frame -- the old one-shot measurement read 0x0 in that window
 * and, since nothing retried, the coachmark just never appeared. This
 * retries every 120ms (up to ~2.4s) until it gets a real (non-zero) rect.
 */

import { useEffect, useState } from 'react';
import { View } from 'react-native';

export type CoachmarkTarget = { x: number; y: number; width: number; height: number };

const RETRY_MS = 120;
const MAX_ATTEMPTS = 40; // ~4.8s of retrying -- generous for slower Android hardware

export interface CoachmarkTargetDebug {
  attempts: number;
  refNull: boolean;
  lastW: number | undefined;
  lastH: number | undefined;
  lastX: number | undefined;
  lastY: number | undefined;
  method: 'measureInWindow' | 'measure';
  gaveUp: boolean;
}

export function useCoachmarkTarget(
  ref: React.RefObject<View | null>,
  active: boolean,
  // Extra dependency (e.g. current step) that should re-trigger measurement.
  resetKey: unknown = null,
  // Optional: fires on every attempt so a caller can surface *why* a target
  // never resolved (ref never attached vs. attached-but-zero-size vs. gave
  // up after MAX_ATTEMPTS) without changing this hook's primary return
  // value/callers. Purely diagnostic.
  onDebug?: (info: CoachmarkTargetDebug) => void,
): CoachmarkTarget | null {
  const [target, setTarget] = useState<CoachmarkTarget | null>(null);

  useEffect(() => {
    if (!active) {
      setTarget(null);
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tryMeasure = () => {
      if (cancelled) return;

      // Previously: `ref.current?.measureInWindow(...)` -- if ref.current
      // was still null on ANY attempt (not just the first), this silently
      // no-op'd and nothing ever rescheduled another try, since the retry
      // increment lived inside the measureInWindow callback, which never
      // fires without a node. That permanently killed the whole retry loop
      // the instant the ref happened to still be unattached on one tick.
      // Now null-ref is its own retry branch, same as a zero-size measure.
      if (!ref.current) {
        const gaveUp = attempts >= MAX_ATTEMPTS;
        onDebug?.({ attempts, refNull: true, lastW: 0, lastH: 0, lastX: 0, lastY: 0, method: 'measure', gaveUp });
        if (!gaveUp) {
          attempts += 1;
          timer = setTimeout(tryMeasure, RETRY_MS);
        }
        return;
      }

      // measureInWindow was observed on-device consistently invoking its
      // callback with width/height (and x/y) as `undefined` -- not 0, not
      // an error, just undefined -- for the full retry window, on a screen
      // that renders and is interactable. That isn't a "not laid out yet"
      // failure (which would read as 0x0 and eventually resolve); it's
      // measureInWindow itself misbehaving for this ref on this device.
      // measure() is RN's other/older measurement API -- a distinct native
      // code path -- returning (x, y, width, height, pageX, pageY), where
      // pageX/pageY are the window-relative coordinates measureInWindow's
      // x/y were meant to give us. Using it as the primary method here;
      // debug output still reports raw values either way so a further
      // failure is visible rather than another silent dead end.
      ref.current.measure((x: number, y: number, width: number, height: number, pageX: number, pageY: number) => {
        if (cancelled) return;
        const ok = typeof width === 'number' && typeof height === 'number'
          && typeof pageX === 'number' && typeof pageY === 'number'
          && width > 0 && height > 0;
        if (ok) {
          onDebug?.({ attempts, refNull: false, lastW: width, lastH: height, lastX: pageX, lastY: pageY, method: 'measure', gaveUp: false });
          setTarget({ x: pageX, y: pageY, width, height });
        } else {
          const gaveUp = attempts >= MAX_ATTEMPTS;
          onDebug?.({ attempts, refNull: false, lastW: width, lastH: height, lastX: pageX, lastY: pageY, method: 'measure', gaveUp });
          if (!gaveUp) {
            attempts += 1;
            timer = setTimeout(tryMeasure, RETRY_MS);
          }
        }
      });
    };

    const raf = requestAnimationFrame(tryMeasure);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, resetKey]);

  return target;
}
