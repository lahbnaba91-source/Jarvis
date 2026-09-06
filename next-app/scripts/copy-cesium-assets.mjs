// Copies CesiumJS's runtime static assets (Workers, ThirdParty, Assets, Widgets)
// into public/cesium so the browser can fetch them at runtime via CESIUM_BASE_URL.
// Plain filesystem copy — no bundler plugin — so it works the same under
// webpack or Turbopack. Runs automatically via the "postinstall" script.
import { cpSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")
const src = join(root, "node_modules", "cesium", "Build", "Cesium")
const dest = join(root, "public", "cesium")

if (!existsSync(src)) {
  console.warn(`[copy-cesium-assets] source not found at ${src}, skipping`)
  process.exit(0)
}

const folders = ["Workers", "ThirdParty", "Assets", "Widgets"]

mkdirSync(dest, { recursive: true })

for (const folder of folders) {
  const from = join(src, folder)
  const to = join(dest, folder)
  if (!existsSync(from)) continue
  cpSync(from, to, { recursive: true })
  console.log(`[copy-cesium-assets] copied ${folder} -> public/cesium/${folder}`)
}
