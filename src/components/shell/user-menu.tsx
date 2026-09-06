"use client";

import { useRef } from "react";
import { Avatar, Dropdown } from "antd";
import { LogoutOutlined, UserOutlined } from "@ant-design/icons";
import { LOGOUT_PATH } from "@/lib/auth/cookies";
import { accentBlue, accentTints } from "@/lib/theme/colors";

interface UserMenuProps {
  /** From the verified session; null when the id token carried no email. */
  email: string | null;
}

/**
 * Avatar dropdown at the right end of the nav bar: who is signed in, Account
 * (not built yet), and Sign out.
 */
export default function UserMenu({ email }: UserMenuProps) {
  const signOutFormRef = useRef<HTMLFormElement>(null);

  return (
    <>
      {/*
        A plain HTML form, not a Server Action: the browser has to *navigate* to
        `/api/auth/logout` for the `/api/auth`-scoped refresh cookie to be sent,
        and that is the only way the token can be revoked at Cognito. A Server
        Action's `redirect()` is resolved server-side from the original POST, so
        the cookie would never travel. The route answers a navigation with a 303
        to /login.

        The menu item cannot *be* the submit button — antd renders the dropdown
        in a portal outside this form — so the form's own button is hidden and
        the menu item calls `requestSubmit()` on it, which is still a real
        submission and still a real navigation. The `<noscript>` twin below is
        the fallback for a browser that never runs the menu at all.
      */}
      <form
        ref={signOutFormRef}
        action={LOGOUT_PATH}
        method="post"
        // `display: contents` keeps the form out of the toolbar's flex layout
        // (an empty flex item would open a 20px hole next to the avatar) while
        // still leaving it a real, submittable form.
        className="contents"
      >
        <button type="submit" tabIndex={-1} aria-hidden className="hidden">
          Sign out
        </button>
        {/*
          The no-JavaScript path. Without scripts the dropdown never opens, so
          the form needs a control of its own. React treats `<noscript>`
          children as text content, so the markup goes in as raw HTML — it is a
          fixed string, nothing here is interpolated.
        */}
        <noscript
          dangerouslySetInnerHTML={{
            __html:
              '<button type="submit" class="cursor-pointer rounded-full border border-solid border-black/10 bg-white px-3 py-1 text-sm">Sign out</button>',
          }}
        />
      </form>

      <Dropdown
        trigger={["click"]}
        placement="bottomRight"
        menu={{
          items: [
            {
              key: "signed-in-as",
              label: `Signed in as ${email ?? "your account"}`,
              disabled: true,
            },
            { type: "divider" as const },
            {
              key: "account",
              label: "Account",
              icon: <UserOutlined />,
              // No account page yet; the item is here so the menu matches the
              // native one and has somewhere to hang the route later.
              onClick: () => {},
            },
            {
              key: "sign-out",
              label: "Sign out",
              icon: <LogoutOutlined />,
              onClick: () => signOutFormRef.current?.requestSubmit(),
            },
          ],
        }}
      >
        <button
          type="button"
          aria-label="Account menu"
          className="flex cursor-pointer items-center rounded-full border-0 bg-transparent p-0"
        >
          {/* A soft blue disc with a blue glyph: accent present, not shouting. */}
          <Avatar
            size={32}
            icon={<UserOutlined />}
            style={{ backgroundColor: accentTints.soft, color: accentBlue }}
          />
        </button>
      </Dropdown>
    </>
  );
}
