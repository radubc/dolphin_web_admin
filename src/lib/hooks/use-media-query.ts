"use client";

/**
 * A CSS media query as a React value.
 *
 * `useSyncExternalStore` rather than an effect: the repo forbids `setState`
 * inside `useEffect`, and a store subscription is the shape React actually
 * wants for something the browser owns. The query is read straight from
 * `matchMedia` on every snapshot, so there is no state to fall out of date, and
 * the server snapshot is passed in by the caller — a layout has to choose which
 * side of the breakpoint the HTML is rendered for.
 *
 * The first client render still uses the *server* snapshot, so a mismatch
 * resolves on the following paint rather than as a hydration error.
 */

import { useCallback, useSyncExternalStore } from "react";

function supportsMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

export function useMediaQuery(query: string, serverSnapshot: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!supportsMatchMedia()) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    if (!supportsMatchMedia()) return serverSnapshot;
    return window.matchMedia(query).matches;
  }, [query, serverSnapshot]);

  const getServerSnapshot = useCallback(() => serverSnapshot, [serverSnapshot]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
