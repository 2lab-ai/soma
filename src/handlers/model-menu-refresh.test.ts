/**
 * Regression: `/model` context-open must show a freshly-fetched llmux roster
 * (Beads agi-9m7). Prior behaviour fired a fire-and-forget refresh and built
 * the keyboard synchronously against whatever entries the module already held,
 * so a just-added catalog id (e.g. `gpt-6-astra[1m]`) landed only in the NEXT
 * open — the "stale-by-one-open" roster.
 *
 * Two behaviours are pinned:
 *   1. Ack-before-await — the Telegram spinner must not be held for the full
 *      5s refresh, so `answerCallbackQuery` fires before we start awaiting the
 *      fetch. Observed by driving the fetch with a promise WE resolve.
 *   2. Same-open Astra — once the fetch resolves, the keyboard the user sees
 *      contains the fresh Astra rows.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Context } from "grammy";
import { join } from "path";
import { ALLOWED_USERS } from "../config";
import {
  __testResetCatalog,
  setCatalogFetcher,
  setSnapshotPathForTests,
  type CatalogFetcher,
} from "../config/model-catalog";
import { handleCallback } from "./callback";

const CHAT_ID = 880001;
const USER_ID = 880001;
const MESSAGE_ID = 4242;

const WIRE_WITH_ASTRA = [
  {
    id: "gpt-6-astra",
    name: "GPT-6-Astra",
    efforts: ["medium", "high"],
    // Live llmux contract: base astra window is 272k (verified 2026-09-07),
    // not the 400k that the earlier draft carried.
    max_context: 272_000,
    group: "codex",
  },
  {
    id: "gpt-6-astra[1m]",
    name: "GPT-6-Astra [1M]",
    efforts: ["medium", "high"],
    max_context: 1_000_000,
    group: "codex",
  },
];

interface Capture {
  ctx: Context;
  editedKeyboards: Array<Array<Array<{ text: string; callback_data: string }>>>;
  answers: { count: number };
  replies: string[];
}

interface ContextOptions {
  editMessageTextThrows?: unknown;
}

function makeContext(callbackData: string, options: ContextOptions = {}): Capture {
  const editedKeyboards: Array<Array<Array<{ text: string; callback_data: string }>>> =
    [];
  const answers = { count: 0 };
  const replies: string[] = [];

  const ctx = {
    from: { id: USER_ID, username: "tester" },
    chat: { id: CHAT_ID, type: "private" },
    callbackQuery: {
      data: callbackData,
      message: { message_id: MESSAGE_ID },
    },
    answerCallbackQuery: async () => {
      answers.count += 1;
      return true;
    },
    editMessageText: async (
      _text: string,
      other?: {
        reply_markup?: {
          inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
        };
      }
    ) => {
      if (options.editMessageTextThrows) throw options.editMessageTextThrows;
      editedKeyboards.push(other?.reply_markup?.inline_keyboard ?? []);
      return true;
    },
    editMessageReplyMarkup: async () => true,
    reply: async (text: string) => {
      replies.push(text);
      return true;
    },
  } as unknown as Context;

  return { ctx, editedKeyboards, answers, replies };
}

// `dirname()` of this resolves to an existing regular file
// (`model-catalog.ts`), so `mkdirSync` inside `saveSnapshot` fails with
// ENOTDIR. `saveSnapshot` warns and keeps in-memory entries, so the test
// creates/removes nothing on disk.
const UNWRITABLE_SNAPSHOT_PATH = join(
  __dirname,
  "..",
  "config",
  "model-catalog.ts",
  "nope",
  "model-catalog.json"
);

// Preserve any pre-existing state exactly: if AUTH_MODE was set (even to
// something other than llmux) or USER_ID was already in ALLOWED_USERS, the
// afterAll must leave that alone rather than deleting it.
let previousAuthMode: string | undefined;
let addedUserId = false;

beforeAll(() => {
  previousAuthMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "llmux";
  if (!ALLOWED_USERS.includes(USER_ID)) {
    ALLOWED_USERS.push(USER_ID);
    addedUserId = true;
  }
});

afterAll(() => {
  if (previousAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = previousAuthMode;
  if (addedUserId) {
    const idx = ALLOWED_USERS.indexOf(USER_ID);
    if (idx !== -1) ALLOWED_USERS.splice(idx, 1);
  }
});

beforeEach(() => {
  setSnapshotPathForTests(UNWRITABLE_SNAPSHOT_PATH);
  __testResetCatalog();
});

afterEach(() => {
  __testResetCatalog();
  setSnapshotPathForTests(null);
  setCatalogFetcher(null);
});

function buttonTexts(
  rows: Array<Array<{ text: string; callback_data: string }>>
): string[] {
  return rows.flatMap((row) => row.map((btn) => btn.text));
}

describe("BUG agi-9m7: /model context-open awaits catalog refresh", () => {
  test("BUG agi-9m7: acks the callback BEFORE awaiting the refresh, then renders fresh Astra rows", async () => {
    // A pending fetch that we control: the handler must ack the callback
    // (release the Telegram spinner) before the fetch resolves, then edit the
    // menu after it does.
    let resolveFetch!: (rows: unknown[]) => void;
    const fetchPromise = new Promise<unknown[]>((r) => {
      resolveFetch = r;
    });
    const fetcher: CatalogFetcher = () => fetchPromise;
    setCatalogFetcher(fetcher);

    const cap = makeContext("model:context:general");
    const handled = handleCallback(cap.ctx);

    // Let the handler run up to its first await point (the fetch).
    await Promise.resolve();
    await Promise.resolve();

    // Ordering — ack has fired exactly once (the context branch early-returns
    // after acking, so the trailing ack in handleModelCallback does not run);
    // the menu edit has NOT.
    expect(cap.answers.count).toBe(1);
    expect(cap.editedKeyboards.length).toBe(0);

    // Now let the refresh finish and the handler continue.
    resolveFetch(WIRE_WITH_ASTRA);
    await handled;

    expect(cap.answers.count).toBe(1);
    expect(cap.editedKeyboards.length).toBe(1);
    const labels = buttonTexts(cap.editedKeyboards[0]!);
    expect(labels.some((t) => t.startsWith("GPT-6-Astra [1M]"))).toBe(true);
    expect(labels.some((t) => t.startsWith("GPT-6-Astra") && !t.includes("[1M]"))).toBe(
      true
    );
  });

  test("BUG agi-9m7: post-ack editMessageText failure yields exactly one ack and one fallback reply", async () => {
    // The context branch acks BEFORE awaiting the refresh. Once acked, any
    // render error inside that branch must be handled locally: the outer
    // catch cannot answer the callback again (it was already answered) and
    // must not try — the user gets a single visible fallback reply instead.
    setCatalogFetcher(async () => WIRE_WITH_ASTRA);

    const boom = new Error("Bad Request: message can't be edited");
    const cap = makeContext("model:context:general", {
      editMessageTextThrows: boom,
    });

    await handleCallback(cap.ctx);

    expect(cap.answers.count).toBe(1);
    expect(cap.replies).toEqual(["❌ Failed to show model selection. Re-open /model."]);
    // The failed edit throws before pushing a keyboard, so nothing captured.
    expect(cap.editedKeyboards.length).toBe(0);
  });
});
