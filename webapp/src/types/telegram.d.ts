/** `telegram-web-app.js` dan kerakli qismi (layout.tsx da ulanadi) */
interface TelegramWebApp {
  ready(): void
  expand(): void
  close(): void
  initDataUnsafe?: { start_param?: string }
  colorScheme?: "light" | "dark"
  setHeaderColor?(color: string): void
  setBackgroundColor?(color: string): void
  disableVerticalSwipes?(): void
}

interface Window {
  Telegram?: { WebApp?: TelegramWebApp }
}
