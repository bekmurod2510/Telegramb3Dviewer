/** Bot modeli (`bot.py: AnalysisResult / Model3D`) -> ko'ruvchi modeli (`BazisModel` v2).
 *
 * Bot mebelni oddiy primitivlarga (quti va silindr) ajratadi, ko'ruvchi esa
 * PANEL chizadi: kontur `o` o'z tekisligida, qalinlik `t` mahalliy +Z bo'ylab
 * 0..t (`scene.ts: ExtrudeGeometry`), `p` — mahalliy koordinata boshi, `q` —
 * burilish. Quti = to'rtburchak konturli panel (qalinlik — eng kichik tomoni),
 * silindr = aylana konturli panel (`rd: 1`, qalinlik — o'qi bo'ylab uzunlik).
 *
 * O'qlar. Bot: x — eni (chapdan o'ngga), y — bo'yi (poldan tepaga), z —
 * chuqurlik (OLD yuzadan orqaga), koordinata boshi old-chap-pastki burchak.
 * Ko'ruvchi (Bazis): X eni, Y bo'yi, +Z — OLD tomon (kamera `(0.62, 0.42, 0.66)`
 * dan qaraydi). Shuning uchun Z = D − z: old yuza Z = D da, tutqichlar (botda
 * z < 0) undan ham oldinda.
 *
 * Birlik: ko'ruvchi mm da, bot sm da (`units: "cm"`) yoki gabarit ulushida
 * (`units: "fraction"`, o'lcham berilmagan) — ulush taxminiy gabaritga,
 * u ham bo'lmasa 1 m ga ko'paytiriladi.
 */

import type { BazisModel, BazisOlcham, BazisPanel } from "@/components/Bazis/model"
import { MODEL_VERSIYA } from "@/components/Bazis/model"

export type BotVec3 = { x: number; y: number; z: number }
export type BotDims = { width_cm: number; depth_cm: number; height_cm: number }
export type BotMaterial = {
  id: string
  name: string
  color_hex?: string
  finish?: string
  roughness?: number
  metalness?: number
}
export type BotPart = {
  id: string
  role?: string
  shape: "box" | "cylinder"
  axis?: "x" | "y" | "z"
  material_id: string
  center: BotVec3
  size: BotVec3
}
export type BotModel3D = {
  units: "cm" | "fraction"
  bounding_box_cm?: BotDims | null
  materials: BotMaterial[]
  parts: BotPart[]
}
export type BotResult = {
  is_furniture?: boolean
  furniture_type?: string
  description?: string
  style?: string
  estimated_dimensions_cm?: BotDims | null
  dimensions_cm?: BotDims | null
  model_3d?: BotModel3D | null
}

const S = Math.SQRT1_2
/** Mahalliy +Z -> dunyo +Z (orqa panel, eshik) */
const Q_Z: BazisPanel["q"] = [0, 0, 0, 1]
/** Mahalliy +Z -> dunyo +X (yon devor); mahalliy X -> −Z, Y -> Y */
const Q_X: BazisPanel["q"] = [0, S, 0, S]
/** Mahalliy +Z -> dunyo +Y (tom, tag, javon); mahalliy X -> X, Y -> −Z */
const Q_Y: BazisPanel["q"] = [-S, 0, 0, S]

/** Aylana kontur — silindr uchun; 24 qirra telefonda ham silliq ko'rinadi */
const AYLANA_QIRRA = 24

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null

const son = (v: unknown, nom: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error(`Model buzuq: «${nom}» son emas`)
  return v
}

const vec = (v: unknown, nom: string): BotVec3 => {
  if (!isObj(v)) throw new Error(`Model buzuq: «${nom}» yo'q`)
  return {
    x: son(v.x, `${nom}.x`),
    y: son(v.y, `${nom}.y`),
    z: son(v.z, `${nom}.z`),
  }
}

/** `left_side_panel` -> `Left side panel`; rol bo'lsa (`side_panel`) ham shunday */
const odamcha = (s: string): string => {
  const t = s.replace(/[_-]+/g, " ").trim()
  return t ? t[0].toUpperCase() + t.slice(1) : s
}

/** Material nomi — rang va finish nomning o'zida: ko'ruvchi rangni FAQAT
 * nomdan oladi (`model.ts: materialColor`), botniki esa rasmdan o'lchangan. */
const materialNomi = (m: BotMaterial): string => {
  const hex = (m.color_hex ?? "").trim()
  const rang = /^#?[0-9a-f]{6}$/i.test(hex) ? ` #${hex.replace("#", "")}` : ""
  const finish = (m.finish ?? "").toLowerCase()
  const teg = [
    "glossy",
    "matte",
    "satin",
    "metal",
    "glass",
    "mirror",
    "fabric",
    "leather",
  ].includes(finish)
    ? ` ${finish}`
    : ""
  return `${m.name || m.id || "material"}${rang}${teg}`
}

/** Bot `Model3D` (yoki to'liq `AnalysisResult`) dan ko'ruvchi modeli */
export function botToBazis(
  m3d: BotModel3D,
  meta: { code?: string; name?: string; dims?: BotDims | null } = {},
): BazisModel {
  const sm = m3d.units === "cm"
  // Gabarit, mm: sm da — berilgan quti yoki qismlardan; ulushda — taxminiy
  // gabarit, u ham yo'q bo'lsa 1 m kub
  const quti = m3d.bounding_box_cm ?? meta.dims ?? null
  let W = 1000
  let H = 1000
  let D = 1000
  if (quti) {
    W = quti.width_cm * 10
    H = quti.height_cm * 10
    D = quti.depth_cm * 10
  } else if (sm) {
    W = Math.max(...m3d.parts.map((p) => p.center.x + p.size.x / 2)) * 10
    H = Math.max(...m3d.parts.map((p) => p.center.y + p.size.y / 2)) * 10
    D = Math.max(...m3d.parts.map((p) => p.center.z + p.size.z / 2)) * 10
  }
  // Bot koordinatasi -> mm (ulushda gabaritga ko'paytiriladi)
  const mm = (v: BotVec3): [number, number, number] =>
    sm ? [v.x * 10, v.y * 10, v.z * 10] : [v.x * W, v.y * H, v.z * D]

  const matIndeks = new Map<string, number>()
  const mats = m3d.materials.map((m, i) => {
    matIndeks.set(m.id, i)
    return materialNomi(m)
  })
  if (!mats.length) mats.push("material #b0b0b0 matte")

  const panels: BazisPanel[] = m3d.parts.map((part, i) => {
    const c = mm(vec(part.center, `parts[${i}].center`))
    const s = mm(vec(part.size, `parts[${i}].size`))
    const [sx, sy, sz] = s.map((v) => Math.max(v, 0.5)) as [number, number, number]
    // Dunyo: X = x, Y = y, Z = D − z (old yuza +Z tomonda)
    const markaz: [number, number, number] = [c[0], c[1], D - c[2]]

    // Qalinlik o'qi: silindrda — o'qi, qutida — eng kichik tomoni
    let oq: "x" | "y" | "z"
    if (part.shape === "cylinder") oq = part.axis ?? "y"
    else oq = sx <= sy && sx <= sz ? "x" : sy <= sz ? "y" : "z"

    let t: number
    let w: number
    let h: number
    let q: BazisPanel["q"]
    let p: [number, number, number]
    if (oq === "x") {
      t = sx
      w = sz
      h = sy
      q = Q_X
      p = [markaz[0] - t / 2, markaz[1], markaz[2]]
    } else if (oq === "y") {
      t = sy
      w = sx
      h = sz
      q = Q_Y
      p = [markaz[0], markaz[1] - t / 2, markaz[2]]
    } else {
      t = sz
      w = sx
      h = sy
      q = Q_Z
      p = [markaz[0], markaz[1], markaz[2] - t / 2]
    }

    let o: [number, number][]
    let rd: 1 | undefined
    if (part.shape === "cylinder") {
      const r = (w + h) / 4
      o = Array.from({ length: AYLANA_QIRRA }, (_, k) => {
        const a = (2 * Math.PI * k) / AYLANA_QIRRA
        return [r * Math.cos(a), r * Math.sin(a)] as [number, number]
      })
      w = r * 2
      h = r * 2
      rd = 1
    } else {
      o = [
        [-w / 2, -h / 2],
        [w / 2, -h / 2],
        [w / 2, h / 2],
        [-w / 2, h / 2],
      ]
    }

    const yax = (v: number) => Math.round(v * 10) / 10
    const panel: BazisPanel = {
      id: part.id || `part_${i + 1}`,
      n: odamcha(part.role || part.id || "part"),
      m: matIndeks.get(part.material_id) ?? 0,
      t: yax(t),
      s: [yax(w), yax(h)],
      p: p.map(yax) as [number, number, number],
      q,
      o: o.map(([x, y]) => [yax(x), yax(y)] as [number, number]),
    }
    if (rd) panel.rd = rd
    return panel
  })

  // Umumiy o'lchamlar — ko'ruvchidagi «O'lchamlar» tugmasi uchun: eni old-pastki
  // qirrada, bo'yi o'ng-old qirrada, chuqurligi o'ng-pastki qirrada
  const k = Math.max(40, Math.min(W, H, D) * 0.08)
  const d: BazisOlcham[] = [
    { v: Math.round(W), a: [0, 0, D], b: [W, 0, D], o: [0, -k, k] },
    { v: Math.round(H), a: [W, 0, D], b: [W, H, D], o: [k, 0, k] },
    { v: Math.round(D), a: [W, 0, 0], b: [W, 0, D], o: [k, -k, 0] },
  ]

  return {
    v: MODEL_VERSIYA,
    code: meta.code ?? "",
    name: meta.name ?? meta.code ?? "Mebel",
    mats,
    panels,
    d,
  }
}

/** Ko'ruvchi modelimi (MESdan ko'chirilgan JSON ham ochiladi) */
export const isBazisModel = (v: unknown): v is BazisModel =>
  isObj(v) && Array.isArray(v.panels) && Array.isArray(v.mats) && "v" in v

/** Ulushli (`units: "fraction"`) modelni sm ga o'tkazadi — o'zgartirish
 * (`/api/edit`) va qayta chizish bir xil, sm li shaklda ishlasin. O'lcham
 * noma'lum bo'lsa 100 sm kub olinadi (bot ham shunday "unscaled" beradi). */
const smGa = (m: BotModel3D, dims: BotDims | null): BotModel3D => {
  if (m.units === "cm") return m
  const q = m.bounding_box_cm ??
    dims ?? { width_cm: 100, depth_cm: 100, height_cm: 100 }
  const k = (v: BotVec3): BotVec3 => ({
    x: v.x * q.width_cm,
    y: v.y * q.height_cm,
    z: v.z * q.depth_cm,
  })
  return {
    units: "cm",
    bounding_box_cm: q,
    materials: m.materials,
    parts: m.parts.map((p) => ({ ...p, center: k(p.center), size: k(p.size) })),
  }
}

/** Ko'ruvchi modeli + uning bot manbasi (o'zgartirish uchun). MESdan kelgan
 * `BazisModel` da manba yo'q (`bot: null`) — uni tahrirlab bo'lmaydi. */
export type ModelManbasi = { model: BazisModel; bot: BotResult | null }

/** Bot javobidan (yoki yalang'och `model_3d` dan) ko'ruvchi modeli */
export const botResultToBazis = (r: BotResult): BazisModel => {
  if (!r.model_3d)
    throw new Error(
      r.is_furniture === false
        ? "Rasmda mebel topilmadi — 3D model yo'q"
        : "Javobda 3D model yo'q",
    )
  const tur = odamcha(r.furniture_type ?? "")
  return botToBazis(r.model_3d, {
    code: r.furniture_type ?? "",
    name: [tur, r.style].filter(Boolean).join(" · ") || tur || "Mebel",
    dims: r.dimensions_cm ?? r.estimated_dimensions_cm ?? null,
  })
}

/** Har qanday qo'llab-quvvatlanadigan JSON -> ko'ruvchi modeli va manbasi:
 * * `BazisModel` (MES `/public/3d/.../model` javobi) — o'zgarishsiz;
 * * bot `AnalysisResult` (`model_3d` bilan);
 * * yalang'och bot `Model3D` (`parts` + `materials`). */
export function parseModelInput(input: unknown): ModelManbasi {
  if (isBazisModel(input)) {
    if (input.v !== MODEL_VERSIYA)
      throw new Error("Bu model eskirgan — uni qayta yarating")
    return { model: input, bot: null }
  }
  if (!isObj(input)) throw new Error("Model JSON emas")
  let r: BotResult
  if ("model_3d" in input) r = { ...(input as BotResult) }
  else if (Array.isArray(input.parts) && Array.isArray(input.materials))
    r = { model_3d: input as unknown as BotModel3D }
  else throw new Error("Model formati tanilmadi")
  if (r.model_3d)
    r.model_3d = smGa(
      r.model_3d,
      r.dimensions_cm ?? r.estimated_dimensions_cm ?? null,
    )
  return { model: botResultToBazis(r), bot: r }
}

export const toBazisModel = (input: unknown): BazisModel =>
  parseModelInput(input).model
