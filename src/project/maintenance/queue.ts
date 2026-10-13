import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { changePacketSchema, type ChangePacket } from "./contracts.js";

export type MaintenanceJob = { packet: ChangePacket; status: string; attempts: number; lease_owner: string | null; lease_expires_at: string | null };

export const MAINTENANCE_QUEUE_LIMITS = Object.freeze({
  packetBytes: 24 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, totalJobs: 512,
  principalBytes: 64 * 1024 * 1024, principalJobs: 64,
  projectBytes: 128 * 1024 * 1024, projectJobs: 128,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
});

export class MaintenanceQueue {
  readonly path: string;
  private db?: Database.Database;
  private initializing?: Promise<void>;

  constructor(path: string) { this.path = path; }

  async initialize(): Promise<void> {
    if (this.db) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeDatabase();
    try { await this.initializing; } finally { this.initializing = undefined; }
  }

  private async initializeDatabase(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("journal_size_limit = 4194304");
    this.db.pragma("synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_jobs (
        packet_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        packet_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','leased','completed','quarantined','dead_letter')),
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS maintenance_jobs_status_idx ON maintenance_jobs(status, created_at);
    `);
    const columns = new Set((this.db.prepare("PRAGMA table_info(maintenance_jobs)").all() as Array<{ name: string }>).map(column => column.name));
    if (!columns.has("packet_bytes")) this.db.exec("ALTER TABLE maintenance_jobs ADD COLUMN packet_bytes INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("actor_principal")) this.db.exec("ALTER TABLE maintenance_jobs ADD COLUMN actor_principal TEXT NOT NULL DEFAULT 'maintenance-system'");
    if (!columns.has("project_id")) this.db.exec("ALTER TABLE maintenance_jobs ADD COLUMN project_id TEXT NOT NULL DEFAULT ''");
    this.db.exec(`UPDATE maintenance_jobs SET packet_bytes=length(CAST(packet_json AS BLOB)),
      actor_principal=COALESCE(json_extract(packet_json,'$.actor_principal'),'maintenance-system'),
      project_id=COALESCE(json_extract(packet_json,'$.project_id'),'') WHERE packet_bytes=0;
      CREATE INDEX IF NOT EXISTS maintenance_jobs_principal_idx ON maintenance_jobs(actor_principal);
      CREATE INDEX IF NOT EXISTS maintenance_jobs_project_idx ON maintenance_jobs(project_id);`);
  }

  async enqueue(packetInput: ChangePacket): Promise<{ packet_id: string; inserted: boolean }> {
    await this.initialize();
    if (Buffer.byteLength(JSON.stringify(packetInput)) > MAINTENANCE_QUEUE_LIMITS.packetBytes) throw new Error("Maintenance serialized packet byte limit exceeded");
    const packet = changePacketSchema.parse(packetInput);
    const serialized = JSON.stringify(packet);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > MAINTENANCE_QUEUE_LIMITS.packetBytes) throw new Error("Maintenance serialized packet byte limit exceeded");
    const time = new Date().toISOString();
    return this.db!.transaction(() => {
      this.collectExpired();
      const existing = this.db!.prepare("SELECT packet_id FROM maintenance_jobs WHERE idempotency_key = ?").get(packet.idempotency_key) as { packet_id: string } | undefined;
      if (existing) return { packet_id: existing.packet_id, inserted: false };
      const usage = (where = "", value?: string) => this.db!.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(packet_bytes),0) AS bytes FROM maintenance_jobs ${where}`).get(...(value === undefined ? [] : [value])) as { count: number; bytes: number };
      const principal = packet.actor_principal;
      const total = usage(), own = usage("WHERE actor_principal=?", principal), project = usage("WHERE project_id=?", packet.project_id);
      if (total.count >= MAINTENANCE_QUEUE_LIMITS.totalJobs || total.bytes + bytes > MAINTENANCE_QUEUE_LIMITS.totalBytes) throw new Error("Maintenance global queue capacity reached");
      if (own.count >= MAINTENANCE_QUEUE_LIMITS.principalJobs || own.bytes + bytes > MAINTENANCE_QUEUE_LIMITS.principalBytes) throw new Error("Maintenance principal queue capacity reached");
      if (project.count >= MAINTENANCE_QUEUE_LIMITS.projectJobs || project.bytes + bytes > MAINTENANCE_QUEUE_LIMITS.projectBytes) throw new Error("Maintenance project queue capacity reached");
      this.db!.prepare(`INSERT INTO maintenance_jobs
        (packet_id,idempotency_key,packet_json,packet_bytes,actor_principal,project_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(packet.packet_id, packet.idempotency_key, serialized, bytes, principal, packet.project_id, "queued", time, time);
      return { packet_id: packet.packet_id, inserted: true };
    }).immediate();
  }

  async lease(owner: string, ttlMs = 120_000): Promise<MaintenanceJob | null> {
    await this.initialize();
    const now = new Date();
    const expires = new Date(now.getTime() + ttlMs).toISOString();
    const transaction = this.db!.transaction(() => {
      this.collectExpired();
      this.db!.prepare("UPDATE maintenance_jobs SET status='queued', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE status='leased' AND lease_expires_at < ?").run(now.toISOString(), now.toISOString());
      const row = this.db!.prepare("SELECT packet_id FROM maintenance_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").get() as { packet_id: string } | undefined;
      if (!row) return null;
      this.db!.prepare("UPDATE maintenance_jobs SET status='leased', attempts=attempts+1, lease_owner=?, lease_expires_at=?, updated_at=? WHERE packet_id=? AND status='queued'").run(owner, expires, now.toISOString(), row.packet_id);
      return this.db!.prepare("SELECT * FROM maintenance_jobs WHERE packet_id=?").get(row.packet_id) as Record<string, unknown>;
    });
    for (let skipped = 0; skipped < 64; skipped++) {
      const row = transaction();
      if (!row) return null;
      try { return this.toJob(row); }
      catch {
        // Legacy packets without the new authorization/media bindings must
        // fail closed without permanently blocking the next valid job.
        this.db!.prepare("UPDATE maintenance_jobs SET status='quarantined', lease_owner=NULL, lease_expires_at=NULL, last_error=?, updated_at=? WHERE packet_id=? AND status='leased' AND lease_owner=?")
          .run("Stored maintenance packet failed current security validation", now.toISOString(), row.packet_id, owner);
      }
    }
    return null;
  }

  async complete(packetId: string, owner: string): Promise<void> {
    await this.transition(packetId, owner, "completed");
  }

  async fail(packetId: string, owner: string, error: string, retryable: boolean, maxAttempts = 5): Promise<void> {
    await this.initialize();
    const row = this.db!.prepare("SELECT attempts FROM maintenance_jobs WHERE packet_id=? AND status='leased' AND lease_owner=?").get(packetId, owner) as { attempts: number } | undefined;
    if (!row) throw new Error("Maintenance job lease is not owned by this worker");
    const status = retryable && row.attempts < maxAttempts ? "queued" : retryable ? "dead_letter" : "quarantined";
    this.db!.prepare("UPDATE maintenance_jobs SET status=?, lease_owner=NULL, lease_expires_at=NULL, last_error=?, updated_at=? WHERE packet_id=?").run(status, error.slice(0, 4000), new Date().toISOString(), packetId);
  }

  async get(packetId: string): Promise<MaintenanceJob | null> {
    await this.initialize();
    const row = this.db!.prepare("SELECT * FROM maintenance_jobs WHERE packet_id=?").get(packetId) as Record<string, unknown> | undefined;
    return row ? this.toJob(row) : null;
  }

  close(): void { this.db?.close(); this.db = undefined; }

  private collectExpired(): void {
    // Only derived terminal queue entries are collected. Canonical revisions
    // and append-only provenance remain owned by the revision/audit stores.
    this.db!.prepare("DELETE FROM maintenance_jobs WHERE status IN ('completed','quarantined','dead_letter') AND updated_at <= ?")
      .run(new Date(Date.now() - MAINTENANCE_QUEUE_LIMITS.retentionMs).toISOString());
  }

  private async transition(packetId: string, owner: string, status: "completed"): Promise<void> {
    await this.initialize();
    const result = this.db!.prepare("UPDATE maintenance_jobs SET status=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE packet_id=? AND status='leased' AND lease_owner=?").run(status, new Date().toISOString(), packetId, owner);
    if (result.changes !== 1) throw new Error("Maintenance job lease is not owned by this worker");
  }

  private toJob(row: Record<string, unknown>): MaintenanceJob {
    return {
      packet: changePacketSchema.parse(JSON.parse(String(row.packet_json))), status: String(row.status), attempts: Number(row.attempts),
      lease_owner: row.lease_owner == null ? null : String(row.lease_owner), lease_expires_at: row.lease_expires_at == null ? null : String(row.lease_expires_at),
    };
  }
}
