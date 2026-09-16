"use client";

import { useEffect, useRef } from "react";
import { refreshSessionOnce } from "@/lib/api/client";
import {
  EXPIRED_SESSION_REDIRECT,
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
 * Every tab of this origin shares one activity clock, one expiry and one
 * refresh lock through `localStorage`, so tabs neither sign each other out nor
 * all spend a Cognito call at the same instant.
 *
 * Renders nothing. Mounted once in the authenticated layout, never on `/login`
 * or `/forgot-password`.
 */

/** How often the clock is checked. Cheap: no network unless something is due. */
const TICK_MS = 15_000;

/** Activity is written to storage at most this often, not on every event. */
const ACTIVITY_PERSIST_MS = 15_000;

/**
 * How long before the id token expires a renewal is attempted.
 *
 * It has to clear two things at once. The id *cookie* is dropped 60 s before
 * the token's `exp` (`COOKIE_EXPIRY_SKEW` in `session.ts`), and a tick only
 * comes round every {@link TICK_MS}, so the latest a renewal can actually start
 * is `exp - lead + tick`. With 120 s and 15 s that is `exp - 105 s`: 45 s of
 * margin before the cookie goes and the next navigation has to detour through
 * the refresh endpoint. A 90 s lead with a 30 s tick left none at all.
 */
const REFRESH_LEAD_SECONDS = 120;

/**
 * Floor between two renewal attempts *in this tab*. Belt and braces: if a
 * server ever answered with an expiry in the past, this keeps the timer from
 * turning into a request loop.
 */
const MIN_REFRESH_GAP_MS = 60_000;

/**
 * How long one tab's claim on a proactive refresh holds off the others. Best
 * effort only — `localStorage` has no atomic test-and-set — but two tabs would
 * have to come due within the same tick to collide at all, and Cognito's 60 s
 * rotation grace covers that.
 */
const REFRESH_LOCK_MS = 45_000;

/** How long the idle sign-out waits for the logout route before giving up. */
const LOGOUT_TIMEOUT_MS = 5_000;

/**
 * Where the last interaction is recorded so that **every tab of this origin**
 * shares one clock. Without it a tab left open on a dashboard would sign the
 * operator out while they were working in the tab next to it.
 */
const ACTIVITY_STORAGE_KEY = "psa:last-activity";

/**
 * The id token's `exp` (epoch seconds) as last seen by any tab. One tab's
 * refresh rewrites the cookies for all of them, so the others have to learn the
 * new expiry or they would go on refreshing a session that was just renewed.
 */
const ID_EXPIRY_STORAGE_KEY = "psa:id-expires-at";

/** When a tab last started a refresh (epoch ms). See {@link REFRESH_LOCK_MS}. */
const REFRESH_LOCK_STORAGE_KEY = "psa:refresh-lock";

/**
 * What counts as "someone is there". Pointer, keyboard, wheel, touch and
 * scroll, all passive so none of them can delay the page.
 *
 * `scroll` is listened for in the capture phase: it does not bubble from the
 * element that scrolls, and in these apps it is a table's own scroller that
 * moves, never the window.
 */
const ACTIVITY_EVENTS = [
  { name: "pointerdown", capture: false },
  { name: "keydown", capture: false },
  { name: "wheel", capture: false },
  { name: "touchstart", capture: false },
  { name: "scroll", capture: true },
] as const;

const LOGIN_PATH = "/login";

/** A stored epoch number, or `null` — storage may be unavailable or empty. */
function readStoredNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
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

function writeStoredNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Same as above: the tab-local values still work.
  }
}

/**
 * Whether this origin's `localStorage` can actually be written.
 *
 * It decides whether the idle sign-out may fire at all: without shared storage
 * this tab cannot know what the tab next to it has been doing, and signing out
 * on its own clock alone would throw away someone else's work mid-sentence.
 */
function storageWorks(): boolean {
  const probe = "psa:storage-probe";
  try {
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
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
  // Zero until the effect below initialises it: `Date.now()` may not be called
  // during render.
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
    // Publish it to the other tabs on the same condition: only when it is
    // genuinely newer than what is on file.
    if (idTokenExpiresAt > (readStoredNumber(ID_EXPIRY_STORAGE_KEY) ?? 0)) {
      writeStoredNumber(ID_EXPIRY_STORAGE_KEY, idTokenExpiresAt);
    }
  }, [idTokenExpiresAt]);

  useEffect(() => {
    const idleWindowMs = IDLE_TIMEOUT_SECONDS * 1000;
    const sharedClock = storageWorks();

    // A hard navigation on purpose, not `router.push`: the session is over, so
    // every cached RSC payload and every piece of client state built for that
    // operator has to go with it.
    const navigateTo = (path: string) => {
      window.location.assign(path);
    };

    /** Leaves for `path`, once. */
    const leaveTo = (path: string) => {
      if (endingRef.current) {
        return;
      }
      endingRef.current = true;
      navigateTo(path);
    };

    const markActivity = () => {
      const now = Date.now();
      lastActivityRef.current = now;
      if (now - lastPersistRef.current >= ACTIVITY_PERSIST_MS) {
        lastPersistRef.current = now;
        writeStoredNumber(ACTIVITY_STORAGE_KEY, now);
      }
    };

    /**
     * Ends the session the way the sign-out control does — the logout route is
     * the only place the refresh cookie is readable, so it is the only place
     * that can revoke it at Cognito.
     *
     * Its answer is waited for, because where the browser goes next depends on
     * it. Landing on `/login?session=idle` while the cookies were still valid
     * would be worse than useless: the login page would see a live session,
     * send the browser back to `/`, remount this component and reset the idle
     * clock. So the "signed out after 30 idle minutes" notice is shown only
     * once the route has confirmed the cookies are gone. Anything else — a
     * network failure, the timeout, a 429 or a 403 — goes to
     * `/login?session=expired`, whose proxy branch deletes every session cookie
     * and lands on a clean `/login`: the app's existing self-heal for "cookies
     * present but useless".
     *
     * `keepalive` so the request still completes if the navigation beats it.
     */
    const signOutIdle = async () => {
      if (endingRef.current) {
        return;
      }
      // Claimed before the fetch, not after: a slow logout must not be fired a
      // second time by the ticks that land while it is in flight.
      endingRef.current = true;

      const controller = new AbortController();
      const timeout = window.setTimeout(() => {
        controller.abort();
      }, LOGOUT_TIMEOUT_MS);
      let cleared = false;
      try {
        const response = await fetch(LOGOUT_PATH, {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          keepalive: true,
          signal: controller.signal,
        });
        // 204 to a fetch, and any other 2xx: the cookies have been deleted.
        cleared = response.ok;
      } catch {
        // Offline, the tab going away, or the timeout above.
      } finally {
        window.clearTimeout(timeout);
      }

      navigateTo(cleared ? IDLE_SESSION_REDIRECT : EXPIRED_SESSION_REDIRECT);
    };

    /**
     * Whether this tab may start a proactive refresh now, or another tab has
     * one in flight. Writes the claim as it grants it.
     */
    const claimRefreshLock = (now: number): boolean => {
      const held = readStoredNumber(REFRESH_LOCK_STORAGE_KEY);
      if (held !== null && now - held < REFRESH_LOCK_MS) {
        return false;
      }
      writeStoredNumber(REFRESH_LOCK_STORAGE_KEY, now);
      return true;
    };

    const renew = async () => {
      const result = await refreshSessionOnce();
      if (result.ok) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const expiresAt =
          result.idTokenExpiresAt ??
          (result.expiresIn === null
            ? nowSeconds + REFRESH_LEAD_SECONDS
            : nowSeconds + result.expiresIn);
        expiresAtRef.current = expiresAt;
        // The cookies this rewrote belong to every tab, so the new expiry does
        // too: the others read it instead of refreshing all over again.
        writeStoredNumber(ID_EXPIRY_STORAGE_KEY, expiresAt);
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
        readStoredNumber(ACTIVITY_STORAGE_KEY) ?? 0,
      );

      if (now - lastActivity >= idleWindowMs) {
        if (!sharedClock) {
          // Passive mode. Without shared storage this tab speaks only for
          // itself, and the tab next to it may well be busy, so it signs
          // nobody out. It simply stops renewing: the marker, refresh and
          // proof cookies are dated "id token expiry + 30 minutes", so an
          // unrenewed session lapses in the browser within 30-35 minutes and
          // the server refuses to refresh it after that. The policy still
          // holds; only the tidy redirect to the notice is lost.
          return;
        }
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

      // Another tab's refresh renewed the very cookies this tab uses, so the
      // shared expiry counts for as much as the one this tab remembers.
      const expiresAt = Math.max(
        expiresAtRef.current,
        readStoredNumber(ID_EXPIRY_STORAGE_KEY) ?? 0,
      );
      expiresAtRef.current = expiresAt;

      if (now < (expiresAt - REFRESH_LEAD_SECONDS) * 1000) {
        return;
      }
      if (now - lastRefreshRef.current < MIN_REFRESH_GAP_MS) {
        return;
      }
      if (!claimRefreshLock(now)) {
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

    // The clock starts from what the tabs of this origin have already recorded,
    // never from "now": stamping the mount would let a navigation — every one
    // of which remounts this component — restart the idle window with nobody
    // touching anything. With nothing on file this is the first tab of a
    // session, and signing in is itself an interaction.
    lastActivityRef.current =
      readStoredNumber(ACTIVITY_STORAGE_KEY) ?? Date.now();

    for (const { name, capture } of ACTIVITY_EVENTS) {
      window.addEventListener(name, markActivity, { passive: true, capture });
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    const timer = window.setInterval(tick, TICK_MS);

    return () => {
      for (const { name, capture } of ACTIVITY_EVENTS) {
        window.removeEventListener(name, markActivity, { capture });
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
