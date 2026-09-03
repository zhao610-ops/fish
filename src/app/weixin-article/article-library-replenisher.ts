export interface LibraryReplenishmentPlan {
  profileId: string;
  targetSize: number;
  readyCount: number;
}

/** 每小时每方案最多补三篇；跨重启保留时段占位，空结果不无限烧模型额度。 */
export class ArticleLibraryReplenisher {
  private running = false;
  constructor(
    private readonly plans: () => Promise<LibraryReplenishmentPlan[]>,
    private readonly claim: (slot: string) => Promise<boolean>,
    private readonly prepare: (
      profileId: string,
      slot: string,
    ) => Promise<boolean>,
    private readonly onError: (error: unknown) => void,
  ) {}

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const plan of await this.plans()) {
        for (
          let index = 0;
          index < Math.min(3, plan.targetSize - plan.readyCount);
          index++
        ) {
          const slot = `${
            now.toISOString().slice(0, 13)
          }:${plan.profileId}:${index}`;
          try {
            if (!await this.claim(slot)) continue;
            if (!await this.prepare(plan.profileId, slot)) break;
          } catch (error) {
            this.onError(error);
            break;
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
