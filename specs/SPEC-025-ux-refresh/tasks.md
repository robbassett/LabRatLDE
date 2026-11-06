# SPEC-025 tasks: UI/UX refresh

Requirements: [requirements.md](requirements.md) · Design: [design.md](design.md)

There are no `Test: yes` requirements, so there are no test tasks. Every UI task is verified with `cd web && npm run build` (type-check plus bundle) and a look in the running app (`go run ./cmd/server`, then `npm run dev`). Section references (§) point to [design.md](design.md). Once open question 1 is answered, task 1.5 follows that answer.

## Phase 1: Foundations

- [ ] 1.1 Add dependencies
  - Requirements: SPEC-025-R04, R05
  - Files: `web/package.json`, `web/package-lock.json`
  - Do: `npm install --save-exact lucide-react @fontsource/fira-sans @fontsource/fira-code react-aria-components` (drop the last if OQ 1 says native only). Commit only the manifest and lockfile changes.
  - Verify: `npm run build` passes; gzipped bundle still under 1 MB (`du` on `web/dist/assets` after `gzip -k`)
- [ ] 1.2 Design tokens and fonts
  - Requirements: SPEC-025-R01, R02, R03, R05, R07
  - Files: `web/src/tokens.css` (new), `web/src/main.tsx`
  - Do: write every token in §3.1 with its ratio comment: light on `:root`, dark under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and again under `:root[data-theme="dark"]`, plus the reduced-motion block. Compute each badge pair (`color-mix` 12% of the state colour into `--surface`, state colour as text), record its ratio, and darken or lighten the text step until it is ≥4.5:1. In `main.tsx` import `@fontsource/fira-sans/latin-400.css`, `latin-500.css`, `latin-600.css`, `@fontsource/fira-code/latin-400.css`, then `./tokens.css` before `./styles.css`.
  - Verify: build passes; DevTools Network shows fonts from the app's own origin only; toggling the OS theme switches colours
- [ ] 1.3 Shared component styles
  - Requirements: SPEC-025-R01, R30
  - Files: `web/src/components.css` (new), `web/src/main.tsx`
  - Do: classes from §3.2: `.btn`, `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.btn-icon` (32 px tall, min 24×24 target), `.card`, `.table` (sticky header, `.num` right-aligned mono), `.field`, `.badge`, `.mono`, focus ring and `scroll-padding` rules (§3.8), and rjsf class-name styling (`.form-group`, `.control-label`, `.field-description`, `.error-detail`). Only `var(--…)` colours. Import after `tokens.css`.
  - Verify: build passes; `grep -nE '#[0-9a-fA-F]{3,6}\b' web/src/components.css` finds nothing
- [ ] 1.4 Small presentational components
  - Requirements: SPEC-025-R04, R06, R15, R18
  - Files: `web/src/StatusBadge.tsx`, `web/src/EmptyState.tsx`, `web/src/RecordDetails.tsx`, `web/src/Field.tsx` (all new)
  - Do: `StatusBadge({state})` uses the state table in §3.4 (Lucide icon `aria-hidden`, word visible). `EmptyState({icon, text, action?})`. `RecordDetails({rows:{label,value,term?}[]})` is a `<details>` with mono values, a copy button per row (`navigator.clipboard.writeText`, toast on success), and `term` shown as a `title` tooltip. `Field({label, hint?, error?, children})` wires `aria-describedby`.
  - Verify: build passes
- [ ] 1.5 Interactive primitives
  - Requirements: SPEC-025-R04, R24, R30
  - Files: `web/src/ui.tsx` (new)
  - Do: export styled `Dialog` (title, body, footer buttons, closes on Escape, returns focus), `Menu` and `MenuItem`, `Tooltip`, and `ComboBox` as thin wrappers over react-aria-components (or `<dialog>` and `popover` per OQ 1). No business logic.
  - Verify: build passes; a Dialog opened from the keyboard traps focus and restores it on close
- [ ] 1.6 Toasts and error messages
  - Requirements: SPEC-025-R19, R20
  - Files: `web/src/Toasts.tsx`, `web/src/errors.ts`, `web/src/ErrorMessage.tsx` (all new), `web/src/Workspace.tsx`
  - Do: `toast(message, kind)` dispatches `labrat:toast`. `<Toasts/>` renders a `role="status"` stack bottom-right that dismisses success after 5 s (paused on hover or focus) and keeps errors until closed. `explain(err, action)` implements the table in §3.7 from `ApiError.status` (`TypeError` from `fetch` → network). `ErrorMessage({error, action})` renders title, what went wrong, what to do, then the server message in `.muted`. Mount `<Toasts/>` once in `Workspace`.
  - Verify: build passes; stopping the server and clicking a reload shows the network message

## Phase 2: Shell

- [ ] 2.1 Top bar and theme menu
  - Requirements: SPEC-025-R02, R08
  - Files: `web/src/TopBar.tsx` (new), `web/src/App.tsx`
  - Do: move the header out of `App.tsx` into `TopBar` as in the §3.3 sketch. The search button opens the palette (lift `paletteOpen` setter via a `labrat:palette` window event, as with problems). Leave New and To do as props filled by task 2.4. The user menu holds My account, Theme (Light, Dark, System: sets or removes `data-theme` on `document.documentElement`; `localStorage` `labrat.theme` in try/catch; applied in `main.tsx` before render to avoid a flash) and Sign out.
  - Verify: build passes; theme choice survives reload
- [ ] 2.2 Sidebar replaces the explorer
  - Requirements: SPEC-025-R09, R15
  - Files: `web/src/Sidebar.tsx` (renamed from `Explorer.tsx` with `git mv`), `web/src/Workspace.tsx`
  - Do: keep the tree keyboard model and lazy paging. Add the sections, Lucide icons and run status dots (`aria-label` with the state word) from §3.3, a "+" per section where the user's role allows it, and Admin only for `admin` (from `getMe()`). Empty sections use `EmptyState`. Update imports.
  - Verify: build passes; arrow keys still walk the tree
- [ ] 2.3 Collapsible bottom panel and responsive drawer
  - Requirements: SPEC-025-R10, R11
  - Files: `web/src/BottomPanel.tsx`, `web/src/Workspace.tsx`, `web/src/styles.css`
  - Do: the panel collapses to a 32 px bar showing `Problems (n)`, its state is stored in `localStorage` `labrat.panel`, and it opens on a `labrat:problems` event containing an `error`. Below 1024 px, hide the sidebar column and add a top-bar `PanelLeft` button that opens it as an overlay Dialog (focus trapped, Escape closes). Tables wrap in `overflow-x:auto`.
  - Verify: build passes; at 768 px width no horizontal page scroll on run, experiment and audit views
- [ ] 2.4 To-do view, New menu and To-do count
  - Requirements: SPEC-025-R08, R12
  - Files: `web/src/ToDoView.tsx` (new), `web/src/tabs.ts`, `web/src/Workspace.tsx`, `web/src/TopBar.tsx`, `web/src/CommandPalette.tsx` (entries only)
  - Do: `ToDoView` tabs `Review changes` (`InboxView`) and `Sign-offs` (`SignoffView`), each with its count. In `tabs.ts` add kind `todo` (singleton) and make `fromHash` map `#/inbox` and `#/signoff` to `todo` with the tab preselected (carry it in the tab `id`: `todo`, `todo:signoff`). The top-bar count is `listSignoff()` items plus `listChangeSets({state:'proposed'})` items, refreshed on window focus and after a `labrat:toast` of kind success. Wire the New menu to the dialogs of Phase 4 (placeholders until then).
  - Verify: build passes; an old `#/signoff` link opens the Sign-offs tab

## Phase 3: Home

- [ ] 3.1 `GET /v1/runs`
  - Requirements: SPEC-025-R16
  - Files: `internal/api/runs.go`, `internal/api/server.go`, `README.md` (API list)
  - Do: handler `listRuns` as in §2: `readPage`; parse `state` (comma-separated, each must satisfy a `domain.RunState` known value, else `badRequest("unknown state %q")`); `SELECT r.id, r.label, r.state, r.created_at, e.id, e.slug FROM runs r JOIN experiments e ON e.id = r.experiment_id WHERE ($1::text[] IS NULL OR r.state = ANY($1)) AND (cursor clause as listExperimentRuns) ORDER BY r.created_at DESC, r.id DESC LIMIT $n` inside `WithTenant`. Register `v1.HandleFunc("GET /v1/runs", s.listRuns)`. No audit (read-only), no migration.
  - Verify: `gofmt -l . && go vet ./...` clean; `make test`; `curl` with the dev headers returns running runs only for `?state=running`
- [ ] 3.2 Home view and Get-started guide
  - Requirements: SPEC-025-R13, R14, R15
  - Files: `web/src/api.ts` (add `listAllRuns(states: RunState[], cursor?)`), `web/src/HomeView.tsx` (new), `web/src/tabs.ts`, `web/src/Workspace.tsx`
  - Do: singleton `home`, opened when there is no hash. Four parallel loads per §3.5, each Card with its own loading line, `ErrorMessage` and `EmptyState`. While experiments is empty, show the six-step Get-started list from §3.5 instead of the cards. Add Home to the sidebar and palette.
  - Verify: build passes; on a fresh database (`docker compose down -v && up -d`) Home shows Get started

## Phase 4: The scientist's workflow

- [ ] 4.1 New experiment dialog
  - Requirements: SPEC-025-R21
  - Files: `web/src/api.ts` (add `createExperiment({slug,title,protocol_md})`), `web/src/NewExperimentDialog.tsx` (new), `web/src/TopBar.tsx`, `web/src/HomeView.tsx`
  - Do: Fields Title, Short name (slug rule in §3.6, auto-filled until edited), Protocol (textarea pre-filled with the §3.6 template). On success: toast, open the experiment tab, refresh the sidebar (`labrat:refresh` event). On 409, the slug message from §3.6; otherwise `ErrorMessage`.
  - Verify: build passes; create an experiment from an empty tenant
- [ ] 4.2 Experiment view tabs and protocol editor
  - Requirements: SPEC-025-R15, R22
  - Files: `web/src/api.ts` (add `createProtocolVersion(experimentId, protocol_md)`), `web/src/ExperimentView.tsx`, `web/src/ProtocolEditor.tsx` (new)
  - Do: split the view into Overview, Protocol and Settings tabs per §3.6. Move the existing version list and diff into Protocol, and the signing policy into Settings. Overview's runs table uses `StatusBadge` and **Plan run** opens `NewRunForm`. `ProtocolEditor`: textarea plus markdown-it preview side by side (stacked below 1024 px), Save as new version → toast and reload versions. Move IDs and hashes into `RecordDetails`.
  - Verify: build passes; saving creates v2 and the diff v1↔v2 shows the change
- [ ] 4.3 Run lifecycle stepper and transitions
  - Requirements: SPEC-025-R06, R23, R24
  - Files: `web/src/RunLifecycle.tsx` (new), `web/src/RunView.tsx`
  - Do: the stepper and action bar per §3.6 (next-action table). Each transition opens a `Dialog` with a required reason `Field` → `transitionRun(id, to, reason)` → toast → reload. Abort and Mark failed use `.btn-danger` and the irreversible text. Keep Start's schema-problem dispatch from SPEC-009. Sign opens the existing `SignDialog` only when `listSignoff()` holds this run; otherwise show "Waiting for signatures (n of m)" from the run's policy and signatures.
  - Verify: build passes; walk a run planned → running → paused → running → completed in the UI
- [ ] 4.4 Run inputs
  - Requirements: SPEC-025-R17, R25
  - Files: `web/src/api.ts` (add `createEdge({from,to,relation})`), `web/src/RunInputs.tsx` (new), `web/src/RunView.tsx`
  - Do: list inputs with kind and the glossary label "used as input". **Add input** Dialog with tabs New (kind select + the SPEC-009 `RecordForm` → `createNode` → `createEdge({from: node.id, to: run.node_id, relation: 'used'})`; edges point downstream, input → run) and Existing (ID Field → `createEdge({from: <entered id>, to: run.node_id, relation: 'used'})`). Shown only in planned, running or paused. Errors via `ErrorMessage`.
  - Verify: build passes; add a new reagent and an existing sample by ID; both appear and show in lineage
- [ ] 4.5 Run data and Send-data panel
  - Requirements: SPEC-025-R18, R26
  - Files: `web/src/RunData.tsx` (new), `web/src/RunView.tsx`
  - Do: dataset table (label, instrument, readings in `.num`, time). While running, a **Send data** popover with an instrument ComboBox and the copyable example from §3.6, filled with `location.origin`, the chosen instrument id and the run id. Dataset SHA-256s and run, protocol and manifest digests go in the run's `RecordDetails`. Use glossary labels throughout the run view.
  - Verify: build passes; pasting the copied command with a real token and `examples/streams/hplc-uv.ndjson` adds a dataset that appears after reload
- [ ] 4.6 Register instrument dialog
  - Requirements: SPEC-025-R27
  - Files: `web/src/api.ts` (add `createInstrument({name,kind})`), `web/src/NewInstrumentDialog.tsx` (new), `web/src/TopBar.tsx`, `web/src/Sidebar.tsx`
  - Do: Name Field, Kind ComboBox seeded from distinct kinds of `listInstruments()`, free text allowed. Toast, open the instrument tab, refresh the sidebar.
  - Verify: build passes; the new instrument appears in the sidebar and in the Send-data picker

## Phase 5: Restyle the remaining views

- [ ] 5.1 Lineage explorer
  - Requirements: SPEC-025-R17, R29
  - Files: `web/src/LineageView.tsx`
  - Do: node shapes per kind (§3.8), colours read from computed tokens (`getComputedStyle(document.documentElement)`) and re-applied on theme change (`matchMedia` listener plus a `labrat:theme` event from task 2.1), edge labels from the glossary, a legend Card, and labelled zoom-in, zoom-out and fit icon buttons (`cy.zoom`, `cy.fit`). Node details use `RecordDetails` for ids.
  - Verify: build passes; graph readable in both themes; 500-node closure still renders within 2 s
- [ ] 5.2 Audit, To-do, signatures, sign dialog and notes
  - Requirements: SPEC-025-R17, R18, R20, R28
  - Files: `web/src/AuditView.tsx`, `web/src/InboxView.tsx`, `web/src/SignoffView.tsx`, `web/src/SignaturesPanel.tsx`, `web/src/SignDialog.tsx`, `web/src/Notes.tsx`, `web/src/EditField.tsx`
  - Do: move each to `.card`, `.table`, `.btn*`, `Field`, `StatusBadge`, `EmptyState`, `ErrorMessage` and toasts; "change set" → "change request" in labels; digests into `RecordDetails`. No behaviour change: SignDialog's re-authentication logic is untouched.
  - Verify: build passes; `cd web && npm run e2e` (SPEC-008 signature tests) passes, with selectors updated only where an element was renamed
- [ ] 5.3 Schemas and schema forms
  - Requirements: SPEC-025-R28
  - Files: `web/src/SchemasView.tsx`, `web/src/SchemaView.tsx`, `web/src/SchemaDraftEditor.tsx`, `web/src/RecordForm.tsx`, `web/src/NewNodeView.tsx`, `web/src/NewRunForm.tsx`
  - Do: same component move; rjsf output picks up the `components.css` field styling; empty schema list uses `EmptyState` with "New schema" for users who may create one.
  - Verify: build passes; a schema-driven form shows labels, hints and inline errors in both themes
- [ ] 5.4 Account and admin
  - Requirements: SPEC-025-R17, R28
  - Files: `web/src/MeView.tsx`, `web/src/PrincipalsView.tsx`, `web/src/DelegationsView.tsx`, `web/src/SignIn.tsx`, `web/src/InstrumentView.tsx`
  - Do: same component move; "principal" → "user or service account" in labels; Sign-in page gets the LabRat wordmark centred in a Card.
  - Verify: build passes
- [ ] 5.5 Remove legacy styles
  - Requirements: SPEC-025-R01, R28
  - Files: `web/src/styles.css`
  - Do: delete the old colour block and every rule no longer referenced. `styles.css` keeps only layout (grid areas, tab strip, panel). No raw colours remain anywhere in `web/src/*.css` except `tokens.css`.
  - Verify: `grep -nE '#[0-9a-fA-F]{3,6}\b' web/src/styles.css web/src/components.css` finds nothing; build passes; every view checked by eye in both themes at 1440, 1024 and 768 px

## Phase 6: Verify and close out

- [ ] 6.1 Accessibility pass: keyboard-only walk of the Get-started path; axe DevTools on Home, Experiment, Run, Lineage, To do and Audit in both themes, with no serious or critical issue (R03, R30)
- [ ] 6.2 Bundle check: gzipped `web/dist` under 1 MB; `gofmt -l . && go vet ./...` clean; `make test`
- [ ] 6.3 `make test-integration` and `cd web && npm run e2e` pass
- [ ] 6.4 `verifier` passes the whole spec
- [ ] 6.5 `uat-planner` writes [uat.md](uat.md), including a new-scientist walk from an empty tenant to a signed run using only the UI
- [ ] 6.6 Status set to Implemented, folder moved to `specs/implemented/`, `ROADMAP.md` updated
- [ ] 6.7 Summary commit written as the PR description
