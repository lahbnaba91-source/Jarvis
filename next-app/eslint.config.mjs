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
    // Cesium's runtime assets, copied into public/ by postinstall — see
    // scripts/copy-cesium-assets.mjs. Not our source, and gitignored.
    "public/cesium/**",
  ]),
]);

export default eslintConfig;
