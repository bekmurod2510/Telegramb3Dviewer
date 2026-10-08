/** `POST /api/edit` — modelni matnli so'rov bilan o'zgartirish.
 *
 * Kirish: `{ model_3d, instruction, context? }` (sm li bot modeli).
 * Chiqish: `{ model_3d, note, model }`. Xato: `{ error }` o'zbekcha.
 *
 * Hozircha autentifikatsiya yo'q (login keyin): so'rov uzunligi va qismlar
 * soni cheklangan, Gemini kaliti faqat serverda.
 */

import { NextResponse } from "next/server"
import { EditError, editModel } from "@/lib/gemini"
import { SanitizeError, sanitizeModel3D } from "@/lib/sanitize"

export const runtime = "nodejs"
/** Gemini 13 qismli modelda 5-20 s; Vercel sukutdagi 10 s dan uzun */
export const maxDuration = 60

const MAX_INSTRUCTION = 400

const xato = (status: number, error: string) =>
  NextResponse.json({ error }, { status })

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return xato(400, "JSON kutilgan edi")
  }
  if (typeof body !== "object" || body === null) return xato(400, "So'rov buzuq")
  const b = body as Record<string, unknown>

  const instruction = typeof b.instruction === "string" ? b.instruction.trim() : ""
  if (instruction.length < 2) return xato(400, "Nimani o'zgartirish kerakligini yozing")
  if (instruction.length > MAX_INSTRUCTION)
    return xato(400, `So'rov juda uzun (${instruction.length} > ${MAX_INSTRUCTION} belgi)`)

  let model_3d: ReturnType<typeof sanitizeModel3D>
  try {
    model_3d = sanitizeModel3D(b.model_3d)
  } catch (e) {
    return xato(400, e instanceof SanitizeError ? `Model buzuq: ${e.message}` : "Model buzuq")
  }

  const c = typeof b.context === "object" && b.context !== null ? (b.context as Record<string, unknown>) : {}
  const matn = (v: unknown) => (typeof v === "string" ? v.slice(0, 300) : undefined)

  try {
    const out = await editModel({
      model_3d,
      instruction,
      context: {
        furniture_type: matn(c.furniture_type),
        description: matn(c.description),
        style: matn(c.style),
      },
    })
    return NextResponse.json(out)
  } catch (e) {
    if (e instanceof EditError) {
      console.error("edit failed:", e.status, e.message)
      return xato(e.status >= 500 || e.status === 429 ? 502 : e.status, e.message)
    }
    console.error("edit failed:", e)
    return xato(502, "O'zgartirish bajarilmadi — qayta urinib ko'ring")
  }
}
