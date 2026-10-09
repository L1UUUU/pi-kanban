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
the latter transport association and runtime evidence gate still require integration.

The brokered SDK tests use the real installed SDK and deterministic Host provider transport,
including a custom tool invocation, actual automatic retry with unknown earlier usage held,
and actual compaction. They demonstrate interception/accounting, not paid model quality.

## Deliberately remaining

- Wire a native Windows private capability channel to the Host model broker and controlled
  file/report tools after the complete isolation evidence is verified.
- Connect the implemented brokered adapter/codec to authenticated native handles and validate
  real provider cancellation/late billing under the authorized single provider/model.
- Obtain actual design-feature and downstream method sources/digests.
- Verify Windows Node/Git Bash/Pi compatibility and full role/ACL/read boundary matrix.
- Run genuine planning, implementation, independent review, repair, and human acceptance.

The production Windows driver stays disabled while those prerequisites are unresolved.
The real SDK no-model tests prove assembly/lifecycle behavior only, not real model quality
or external OS isolation.
