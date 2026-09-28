/**
 * `/model <model> [effort]` — the argument form of the command.
 *
 * Operator request (2026-09-28): "`/model fable` → the newest fable `[1m]`;
 * `/model fable xhigh` → same model, effort xhigh; `/model {model} {effort}`
 * in general". The bare `/model` keeps its 3-context keyboard, so both shapes
 * are pinned here.
 *
 * The catalog is seeded with the live llmux shape (aliases on the `[1m]` row,
 * except `grok` which llmux hangs on the NON-1M row) so the promotion rule is
 * exercised against the real metadata and not a convenient one.
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
import { ALLOWED_USERS } from "../../config";
import { getCurrentConfig, updateContextModel } from "../../config/model";
import {
  __testResetCatalog,
  __testSeedCatalog,
  setCatalogFetcher,
  setSnapshotPathForTests,
} from "../../config/model-catalog";
import { handleModel } from "./usage-commands";

const CHAT_ID = 880002;
const USER_ID = 880002;

/** Live llmux rows (2026-09-28), trimmed to the families these cases touch. */
const WIRE = [
  {
    id: "claude-fable-5-1[1m]",
    name: "Fable 5.1 [1M]",
    aliases: ["fable", "fable-5-1"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    max_context: 1_000_000,
    group: "claude",
  },
  {
    id: "claude-opus-5-5[1m]",
    name: "Opus 5.5 [1M]",
    aliases: ["opus", "opus-5-5"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    max_context: 1_000_000,
    group: "claude",
  },
  {
    id: "claude-opus-5-5",
    name: "Opus 5.5",
    aliases: [],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    max_context: 256_000,
    group: "claude",
  },
  {
    // llmux's `grok` alias sits on the 256k row — the resolver must promote.
    id: "grok-4.7",
    name: "Grok 4.7",
    aliases: ["grok"],
    efforts: ["low", "medium", "high", "xhigh"],
    max_context: 256_000,
    group: "grok",
  },
  {
    id: "grok-4.7[1m]",
    name: "Grok 4.7 [1M]",
    aliases: [],
    efforts: ["low", "medium", "high", "xhigh"],
    max_context: 1_000_000,
    group: "grok",
  },
  {
    id: "gpt-6-astra[1m]",
    name: "GPT-6-Astra [1M]",
    aliases: ["astra", "gpt-6"],
    efforts: ["medium", "high"],
    max_context: 1_000_000,
    group: "codex",
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6-Astra",
    aliases: [],
    efforts: ["medium", "high"],
    max_context: 272_000,
    group: "codex",
  },
];

interface Reply {
  text: string;
  keyboard: Array<Array<{ text: string; callback_data: string }>> | null;
}

interface Capture {
  ctx: Context;
  replies: Reply[];
}

function makeContext(text: string): Capture {
  const replies: Reply[] = [];
  const ctx = {
    from: { id: USER_ID, username: "tester" },
    chat: { id: CHAT_ID, type: "private" },
    message: { text, message_id: 7 },
    reply: async (
      replyText: string,
      other?: {
        reply_markup?: {
          inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
        };
      }
    ) => {
      replies.push({
        text: replyText,
        keyboard: other?.reply_markup?.inline_keyboard ?? null,
      });
      return true;
    },
  } as unknown as Context;
  return { ctx, replies };
}

// Same trick as model-menu-refresh.test.ts: `dirname()` of this path is a
// regular file, so a snapshot write fails with ENOTDIR, warns, and leaves the
// in-memory entries alone — the test writes nothing to disk.
const UNWRITABLE_SNAPSHOT_PATH = join(
  __dirname,
  "..",
  "..",
  "config",
  "model-catalog.ts",
  "nope",
  "model-catalog.json"
);

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

beforeEach(async () => {
  setSnapshotPathForTests(UNWRITABLE_SNAPSHOT_PATH);
  __testResetCatalog();
  // An empty fetch never replaces entries (extend-only contract), so a refresh
  // triggered by the handler cannot wipe the seed.
  setCatalogFetcher(async () => []);
  __testSeedCatalog(WIRE);
  // Known starting point for every case: a model/effort pair the cases change.
  await updateContextModel("general", "claude-opus-4-8[1m]", "low");
});

afterEach(() => {
  __testResetCatalog();
  setSnapshotPathForTests(null);
  setCatalogFetcher(null);
});

function generalContext(): { model?: string; effort?: string } {
  return getCurrentConfig().contexts.general ?? {};
}

describe("/model with no arguments", () => {
  test("keeps the 3-context keyboard", async () => {
    const cap = makeContext("/model");
    await handleModel(cap.ctx);

    expect(cap.replies.length).toBe(1);
    const rows = cap.replies[0]!.keyboard;
    expect(rows?.length).toBe(3);
    expect(rows?.flat().map((b) => b.callback_data)).toEqual([
      "model:context:general",
      "model:context:summary",
      "model:context:cron",
    ]);
    // Nothing was saved by opening the menu.
    expect(generalContext().model).toBe("claude-opus-4-8[1m]");
  });
});

describe("/model <shorthand>", () => {
  test("fable selects the newest fable [1m] and leaves effort alone", async () => {
    const cap = makeContext("/model fable");
    await handleModel(cap.ctx);

    expect(generalContext().model).toBe("claude-fable-5-1[1m]");
    expect(generalContext().effort).toBe("low");
    expect(cap.replies[0]!.text).toContain("claude-fable-5-1[1m]");
    expect(cap.replies[0]!.keyboard).toBeNull();
  });

  test("the /model@botname form is accepted too", async () => {
    const cap = makeContext("/model@soma_bot opus");
    await handleModel(cap.ctx);

    expect(generalContext().model).toBe("claude-opus-5-5[1m]");
  });

  test("grok is promoted past llmux's non-1M alias target", async () => {
    const cap = makeContext("/model grok max");
    await handleModel(cap.ctx);

    expect(generalContext().model).toBe("grok-4.7[1m]");
    // The requested level is persisted as typed; the clamp is only displayed.
    expect(generalContext().effort).toBe("max");
    expect(cap.replies[0]!.text).toContain("max → xhigh");
  });
});

describe("/model <model> <effort>", () => {
  test("fable xhigh sets both", async () => {
    const cap = makeContext("/model fable xhigh");
    await handleModel(cap.ctx);

    expect(generalContext().model).toBe("claude-fable-5-1[1m]");
    expect(generalContext().effort).toBe("xhigh");
    expect(cap.replies[0]!.text).toContain("effort: xhigh");
  });

  test("a model with no effort menu saves the model and says the effort was ignored", async () => {
    const cap = makeContext("/model claude-sonnet-4-5-20250929 high");
    await handleModel(cap.ctx);

    expect(generalContext().model).toBe("claude-sonnet-4-5-20250929");
    expect(generalContext().effort).toBe("low");
    expect(cap.replies[0]!.text).toContain("ignored");
    expect(cap.replies[0]!.text).toContain("keyword");
  });
});

describe("/model rejects bad input without saving", () => {
  test("in oauth mode there are no shorthands to suggest, so it asks for an exact id", async () => {
    // The catalog contributes nothing in oauth mode (same gate as isKnownModel),
    // so `getKnownAliases()` is empty and the suggestion sentence must be
    // dropped rather than rendered as "Try one of:  or …".
    process.env.AUTH_MODE = "oauth";
    try {
      const cap = makeContext("/model nope");
      await handleModel(cap.ctx);

      expect(cap.replies[0]!.text).toContain("Unknown model");
      expect(cap.replies[0]!.text).toContain("Use an exact model id");
      expect(cap.replies[0]!.text).not.toContain("Try one of");
      expect(generalContext().model).toBe("claude-opus-4-8[1m]");
    } finally {
      process.env.AUTH_MODE = "llmux";
    }
  });

  test("an unknown model names the known shorthands", async () => {
    const cap = makeContext("/model nope");
    await handleModel(cap.ctx);

    expect(cap.replies[0]!.text).toContain("Unknown model");
    expect(cap.replies[0]!.text).toContain("fable");
    expect(generalContext().model).toBe("claude-opus-4-8[1m]");
    expect(generalContext().effort).toBe("low");
  });

  test("an unknown effort lists the levels and changes nothing", async () => {
    const cap = makeContext("/model fable turbo");
    await handleModel(cap.ctx);

    expect(cap.replies[0]!.text).toContain("Unknown effort");
    expect(cap.replies[0]!.text).toContain("xhigh");
    expect(generalContext().model).toBe("claude-opus-4-8[1m]");
    expect(generalContext().effort).toBe("low");
  });

  test("an ambiguous shorthand lists the candidates", async () => {
    const cap = makeContext("/model claude");
    await handleModel(cap.ctx);

    expect(cap.replies[0]!.text).toContain("claude-fable-5-1[1m]");
    expect(cap.replies[0]!.text).toContain("claude-opus-5-5[1m]");
    expect(generalContext().model).toBe("claude-opus-4-8[1m]");
  });

  test("a third token is a usage error", async () => {
    const cap = makeContext("/model a b c");
    await handleModel(cap.ctx);

    expect(cap.replies[0]!.text).toContain("Usage:");
    expect(generalContext().model).toBe("claude-opus-4-8[1m]");
  });
});
