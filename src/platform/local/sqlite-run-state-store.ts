import { Database } from "@db/sqlite";
import { join } from "node:path";
import type {
  ArticleRunDetail,
  ArticleRunRecord,
  ArticleRunStepRecord,
  RunStateStore,
  StartRunInput,
} from "@src/core/ports/run-state-store.ts";

/** 每次操作使用事务并释放连接，避免定时任务与后台请求覆盖彼此的运行记录。 */
export class SQLiteRunStateStore implements RunStateStore {
  constructor(private readonly baseDir: string) {}

  async startRun(input: StartRunInput): Promise<ArticleRunRecord> {
    return this.transaction((db) => {
      const existing = this.readRun(db, input.runId);
      const now = new Date().toISOString();
      const record: ArticleRunRecord = {
        ...input,
        runKind: input.runKind ?? "single",
        status: "running",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        artifacts: existing?.artifacts ?? [],
      };
      this.writeRun(db, record);
      return record;
    });
  }

  async updateRun(
    runId: string,
    patch: Partial<ArticleRunRecord>,
  ): Promise<void> {
    this.transaction((db) => {
      const run = this.requireRun(db, runId);
      this.writeRun(db, {
        ...run,
        ...patch,
        runId,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async finishRun(
    runId: string,
    patch: Partial<ArticleRunRecord> = {},
  ): Promise<void> {
    await this.updateRun(runId, {
      ...patch,
      status: "succeeded",
      finishedAt: new Date().toISOString(),
    });
  }

  async failRun(runId: string, error: string): Promise<void> {
    await this.updateRun(runId, {
      status: "failed",
      error,
      finishedAt: new Date().toISOString(),
    });
  }

  async startStep(
    runId: string,
    name: string,
    options: { inputArtifacts?: ArticleRunStepRecord["inputArtifacts"] } = {},
  ): Promise<ArticleRunStepRecord> {
    return this.transaction((db) => {
      const run = this.requireRun(db, runId);
      const row = db.prepare(
        "SELECT MAX(attempt) AS attempt FROM local_run_steps WHERE run_id = ? AND name = ?",
      ).get(runId, name) as { attempt: number | null };
      const step: ArticleRunStepRecord = {
        runId,
        name,
        attempt: (row.attempt ?? 0) + 1,
        status: "running",
        startedAt: new Date().toISOString(),
        inputArtifacts: options.inputArtifacts ?? [],
      };
      this.writeStep(db, step);
      this.writeRun(db, {
        ...run,
        status: "running",
        updatedAt: step.startedAt!,
      });
      return step;
    });
  }

  async finishStep(
    runId: string,
    name: string,
    options: { outputArtifacts?: ArticleRunStepRecord["outputArtifacts"] } = {},
  ): Promise<void> {
    this.transaction((db) => {
      const step = this.latestStep(db, runId, name);
      const now = new Date().toISOString();
      this.writeStep(db, {
        ...step,
        status: "succeeded",
        finishedAt: now,
        durationMs: step.startedAt
          ? Date.parse(now) - Date.parse(step.startedAt)
          : undefined,
        outputArtifacts: options.outputArtifacts ?? [],
      });
      const run = this.requireRun(db, runId);
      this.writeRun(db, {
        ...run,
        updatedAt: now,
        artifacts: [...run.artifacts, ...(options.outputArtifacts ?? [])],
      });
    });
  }

  async failStep(runId: string, name: string, error: string): Promise<void> {
    this.transaction((db) => {
      const step = this.latestStep(db, runId, name);
      const now = new Date().toISOString();
      this.writeStep(db, {
        ...step,
        status: "failed",
        error,
        finishedAt: now,
        durationMs: step.startedAt
          ? Date.parse(now) - Date.parse(step.startedAt)
          : undefined,
      });
    });
  }

  async listRuns(limit = 20): Promise<ArticleRunRecord[]> {
    return this.transaction((db) => {
      const rows = db.prepare(
        "SELECT record_json FROM local_runs ORDER BY created_at DESC, rowid DESC LIMIT ?",
      ).all(limit) as { record_json: string }[];
      return rows.map((row) => JSON.parse(row.record_json));
    });
  }

  async getRun(runId: string): Promise<ArticleRunDetail | null> {
    return this.transaction((db) => {
      const run = this.readRun(db, runId);
      if (!run) return null;
      const rows = db.prepare(
        "SELECT record_json FROM local_run_steps WHERE run_id = ? ORDER BY rowid",
      ).all(runId) as { record_json: string }[];
      return { ...run, steps: rows.map((row) => JSON.parse(row.record_json)) };
    });
  }

  private transaction<T>(operation: (db: Database) => T): T {
    const directory = join(this.baseDir, "runs");
    Deno.mkdirSync(directory, { recursive: true });
    const db = new Database(join(directory, "state.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      db.exec(
        `CREATE TABLE IF NOT EXISTS local_runs (run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, record_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local_run_steps (run_id TEXT NOT NULL, name TEXT NOT NULL, attempt INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY (run_id, name, attempt));
        CREATE TABLE IF NOT EXISTS local_run_meta (key TEXT PRIMARY KEY)`,
      );
      if (
        !db.prepare(
          "SELECT key FROM local_run_meta WHERE key = 'legacy-imported'",
        ).get()
      ) {
        let legacy: {
          runs: ArticleRunRecord[];
          steps: ArticleRunStepRecord[];
        } = { runs: [], steps: [] };
        try {
          legacy = JSON.parse(
            Deno.readTextFileSync(join(directory, "state.json")),
          );
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        for (const run of legacy.runs) this.writeRun(db, run);
        for (const step of legacy.steps) this.writeStep(db, step);
        db.exec("INSERT INTO local_run_meta (key) VALUES ('legacy-imported')");
      }
      const result = operation(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch { /* 保留原始异常。 */ }
      throw error;
    } finally {
      db.close();
    }
  }

  private readRun(db: Database, runId: string): ArticleRunRecord | null {
    const row = db.prepare(
      "SELECT record_json FROM local_runs WHERE run_id = ?",
    ).get(runId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) : null;
  }

  private requireRun(db: Database, runId: string): ArticleRunRecord {
    const run = this.readRun(db, runId);
    if (!run) throw new Error(`run 不存在: ${runId}`);
    return run;
  }

  private writeRun(db: Database, run: ArticleRunRecord): void {
    db.prepare(
      "INSERT INTO local_runs (run_id, created_at, record_json) VALUES (?, ?, ?) ON CONFLICT (run_id) DO UPDATE SET record_json = excluded.record_json",
    ).run(run.runId, run.createdAt, JSON.stringify(run));
  }

  private latestStep(
    db: Database,
    runId: string,
    name: string,
  ): ArticleRunStepRecord {
    const row = db.prepare(
      "SELECT record_json FROM local_run_steps WHERE run_id = ? AND name = ? ORDER BY attempt DESC LIMIT 1",
    ).get(runId, name) as { record_json: string } | undefined;
    if (!row) throw new Error(`step 不存在: ${runId}/${name}`);
    return JSON.parse(row.record_json);
  }

  private writeStep(db: Database, step: ArticleRunStepRecord): void {
    db.prepare(
      "INSERT INTO local_run_steps (run_id, name, attempt, record_json) VALUES (?, ?, ?, ?) ON CONFLICT (run_id, name, attempt) DO UPDATE SET record_json = excluded.record_json",
    ).run(step.runId, step.name, step.attempt, JSON.stringify(step));
  }
}
