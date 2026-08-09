/**
 * Telegram callback-data encoding for model selection, plus the pure builder
 * for the `/model` keyboard rows.
 *
 * History of the encoding:
 *  1. `modelId.split("-")[1]` collapsed every opus row onto the literal
 *     `"opus"` — the user's pick silently routed to the first opus listed.
 *  2. The AVAILABLE_MODELS array index fixed that, but an index is only stable
 *     while the roster is a static append-only array. With the llmux catalog
 *     the roster changes at runtime, so index N means a different model after
 *     a refresh.
 *  3. Now: the id travels verbatim. Telegram allows 64 bytes of callback_data;
 *     the longest payload we build is `model:save:<ctx>:<id>:<level>`, which
 *     leaves ~35 bytes for the id (today's longest catalog id is 18). Ids that
 *     would not fit are dropped from the menu by {@link buildModelMenuRows}
 *     rather than truncated into an ambiguous prefix.
 */
import { AVAILABLE_MODELS } from "../config/model";
import { getSelectableModels, isKnownModel } from "../config/model-catalog";

/** Telegram's hard limit on `callback_data`. */
const CALLBACK_DATA_LIMIT_BYTES = 64;
/** Longest reasoning level appended by the `model:save:` payload. */
const LONGEST_REASONING_LEVEL = "minimal";
/** Inert payload for the non-clickable group headers. */
export const MODEL_MENU_NOOP_DATA = "model:noop";

export interface ModelMenuRow {
  kind: "label" | "model";
  /** Button caption. */
  text: string;
  /** `callback_data` for the button (labels get {@link MODEL_MENU_NOOP_DATA}). */
  callbackData: string;
  /** The model id this row selects — only present on `kind: "model"` rows. */
  model?: string;
}

/** Encode a model id for `callback_data` (identity — kept as the seam). */
export function encodeModelId(model: string): string {
  return model;
}

/**
 * Decode a callback-data model id. Returns `undefined` when the id is not (or
 * no longer) known — callers MUST handle that explicitly (answer the callback
 * with an "expired menu" notice) rather than falling back to some other model.
 */
export function decodeModelId(short: string): string | undefined {
  if (typeof short !== "string" || short.length === 0) return undefined;
  return isKnownModel(short) ? short : undefined;
}

/**
 * True when every payload this model needs fits Telegram's 64-byte budget.
 * The `model:save:` payload is the longest of the three, so it is the one
 * measured.
 */
export function callbackDataFits(context: string, modelId: string): boolean {
  const worstCase = `model:save:${context}:${encodeModelId(modelId)}:${LONGEST_REASONING_LEVEL}`;
  return Buffer.byteLength(worstCase, "utf-8") <= CALLBACK_DATA_LIMIT_BYTES;
}

function groupLabel(group: string): string {
  return `— ${group} —`;
}

/**
 * Build the `/model` model-selection rows: the static roster first, then the
 * llmux catalog additions, with a header row whenever the group changes.
 *
 * Pure over the current catalog state — the caller decides when to refresh.
 */
export function buildModelMenuRows(context: string, currentModel: string): ModelMenuRow[] {
  const rows: ModelMenuRow[] = [];
  let lastGroup: string | null = null;

  for (const model of getSelectableModels()) {
    // A model whose callback payload cannot fit is unusable, not merely ugly:
    // Telegram rejects the whole keyboard. Skip it and keep the menu working.
    if (!callbackDataFits(context, model.id)) continue;

    if (model.group !== lastGroup) {
      lastGroup = model.group;
      rows.push({
        kind: "label",
        text: groupLabel(model.group),
        callbackData: MODEL_MENU_NOOP_DATA,
      });
    }
    const current = model.id === currentModel ? " ✓" : "";
    rows.push({
      kind: "model",
      text: `${model.displayName}${current}`,
      callbackData: `model:model:${context}:${encodeModelId(model.id)}`,
      model: model.id,
    });
  }

  // Defensive: the static roster must always be reachable (extend-only).
  if (!rows.some((r) => r.kind === "model")) {
    for (const id of AVAILABLE_MODELS) {
      rows.push({
        kind: "model",
        text: id,
        callbackData: `model:model:${context}:${encodeModelId(id)}`,
        model: id,
      });
    }
  }
  return rows;
}
