# Development and verification

## Reproducible setup

Use Node 24. `package-lock.json` records exact package versions and registry integrity. `npm ci --ignore-scripts` installs the development/test dependencies without package lifecycle execution. Esbuild's platform package is included by the lock. Download the official Electron runtime separately with `npm run setup:electron` when running the desktop.

`npm run check` runs strict type checking, Node tests and the production build. `npm run diagnostics` prints observed OS/Node/Git/SQLite/package versions and hashes without environment secrets. CI runs the portable suite on Linux and Windows and separately compiles/runs the native Win32 smoke. The source package contains no downloaded binary artifacts.

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
ctest --test-dir build/native -C Release --output-on-failure
```

The native smoke manages unique temporary synthetic identities/resources. Preserve `build/native/Testing/Temporary/LastTest.log` including failures. Do not install a new backend or disable failed negative cases to make the suite green. The product targets Windows 11 x64/NTFS; hosted Windows Server CI is useful partial Win32 evidence, not proof of that target combination.

The locked Worker is emitted as `dist/worker/main.mjs`, including SDK dependencies rather than exposing the Host's node_modules directory. Runtime evidence binds its exact byte digest. On Windows, set `PI_KANBAN_GIT` to the verified absolute git.exe path before `npm start`. The launcher forwards only that path, necessary OS loader fields and the single explicitly configured `env:NAME` credential to the trusted Host. No credential enters the Worker. Restart after changing the referenced environment credential name.

## Completing live validation

The original actual `design-feature` source and all dependencies must be supplied, hashed and reviewed. Implementation/Review method candidates must be explicitly versioned. A real model requires provider/model, Host credential reference, exact data/destination authorization, finite request/token/cost policy and metering behavior. The complete native Worker + private channel must be verified for the chosen Node/Git Bash/Pi build before any live fixture run. Finally, run a dedicated real GitHub merge/read-only verification + later-demand reuse scenario and user acceptance; mock observations cannot substitute.
