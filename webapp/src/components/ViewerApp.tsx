"use client"

/** Mini ilovaning yagona sahifasi: havoladagi modelni ochadi, bo'lmasa JSON
 * qo'lda yuklanadi (sinov va botning fayl bilan yuborgan javobi uchun).
 *
 * Model manbasi — havola parametri `?m=` (`lib/encode.ts`): bot uni
 * `web_app` tugmasiga yozadi, server kerak emas. Sahna telefonda ochiladi:
 * balandlik `dvh`, 3D qolgan joyni oladi (MES `routes/3d.$token.tsx` kabi).
 *
 * Pastda «O'zgartirish» qatori: foydalanuvchi matn yozadi («surma eshiklar»),
 * `/api/edit` Gemini bilan `model_3d` ni yangilaydi, sahna qayta chiziladi.
 * Faqat bot manbali modelda — MESdan kelgan `BazisModel` ni tahrirlab bo'lmaydi.
 */

import { ChevronLeft, FileJson, PackageX, RotateCcw, Send, Wand2 } from "lucide-react"
import dynamic from "next/dynamic"
import { useEffect, useMemo, useState } from "react"
import { type BazisModel, gabarit } from "@/components/Bazis/model"
import { Button } from "@/components/ui/button"
import {
  type BotModel3D,
  type BotResult,
  botResultToBazis,
  parseModelInput,
} from "@/lib/botModel"
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

type ModelHolati = {
  model: BazisModel
  /** Joriy bot manbasi (o'zgartirishlar shunga qo'llanadi); MES modelida `null` */
  bot: BotResult | null
  /** Ochilgandagi asl manba — «Asl» tugmasi shunga qaytaradi */
  asl: BotResult | null
  qolda: boolean
}

type Holat =
  | { tur: "yuklanmoqda" }
  | { tur: "bosh" }
  | { tur: "xato"; xabar: string }
  | ({ tur: "model" } & ModelHolati)

const xatoMatni = (e: unknown): string =>
  e instanceof Error ? e.message : "Model ochilmadi"

const MAX_SOROV = 400

function Markaz({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      {children}
    </div>
  )
}

/** Qo'lda yuklash: JSON matni yoki fayl (bot javobi yoki MES modeli) */
function Yuklash({ onModel }: { onModel: (m: ModelHolati) => void }) {
  const [matn, setMatn] = useState("")
  const [xabar, setXabar] = useState<string | null>(null)

  const och = (json: string) => {
    try {
      const { model, bot } = parseModelInput(JSON.parse(json))
      onModel({ model, bot, asl: bot, qolda: true })
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

/** «O'zgartirish» qatori — sahna ostida, doim ko'rinib turadi */
function Ozgartirish({
  bot,
  ozgargan,
  onNatija,
  onAsl,
}: {
  bot: BotResult
  ozgargan: boolean
  onNatija: (model_3d: BotModel3D) => void
  onAsl: () => void
}) {
  const [sorov, setSorov] = useState("")
  const [band, setBand] = useState(false)
  const [izoh, setIzoh] = useState<{ tur: "ok" | "xato"; matn: string } | null>(null)

  const yubor = async () => {
    const s = sorov.trim()
    if (!s || band || !bot.model_3d) return
    setBand(true)
    setIzoh(null)
    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model_3d: bot.model_3d,
          instruction: s,
          context: {
            furniture_type: bot.furniture_type,
            description: bot.description,
            style: bot.style,
          },
        }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        model_3d?: BotModel3D
        note?: string
        error?: string
      }
      if (!res.ok || !data.model_3d)
        throw new Error(data.error ?? `Server xatosi (${res.status})`)
      onNatija(data.model_3d)
      setSorov("")
      setIzoh({ tur: "ok", matn: data.note || "O'zgartirildi" })
    } catch (e) {
      setIzoh({ tur: "xato", matn: xatoMatni(e) })
    } finally {
      setBand(false)
    }
  }

  return (
    <div className="shrink-0 border-border border-t bg-card px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void yubor()
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Wand2 className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={sorov}
            onChange={(e) => setSorov(e.target.value.slice(0, MAX_SOROV))}
            disabled={band}
            enterKeyHint="send"
            placeholder="O'zgartirish: masalan, «surma eshiklar»"
            aria-label="Modelga o'zgartirish so'rovi"
            className="h-10 w-full rounded-full border border-input bg-background pr-3 pl-9 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
          />
        </div>
        {ozgargan && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => {
              onAsl()
              setIzoh(null)
            }}
            disabled={band}
            title="Asl holatga qaytarish"
            aria-label="Asl holatga qaytarish"
          >
            <RotateCcw />
          </Button>
        )}
        <Button
          type="submit"
          size="icon"
          disabled={band || !sorov.trim()}
          aria-label="Yuborish"
        >
          <Send />
        </Button>
      </form>
      {(band || izoh) && (
        <p
          className={`mt-1.5 truncate text-xs ${izoh?.tur === "xato" ? "text-destructive" : "text-muted-foreground"}`}
          role="status"
        >
          {band ? "Gemini o'zgartirmoqda…" : izoh?.matn}
        </p>
      )}
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
        if (!tirik) return
        const { model, bot } = parseModelInput(json)
        setHolat({ tur: "model", model, bot, asl: bot, qolda: false })
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
        <Yuklash onModel={(m) => setHolat({ tur: "model", ...m })} />
      </div>
    )
  }

  const joriy = holat
  /** Yangi `model_3d` — manbaga yoziladi, sahna qayta hisoblanadi */
  const qollash = (model_3d: BotModel3D) => {
    if (!joriy.bot) return
    const bot: BotResult = { ...joriy.bot, model_3d }
    setHolat({ ...joriy, bot, model: botResultToBazis(bot) })
  }
  const aslgaQaytar = () => {
    if (!joriy.asl) return
    setHolat({ ...joriy, bot: joriy.asl, model: botResultToBazis(joriy.asl) })
  }

  return (
    <div className="flex h-dvh flex-col bg-surface">
      <header className="flex shrink-0 items-center gap-3 border-border border-b bg-card px-3 py-2.5">
        {joriy.qolda && (
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
            {joriy.model.name || "Mebel"}
          </div>
          <div className="flex min-w-0 gap-1 text-muted-foreground text-xs">
            <span className="truncate tabular-nums">
              {joriy.model.panels.length} detal
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
      <ModelViewer model={joriy.model} />
      {joriy.bot?.model_3d && (
        <Ozgartirish
          bot={joriy.bot}
          ozgargan={joriy.bot !== joriy.asl}
          onNatija={qollash}
          onAsl={aslgaQaytar}
        />
      )}
    </div>
  )
}
