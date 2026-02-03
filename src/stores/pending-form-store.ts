import type { PendingFormData, SerializedFormData } from "../types/pending-forms.js";
import * as path from "path";
import * as fs from "fs";

const FORM_TIMEOUT_MS = 24 * 60 * 60 * 1000;

interface PendingFormStoreOptions {
  dataDir?: string;
}

export class PendingFormStore {
  private forms: Map<string, PendingFormData> = new Map();
  private dataDir: string;
  private formsFile: string;

  constructor(options: PendingFormStoreOptions = {}) {
    this.dataDir = options.dataDir || path.join(process.cwd(), "data");
    this.formsFile = path.join(this.dataDir, "pending-forms.json");
  }

  get(formId: string): PendingFormData | undefined {
    return this.forms.get(formId);
  }

  set(formId: string, data: PendingFormData): void {
    this.forms.set(formId, data);
    this.saveForms();
  }

  delete(formId: string): void {
    this.forms.delete(formId);
    this.saveForms();
  }

  has(formId: string): boolean {
    return this.forms.has(formId);
  }

  updateSelection(
    formId: string,
    questionId: string,
    selection: { choiceId: string; label: string }
  ): boolean {
    const form = this.forms.get(formId);
    if (!form) return false;

    form.selections[questionId] = selection;
    this.saveForms();
    return true;
  }

  getFormsBySession(sessionKey: string): Map<string, PendingFormData> {
    const result = new Map<string, PendingFormData>();
    for (const [formId, form] of this.forms) {
      if (form.sessionKey === sessionKey) {
        result.set(formId, form);
      }
    }
    return result;
  }

  private saveForms(): void {
    this.saveFormsAsync().catch((error) => {
      console.error("[PendingFormStore] Failed to save forms:", error);
    });
  }

  private async saveFormsAsync(): Promise<void> {
    fs.mkdirSync(this.dataDir, { recursive: true });

    const formsArray: SerializedFormData[] = Array.from(this.forms.entries()).map(
      ([id, form]) => ({ id, ...form })
    );

    await Bun.write(this.formsFile, JSON.stringify(formsArray, null, 2));
    console.log(`[PendingFormStore] Saved ${formsArray.length} forms`);
  }

  async loadForms(): Promise<number> {
    if (!fs.existsSync(this.formsFile)) {
      console.log("[PendingFormStore] No forms file found");
      return 0;
    }

    try {
      const data = await Bun.file(this.formsFile).text();
      const formsArray: SerializedFormData[] = JSON.parse(data);
      const now = Date.now();

      const validForms = formsArray.filter(
        (form) => now - (form.createdAt || 0) < FORM_TIMEOUT_MS
      );

      for (const { id, ...form } of validForms) {
        this.forms.set(id, form as PendingFormData);
      }

      const expiredCount = formsArray.length - validForms.length;
      console.log(
        `[PendingFormStore] Loaded ${validForms.length} forms (${expiredCount} expired)`
      );

      if (expiredCount > 0) {
        this.saveForms();
      }

      return validForms.length;
    } catch (error) {
      console.error("[PendingFormStore] Failed to load forms:", error);
      return 0;
    }
  }

  getAllFormIds(): string[] {
    return Array.from(this.forms.keys());
  }

  clear(): void {
    this.forms.clear();
  }
}
