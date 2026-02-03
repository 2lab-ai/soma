/**
 * bd CLI integration client
 *
 * Wrapper for bd (beads) issue tracker CLI tool.
 * Provides async functions to query tasks via Bun.spawn.
 */

export interface BdTask {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  issue_type: string;
  owner: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  dependencies?: Array<{
    issue_id: string;
    depends_on_id: string;
    type: string;
    created_at: string;
    created_by: string;
  }>;
  dependents?: Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    priority: number;
    issue_type: string;
    owner: string;
    created_at: string;
    created_by: string;
    updated_at: string;
    dependency_type: string;
  }>;
  dependency_count?: number;
  dependent_count?: number;
}

export interface ListTasksFilter {
  priority?: string; // "P0", "P1", "P2", etc.
  status?: string; // "open", "in_progress", "closed"
  project?: string; // Project prefix filter (e.g., "soma", "p9")
  limit?: number;
}

export class BdClientError extends Error {
  constructor(
    message: string,
    public code: string,
    public stderr?: string
  ) {
    super(message);
    this.name = "BdClientError";
  }
}

const DEFAULT_TIMEOUT = 10000; // 10s
const VALID_PRIORITIES = ["P0", "P1", "P2", "P3", "P4"];
const VALID_STATUSES = ["open", "in_progress", "closed"];

/**
 * Check if bd CLI is available
 */
export async function checkBdAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bd", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Spawn bd command and parse JSON output
 */
async function spawnBd(args: string[], cwd?: string): Promise<BdTask[]> {
  const proc = Bun.spawn(["bd", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: cwd || process.cwd(),
  });

  let killed = false;
  const timeout = setTimeout(() => {
    killed = true;
    proc.kill();
  }, DEFAULT_TIMEOUT);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    clearTimeout(timeout);
    await proc.exited;

    // Check if process was killed by timeout
    if (killed) {
      throw new BdClientError(
        `bd command timed out after ${DEFAULT_TIMEOUT / 1000}s`,
        "BD_TIMEOUT"
      );
    }

    // Check exit code (skip if stdout contains error JSON - handled below)
    const hasErrorJson = stdout.trim() && stdout.includes("error");
    if (proc.exitCode !== 0 && proc.exitCode !== null && !hasErrorJson) {
      throw new BdClientError(
        `bd exited with code ${proc.exitCode}: ${stderr}`,
        "BD_EXIT_ERROR",
        stderr
      );
    }

    if (!stdout.trim()) {
      return [];
    }

    // Parse JSON first to check for error field
    let parsed: BdTask[] | { error: string };
    try {
      parsed = JSON.parse(stdout);
    } catch (parseError) {
      throw new BdClientError(
        `Failed to parse bd JSON output: ${parseError}`,
        "BD_PARSE_ERROR",
        stdout
      );
    }

    // Check if bd returned an error object
    if (!Array.isArray(parsed) && typeof parsed === "object" && "error" in parsed) {
      throw new BdClientError(
        `bd command failed: ${parsed.error}`,
        "BD_EXEC_FAILED",
        parsed.error
      );
    }

    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof BdClientError) {
      throw error;
    }
    throw new BdClientError(`bd execution error: ${error}`, "BD_UNKNOWN_ERROR");
  }
}

/**
 * List tasks with optional filters
 */
export async function listTasks(
  filter?: ListTasksFilter,
  cwd?: string
): Promise<BdTask[]> {
  const args = ["list", "--json"];

  if (filter?.limit) {
    args.push("--limit", filter.limit.toString());
  }

  if (filter?.priority) {
    if (!VALID_PRIORITIES.includes(filter.priority)) {
      throw new BdClientError(
        `Invalid priority: ${filter.priority}. Must be one of: ${VALID_PRIORITIES.join(", ")}`,
        "BD_INVALID_INPUT"
      );
    }
    args.push("--priority", filter.priority);
  }

  if (filter?.status) {
    if (!VALID_STATUSES.includes(filter.status)) {
      throw new BdClientError(
        `Invalid status: ${filter.status}. Must be one of: ${VALID_STATUSES.join(", ")}`,
        "BD_INVALID_INPUT"
      );
    }

    if (filter.status === "closed") {
      args.push("--all"); // Include closed issues
    }
  }

  const tasks = await spawnBd(args, cwd);

  // Client-side filtering for project prefix
  if (filter?.project) {
    const prefix = filter.project.toLowerCase();
    return tasks.filter((task) => task.id.toLowerCase().startsWith(prefix));
  }

  return tasks;
}

/**
 * Get a single task by ID
 */
export async function getTask(taskId: string, cwd?: string): Promise<BdTask | null> {
  // Validate taskId format (security: prevent command injection)
  if (!/^[a-zA-Z0-9_.-]+$/.test(taskId)) {
    throw new BdClientError(`Invalid task ID format: ${taskId}`, "BD_INVALID_INPUT");
  }

  const args = ["show", taskId, "--json"];

  try {
    const tasks = await spawnBd(args, cwd);
    return tasks[0] || null;
  } catch (error) {
    if (
      error instanceof BdClientError &&
      error.code === "BD_EXEC_FAILED" &&
      error.stderr?.includes("no issue found")
    ) {
      return null;
    }
    throw error;
  }
}
