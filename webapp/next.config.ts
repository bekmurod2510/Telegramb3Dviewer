import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Havola faqat uni olgan odamda bo'lishi kerak (MES `public.py` bilan bir xil):
  // qidiruv tizimi indekslamasin, tashqi saytga o'tilganda manzil oqib ketmasin.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ]
  },
}

export default nextConfig
