# Telegram 3D viewer (Mini App)

Next.js app that renders the furniture model produced by `bot.py` in 3D.
The viewer itself (`src/components/Bazis/`) is a copy of the MebeliX MES
Bazis viewer (three.js scene, search, part card, view modes); it is kept
separate from MES and evolves on its own.

## How a model reaches the page

1. `bot.py` builds the result JSON, compresses it (`zlib`) and encodes it as
   base64url into the Mini App URL: `WEBAPP_URL?m=<payload>`.
2. The page decodes `?m=` (`src/lib/encode.ts`), converts the bot format to the
   viewer format (`src/lib/botModel.ts`) and renders it.
3. Without `?m=` the page shows a loader where the bot's JSON reply can be
   pasted or uploaded as a file.

Supported inputs: the bot's `AnalysisResult` (with `model_3d`), a bare
`model_3d` object, and a MES viewer model (`{"v": 2, "panels": [...]}`).

## Bot -> viewer mapping

| Bot (`model_3d`) | Viewer (`BazisModel`) |
| --- | --- |
| box part | panel with a rectangular outline, thickness = smallest side |
| cylinder part | panel with a 24-gon outline (`rd: 1`), thickness = length along `axis` |
| `center`/`size` in cm | mm; `Z = depth - z` so the front face points to +Z (camera side) |
| `units: "fraction"` | scaled by `dimensions_cm`/`estimated_dimensions_cm`, else 1 m |
| material `name`, `color_hex`, `finish` | one string: `oak veneer #8b5a2b wood` — color and finish are read from the name |
| bounding box | three dimension lines (`d`), toggled by the ruler button |

## Commands

```bash
npm install
npm run dev        # http://localhost:3000  (paste a bot JSON to test)
npm run typecheck
npm run build
```

Test a link locally: `python -c "import bot; print(bot.encode_model_param(open('furniture_model.json').read()))"`
from the bot folder, then open `http://localhost:3000/?m=<output>`.

## Deploy on Vercel

* Import the repository, set **Root Directory** to `webapp`. No environment
  variables are needed.
* Put the deployment URL into the bot's `.env` as `WEBAPP_URL=https://...`.
* In @BotFather, enable the Mini App (`/newapp` or Bot Settings -> Menu Button)
  pointing at the same URL. The bot attaches an inline "Open 3D viewer"
  `web_app` button to every result, so the menu button is optional.

## Limits

* The model travels inside the URL. A 30-part model compresses to roughly
  2-3 KB; Telegram accepts such button URLs, but if a URL is ever rejected
  the bot sends the result without the button and logs a warning.
* `DecompressionStream` is required (Chrome 80+, Safari 16.4+), which the
  Telegram web views on current Android/iOS provide.
