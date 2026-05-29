/**
 * Telegram callback-data short identifier for ModelId.
 *
 * Telegram's `callback_data` has a hard 64-byte limit, so we can't send the
 * full model id. The previous scheme (`modelId.split("-")[1]`) collapsed
 * every opus row onto the literal `"opus"`, which means a roster with two
 * or more opus selections silently routed the user's pick to whichever opus
 * the AVAILABLE_MODELS array listed first. Encoding the array index as a
 * decimal string fixes that without growing the payload meaningfully.
 *
 * Stability: indices are stable as long as AVAILABLE_MODELS entries are
 * append-only (or in-place renames). Reorders or deletions invalidate
 * outstanding keyboards. That's the same constraint the literal-encoding
 * scheme had, just expressed honestly.
 */
import { AVAILABLE_MODELS, type ModelId } from "../config/model";

/** Encode a ModelId as the AVAILABLE_MODELS index string (e.g. "0", "3"). */
export function encodeModelId(model: ModelId): string {
  const idx = AVAILABLE_MODELS.indexOf(model);
  // ModelId is a literal union over AVAILABLE_MODELS — any runtime value
  // typed as ModelId must be present in the array. A −1 here would be a
  // contract bug; surface it loudly rather than rendering "model:model::-1".
  if (idx < 0) {
    throw new Error(
      `encodeModelId: '${model}' is not present in AVAILABLE_MODELS`
    );
  }
  return String(idx);
}

/**
 * Decode a short identifier back to a ModelId. Returns `undefined` when the
 * input is out of range or not a non-negative integer — callers (e.g.
 * `handleModelCallback`) MUST handle that case explicitly (typically by
 * answering the Telegram callback with an "expired" message) rather than
 * silently dispatching to an arbitrary fallback model.
 */
export function decodeModelId(short: string): ModelId | undefined {
  if (!/^\d+$/.test(short)) return undefined;
  const idx = Number(short);
  if (idx < 0 || idx >= AVAILABLE_MODELS.length) return undefined;
  return AVAILABLE_MODELS[idx];
}
