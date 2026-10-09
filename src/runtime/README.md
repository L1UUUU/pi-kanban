# Runtime implementation and evidence boundary

The Host owns the shared `DatabaseSync`. `RuntimeSupervisor`, `ModelBudgetLedger`, and
`ModelBroker` never derive permission from Worker messages. Callbacks must use the same
trusted Host rule service as desktop controls. No module in this directory sends a paid
request, installs software, changes a Windows ACL, or launches a production Worker by default.

## Current execution paths

- `WindowsCandidateDriver`: unconditional fail-closed production path. It reports missing
  profile/evidence and bridge integration. Even a caller-supplied `verified: true` cannot
  enable execution. No Linux, shell, CLI, or unrestricted fallback exists.
- `SyntheticProcessDriver`: explicitly named Linux trusted-fixture harness. Tests execute
  real Node parent/child processes, check `/proc` birth identity/process group membership,
  signal only owned groups, and observe stopped writing. This is **not containment**:
  `setsid` escape, hostile code, and kill-on-Host-crash are not supported or claimed.
- `VerifiedWindowsDriver`: real helper transport/bootstrap, enabled only by the independent
  exact-machine/artifact/evidence verifier. It binds per-generation capability messages and
  native lifecycle proof; forged flags or class objects cannot enable it.
- `native/windows`: real Win32 candidate source and a Windows CTest probe, independently
  gated from production. See its README for commands and unverified limits.

## Supervision API

`new RuntimeSupervisor(db, driver, authorize)` initializes namespaced runtime tables.
`launch(request)` requires demand/role/grant/workspace/profile plus finite timeout and
output limits. It durably reserves a generation before launch. All states other than
`stopped` hold capacity: at most two demands, one writer per demand, one high-resource
check. Source-write privilege is only allowed for implementation.

`stop(runId, reason)` persists intent before signaling. Concurrent stop and launch honor
the durable intention. A matching-generation observation with zero controlled descendants
and explicit proof is required to release the lease. An exception after spawn leaves
`unknown`; PID absence, timeout, wrong generation, or a missing connection cannot release it.
`observe(runId)` is normal lifecycle observation. `recover()` is deliberately stricter:
it never launches or resumes, never clears usage, and quarantines unconfirmed live work.
`isDispatchAllowed` becomes false as soon as stop intention is recorded, including an
output-limit callback from the fixture driver. Call it for every tool/model dispatch.

## Budget and model boundary

Model grants bind exact canonical HTTPS destination, provider, model, roles, immutable
material identities/digests, credential reference (Host only), currency, expiration,
metering policy, and finite request/token/micro-currency amounts. Monetary units are
integer millionths of the named currency, not a claim of exact instantaneous billing.

Each invocation, including SDK retries, compaction, and auxiliary work, must reserve under
a distinct request ID before transmission. Reusing a reservation never permits another
provider call. Reservations are held for missing usage, disconnects, local abort, and
restart. Cumulative partial reports are monotonic and report-ID deduplicated; late final
reports settle unused reserves. If observed usage exceeds the estimate, actual usage is
retained and the grant is blocked. This cannot promise an instantaneous provider-side cap.

`ModelBroker` resolves approved immutable material in the Host, verifies actual content,
rechecks running authorization after async reads, and invokes a fixed transport binding.
It accepts no arbitrary URL, headers, credential, or endpoint redirect from a
Worker. The Pi endpoint persists exact transcript snapshots only after a trusted Host
context authorizer links them to explicit data permission; this is not semantic filtering. The production Host supplies the fixed-provider transport only after profile, explicit
model/data permission and finite-budget checks. A transport configuration flag is an
additional gate, not a replacement for signed Windows evidence or a trusted authorization
callback. Deterministic fixtures never contact a real provider. Ordinary continue and session changes do not add budget.

Persistent retry counters permit an original safe attempt plus two retries. Unknown side
effects forbid retry. Three complete no-progress cycles retain a block; resource waiting
is excluded, and resets require trusted substantive-progress evidence.

## Executed local checks

`node --test tests/runtime*.test.ts tests/agent*.test.ts` on Node 24.19.0/Linux has executed
SQLite persistence, conservative recovery, real trusted process-tree stopping, output-limit
stop, runtime timeout, explicit model/data scope, concurrent reservation, cumulative late
usage, abort accounting, retry/progress and actual Pi SDK deterministic assembly tests.
These cover subsets of PV-02/03/04/09 and FI-03/08/10/11/16. They do not establish Windows
PV-01, the complete Gates G1–G5, real model quality, or product acceptance.

## Authenticated profile provenance and installation trust

A hand-authored `passed` document, a profile flag, an evidence-file hash, or an adjacent
public key cannot enable `VerifiedWindowsDriver`. `profile.ts` requires a domain-separated
Ed25519 envelope from a separately pinned Host recorder, plus exact OS build, architecture,
Node/helper/Worker/Pi path-version-digest locks, policy digest, evidence ID, recorder digest,
recorder run/time metadata, and every mandatory passing probe. The same bounded file
snapshot supplies both signature verification and the reference hash. Unsigned, partial,
synthetic, failed, mismatched or `releaseAuthorized: false` reports are rejected.

A trusted installation provisions a fixed `windows-evidence-trust.json` file containing
`schemaVersion: 1`, `keyId`, `publicKeyPem` and `recorderSha256`. The operator separately
pins its SHA-256 through the Host-only startup settings `PI_KANBAN_RUNTIME_TRUST_DIR` and
`PI_KANBAN_RUNTIME_TRUST_SHA256`. These are supplied to the trusted desktop/Host at startup;
they are not imported runtime-profile fields and are never forwarded to Workers. The
loader validates the exact pin, bounded regular file, canonical non-reparse path, Ed25519
key and recorder digest. Missing trust is a blocker. There is no default signing key,
TOFU, evidence-local key import, or tool that blindly signs an arbitrary all-pass report.

The independent actual native recorder source and execution command are documented in
`native/windows/README.md`. Its current diagnostic output deliberately lacks full release
authority. A separately approved release recorder must execute and observe all required
probes on the exact locked artifacts and machine before producing a signed schema-v2
report; public trust provisioning alone cannot turn partial diagnostic evidence into a
pass. Its signing key must stay outside all Worker-readable resources. Thus profile import,
cryptographic verification, helper transport and recovery are implemented, while a complete
accepted release attestation is not claimed.

## Native command receipts and durable cleanup

`controlled_node` requests are executed by the native helper under the same AppContainer
SID and Job, with one finite command, exact arguments, bounded output and timeout. No
in-Worker spawn or unrestricted Host fallback exists. The Host accepts results only from
the helper's separate native pipe and validates generation/request/argument binding,
process birth, Win32 status, exit code, canonical bounded output and termination reason.
Worker reports or logs never prove a command passed.

`NativeRecoveryStore` persists Host-private per-run authentication state before launch.
Native cleanup receipts bind exact immutable runtime context and can prove zero Job
processes plus successful ACL revocation after Host loss. `recoverUnregistered` is an
explicit driver capability for the narrow launch-before-registration crash; generic
PID observation cannot use it. The synthetic cryptographic tests exercise tamper rejection
and restart behavior without claiming any Windows execution. Actual Windows EOF recovery
is separately exercised by the native Worker recorder.
