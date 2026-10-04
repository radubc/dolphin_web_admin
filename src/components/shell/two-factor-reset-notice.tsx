"use client";

/**
 * "Set up your authenticator app again": the in-app nudge after a two-factor
 * recovery (`docs/two-factor-plan.md`, phase B; the consumer app's
 * `docs/recovery-codes.md`, section 2).
 *
 * The `(app)` layout asks the admin database one thing — does this operator
 * hold a recovery code with `used_at` set — and passes the answer down. A used
 * row survives exactly until the next enrolment replaces the set, so the
 * notice comes back on every full load until the authenticator is set up
 * again. Deliberately **not** remembered in `localStorage`: this one should
 * keep coming back. Renders nothing.
 */

import { useEffect } from "react";
import { App, Button } from "antd";

const NOTICE_KEY = "two-factor-reset";

export default function TwoFactorResetNotice({
  pending,
  onOpenAccount,
}: {
  /** True when a redeemed recovery code is on file and the factor is off. */
  pending: boolean;
  /** Opens the Account & security drawer, which is shell state, not a route. */
  onOpenAccount: () => void;
}) {
  const { notification } = App.useApp();

  useEffect(() => {
    if (!pending) return;
    notification.warning({
      key: NOTICE_KEY,
      title: "Two-factor authentication is off",
      description:
        "It was turned off with a recovery code. Set up your authenticator app again to protect your sign-in.",
      // Stays until dismissed: a security nudge, not a passing status.
      duration: 0,
      placement: "topRight",
      actions: (
        <Button
          type="primary"
          size="small"
          onClick={() => {
            notification.destroy(NOTICE_KEY);
            onOpenAccount();
          }}
        >
          Open Account &amp; security
        </Button>
      ),
    });
  }, [pending, notification, onOpenAccount]);

  return null;
}
