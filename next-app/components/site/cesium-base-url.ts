// Tells Cesium where to fetch its runtime assets (Workers, Assets, ThirdParty)
// from — the copies scripts/copy-cesium-assets.mjs places in public/cesium at
// install time. Must run before anything imports from "cesium".
declare global {
  interface Window {
    CESIUM_BASE_URL?: string
  }
}

export function setCesiumBaseUrl() {
  if (typeof window !== "undefined") {
    window.CESIUM_BASE_URL = "/cesium"
  }
}
