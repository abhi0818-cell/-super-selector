/**
 * Measures a ref for a Coachmark target, retrying for a bit instead of
 * giving up after one frame.
 *
 * Two measurement strategies, picked by whether a `containerRef` is passed:
 *
 * 1. No containerRef: ref.current.measure() gives window-relative
 *    coordinates directly (pageX/pageY). Simple, and it's what Captain/VC's
 *    tip (inside a plain RN <Modal>) has always used successfully.
 *
 * 2. containerRef passed: ref.current.measureLayout(containerNode, ...)
 *    gives the target's position RELATIVE TO that container instead --
 *    measured via the JS-side shadow-tree relationship rather than asking
 *    to be resolved against the window -- combined with a separate
 *    measure() of the container itself (window-relative) to get the same
 *    final page coordinates. This exists because, on Android, `measure()`
 *    on some deeply-nested targets (Home's tile, Player Picker's header
 *    row buttons) was observed returning coordinates offset from their
 *    true position by roughly a section's height, while measuring the
 *    screen's own root container the same way was consistently correct.
 *    Routing nested targets through their own screen's root sidesteps
 *    whatever is unreliable about resolving a deep view straight to window
 *    coordinates, since the root -> window resolution (known-good) and the
 *    target -> root resolution (a much shorter, simpler relationship) are
 *    now two separate calls instead of one that has to get everything
 *    right at once.
 */

import { useEffect, useState } from 'react';
import { View, InteractionManager, findNodeHandle } from 'react-native';

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
  method: 'measure' | 'measureLayout';
  gaveUp: boolean;
}

export function useCoachmarkTarget(
  ref: React.RefObject<View | null>,
  active: boolean,
  // Extra dependency (e.g. current step) that should re-trigger measurement.
  resetKey: unknown = null,
  // Optional: fires on every attempt so a caller can surface *why* a target
  // never resolved. Purely diagnostic.
  onDebug?: (info: CoachmarkTargetDebug) => void,
  // Optional: measure relative to this ancestor instead of the window
  // directly -- see file doc comment above. Pass the target's own screen
  // root (e.g. the outer SafeAreaView/View) for anything nested inside a
  // header/row, not the bare window-relative measure().
  containerRef?: React.RefObject<View | null>,
): CoachmarkTarget | null {
  const [target, setTarget] = useState<CoachmarkTarget | null>(null);

  useEffect(() => {
    if (!active) {
      setTarget(null);
      return;
    }
    // Clear any position measured for a PREVIOUS resetKey (e.g. the last
    // tour step) before starting to measure the new one -- otherwise a
    // multi-step tour can briefly (or not-so-briefly) draw the coachmark at
    // the previous step's coordinates while the new one is still resolving.
    setTarget(null);
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRetry = (debug: Omit<CoachmarkTargetDebug, 'attempts' | 'gaveUp'>) => {
      const gaveUp = attempts >= MAX_ATTEMPTS;
      onDebug?.({ ...debug, attempts, gaveUp });
      if (!gaveUp) {
        attempts += 1;
        timer = setTimeout(tryMeasure, RETRY_MS);
      }
    };

    const tryMeasure = () => {
      if (cancelled) return;

      // Previously: `ref.current?.measure(...)` -- if ref.current was
      // still null on ANY attempt (not just the first), this silently
      // no-op'd and nothing ever rescheduled another try, since the retry
      // increment lived inside the measure callback, which never fires
      // without a node. Now null-ref is its own retry branch.
      if (!ref.current) {
        scheduleRetry({ refNull: true, lastW: 0, lastH: 0, lastX: 0, lastY: 0, method: 'measure' });
        return;
      }

      if (containerRef) {
        const containerNode = containerRef.current ? findNodeHandle(containerRef.current) : null;
        if (!containerNode) {
          scheduleRetry({ refNull: false, lastW: undefined, lastH: undefined, lastX: undefined, lastY: undefined, method: 'measureLayout' });
          return;
        }
        ref.current.measureLayout(
          containerNode,
          (relX: number, relY: number, width: number, height: number) => {
            if (cancelled) return;
            if (!(width > 0 && height > 0)) {
              scheduleRetry({ refNull: false, lastW: width, lastH: height, lastX: relX, lastY: relY, method: 'measureLayout' });
              return;
            }
            containerRef.current?.measure((_cx: number, _cy: number, _cw: number, _ch: number, containerPageX: number, containerPageY: number) => {
              if (cancelled) return;
              const ok = typeof containerPageX === 'number' && typeof containerPageY === 'number';
              if (ok) {
                onDebug?.({ attempts, refNull: false, lastW: width, lastH: height, lastX: containerPageX + relX, lastY: containerPageY + relY, method: 'measureLayout', gaveUp: false });
                setTarget({ x: containerPageX + relX, y: containerPageY + relY, width, height });
              } else {
                scheduleRetry({ refNull: false, lastW: width, lastH: height, lastX: relX, lastY: relY, method: 'measureLayout' });
              }
            });
          },
          () => {
            if (cancelled) return;
            scheduleRetry({ refNull: false, lastW: undefined, lastH: undefined, lastX: undefined, lastY: undefined, method: 'measureLayout' });
          },
        );
        return;
      }

      // No containerRef -- plain window-relative measure(), as used by
      // Captain/VC's tip (inside a <Modal>, unaffected by any of this).
      ref.current.measure((x: number, y: number, width: number, height: number, pageX: number, pageY: number) => {
        if (cancelled) return;
        const ok = typeof width === 'number' && typeof height === 'number'
          && typeof pageX === 'number' && typeof pageY === 'number'
          && width > 0 && height > 0;
        if (ok) {
          onDebug?.({ attempts, refNull: false, lastW: width, lastH: height, lastX: pageX, lastY: pageY, method: 'measure', gaveUp: false });
          setTarget({ x: pageX, y: pageY, width, height });
        } else {
          scheduleRetry({ refNull: false, lastW: width, lastH: height, lastX: pageX, lastY: pageY, method: 'measure' });
        }
      });
    };

    // Defer the first attempt until the interaction queue (which includes
    // navigation transitions) has drained -- a screen can be considered
    // "focused" and start painting before its native attachment has fully
    // settled, and a measure call issued into that gap can behave oddly.
    let raf: number | null = null;
    const interactionHandle = InteractionManager.runAfterInteractions(() => {
      if (cancelled) return;
      raf = requestAnimationFrame(tryMeasure);
    });

    return () => {
      cancelled = true;
      interactionHandle.cancel();
      if (raf !== null) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, resetKey]);

  return target;
}
