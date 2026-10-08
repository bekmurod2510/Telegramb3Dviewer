"""
Telegram bot that turns a furniture photo into an approximate 3D model description.

Flow:
    1. User sends a photo (or an image file), optionally with a caption.
    2. Gemini decomposes the furniture into simple primitives (boxes, cylinders).
       Positions and sizes are fractions of the overall bounding box, so the model
       can be scaled to any real dimensions later. The google-genai SDK
       base64-encodes the image bytes on the wire.
    3. If the caption contains dimensions ("200 x 60 x 220"), the final model is
       sent at once. Otherwise the bot shows Gemini's size estimate and asks for
       the real dimensions.
    4. The user replies "W x D x H" in centimeters, or /skip to keep the estimate.
    5. Fractions are scaled to centimeters and the final JSON is sent in a code
       block (or as a file when too long for one Telegram message).
"""

import base64
import html
import io
import json
import logging
import os
import re
import time
import zlib
from typing import Literal, Optional

from dotenv import load_dotenv
from google import genai
from google.genai import errors, types
from pydantic import BaseModel, Field, ValidationError
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Message, Update, WebAppInfo
from telegram.constants import ChatAction, ParseMode
from telegram.error import BadRequest
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

load_dotenv()  # Reads .env from the current directory into os.environ

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
# Used when the primary model is overloaded (HTTP 503/429) even after retries.
GEMINI_FALLBACK_MODEL = os.getenv("GEMINI_FALLBACK_MODEL", "gemini-3.5-flash-lite")

# Output budget. Thinking tokens count against it on Gemini 2.5+/3.x, so keep it large.
GEMINI_MAX_OUTPUT_TOKENS = int(os.getenv("GEMINI_MAX_OUTPUT_TOKENS", "32768"))
# Optional: HTTPS URL of the Mini App (webapp/ deployed on Vercel). When set, every
# result gets an inline "Open 3D viewer" button that renders the model in 3D.
WEBAPP_URL = os.getenv("WEBAPP_URL", "").strip().rstrip("/")
# How much the model may reason before answering: minimal, low, medium or high.
# minimal is ~3x faster; low is a good balance for geometry. Measured on a simple
# table: default 10.6s / 1717 thinking tokens, low 9.1s, minimal 3.7s.
GEMINI_THINKING_LEVEL = os.getenv("GEMINI_THINKING_LEVEL", "low").strip().lower()
GEMINI_THINKING_CONFIG = (
    types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL) if GEMINI_THINKING_LEVEL else None
)

# Retry transient Gemini errors with exponential backoff before giving up.
GEMINI_RETRY_OPTIONS = types.HttpRetryOptions(
    attempts=4,
    initial_delay=1.0,
    max_delay=8.0,
    http_status_codes=[429, 500, 502, 503, 504],
)

TELEGRAM_MAX_MESSAGE_CHARS = 4096
TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024  # Bot API download limit
PENDING_TTL_SECONDS = 10 * 60  # How long the bot waits for dimensions after a photo

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    level=logging.INFO,
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger("photo-bot")


# ---------------------------------------------------------------------------
# Gemini response schema (what the model fills in)
# ---------------------------------------------------------------------------
# All positions and sizes are FRACTIONS (0..1) of the overall bounding box:
#   x = width  (left -> right), y = height (floor -> top), z = depth (front -> back).
# This keeps the model independent of real-world size; the bot scales it to
# centimeters once the user confirms the dimensions.

FurnitureType = Literal[
    "wardrobe", "cabinet", "dresser", "shelf", "bookcase", "tv_stand", "table", "desk",
    "chair", "stool", "sofa", "armchair", "bed", "nightstand", "kitchen", "other",
]

PartRole = Literal[
    "body", "top", "bottom", "side_panel", "back_panel", "shelf", "divider",
    "door", "drawer_front", "handle", "leg", "plinth", "frame", "rail",
    "seat", "backrest", "armrest", "cushion", "mattress", "headboard", "footboard",
    "tabletop", "apron", "countertop", "other",
]

Finish = Literal["matte", "satin", "glossy", "wood", "fabric", "leather", "metal", "glass", "mirror"]


class Vec3(BaseModel):
    x: float = Field(description="Along the width, left to right.")
    y: float = Field(description="Along the height, floor to top.")
    z: float = Field(description="Along the depth, front to back.")


class Dimensions(BaseModel):
    width_cm: float = Field(description="Overall width in centimeters.")
    depth_cm: float = Field(description="Overall depth in centimeters.")
    height_cm: float = Field(description="Overall height in centimeters.")


class Material(BaseModel):
    id: str = Field(description="Short unique snake_case id, e.g. 'oak_veneer', 'white_mdf', 'steel'.")
    name: str = Field(description="Human readable name, e.g. 'oak veneer'.")
    color_hex: str = Field(description="Average visible color as #RRGGBB.")
    finish: Finish
    roughness: float = Field(description="0.0 (mirror-like) to 1.0 (fully matte).")
    metalness: float = Field(description="0.0 (non-metal) to 1.0 (metal).")


class Part(BaseModel):
    id: str = Field(description="Unique snake_case id, e.g. 'left_side_panel', 'leg_front_left'.")
    role: PartRole
    shape: Literal["box", "cylinder"]
    axis: Literal["x", "y", "z"] = Field(description="Cylinder axis direction. Use 'y' for boxes.")
    center: Vec3 = Field(description="Center of the part as fractions 0..1 of the bounding box.")
    size: Vec3 = Field(
        description=(
            "Extents as fractions 0..1 of the overall width, height and depth. "
            "For cylinders the two extents perpendicular to the axis are the diameter."
        )
    )
    material_id: str = Field(description="Must match an id in materials.")


class FurnitureModel(BaseModel):
    is_furniture: bool = Field(description="True if the main subject is a piece of furniture.")
    furniture_type: FurnitureType = Field(description="Use 'other' if unclear or not furniture.")
    description: str = Field(description="One or two sentences describing the piece.")
    style: str = Field(description="Design style, e.g. 'modern', 'classic', 'loft', 'minimalist'.")
    estimated_dimensions_cm: Optional[Dimensions] = Field(
        description=(
            "Best estimate of the overall width x depth x height in centimeters, from visible "
            "context and typical proportions. Null if not furniture."
        )
    )
    materials: list[Material] = Field(description="1 to 5 materials used by the parts.")
    parts: list[Part] = Field(description="3 to 24 primitives that approximate the piece.")
    confidence: float = Field(description="Overall confidence between 0.0 and 1.0.")


SYSTEM_PROMPT = """You convert a photo of a piece of furniture into an approximate 3D model built from simple primitives (boxes and cylinders). The output is used to render the piece in a 3D viewer, so geometry matters more than prose.

COORDINATE SYSTEM
The furniture sits inside its overall bounding box. x runs along the WIDTH from the left face (0) to the right face (1). y runs along the HEIGHT from the floor (0) to the top (1). z runs along the DEPTH from the front face (0) to the back face (1). Every part's center and size are fractions of that bounding box, so the same model can later be scaled to any real width, depth and height.

RULES
1. Decompose the piece into 3 to 24 parts. Keep ids short. Prefer boxes. Use cylinders only for round legs, rods, tubes or round tabletops. Set axis to the cylinder's long direction; use "y" for boxes.
2. List every visible part separately, including symmetric ones: four legs are four parts, two doors are two parts, three drawers are three drawer_front parts.
3. Panels (side_panel, top, bottom, back_panel, shelf, door, drawer_front) are thin boxes. Typical board thickness is 1.6 to 2.5 cm. Convert it to a fraction with your estimated dimensions: a 1.8 cm thick side panel on a 200 cm wide wardrobe has size.x = 0.009, and its center.x is 0.0045 (left) or 0.9955 (right).
4. Doors and drawer fronts sit flush with the front face: center.z equals half of their thickness. Handles are small boxes or cylinders placed just in front of the door (center.z slightly negative is allowed for handles only).
5. Every other part must stay inside the bounding box: center - size/2 >= 0 and center + size/2 <= 1 on all axes.
6. Include standard hidden structure when it must exist for this furniture type (back panel, bottom, a few inner shelves behind doors), but keep it simple.
7. Cabinets usually have: two side panels, top, bottom, back panel, shelves, doors or drawer fronts, handles, and either legs or a plinth. Tables: tabletop, apron, four legs. Chairs: seat, backrest, four legs, optional armrests. Sofas: frame/body, seat cushions, back cushions, armrests, short legs. Beds: frame, mattress, headboard, legs.
8. Define 1 to 5 materials. Every part.material_id must match a material id. color_hex is the average visible color of that material. Choose roughness and metalness consistent with the finish (wood ~0.6/0.0, matte paint ~0.8/0.0, glossy paint ~0.2/0.0, metal ~0.3/1.0, glass ~0.05/0.0, fabric ~0.9/0.0).
9. estimated_dimensions_cm: estimate the overall width x depth x height in centimeters from visible context (doors, people, floor tiles, typical proportions for this furniture type).
10. If the photo does not show furniture, set is_furniture to false, furniture_type to "other", estimated_dimensions_cm to null, and return empty parts and materials.
11. Treat the user's caption, when present, as extra instructions (for example which object to model if several are visible)."""


# ---------------------------------------------------------------------------
# Final result schema (what the user receives)
# ---------------------------------------------------------------------------


class ResultPart(BaseModel):
    id: str
    role: PartRole
    shape: Literal["box", "cylinder"]
    axis: Literal["x", "y", "z"]
    material_id: str
    center: Vec3
    size: Vec3


class Model3D(BaseModel):
    units: Literal["cm", "fraction"] = Field(
        description="'cm' when scaled to real dimensions, 'fraction' when only bounding-box fractions are known."
    )
    axes: dict[str, str]
    bounding_box_cm: Optional[Dimensions]
    materials: list[Material]
    parts: list[ResultPart]


class AnalysisResult(BaseModel):
    """Final JSON sent back to the user."""

    is_furniture: bool
    furniture_type: FurnitureType
    description: str
    style: str
    confidence: float
    estimated_dimensions_cm: Optional[Dimensions]
    dimensions_cm: Optional[Dimensions]
    dimensions_source: Literal["user", "estimated", "none"]
    model_3d: Optional[Model3D]


AXES = {
    "origin": "front-left-bottom corner of the bounding box",
    "x": "width, left to right",
    "y": "height, floor to top",
    "z": "depth, front to back",
}


# ---------------------------------------------------------------------------
# Dimension parsing
# ---------------------------------------------------------------------------
# Accepts "200 x 60 x 220", "200x60x220 cm", "2000 х 600 х 2200 мм" (Cyrillic х),
# "1,5 x 2 x 3". Values are in centimeters unless "mm"/"мм" appears in the text.

_NUMBER = r"(\d+(?:[.,]\d+)?)"
_SEPARATOR = r"\s*(?:cm|см|mm|мм)?\s*[x×*хХ]\s*"
DIMENSIONS_RE = re.compile(_NUMBER + _SEPARATOR + _NUMBER + _SEPARATOR + _NUMBER, re.IGNORECASE)
MILLIMETERS_RE = re.compile(r"\b(?:mm|мм)\b", re.IGNORECASE)
# Largest dimension (cm) accepted without a unit; anything bigger is read as mm.
MAX_CM_WITHOUT_UNIT = 500
# ...unless one value is small: "600 x 60 x 220" is a 6 m kitchen in cm, not 60 x 6 x 22.
MIN_MM_VALUE = 100


def parse_dimensions(text: Optional[str]) -> Optional[Dimensions]:
    """Extract W x D x H from free text. Returns None if no dimensions are found."""
    if not text:
        return None
    match = DIMENSIONS_RE.search(text)
    if match is None:
        return None
    values = [float(raw.replace(",", ".")) for raw in match.groups()]
    # Explicit "mm", or numbers that only make sense in millimeters: no piece of
    # furniture is 20 m wide, so "2000 x 600 x 2200" means mm even without a unit.
    if MILLIMETERS_RE.search(text) or (max(values) > MAX_CM_WITHOUT_UNIT and min(values) >= MIN_MM_VALUE):
        values = [value / 10 for value in values]
    if any(value <= 0 for value in values):
        return None
    width, depth, height = values
    return Dimensions(width_cm=width, depth_cm=depth, height_cm=height)


def format_dimensions(dims: Dimensions) -> str:
    return f"{dims.width_cm:g} × {dims.depth_cm:g} × {dims.height_cm:g} cm (W × D × H)"


# ---------------------------------------------------------------------------
# Model clean-up and scaling
# ---------------------------------------------------------------------------

DEFAULT_MATERIAL = Material(
    id="default", name="unknown", color_hex="#B0B0B0", finish="matte", roughness=0.8, metalness=0.0
)


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def sanitize_model(model: FurnitureModel) -> FurnitureModel:
    """Fix small inconsistencies so the viewer never receives broken geometry."""
    if not model.is_furniture:
        return model

    materials = list(model.materials) or [DEFAULT_MATERIAL]
    material_ids = {material.id for material in materials}
    fallback_material = materials[0].id

    parts: list[Part] = []
    seen_ids: set[str] = set()
    for index, part in enumerate(model.parts):
        part_id = part.id or f"part_{index + 1}"
        while part_id in seen_ids:
            part_id = f"{part_id}_{index + 1}"
        seen_ids.add(part_id)

        min_z = -0.2 if part.role == "handle" else 0.0
        parts.append(
            Part(
                id=part_id,
                role=part.role,
                shape=part.shape,
                axis=part.axis,
                center=Vec3(
                    x=_clamp(part.center.x, 0.0, 1.0),
                    y=_clamp(part.center.y, 0.0, 1.0),
                    z=_clamp(part.center.z, min_z, 1.0),
                ),
                size=Vec3(
                    x=_clamp(part.size.x, 0.001, 1.0),
                    y=_clamp(part.size.y, 0.001, 1.0),
                    z=_clamp(part.size.z, 0.001, 1.0),
                ),
                material_id=part.material_id if part.material_id in material_ids else fallback_material,
            )
        )

    if not parts:  # Gemini saw furniture but gave no parts: fall back to one solid block.
        parts.append(
            Part(
                id="body", role="body", shape="box", axis="y",
                center=Vec3(x=0.5, y=0.5, z=0.5), size=Vec3(x=1.0, y=1.0, z=1.0),
                material_id=fallback_material,
            )
        )

    return model.model_copy(update={"materials": materials, "parts": parts})


def build_model_3d(model: FurnitureModel, dims: Optional[Dimensions]) -> Model3D:
    """Scale bounding-box fractions to centimeters when real dimensions are known."""
    parts: list[ResultPart] = []
    for part in model.parts:
        if dims is None:
            center, size = part.center, part.size
        else:
            center = Vec3(
                x=round(part.center.x * dims.width_cm, 2),
                y=round(part.center.y * dims.height_cm, 2),
                z=round(part.center.z * dims.depth_cm, 2),
            )
            size = Vec3(
                x=round(part.size.x * dims.width_cm, 2),
                y=round(part.size.y * dims.height_cm, 2),
                z=round(part.size.z * dims.depth_cm, 2),
            )
        parts.append(
            ResultPart(
                id=part.id, role=part.role, shape=part.shape, axis=part.axis,
                material_id=part.material_id, center=center, size=size,
            )
        )
    return Model3D(
        units="cm" if dims is not None else "fraction",
        axes=AXES,
        bounding_box_cm=dims,
        materials=model.materials,
        parts=parts,
    )


def build_result(
    model: FurnitureModel,
    dims: Optional[Dimensions],
    source: Literal["user", "estimated", "none"],
) -> AnalysisResult:
    return AnalysisResult(
        is_furniture=model.is_furniture,
        furniture_type=model.furniture_type,
        description=model.description,
        style=model.style,
        confidence=model.confidence,
        estimated_dimensions_cm=model.estimated_dimensions_cm,
        dimensions_cm=dims,
        dimensions_source=source,
        model_3d=build_model_3d(model, dims) if model.is_furniture else None,
    )


# ---------------------------------------------------------------------------
# Gemini call
# ---------------------------------------------------------------------------


class BadModelOutput(RuntimeError):
    """Gemini answered, but the JSON was cut off (MAX_TOKENS) or did not validate."""


FEWER_PARTS_HINT = "Use at most 12 parts and very short ids."


def is_overloaded_error(exc: BaseException) -> bool:
    """True for Gemini errors caused by load: 5xx or 429 (rate limit)."""
    if isinstance(exc, errors.ServerError):
        return True
    return isinstance(exc, errors.ClientError) and exc.code == 429


async def analyze_image(
    client: genai.Client,
    image_bytes: bytes,
    mime_type: str,
    user_hint: Optional[str] = None,
) -> FurnitureModel:
    """Send an image to Gemini and return a validated, sanitized FurnitureModel.

    Tries the primary model first (with the client's built-in retries), then the
    fallback model if the primary one is overloaded.
    """
    models = [GEMINI_MODEL]
    if GEMINI_FALLBACK_MODEL and GEMINI_FALLBACK_MODEL != GEMINI_MODEL:
        models.append(GEMINI_FALLBACK_MODEL)

    for index, model in enumerate(models):
        try:
            try:
                raw_model = await _generate_analysis(client, model, image_bytes, mime_type, user_hint)
            except BadModelOutput as exc:
                # Usually a very detailed piece that overflowed the output budget: ask for less.
                logger.warning("Bad output from %s (%s); retrying with fewer parts", model, exc)
                retry_hint = f"{user_hint} {FEWER_PARTS_HINT}" if user_hint else FEWER_PARTS_HINT
                raw_model = await _generate_analysis(client, model, image_bytes, mime_type, retry_hint)
            return sanitize_model(raw_model)
        except errors.APIError as exc:
            is_last = index == len(models) - 1
            if is_last or not is_overloaded_error(exc):
                raise
            logger.warning("Model %s overloaded (%s); falling back to %s", model, exc.code, models[index + 1])

    raise RuntimeError("No Gemini model configured.")  # unreachable, keeps type checkers happy


async def _generate_analysis(
    client: genai.Client,
    model: str,
    image_bytes: bytes,
    mime_type: str,
    user_hint: Optional[str],
) -> FurnitureModel:
    response = await client.aio.models.generate_content(
        model=model,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
            user_hint or "Build the 3D model of the furniture in this photo.",
        ],
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=FurnitureModel,
            # Thinking tokens count against this budget on Gemini 2.5+/3.x models,
            # so keep it generous or long part lists get cut off mid-JSON.
            max_output_tokens=GEMINI_MAX_OUTPUT_TOKENS,
            temperature=0.2,
            thinking_config=GEMINI_THINKING_CONFIG,
            # No tools are used, so turn off automatic function calling (silences SDK warning).
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        ),
    )

    candidate = response.candidates[0] if response.candidates else None
    if candidate is not None and candidate.finish_reason == types.FinishReason.MAX_TOKENS:
        raise BadModelOutput("output cut off by MAX_TOKENS")

    # The SDK fills `parsed` with a model instance when a Pydantic schema is used.
    parsed = response.parsed
    if isinstance(parsed, FurnitureModel):
        return parsed

    # Fallback: validate the raw JSON text ourselves (also catches blocked output).
    raw = response.text
    if not raw:
        reason = None
        if response.prompt_feedback and response.prompt_feedback.block_reason:
            reason = response.prompt_feedback.block_reason.name
        elif candidate is not None and candidate.finish_reason:
            reason = candidate.finish_reason.name
        raise RuntimeError(f"Gemini returned no output (reason: {reason or 'unknown'}).")
    try:
        return FurnitureModel.model_validate_json(raw)
    except ValidationError as exc:
        raise BadModelOutput(f"invalid JSON ({exc.error_count()} errors)") from exc


# ---------------------------------------------------------------------------
# Pending-state helpers (one analysis waiting for dimensions per user)
# ---------------------------------------------------------------------------


def set_pending(context: ContextTypes.DEFAULT_TYPE, model: FurnitureModel) -> None:
    context.user_data["pending"] = {"model": model, "created_at": time.monotonic()}


def pop_pending(context: ContextTypes.DEFAULT_TYPE) -> Optional[FurnitureModel]:
    """Return and clear the pending model, or None if there is none or it expired."""
    pending = context.user_data.pop("pending", None)
    if pending is None:
        return None
    if time.monotonic() - pending["created_at"] > PENDING_TTL_SECONDS:
        return None
    return pending["model"]


def peek_pending(context: ContextTypes.DEFAULT_TYPE) -> Optional[FurnitureModel]:
    model = pop_pending(context)
    if model is not None:
        set_pending(context, model)
    return model


# ---------------------------------------------------------------------------
# Telegram helpers
# ---------------------------------------------------------------------------


def summarize(result: AnalysisResult) -> str:
    bits = [result.furniture_type.replace("_", " ")]
    if result.dimensions_cm is not None:
        bits.append(format_dimensions(result.dimensions_cm))
    if result.model_3d is not None:
        bits.append(f"{len(result.model_3d.parts)} parts, {len(result.model_3d.materials)} materials")
    return " · ".join(bits)


def encode_model_param(payload: str) -> str:
    """Compress the result JSON for the Mini App URL (`webapp/src/lib/encode.ts` decodes it)."""
    raw = zlib.compress(payload.encode("utf-8"), 9)
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def webapp_markup(result: AnalysisResult) -> Optional[InlineKeyboardMarkup]:
    """Inline button that opens the Mini App with the model embedded in the URL."""
    if not WEBAPP_URL or result.model_3d is None:
        return None
    compact = json.dumps(result.model_dump(), separators=(",", ":"), ensure_ascii=False)
    url = f"{WEBAPP_URL}/?m={encode_model_param(compact)}"
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("Open 3D viewer", web_app=WebAppInfo(url=url))]]
    )


async def reply_with_json(
    message: Message,
    payload: str,
    summary: str,
    reply_markup: Optional[InlineKeyboardMarkup] = None,
) -> None:
    """Reply with JSON in a code block, or as a file if it exceeds the Telegram limit.

    `reply_markup` carries the Mini App button. If Telegram rejects the markup (for
    example a URL that is too long), the reply is sent again without the button.
    """
    body = f'<pre><code class="language-json">{html.escape(payload, quote=False)}</code></pre>'

    async def send(markup: Optional[InlineKeyboardMarkup]) -> None:
        if len(body) <= TELEGRAM_MAX_MESSAGE_CHARS:
            await message.reply_text(body, parse_mode=ParseMode.HTML, reply_markup=markup)
            return
        await message.reply_document(
            document=io.BytesIO(payload.encode("utf-8")),
            filename="furniture_model.json",
            caption=f"{summary}\nThe JSON is too long for one message, so it is attached as a file.",
            reply_markup=markup,
        )

    try:
        await send(reply_markup)
    except BadRequest as exc:
        if reply_markup is None:
            raise
        logger.warning("Telegram rejected the Mini App button (%s); sending without it", exc)
        await send(None)


async def send_result(
    message: Message,
    model: FurnitureModel,
    dims: Optional[Dimensions],
    source: Literal["user", "estimated", "none"],
) -> None:
    result = build_result(model, dims, source)
    payload = json.dumps(result.model_dump(), indent=2, ensure_ascii=False)
    await reply_with_json(message, payload, summarize(result), webapp_markup(result))
    logger.info(
        "Result sent to chat %s: type=%s, dimensions=%s, source=%s, parts=%d",
        message.chat_id,
        model.furniture_type,
        format_dimensions(dims) if dims else None,
        source,
        len(model.parts),
    )


async def ask_for_dimensions(message: Message, model: FurnitureModel) -> None:
    estimate = model.estimated_dimensions_cm
    lines = [
        f"Looks like a <b>{html.escape(model.furniture_type.replace('_', ' '))}</b> "
        f"({len(model.parts)} parts, {len(model.materials)} materials)."
    ]
    if estimate is not None:
        lines.append(f"Estimated size: <b>{html.escape(format_dimensions(estimate))}</b>.")
    lines.append(
        "Send the real dimensions in cm as <code>W x D x H</code>, "
        "for example <code>200 x 60 x 220</code>."
    )
    lines.append(
        "Or send /skip to " + ("use the estimate." if estimate else "get the unscaled model.")
    )
    await message.reply_text("\n".join(lines), parse_mode=ParseMode.HTML)


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.effective_message.reply_text(
        "Send me a photo of a piece of furniture. I will build an approximate 3D model "
        "description with Gemini, ask for the real dimensions, and reply with JSON.\n\n"
        "Tip: put the dimensions in the photo caption as W x D x H in cm "
        "(for example 200 x 60 x 220) to skip the question."
    )


async def skip(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    model = pop_pending(context)
    if model is None:
        await message.reply_text("Nothing to skip. Send a photo first.")
        return
    estimate = model.estimated_dimensions_cm
    await send_result(message, model, estimate, "estimated" if estimate else "none")


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    if peek_pending(context) is None:
        await message.reply_text("Please send a photo of the furniture to model.")
        return

    dims = parse_dimensions(message.text)
    if dims is None:
        await message.reply_text(
            "I could not read the dimensions. Send them as W x D x H in cm, "
            "for example 200 x 60 x 220, or send /skip."
        )
        return

    model = pop_pending(context)
    if model is None:  # expired between peek and pop; practically never happens
        await message.reply_text("That photo expired. Please send it again.")
        return
    await send_result(message, model, dims, "user")


async def handle_image(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    if message is None:
        return

    if message.photo:
        # photo[-1] is the largest size Telegram provides; photos are always JPEG.
        tg_file = await message.photo[-1].get_file()
        mime_type = "image/jpeg"
    elif message.document and (message.document.mime_type or "").startswith("image/"):
        if (message.document.file_size or 0) > TELEGRAM_MAX_DOWNLOAD_BYTES:
            await message.reply_text("That file is larger than 20 MB, which bots cannot download.")
            return
        tg_file = await message.document.get_file()
        mime_type = message.document.mime_type
    else:
        return

    # A new photo replaces any model still waiting for dimensions.
    context.user_data.pop("pending", None)

    await message.chat.send_action(ChatAction.TYPING)
    status = await message.reply_text("Building the 3D model...")

    try:
        image_bytes = bytes(await tg_file.download_as_bytearray())
        client: genai.Client = context.bot_data["gemini_client"]
        model = await analyze_image(client, image_bytes, mime_type, message.caption)

        caption_dims = parse_dimensions(message.caption)
        if caption_dims is not None:
            await send_result(message, model, caption_dims, "user")
        elif not model.is_furniture:
            await send_result(message, model, None, "none")
        else:
            set_pending(context, model)
            await ask_for_dimensions(message, model)
    except Exception as exc:  # noqa: BLE001 - report any failure back to the user
        logger.exception("Image analysis failed")
        if is_overloaded_error(exc):
            await message.reply_text(
                "Gemini is overloaded right now. Please send the photo again in a minute."
            )
        else:
            await message.reply_text(f"Sorry, something went wrong: {exc}")
    finally:
        try:
            await status.delete()
        except Exception:  # noqa: BLE001 - status cleanup is best-effort
            pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    missing = [
        name
        for name, value in (
            ("TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN),
            ("GEMINI_API_KEY", GEMINI_API_KEY),
        )
        if not value
    ]
    if missing:
        raise SystemExit(
            f"Missing environment variables: {', '.join(missing)}. "
            "Copy .env.example to .env and fill in the values."
        )

    application = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    application.bot_data["gemini_client"] = genai.Client(
        api_key=GEMINI_API_KEY,
        http_options=types.HttpOptions(retry_options=GEMINI_RETRY_OPTIONS),
    )

    application.add_handler(CommandHandler(["start", "help"], start))
    application.add_handler(CommandHandler("skip", skip))
    application.add_handler(MessageHandler(filters.PHOTO | filters.Document.IMAGE, handle_image))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    logger.info(
        "Bot is running with model %s (fallback %s). Press Ctrl+C to stop.",
        GEMINI_MODEL,
        GEMINI_FALLBACK_MODEL or "none",
    )
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
