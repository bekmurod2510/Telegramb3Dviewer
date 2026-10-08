/** Modelni matnli so'rov bilan o'zgartirish — Gemini (server tomonida).
 *
 * `bot.py: analyze_image` bilan bir xil sozlamalar (`GEMINI_MODEL`,
 * `GEMINI_FALLBACK_MODEL`, `GEMINI_THINKING_LEVEL`, `GEMINI_MAX_OUTPUT_TOKENS`),
 * lekin SDK siz — REST `generateContent`. Kirish: joriy `model_3d` (sm) va
 * foydalanuvchi so'rovi («surma eshiklar»); chiqish: TO'LIQ yangi `model_3d`
 * va bir gaplik `note`. Javob `sanitizeModel3D` dan o'tadi.
 */

import type { BotModel3D } from "./botModel"
import { FINISHES, SanitizeError, sanitizeModel3D } from "./sanitize"

const API = "https://generativelanguage.googleapis.com/v1beta/models"

export class EditError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export type EditInput = {
  model_3d: BotModel3D
  instruction: string
  context?: { furniture_type?: string; description?: string; style?: string }
}
export type EditOutput = { model_3d: BotModel3D; note: string; model: string }

const SYSTEM_PROMPT = `You edit an existing 3D model of a piece of furniture. The model is a list of simple primitives (boxes and cylinders). You receive the current model as JSON and a change request written by the user, and you return the FULL updated model in the same JSON format plus a one-sentence note.

COORDINATE SYSTEM (centimeters)
The furniture sits inside its bounding box (bounding_box_cm: width W, depth D, height H). x runs along the WIDTH from the left face (0) to the right face (W). y runs along the HEIGHT from the floor (0) to the top (H). z runs along the DEPTH from the front face (0) to the back face (D). Every part has a center and a size in centimeters. For cylinders, axis is the long direction and the two sizes perpendicular to it are the diameter.

RULES
1. Apply ONLY the requested change. Keep every other part identical: same ids, same materials, same positions and sizes. Do not re-model the whole piece.
2. Keep ids short snake_case and unique. New parts get new ids; removed parts are simply omitted.
3. Panels are thin boxes: board thickness 1.6 to 2.5 cm. Doors and drawer fronts sit flush with the front face (center.z = half of their thickness). Handles are small boxes or cylinders just in front of the door (center.z slightly negative is allowed for handles only). Everything else stays inside the bounding box.
4. If the request changes the overall size (for example "make it 180 cm wide"), update bounding_box_cm and move/scale the affected parts so the structure stays consistent (side panels at the edges, top and bottom spanning the width, doors filling the opening).
5. Materials: 1 to 5. Every part.material_id must match a material id. When the user asks for a new color or material, change the material entry (color_hex, name, finish, roughness, metalness) or add a new one and reference it.
6. Common requests:
   - sliding doors: replace hinged doors with sliding leaves that overlap by 3 to 6 cm; put them in two front planes (one leaf with center.z about 1 cm, the other about 3 cm, each 1.8 cm thick), full opening height, remove hinge-side handles and use vertical bar handles at the inner edges of each leaf; keep the carcass unchanged.
   - more/fewer shelves or drawers: distribute them evenly in the available height.
   - remove legs: replace with a plinth (a box across the width, 8 to 10 cm high, set back about 3 cm from the front).
   - add a mirror: a glass/mirror material on a door front or a thin box.
7. If the request is unclear, impossible for this piece, or not about the furniture, return the model UNCHANGED and explain why in the note.
8. note: one short sentence saying what changed, written in the SAME language the CHANGE REQUEST text is written in (English request -> English note, Uzbek -> Uzbek, Russian -> Russian). Never use another language.`

/** Gemini `responseSchema` (OpenAPI kichik to'plami) — chiqish shu shaklda */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    note: { type: "string" },
    model_3d: {
      type: "object",
      properties: {
        units: { type: "string", enum: ["cm"] },
        bounding_box_cm: {
          type: "object",
          properties: {
            width_cm: { type: "number" },
            depth_cm: { type: "number" },
            height_cm: { type: "number" },
          },
          required: ["width_cm", "depth_cm", "height_cm"],
        },
        materials: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              color_hex: { type: "string" },
              finish: { type: "string", enum: [...FINISHES] },
              roughness: { type: "number" },
              metalness: { type: "number" },
            },
            required: ["id", "name", "color_hex", "finish", "roughness", "metalness"],
          },
        },
        parts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              role: { type: "string" },
              shape: { type: "string", enum: ["box", "cylinder"] },
              axis: { type: "string", enum: ["x", "y", "z"] },
              material_id: { type: "string" },
              center: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                  z: { type: "number" },
                },
                required: ["x", "y", "z"],
              },
              size: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                  z: { type: "number" },
                },
                required: ["x", "y", "z"],
              },
            },
            required: ["id", "role", "shape", "axis", "material_id", "center", "size"],
          },
        },
      },
      required: ["units", "bounding_box_cm", "materials", "parts"],
    },
  },
  required: ["note", "model_3d"],
}

const env = (nom: string, d: string) => (process.env[nom] ?? d).trim()

/** Yuklama xatosi — 429 yoki 5xx: zaxira modelga o'tiladi (`bot.py: is_overloaded_error`) */
const yuklama = (status: number) => status === 429 || status >= 500

type GeminiResponse = {
  candidates?: {
    finishReason?: string
    content?: { parts?: { text?: string }[] }
  }[]
  promptFeedback?: { blockReason?: string }
}

async function generate(model: string, key: string, input: EditInput): Promise<EditOutput> {
  const ctx = input.context ?? {}
  const sarlavha = [ctx.furniture_type, ctx.style, ctx.description]
    .filter(Boolean)
    .join(" · ")
  const prompt =
    `${sarlavha ? `FURNITURE: ${sarlavha}\n\n` : ""}` +
    `CURRENT MODEL (JSON, centimeters):\n${JSON.stringify(input.model_3d)}\n\n` +
    `CHANGE REQUEST:\n${input.instruction}`

  const level = env("GEMINI_THINKING_LEVEL", "low").toUpperCase()
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      // Fikrlash tokenlari ham shu byudjetga kiradi (Gemini 2.5+/3.x)
      maxOutputTokens: Number(env("GEMINI_MAX_OUTPUT_TOKENS", "32768")) || 32768,
      temperature: 0.2,
      ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}),
    },
  }

  const res = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = (await res.text()).slice(0, 300)
    throw new EditError(res.status, `Gemini ${res.status}: ${t}`)
  }
  const data = (await res.json()) as GeminiResponse
  const cand = data.candidates?.[0]
  if (cand?.finishReason === "MAX_TOKENS")
    throw new EditError(502, "Javob kesilib qoldi (MAX_TOKENS) — so'rovni soddalashtiring")
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("")
  if (!text) {
    const sabab = data.promptFeedback?.blockReason ?? cand?.finishReason ?? "unknown"
    throw new EditError(502, `Gemini javob bermadi (${sabab})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new EditError(502, "Gemini JSON emas qaytardi")
  }
  const obj = parsed as { note?: unknown; model_3d?: unknown }
  try {
    return {
      model_3d: sanitizeModel3D(obj.model_3d),
      note: typeof obj.note === "string" ? obj.note.trim() : "",
      model,
    }
  } catch (e) {
    if (e instanceof SanitizeError) throw new EditError(502, `Gemini modeli buzuq: ${e.message}`)
    throw e
  }
}

export async function editModel(input: EditInput): Promise<EditOutput> {
  const key = env("GEMINI_API_KEY", "")
  if (!key) throw new EditError(503, "Serverda GEMINI_API_KEY sozlanmagan")
  const asosiy = env("GEMINI_MODEL", "gemini-3.5-flash")
  const zaxira = env("GEMINI_FALLBACK_MODEL", "gemini-3.5-flash-lite")
  const models = zaxira && zaxira !== asosiy ? [asosiy, zaxira] : [asosiy]
  for (let i = 0; i < models.length; i++) {
    try {
      return await generate(models[i], key, input)
    } catch (e) {
      const oxirgi = i === models.length - 1
      if (oxirgi || !(e instanceof EditError) || !yuklama(e.status)) throw e
      console.warn(`Model ${models[i]} overloaded (${e.status}); falling back to ${models[i + 1]}`)
    }
  }
  throw new EditError(503, "Gemini modeli sozlanmagan")
}
