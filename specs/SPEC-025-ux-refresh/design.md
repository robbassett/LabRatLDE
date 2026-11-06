# SPEC-025 design: UI/UX refresh

Requirements: [requirements.md](requirements.md)

**The style seed is the LabRat mark, `docs/logo.jpg` (OQ 5).** It is a flat, Bauhaus-style rat built from circles, quarter-circles and a square frame in four colours on warm paper. The palette, shape language and heading font all come from it (§3.0).

The rest came from the `ui-ux-pro-max` skill, adjusted for an air-gapped, regulated work tool:
- Its design-system search ("scientific laboratory data platform", density 7, motion 2, variance 3) gave the Swiss-minimal layout discipline, light and dark modes, Fira Sans and Fira Code, and the accessibility checklist.
- A typography search ("geometric bauhaus modern") gave Outfit for headings.
- Dropped: the suggested "Enterprise Gateway" landing-page pattern (this is an app, not a marketing site), scroll-reveal motion, Google-hosted fonts (air gap), and the generic navy and amber palette, which the mark's palette replaces. The skill's colour search returned no fitting match ("teal navy calm scientific" gave yoga and healthcare palettes), so every colour below comes from the mark.

## 1. Simplicity budget

- **Approach:** keep React + Vite + plain CSS. Add one token file and one shared component stylesheet. Write a dozen small presentational components in `web/src/` (flat, like today). Add four new workflow views and dialogs that call endpoints the API already has. Add one small read endpoint for Home.
- **Keep the SPEC-005 shell model:** tabs, hash links, command palette, bottom panel. The refresh reorganises and restyles it rather than replacing it, so links and keyboard habits survive.
- **Not doing:** a CSS framework (Tailwind), CSS-in-JS, a full component kit (MUI, Chakra), a router library, a state library, a new rjsf theme package, animation libraries (no GSAP: CSS transitions suffice at motion 2), or any API change beyond `GET /v1/runs`.
- **New dependencies** (all stock, permissive licences, recorded in §5):
  - `lucide-react` (ISC): icons, imported one by one so only the used icons ship.
  - `@fontsource/outfit`, `@fontsource/fira-sans`, `@fontsource/fira-code` (OFL-1.1): self-hosted fonts, Latin subset only, bundled by Vite and served from the binary.
  - `react-aria-components` (Apache-2.0): menu, dialog, popover, tooltip and combobox with correct keyboard and screen-reader behaviour (OQ 1).

## 2. Data and interfaces

### `GET /v1/runs` (R16)

```
GET /v1/runs?state=running,paused&limit=20&cursor=<id>
200 {"items":[{"id":"…","label":"Batch 7 HPLC","state":"running","created_at":"…",
               "experiment_id":"…","experiment_slug":"hplc-purity"}],
     "next_cursor":"…"|null}
400 unknown state name
```

- Handler `listRuns` in `internal/api/runs.go`, next to `listExperimentRuns`, using the same `readPage` and `nextCursor` helpers. It runs one `SELECT … FROM runs JOIN experiments` inside `WithTenant` (RLS scopes it), `ORDER BY created_at DESC, id DESC`.
- `state` is optional. Each comma-separated value must be a valid `domain.RunState`.
- Read-only: no audit event, no migration, no new grant (`lde_app` already selects both tables).
- Documented in the API reference with the other run endpoints. The UI keeps no private endpoint (SPEC-005-R03).

No tables, triggers or SQLSTATE codes are added.

## 3. UI

### 3.0 Brand: what the mark gives the UI (R31)

Colours sampled from `docs/logo.jpg`:

| Mark colour | Sampled | Becomes |
|---|---|---|
| Paper | `#F4F5EF` | light `--bg` (warm off-white, not pure white) |
| Teal | `#3A7B7D` | brand teal. Too light for text on paper (4.44:1), so `--primary` uses the slightly deeper `#2F6E70` (5.34:1). Graphic fills such as the mark and illustrations use `#3A7B7D` itself |
| Slate navy | `#384857` | `--brand-navy`: headings and wordmark (8.58:1 on paper). Darkened to `#1F2B36` for body text, and the base of the dark theme (`#17212B`) |
| Powder blue | `#A7C2D3` | `--tint-blue`: selected rows, active sidebar item, `info` and `run` in the dark theme |
| Aqua | `#ACCECD` | `--tint-aqua`: hover and highlight surfaces, the Get-started panel. Dark `--primary` is a lighter aqua-teal (`#7FC3C0`) |

The mark has no warm colour. LabRat needs one signal for "needs you" that is never confused with the teal brand or a status, so `--accent` is a single **terracotta** (`#9E4422`), the complement of teal and in keeping with the Bauhaus palette. It's used sparingly: the To-do count, "to check" badges and the Get-started step marker.

**Shape language:**
- Flat colour: no gradients, glows or glass. Elevation comes from a 1 px border; only floating layers (menus, popovers, dialogs) get `--shadow-pop`.
- Two geometries, as in the mark: **square frames** for containers (cards, panels, tables, dialogs, inputs) with a small radius (`--radius-sm 2px`, `--radius-md 4px`), and **full circles** for the things that are "alive": status dots, avatar initials, the To-do count, the lifecycle stepper's nodes, and lineage `sample` nodes.
- **Quarter-circles** as the one decorative motif: the active sidebar item's indicator, the corner of the Home greeting band, and empty-state illustrations.
- **Empty-state illustrations** are small inline SVGs, 96 px or smaller, composed only of the mark's primitives (circle, quarter-circle, square) in `--tint-blue`, `--tint-aqua` and brand teal. They are `aria-hidden`, and the sentence beside them carries the meaning. Six are needed: experiments, runs, inputs, data, to-do and search. They live in `web/src/illustrations.tsx`.

**The mark in the UI:** `web/src/LabRatMark.tsx` redraws the square mark as inline SVG from the logo's geometry (4 colours, no paper background, so it sits on either theme). It shows at 24 px in the top bar next to the wordmark "LabRat" in Outfit 600 `--brand-navy`, at 96 px on the sign-in card, and as the favicon (`web/src/assets/favicon.svg`, plus a 32 px PNG fallback cropped from `docs/logo.jpg`). In the dark theme the mark's navy shapes swap to a light `#DCE6EC` through `currentColor` (see §5), so the rat stays visible. `docs/logo.jpg` stays the master artwork.

### 3.1 Tokens (`web/src/tokens.css`, R01–R03)

Ratios are WCAG 2.x, computed against `--bg` and `--surface`. Each value goes in a comment beside its token, as `styles.css` does today.

| Token | Light | ratio bg / surface | Dark | ratio bg / surface | Use |
|---|---|---|---|---|---|
| `--bg` | `#F4F5EF` | | `#17212B` | | page (mark's paper / deep slate navy) |
| `--surface` | `#FBFBF8` | | `#1F2C38` | | cards, panels, dialogs |
| `--surface-2` | `#E9EEEC` | | `#283847` | | table stripes, code blocks, agent-written text |
| `--tint-blue` | `#A7C2D3` at 35% on surface | decorative | `#A7C2D3` at 18% on surface | decorative | selected row, active sidebar item |
| `--tint-aqua` | `#ACCECD` at 40% on surface | decorative | `#ACCECD` at 15% on surface | decorative | hover, highlight, Get-started panel |
| `--fg` | `#1F2B36` | 13.15 / 13.90 | `#ECEEE8` | 13.94 / 12.17 | text |
| `--brand-navy` | `#384857` | 8.58 / 9.07 | `#A7C2D3` | 8.77 / 7.66 | headings, wordmark |
| `--muted` | `#4F5E6B` | 6.09 / 6.44 | `#A9B6C1` | 7.87 / 6.88 | secondary text |
| `--border` | `#DCE1DE` | decorative | `#2E3E4D` | decorative | dividers only |
| `--border-strong` | `#6B7C8A` | 3.93 / 4.15 | `#7A8D9E` | 4.76 / 4.15 | input and control boundaries (≥3:1; also ≥3:1 on `--surface-2`) |
| `--primary` | `#2F6E70` | 5.34 / 5.65 | `#7FC3C0` | 8.12 / 7.09 | primary buttons, links, focus ring |
| `--on-primary` | `#FFFFFF` | 5.86 on primary | `#17212B` | 8.12 on primary | text on primary |
| `--brand-teal` | `#3A7B7D` | graphic only (4.44) | `#3A7B7D` | graphic only | the mark, illustrations |
| `--accent` | `#9E4422` | 5.80 / 6.13 | `#F0A27E` | 7.89 / 6.89 | "needs you": To-do count, "to check" badges |
| `--danger` | `#B42318` | 6.00 / 6.34 | `#F59A8E` | 7.68 / 6.71 | errors, destructive actions |
| `--ok` | `#2E7046` | 5.44 / 5.75 | `#86CFA0` | 8.88 / 7.76 | success, completed |
| `--warn` | `#8A5A00` | 5.41 / 5.72 | `#E8C066` | 9.44 / 8.24 | warnings, paused |
| `--info` | `#2F5F86` | 6.17 / 6.53 | `#A7C2D3` | 8.77 / 7.66 | running, info |
| `--signed` | `#5B3F99` | 7.32 / 7.74 | `#C7B5F2` | 8.78 / 7.67 | signed state |
| `--kind-sample` | `#2E7046` | 5.44 | `#86CFA0` | 8.88 | lineage |
| `--kind-reagent` | `#8A5A00` | 5.41 | `#E8C066` | 9.44 | lineage |
| `--kind-protocol` | `#5B3F99` | 7.32 | `#C7B5F2` | 8.78 | lineage |
| `--kind-run` | `#2F5F86` | 6.17 | `#A7C2D3` | 8.77 | lineage |
| `--kind-instrument` | `#9E4422` | 5.80 | `#F0A27E` | 7.89 | lineage |
| `--kind-dataset` | `#2F6E70` | 5.34 | `#7FC3C0` | 8.12 | lineage |
| `--kind-analysis` | `#A23B72` | 5.63 | `#F2A0C8` | 8.25 | lineage |

Badge backgrounds are the state colour mixed at 14% into `--surface` (`color-mix(in srgb, var(--info) 14%, var(--surface))`), with the text in the state colour. Computed for this palette, every badge pair is at least 4.6:1 in light and 5.1:1 in dark: info 5.31 / 5.65, ok 4.75 / 5.71, warn 4.68 / 6.05, danger 5.04 / 5.19, signed 6.23 / 5.67, muted 5.27 / 5.21, primary 4.65 / 5.33, accent 4.97 / 5.25. Task 1.2 records them beside the tokens.

- **Type:** `--font-display: "Outfit", "Fira Sans", system-ui, sans-serif` for the wordmark, view titles and card headings (weights 500 and 600, `--brand-navy`; geometric like the mark). `--font-sans: "Fira Sans", system-ui, sans-serif` for everything else, `--font-mono: "Fira Code", ui-monospace, monospace` with `font-variant-numeric: tabular-nums`. Scale: `--text-xs 12px` (badges, captions; never body text), `--text-sm 14px` (tables, sidebar, dense UI), `--text-md 16px` (body, protocol prose, forms), `--text-lg 20px` (view titles), `--text-xl 24px` (Home greeting). Line height 1.5 for body, 1.25 for headings. Weights 400, 500 and 600 only.
- **Spacing:** 4 px base: `--space-1 4px`, `-2 8px`, `-3 12px`, `-4 16px`, `-6 24px`, `-8 32px`, `-12 48px`.
- **Shape** (§3.0): `--radius-sm 2px` (inputs, badges), `--radius-md 4px` (buttons, cards, dialogs), `--radius-full 9999px` (status dots, avatars, counts, stepper nodes). There is one shadow, `--shadow-pop`, for menus, popovers and dialogs. Cards use a border, not a shadow.
- **Motion:** `--dur-fast 150ms`, `--dur-base 200ms`, `--dur-slow 250ms`, `--ease: cubic-bezier(.2,0,0,1)`. A `@media (prefers-reduced-motion: reduce)` block sets all durations to `0ms` (R07).
- **Themes:** the light values sit on `:root`. The dark values apply under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }` and again under `:root[data-theme="dark"]`. The user menu sets or removes `data-theme` on `<html>` and stores `labrat.theme` in `localStorage`, wrapped in try/catch (R02). The lineage graph reads its colours from computed tokens and restyles when the theme changes.

### 3.2 Components (`web/src/components.css` plus small TSX files)

| Component | File | Notes |
|---|---|---|
| Button | CSS classes `.btn`, `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.btn-icon` | 32 px tall (≥24 px target, R30); icon-only buttons need `aria-label` plus a tooltip (R04) |
| Icon | `lucide-react` direct imports | 16 px in dense UI, 20 px in the sidebar; `aria-hidden` beside text |
| StatusBadge | `StatusBadge.tsx` | `state → {icon, colour token, word}`, see §3.4 (R06) |
| Card | `.card` | surface, border, `--radius-md`, `--space-4` padding |
| Field | `Field.tsx` | visible label, optional hint, error below the field with `aria-describedby`; never a placeholder used as the label |
| DataTable | `.table` | sticky header, `--text-sm`, row hover, numbers right-aligned in mono, `overflow-x:auto` wrapper (R11) |
| Dialog, Menu, Tooltip, ComboBox | `ui.tsx` (thin wrappers over react-aria-components) | one file exporting the four styled wrappers |
| Toast | `Toasts.tsx` | `toast(message, kind)` through a window event like `labrat:problems`; `role="status"`; 5 s, pauses on hover and focus; errors don't auto-dismiss (R20) |
| EmptyState | `EmptyState.tsx` | icon, one sentence, optional action button (R15) |
| RecordDetails | `RecordDetails.tsx` | `<details>` (collapsed) listing `{label, value}` rows in mono with copy buttons (R18) |
| ErrorMessage | `ErrorMessage.tsx` plus `errors.ts` | renders `explain(err, action)` inline (R19) |

**rjsf forms (SPEC-009)** stay on `@rjsf/core`'s default templates. `components.css` styles their generated class names (`.form-group`, `.control-label`, `.field-description`, `.error-detail`) with the Field look, so no rjsf theme package is needed.

### 3.3 Shell (R08–R12)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ◧ LabRat   [ Search or jump to…        Ctrl K ]   [+ New ▾]  [✓ To do 3]  (RB ▾)│ top bar 48px
├──────────────┬────────────────────────────────────────────────────────────────┤
│ ⌂ Home       │ [Run: Batch 7 ×] [Experiment: hplc-purity ×]                   │ tab strip
│ ⚗ Experiments│ ┌────────────────────────────────────────────────────────────┐ │
│   hplc-purity│ │                                                            │ │
│     Batch 7 ●│ │                    active view                             │ │
│ ⏚ Instruments│ │                                                            │ │
│ { } Schemas  │ └────────────────────────────────────────────────────────────┘ │
│ ✓ To do    3 │                                                                │
│ ⛓ Audit trail│                                                                │
│ ⚙ Admin      │ ─ Problems (2) · History ───────────────────────────── [▴] ─── │ bottom panel, collapsed
└──────────────┴────────────────────────────────────────────────────────────────┘
```
(Glyphs here are sketch placeholders. The build uses Lucide icons: `House`, `FlaskConical`, `Gauge`, `Braces`, `ListChecks`, `ShieldCheck`, `Settings`.)

- **`TopBar.tsx`** replaces the inline header in `App.tsx`. The search field is a button styled as an input that opens `CommandPalette`. The **New** menu items open the dialogs from §3.6. **New run** opens a small dialog that picks the experiment, then `NewRunForm`. **New sample or material** opens `NewNodeView`. The To-do count is the signoff inbox length plus the proposed change sets the user can decide, refreshed on focus and after any decision.
- **`Sidebar.tsx`** replaces `Explorer.tsx`. It keeps the explorer's tree keyboard model and lazy loading, but adds section headings, icons, run status dots (colour plus `aria-label` with the state) and a "+" action per section (role-gated). Admin is visible only when `getMe()` roles include `admin`.
- **Bottom panel:** collapsed to a 32 px bar by default. Its open state is stored in `localStorage`. A `labrat:problems` event carrying any `severity: error` problem opens it.
- **Below 1024 px:** the grid drops the sidebar column, and a top-bar `PanelLeft` button opens it as an overlay drawer that traps focus and closes on Escape.
- **`ToDoView.tsx`** hosts `InboxView` and `SignoffView` as tabs (`Review changes`, `Sign-offs`). `tabs.ts` maps kinds `inbox` and `signoff` to the `todo` singleton with the matching tab selected, so old links still work.

### 3.4 Glossary and state presentation (R06, R17)

| Term in data | Label in UI |
|---|---|
| `used` | used as input |
| `wasGeneratedBy` | produced by (dataset ← run) / produced (run → dataset) |
| `wasDerivedFrom` | derived from |
| `wasInformedBy` | informed by |
| `wasAssociatedWith` | carried out with |
| `wasAttributedTo` | recorded by |
| lineage node | item |
| change set | change request |
| manifest digest | record fingerprint (in Record details, with the term in a tooltip) |
| principal | user or service account |
| `attrs` / `params` | details / parameters |

| Run state | Icon | Token | Word |
|---|---|---|---|
| planned | `CircleDashed` | `--muted` | Planned |
| running | `CirclePlay` | `--info` | Running |
| paused | `CirclePause` | `--warn` | Paused |
| completed | `CircleCheck` | `--ok` | Completed |
| failed | `CircleX` | `--danger` | Failed |
| aborted | `Ban` | `--muted` | Aborted |
| signed | `BadgeCheck` | `--signed` | Signed |

### 3.5 Home (R13–R15)

```
Good morning, Rob                                                  [+ New experiment]
┌ Needs you ──────────────────────────┐  ┌ Runs in progress ────────────────────────┐
│ ✍ Sign Batch 6 HPLC  (reviewer)  →  │  │ ● Running  Batch 7 HPLC   hplc-purity  → │
│ ⇄ Review "fix pH units"         →   │  │ ‖ Paused   Cell count 3   vicell-qc    → │
└─────────────────────────────────────┘  └──────────────────────────────────────────┘
┌ Recent experiments ──────────────────────────────────────────────────────────────┐
│ hplc-purity   HPLC purity of batch lots        4 runs · 1 running   2026-11-05   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- Data comes from `listSignoff()`, `listChangeSets({state:'proposed'})` filtered to ones the user may decide, `GET /v1/runs?state=running,paused&limit=10` and `listExperiments()` (first page). The four calls run in parallel, and each card shows its own loading and empty state.
- **Get started** replaces the cards while `listExperiments()` returns no items. It is a numbered list of six steps, each with a sentence and a button: (1) New experiment → dialog, (2) Write the protocol → explained in step 1's dialog, (3) Plan a run → opens the experiment, (4) Add inputs and start → explained, (5) Send data → links to the Send-data help, (6) Complete and sign → explained. Steps that need a record that doesn't exist yet are shown, but their buttons are disabled with a hint. Home is the singleton tab `home`, opened when there is no hash.

### 3.6 Workflow screens (R21–R27)

**Run view (`RunView.tsx`, restructured)**

```
Batch 7 HPLC                         ● Running            [Complete run]  [⋯ More ▾]
hplc-purity · protocol v3                                  (More: Pause, Mark failed, Abort)
 ●───────────●───────────○───────────○
 Planned     Running     Completed   Signed
┌ Parameters ─────────────┐ ┌ Inputs ─────────────────────── [+ Add input] ┐
│ column: C18  flow: 1.0  │ │ ■ Lot R-2291 (reagent) used as input         │
└─────────────────────────┘ └──────────────────────────────────────────────┘
┌ Data ──────────────────────────────────────────────────── [Send data ▾] ┐
│ HPLC-1 · UV run 1      12,480 readings     2026-11-06 09:30              │
└─────────────────────────────────────────────────────────────────────────┘
┌ Notes ┐ ┌ Signatures ┐                                ▸ Record details
```

- **`RunLifecycle.tsx`**: the stepper plus the action bar. Next action by state: planned → **Start run**; running → **Complete run** (More: Pause, Mark failed, Abort); paused → **Resume** (More: Abort); completed or failed → **Sign** when `listSignoff()` holds this run for the user, otherwise the text "Waiting for signatures (n of m)"; signed → none (the existing **Propose correction** stays in More); aborted → none. Every transition opens a Dialog with a required reason Field and calls `transitionRun(id, to, reason)`. Abort and Mark failed use `.btn-danger` and the text "This can't be undone. The run will stay in the record as aborted/failed." (R24). Start keeps its schema-problem handling from SPEC-009 (problems go to the Problems panel).
- **`RunInputs.tsx`**: lists the run's inputs (from `getRun`). **Add input** opens a Dialog with two tabs. *New*: kind (sample, reagent, other kinds from the schema list) plus the `RecordForm` schema form, then `createNode` and `createEdge({from: new node, to: run.node_id, relation: 'used'})`. Edges point downstream: the input is `from` and the run is `to` (`internal/domain/lineage.go`). *Existing*: an ID field (paste or barcode scan), then `createEdge`. Shown only while the run is planned, running or paused. A sealed run's DB error falls back to R19's message.
- **`RunData.tsx`**: the dataset table. While running, **Send data** opens a popover with an instrument ComboBox (from `listInstruments`) and a copyable block:
  ```
  curl --data-binary @readings.ndjson -H 'Content-Type: application/x-ndjson' \
       -H 'Authorization: Bearer <your token>' \
       "<origin>/v1/instruments/<instrument id>/stream?run_id=<run id>&label=<label>"
  # each line: {"ts":"2026-11-06T09:30:00Z","channel":"UV_254nm","value":0.0012,"unit":"AU"}
  ```
  It also says: "Instrument PCs usually send this automatically. Ask your lab's automation contact."
- IDs, protocol hash, dataset SHA-256 and manifest digest move into **Record details** (R18). History stays in the bottom panel.

**Experiment view (`ExperimentView.tsx`, restructured into tabs, R22)**
- *Overview*: title (inline-editable as today) and run counts by state, the current protocol rendered with markdown-it, and the runs DataTable (label, StatusBadge, created) with **Plan run**, which opens the existing `NewRunForm`.
- *Protocol* (`ProtocolEditor.tsx`): a split textarea and live preview, a **Save as new version** button with the note "Runs already planned keep the version they pinned", then `createProtocolVersion`. Below it, the version list and the existing two-version diff.
- *Settings*: the existing signing-policy editor.

**Dialogs:** `NewExperimentDialog.tsx` (R21) and `NewInstrumentDialog.tsx` (R27, name plus a kind ComboBox seeded from existing instrument kinds, free text allowed). The protocol template:
```markdown
## Aim
## Materials
## Method
1.
## Expected results
```
Slug: lower-case title, non-alphanumerics → `-`, trimmed, max 64 characters, editable. A server 409 shows "That short name is taken. Try another."

### 3.7 Error messages (R19)

`errors.ts` exports `explain(err: unknown, action: string): {title, detail, hint}`. The title is always `Couldn't <action>`, e.g. "Couldn't start the run".

| Status | What went wrong | What you can do |
|---|---|---|
| network failure | LabRat can't be reached. | Check your connection and try again. Nothing was saved. |
| 400 | Something in the request isn't valid. | Check the highlighted fields. (server message as detail) |
| 401 | Your session has ended. | Sign in again. (existing handler signs out) |
| 403 | You don't have the role this needs. | Ask an admin for the role named below. (server message names it) |
| 404 | That item doesn't exist, or you can't see it. | Check the ID, or ask whoever shared it. |
| 409 | The record changed or is locked: it may be signed or already in that state. | Reload to see its current state. To change a signed record, propose a correction. |
| 413 | The upload is too large. | Split it into smaller parts. |
| 422 (with `errors`) | The details don't match the schema. | Fix the problems listed in the Problems panel. |
| 422 (other) | It refers to something that doesn't exist here. | Check the linked item's ID. |
| 5xx | LabRat hit an internal error. | Try again. If it keeps happening, tell your administrator the time it happened. |

### 3.8 Restyle (R28–R30)

Each existing view moves to the components above, with no behaviour change. Notable points:
- **Lineage:** a node shape per kind (sample `ellipse`, reagent `round-diamond`, protocol `round-rectangle` with a dashed border, run `hexagon`, instrument `round-triangle`, dataset `barrel`, analysis `round-pentagon`). A legend card lists the kind, shape and colour. Edge labels come from the glossary. Zoom-in, zoom-out and fit buttons sit as an icon-button group with labels.
- **Audit:** the event table in mono with sequence numbers; the verify result in a Card with an `ok`/`danger` icon and words.
- **Sign dialog:** restyled only. Its re-authentication flow is unchanged (SPEC-008).
- **Focus:** `:focus-visible` is a 2 px `--primary` outline with a 2 px offset. `scroll-padding-top` is the top-bar height, and the bottom panel's height is added to `scroll-padding-bottom` while it is open, so focused controls are never covered (R30).
- **Playwright:** no flow is added as a test (open question 4). `web/e2e` stays as SPEC-008 left it, and its selectors are updated to match renamed elements.

## 4. Testing approach

No `Test: yes` requirements, so no new tests. The existing SPEC-008 Playwright tests must still pass after the restyle (task 6.3). Review checks each requirement, and `uat.md` covers the workflow end to end.

## 5. Decision log

| Date | Decision | Why | Alternatives rejected |
|---|---|---|---|
| 2026-11-06 | Insert SPEC-025 before SPEC-010 | Ten more specs will add screens; a shared design system first keeps them consistent and is cheaper than restyling later | Restyle after Phase 2 |
| 2026-11-06 | Keep the SPEC-005 shell (tabs, palette, bottom panel), reorganised and restyled | Deep links and keyboard habits survive; smaller change | A page-based router rewrite |
| 2026-11-06 | Plain CSS with custom-property tokens | Already in use, no build step, CSP-friendly | Tailwind (new toolchain), CSS-in-JS (runtime cost, CSP `unsafe-inline` risk) |
| 2026-11-06 | `lucide-react` for icons | ISC licence, per-icon imports keep the bundle small, consistent outline style that suits Swiss-minimal | Phosphor (heavier package), Heroicons (fewer science-relevant icons) |
| 2026-11-06 | `@fontsource/fira-sans` and `@fontsource/fira-code`, Latin subset, self-hosted | OFL licence; works air-gapped and within the self-origin CSP; tabular numerals for measured values | Google Fonts CDN (network, CSP), system fonts only (inconsistent numerals across OSes) |
| 2026-11-06 | `react-aria-components` for interactive primitives (OQ 1: confirmed) | Stock, Apache-2.0, accessible menus, dialogs and combobox; rebuilding those is a known accessibility risk | Radix (good, but fewer form primitives such as ComboBox), hand-written widgets |
| 2026-11-06 | Light theme default, dark available | Labs are brightly lit; contrast holds in both | Dark only (today) |
| 2026-11-06 | The LabRat mark (`docs/logo.jpg`) is the style seed: palette, shape language, illustrations (OQ 5) | One recognisable identity; the mark's flat Bauhaus geometry suits a calm, precise work tool | The generic navy and amber palette from the design-system search |
| 2026-11-06 | One terracotta accent outside the mark's palette | "Needs you" must stand apart from the teal brand and from the status colours | Using teal for attention (it would collide with primary actions) |
| 2026-11-06 | `@fontsource/outfit` for headings and the wordmark | Geometric sans that matches the mark's circles (ui-ux-pro-max "Bauhaus Geometric" pairing); OFL | Outfit for body text too (Fira Sans reads better in dense tables) |
| 2026-11-06 | Mark redrawn as SVG; PNG crop only as the favicon fallback | Crisp at 16–96 px in both themes; `currentColor` lets the navy shapes lighten in dark mode | Using the JPG directly (blurry, fixed paper background) |
| 2026-11-06 | Error messages chosen by HTTP status plus action, no new error codes | The API has no stable error codes; status plus the server message is enough to say what to do | Adding machine error codes to every endpoint (API-wide change, a separate spec if needed) |
| 2026-11-06 | One read endpoint, `GET /v1/runs` | Home needs runs in progress across experiments; per-experiment fan-out is N+1 calls | Fetch every experiment's runs from the browser |
| 2026-11-06 | Build: dark-theme mark ink is `#DCE6EC`, not `#A7C2D3` | With `#A7C2D3` the mark's navy ring and ear merge into the powder-blue disc and ear beside them, so the rat loses its shape | `#A7C2D3` as first written in §3.0 |
| 2026-11-06 | Build: favicon and its PNG fallback live in `web/src/assets/` and go through Vite | The Go handler serves only `/` and `/assets/*`, so files in `web/public/` would 404; `assetsInlineLimit: 0` keeps every asset a same-origin file under the CSP (no `data:` URIs) | Widening the Go handler to serve root files |
| 2026-11-06 | Build: the To-do count is sign-offs plus proposed change requests whose author is not the user (or the human an agent acts for) | Nobody reviews their own proposal; the server has no "decidable by me" filter | A new API filter |
| 2026-11-06 | Build: the lifecycle bar's **Sign** presses the Signatures panel's own Sign button | Keeps SPEC-008's signing and re-authentication in one place, untouched | A second copy of the sign flow in the lifecycle bar |
| 2026-11-06 | Build: the dataset table shows label and readings only | `GET /v1/runs/{id}` doesn't return a dataset's instrument or time; adding them is an API change outside this spec | Extending the run detail response |
| 2026-11-06 | Build: run inputs added from the Existing tab are checked as UUIDs in the browser before `createEdge` | Catches a mistyped or half-scanned barcode with a field error instead of a server 400 | Server-side only |
