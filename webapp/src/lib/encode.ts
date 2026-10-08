/** Havoladagi model parametri: `?m=<base64url(zlib(json))>`.
 *
 * Botdagi `bot.py: encode_model_param` ning teskarisi — `zlib.compress` chiqishi
 * (RFC 1950 o'rami), brauzerda `DecompressionStream("deflate")` aynan shuni
 * ochadi. Sinov uchun xom JSON (`{` bilan boshlanadi) ham qabul qilinadi.
 */

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4))
  const bin = atob(b64 + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function decodeModelParam(param: string): Promise<unknown> {
  const t = param.trim()
  if (t.startsWith("{")) return JSON.parse(t)
  const bytes = b64urlToBytes(t)
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"))
  const text = await new Response(stream).text()
  return JSON.parse(text)
}

/** `m` parametri — avval query (`?m=`), keyin hash (`#m=`). Telegram o'z
 * `tgWebApp*` parametrlarini hash'ga qo'shadi, shuning uchun hash
 * `URLSearchParams` bilan o'qiladi: `#m=...&tgWebAppData=...` ham ishlaydi. */
export const modelParamFromLocation = (loc: Location): string | null => {
  const q = new URLSearchParams(loc.search).get("m")
  if (q) return q
  const h = new URLSearchParams(loc.hash.replace(/^#/, "")).get("m")
  return h || null
}
