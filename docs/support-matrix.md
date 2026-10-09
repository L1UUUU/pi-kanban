# First supported scope: Node-native controlled tools

The approved first product combination is **Node 24 + pinned Pi Worker + Windows
native isolation, with no shell**. This is a scoped implementation target, not a
claim that Windows 11 release acceptance is complete. Production stays closed
until independent exact-machine evidence, trusted methods, permitted materials
and separate finite model authorization are present.

## Capabilities

| Operation | Current scope | Boundary |
|---|---|---|
| Read and list source | Controlled Node tools | Demand-relative paths; Git/local metadata, links, private and unrelated demand resources excluded |
| Search source | Bounded literal Node search | File, byte and result limits; no regex engine or external grep/find process |
| Write/delete source | Implementation-only mediated tools | Exact Host authorization and independent post-write source verification; read-only roles cannot write |
| Test source | Native `controlled_node` | Exact locked Node executable, same AppContainer/Job, finite output/time, genuine native result receipt |
| JavaScript CLI | Direct Node entry point where applicable | The script and dependencies must already be within authorized resource scope; source-preserving commands and private scratch only |
| Plan/review/repair/accept | Connected Host/Pi workflow | Independent sessions, version-bound decisions and actual-stop handoff; deterministic tests are not real model quality acceptance |
| Git lifecycle | Trusted bounded Host operations | Worktree/baseline/optional explicitly granted local commit; no automatic remote writes |
| Bash, POSIX pipelines, PowerShell/cmd | Excluded | No shell in product config, Worker capability or tool registration; no fallback |
| npm scripts/system-shell CLI | Excluded when they require a shell or unapproved binary | Invoke suitable JS test/CLI files directly through Node instead; do not assume all `npm test` scripts are supported |
| Arbitrary native binaries | Excluded | A project command name does not grant executable access |

A typical applicable check is `controlled_node` with arguments such as
`["--test", "tests/example.test.mjs"]`. A script may write private scratch, but
must not modify source, executable modes, Git status or HEAD. Generated source
must pass through `controlled_write`/`controlled_delete`. Host receipt IDs, exit
codes and termination reasons remain the evidence used by independent Review.

## Configuration and policies

Use `runtime.shell: null`, or omit it in older schema-v1 documents. Imported
non-null shell metadata remains visible as an unsupported blocking selection;
clear it before configuring the Node-only runtime. It cannot enable a shell even
if it contains valid hashes or a historical signed diagnostic report.

Policy selection remains explicit and locked into evidence. The legacy default
`lpac-strict-v1` is unchanged and has an observed Node Winsock startup limitation.
`lpac-registry-read-no-network-v2` is the selected Node validation candidate; its
hosted-Windows Node/Pi probes passed, without a network capability or filesystem
root/ancestor ACL grants. Choosing it does not provision capabilities on the user's
machine or release execution. `appcontainer-no-network-v3` remains an alternate
unreleased diagnostic candidate with inconclusive network-denial evidence.

## Verification and excluded diagnostics

CI requires portable Linux/Windows checks, renderer checks, the selected revised-v2
native smoke and the real Node-only Worker probes. Failures in those checks remain
failures. Browser tests use clearly synthetic application data; native tests use
real Win32 containment with a deterministic provider and no model spend.

Git Bash and alternate policy comparisons run separately as **non-gating,
unsupported-combination diagnostics**. Their nonzero exit codes, failed outcomes
and raw artifacts remain visible. The prior Git Bash failure is real:
MSYS cannot create its named-object directory under the selected boundary
(`NtCreateDirectoryObject`, `0xC0000022`). No shared namespace grant or fallback
was added. The original Bash requirement is deferred by the approved scope change,
not passed by removing a failing assertion.

## Remaining acceptance

Hosted Windows Server observations do not certify Windows 11 x64/NTFS. Full target
private-channel/ACL/process/race/desktop scenarios, independent Host trust, actual
user methods, explicitly authorized real-model Review/repair, real remote-content
verification and later-demand reuse remain required. G1–G5 and the original 64
acceptance scenarios have not all passed. See [implementation status](implementation-status.md).
