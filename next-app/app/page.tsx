"use client"

import dynamic from "next/dynamic"

// Entirely client-rendered: it reads window.location for its initial view and
// wraps CesiumJS, which needs the DOM. See components/site/site-page-client.tsx.
const SitePageClient = dynamic(() => import("@/components/site/site-page-client"), {
  ssr: false,
  loading: () => (
    <div className="flex h-svh w-full items-center justify-center text-sm text-muted-foreground">
      Loading Site Analyzer…
    </div>
  ),
})

export default function Page() {
  return <SitePageClient />
}
