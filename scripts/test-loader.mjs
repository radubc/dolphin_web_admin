/**
 * Module hooks for `node --test` over the TypeScript sources.
 *
 * Node 24 strips types natively, but its ESM resolver wants explicit file
 * extensions and knows nothing about the `@/` path alias `tsconfig.json`
 * defines. This hook fills both gaps for the test run only, so test files
 * and the modules under test can keep the same import style as the rest of
 * the codebase:
 *
 * - a relative or `@/` specifier that does not resolve as written is retried
 *   with `.ts`, `.tsx`, `/index.ts`;
 * - `@/` maps to `src/`.
 *
 * Run with `--conditions=react-server` so `server-only` resolves to its empty
 * build instead of throwing (that package exists to refuse *client* bundles;
 * the tests are the server). See `package.json` → `test`. The same setup the
 * consumer app uses (`../penny-squeeze-web/scripts/test-loader.mjs`).
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".mts", "/index.ts", "/index.tsx"];

function resolveWithExtensions(basePath) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${basePath}${suffix}`;
    if (existsSync(candidate) && !candidate.endsWith("/")) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const resolved = resolveWithExtensions(path.join(srcDir, specifier.slice(2)));
      if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const resolved = resolveWithExtensions(path.resolve(parentDir, specifier));
      if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
