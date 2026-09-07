"use client";

/**
 * Integrations: the outbound calls this app makes to external providers — the
 * TwelveData catalog download, the daily TwelveData quotes, the daily Bank of
 * Canada rates — together with the two watch lists those runs work through.
 *
 * Three views, one screen. A segmented control under the ribbon switches
 * between them and the choice is written into `?view=` with
 * `history.replaceState`, so a reload or a shared link lands on the same one
 * without a server round trip. Each view owns its own frame — its figures, its
 * ribbon and its rail card all describe what is actually on screen — and is
 * mounted alone, so the quote table is not fetched while the currency pairs are
 * being read.
 *
 * Mounting one view at a time also means switching drops the run poller for the
 * Integrations view. That is deliberate: a run belongs to the server, the list
 * reports it again from `latestRun` on the way back, and holding an operator on
 * one view for the minutes a run takes would be worse than losing sight of its
 * progress.
 */

import { useCallback, useState } from "react";
import { Segmented } from "antd";
import { ApiOutlined, StockOutlined, SwapOutlined } from "@ant-design/icons";
import type { AdminCapabilities } from "@/lib/admin-access/types";
import type { IntegrationsViewKey } from "@/lib/integrations/types";
import CurrencyPairsView from "./currency-pairs-view";
import IntegrationsView from "./integrations-view";
import QuoteSymbolsView from "./quote-symbols-view";

const VIEW_OPTIONS: ReadonlyArray<{ value: IntegrationsViewKey; label: string; icon: React.ReactNode }> = [
  { value: "integrations", label: "Integrations", icon: <ApiOutlined /> },
  { value: "quotes", label: "Quote symbols", icon: <StockOutlined /> },
  { value: "rates", label: "Currency pairs", icon: <SwapOutlined /> },
];

interface IntegrationsPageProps {
  /** The signed-in operator, resolved on the server. */
  capabilities: AdminCapabilities;
  /** From `?view=`, so a link opens on the view it names. */
  initialView?: IntegrationsViewKey;
}

export default function IntegrationsPage({ capabilities, initialView }: IntegrationsPageProps) {
  const [view, setView] = useState<IntegrationsViewKey>(initialView ?? "integrations");

  const changeView = useCallback((next: IntegrationsViewKey) => {
    setView(next);
    // Shallow: the URL keeps up with the screen without re-running the Server
    // Component, which would only re-check the same page access.
    window.history.replaceState(null, "", `?view=${encodeURIComponent(next)}`);
  }, []);

  const switcher = (
    <div className="max-w-full overflow-x-auto pb-1">
      <span role="group" aria-label="Integrations view" className="inline-block min-w-max">
        <Segmented<IntegrationsViewKey> value={view} onChange={changeView} options={[...VIEW_OPTIONS]} />
      </span>
    </div>
  );

  switch (view) {
    case "quotes":
      return <QuoteSymbolsView capabilities={capabilities} switcher={switcher} />;
    case "rates":
      return <CurrencyPairsView capabilities={capabilities} switcher={switcher} />;
    case "integrations":
      return <IntegrationsView capabilities={capabilities} switcher={switcher} />;
  }
}
