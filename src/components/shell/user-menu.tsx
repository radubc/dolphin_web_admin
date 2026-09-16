"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { Avatar, Button, Dropdown, type MenuProps } from "antd";
import {
  LogoutOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { LOGOUT_PATH } from "@/lib/auth/cookies";
import { useCompactLayout } from "@/lib/hooks/use-compact-layout";
import { accentBlue, accentTints, surfaceColors } from "@/lib/theme/colors";
import { presentationFor, type ShellSettingsEntry } from "./definitions";

interface UserMenuProps {
  /** From the verified session; null when the id token carried no email. */
  email: string | null;
  /**
   * The gear menu's pages, already filtered by the access map. Only used on
   * compact, where the nav bar's gear button is hidden and these move in here.
   */
  settingsEntries: readonly ShellSettingsEntry[];
  /** Opens the Account & security drawer, which the shell owns. */
  onOpenAccount: () => void;
  /** Opens the Learning Centre drawer; the nav bar's Help button on compact. */
  onOpenHelp: () => void;
}

/**
 * Avatar dropdown at the right end of the nav bar: who is signed in, Account
 * & security, and Sign out.
 *
 * On compact the bar drops the Help button and the gear, and this menu takes
 * them in — but it becomes the *gear's* menu, not the avatar's: the trigger is
 * drawn as the Settings icon, the settings pages come first, then Help, and
 * the account section (who is signed in, Account & security, Sign out) closes
 * the list. Owner's call (2026-09-15, both apps): the account belongs under
 * Settings, not the settings under the account. The two trigger glyphs are
 * both rendered and swapped by CSS (`max-lg:hidden` / `lg:hidden`), so the
 * server paints the right one; the breakpoint hook only decides the menu's
 * order and label, which are read when the dropdown opens, long after the
 * query has resolved. On desktop nothing changes.
 */
export default function UserMenu({
  email,
  settingsEntries,
  onOpenAccount,
  onOpenHelp,
}: UserMenuProps) {
  const signOutFormRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const compact = useCompactLayout();

  // Empty on desktop, so the menu below is exactly what it has always been.
  const compactItems: NonNullable<MenuProps["items"]> = compact
    ? [
        ...(settingsEntries.length > 0
          ? [
              ...settingsEntries.map((entry) => {
                const { icon: Icon } = presentationFor(entry.key);
                return {
                  key: `settings:${entry.key}`,
                  label: entry.label,
                  icon: <Icon />,
                  // A push, not a `<Link>`: the menu is portalled out of the
                  // bar and an anchor inside it would fight the dropdown's own
                  // click handling.
                  onClick: () => router.push(entry.href),
                };
              }),
              { type: "divider" as const },
            ]
          : []),
        {
          key: "help",
          label: "Help",
          icon: <QuestionCircleOutlined />,
          onClick: onOpenHelp,
        },
        { type: "divider" as const },
      ]
    : [];

  /** Who is signed in, Account & security and Sign out — always last. */
  const accountItems: NonNullable<MenuProps["items"]> = [
    {
      key: "signed-in-as",
      label: `Signed in as ${email ?? "your account"}`,
      disabled: true,
    },
    { type: "divider" as const },
    {
      key: "account",
      label: "Account & security",
      icon: <UserOutlined />,
      // A drawer, not a page: these are the operator's own Cognito
      // settings (password, authenticator app, passkeys), not
      // something the access map should have to grant.
      onClick: onOpenAccount,
    },
    {
      key: "sign-out",
      label: "Sign out",
      icon: <LogoutOutlined />,
      onClick: () => signOutFormRef.current?.requestSubmit(),
    },
  ];

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
        menu={{ items: [...compactItems, ...accountItems] }}
      >
        {/* One trigger, two faces: the avatar on desktop, the gear on compact.
            Both are in the document and CSS picks, so there is no flash of the
            wrong glyph before the breakpoint query resolves. The label is the
            only thing the hook decides, and a screen reader hears it on
            open, not on first paint. */}
        <span className="inline-flex">
          <button
            type="button"
            aria-label="Account menu"
            className="flex cursor-pointer items-center rounded-full border-0 bg-transparent p-0 max-lg:hidden"
          >
            {/* A soft blue disc with a blue glyph: accent present, not shouting. */}
            <Avatar
              size={32}
              icon={<UserOutlined />}
              style={{ backgroundColor: accentTints.soft, color: accentBlue }}
            />
          </button>
          <span className="inline-flex lg:hidden">
            <Button
              type="text"
              shape="circle"
              title="Settings"
              aria-label={compact ? "Settings menu" : "Settings"}
              icon={
                <SettingOutlined
                  style={{ fontSize: 18, color: surfaceColors.textSecondary }}
                />
              }
            />
          </span>
        </span>
      </Dropdown>
    </>
  );
}
