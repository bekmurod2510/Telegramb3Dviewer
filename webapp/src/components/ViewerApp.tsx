"use client"

/** Mini ilovaning yagona sahifasi: havoladagi modelni ochadi, bo'lmasa JSON
 * qo'lda yuklanadi (sinov va botning fayl bilan yuborgan javobi uchun).
 *
 * Model manbasi — havola parametri `?m=` (`lib/encode.ts`): bot uni
 * `web_app` tugmasiga yozadi, server kerak emas. Sahna telefonda ochiladi:
 * balandlik `dvh`, 3D qolgan joyni oladi (MES `routes/3d.$token.tsx` kabi).
 */

import { ChevronLeft, FileJson, PackageX } from "lucide-react"
import dynamic from "next/dynamic"
import { useEffect, useMemo, useState } from "react"
import { type BazisModel, gabarit } from "@/components/Bazis/model"
import { Button } from "@/components/ui/button"
import { toBazisModel } from "@/lib/botModel"
import { decodeModelParam, modelParamFromLocation } from "@/lib/encode"

// three.js faqat shu chunk'da va faqat brauzerda: sahna `document`/`window`
// bilan ishlaydi, serverda chizilmaydi.
const ModelViewer = dynamic(
  () => import("@/components/Bazis/ModelViewer").then((m) => m.ModelViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
        3D yuklanmoqda…
      </div>
    ),
  },
)

type Holat =
  | { tur: "yuklanmoqda" }
  | { tur: "bosh" }
  | { tur: "xato"; xabar: string }
  | { tur: "model"; model: BazisModel; qolda: boolean }

const xatoMatni = (e: unknown): string =>
  e instanceof Error ? e.message : "Model ochilmadi"

function Markaz({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      {children}
    </div>
  )
}

/** Qo'lda yuklash: JSON matni yoki fayl (bot javobi yoki MES modeli) */
function Yuklash({
  onModel,
  xato,
}: {
  onModel: (m: BazisModel) => void
  xato: string | null
}) {
  const [matn, setMatn] = useState("")
  const [xabar, setXabar] = useState<string | null>(xato)

  const och = (json: string) => {
    try {
      onModel(toBazisModel(JSON.parse(json)))
      setXabar(null)
    } catch (e) {
      setXabar(xatoMatni(e))
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-3 p-4">
      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2 font-semibold">
          <FileJson className="size-5 text-primary" />
          Model JSON
        </div>
        <p className="mt-1 text-muted-foreground text-sm">
          Botning javobini (JSON) shu yerga qo'ying yoki fayl sifatida tanlang.
          Havola orqali ochilganda bu qadam kerak emas.
        </p>
        <textarea
          value={matn}
          onChange={(e) => setMatn(e.target.value)}
          spellCheck={false}
          placeholder='{"model_3d": {...}}'
          className="num mt-3 h-40 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={() => och(matn)} disabled={!matn.trim()}>
            Ochish
          </Button>
          <label className="inline-flex h-9 cursor-pointer items-center rounded-md border bg-background px-4 text-sm font-medium hover:bg-accent">
            Fayl tanlash
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (f) och(await f.text())
                e.target.value = ""
              }}
            />
          </label>
        </div>
        {xabar && <p className="mt-3 text-destructive text-sm">{xabar}</p>}
      </div>
    </div>
  )
}

export function ViewerApp() {
  const [holat, setHolat] = useState<Holat>({ tur: "yuklanmoqda" })

  useEffect(() => {
    const tg = window.Telegram?.WebApp
    tg?.ready()
    tg?.expand()
    tg?.disableVerticalSwipes?.()
    tg?.setHeaderColor?.("#ffffff")
    tg?.setBackgroundColor?.("#f4f6f9")

    const param = modelParamFromLocation(window.location)
    if (!param) {
      setHolat({ tur: "bosh" })
      return
    }
    let tirik = true
    decodeModelParam(param)
      .then((json) => {
        if (tirik)
          setHolat({ tur: "model", model: toBazisModel(json), qolda: false })
      })
      .catch((e) => {
        if (tirik) setHolat({ tur: "xato", xabar: xatoMatni(e) })
      })
    return () => {
      tirik = false
    }
  }, [])

  const model = holat.tur === "model" ? holat.model : null
  const olchami = useMemo(() => {
    if (!model) return null
    const g = gabarit(model)
    return g.some((v) => v > 0) ? g : null
  }, [model])

  if (holat.tur === "yuklanmoqda") {
    return (
      <div className="flex h-dvh flex-col bg-surface">
        <Markaz>
          <span className="text-muted-foreground text-sm">Yuklanmoqda…</span>
        </Markaz>
      </div>
    )
  }

  if (holat.tur === "xato") {
    return (
      <div className="flex h-dvh flex-col bg-surface">
        <Markaz>
          <PackageX className="size-10 text-muted-foreground" />
          <div className="font-semibold text-lg">Model ochilmadi</div>
          <p className="max-w-xs text-muted-foreground text-sm">{holat.xabar}</p>
          <Button variant="outline" onClick={() => setHolat({ tur: "bosh" })}>
            JSON qo'lda yuklash
          </Button>
        </Markaz>
      </div>
    )
  }

  if (holat.tur === "bosh") {
    return (
      <div className="flex h-dvh flex-col bg-surface">
        <header className="flex shrink-0 items-center gap-3 border-border border-b bg-card px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold leading-tight">3D model</div>
            <div className="truncate text-muted-foreground text-xs">
              Modelni ochish uchun bot javobini yuklang
            </div>
          </div>
        </header>
        <Yuklash
          xato={null}
          onModel={(m) => setHolat({ tur: "model", model: m, qolda: true })}
        />
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col bg-surface">
      <header className="flex shrink-0 items-center gap-3 border-border border-b bg-card px-3 py-2.5">
        {holat.qolda && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setHolat({ tur: "bosh" })}
            aria-label="Orqaga"
          >
            <ChevronLeft />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold leading-tight">
            {holat.model.name || "Mebel"}
          </div>
          <div className="flex min-w-0 gap-1 text-muted-foreground text-xs">
            <span className="truncate tabular-nums">
              {holat.model.panels.length} detal
            </span>
            {/* Umumiy o'lcham — usta birinchi so'raydigan savol "qancha joy egallaydi" */}
            {olchami && (
              <span
                className="shrink-0 whitespace-nowrap tabular-nums"
                title="Eni × bo'yi × chuqurligi"
              >
                · {olchami.join(" × ")} mm
              </span>
            )}
          </div>
        </div>
      </header>
      <ModelViewer model={holat.model} />
    </div>
  )
}
