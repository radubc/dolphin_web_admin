---
paths:
  - "src/app/**"
  - "src/proxy.ts"
  - "next.config.ts"
---

# Next.js 16 conventions

This project runs Next.js 16.3 with the App Router, React 19.2, Turbopack. Check `node_modules/next/dist/docs/01-app/` before using any API you are not certain about. Key differences from older versions:

- `params`, `searchParams`, `cookies()`, `headers()`, `draftMode()` are async. Always `await` them.
- Request interception lives in `src/proxy.ts` exporting `proxy()`, not `middleware.ts`. Proxy is for redirects and header tweaks, not data fetching or session management.
- Route types: page and layout props use the generated `PageProps<"/route">` and `LayoutProps<"/route">` helpers (see `src/app/layout.tsx`).
- Caching: this project does not yet enable `cacheComponents`. Until it does, follow the "caching without cache components" guide. If enabling it, use `"use cache"` with `cacheLife`. Admin data is per-operator and authorization-gated; default to uncached, dynamic rendering.
- Server Components by default. `"use client"` only for hooks, event handlers, browser APIs, or Ant Design interactive components.
- Ant Design 6 is registered through `@ant-design/nextjs-registry`; wrap client trees that use antd with `AntdRegistry` in the root layout when antd is introduced.
- Tailwind v4: theme tokens live in `src/app/globals.css` under `@theme inline`. No `tailwind.config.js`.
- Images: `next/image` with explicit width/height; `images.domains` is deprecated, use `remotePatterns`.
- No `next lint`; run `npm run lint` (plain `eslint`, flat config).
- Fonts via `next/font/google` (Geist is already wired in the root layout).
- The dev and start scripts bind port 3001 so the app can run beside the consumer app on 3000. Keep that when touching `package.json`.
