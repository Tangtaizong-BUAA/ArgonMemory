import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { CLIENT_NOTICE_LIMITS, DEFAULT_PROJECT_NOTICE, deliverClientNotice } from "../src/project/client-notices.js";
import { MaintenanceQueue, MAINTENANCE_QUEUE_LIMITS } from "../src/project/maintenance/queue.js";
import { changePacketSchema } from "../src/project/maintenance/contracts.js";

const roots: string[] = [];
const queues: MaintenanceQueue[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(async () => { vi.restoreAllMocks(); for (const queue of queues.splice(0)) queue.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const value = await mkdtemp(join(tmpdir(), "argon-security-boundary-")); roots.push(value); return value; }
async function queue() { const value = new MaintenanceQueue(join(await root(), "queue.sqlite")); queues.push(value); await value.initialize(); return value; }
function packet(index = 0, actor = "alice", project = "project:test") {
  return changePacketSchema.parse({ schema: "argon-memory-change-packet/v1", packet_id: `packet:${index}`, project_id: project, actor_principal: actor, idempotency_key: `security-packet-${index}`,
    trigger: "resource_published", base_revisions: { knowledge_revision: "revision", topology_revision: "topology", index_revision: "index" }, evidence_refs: [], candidate_section_refs: [], open_conflict_refs: [], text_context: "Synthetic evidence",
    media: [], budget: { max_cost_usd: 0.5 }, egress_policy: { maximum_confidentiality: "internal", provider: "alibaba_model_studio", region: "cn-beijing" } });
}

describe("authenticated bounded notice receipts", () => {
  test("racing distinct device claims cannot exceed the principal rate and cannot mutate another principal's receipt", async () => {
    const directory = await root();
    const claims = await Promise.allSettled(Array.from({ length: 24 }, (_, index) => deliverClientNotice(directory, { device_id: hash(`device-${index}`) }, DEFAULT_PROJECT_NOTICE, "alice")));
    expect(claims.filter(result => result.status === "fulfilled")).toHaveLength(CLIENT_NOTICE_LIMITS.perPrincipalPerHour);
    const db = new Database(join(directory, "client-notices/receipts.sqlite"));
    try {
      const rows = db.prepare("SELECT * FROM client_notice_receipts").all() as any[];
      expect(rows).toHaveLength(8); expect(rows.every(row => row.principal_hash === hash("alice"))).toBe(true);
      const chosen = claims.findIndex(result => result.status === "fulfilled");
      const device_id = hash(`device-${chosen}`);
      expect((await deliverClientNotice(directory, { device_id }, DEFAULT_PROJECT_NOTICE, "bob")).display).toBe(false);
      await deliverClientNotice(directory, { device_id, action: "ack" }, DEFAULT_PROJECT_NOTICE, "bob");
      expect(db.prepare("SELECT acknowledged_at FROM client_notice_receipts WHERE device_hash=?").get(hash(device_id))).toEqual({ acknowledged_at: null });
      expect((await deliverClientNotice(directory, { device_id, action: "ack" }, DEFAULT_PROJECT_NOTICE, "alice")).status).toBe("acknowledged");
    } finally { db.close(); }
  });

  test("principal cardinality stays fixed across rate windows and expired receipts reclaim capacity", async () => {
    const directory = await root(), clock = vi.spyOn(Date, "now"); const start = Date.now();
    for (let index = 0; index < CLIENT_NOTICE_LIMITS.perPrincipal; index++) {
      clock.mockReturnValue(start + Math.floor(index / 8) * 3_600_001);
      await deliverClientNotice(directory, { device_id: hash(`device-${index}`) }, DEFAULT_PROJECT_NOTICE, "alice");
    }
    clock.mockReturnValue(start + 5 * 3_600_001);
    await expect(deliverClientNotice(directory, { device_id: hash("overflow") }, DEFAULT_PROJECT_NOTICE, "alice")).rejects.toThrow("capacity");
    clock.mockReturnValue(start + CLIENT_NOTICE_LIMITS.retentionMs + 6 * 3_600_001);
    expect((await deliverClientNotice(directory, { device_id: hash("new-after-expiry") }, DEFAULT_PROJECT_NOTICE, "alice")).display).toBe(true);
    const db = new Database(join(directory, "client-notices/receipts.sqlite"));
    try { expect(db.prepare("SELECT COUNT(*) AS count FROM client_notice_receipts").get()).toEqual({ count: 1 }); } finally { db.close(); }
  });

  test("global capacity applies across principals and a requested legacy receipt is migrated without reannouncement", async () => {
    const directory = await root(), device_id = hash("legacy-device"), campaign = join(directory, "client-notices", DEFAULT_PROJECT_NOTICE.notice_id);
    await mkdir(campaign, { recursive: true }); await writeFile(join(campaign, `${hash(device_id)}.delivered.json`), "{}\n");
    expect((await deliverClientNotice(directory, { device_id }, DEFAULT_PROJECT_NOTICE, "legacy-owner")).status).toBe("already_delivered");
    const db = new Database(join(directory, "client-notices/receipts.sqlite"));
    try {
      const insert = db.prepare("INSERT INTO client_notice_receipts VALUES (?,?,?,?,NULL)");
      db.transaction(() => { for (let index = 1; index < CLIENT_NOTICE_LIMITS.total; index++) insert.run(DEFAULT_PROJECT_NOTICE.notice_id, hash(`seed-${index}`), hash(`actor-${index}`), Date.now()); })();
      await expect(deliverClientNotice(directory, { device_id: hash("global-overflow") }, DEFAULT_PROJECT_NOTICE, "new-principal")).rejects.toThrow("capacity");
      expect(db.prepare("SELECT COUNT(*) AS count FROM client_notice_receipts").get()).toEqual({ count: CLIENT_NOTICE_LIMITS.total });
    } finally { db.close(); }
    await expect.poll(async () => (await readdir(campaign).catch(() => []))).toEqual([]);
  });

  test("upgrading preserves an unrequested fresh legacy device and collects only expired legacy receipts", async () => {
    const directory = await root(), campaign = join(directory, "client-notices", DEFAULT_PROJECT_NOTICE.notice_id);
    await mkdir(campaign, { recursive: true });
    const requested = hash("requested-device"), untouched = hash("unrequested-device"), expired = hash("expired-device");
    for (const device of [requested, untouched, expired]) for (const event of ["delivered", "shown"]) {
      const path = join(campaign, `${hash(device)}.${event}.json`); await writeFile(path, "{}\n");
      if (device === expired) { const time = new Date(Date.now() - CLIENT_NOTICE_LIMITS.retentionMs - 1000); await utimes(path, time, time); }
    }
    expect((await deliverClientNotice(directory, { device_id: requested }, DEFAULT_PROJECT_NOTICE, "migrated-owner")).status).toBe("already_delivered");
    await expect.poll(async () => await stat(join(campaign, `${hash(expired)}.delivered.json`)).catch(() => null)).toBeNull();
    await expect.poll(async () => (await readdir(campaign)).sort()).toEqual([`${hash(untouched)}.delivered.json`, `${hash(untouched)}.shown.json`].sort());
    expect(await readFile(join(campaign, `${hash(untouched)}.delivered.json`), "utf8")).toBe("{}\n");
  });
});

describe("maintenance queue admission", () => {
  test("principal depth checks are atomic and retries remain idempotent at capacity", async () => {
    const q = await queue();
    const results = await Promise.allSettled(Array.from({ length: MAINTENANCE_QUEUE_LIMITS.principalJobs + 4 }, (_, index) => q.enqueue(packet(index))));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(MAINTENANCE_QUEUE_LIMITS.principalJobs);
    expect(await q.enqueue(packet(0))).toEqual({ packet_id: "packet:0", inserted: false });
    expect(await q.enqueue(packet(1000, "bob"))).toEqual({ packet_id: "packet:1000", inserted: true });
  });

  test("global depth remains bounded across independently valid principals and projects", async () => {
    const q = await queue();
    for (let index = 0; index < MAINTENANCE_QUEUE_LIMITS.totalJobs; index++) await q.enqueue(packet(index, `actor-${Math.floor(index / 32)}`, `project:${Math.floor(index / 64)}`));
    await expect(q.enqueue(packet(9999, "fresh-actor", "project:fresh"))).rejects.toThrow("global queue capacity");
  });

  test("serialized packet and aggregate principal bytes are enforced for valid media packets", async () => {
    const q = await queue();
    await expect(q.enqueue({ ...packet(), text_context: "x".repeat(MAINTENANCE_QUEUE_LIMITS.packetBytes) })).rejects.toThrow("serialized packet");
    const bytes = Buffer.alloc(8 * 1024 * 1024, 1), value = `data:image/png;base64,${bytes.toString("base64")}`;
    const media = { evidence_id: "evidence:synthetic", artifact_id: "artifact:synthetic", modality: "image" as const, mime_type: "image/png", sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length, locator: {}, transport: "base64_data_uri" as const, value, native_video_required: false };
    for (let index = 0; index < 5; index++) await q.enqueue({ ...packet(index), media: [media] });
    await expect(q.enqueue({ ...packet(6), media: [media] })).rejects.toThrow("principal queue capacity");
    expect((await q.get("packet:0"))?.packet.media[0]?.size_bytes).toBe(bytes.length);
  }, 20_000);

  test("terminal retention reclaims derived packets but preserves active jobs and a canonical sentinel", async () => {
    const q = await queue(); await q.enqueue(packet()); await q.enqueue(packet(1));
    const leased = await q.lease("worker"); expect(leased?.packet.packet_id).toBe("packet:0"); await q.complete("packet:0", "worker");
    const sentinel = join(q.path, "..", "canonical-sentinel.md"); await writeFile(sentinel, "append-only provenance");
    const db = new Database(q.path);
    try { db.prepare("UPDATE maintenance_jobs SET updated_at=?").run(new Date(Date.now() - MAINTENANCE_QUEUE_LIMITS.retentionMs - 1).toISOString()); } finally { db.close(); }
    await q.enqueue(packet(2));
    expect(await q.get("packet:0")).toBeNull(); expect((await q.get("packet:1"))?.status).toBe("queued");
    expect(await readFile(sentinel, "utf8")).toBe("append-only provenance");
  });

  test("an unsafe legacy packet is quarantined without blocking the next valid job", async () => {
    const q = await queue(); await q.enqueue(packet(0)); await q.enqueue(packet(1));
    const db = new Database(q.path);
    try { db.prepare("UPDATE maintenance_jobs SET packet_json=? WHERE packet_id=?").run(JSON.stringify({ ...packet(), locked_user_resolution_ref: "unbound-legacy-resolution" }), "packet:0"); } finally { db.close(); }
    expect((await q.lease("worker"))?.packet.packet_id).toBe("packet:1");
    const check = new Database(q.path);
    try { expect(check.prepare("SELECT status,lease_owner FROM maintenance_jobs WHERE packet_id='packet:0'").get()).toEqual({ status: "quarantined", lease_owner: null }); } finally { check.close(); }
  });
});

test("the Python provider boundary validates decoded media budgets and rejects unverified URL sizes before provider setup", () => {
  const worker = fileURLToPath(new URL("../src/backends/python/cyj_maintenance_worker.py", import.meta.url));
  const script = `
import asyncio, base64, hashlib, importlib.util, sys
spec = importlib.util.spec_from_file_location('worker', sys.argv[1]); module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
data = b'valid synthetic pixels'
media = {'modality':'image','mime_type':'image/png','transport':'base64_data_uri','value':'data:image/png;base64,'+base64.b64encode(data).decode(),'sha256':hashlib.sha256(data).hexdigest(),'size_bytes':len(data)}
packet = {'media':[media], 'budget':{'max_multimodal_bytes':len(data),'max_multimodal_assets':1,'max_context_tokens_per_step':6000}}
assert len(module._content(packet)) == 2
for bad in [dict(packet, budget=dict(packet['budget'],max_multimodal_bytes=len(data)-1)),dict(packet,media=[dict(media,size_bytes=1)]),dict(packet,media=[dict(media,transport='signed_url',value='https://invalid.test/oversized',size_bytes=1)])]:
    try: asyncio.run(module._live_plan(bad, {}))
    except ValueError as exc: assert 'media' in str(exc)
    else: raise AssertionError('unadmitted media reached provider')
large = b'x' * (6 * 1024 * 1024)
asset = dict(media, size_bytes=len(large), value='data:image/png;base64,'+base64.b64encode(large).decode(), sha256=hashlib.sha256(large).hexdigest())
try: module._content({'media':[asset]*3, 'budget':{'max_multimodal_bytes':16*1024*1024,'max_multimodal_assets':3}})
except ValueError as exc: assert 'budget' in str(exc)
else: raise AssertionError('aggregate media budget bypassed')
print('media admission checks passed')
`;
  const result = spawnSync("python3", ["-c", script, worker], { encoding: "utf8", timeout: 15_000 });
  expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain("media admission checks passed");
});
