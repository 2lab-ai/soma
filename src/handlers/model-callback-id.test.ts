/**
 * Telegram callback-data identifier scheme for model selection.
 *
 * Background. The `model:model:<ctx>:<id>` / `model:save:<ctx>:<id>:<lvl>`
 * payload used the second hyphen-segment of the model id as the short
 * identifier (`"claude-opus-4-7".split("-")[1] === "opus"`). That worked
 * when there was a single Opus row, but breaks the moment more than one
 * opus is selectable:
 *
 *   "claude-opus-4-7".split("-")[1]      === "opus"
 *   "claude-opus-4-8".split("-")[1]      === "opus"
 *   "claude-opus-4-8[1m]".split("-")[1]  === "opus"
 *
 * `AVAILABLE_MODELS.find(m => m.includes("opus"))` then returns the first
 * match — the user's selection collapses to whichever Opus is listed first.
 *
 * The fix: encode the AVAILABLE_MODELS index as the short identifier and
 * resolve it back via lookup. The contract this test pins:
 *
 *   - `encodeModelId(modelId)` returns the model's AVAILABLE_MODELS index
 *     as a decimal string.
 *   - `decodeModelId(short)` returns the matching ModelId (or undefined
 *     when the index is out of range / non-numeric).
 *   - Round-trip is the identity on every AVAILABLE_MODELS entry.
 *   - Each opus variant decodes to a distinct id (regression for the bug
 *     above).
 */
import { describe, expect, test } from "bun:test";
import { AVAILABLE_MODELS, type ModelId } from "../config/model";
import { decodeModelId, encodeModelId } from "./model-callback-id";

describe("model-callback-id — round-trip", () => {
  test("every AVAILABLE_MODELS entry round-trips through encode/decode", () => {
    for (const id of AVAILABLE_MODELS) {
      const short = encodeModelId(id);
      expect(decodeModelId(short)).toBe(id);
    }
  });

  test("encoded short identifier fits Telegram's 64-byte callback-data limit", () => {
    // model:save:<ctx>:<short>:<level>  →  worst case ~30 bytes prefix +
    // short. Index strings are ≤ 3 digits long for any plausible roster.
    for (const id of AVAILABLE_MODELS) {
      expect(encodeModelId(id).length).toBeLessThanOrEqual(3);
    }
  });
});

describe("model-callback-id — multi-opus disambiguation (regression for the split('-')[1] bug)", () => {
  test("each opus-family row decodes to a distinct id (no collapsing onto the first opus)", () => {
    const opusRows = AVAILABLE_MODELS.filter((m): m is ModelId =>
      m.startsWith("claude-opus-")
    );
    expect(opusRows.length).toBeGreaterThanOrEqual(2);

    const decoded = opusRows.map((id) => decodeModelId(encodeModelId(id)));
    expect(new Set(decoded).size).toBe(opusRows.length);

    // And specifically: the 4.8 [1m] variant must be reachable without
    // colliding with bare 4.8 or 4.7.
    if (
      (AVAILABLE_MODELS as readonly string[]).includes("claude-opus-4-8[1m]")
    ) {
      const short = encodeModelId("claude-opus-4-8[1m]" as ModelId);
      expect(decodeModelId(short)).toBe("claude-opus-4-8[1m]");
    }
  });
});

describe("model-callback-id — defensive decoding", () => {
  test("returns undefined for out-of-range or non-numeric input", () => {
    expect(decodeModelId("9999")).toBeUndefined();
    expect(decodeModelId("opus")).toBeUndefined();
    expect(decodeModelId("")).toBeUndefined();
  });
});
