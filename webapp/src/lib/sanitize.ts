/** Bot `model_3d` (sm) ni tozalash — `bot.py: sanitize_model` ning sm li
 * ko'rinishi. Gemini javobi ham, mijozdan kelgan JSON ham shu yerdan o'tadi:
 * ko'ruvchi hech qachon buzuq geometriya olmasin (NaN, bo'sh ro'yxat, takror
 * id, yo'q material). */

import type { BotDims, BotMaterial, BotModel3D, BotPart, BotVec3 } from "./botModel"

export const FINISHES = [
  "matte",
  "satin",
  "glossy",
  "wood",
  "fabric",
  "leather",
  "metal",
  "glass",
  "mirror",
] as const

/** Eng ko'p qism — Gemini 3..24 beradi; undan ko'pi javob kesilganining belgisi */
export const MAX_PARTS = 80

const DEFAULT_MATERIAL: BotMaterial = {
  id: "default",
  name: "unknown",
  color_hex: "#B0B0B0",
  finish: "matte",
  roughness: 0.8,
  metalness: 0,
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const son = (v: unknown, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d

const matn = (v: unknown, d: string): string =>
  typeof v === "string" && v.trim() ? v.trim() : d

const vec = (v: unknown): BotVec3 | null =>
  isObj(v) &&
  [v.x, v.y, v.z].every((n) => typeof n === "number" && Number.isFinite(n))
    ? { x: v.x as number, y: v.y as number, z: v.z as number }
    : null

export class SanitizeError extends Error {}

export function sanitizeModel3D(raw: unknown): BotModel3D {
  if (!isObj(raw)) throw new SanitizeError("model_3d obyekt emas")
  const bb = raw.bounding_box_cm
  if (!isObj(bb)) throw new SanitizeError("bounding_box_cm yo'q")
  const quti: BotDims = {
    width_cm: son(bb.width_cm, 0),
    depth_cm: son(bb.depth_cm, 0),
    height_cm: son(bb.height_cm, 0),
  }
  if (quti.width_cm <= 0 || quti.depth_cm <= 0 || quti.height_cm <= 0)
    throw new SanitizeError("bounding_box_cm musbat emas")
  const { width_cm: W, depth_cm: D, height_cm: H } = quti

  const materials: BotMaterial[] = []
  const matId = new Set<string>()
  for (const m of Array.isArray(raw.materials) ? raw.materials : []) {
    if (!isObj(m)) continue
    let id = matn(m.id, `material_${materials.length + 1}`)
    while (matId.has(id)) id = `${id}_${materials.length + 1}`
    matId.add(id)
    const hex = matn(m.color_hex, "")
    const finish = matn(m.finish, "matte").toLowerCase()
    materials.push({
      id,
      name: matn(m.name, id),
      color_hex: /^#?[0-9a-f]{6}$/i.test(hex)
        ? `#${hex.replace("#", "").toLowerCase()}`
        : DEFAULT_MATERIAL.color_hex,
      finish: (FINISHES as readonly string[]).includes(finish) ? finish : "matte",
      roughness: clamp(son(m.roughness, 0.7), 0, 1),
      metalness: clamp(son(m.metalness, 0), 0, 1),
    })
  }
  if (!materials.length) {
    materials.push(DEFAULT_MATERIAL)
    matId.add(DEFAULT_MATERIAL.id)
  }
  const fallbackMat = materials[0].id

  const parts: BotPart[] = []
  const partId = new Set<string>()
  const xom = Array.isArray(raw.parts) ? raw.parts : []
  if (xom.length > MAX_PARTS)
    throw new SanitizeError(`qismlar juda ko'p (${xom.length} > ${MAX_PARTS})`)
  xom.forEach((p, i) => {
    if (!isObj(p)) return
    const c = vec(p.center)
    const s = vec(p.size)
    if (!c || !s) return
    let id = matn(p.id, `part_${i + 1}`)
    while (partId.has(id)) id = `${id}_${i + 1}`
    partId.add(id)
    const role = matn(p.role, "other")
    const shape = p.shape === "cylinder" ? "cylinder" : "box"
    const axis = p.axis === "x" || p.axis === "z" ? p.axis : "y"
    // Tutqich old yuzadan chiqib turadi (z < 0), qolgani quti ichida
    const minZ = role === "handle" ? -0.2 * D : 0
    const size: BotVec3 = {
      x: clamp(s.x, 0.1, W),
      y: clamp(s.y, 0.1, H),
      z: clamp(s.z, 0.1, D),
    }
    parts.push({
      id,
      role,
      shape,
      axis,
      material_id: matId.has(matn(p.material_id, "")) ? (p.material_id as string) : fallbackMat,
      center: { x: clamp(c.x, 0, W), y: clamp(c.y, 0, H), z: clamp(c.z, minZ, D) },
      size,
    })
  })
  if (!parts.length) throw new SanitizeError("qismlar ro'yxati bo'sh")

  return { units: "cm", bounding_box_cm: quti, materials, parts }
}
