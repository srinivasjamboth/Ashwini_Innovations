import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
    // Vendored landing-page template (static HTML/jQuery libs + its own
    // css/js). Nothing in the Next app imports it, so its `require()` and
    // `no-this-alias` patterns are not ours to fix — and `npm run lint`
    // is a CI step, so leaving it in fails the pipeline on every push.
    "landing page/**",
  ]),
]);

export default eslintConfig;
