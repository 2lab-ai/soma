import type { ProviderBoundary } from "./types.models";

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderBoundary>();

  register(provider: ProviderBoundary): void {
    this.providers.set(provider.providerId, provider);
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  get(providerId: string): ProviderBoundary | null {
    return this.providers.get(providerId) ?? null;
  }

  getOrThrow(providerId: string): ProviderBoundary {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider not registered: ${providerId}`);
    }
    return provider;
  }

  listProviderIds(): string[] {
    return Array.from(this.providers.keys());
  }
}
