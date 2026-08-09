/**
 * Telegram callback-data identifier scheme for model selection.
 *
 * Background (two bugs, in order):
 *
 * 1. The payload used the second hyphen-segment of the model id as the short
 *    identifier (`"claude-opus-4-7".split("-")[1] === "opus"`), so every opus
 *    row collapsed onto whichever opus was listed first.
 * 2. The fix for (1) encoded the AVAILABLE_MODELS *index*. That is only stable
 *    while the roster is a static append-only array — with the llmux catalog
 *    the roster grows/shrinks at runtime, so an index encodes a different
 *    model after every refresh.
 *
 * Current contract: the callback data carries the model id verbatim (the
 * longest catalog id today is 18 bytes; `model:save:<ctx>:<id>:<level>` stays
 * well inside Telegram's 64-byte limit) and decoding validates the id against
 * the known set (static roster ∪ catalog) instead of an array position.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AVAILABLE_MODELS } from "../config/model";
import { __testResetCatalog, __testSeedCatalog } from "../config/model-catalog";
import {
  buildModelMenuRows,
  callbackDataFits,
  decodeModelId,
  encodeModelId,
} from "./model-callback-id";

const CATALOG_ENTRIES = [
  { id: "claude-opus-5[1m]", name: "Opus 5 (1M)", group: "claude" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", group: "codex" },
  { id: "grok-4.5", name: "Grok 4.5", group: "grok" },
];

beforeEach(() => {
  __testResetCatalog();
});

afterEach(() => {
  __testResetCatalog();
});

describe("model-callback-id — round-trip", () => {
  test("every AVAILABLE_MODELS entry round-trips through encode/decode", () => {
    for (const id of AVAILABLE_MODELS) {
      expect(decodeModelId(encodeModelId(id))).toBe(id);
    }
  });

  test("catalog-only models round-trip once the catalog knows them", () => {
    __testSeedCatalog(CATALOG_ENTRIES);
    for (const entry of CATALOG_ENTRIES) {
      expect(decodeModelId(encodeModelId(entry.id))).toBe(entry.id);
    }
  });

  test("the full callback payload fits Telegram's 64-byte limit", () => {
    __testSeedCatalog(CATALOG_ENTRIES);
    for (const id of [...AVAILABLE_MODELS, ...CATALOG_ENTRIES.map((e) => e.id)]) {
      expect(callbackDataFits("general", id)).toBe(true);
      const payload = `model:save:general:${encodeModelId(id)}:minimal`;
      expect(Buffer.byteLength(payload, "utf-8")).toBeLessThanOrEqual(64);
    }
  });

  test("an absurdly long model id is rejected by the payload guard", () => {
    expect(callbackDataFits("general", "x".repeat(80))).toBe(false);
  });
});

describe("model-callback-id — multi-opus disambiguation (regression for the split('-')[1] bug)", () => {
  test("each opus-family row decodes to a distinct id", () => {
    const opusRows = AVAILABLE_MODELS.filter((m) => m.startsWith("claude-opus-"));
    expect(opusRows.length).toBeGreaterThanOrEqual(2);

    const decoded = opusRows.map((id) => decodeModelId(encodeModelId(id)));
    expect(new Set(decoded).size).toBe(opusRows.length);
    expect(decodeModelId(encodeModelId("claude-opus-4-8[1m]"))).toBe(
      "claude-opus-4-8[1m]"
    );
  });
});

describe("model-callback-id — defensive decoding", () => {
  test("returns undefined for unknown or malformed input", () => {
    expect(decodeModelId("9999")).toBeUndefined();
    expect(decodeModelId("opus")).toBeUndefined();
    expect(decodeModelId("")).toBeUndefined();
    expect(decodeModelId("grok-4.5")).toBeUndefined();
  });

  test("a stale keyboard pointing at a model the catalog dropped decodes to undefined", () => {
    __testSeedCatalog(CATALOG_ENTRIES);
    expect(decodeModelId("grok-4.5")).toBe("grok-4.5");
    __testResetCatalog();
    expect(decodeModelId("grok-4.5")).toBeUndefined();
  });
});

describe("buildModelMenuRows", () => {
  test("lists the static roster with a group label and marks the current model", () => {
    const rows = buildModelMenuRows("general", "claude-opus-4-8");
    const modelRows = rows.filter((r) => r.kind === "model");
    expect(modelRows.map((r) => r.model)).toEqual([...AVAILABLE_MODELS]);
    expect(rows[0]?.kind).toBe("label");
    expect(modelRows.find((r) => r.model === "claude-opus-4-8")?.text).toContain("✓");
  });

  test("appends catalog models with a label row per group change", () => {
    __testSeedCatalog(CATALOG_ENTRIES);
    const rows = buildModelMenuRows("general", "claude-opus-4-8");
    expect(rows.filter((r) => r.kind === "model").map((r) => r.model)).toContain(
      "grok-4.5"
    );
    const labels = rows.filter((r) => r.kind === "label").map((r) => r.text);
    expect(labels.length).toBe(3); // claude, codex, grok
    expect(labels.some((l) => l.toLowerCase().includes("codex"))).toBe(true);
    expect(labels.some((l) => l.toLowerCase().includes("grok"))).toBe(true);
  });

  test("label rows carry an inert callback payload", () => {
    const rows = buildModelMenuRows("general", "claude-opus-4-8");
    for (const row of rows.filter((r) => r.kind === "label")) {
      expect(row.callbackData).toBe("model:noop");
    }
  });

  test("models whose payload would exceed 64 bytes are skipped, not truncated", () => {
    __testSeedCatalog([
      ...CATALOG_ENTRIES,
      { id: `overlong-${"y".repeat(70)}`, name: "Too Long", group: "grok" },
    ]);
    const ids = buildModelMenuRows("general", "claude-opus-4-8")
      .filter((r) => r.kind === "model")
      .map((r) => r.model);
    expect(ids.some((id) => id?.startsWith("overlong-"))).toBe(false);
    expect(ids).toContain("grok-4.5");
  });

  test("catalog outage still renders the full static roster (extend-only)", () => {
    const ids = buildModelMenuRows("summary", "claude-opus-4-8")
      .filter((r) => r.kind === "model")
      .map((r) => r.model);
    expect(ids).toEqual([...AVAILABLE_MODELS]);
  });
});
