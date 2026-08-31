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
  lastW: number;
  lastH: number;
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
        onDebug?.({ attempts, refNull: true, lastW: 0, lastH: 0, gaveUp });
        if (!gaveUp) {
          attempts += 1;
          timer = setTimeout(tryMeasure, RETRY_MS);
        }
        return;
      }

      ref.current.measureInWindow((x: number, y: number, width: number, height: number) => {
        if (cancelled) return;
        if (width > 0 && height > 0) {
          onDebug?.({ attempts, refNull: false, lastW: width, lastH: height, gaveUp: false });
          setTarget({ x, y, width, height });
        } else {
          const gaveUp = attempts >= MAX_ATTEMPTS;
          onDebug?.({ attempts, refNull: false, lastW: width, lastH: height, gaveUp });
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
