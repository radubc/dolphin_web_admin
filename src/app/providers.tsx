"use client";

import type { ReactNode } from "react";
import { App, ConfigProvider, theme } from "antd";
import {
  accentBlue,
  accentBlueDark,
  accentBlueDeep,
  accentTints,
} from "@/lib/theme/colors";

/**
 * The app-wide antd theme.
 *
 * The accent blue (the same system blue as the mac app) is `colorPrimary`
 * *and* the link colour, and every "selected" affordance antd owns (menu
 * items, tab ink bars, segmented control) is pulled onto it too — otherwise
 * antd's default blue keeps surfacing next to the accent and the page reads
 * as two shades of blue at once.
 *
 * Semantic colours are deliberately left alone: success stays green, warning
 * amber, error red. Money and status must not be confused with the accent.
 *
 * `App` wraps the tree so any client component can raise a toast with
 * `App.useApp()` instead of the static `message.*` calls, which render outside
 * the `ConfigProvider` and therefore lose the theme. `component={false}` makes
 * it a context provider only: it emits no wrapper element, so the layout's
 * full-height flex chain is untouched.
 */
export default function Providers({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: accentBlue,
          colorLink: accentBlue,
          colorLinkHover: accentBlueDark,
          colorLinkActive: accentBlueDeep,
          borderRadius: 8,
          fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
        },
        components: {
          Button: {
            // A hair darker than the accent, for hover/active contrast.
            colorPrimaryHover: accentBlueDark,
            colorPrimaryActive: accentBlueDeep,
          },
          Menu: {
            itemSelectedColor: accentBlue,
            itemSelectedBg: accentTints.soft,
          },
          Tabs: {
            itemSelectedColor: accentBlue,
            itemHoverColor: accentBlueDark,
            inkBarColor: accentBlue,
          },
          Segmented: {
            itemSelectedColor: accentBlue,
          },
        },
      }}
    >
      <App component={false}>{children}</App>
    </ConfigProvider>
  );
}
