import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import Providers from "./providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Penny Squeeze Admin",
  description: "Penny Squeeze operator console",
};

/**
 * `viewport-fit=cover` is what makes `env(safe-area-inset-*)` anything but
 * zero, and the shell's bottom tab bar pads itself by the bottom inset so it
 * clears a phone's home indicator. `width=device-width, initial-scale=1` is
 * Next's default already; it is spelled out here so the whole tag is in one
 * place. Zooming is deliberately left alone — pinching an admin table is a
 * legitimate thing to want to do.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AntdRegistry>
          <Providers>{children}</Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
