import { expect, test } from "bun:test";
import { parseDotenv } from "./parse-dotenv";

test("parses the shapes Bun's .env auto-load accepts on one line", () => {
  const env = parseDotenv(
    [
      "# comment",
      "",
      "TELEGRAM_BOT_TOKEN=123:abc",
      "export ALLOWED_PATHS=/a,/b",
      'AUDIT_LOG_PATH="/var/log/soma audit.log"',
      "QUOTED_HASH='a # not a comment'",
      "TRAILING=value # comment",
      "  SPACED = padded  ",
      "not a pair",
    ].join("\n")
  );
  expect(env).toEqual({
    TELEGRAM_BOT_TOKEN: "123:abc",
    ALLOWED_PATHS: "/a,/b",
    AUDIT_LOG_PATH: "/var/log/soma audit.log",
    QUOTED_HASH: "a # not a comment",
    TRAILING: "value",
    SPACED: "padded",
  });
});
