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
 * Frame shared by every unauthenticated page: the brand mark above a single
 * card, on the plain page background. Kept in one place so /login,
 * /forgot-password, /setup and /no-access cannot drift apart.
 *
 * Only the symbol is shown, the same mark the nav bar uses: the full wordmark
 * on disk is white and needs a coloured panel behind it, and the owner asked
 * for exactly that panel to go.
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
    <div className="flex min-h-dvh flex-1 flex-col">
      <main className="flex flex-1 flex-col items-center justify-center bg-[#f6f6f7] px-6 py-12 text-[#141414]">
        <Image
          src="/brand/symbol.png"
          alt="Penny Squeeze Admin"
          width={1092}
          height={1050}
          sizes="72px"
          priority
          className="mb-6 h-[72px] w-auto rounded-2xl"
        />
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
