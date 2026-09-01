/**
 * Measures a ref for a Coachmark target, retrying for a bit instead of
 * giving up after one frame.
 *
 * Two measurement strategies, picked by whether a `containerRef` is passed
 * -- and this MUST be the same view Coachmark itself is mounted inside
 * (a direct ancestor whose bounds Coachmark's StyleSheet.absoluteFill
 * actually fills), not just "the screen root" in the abstract:
 *
 * 1. No containerRef: ref.current.measure() gives window-relative
 *    coordinates (pageX/pageY). What Captain/VC's tip uses -- it lives
 *    inside a plain RN <Modal>, which itself covers the whole window, so
 *    window-relative coordinates are exactly what its Coachmark needs.
 *
 * 2. containerRef passed: ref.current.measureLayout(containerRef.current, ...)
 *    gives the target's position relative to that container -- and that
 *    relative offset is used AS-IS, with nothing added for the
 *    container's own window position. Coachmark, mounted as a child of
 *    that same container, already interprets its coordinates relative to
 *    it (RN's position:absolute is always relative to the immediate
 *    parent, not the window) -- adding the container's own page offset on
 *    top double-counts it. That bug was invisible on a screen whose
 *    container happens to sit at the very top of the screen (offset ~0,
 *    e.g. Home's tab), but very visible on one presented with its own
 *    header above it (e.g. Player Picker inside "Make Transfers"), where
 *    every target rendered low by roughly that header's height.
 */

import { useEffect, useState } from 'react';
import { View, InteractionManager } from 'react-native';

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
        if (!containerRef.current) {
          scheduleRetry({ refNull: false, lastW: undefined, lastH: undefined, lastX: undefined, lastY: undefined, method: 'measureLayout' });
          return;
        }
        // IMPORTANT: use the container-relative offset as-is -- do NOT add
        // the container's own window position on top of it. Coachmark is
        // rendered as a child of this same container (its
        // StyleSheet.absoluteFill is relative to THAT container's bounds,
        // not the true screen), so relX/relY is already exactly the
        // coordinate space Coachmark draws in. Adding the container's own
        // page offset here double-counts it -- invisible on a screen whose
        // container happens to sit at the very top (offset ~0, e.g. Home),
        // but very visible on a screen presented with its own header above
        // it (e.g. Player Picker inside "Make Transfers"), where it shows
        // up as the target rendering low by roughly that header's height.
        //
        // Pass the container's REF directly, not findNodeHandle(ref) --
        // on the New Architecture (Fabric, which Expo Go runs by default),
        // measureLayout expects a ref to the other native component; a
        // legacy numeric node handle from findNodeHandle() throws "ref.
        // measureLayout must be called with a ref to a native component."
        // findNodeHandle is deprecated for exactly this reason.
        ref.current.measureLayout(
          containerRef.current,
          (relX: number, relY: number, width: number, height: number) => {
            if (cancelled) return;
            if (!(width > 0 && height > 0)) {
              scheduleRetry({ refNull: false, lastW: width, lastH: height, lastX: relX, lastY: relY, method: 'measureLayout' });
              return;
            }
            onDebug?.({ attempts, refNull: false, lastW: width, lastH: height, lastX: relX, lastY: relY, method: 'measureLayout', gaveUp: false });
            setTarget({ x: relX, y: relY, width, height });
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
