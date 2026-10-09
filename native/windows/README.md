# Windows AppContainer + Job candidate

Status: substantive candidate source; **not compiled or executed in the Linux authoring
container**. The production TypeScript driver remains disabled even if a JSON profile says
`verified: true`. The candidate does not implement the Host IPC/evidence-verification bridge.

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
or role-transition ACL cleanup. The library takes trusted native descriptor structs; a
bounded serialized transport and authenticated Host verifier remain unimplemented.
Output-frame/log quotas must be enforced by that bridge; the native memory/process/runtime
limits do not substitute for protocol backpressure and stop-priority checks.

Official references checked 2026-10-09:
- https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
