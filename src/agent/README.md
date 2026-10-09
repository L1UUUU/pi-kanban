# Explicit Pi SDK adapter

Primary reference checked 2026-10-09: https://pi.dev/docs/latest/sdk
Installed and executed package: `@earendil-works/pi-coding-agent` 1.1.0.
Companion public API: `@earendil-works/pi-ai` 1.1.0.

`createSyntheticPiSession` actually calls the installed public SDK with explicit model
runtime, model, scoped models, in-memory credential/catalog stores, settings, resource
loader, native session manager, tools, and private agent directory. It registers a local
deterministic transport with a `.invalid` base URL; it never invokes a paid model or HTTP.
The synthetic response is deliberately test data, not an autonomous implementation/review.

The resource loader does not use `DefaultResourceLoader`, global/ancestor discovery,
file-based extensions, or default shell/file tools. Host-resolved material digests are
checked before assembly. Reviewer inputs reject implementation transcripts and equivalent
summaries; Reviewer sessions must start empty. Pi native sessions are the authoritative
history. The actual SDK persistence/open APIs are tested instead of editing messages arrays.

`PiLifecycle` observes `agent_settled`, not `agent_end`, for quiescence. Neither event
accepts a user result or marks a business demand complete. Tests execute actual queued
follow-up behavior and a native JSONL session round-trip, not mocked factory signatures.

## Bounded Host broker path (implemented and tested without a paid model)

`createBrokeredPiSession` is the genuine SDK-to-Host adapter. It registers one explicit
custom provider whose only transport is a `PiModelChannel`. It holds no provider URL,
headers or credentials; the `.invalid` SDK compatibility URL is never requested.
Explicit controlled tools can produce actual SDK tool loops. Ordinary turns, automatic
SDK retries and manual SDK compaction have all executed through this adapter in tests.

`FramedPiModelChannel` sends bounded model-only frames. `HostPiBrokerEndpoint` verifies a
private 256-bit capability, generation, session and durable monotonic sequence. The Host,
not the frame, selects the grant, provider, model, destination, role and reservation limits.
The Host's context authorizer must link each exact context snapshot to existing explicit
permission for its source scope; that authorization and immutable bytes are persisted.
No automatic secret detector or Worker self-attested provenance is claimed. Derived input
permissions add no spending authority and every call uses the same surviving budget.

`PrivateModelPipeClient` / `PrivateModelPipeServer` implement bounded length framing,
response correlation, maximum in-flight/buffer sizes and cancellation independent of
output drain. They are tested with real Node streams, not native Windows inherited pipes;
the native helper/driver association and evidence gate are implemented, with actual Windows validation still pending.

The brokered SDK tests use the real installed SDK and deterministic Host provider transport,
including a custom tool invocation, actual automatic retry with unknown earlier usage held,
and actual compaction. They demonstrate interception/accounting, not paid model quality.

## Native Worker bootstrap (Node-only; target Windows validation pending)

`worker-main.ts` is a separate Windows x64 entry accepting only the locked native generation.
`worker-runtime.ts` binds a fresh Pi native session ID, immutable role/material/method context,
capability model channel, report receipts and lifecycle events. It imports no synthetic adapter.
`controlled-tools.ts` offers bounded source read/list/search/write/delete, isolated Node execution and typed
Host reporting. Read-only roles have no source-write tool. Tool timeout/output overflow asks
for whole-Job stop instead of claiming killing one child controls its descendants.

The complete Worker -> actual SDK -> controlled report -> framed Host broker -> persisted budget
-> report receipt -> settled path has executed with synthetic Node streams and deterministic
provider responses. The same native entry is wired to `VerifiedWindowsDriver`; its machine,
artifact hashes, private handles and actual ACL/Job evidence must pass before real launch.

## Staged planning integration

Production planning uses `design-feature-staged-v1`; plain `explicit-text-v1`
planning is accepted only by the explicitly synthetic composition path.
`planning-skills.ts` reconstructs the immutable private entry and exact public
dependency graph from frozen Host materials. Each fresh Worker gets only its
selected skill and owned references. Pi's real `ResourceLoader.getSkills()`
registers its original metadata, including disabled invocation flags.

`controlled_skill` and `controlled_skill_resource` return original bodies only
after the authenticated `worker.skill-request` receives the Host receipt.
No method body is initially injected, and no arbitrary skill, filesystem or
network resource can be selected. Staged `getAgentsFiles()` stays empty; approved
source and generated artifacts enter the labeled untrusted task-data lane.
The upstream originals and restrictions stay unchanged; scoped automatic Host
invocation and local artifact destinations are documented in
[the resource adapter contract](../../docs/planning-method-bundle.md).

The private bootstrap binds flow ID/revision, step and exact input digest.
Facts and design review use separate fresh read-only contexts; all planning
stages have no source write/delete tools and cannot implement tickets. Bounded
`controlled_node` checks remain available for fact investigation and validation
under the existing read-only role, finite native/runtime/model grant and private
scratch limits. They cannot modify source or use a shell/child-IPC fallback.
The Host requires
observed primary-skill loading and verified process stop before accepting a
typed stage handoff. It rejects legacy plan reports, stale flow state and
unverified artifact references. Requirement understanding and final reviewed
design/test seams have distinct owner confirmations before local spec/tickets.
Planning completion never grants implementation permission.

The installed-Pi resource tests exercise progressive tool loading and rejection
paths. The production journey tests exercise these same methods through actual
Worker/Host framing using deterministic provider responses and synthetic native
observations. The private entry stays external; no private text is checked into
test fixtures. These tests do not establish real-model output quality or native
isolation. Consult the exact-commit CI and its individual job outcomes.

## implement-spec execution resources

Implementation and Review both retain the pinned `implement-spec` root identity
through a separate execution bundle. Each private stage loads that root and its
TDD or code-review dependency progressively; successful model consumption of
both exact bodies is required before a nonblocked handoff. Contexts always start
empty, with source/artifact data outside system instructions. The Host owns the
serial frontier, exact base-to-K evidence (including uncommitted changes),
read-only Standards/Spec contexts and focused repair scope. It never grants
upstream shell, multi-worktree, reset, push or PR actions.

The [execution adapter contract](../../docs/implementation-method-bundle.md)
records the original provenance and explicit scoped differences. Installed SDK
journeys and local Node test receipts exercise behavior with a deterministic
provider and explicitly synthetic native observations; real confinement remains
a separately measured gate.

## Deliberately remaining

- Complete the target Windows 11 private-handle and isolation matrix. Hosted-Windows actual Node/Pi probes passed; no in-process test substitutes for target evidence.
- Validate real provider cancellation/late billing under explicitly authorized data/spend limits.
- Explicitly configure the external private design-feature entry and the pinned
  public method bundle for each installation; validate real-model behavior under
  approved data and spend limits.
- Verify the exact Node/Pi combination and full role/ACL/read boundary matrix. Bash/POSIX is excluded from the approved first product scope.
- Run genuine planning, implementation, independent review, repair, and human acceptance.

The production Windows driver stays disabled while those prerequisites are unresolved.
The real SDK no-model tests prove assembly/lifecycle behavior only, not real model quality
or external OS isolation.

The production Worker advertises no shell tool and rejects a shell-enabled bootstrap. Native Node checks preserve source and use private scratch; edits require the mediated write/delete path. Node tests must explicitly use `--test-isolation=none`; default process-isolated `node --test` is outside the current scope. Test bodies, dependencies and direct JavaScript CLI entry points must not create child-process pipes or IPC named pipes. Their files/dependencies must already be within authorized resources; npm scripts do not gain a shell fallback. A required check that needs process isolation stays unsupported rather than having its semantics silently changed.

The pinned Node 24.19.0 native fixture in [run 37903915830](https://github.com/L1UUUU/pi-kanban/actions/runs/37903915830) timed out without parent-readiness output during `child_process.spawn` setup with `stdio: 'pipe'` under LPAC. The [pinned libuv source](https://github.com/nodejs/node/blob/v24.19.0/deps/uv/src/win/pipe.c#L194-L219) supports an access-denied retry loop in the global pipe namespace as an explanation; this is an inference, and no Win32 syscall trace was captured. No broader namespace permission or locked-version change bypasses the failure, which remains historical evidence. A real `node --test --test-isolation=none` fixture is part of the required native recorder; consult the exact-commit Windows run for its result. Portable tests and the earlier Node/Pi probes do not establish that this check has passed.
