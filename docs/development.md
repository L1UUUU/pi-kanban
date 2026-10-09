# Development and verification

## Reproducible setup

Use Node 24. `package-lock.json` records exact package versions and registry integrity. `npm ci --ignore-scripts` installs the development/test dependencies without package lifecycle execution. Esbuild's platform package is included by the lock. Download the official Electron runtime separately with `npm run setup:electron` when running the desktop.

`npm run check` runs strict type checking, Node tests and the production build. `npm run diagnostics` prints observed OS/Node/Git/SQLite/package versions and hashes without environment secrets. CI runs the portable suite on Linux and Windows. The explicitly selected Node-only native profile is a required job; alternative policy and excluded Git Bash probes are separately labeled diagnostics whose raw failures remain available. The source package contains no downloaded binary artifacts.

## Local data and cleanup

Tests create synthetic temporary fixtures and clean only their own test directories. Application exit never deletes a user's worktree, code, history or local knowledge. Production data remains under the Electron app user-data directory and the explicitly bound project anchor.

Generated `dist`, `artifacts`, test reports, screenshots and native build output are ignored. Never stage the original planning ZIP or all of a user's `.local` folder.

## UI test modes

`npm run preview` serves a dedicated synthetic renderer at `http://127.0.0.1:4173`. Its banner always identifies the fixture, controls do not start real runs, and it is not included in `npm run build`. Query `?view=empty` or `?view=onboarding` to inspect the empty states. Production fails visibly when its desktop bridge is absent; it never silently swaps in demo data.

Browser tests use Playwright and record screenshots as CI artifacts. They establish interaction/rendering behavior only. Electron IPC, tray and quit behavior require the separately identified desktop tests; a browser screenshot is not proof of native process containment.

## Native Windows candidate

```powershell
cmake -S native/windows -B build/native -A x64
cmake --build build/native --config Release
ctest --test-dir build/native -C Release --output-on-failure --no-tests=error -R '^native_registry_read_smoke$'
npm run build
node native/windows/probe-worker.mjs --helper build/native/Release/pi_kanban_native_helper.exe --worker dist/worker/main.mjs --policy lpac-registry-read-no-network-v2 --output artifacts/windows-worker
```

The native smoke manages unique temporary synthetic identities/resources. Preserve `build/native/Testing/Temporary/LastTest.log` including failures. Do not install a new backend or disable failed negative cases to make the suite green. The product targets Windows 11 x64/NTFS; hosted Windows Server CI is useful partial Win32 evidence, not proof of that target combination.

The command explicitly selects the revised registry-read LPAC diagnostic candidate,
with no network capability and no ancestor/root ACL grants. The strict configuration
default is unchanged. Its earlier metadata-grant experiment has been removed; fixed
Node startup flags and the exact native-pinned workspace bootstrap now avoid requiring
those grants. Its actual Node/Pi probes passed on hosted Windows Server; full target Windows 11 release verification remains pending.
Ordinary AppContainer's inconclusive loopback result stays visible in its unchanged
CTest negative case; zero-capability LPAC failed real Node Winsock startup.
All policies are identified separately in observations. Network denial requires
successful Winsock initialization and an explicit access-denied socket creation or
completed connection; startup failure, a pending connection and timeout are not
denial proof. Policy changes are part of the signed runtime identity and require new
evidence. These no-model probes cannot authorize production execution or satisfy
the real-model quality gates.

Git Bash is excluded from the approved product scope. A separate non-gating diagnostic can append `--git-bash "C:\Program Files\Git"`; the actual failure remains in its report, never converted to success. `--git-bash` selects an existing official Git for Windows installation explicitly;
adjust the example path to the actual installation. The recorder copies a bounded
manifest of exact executable/DLL dependencies into its disposable fixture before
applying ACLs. It does not change installed Git permissions or search for another
shell. Missing files or an incompatible Bash runtime fail the probe.

The locked Worker is emitted as `dist/worker/main.mjs`, including SDK dependencies rather than exposing the Host's node_modules directory. Runtime evidence binds its exact byte digest. On Windows, set `PI_KANBAN_GIT` to the verified absolute git.exe path before `npm start`. The launcher forwards only that path, necessary OS loader fields and the single explicitly configured `env:NAME` credential to the trusted Host. No credential enters the Worker. Restart after changing the referenced environment credential name.

## Completing live validation

The original actual `design-feature` source and all dependencies must be supplied, hashed and reviewed. Implementation/Review method candidates must be explicitly versioned. A real model requires provider/model, Host credential reference, exact data/destination authorization, finite request/token/cost policy and metering behavior. The complete native Worker + private channel must be verified for the chosen Node/Pi build without a shell before any live fixture run. Finally, run a dedicated real GitHub merge/read-only verification + later-demand reuse scenario and user acceptance; mock observations cannot substitute.
