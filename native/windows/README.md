# Windows AppContainer + Job candidate

Status: substantive native source; **not compiled or executed in the Linux authoring
container**, with native compilation and CTest smoke subsequently passed in Windows CI. The production TypeScript driver remains disabled until exact signed runtime evidence and
separately provisioned Host recorder trust pass; a JSON `verified: true` flag does nothing. The general helper, bounded IPC/Host driver, scoped resource provisioning and independent
evidence verifier are now implemented; all units have now compiled in Windows CI; runtime validation remains incomplete.

## Native Windows 11 / Windows CI build

Prerequisites: Windows x64, Visual Studio C++ toolchain, Windows 10/11 SDK, CMake >= 3.24.
No dependency download or installer is included.

```powershell
cmake -S native/windows -B build/native -A x64
cmake --build build/native --config Release
ctest --test-dir build/native -C Release --output-on-failure
```

Always retain `build/native/Testing/Temporary/LastTest.log`. A compile failure, denied
profile creation, denied launch, or failed access probe is a failure or environment blocker;
do not relax policies or label it a pass. Running the smoke changes ACLs and creates an
AppContainer profile **only within its newly generated synthetic temporary resources**.
It deletes its own profile on exit, retains files on failure, and removes its uniquely
created test root on success. It never touches a business repository or real credential.
Windows Server CI is a useful compile/smoke environment but does not prove Windows 11
end-user behavior; capture exact OS build separately.

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

The native CTest smoke has passed on the Windows CI baseline. The broader recorder below
must be run separately; a C++ fixture passing is not Node/Pi compatibility evidence.

```powershell
npm ci --ignore-scripts
npm run build
node native/windows/probe-worker.mjs --helper build/native/Release/pi_kanban_native_helper.exe --worker dist/worker/main.mjs --output artifacts/windows-worker
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

Additional probes create a real same-Job Node heartbeat and verify zero-process stop plus
quiescent writes, reject a real junction before launch, and close the Host control pipe to
exercise authenticated cleanup across a reconstructed Host. Reports and raw framed
transcripts are retained, including bounded Worker diagnostics. Fixtures contain only
synthetic data and remain available for ACL inspection. A nonzero process status, timeout,
missing observation, failed revoke or access-policy failure fails the probe.

The recorder explicitly emits `releaseAuthorized: false`: it is partial real-runtime
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


## Explicit policy candidates and locked Git Bash

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

Run the expanded diagnostic, including an explicitly selected preinstalled official Git:

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
parent FILE_DELETE_CHILD. Protected `.git` and `.local` deny DELETE. The real Node/Bash
probes check that implementation can unlink its fixture while review cannot and protected
Git metadata remains denied.

Unconfirmed Host launch now queues stop and closes only its exact helper control pipe.
A native receipt can attest either actual zero-Job process identity and cleanup, or the
separate `neverCreated` state when CreateProcess never succeeded and scoped permissions
were revoked. A missing PID does not imply either state. Late native launch before Host
registration and pre-creation reparse rejection both have explicit recovery probes.

The explicit registry-only diagnostic candidate also grants only READ_ATTRIBUTES and
TRAVERSE to exact runtime/source/scratch ancestor directories, including their volume
roots, with no inheritance, directory listing, file content or write rights. Node 24
otherwise failed during entry-point realpath with `EPERM lstat C:\`. Strict-v1 keeps its
original traverse-only grants. The recorder requires metadata lookup to succeed while
listing those ancestors, adjacent file reads and all existing private-resource reads
remain denied. Every grant is generation-specific and revoked under the shared mutex;
bounded native cleanup failures report their precise phase, path and Win32 status.

This metadata diagnostic can require WRITE_DAC on existing ancestors/volume roots, which
ordinary desktop users may not possess. An unavailable grant is a recorded startup failure;
there is no elevation, broad-principal ACL change or silent policy fallback. Until this is
validated on supported non-elevated Windows 11 accounts, it is not a usable production
profile. The expanded CI is an explicitly selected synthetic compatibility experiment.

Revocation filters only this generated SID's allow/deny ACEs from the current ACL,
copying all unrelated entries, order and flags unchanged. It does not rely on Win32
REVOKE_ACCESS to remove deny entries (that mode does not do so), and still independently
verifies SID absence before accepting cleanup. Role-transition and HMAC recovery probes
must observe successful removal of the protected `.git` deny entries too.

The native CTest includes a dedicated no-process cleanup regression: it confirms the
protected Git deny exists, revokes the generated SID, checks descendant/runtime SID
absence, and compares an unrelated identity's ACE bytes before and after. Object/callback
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
`fs.realpathSync.native` for actual selected-workspace canonicalization. Per-ancestor
metadata availability is recorded rather than assuming the rejected v2 root grant exists;
all ancestor-directory listing, adjacent/private file, Git and Host denials remain mandatory.
https://github.com/nodejs/node/blob/v24.x/doc/api/cli.md#--preserve-symlinks-main
