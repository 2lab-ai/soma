import { describe, test, expect } from "bun:test";
import { listTasks, getTask, checkBdAvailable } from "./bd-client";

describe("bd-client", () => {
  test("checkBdAvailable should return true", async () => {
    const available = await checkBdAvailable();
    expect(available).toBe(true);
  });

  test("listTasks should return array", async () => {
    const tasks = await listTasks({ limit: 5 });
    expect(Array.isArray(tasks)).toBe(true);
  });

  test("listTasks with priority filter", async () => {
    const tasks = await listTasks({ priority: "P0", limit: 10 });
    expect(Array.isArray(tasks)).toBe(true);
    // All returned tasks should be P0 (priority 0)
    tasks.forEach((task) => {
      expect(task.priority).toBe(0);
    });
  });

  test("listTasks with project filter", async () => {
    const tasks = await listTasks({ project: "soma", limit: 10 });
    expect(Array.isArray(tasks)).toBe(true);
    // All returned tasks should have soma- prefix
    tasks.forEach((task) => {
      expect(task.id.startsWith("soma-")).toBe(true);
    });
  });

  test("getTask should return task details", async () => {
    // First get a task ID
    const tasks = await listTasks({ limit: 1 });
    if (tasks.length > 0) {
      const taskId = tasks[0]!.id; // Safe: length check guarantees this exists
      const task = await getTask(taskId);
      expect(task).not.toBeNull();
      expect(task?.id).toBe(taskId);
    }
  });

  test("getTask with invalid ID should return null", async () => {
    const task = await getTask("nonexistent-task-12345");
    expect(task).toBeNull();
  });
});
