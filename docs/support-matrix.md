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
| Test source | Native `controlled_node`, in-process tests with `--test-isolation=none` | Exact locked Node executable, same AppContainer/Job, finite output/time and genuine native result receipt; test bodies/dependencies must not create child-process pipes or IPC named pipes |
| JavaScript CLI | Direct Node entry point without new child-process pipes or IPC named pipes | Script and dependencies must already be within authorized resource scope; source-preserving commands and private scratch only |
| Plan/review/repair/accept | Connected Host/Pi workflow | Independent sessions, version-bound decisions and actual-stop handoff; deterministic tests are not real model quality acceptance |
| Git lifecycle | Trusted bounded Host operations | Worktree/baseline/optional explicitly granted local commit; no automatic remote writes |
| Bash, POSIX pipelines, PowerShell/cmd | Excluded | No shell in product config, Worker capability or tool registration; no fallback |
| npm scripts/system-shell CLI | Excluded when they require a shell or unapproved binary | Invoke suitable JS test/CLI files directly through Node instead; do not assume all `npm test` scripts are supported |
| Arbitrary native binaries | Excluded | A project command name does not grant executable access |
| Default process-isolated `node --test` / new child or IPC pipes | Excluded | The Node 24.19.0 fixture timed out during spawn setup under LPAC; see the observed result and source-supported explanation below; no shared namespace grant or silent test-semantics substitution |

A typical applicable check is `controlled_node` with arguments such as
`["--test", "--test-isolation=none", "tests/example.test.mjs"]`. This explicitly
selects in-process test execution; it does not make tests that create child-process
pipes or IPC named pipes applicable. If a required check depends on process
isolation, report the unsupported requirement rather than silently changing its
semantics. A script may write private scratch, but
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
earlier hosted-Windows Node/Pi probes passed, without a network capability or filesystem
root/ancestor ACL grants. Those results did not validate Node child-process pipe
creation or default process-isolated tests. Choosing it does not provision capabilities on the user's
machine or release execution. `appcontainer-no-network-v3` remains an alternate
unreleased diagnostic candidate with inconclusive network-denial evidence.

## Verification and excluded diagnostics

CI requires portable Linux/Windows checks, renderer checks, the selected revised-v2
native smoke and the real Node-only Worker probes. Failures in those checks remain
failures. Browser tests use clearly synthetic application data; native tests use
real Win32 containment with a deterministic provider and no model spend.

The real `node --test --test-isolation=none` fixture is part of the required native
recorder; consult the Windows run for the exact commit for its result. Do not infer
a pass from its presence or from portable test results. The historical native
fixture in [run 37903915830](https://github.com/L1UUUU/pi-kanban/actions/runs/37903915830)
timed out without parent-readiness output during `child_process.spawn` setup with
`stdio: 'pipe'` under LPAC on pinned Node **24.19.0**. The
[pinned libuv source](https://github.com/nodejs/node/blob/v24.19.0/deps/uv/src/win/pipe.c#L194-L219)
supports an access-denied retry loop in the global pipe namespace as an explanation;
this is a source-supported inference, and no Win32 syscall trace was captured.
The failed fixture observation remains evidence;
neither the boundary nor the locked runtime/package versions are relaxed to bypass it.

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
