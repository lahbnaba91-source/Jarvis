import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
// Cesium's widget CSS (measurement/info-box chrome). Cesium's JS runtime assets
// (Workers/Assets/ThirdParty) are served separately from public/cesium — see
// scripts/copy-cesium-assets.mjs and components/site/cesium-base-url.ts.
import "cesium/Build/Cesium/Widgets/widgets.css"
import { ThemeProvider } from "@/components/theme-provider"
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, "font-sans", geist.variable)}
    >
      <body suppressHydrationWarning>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
