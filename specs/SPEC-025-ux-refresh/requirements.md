# SPEC-025: UI/UX refresh: design system and the scientist's workflow

| | |
|---|---|
| **Status** | Approved |
| **Owner** | Rob Bassett |
| **Created / Updated** | 2026-11-06 / 2026-11-06 |
| **Regulatory refs** | none (it displays records; it changes no rule about them) |
| **Depends on** | `SPEC-005` (shell), `SPEC-008` (signing UI), `SPEC-009` (schema forms) |

Design: [design.md](design.md) · Tasks: [tasks.md](tasks.md)

Sequencing: built **before SPEC-010**. Every later spec's screens are written against the design system and patterns defined here (see the UI sections of SPEC-010 to SPEC-024).

## 1. Problem

LabRat's primary users are bench scientists (decision D7), but the UI they have today doesn't show them how to do science. It looks like a developer tool: a dark-only IDE shell, a tree of raw records, UUIDs and SHA-256 digests in the main content, and PROV terms such as `wasGeneratedBy` as labels. It also can't do the basic work. The engine already supports creating an experiment, writing and revising its protocol, linking a run's inputs, moving a run through its lifecycle and registering an instrument. The UI offers almost none of these, so a scientist has no path from "I have an idea" to "my run is signed". Each feature spec so far has added its own screens without a shared visual language, so the product looks inconsistent and gets harder to use with every addition. Fixing this now, before ten more specs add screens, is far cheaper than fixing it later.

## 2. Scope

**In scope**
- A **design system**: colour, type, spacing and motion tokens, light and dark themes, one icon set, self-hosted fonts and a small set of shared components (button, badge, card, field, table, dialog, menu, toast, empty state, record details).
- A **restructured shell**: top bar, sectioned sidebar, collapsible bottom panel, a Home view, a merged To-do view, and tablet widths down to 768 px.
- **The scientist's workflow in the UI**, over existing public endpoints: new experiment, write and revise the protocol, plan a run, add inputs, start, pause, resume, complete, fail or abort it, send data, sign. Also register an instrument.
- **Guidance**: a Get-started guide for an empty workspace, useful empty states, plain-language labels, and error messages that say what to do next.
- **Restyling every existing screen** onto the design system: lineage, audit, review and sign-off, notes, signatures, schemas and schema forms, account and admin.
- One read endpoint, `GET /v1/runs`, so Home can list runs in progress across experiments.

**Out of scope**
- Phone layouts (narrower than 768 px), localisation and user-configurable layouts.
- Searching for existing samples or materials by name in the input picker. This needs node search (SPEC-011). Until then an existing input is added by its ID.
- Uploading raw instrument files (SPEC-012) and typing readings in by hand. Data still arrives through the instrument stream endpoint.
- Any change to what an action does, who may do it or what is audited. Only how it is presented changes.
- Charts of readings (SPEC-011).
- An example-experiment generator for the Get-started guide (OQ 2: left out for now).
- A Playwright test of the workflow (OQ 4: UAT covers it).

## 3. Requirements (EARS)

### Design system

| ID | Requirement | Test | Source |
|---|---|---|---|
| SPEC-025-R01 | The UI shall take every colour, font size, spacing step, radius, shadow and transition duration from design tokens defined once in `web/src/tokens.css`, and component styles shall not contain raw colour values. | no | consistency |
| SPEC-025-R02 | The UI shall offer a light and a dark theme, follow the operating system's `prefers-color-scheme` by default (light when there is no preference), and let the user choose Light, Dark or System from the user menu, remembering the choice in that browser. | no | user need (bright labs) |
| SPEC-025-R03 | Every text token shall have a contrast ratio of at least 4.5:1, and every UI-boundary or graph-fill token at least 3:1, against the background and surface tokens in both themes, with the ratios recorded beside the tokens. | no | WCAG 2.2 AA 1.4.3, 1.4.11 |
| SPEC-025-R04 | The UI shall draw icons from one SVG icon set and shall never use emoji as icons. An icon beside visible text shall be hidden from assistive technology, and an icon-only button shall have an accessible name and a tooltip showing it. | no | accessibility |
| SPEC-025-R05 | The UI shall load its fonts from the embedded assets with no request to another origin, using Outfit for headings and the wordmark, Fira Sans for text, and Fira Code with tabular numerals for identifiers, digests and measured values. | no | air gap (D8), CSP (SPEC-005-R04) |
| SPEC-025-R31 | The UI shall show the LabRat mark (`docs/logo.jpg`, redrawn as SVG) in the top bar, on the sign-in page and as the favicon, and shall take its brand colours from the mark's palette (design §3.0). | no | brand (OQ 5) |
| SPEC-025-R06 | Wherever a run's state is shown, the UI shall show it with one status badge that combines the state's colour, its icon and the state word. | no | WCAG 1.4.1 (not colour alone) |
| SPEC-025-R07 | While the user's system requests reduced motion, the UI shall show state changes without animation; otherwise transitions shall last 150–250 ms and animate only opacity and transform. | no | WCAG 2.3.3 |

### Shell and navigation

| ID | Requirement | Test | Source |
|---|---|---|---|
| SPEC-025-R08 | The workspace shall show a top bar holding the product name, a search field that opens the command palette, a **New** menu (experiment, run, sample or material, instrument), a **To do** button showing the number of items awaiting the user, and a user menu (account, theme, sign out). | no | user need |
| SPEC-025-R09 | The sidebar shall group navigation into labelled sections with an icon each: Home, Experiments (with their runs), Instruments, Schemas, To do, Audit trail, and Admin, which is shown only to users holding `admin`. | no | user need |
| SPEC-025-R10 | The bottom panel (Problems, History) shall start collapsed, show the problem count on its toggle, open by itself when a view reports a blocking problem, and remember whether the user left it open. | no | screen space |
| SPEC-025-R11 | While the window is narrower than 1024 px, the sidebar shall become a drawer opened from the top bar, and every view shall stay usable without horizontal page scrolling at widths down to 768 px. | no | bench tablets |
| SPEC-025-R12 | The To-do view shall combine the review inbox (SPEC-007) and the sign-off inbox (SPEC-008) as two tabs, each tab showing its count, and the command palette entries and old `#/inbox` and `#/signoff` links shall open the matching tab. | no | one place for "what needs me" |

### Home and guidance

| ID | Requirement | Test | Source |
|---|---|---|---|
| SPEC-025-R13 | When a signed-in user opens the workspace without a link to a specific item, the workspace shall open Home, showing: sign-offs awaiting the user, change sets awaiting the user's review, runs in progress (`running` or `paused`) across experiments, and the most recently created experiments, each item opening its view. | no | user need |
| SPEC-025-R14 | While the tenant has no experiments, Home shall show a Get-started guide listing the steps of a first experiment (create the experiment and its protocol, plan a run with its inputs, start it, send data, complete it, sign it), with each step linked to the screen that does it. | no | onboarding |
| SPEC-025-R15 | When a list, table or panel has no items, the UI shall say what belongs there and, if the user's roles allow it, offer the action that adds the first one. | no | onboarding |
| SPEC-025-R16 | The API shall offer cursor-paginated `GET /v1/runs?state=<state>[,<state>…]` across the tenant's experiments, newest first, returning each run's id, label, state, created time, experiment id and experiment slug. | no | R13 |
| SPEC-025-R17 | UI labels shall use the plain-language glossary in design §3, e.g. "used as input" for the `used` relation and "produced" for `wasGeneratedBy`. The technical term shall appear only in Record details and tooltips. | no | user need |
| SPEC-025-R18 | Each view shall show record identifiers, SHA-256 digests, manifest digests and audit sequence numbers in a collapsed **Record details** section, in Fira Code, each with a copy button, and not in the main content. | no | user need |
| SPEC-025-R19 | When an API call fails, the UI shall show, next to the control that made it, a message naming the action, what went wrong in plain words, and what the user can do, chosen from the HTTP status as in design §3; the server's own message shall follow as detail. | no | user need |
| SPEC-025-R20 | When a create, edit, transition, decision or signature succeeds, the UI shall confirm it in a status toast announced to assistive technology, which disappears after 5 s. | no | feedback |

### The scientist's workflow

| ID | Requirement | Test | Source |
|---|---|---|---|
| SPEC-025-R21 | The **New experiment** dialog shall ask for a title, derive an editable slug from it, and offer the protocol as Markdown pre-filled with a template (Aim, Materials, Method, Expected results). Creating the experiment shall call `POST /v1/experiments` and open the new experiment. | no | user need |
| SPEC-025-R22 | The experiment view shall have three tabs. **Overview** shows the current protocol rendered, the runs with status badges and a **Plan run** action. **Protocol** offers a Markdown editor with live preview that saves a new version through `POST /v1/experiments/{id}/protocol-versions`, plus the version list and diff. **Settings** holds the signing policy. | no | user need |
| SPEC-025-R23 | The run view shall show, under the run's label and status badge, a lifecycle stepper (Planned → Running → Completed or Failed → Signed, with Aborted as an end state) that marks the current step and offers the one next action the run's state and the user's roles allow as the primary button. | no | user need |
| SPEC-025-R24 | The run view shall offer exactly the transitions the run's state allows (Start, Pause, Resume, Complete, Mark failed, Abort), each asking for a reason. Abort and Mark failed shall also ask for confirmation in a dialog saying the step can't be undone. | no | user need, confirmation for irreversible steps |
| SPEC-025-R25 | While a run is `planned`, `running` or `paused`, the run view shall let the user add an input either by creating a new sample or material with its schema form (`POST /v1/lineage/nodes`) or by entering an existing node's ID, then linking it with a `used` edge (`POST /v1/lineage/edges`). | no | user need |
| SPEC-025-R26 | The run view shall list the run's datasets with their reading counts and, while the run is `running`, show a **Send data** panel where the user picks an instrument and copies a ready-made example request that streams readings into this run. | no | user need |
| SPEC-025-R27 | The **Register instrument** dialog shall ask for a name and kind, and create the instrument through `POST /v1/instruments`. | no | user need |

### Restyle and accessibility

| ID | Requirement | Test | Source |
|---|---|---|---|
| SPEC-025-R28 | Every existing view (lineage, audit, review and sign-off, notes, signatures and sign dialog, schemas and schema forms, account, principals, delegations) shall use the design-system components and tokens, with no view keeping styles from before this spec. | no | consistency |
| SPEC-025-R29 | The lineage explorer shall show a legend and draw each node kind with its own shape as well as its own colour, label edges with the glossary terms, and offer zoom-in, zoom-out and fit controls. | no | WCAG 1.4.1, user need |
| SPEC-025-R30 | Every view shall be usable with the keyboard alone, keep the focused control visible and not covered by the top bar, toasts or bottom panel, and give every pointer target at least 24 × 24 px. This raises SPEC-005-R11 from WCAG 2.1 AA to 2.2 AA. | no | WCAG 2.2 AA 2.4.11, 2.5.8 |

No `Test: yes` requirements. This spec changes presentation only. The rules the screens display are tested where they're enforced, and the user acceptance plan covers the workflow (open question 4).

## 4. Acceptance examples

None (no `Test: yes` requirements). The UAT plan must walk a new scientist from an empty tenant to a signed run using only the UI and the Get-started guide.

## 5. Non-functional

- The gzipped UI bundle shall stay under 1 MB (unchanged from SPEC-005), including fonts and icons.
- Home shall render its first content within 1 s of sign-in on a local server.
- The lineage explorer keeps SPEC-005's 500-node, 2 s budget with the new node shapes.

## 6. Open questions

| # | Question | Owner | Answer (date) |
|---|---|---|---|
| 1 | Accessible primitives for menus, dialogs, popovers, tooltips and the combobox: **React Aria Components** (recommended: Apache-2.0, stock, strong keyboard and screen-reader support, tree-shaken) or native HTML only (`<dialog>`, `popover`), with hand-written keyboard handling for menus? | Rob Bassett | React Aria Components (2026-11-06) |
| 2 | Should the Get-started guide offer **Create an example experiment**? It would write a synthetic, clearly labelled experiment through the public API, so it would be audited like any other record. Recommended: only while `env` is `dev`. | Rob Bassett | Left out for now (2026-11-06); moved to Out of scope |
| 3 | Confirm merging the review and sign-off inboxes into one To-do view (R12). | Rob Bassett | Yes (2026-11-06) |
| 4 | Should the "empty tenant to signed run" golden path become a Playwright test? The testing policy says only business-critical rules get tests. Recommended: no; UAT covers it. | Rob Bassett | No (2026-11-06) |
| 5 | Confirm the visual direction in design §3: Swiss-minimal, navy primary with an amber accent, Fira Sans and Fira Code, light by default. | Rob Bassett | Use `docs/logo.jpg` as the style seed (2026-11-06): the palette, shape language and heading font now come from the mark (design §3.0, R31) |
