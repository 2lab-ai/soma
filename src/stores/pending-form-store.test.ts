import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PendingFormStore } from "./pending-form-store.js";
import type { PendingFormData } from "../types/pending-forms.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("PendingFormStore", () => {
  let tempDir: string;
  let store: PendingFormStore;

  const createValidForm = (
    overrides: Partial<PendingFormData> = {}
  ): PendingFormData => ({
    formId: "test-form-1",
    sessionKey: "12345",
    chatId: 12345,
    messageIds: [101, 102],
    questions: [
      {
        id: "q1",
        question: "Choose one?",
        choices: [
          { id: "a", label: "Option A", description: "First option" },
          { id: "b", label: "Option B", description: "Second option" },
        ],
      },
    ],
    selections: {},
    createdAt: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "soma-test-"));
    store = new PendingFormStore({ dataDir: tempDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Basic Operations", () => {
    it("should store and retrieve a form", () => {
      const form = createValidForm();
      store.set("test-form-1", form);

      const retrieved = store.get("test-form-1");
      expect(retrieved).toEqual(form);
    });

    it("should check if form exists", () => {
      const form = createValidForm();
      store.set("test-form-1", form);

      expect(store.has("test-form-1")).toBe(true);
      expect(store.has("non-existent")).toBe(false);
    });

    it("should delete a form", () => {
      const form = createValidForm();
      store.set("test-form-1", form);
      expect(store.has("test-form-1")).toBe(true);

      store.delete("test-form-1");
      expect(store.has("test-form-1")).toBe(false);
      expect(store.get("test-form-1")).toBeUndefined();
    });

    it("should return undefined for non-existent form", () => {
      expect(store.get("non-existent")).toBeUndefined();
    });
  });

  describe("Selection Updates", () => {
    it("should update selection for a question", () => {
      const form = createValidForm();
      store.set("test-form-1", form);

      const updated = store.updateSelection("test-form-1", "q1", {
        choiceId: "a",
        label: "Option A",
      });

      expect(updated).toBe(true);

      const retrieved = store.get("test-form-1");
      expect(retrieved?.selections["q1"]).toEqual({
        choiceId: "a",
        label: "Option A",
      });
    });

    it("should return false for non-existent form", () => {
      const updated = store.updateSelection("non-existent", "q1", {
        choiceId: "a",
        label: "Option A",
      });
      expect(updated).toBe(false);
    });
  });

  describe("Session Filtering", () => {
    it("should get forms by session key", () => {
      const form1 = createValidForm({ formId: "form1", sessionKey: "session1" });
      const form2 = createValidForm({ formId: "form2", sessionKey: "session1" });
      const form3 = createValidForm({ formId: "form3", sessionKey: "session2" });

      store.set("form1", form1);
      store.set("form2", form2);
      store.set("form3", form3);

      const session1Forms = store.getFormsBySession("session1");
      expect(session1Forms.size).toBe(2);
      expect(session1Forms.has("form1")).toBe(true);
      expect(session1Forms.has("form2")).toBe(true);
      expect(session1Forms.has("form3")).toBe(false);
    });

    it("should return empty map for session with no forms", () => {
      const forms = store.getFormsBySession("non-existent");
      expect(forms.size).toBe(0);
    });
  });

  describe("File Persistence", () => {
    it("should persist forms to file and reload", async () => {
      const form = createValidForm();
      store.set("test-form-1", form);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const newStore = new PendingFormStore({ dataDir: tempDir });
      const loaded = await newStore.loadForms();

      expect(loaded).toBe(1);
      expect(newStore.has("test-form-1")).toBe(true);
      expect(newStore.get("test-form-1")).toEqual(form);
    });

    it("should handle missing forms file gracefully", async () => {
      const loaded = await store.loadForms();
      expect(loaded).toBe(0);
    });

    it("should persist multiple forms", async () => {
      const form1 = createValidForm({ formId: "form1" });
      const form2 = createValidForm({ formId: "form2" });

      store.set("form1", form1);
      store.set("form2", form2);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const newStore = new PendingFormStore({ dataDir: tempDir });
      const loaded = await newStore.loadForms();

      expect(loaded).toBe(2);
      expect(newStore.has("form1")).toBe(true);
      expect(newStore.has("form2")).toBe(true);
    });
  });

  describe("TTL Expiration", () => {
    it("should expire forms after 24 hours", async () => {
      const now = Date.now();
      const oldForm = createValidForm({
        formId: "old-form",
        createdAt: now - 25 * 60 * 60 * 1000,
      });
      const recentForm = createValidForm({
        formId: "recent-form",
        createdAt: now - 1 * 60 * 60 * 1000,
      });

      store.set("old-form", oldForm);
      store.set("recent-form", recentForm);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const newStore = new PendingFormStore({ dataDir: tempDir });
      const loaded = await newStore.loadForms();

      expect(loaded).toBe(1);
      expect(newStore.has("recent-form")).toBe(true);
      expect(newStore.has("old-form")).toBe(false);
    });

    it("should clean up expired forms from file", async () => {
      const now = Date.now();
      const oldForm = createValidForm({
        formId: "old-form",
        createdAt: now - 25 * 60 * 60 * 1000,
      });

      store.set("old-form", oldForm);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const newStore = new PendingFormStore({ dataDir: tempDir });
      await newStore.loadForms();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const thirdStore = new PendingFormStore({ dataDir: tempDir });
      const loaded = await thirdStore.loadForms();

      expect(loaded).toBe(0);
    });
  });

  describe("Utility Methods", () => {
    it("should get all form IDs", () => {
      const form1 = createValidForm({ formId: "form1" });
      const form2 = createValidForm({ formId: "form2" });

      store.set("form1", form1);
      store.set("form2", form2);

      const ids = store.getAllFormIds();
      expect(ids).toContain("form1");
      expect(ids).toContain("form2");
      expect(ids.length).toBe(2);
    });

    it("should clear all forms", () => {
      const form1 = createValidForm({ formId: "form1" });
      const form2 = createValidForm({ formId: "form2" });

      store.set("form1", form1);
      store.set("form2", form2);

      store.clear();

      expect(store.getAllFormIds().length).toBe(0);
      expect(store.has("form1")).toBe(false);
      expect(store.has("form2")).toBe(false);
    });
  });
});
