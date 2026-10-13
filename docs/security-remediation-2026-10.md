# October 2026 security remediation

This change addresses the two high and eleven medium findings reported for
`Tangtaizong-BUAA/ArgonMemory` at revision
`151c47707e5e61aa27360b28d968173dc207efdd`. It strengthens the deterministic
authorization, publication and resource-admission boundaries around MCP and
model-generated maintenance plans.

The table uses the scan's full `csf_…` finding IDs. The findings came from
workflow `wfr_c6c756838aa597eb549385b71456fd929ce55b0b7f8f56a6d29d76dee26e5a07`.
The table describes implemented controls and regression coverage; it does not
assert that a subsequent security scan has verified or closed a finding.

## Finding-to-change map

| Short ID | Severity and finding | Enforcement and regression coverage |
| --- | --- | --- |
| `csf_587d01e31b6ec8242d8ec366` | High: maintenance can replace an entire canonical document through an unrouted block key | `maintenance/contracts.ts`, `maintenance/blocks.ts` and `runtime.ts` issue and revalidate exact mutable-heading capabilities. Whole-document keys, unrouted targets, protected conflict headings and parents containing them are rejected. Replacement text cannot escape its heading through HTML, Setext headings or an unclosed code fence. `security-core.test.ts`: **rejects whole-document, unrouted and protected-parent edits at the runtime entry point**. |
| `csf_cda648ead05de58b5e47f0b5` | High: the model can choose a conflict outcome not authorized by the locked user statement | `kb_submit_user_resolution` requires an explicit structured user decision. The stored authorization binds the decision, exact statement, statement hash, conflict revision, source turn and authenticated principal. The runtime compares model output with that authorization before applying it. `security-core.test.ts`: **only the resolver's structured decision can be applied and legacy free-text locks fail closed**. |
| `csf_41356d89a563fd36560b0079` | Medium: read-only principals can create unbounded notice-receipt files | `client-notices.ts` uses a bounded SQLite receipt table with authenticated ownership, atomic count/rate checks and expiry. Another principal cannot acknowledge or mutate an existing receipt. `security-resource-boundaries.test.ts`, **authenticated bounded notice receipts**, covers racing claims, cardinality, global limits, expiry and requested legacy-receipt migration. |
| `csf_066a16b8f8c0da07b1f5d6f6` | Medium: `update_topology` can mutate arbitrary records without revision checks | Packet capabilities specify eligible routed main/section targets, exact record revisions and permitted added references. Runtime application rechecks type, project, visibility, current revision and reference eligibility. `security-core.test.ts`: **rejects unrouted topology targets, stale revisions and fabricated or foreign links**. |
| `csf_35ade616443e120fc19455bd` | Medium: an unsupported counterclaim can invalidate and reattribute accepted memories | A conflicting new candidate is quarantined. Evaluation does not change the original accepted record's status, creator or content. `security-core.test.ts`: **quarantines nonexistent, foreign, hidden, disputed and prefix-only evidence**, including preservation of the accepted record after a counterclaim. |
| `csf_19b995268aa4a6e867e5f2e6` | Medium: full immutable snapshots allow quadratic content storage and inode exhaustion | `revision-store.ts` hardlinks unchanged canonical files, writes replacements to new inodes and enforces persistent storage and mutation limits before allocating the next snapshot. Existing history is retained. `security-core.test.ts`, **security: immutable storage admission**, covers inode sharing, old-snapshot immutability, restart persistence, each admission limit and accounting for legacy manifests. |
| `csf_85362687dc3024514fd66734` | Medium: fabricated evidence references can promote claims to verified memory | References must resolve to eligible, visible records or evidence in the same project. Prefixes such as `user:` do not establish authority. Decision-like memories require an authenticated typed directive. Validation records the evidence revisions it actually used. `security-core.test.ts`: **quarantines nonexistent, foreign, hidden, disputed and prefix-only evidence** also covers valid promotion and its evidence snapshot. |
| `csf_c3906ac62d924cd8da498604` | Medium: `observe_conflict` ignores routing, revision and claim membership | Only a routed, currently open, visible conflict in the same project may be observed. The exact conflict revision and membership of every referenced claim are checked. `resolution_pending` conflicts are rejected. `security-core.test.ts`: **observations bind an open routed conflict, its exact revision and its own claims**. |
| `csf_71a183b3c214e2e346951bb6` | Medium: uploads can create unbounded retained maintenance packets and provider work | Packet construction and schemas bound raw media; queue admission atomically bounds serialized bytes and job counts by principal, project and database; the Python provider boundary independently checks raw sizes and SHA-256 before provider setup. `security-core.test.ts`: **oversized images remain local and never enter persistent provider packets**. `security-resource-boundaries.test.ts` covers queue admission, idempotency at capacity, terminal retention, invalid legacy packets and the Python media boundary. |
| `csf_f393e5fe593918018ba6e77e` | Medium: Markdown image references can relabel a more sensitive image | `retrieval/evidence.ts` confines relative images to artifact resource directories, establishes registered image ownership and includes owner labels in cache validity. Derived units carry `image_artifact_id`; the runtime checks the current owner's project and confidentiality again before returning pixels. `security-image-ownership.test.ts` covers sensitive/cross-project images, encoded parent paths, symlinks, owner-label changes and unregistered images. Existing retrieval tests retain valid local-image coverage. |
| `csf_740ac4017f7684e9ba1b3568` | Medium: concurrent initialization bypasses the MCP session limit | `project-http-server.ts` reserves capacity synchronously before transport creation/connect, counts pending and established sessions, and releases reservations on failure, close and expiry. `security-mcp-sessions.test.ts` covers simultaneous initialization, delayed connect, connection failure and JSON-RPC initialization failure. |
| `csf_0c54ec170b4a047657e265aa` | Medium: a maintenance plan can publish over a newer unchecked revision | `CanonicalRevisionStore.publish` compares `expectedParent` with the current pointer while holding the write lock, before creating the next snapshot. Maintenance application, conflict authorization and memory validation use that compare-and-swap boundary. `security-core.test.ts`: **rejects canonical publication if another writer commits after plan validation** and the stale-parent storage assertion. |
| `csf_9e2e5cc6a45c150fee874ed6` | Medium: chunked uploads lack aggregate quotas and independent expiration | Uploads reserve their declared bytes and count before asynchronous file creation. Ownership includes the authenticated actor and knowledge root. Append/commit operations exclude one another, and independent sweeping removes expired temporary files. `security-chunk-uploads.test.ts` covers simultaneous begins, principal/global count and byte limits, expiry without another request, creation failure, competing operations, ownership, failed publication cleanup and a successful 100 MiB byte-API commit. |

All named tests are under `test/`; implementation paths above are relative to
`src/project/` unless the MCP or Python boundary is explicitly named.

## Required resolver API change

`kb_submit_user_resolution` remains restricted to a `project-resolve` principal
with the project-owner or designated-resolver role. Its request now requires
`resolution_decision` in addition to `conflict_id`,
`expected_conflict_revision`, `resolution_statement`, `source_turn_ref`,
`user_statement_hash` and `idempotency_key`. The server supplies
`actor_principal` from authentication; the caller does not choose it.

For example, the structured part of a user decision to leave a conflict open is:

```json
{
  "resolution_decision": {
    "outcome": "remain_open",
    "affected_claim_refs": [],
    "resulting_scopes": []
  }
}
```

The allowed outcomes are:

- `supersede_one_claim`
- `accept_multiple_claims_with_narrowed_scopes`
- `reject_all_claims_and_record_new_statement`
- `reject_candidate_claim`
- `remain_open`

Both arrays are required and contain at most 50 nonempty strings of at most
2,000 characters each. Affected claims must be unique members of the identified
conflict. An outcome other than `remain_open` requires affected claims. Accepting
multiple claims with narrowed scopes requires at least two claims and one scope
per claim, in the corresponding order. The statement is limited to 4,000
characters and its SHA-256 must match `user_statement_hash`. The expected
conflict revision is the current canonical record digest, not a guessed revision
or an arbitrary identifier.

The structured choice must come from the authenticated user's authorization.
Clients must collect that choice explicitly; a model must not fill in missing
authorization by interpreting a previously locked natural-language statement.
Submission locks the statement and queues maintenance. It does not immediately
resolve the conflict. Reusing an idempotency key with different authorization is
rejected, while an exact replay can return the original result.

Existing resolution packets that lack the structured decision and authorization
hash fail closed. Obtain a fresh authorized decision and regenerate the packet
through the supported runtime workflow. Do not fabricate those fields in a queue
row. Queue leasing quarantines invalid legacy packets and continues to other
valid jobs; a blocked legacy conflict may require an administrator to reconcile
its pending state before a fresh authorized submission.

## Maintenance-plan compatibility

Maintenance packets now carry exact `mutable_blocks`, `topology_targets` and
`routed_conflicts` capabilities. A model can use only the capabilities present in
that packet. Empty/default capability lists grant no write authority. Regenerate
stale or older packets from current canonical records; do not reuse a prior
record hash as a substitute for the current capability.

Document patches accept only explicit `heading:…` keys. Whole-document and
comment-delimited block edits are no longer accepted. A heading containing a
protected conflict subsection is also unavailable for replacement. Runtime
application repeats validation even when invoked without the normal worker
adapter. A concurrent canonical change causes publication to fail with a stale
parent error and requires a fresh plan.

Evidence references that previously passed because they were nonempty or had an
authority-looking prefix can now cause a candidate to be quarantined. Accepted
knowledge is not downgraded merely because a contributor submits a differing
statement. The candidate and validation event remain available for governed
review.

## Resource limits and their scope

MiB and GiB below mean powers of 1,024. These are application admission limits;
they do not replace a deployment's filesystem, process or provider-account
limits.

| Resource | Default or hard admission limit | Accounting scope and expiry |
| --- | --- | --- |
| Canonical records in a snapshot | 10,000 | One canonical revision store. |
| Retained snapshot entries | 1,000,000 | All retained snapshots; each revision also charges six fixed directory/manifest entries. Hardlinked file entries still count. |
| Retained canonical content | 2 GiB | Distinct retained file inodes, including historical copies from older stores. This is canonical content, not a quota on all uploaded originals or total filesystem bytes. |
| One canonical publication | 1,000 mutations and 16 MiB UTF-8 mutation content | Checked under the publication lock before allocating the snapshot. |
| One chunked resource | 100 MiB | A temporary upload; each decoded chunk is at most 4 MiB. |
| Pending chunk uploads per principal | 4 uploads and 200 MiB declared bytes | Per authenticated principal and knowledge root within the server process. Empty/pending files consume the entire reservation. |
| Pending chunk uploads globally | 16 uploads and 512 MiB declared bytes | Across the server process. Expire 30 minutes after begin; a 60-second sweeper runs independently of requests. |
| One maintenance media asset | 8 MiB decoded bytes | Required `size_bytes`; canonical base64, MIME prefix and declared size are checked. The live Python boundary also checks SHA-256. |
| Media in one maintenance packet | 16 MiB decoded bytes and at most 12 assets | A packet may specify a smaller `max_multimodal_bytes` or asset budget. |
| Serialized maintenance packet | 24 MiB UTF-8 JSON | Before persistent queue admission. The Python line-input boundary is 25 MiB. |
| Retained queue per principal | 64 jobs and 64 MiB serialized packets | One queue database, including terminal rows until expiry. |
| Retained queue per project | 128 jobs and 128 MiB serialized packets | One queue database. |
| Retained queue globally | 512 jobs and 256 MiB serialized packets | One queue database. Completed, quarantined and dead-letter rows expire after 30 days and are collected during enqueue/lease. Active jobs are retained. |
| Client-notice receipts | 32 per principal; 4,096 total; 8 new receipts per principal per hour | One receipt database shared by processes using the same knowledge root. Receipts expire after 30 days and are collected on receipt operations. |
| MCP sessions | Configured `maxSessions`, default 1,024; per principal at most `min(maxSessions, 64)` | One HTTP server instance; counts pending and initialized sessions. Default idle/pending TTL is 30 minutes, with a configured minimum of 60 seconds. |
| MCP request body | Default 14 MiB | Existing configurable HTTP boundary; session reservations are in addition to this limit. |
| Retrieval image read | 10 MiB per nonempty image | A separate local retrieval boundary; it does not expand the maintenance-provider media allowance. |

Canonical-store constructor overrides are trusted deployment configuration and
must be finite positive safe integers. Their ceilings are 1,000,000 records,
100,000,000 retained entries, 1 TiB retained content, 100,000 mutations and 1 GiB
mutation content. These options are not accepted from maintenance-model output.
Session and upload limits apply per server process/instance as described above;
operators running multiple instances must account for their combined capacity.

Maintenance retains its existing per-packet ceilings of eight tool calls,
12,000 cumulative input tokens, 6,000 context tokens per step, 3,000 cumulative
output tokens, six sections and 40 evidence units. Raw-media admission is now
independent of text-token accounting. `max_cost_usd` is not a substitute for these
byte limits or a guarantee about the provider's invoice.

A larger resource can still be published locally through the normal resource
workflow, but image/video bytes over the maintenance media limit are omitted
from the provider packet and this omission is recorded in its context. Chunked
commit calls `publishResourceBytes` directly, avoiding a second whole-resource
base64 representation. A live provider call accepts only inline media whose size
and SHA-256 have been verified; a `signed_url` descriptor alone is rejected.
Supporting remote media later requires a bounded download and integrity check
before provider admission.

## History, migration and capacity handling

Canonical history remains append-only. Unchanged committed files are shared by
hardlink; changed files get new inodes, so updating a current record cannot edit
its historical versions. The first import of a mutable legacy canonical tree
copies its files instead of linking to that mutable source. New manifests persist
usage totals. Older manifests remain unchanged and are accounted for by scanning
the retained files when required, with inode-based deduplication.

Quota checks happen under the write lock before directory allocation. A rejected
publication leaves the current pointer and old snapshots intact. Hitting a
canonical quota requires an administrator to provision capacity, adjust bounded
trusted limits or migrate the complete retained history to suitable storage.
The implementation does not silently delete canonical history to make room.

Operational state has separate retention. Terminal maintenance packets and
client-notice receipts may expire; canonical records and provenance events do
not. Streamed cleanup retires only legacy notice files older than 30 days. A
requested fresh legacy receipt migrates on demand and then only that device's old
files are removed. Unrequested fresh receipts remain available to preserve
upgrade deduplication. Notice deduplication remains shared for the same
device/campaign, while acknowledgement
ownership is bound to the creating principal. Because receipt retention is
bounded, the server can issue a notice again after its receipt expires; clients
should retain their own acknowledgement when they require a longer display
suppression period.

Image retrieval now rejects references that cross an artifact's resource
directory or cannot establish an authorized owner. Register the appropriate
image artifact or place a derived image within its owning artifact's resource
directory. Changing an image owner's confidentiality invalidates cached evidence;
read-time owner checks apply again before returning bytes. Unavailable images
remain explicit coverage gaps rather than silently becoming lower-confidentiality
evidence.

## Validation and scan follow-up

Final integrated validation passed `npm run check`, `npm run build` and the
complete default-parallel `npm test` suite: **17 files, 211 passed, 1 skipped**.
The security additions exercise real HTTP initialization races, upload
reservations and expiration, image ownership, immutable snapshots and canonical
publication races. The final upload cleanup regression also preserves another
live process or same-process module instance's files while reclaiming dead-owner
and expired legacy uploads.

Search smoke, benchmark Python compilation, both synthetic benchmark smoke
suites and `npm pack --dry-run` also passed. These smoke results verify wiring,
not model accuracy or performance scores. No live provider requests were made.
`architecture-sync.json` target hashes were refreshed without altering upstream
source hashes. GitHub Actions verifies the final pull-request commit separately.

Suggested complete verification commands:

```sh
npm run check
npm run build
npm test
```

This patch does not change finding status in Codex Security Cloud. After review
and integration, scan the intended repository revision again and assess the new
scan evidence before closing the reported findings.
