#!/usr/bin/env python3
import asyncio
import json
import sys
from datetime import datetime, timezone

POLL_SECONDS = 10
CHECKS_TIMEOUT_SECONDS = 180
BOT_LOGINS = {
    "github-actions[bot]",
    "chatgpt-codex-connector[bot]",
    "codex-gc-app[bot]",
    "app/codex-gc-app",
}


async def run_gh(*args: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        "gh",
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(stderr.decode().strip() or "gh command failed")
    return stdout.decode()


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def is_human(comment: dict) -> bool:
    login = ((comment.get("user") or {}).get("login")) or ""
    return login not in BOT_LOGINS


async def get_pr_info() -> dict:
    data = await run_gh(
        "pr",
        "view",
        "--json",
        "number,url,headRefOid,mergeable",
    )
    return json.loads(data)


async def list_issue_comments(pr_number: int) -> list[dict]:
    data = await run_gh(
        "api",
        f"repos/{{owner}}/{{repo}}/issues/{pr_number}/comments",
    )
    return json.loads(data)


async def list_review_comments(pr_number: int) -> list[dict]:
    data = await run_gh(
        "api",
        f"repos/{{owner}}/{{repo}}/pulls/{pr_number}/comments",
    )
    return json.loads(data)


async def list_reviews(pr_number: int) -> list[dict]:
    data = await run_gh(
        "api",
        f"repos/{{owner}}/{{repo}}/pulls/{pr_number}/reviews",
    )
    return json.loads(data)


async def list_check_runs(head_sha: str) -> list[dict]:
    data = await run_gh(
        "api",
        f"repos/{{owner}}/{{repo}}/commits/{head_sha}/check-runs",
    )
    payload = json.loads(data)
    return payload.get("check_runs", [])


def has_new_human_feedback(
    comments: list[dict],
    started_at: datetime,
) -> bool:
    for comment in comments:
        if not is_human(comment):
            continue
        timestamp = parse_time(comment.get("updated_at") or comment.get("created_at"))
        if timestamp and timestamp > started_at:
            return True
    return False


def has_new_review_state(reviews: list[dict], started_at: datetime) -> bool:
    for review in reviews:
        login = ((review.get("user") or {}).get("login")) or ""
        if login in BOT_LOGINS:
            continue
        state = review.get("state")
        timestamp = parse_time(review.get("submitted_at"))
        if state in {"CHANGES_REQUESTED", "COMMENTED"} and timestamp and timestamp > started_at:
            return True
    return False


def summarize_checks(check_runs: list[dict]) -> tuple[bool, bool]:
    if not check_runs:
      return True, False

    pending = False
    failed = False
    latest_by_name: dict[str, dict] = {}

    for check in check_runs:
        name = check.get("name", "unknown")
        previous = latest_by_name.get(name)
        if previous is None:
            latest_by_name[name] = check
            continue

        current_time = parse_time(
            check.get("completed_at")
            or check.get("started_at")
            or check.get("created_at"),
        )
        previous_time = parse_time(
            previous.get("completed_at")
            or previous.get("started_at")
            or previous.get("created_at"),
        )
        if current_time and (previous_time is None or current_time > previous_time):
            latest_by_name[name] = check

    for check in latest_by_name.values():
        status = check.get("status")
        conclusion = check.get("conclusion")
        if status != "completed":
            pending = True
            continue
        if conclusion not in {"success", "neutral", "skipped"}:
            failed = True

    return pending, failed


async def main() -> int:
    started_at = datetime.now(timezone.utc)
    pr = await get_pr_info()
    pr_number = pr["number"]
    initial_head_sha = pr["headRefOid"]
    checks_deadline = started_at.timestamp() + CHECKS_TIMEOUT_SECONDS

    while True:
        current_pr = await get_pr_info()
        if current_pr["headRefOid"] != initial_head_sha:
            print("PR head changed while waiting.")
            return 4

        issue_comments, review_comments, reviews = await asyncio.gather(
            list_issue_comments(pr_number),
            list_review_comments(pr_number),
            list_reviews(pr_number),
        )

        if has_new_human_feedback(issue_comments, started_at):
            print("New issue comment detected.")
            return 2

        if has_new_human_feedback(review_comments, started_at):
            print("New review comment detected.")
            return 2

        if has_new_review_state(reviews, started_at):
            print("New review state detected.")
            return 2

        check_runs = await list_check_runs(initial_head_sha)
        pending, failed = summarize_checks(check_runs)

        if not check_runs and datetime.now(timezone.utc).timestamp() < checks_deadline:
            await asyncio.sleep(POLL_SECONDS)
            continue

        if failed:
            print("One or more checks failed.")
            return 3

        if not pending:
            print("Checks passed and no new review feedback detected.")
            return 0

        await asyncio.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as exc:  # pragma: no cover - operational fallback
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
