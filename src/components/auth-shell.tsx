import type { ReactNode } from "react";
import Image from "next/image";
import { Card } from "antd";
import { Paragraph, Title } from "@/components/typography";

interface AuthShellProps {
  /** Card heading, e.g. "Sign in to your account". */
  heading: string;
  /** One-line explanation under the heading. */
  description: ReactNode;
  /** Form (and any alerts) rendered inside the card. */
  children: ReactNode;
}

/**
 * Split-screen frame shared by every unauthenticated page: brand panel on one
 * side, a single card on the other. Kept in one place so /login and
 * /forgot-password cannot drift apart.
 *
 * Server Component: antd's `Card` is safe to render from the server, but
 * `Typography.*` is not reachable through the client reference, hence the
 * `@/components/typography` re-exports.
 */
export default function AuthShell({
  heading,
  description,
  children,
}: AuthShellProps) {
  return (
    <div className="flex min-h-dvh flex-1 flex-col min-[900px]:flex-row">
      {/* Brand panel: full height on wide screens, a compact band below 900px. */}
      <aside className="relative flex items-center justify-center overflow-hidden bg-[#ff0000] px-6 py-10 min-[900px]:w-[45%] min-[900px]:py-16">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,rgba(255,255,255,0.22),rgba(255,255,255,0)_62%)]"
        />
        <Image
          src="/brand/logo-white.png"
          alt="Penny Squeeze Admin"
          width={2229}
          height={1050}
          priority
          className="relative h-auto w-[220px] min-[900px]:w-[min(78%,420px)]"
        />
      </aside>

      <main className="flex flex-1 flex-col items-center justify-center bg-[#f6f6f7] px-6 py-12 text-[#141414]">
        <Card className="w-full max-w-[420px]">
          <Title level={2} style={{ fontSize: 24, marginBottom: 4 }}>
            {heading}
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 24 }}>
            {description}
          </Paragraph>
          {children}
        </Card>
        <p className="mt-6 text-sm text-[#8c8c8c]">© 2026 Penny Squeeze</p>
      </main>
    </div>
  );
}
