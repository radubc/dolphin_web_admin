import type { NextConfig } from "next";

/**
 * Baseline response headers, applied to every path (pages, assets and API
 * alike). They are cheap, framework-agnostic mitigations that do not depend on
 * anything a handler does.
 *
 * Deliberately absent: `Content-Security-Policy`. Ant Design 6 injects inline
 * `<style>` blocks at render time, so any useful policy needs `style-src` with
 * a per-request nonce threaded through the root layout and the antd registry.
 * A `unsafe-inline` policy instead of that would be theatre. Add it as its own
 * piece of work, with the nonce wiring.
 */
const securityHeaders = [
  // Stop the browser from second-guessing our Content-Type (a JSON response
  // talked into being a script is the classic version of this).
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Send the origin, not the path, to third parties; full URL stays same-origin.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing here is meant to be framed. Covers the browsers that still honour
  // this rather than CSP `frame-ancestors`.
  { key: "X-Frame-Options", value: "DENY" },
  // An admin console needs none of these; deny them everywhere, including in
  // any embedded third-party frame.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

// HSTS is production-only and evaluated once, at config load: pinning HTTPS for
// two years is right for the deployed app and hostile on `localhost`, where a
// stray header would poison the browser for every other local project.
if (process.env.NODE_ENV === "production") {
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  });
}

const nextConfig: NextConfig = {
  // `x-powered-by: Next.js` tells an attacker which CVE list to read.
  poweredByHeader: false,
  // Docker deployment: trace and copy only the files each route needs into
  // `.next/standalone`, so the runtime image ships without `node_modules`.
  // See the Dockerfile at the repo root.
  output: "standalone",
  // Version-skew protection for the ECS rolling deployment: the deploy
  // workflow builds one image per commit SHA and passes it in as the
  // `BUILD_ID` build ARG (see the Dockerfile), which becomes this env var at
  // build time. A client whose deployment id no longer matches the server's
  // gets a hard reload instead of a broken client-side navigation.
  deploymentId: process.env.BUILD_ID,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
  experimental: {
    // The proxy runs on /api/*, and Next buffers every proxied request body in
    // memory so it can be read twice (default limit 10 MB, silently truncated
    // beyond it). Kept just above the 1 MiB JSON cap in
    // `src/lib/api/validate.ts` so our own "too large" verdict fires first
    // instead of a truncated body failing as "not valid JSON".
    proxyClientMaxBodySize: "2mb",
  },
};

export default nextConfig;
