import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { changePacketSchema, type ChangePacket } from "./contracts.js";

export type MaintenanceJob = { packet: ChangePacket; status: string; attempts: number; lease_owner: string | null; lease_expires_at: string | null };

export class MaintenanceQueue {
  readonly path: string;
  private db?: Database.Database;

  constructor(path: string) { this.path = path; }

  async initialize(): Promise<void> {
    if (this.db) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.pragma("journal_mode = WAL");
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
  }

  async enqueue(packetInput: ChangePacket): Promise<{ packet_id: string; inserted: boolean }> {
    await this.initialize();
    const packet = changePacketSchema.parse(packetInput);
    const time = new Date().toISOString();
    const result = this.db!.prepare(`INSERT OR IGNORE INTO maintenance_jobs
      (packet_id,idempotency_key,packet_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(packet.packet_id, packet.idempotency_key, JSON.stringify(packet), "queued", time, time);
    const row = this.db!.prepare("SELECT packet_id FROM maintenance_jobs WHERE idempotency_key = ?").get(packet.idempotency_key) as { packet_id: string };
    return { packet_id: row.packet_id, inserted: result.changes === 1 };
  }

  async lease(owner: string, ttlMs = 120_000): Promise<MaintenanceJob | null> {
    await this.initialize();
    const now = new Date();
    const expires = new Date(now.getTime() + ttlMs).toISOString();
    const transaction = this.db!.transaction(() => {
      this.db!.prepare("UPDATE maintenance_jobs SET status='queued', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE status='leased' AND lease_expires_at < ?").run(now.toISOString(), now.toISOString());
      const row = this.db!.prepare("SELECT packet_id FROM maintenance_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").get() as { packet_id: string } | undefined;
      if (!row) return null;
      this.db!.prepare("UPDATE maintenance_jobs SET status='leased', attempts=attempts+1, lease_owner=?, lease_expires_at=?, updated_at=? WHERE packet_id=? AND status='queued'").run(owner, expires, now.toISOString(), row.packet_id);
      return this.db!.prepare("SELECT * FROM maintenance_jobs WHERE packet_id=?").get(row.packet_id) as Record<string, unknown>;
    });
    const row = transaction();
    return row ? this.toJob(row) : null;
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
