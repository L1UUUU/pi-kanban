# Windows AppContainer + Job candidate

Status: substantive candidate source; **not compiled or executed in the Linux authoring
container**. The production TypeScript driver remains disabled even if a JSON profile says
`verified: true`. The general helper, bounded IPC/Host driver, scoped resource provisioning and independent
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
The candidate uses LPAC (`ALL_APPLICATION_PACKAGES_OPT_OUT`) with no capabilities, especially
no broad network capability. Pre-provisioned ACL evidence is required by the descriptor;
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
readonly runtime roots, role-specific source rights and private scratch rights, and denies
`.git`/`.local`. Runtime roots cannot enclose source or scratch. Ancestors receive traverse
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
