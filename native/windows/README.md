# Windows Node-native tools candidate

Status: substantive native source; **not compiled or executed in the Linux authoring
container**, with native compilation and CTest smoke subsequently passed in Windows CI. The production TypeScript driver remains disabled until exact signed runtime evidence and
separately provisioned Host recorder trust pass; a JSON `verified: true` flag does nothing. The general helper, bounded IPC/Host driver, scoped resource provisioning and independent
evidence verifier are now implemented; all units have now compiled in Windows CI; runtime validation remains incomplete.

The first delivery scope is **Node-native tools only**: controlled source read/list/search,
role-authorized write/delete, and bounded native Node checks, using the explicitly selected
`lpac-registry-read-no-network-v2` candidate. Git Bash is unsupported and excluded from
product bootstrap. Its actual failures remain separate diagnostics. The legacy strict
default is unchanged; this scope does not enable unverified production execution.

## Native Windows 11 / Windows CI build

Prerequisites: Windows x64, Visual Studio C++ toolchain, Windows 10/11 SDK, CMake >= 3.24.
No dependency download or installer is included.

```powershell
cmake -S native/windows -B build/native -A x64
cmake --build build/native --config Release
ctest --test-dir build/native -C Release --output-on-failure --no-tests=error -R '^native_registry_read_smoke$'
```

Always retain `build/native/Testing/Temporary/LastTest.log`. A compile failure, denied
profile creation, denied launch, or failed access probe is a failure or environment blocker;
do not relax policies or label it a pass. Running the smoke changes ACLs and creates an
AppContainer profile **only within its newly generated synthetic temporary resources**.
It deletes its own profile on exit, retains files on failure, and removes its uniquely
created test root on success. It never touches a business repository or real credential.
Windows Server CI is a useful compile/smoke environment but does not prove Windows 11
end-user behavior; capture exact OS build separately.

CI requires this selected revised-v2 smoke and the Node-only bundled-Pi recorder below.
Neither required step tolerates failure. A separate, explicitly non-gating diagnostic
matrix runs legacy strict smoke, ordinary-v3 smoke, and the stock-Git-Bash revised-v2
recorder. Those commands retain their original nonzero exit status, failing step outcome,
raw logs and separate artifacts; CI summaries mark failures visibly. They cannot authorize
shell support, broaden the selected policy, or turn an inconclusive denial into a pass.
The diagnostic job's non-gating setting never applies to the required Node job.

To reproduce the other smoke comparisons, run them separately and retain each log:

```powershell
ctest --test-dir build/native -C Release --output-on-failure --no-tests=error -R '^native_candidate_smoke$'
ctest --test-dir build/native -C Release --output-on-failure --no-tests=error -R '^native_appcontainer_smoke$'
```

## Candidate implementation

`launcher.cpp` validates fixed fields, a unique demand/role/generation profile name, local
absolute non-device paths, finite resource limits and pinned binary digests. It rejects
reparse components while holding no-write/no-delete-share handles against path replacement.
It derives the pre-provisioned AppContainer SID without silently provisioning permissions.
The default strict candidate uses LPAC (`ALL_APPLICATION_PACKAGES_OPT_OUT`) with no
capabilities. A separately selected diagnostic policy grants only the named `registryRead`
capability for ordinary HKLM reads needed by Winsock initialization. Neither candidate
grants internet, client/server or private-network capabilities; there is no startup fallback. Pre-provisioned ACL evidence is required by the descriptor;
the production Host must verify its content, not merely accept a string reference.

Only three explicitly listed inherited private pipe handles reach the Worker. The Job,
process, file-lock and Host control handles are not inherited. The environment is explicitly
built with scratch TEMP/TMP, SystemRoot and PI_OFFLINE; user keys, HOME/PATH, proxy settings,
NODE_OPTIONS and desktop control credentials are omitted.

The process is created suspended, associated with an unnamed non-inherited Job, checked for
Job membership and the expected AppContainer token SID, and only then resumed. The Job has
kill-on-close, process count and aggregate memory limits; both breakaway flags are absent.
A native watchdog enforces finite elapsed runtime. Stop terminates the Job and polls actual
active-process accounting, rather than assuming the parent exit is sufficient.

## Smoke evidence (when actually run)

`smoke.cpp` is a native fixture executable, not Node/Pi. It provisions per-role synthetic
ACLs and launches through the same candidate library. It records JSON lines for:

- Actual private request/report pipe round-trip
- Implementation own-source read/write success
- Reviewer own-source read success and write denial
- Other demand, shared Git marker, Host DB marker and inherited credential marker denial
- No-capability connection denial to a real trusted loopback listener
- Actual descendant creation and Job membership; breakaway creation rejection
- Job termination, zero active processes, and unchanged parent/child heartbeat files

A successful smoke would prove only those probes on that exact CI host. It would **not**
prove complete PV-01/G1, Node/Git Bash/Pi execution, arbitrary-network denial, reparse attack
races, Host/helper crash recovery, all shell/service escape paths, mandatory hooks/signing,
or role-transition ACL cleanup. The library takes trusted native descriptor structs. `helper.cpp` validates a bounded strict
JSON launch descriptor, duplicate keys, fields, depth and numeric ranges before calling it.
The general helper now enforces separate bounded model/report frames, bounded queued bootstrap
responses and independent output/log byte limits. Its stderr lifecycle channel is separate
from Worker stdout so output backpressure cannot block receipt of a native stop command.

Official references checked 2026-10-09:
- https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute

## General helper and provisioning

The build also produces `pi_kanban_native_helper.exe`. stdin is a length-prefixed launch
descriptor followed by `query`, `stop` or `worker-input` controls; stdout carries bounded
Worker frames and stderr carries separate trusted native identity/Job/ACL events. Native
helper EOF/crash closes the only Job handle. The Node driver validates the exact helper
binary and requires independent profile evidence before exposing this transport.

`provision.cpp` accepts only a bounded explicit resource-authorization reference and a new
per-demand/role/generation profile. It rejects reparse trees, grants read/execute to exact
readonly runtime files, role-specific source rights and private scratch rights, and denies
`.git`/`.local`. Only the exact Node executable and bundled Worker file are accepted; directory-wide
runtime grants and overlaps with source or scratch are rejected. Ancestors receive traverse
only. It appends/removes only the generated SID, preserving unrelated principals. Verified
stop includes explicit revocation status; unexpected reparse changes retain a cleanup
blocker rather than following links or deleting user files. Crashes still require cleanup
reconciliation; successful process termination alone is not clean-resource evidence.

First remote Windows Server 2025 CI: the original launcher/smoke compiled with MSVC /W4 /WX,
but launch failed with Win32 203 before any access probe ran. No isolation pass is claimed.
API-stage telemetry and private profile-environment replacements were added for the next
run; raw failure is retained by the parent CI evidence. The next Windows CI compiled helper/provision too, and launch succeeded with actual own-source
read/write and cross-demand/Git/Host/environment/network denial probes. Legal descendant creation
failed, so the smoke still failed and no G1 release is claimed. Additional immediate Win32 error
telemetry preserves that unresolved behavior for diagnosis.

## Real Node 24 / bundled Pi private-channel probe

The selected revised-v2 native CTest smoke has passed on the Windows CI baseline. The
broader recorder below must be run separately; a C++ fixture passing is not Node/Pi
compatibility evidence. Select the policy explicitly; omitting it retains strict-v1.

```powershell
npm ci --ignore-scripts
npm run build
node native/windows/probe-worker.mjs --helper build/native/Release/pi_kanban_native_helper.exe --worker dist/worker/main.mjs --policy lpac-registry-read-no-network-v2 --output artifacts/windows-node-native
```

`probe-worker.mjs` runs as the independent trusted Host, not in the sandbox. It copies the
exact Node and bundled Worker files into disposable fixtures, then executes the production
helper. Actual Pi SDK turns use a deterministic in-memory model responder over the inherited
private channel. It exercises real controlled-tool dispatch, native-mediated Node commands,
separate native receipts, role-specific source access, cross-demand/Host/Git denial, adjacent
runtime-file denial, and a live loopback listener. No real provider or credential is used.
Only the exact pinned executable and bundled Worker file receive read/execute grants;
parent runtime directories and their siblings do not. The legacy `readonlyRuntimeRoots`
field name now contains those two exact files, never directory trees.

The Node-only recorder additionally requires real Pi `controlled_read` and bounded literal
`controlled_search` results before its native Node assertion check in each source role.
It checks the actual advertised tools for absence of `controlled_shell` and built-ins,
and checks that native Node has no PATH/ComSpec/SHELL environment. A valid `run-shell`
request to the real helper, with empty shell fields and only Node/Worker runtime files,
must return Win32 `ERROR_ACCESS_DENIED`, `launch-failed`, PID zero and no child exit code.
A subsequent native Node command must still run, followed by zero-process and revoked-ACL
cleanup. This tests shell unavailability at the helper as well as the advertised tool list;
it does not claim to prove every possible indirect executable or service escape.

Additional probes create a real same-Job Node heartbeat and verify zero-process stop plus
quiescent writes, reject a real junction before launch, and close the Host control pipe to
exercise authenticated cleanup across a reconstructed Host. Reports and raw framed
transcripts are retained, including bounded Worker diagnostics. Fixtures contain only
synthetic data and remain available for ACL inspection. A nonzero process status, timeout,
missing observation, failed revoke or access-policy failure fails the probe.

Native command completion shares one monotonic **250 ms** window between actual Job
census and normal output-pipe completion, starting immediately when the command wait
returns. It repeatedly requires that no process outside the pre-command baseline remains
and that the reader observed a zero-byte read or `ERROR_BROKEN_PIPE`. The command handle
stays open through settlement. Query work consumes this same budget; a clean observation
made only after expiry cannot pass. An API error, surviving child or unfinished output
still fails and stops the whole Job. Output errors are never treated as normal pipe end.

Receipts retain first/final PID snapshots, read-only process diagnostics, observation
count, fixed budget, actual elapsed time and settlement/deadline outcome. These explain
the native result; an executable name, exit code or metadata query never grants an
exception. Five bounded commands in the concurrent-cleanup probe still exercise normal
completion and receipt-to-next-command handoff without increasing the helper deadline.
Both launch failure and normal completion release their single check slot before
publishing the receipt. Publication is serialized with the natural-shutdown watcher's
fresh check-slot and zero-Job recheck, so finalization cannot discard the pending receipt.

Paired fixtures start a real child that writes a heartbeat before its Node command parent
exits zero. Child standard handles are duplicates of an already-open scratch file, so the
fixture needs neither a new named pipe nor an inherited helper output writer. The Host
releases a challenge marker only after a successful native Job census shows the exact
parent absent and child present. The short-lived child then starts a 75 ms exit timer;
the probe requires a live first native census and disappearance in the final census within
the shared 250 ms window. A scheduling miss fails coverage rather than being called a
settlement pass. The persistent child keeps running with no inherited helper output
writer; its continued presence must fail command completion despite parent exit zero and
normal output EOF. Both fixtures require actual zero-Job/revoked-ACL authenticated cleanup
and an independently quiescent heartbeat. Waiting alone never proves a clean stop.
Bounded progress markers around file opening, spawn and readiness are preserved in the
transcript even if the command times out before producing output.

The recorder also runs a real `node --test --test-isolation=none --test-reporter=tap`
source testcase and checks both its challenged assertion and genuine native receipt.
Default process isolation and other child-process pipe-dependent JavaScript commands
remain outside this evidence. The pinned [Node 24.19.0 libuv pipe code](https://github.com/nodejs/node/blob/v24.19.0/deps/uv/src/win/pipe.c#L194-L219)
retries `ERROR_ACCESS_DENIED` while creating a global named stdio pipe; that is consistent
with the earlier child-fixture timeout before its JavaScript deadline could run. No
namespace grant or runtime patch is introduced to make that optional pipe path work.

Baseline and unexpected-process diagnostics additionally attempt read-only handle queries
for image path, birth/exit time, zero-time wait, exit code and membership in this exact Job.
Each list records at most eight processes and 512 image-path characters per process, with
omitted counts and API errors explicit. Handles are non-inheritable and request only
limited query/synchronize access, without enabling privileges. An observed system image,
apparently exited process or failed query never exempts a remaining PID from the
deadline's Job-wide stop or turns that failed command into success. The observations are
sequential snapshots, not permission to terminate or trust a process by bare PID.

The report identifies `toolScope: "node-native-tools-only"`; adding `--git-bash` produces
the separately labeled `node-and-git-bash-diagnostic` report. The recorder always emits
`releaseAuthorized: false`: it is partial real-runtime
validation, not a full release attestation. In particular it does not prove all reparse
races, arbitrary network/service escape routes, catastrophic helper-crash cleanup, or full
role-transition attack coverage. It cannot be used as a signed all-pass profile.

## Authenticated recovery after Host loss

The production Host stores a unique per-run recovery secret and exact generation/artifact/
policy/workspace binding in its private state before launch. The helper receives that data
only over the trusted control pipe. It never forwards the secret or receipt path to the
Worker. After explicit stop, natural completion or Host stdin EOF, the helper must observe
an actual zero Job census and successfully revoke its generated identity's ACLs before
atomically writing an HMAC-SHA256 receipt. Process birth identity is included.

A restarted Host authenticates that receipt before releasing a lease, including the narrow
crash window before PID registration. Generic drivers have no such recovery authority;
missing PIDs, unsigned files and absent connections remain unknown. If the helper itself
is killed before it can complete cleanup and write the receipt, the Job still has
kill-on-close, but missing independent cleanup proof remains an explicit recovery blocker.
The application never kills an arbitrary reused PID to work around that blocker.

AppContainer profile names use a 192-bit SHA-256 prefix binding the complete demand, role
and generation. They are always 58 ASCII characters, within the Win32 64-character limit.
The native launcher recomputes the name; a truncated or caller-chosen name is rejected.
The native smoke and TypeScript test share an exact digest vector and cover long IDs.

Shared file/ancestor ACL changes are serialized across helper processes by a per-user
Global named mutex with a protected user-and-SYSTEM-only DACL and a bounded acquisition
time. Workers receive no mutex rights. Revoke independently reads back affected ACLs,
including descendants of inherited grants, and refuses clean proof if its generated SID
remains. The two-helper probe overlaps provisioning and A's revocation while B repeatedly
uses its allowed files and remains denied adjacent private files.

All post-launch exits, including broken Host stdout/stderr and failed lifecycle writes,
use a once-only native finalizer. It terminates and censuses the Job, revokes resources,
and persists the authenticated receipt before attempting bounded best-effort pipe output.
It does not re-enter the native event mutex during cleanup. A final cleanup watchdog
retains a failure/unknown outcome if cleanup itself cannot finish. The recorder closes
both Host output readers during continuous contained Node output and checks reconstructed
receipt authentication and quiescent writes; this is separate from orderly stdin EOF.

## Sampled disk, file-count and free-space policy

The helper requires finite `diskLimitBytes`, `fileLimit`, `minimumFreeBytes` and
`diskPollMs` limits in its descriptor. Production defaults bound combined source+scratch
bytes to 1 GiB, entries to 100,000, available space to at least 256 MiB on each volume,
and polling to 250 ms. It samples before launching and while the Job runs; unreadable
paths, reparse points, arithmetic errors or an exceeded bound cause the same authenticated
stop/revoke finalizer. Source and scratch must not overlap. Files are retained, never
silently deleted to regain space. Native diagnostics record thresholds, sampled counts,
status, and whether available-space values were actually sampled.

This is explicitly a polling monitor, **not a hard quota**. Writes can overshoot between
samples, during traversal, or while termination completes; hard exhaustion prevention is
not established. The Windows recorder writes a real 2 MiB scratch file under a 1 MiB
fixture limit, checks observed stop/revocation/authentication, and retains the overflow
file. Output/log streams remain independently byte-bounded; the probe records possible
overshoot instead of relabeling monitoring as kernel-enforced storage containment.


## Explicit policy candidates and unsupported Git Bash diagnostics

`lpac-strict-v1` remains the default for legacy configurations. Actual Windows CI observed
Node 24 starting and then exiting with Winsock initialization error 10107 under that strict
policy. This is a real compatibility failure, not successful network isolation. The native
strict smoke retains its filesystem/Job observations and explicitly reports whether network
initialization/denial was proven. The separate `native_registry_read_smoke` CTest requires
successful Winsock initialization followed by actual access-denied connection behavior,
plus denial of a disposable private HKCU registry marker. It does not change OS registry
ACLs, firewall settings, or real user data. The marker is synthetic and deleted after success.

The `lpac-registry-read-no-network-v2` diagnostic is explicitly selected by the profile and
signed evidence. Its token capabilities are checked exactly. It is never selected in
response to startup failure, and a strict-policy signature cannot authorize it. Microsoft's
primary documentation distinguishes `registryRead` (HKLM read) from network capabilities:
https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox

The helper retains a direct shell-fixture diagnostic only. The product never enables it
from a shell profile. Run this non-gating comparison, including an explicitly selected
preinstalled official Git:

```powershell
node native/windows/probe-worker.mjs --helper build/native/Release/pi_kanban_native_helper.exe --worker dist/worker/main.mjs --output artifacts/windows-worker --policy lpac-registry-read-no-network-v2 --git-bash "C:\Program Files\Git"
```

After retaining independent Node/Pi/recovery observations, the fixture copies only the
three required official `bash.exe`, `cat.exe`, `rm.exe` files and the bounded `usr/bin` DLL
set into its disposable tree. It hashes the complete exact-file manifest and
never changes installed Git ACLs. Shell startup is the pinned executable with fixed
`--noprofile --norc -c` arguments, scratch HOME, curated manifest-root PATH and no inherited
credentials/config/proxy environment. Every dependency is pinned and hashed before launch;
no root-directory read grant is substituted. Actual Bash `cat`/`rm`, own-source writes and
deletes, reviewer denials, private/unlisted sibling denial and `/dev/tcp` access denial are
checked through the independent native receipt and stop/revocation channel. A missing
runtime file, denied child launch, failed Bash startup or inaccessible dependency fails
closed, without a normal-user shell fallback. Execution of these expanded probes is a
separate CI result; implementing them is not a passing release claim.

Implementation source ACLs include scoped DELETE on inherited source objects but never
parent FILE_DELETE_CHILD. Before source rights are granted, existing `.git` and `.local`
roots have DACL inheritance protected while their unrelated ACEs are preserved. The fresh
generation's source grant must be absent from every protected descendant. Traversal rejects
reparses and is bounded by the descriptor file count and a ten-second sampled deadline
(individual Windows ACL calls can block). Exact-token read and DELETE-open attempts on every
protected object must return ACCESS_DENIED before Worker or check process resume. The real Node/Bash
probes check that implementation can unlink its fixture while review cannot and protected
Git metadata remains denied.

Unconfirmed Host launch now queues stop and closes only its exact helper control pipe.
A native receipt can attest either actual zero-Job process identity and cleanup, or the
separate `neverCreated` state when CreateProcess never succeeded and scoped permissions
were revoked. A missing PID does not imply either state. Late native launch before Host
registration and pre-creation reparse rejection both have explicit recovery probes.

A previous registry-only metadata experiment granted READ_ATTRIBUTES/TRAVERSE to exact
ancestors and a volume root. It timed out during Windows ACL propagation and required
WRITE_DAC that ordinary users may not have. Those grants have been removed from v2;
revised v2 and ordinary v3 perform no ancestor or volume-root ACL edits. The failed
experiment remains evidence of incompatibility, never authorization for the revised
artifact. Strict-v1 retains only its original traverse-only scope. Bounded native cleanup
failures continue to report precise phase, path and Win32 status.

Revocation filters only this generated SID's allow/deny ACEs from the current ACL,
copying all unrelated entries, order and flags unchanged. It does not rely on Win32
REVOKE_ACCESS to remove deny entries (that mode does not do so), and still independently
verifies SID absence before accepting cleanup. Role-transition and HMAC recovery probes
must observe generated-SID absence after restoring the original metadata inheritance flags too.

The native CTest includes a real-token protected-deletion/cleanup regression for both a
`.git` directory (including nested objects) and an ordinary worktree-pointer file. The
contained process must delete an ordinary source fixture while actual read/delete opens
on protected Git and `.local` objects return ACCESS_DENIED. It then revokes the generated
SID, checks descendant/runtime SID absence, restores and verifies both originally protected
and unprotected metadata roots, and compares an unrelated identity's ACE bytes before and
after. Exact, ancestor-first and descendant-first overlapping workspace generations are rejected
before mutation, including protected nested source DACLs. Object/callback
allow/deny ACEs are parsed with their optional GUID offsets; unknown DACL ACE forms retain
a cleanup blocker instead of being skipped or falsely certified clean.


## Explicit ordinary AppContainer comparison

`appcontainer-no-network-v3` is a separately named primary-scope AppContainer + Job
candidate. It omits the LPAC opt-out attribute, grants zero capabilities, and verifies
both the actual AppContainer SID and the token's observed AAP access policy before
resuming any instruction. The same Job, bounded private pipes, exact runtime file grants,
source-role restrictions, disk monitor and authenticated cleanup apply. This variant
performs no ancestor or volume-root ACL edits and never elevates or falls back.

Ordinary AppContainer honors Windows' existing ALL_APPLICATION_PACKAGES resource policy;
that is a real difference from LPAC, not an equivalent isolation claim. The separate
`native_appcontainer_smoke` and explicitly selected Node/Pi/Bash recorder must still pass
all private/sibling/Git/HKCU/network denials and metadata-versus-directory-listing probes.
An unexpected read remains a failed diagnostic; no negative test is waived for usability.
Strict-v1 remains the default. Prior strict Winsock failure and v2 root-metadata/ACL timing
failure remain historical failures and cannot authorize v3. Every signature binds the
exact selected policy and changed helper artifact.

```powershell
node native/windows/probe-worker.mjs --helper build/native/Release/pi_kanban_native_helper.exe --worker dist/worker/main.mjs --output artifacts/windows-worker --policy appcontainer-no-network-v3 --git-bash "C:\Program Files\Git"
```

Primary token-state API: https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class


The first v3 comparison failed pre-resume because Windows returned invalid parameter for
`GetTokenInformation(TokenIsLessPrivilegedAppContainer)`; the enum's presence was not a
supported query contract on that host. That result is retained as a failed experiment.
The unsupported query is removed, never interpreted as false. Supported AppContainer,
exact SID and capability checks remain, along with the explicitly selected creation flags.

Before the business Worker is resumed, the helper now uses supported token duplication
and same-identity impersonation APIs for two real filesystem reads. New scratch fixtures
have protected DACLs granting the exact generated SID or ALL_APPLICATION_PACKAGES,
respectively (plus Host/SYSTEM ownership); files are random CREATE_NEW names held against
write/delete replacement. Exact-SID bytes must be readable for every policy. The AAP-only
bytes must be readable for ordinary v3 and return actual ACCESS_DENIED for LPAC. Any token,
impersonation, revert or other read failure aborts pre-resume; failed APIs are not denial
proof. Only those helper-created synthetic files are removed by handle closure before
untrusted code runs. Native telemetry records this trusted differential observation and
the Host requires it, bound to the selected policy and exact helper digest.

https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-duplicatetokenex
https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-impersonateloggedonuser

Once CreateProcess, exact birth capture and Job assignment succeed, a later pre-resume
verification failure retains those trusted handles and identity for the finalizer. It
still records launch failure; only actual zero-Job/revocation proof can authenticate clean
recovery. A failure before birth capture or Job assignment remains unknown rather than
being mislabeled never-created.

The same exact-token differential runs before every native-mediated Node/Bash command,
not only the primary Worker. A shared native mutex keeps these short-lived trusted
fixtures out of concurrent disk traversal without weakening any missing/permission/reparse
failure rule. A check-policy failure terminates the entire Job before returning failure.
If reverting impersonation itself fails, the helper exits immediately and writes no clean
receipt; kernel Job-handle closure kills descendants and recovery remains explicitly unknown.


The v3 smoke initially recorded WSAEWOULDBLOCK without a completion because the probe
watched only writefds. WinSock reports failed nonblocking connects in exceptfds. The
corrected probe watches both under the same one-second bound and requires a successful
SO_ERROR query returning WSAEACCES; pending sockets, timeouts and API failures still fail.
https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-select

Both primary Worker and native-mediated Node commands now use fixed Node 24
`--preserve-symlinks --preserve-symlinks-main` flags after native component pinning and
reparse rejection. This avoids the module loader's redundant volume-root realpath walk;
it grants no filesystem permission and introduces no path fallback. Controlled tools use
`fs.realpathSync.native` for direct/in-process assembly, or the explicit private native
workspace capability described below for actual contained Workers. Per-ancestor
metadata availability is recorded rather than assuming the rejected v2 root grant exists;
all ancestor-directory listing, adjacent/private file, Git and Host denials remain mandatory.
https://github.com/nodejs/node/blob/v24.x/doc/api/cli.md#--preserve-symlinks-main


## Explicit pinned workspace handoff and bounded final candidate attempt

The verified Host driver supplies `{version:1,kind:"native-pinned-workspace",path,generation}`
only after matching native process/policy/provisioning proof. It overwrites any caller
capability with the exact launched path and generation. The helper has already rejected
reparse components and keeps no-write/no-delete-share directory handles open. The Worker
checks the exact capability shape/path/generation and ordinary directory status, then
uses that path with unchanged lexical containment, role checks, and per-component junction
rejection. There is no catch-and-use-raw-path fallback after failed canonicalization.
Workers without this private assertion still require actual native realpath canonicalization.
The assertion does not grant OS permissions, permit a model to select roots, or attest its
own origin; its provenance is the existing private Host/helper bootstrap channel.

The independent recorder resolves its Host-side temporary root with realpathSync.native
to eliminate Windows 8.3 aliases before constructing native descriptors. It supplies the
same capability only after verified native startup. Real-file/junction tests cover both
assembly paths and malformed/mismatched assertions.

After successful WSAStartup, socket creation returning WSAEACCES is explicit socket-stage
network denial. A completed connect returning WSAEACCES is a separate supported outcome;
failed WSA initialization, ioctl/select/getsockopt errors, pending connections and timeouts
are never treated as denial. Ordinary v3 continued to time out even with correct exceptfds
handling and remains an unsupported diagnostic result, with its negative test unchanged.
The final disposable compatibility attempt explicitly selects revised v2, retains the
strict user default, and uses no root grants. A further Node/Pi/Bash failure remains a
blocked candidate rather than justification for broader policies or another backend.


The revised-v2 expanded Windows run reached the real bundled Pi session and its native
Node command, but exposed a security failure: an implementation check deleted a protected
Git fixture despite a root-level inherited deny. A subsequent actual-token regression also
read and deleted protected objects despite explicit per-object package-SID denies. Both runs
remain failed evidence. The implementation therefore excludes the fresh package grant from
reserved trees instead of relying on those denies. Cleanup first removes and independently
verifies inheritable parent grants, then restores only the original DACL-protection flags
using current unrelated ACEs, followed by another tree-wide SID-absence check. A tracked,
non-inheriting READ_ATTRIBUTES ownership marker (a subset of every role's existing source
rights) precedes metadata mutation and remains until all restoration checks succeed.
Existing specific package source grants on the workspace, ancestors or ordinary descendants
reject overlapping or unsupported ownership under the cross-helper ACL mutex; strict
traverse-only ancestor ACEs and excluded metadata trees are not mistaken for source grants. A helper crash before restoration remains an unknown cleanup blocker.

Microsoft documents the AppContainer user/package intersection and protected-DACL inheritance:
https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces
https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptor-control

The exclusion correction's Windows execution is a separate required result; source inspection
alone does not establish that the failure is closed.
Failed Node checks now print bounded native-captured child diagnostics in CI logs, while
the complete bounded receipt remains in the retained diagnostic artifact.


## Observed Windows result, 2026-10-09

[Run 37895356130](https://github.com/L1UUUU/pi-kanban/actions/runs/37895356130)
compiled commit `94a8c943c32381c2fec7d09a1a5e47c944511234` on Windows Server 2025,
build 26100, using Node 24.19.0. The exclusion correction passed actual read/delete
negatives for Git directory, nested object, ordinary `.git` pointer and `.local`, plus
inheritance restoration, unrelated ACE preservation, overlapping workspace rejection and
failed-cleanup retry, under all three explicitly selected tokens. Strict and revised-v2
native CTests passed their stated scopes. Ordinary-v3 still failed its inconclusive network
check (pending 10035, no completed denial); that assertion remains mandatory and visible.

The revised-v2 expanded recorder passed 16 independent probes: real bundled Pi/private
model channel and native Node tools; implementation/review and clean role transition;
Git, other-demand, Host and adjacent runtime-file denials; actual loopback EACCES;
same-Job descendant stop; authenticated Host EOF and broken-output recovery; concurrent
shared-runtime ACL cleanup; sampled disk overrun; early queued stop; and junction rejection.
These are real partial results, not complete Windows 11 release evidence.

The exact copied 77-file official Git Bash fixture failed before its script ran:
`NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-00ba77ed17b904c1)` returned
`0xC0000022` (access denied), and Bash exited `0xC0000142`. The native check retained that
output and failed conservatively; final cleanup independently observed zero Job processes,
successful ACL restoration and authenticated recovery. Git Bash compatibility remains
**blocked** for this candidate. No global object-namespace grant, security change, silent
fallback or alternative backend is introduced to bypass the failure. Shell profiles cannot
be released without their actual compatibility evidence. The full diagnostic remains
`releaseAuthorized: false`, including the successful Node subset.

Reproduce with the explicit revised-v2 command above and retain both `report.json` and
`transcript.json`. [The exact run artifact](https://github.com/L1UUUU/pi-kanban/actions/runs/37895356130/artifacts/11600570460)
contains the successful subset, native receipts and the actual Bash error. Bounded failed
Bash receipt output is also included in subsequent CI assertion diagnostics.

The subsequent Node-only CI split adds native assertions for actual controlled read/search,
Node assertion checks, advertised tool scope and helper shell denial. These additions need
their own Windows execution; the historical 16-probe result above does not certify them.
Even a successful required Node job remains partial Windows Server evidence, not complete
Windows 11 release evidence. Every recorder result still sets `releaseAuthorized: false`,
and production still requires independently verified exact runtime evidence.
