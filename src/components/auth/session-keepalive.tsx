"use client";

import { useEffect, useRef } from "react";
import { refreshSessionOnce } from "@/lib/api/client";
import {
  IDLE_SESSION_REDIRECT,
  IDLE_TIMEOUT_SECONDS,
  LOGOUT_PATH,
} from "@/lib/auth/cookies";

/**
 * The browser half of the session policy: **signed out after
 * {@link IDLE_TIMEOUT_SECONDS} without activity, never while working.**
 *
 * The server can only enforce the first half — it sees a request or it does
 * not, and it cannot tell "reading a long page" from "gone for lunch". This
 * component supplies the other half. It watches for real interaction and, while
 * there is any, renews the session a little before the id token runs out. That
 * matters for more than comfort: a Server Action POST cannot be replayed
 * through the proxy's refresh redirect, so without a proactive renewal a form
 * submitted a few minutes after the id token expired would land on `/login`
 * with the typed values lost.
 *
 * Renders nothing. Mounted once in the authenticated layout, never on `/login`
 * or `/forgot-password`.
 */

/** How often the clock is checked. Cheap: no network unless something is due. */
const TICK_MS = 30_000;

/** Activity is written to storage at most this often, not on every event. */
const ACTIVITY_PERSIST_MS = 15_000;

/** How long before the id token expires a renewal is attempted. */
const REFRESH_LEAD_SECONDS = 90;

/**
 * Floor between two renewal attempts. Belt and braces: if a server ever
 * answered with an expiry in the past, this keeps the timer from turning into
 * a request loop.
 */
const MIN_REFRESH_GAP_MS = 60_000;

/**
 * Where the last interaction is recorded so that **every tab of this origin**
 * shares one clock. Without it a tab left open on a dashboard would sign the
 * operator out while they were working in the tab next to it.
 */
const ACTIVITY_STORAGE_KEY = "psa:last-activity";

/**
 * What counts as "someone is there". Pointer, keyboard, wheel, touch and
 * scroll, all passive so none of them can delay the page.
 */
const ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

const LOGIN_PATH = "/login";

/** The stored timestamp in epoch ms, or `null` — storage may be unavailable. */
function readStoredActivity(): number | null {
  try {
    const raw = window.localStorage.getItem(ACTIVITY_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    // Private mode, a blocked origin, a full quota: fall back to this tab's
    // own clock rather than failing.
    return null;
  }
}

function writeStoredActivity(at: number): void {
  try {
    window.localStorage.setItem(ACTIVITY_STORAGE_KEY, String(at));
  } catch {
    // Same as above: the tab-local clock still works.
  }
}

interface SessionKeepaliveProps {
  /**
   * The current id token's `exp`, epoch seconds, from the verified session on
   * the server. Every successful renewal replaces it with the value the
   * refresh endpoint reports, so this prop is only ever the starting point.
   */
  idTokenExpiresAt: number;
}

export default function SessionKeepalive({
  idTokenExpiresAt,
}: SessionKeepaliveProps) {
  const expiresAtRef = useRef(idTokenExpiresAt);
  // Zero until the effect below runs `markActivity()` on mount: `Date.now()`
  // may not be called during render.
  const lastActivityRef = useRef(0);
  const lastPersistRef = useRef(0);
  const lastRefreshRef = useRef(0);
  const endingRef = useRef(false);

  // A navigation re-renders the layout with a fresh session, which may be
  // newer than what this component has been tracking (another tab refreshed,
  // say). Never move the expiry backwards: the tracked value comes from a
  // refresh this tab made and the prop can be a cached render.
  useEffect(() => {
    if (idTokenExpiresAt > expiresAtRef.current) {
      expiresAtRef.current = idTokenExpiresAt;
    }
  }, [idTokenExpiresAt]);

  useEffect(() => {
    const idleWindowMs = IDLE_TIMEOUT_SECONDS * 1000;

    /** Leaves for `path`, once. */
    const leaveTo = (path: string) => {
      if (endingRef.current) {
        return;
      }
      endingRef.current = true;
      // A hard navigation on purpose, not `router.push`: the session is over,
      // so every cached RSC payload and every piece of client state built for
      // that operator has to go with it.
      window.location.assign(path);
    };

    const markActivity = () => {
      const now = Date.now();
      lastActivityRef.current = now;
      if (now - lastPersistRef.current >= ACTIVITY_PERSIST_MS) {
        lastPersistRef.current = now;
        writeStoredActivity(now);
      }
    };

    /**
     * Ends the session the way the sign-out control does — the logout route is
     * the only place the refresh cookie is readable, so it is the only place
     * that can revoke it at Cognito. `keepalive` so the request survives the
     * navigation that follows; its answer is not interesting either way,
     * because the destination is the same whatever Cognito says.
     */
    const signOutIdle = async () => {
      if (endingRef.current) {
        return;
      }
      try {
        await fetch(LOGOUT_PATH, {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          keepalive: true,
        });
      } catch {
        // Offline, or the tab is going away. The cookies may survive, but the
        // server refuses to refresh an idle session anyway.
      }
      leaveTo(IDLE_SESSION_REDIRECT);
    };

    const renew = async () => {
      const result = await refreshSessionOnce();
      if (result.ok) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        expiresAtRef.current =
          result.idTokenExpiresAt ??
          (result.expiresIn === null
            ? nowSeconds + REFRESH_LEAD_SECONDS
            : nowSeconds + result.expiresIn);
        return;
      }
      if (result.status === 401) {
        // `session_idle`: the server's own idle check fired first (this tab's
        // clock can lag, for instance after the machine slept). Anything else
        // means the refresh token itself is gone.
        leaveTo(
          result.code === "session_idle" ? IDLE_SESSION_REDIRECT : LOGIN_PATH,
        );
        return;
      }
      // 503, or no answer at all: Cognito is having a moment and every cookie
      // is still in place. Say nothing and try again on the next tick.
    };

    const tick = () => {
      if (endingRef.current) {
        return;
      }
      const now = Date.now();
      const lastActivity = Math.max(
        lastActivityRef.current,
        readStoredActivity() ?? 0,
      );

      if (now - lastActivity >= idleWindowMs) {
        void signOutIdle();
        return;
      }

      // A hidden tab is not where the work is happening: it still checks for
      // the idle deadline above, but it does not spend a Cognito call. The
      // visible tab is refreshing the same cookie jar for all of them, and a
      // tab brought back to the front renews immediately (below).
      if (document.visibilityState === "hidden") {
        return;
      }

      if (now < (expiresAtRef.current - REFRESH_LEAD_SECONDS) * 1000) {
        return;
      }
      if (now - lastRefreshRef.current < MIN_REFRESH_GAP_MS) {
        return;
      }
      lastRefreshRef.current = now;
      void renew();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      // The idle check runs *before* this return is counted as activity, so
      // coming back to a tab after an hour away still ends the session; the
      // timestamp is then recorded for the window that starts now.
      tick();
      markActivity();
    };

    markActivity();
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, markActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    const timer = window.setInterval(tick, TICK_MS);

    return () => {
      for (const name of ACTIVITY_EVENTS) {
        window.removeEventListener(name, markActivity);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
