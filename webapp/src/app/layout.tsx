import type { Metadata, Viewport } from "next"
import Script from "next/script"
import "./globals.css"

export const metadata: Metadata = {
  title: "3D model",
  description: "Mebel 3D modeli — Telegram mini ilova",
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#ffffff",
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="uz">
      <head>
        {/* Telegram Mini App SDK — `window.Telegram.WebApp` sahifadan oldin
            tayyor bo'lsin (`ready()`/`expand()` birinchi renderda chaqiriladi) */}
        <Script
          src="https://telegram.org/js/telegram-web-app.js?59"
          strategy="beforeInteractive"
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
