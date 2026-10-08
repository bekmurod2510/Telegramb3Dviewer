# Telegram Furniture 3D Model Bot

A Telegram bot that receives furniture photos, asks Google Gemini (AI Studio
API) to decompose the piece into simple 3D primitives using a Pydantic
response schema, asks the user for the real dimensions, and replies with a
scaled JSON model in a code block (or as a file when it is too long).

## How a conversation works

1. The user sends a photo (optionally with a caption).
2. Gemini identifies the furniture type and style, defines 1 to 5 materials,
   and splits the piece into 3 to 30 boxes and cylinders. Every part has a
   center and size expressed as fractions (0..1) of the overall bounding box.
3. If the caption already contains dimensions such as `200 x 60 x 220`, the
   final JSON is sent immediately with `dimensions_source: "user"`.
4. Otherwise the bot shows the estimate and asks for the real dimensions as
   `W x D x H` in cm. The user replies with the numbers, or sends `/skip` to
   keep the estimate (`dimensions_source: "estimated"`).
5. The bot scales all fractions to centimeters and sends the final JSON.
6. Dimensions may use `x`, `×`, `*` or Cyrillic `х` as separators and `,` as
   a decimal mark. If the text contains `mm`/`мм`, values are converted to cm.
7. A pending question expires after 10 minutes. Sending a new photo replaces
   the pending one. Photos that are not furniture are returned without a
   3D model or a dimensions question.

## Output format

```json
{
  "is_furniture": true,
  "furniture_type": "wardrobe",
  "description": "...",
  "style": "modern",
  "confidence": 0.8,
  "estimated_dimensions_cm": { "width_cm": 200, "depth_cm": 60, "height_cm": 220 },
  "dimensions_cm": { "width_cm": 200, "depth_cm": 60, "height_cm": 220 },
  "dimensions_source": "user",
  "model_3d": {
    "units": "cm",
    "axes": {
      "origin": "front-left-bottom corner of the bounding box",
      "x": "width, left to right",
      "y": "height, floor to top",
      "z": "depth, front to back"
    },
    "bounding_box_cm": { "width_cm": 200, "depth_cm": 60, "height_cm": 220 },
    "materials": [
      { "id": "white_mdf", "name": "white MDF", "color_hex": "#F2F2F2",
        "finish": "matte", "roughness": 0.8, "metalness": 0.0 }
    ],
    "parts": [
      { "id": "left_side_panel", "role": "side_panel", "shape": "box", "axis": "y",
        "material_id": "white_mdf",
        "center": { "x": 0.9, "y": 110, "z": 30 },
        "size": { "x": 1.8, "y": 220, "z": 60 } }
    ]
  }
}
```

`center` and `size` are in centimeters when `units` is `"cm"`, or fractions
of the bounding box when `units` is `"fraction"` (user skipped and Gemini
had no estimate). For cylinders, `axis` is the long direction and the two
other extents are the diameter. The bot clamps parts into the bounding box,
fixes unknown material ids and duplicate part ids, and falls back to a single
box when Gemini returns no parts.

## Setup

### 1. Create and activate a virtual environment

Windows (PowerShell):

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks the activation script, run this once and retry:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

macOS / Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

### 3. Configure environment variables

Windows (PowerShell):

```powershell
Copy-Item .env.example .env
```

macOS / Linux:

```bash
cp .env.example .env
```

Open `.env` and set:

- `TELEGRAM_BOT_TOKEN` from [@BotFather](https://t.me/BotFather) (send `/newbot`).
- `GEMINI_API_KEY` from <https://aistudio.google.com/apikey>.
- `GEMINI_MODEL` (optional) to override the default `gemini-3.5-flash`.
- `GEMINI_FALLBACK_MODEL` (optional) used when the primary model returns
  503/429 after retries. Defaults to `gemini-3.5-flash-lite`; set it to an
  empty value to disable the fallback.
- `GEMINI_THINKING_LEVEL` (optional) reasoning depth: `minimal`, `low`
  (default), `medium` or `high`. `minimal` is about 3x faster, `low` gives
  better geometry on complex pieces.
- `GEMINI_MAX_OUTPUT_TOKENS` (optional, default `32768`). Thinking tokens
  count against this budget. If Gemini still runs out, the bot retries once
  asking for at most 12 parts.

### 4. Start the bot

```bash
python bot.py
```

Open your bot in Telegram, send `/start`, then send a photo. Add a caption to
give the model extra instructions. Press `Ctrl+C` to stop.

## Files

- `bot.py` - bot logic, Pydantic schema, Gemini call.
- `requirements.txt` - Python dependencies.
- `.env.example` - template for required environment variables.
- `.gitignore` - keeps `.env` and the virtual environment out of git.

## Customizing the output

Edit the `ImageAnalysis` model in `bot.py`. Gemini supports nested models,
lists, `Literal` enums and `Optional` (nullable) fields.

## 3D viewer (Telegram Mini App)

`webapp/` is a Next.js app that renders the result in 3D (same viewer logic as
the MebeliX MES Bazis viewer, kept as a separate copy). Set `WEBAPP_URL` in
`.env` to the deployed HTTPS URL (Vercel, root directory `webapp`) and every
result gets an inline **Open 3D viewer** button; the model travels inside the
button URL (`?m=` = base64url of zlib-compressed JSON, see
`encode_model_param`). Without `WEBAPP_URL` the bot behaves as before.
See `webapp/README.md` for the bot -> viewer mapping and deployment steps.
