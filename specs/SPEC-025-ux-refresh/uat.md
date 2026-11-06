# SPEC-025 user acceptance test plan: UI/UX refresh

| | |
|---|---|
| **Build** | branch `worktree-spec-025-ux-refresh` (the commit that adds this file) |
| **Written** | 2026-11-06 |
| **Testers** | a scientist new to LabRat (cases 1-9), a reviewer (cases 10-11), anyone with a screen reader or keyboard only (case 13), an admin (case 12) |

You will check that someone who has never used LabRat can go from an empty tenant to a signed run using only the UI, that every screen follows the LabRat look in light and dark, and that errors say what to do. Use synthetic data only.

Known limitations, not UAT failures:

- The dataset table shows each dataset's label and reading count only. The run detail API doesn't return the instrument or arrival time (design §5).
- An instrument's readings are sent with `curl` from the Send-data panel; there is no in-browser upload.
- The sidebar's "+" buttons are pointer shortcuts. Keyboard users reach the same dialogs from **New** in the top bar.
- No automated browser test covers this workflow (open question 4); this plan is the check.

## 1. Setup

The database is rebuilt for this UAT. Run from a clean checkout of the build above. Node 22 is needed for the UI, and `curl` for case 7 (Git Bash or WSL on Windows).

```bash
docker compose down -v && docker compose up -d     # fresh PostgreSQL 16
make ui                                            # builds the web UI into web/dist
LDE_ENV=dev go run ./cmd/server                    # migrates, seeds the dev tenant, listens on :8080
```

Open http://localhost:8080/ in a desktop browser at full width. In the dev server a handle it has not seen gets every role. Sign in with tenant `00000000-0000-4000-8000-000000000001` and handle `sam` (the scientist). For the reviewer use a private window with handle `rita`.

## 2. Test cases

### UAT-01: The sign-in page and shell carry the LabRat look

- **Requirements:** SPEC-025-R01, R02, R05, R08, R09, R31
- **As:** sam
- **Steps:**
  1. Before signing in, look at the sign-in page and the browser tab.
  2. Sign in. Look at the top bar and sidebar.
  3. Open the user menu (initials, top right) and choose **Dark theme**, then reload. Then choose **Light theme**, then **System theme**.
  4. Open the browser's network tools and reload.
- **Expected:**
  - The sign-in card shows the LabRat mark (the geometric rat) above "Sign in to LabRat"; the tab shows the mark as its icon.
  - The top bar shows the mark and the wordmark "LabRat", a search field with "Ctrl K", a teal **New** button, **To do** with a count, and the user menu. The sidebar has Home, Experiments, Instruments, Schemas, To do, Audit trail and (for an admin) Admin, each with an icon.
  - Dark and light switch every surface, and the choice survives the reload. System follows the operating system's setting.
  - Every font and icon loads from `localhost:8080`; nothing is fetched from another site. The browser console shows no Content-Security-Policy errors.
- **Result:** Pass / Fail · Notes:

### UAT-02: An empty tenant shows how to get started

- **Requirements:** SPEC-025-R13, R14, R15
- **As:** sam
- **Steps:**
  1. After signing in, you land on **Home**.
- **Expected:**
  - Home greets you by name and, because there are no experiments, shows **Get started**: six numbered steps (Create an experiment, Write the protocol, Plan a run, Add inputs and start, Send data, Complete and sign), each with one sentence.
  - Step 1 has a **New experiment** button. Step 3's **Plan a run** button is disabled and its text says it needs an experiment.
  - The sidebar's Experiments section says "No experiments yet"; Instruments says "No instruments registered".
- **Result:** Pass / Fail · Notes:

### UAT-03: Create an experiment with its protocol

- **Requirements:** SPEC-025-R20, R21
- **As:** sam
- **Steps:**
  1. On Home click **New experiment**.
  2. Type the title `HPLC purity of batch lots`. Watch the Short name field.
  3. Leave the protocol template, add a line under Method, and click **Create experiment**.
  4. Open **New → New experiment** again, use a different title but set Short name to `hplc-purity-of-batch-lots`, and create.
- **Expected:**
  - The short name fills in as `hplc-purity-of-batch-lots` while you type the title. The protocol box starts with the headings Aim, Materials, Method, Expected results.
  - After step 3 a toast says the experiment was created, its tab opens on **Overview**, and it appears in the sidebar.
  - Step 4 shows "That short name is taken. Try another." under the Short name field, and the dialog stays open.
- **Result:** Pass / Fail · Notes:

### UAT-04: Revise the protocol and compare versions

- **Requirements:** SPEC-025-R22
- **As:** sam
- **Steps:**
  1. In the experiment, open the **Protocol** tab.
  2. Edit the Markdown (for example, add a step). Watch the preview.
  3. Click **Save as version 2**.
  4. In **Compare versions** pick v1 to v2 and click **Compare**.
  5. Open the **Settings** tab.
- **Expected:**
  - The preview updates as you type. The note says runs already planned keep the version they pinned.
  - After saving, a toast says "Protocol saved as version 2", the Versions table lists v2 as **Current**, and the header says protocol v2.
  - The diff shows your added line marked as added.
  - Settings shows the signing policy (author then review by default).
- **Result:** Pass / Fail · Notes:

### UAT-05: Plan a run

- **Requirements:** SPEC-025-R06, R22, R23
- **As:** sam
- **Steps:**
  1. On the experiment's **Overview**, read the Runs card, then click **Plan run**.
  2. Label it `Batch 7 HPLC`, leave Inputs empty and parameters `{}`, and click **Plan run**.
- **Expected:**
  - Before planning, the Runs card explains what a run is and offers **Plan run**.
  - The run opens. It shows the experiment and protocol version, a stepper Planned → Running → Completed → Signed with Planned current, a **Planned** badge (icon and word), a primary **Start run** button and **More**.
  - The run appears in the sidebar under the experiment with a status dot; hovering or a screen reader gives the state word.
- **Result:** Pass / Fail · Notes:

### UAT-06: Add inputs, then start the run

- **Requirements:** SPEC-025-R17, R24, R25
- **As:** sam
- **Steps:**
  1. In **Inputs** click **Add input**. On **New item** choose kind Reagent, name `Lot R-2291`, and click **Create and add**.
  2. Click **Add input** again, choose **Existing item**, type `not-an-id` and submit.
  3. **New → New sample or material**: kind Sample, name `Plasma S-104`, **Create**. Its lineage opens; expand **Record details** under the selected item and copy the Item ID. Go back to the run tab, **Add input → Existing item**, paste it and submit.
  4. Click **Start run**. In the dialog, clear the reason and try to submit; then enter `Started at the bench` and click **Start run**.
- **Expected:**
  - Step 1: a toast, and `Lot R-2291` appears with a Reagent badge and "used as input".
  - Step 2: the field says what an item ID looks like; nothing is sent.
  - Step 3: a toast, and `Plasma S-104` appears with a Sample badge and "used as input".
  - Step 4: the dialog will not submit without a reason. After starting, the stepper shows Running, the badge says **Running**, the primary action is **Complete run**, and More lists Pause, Mark failed and Abort.
- **Result:** Pass / Fail · Notes:

### UAT-07: Register an instrument and send data

- **Requirements:** SPEC-025-R18, R26, R27
- **As:** sam
- **Steps:**
  1. **New → Register instrument**: name `HPLC-1`, kind `hplc`. Register.
  2. Back on the running run, in **Data** click **Send data**. Pick `HPLC-1`. Click **Copy command**.
  3. In a terminal, paste the command, replacing `Authorization: Bearer <your token>` with `-H 'X-LDE-Tenant: 00000000-0000-4000-8000-000000000001' -H 'X-LDE-Actor: sam'`, `readings.ndjson` with `examples/streams/hplc-uv.ndjson`, and `<label>` with `UV run 1`. Run it.
  4. Reload the run tab.
- **Expected:**
  - The instrument's tab opens and it appears in the sidebar and in the Send-data picker.
  - The panel says instrument PCs usually send this automatically, and the command contains this server's address, the instrument's ID and the run's ID.
  - After reload the Data card lists `UV run 1` with its reading count. **Record details** at the bottom of the run lists the dataset's SHA-256, the run and item IDs and the protocol fingerprint, each with a copy button.
- **Result:** Pass / Fail · Notes:

### UAT-08: Pause, resume, complete

- **Requirements:** SPEC-025-R20, R23, R24
- **As:** sam
- **Steps:**
  1. **More → Pause**, reason `Column change`. Then **Resume**, reason `Column fitted`.
  2. Open **More** and choose **Abort**, read the dialog, and cancel.
  3. **Complete run**, reason `Work finished`.
- **Expected:**
  - Each move shows a toast and the stepper and badge follow (Paused shows the Running step labelled Paused, in amber).
  - The Abort dialog says "This can't be undone. The run will stay in the record as aborted." and its button is red.
  - After completing, the stepper shows Completed; in place of actions it says "Sign as author" (sam holds the scientist role) or "Waiting for signatures (0 of 2)".
- **Result:** Pass / Fail · Notes:

### UAT-09: Lineage reads in plain words

- **Requirements:** SPEC-025-R17, R29
- **As:** sam
- **Steps:**
  1. On the run click **Open lineage**. Choose **Both**.
  2. Use the zoom in, zoom out and fit buttons. Hover each.
  3. Switch the theme to dark from the user menu.
- **Expected:**
  - The run is a hexagon, the reagent a diamond, the protocol a dashed square, the dataset a barrel. The Legend card lists the kinds present with the same shapes and colours. Edges read "used as input" and "produced by", not PROV terms.
  - Each zoom button has a tooltip and a name. The graph restyles in the dark theme without reloading.
- **Result:** Pass / Fail · Notes:

### UAT-10: To do brings sign-offs and reviews together

- **Requirements:** SPEC-025-R12, R13
- **As:** sam, then rita
- **Steps:**
  1. As sam, sign the run as author from the run's lifecycle bar (**Sign as author**), completing the sign dialog.
  2. In a private window sign in as `rita`. Look at the top bar and Home.
  3. Click **To do**. Then visit `http://localhost:8080/#/signoff` and `#/inbox`.
- **Expected:**
  - Rita's To-do count is at least 1 (terracotta). Home's **Needs you** lists "Sign Batch 7 HPLC (review)" with a "To sign" badge, and **Runs in progress** doesn't list it (it is completed).
  - To do has two tabs, **Review changes** and **Sign-offs**, each with its count. The old `#/signoff` link opens Sign-offs; `#/inbox` opens Review changes.
- **Result:** Pass / Fail · Notes:

### UAT-11: The reviewer signs; a correction becomes a change request

- **Requirements:** SPEC-025-R06, R17, R20, R28
- **As:** rita, then sam
- **Steps:**
  1. As rita, open the run from Sign-offs and sign as review.
  2. As sam, on the signed run edit **Parameters** to `{"column":"C18"}` with a reason, and save.
  3. As rita, open **To do → Review changes**.
- **Expected:**
  - After rita signs, the stepper shows Signed and the badge **Signed** (purple, with an icon).
  - Sam's edit is proposed as a correction and the message points to To do. Rita sees it under "From people" as a change request, with Commit (teal) and Reject (red). No screen says "change set".
- **Result:** Pass / Fail · Notes:

### UAT-12: Errors say what to do

- **Requirements:** SPEC-025-R19
- **As:** sam, and an account without the scientist role
- **Steps:**
  1. Stop the server. In LabRat, open the Audit trail and click **Verify chain**. Start the server again.
  2. Open `http://localhost:8080/#/run/00000000-0000-4000-8000-00000000dead`.
  3. As an admin, in **Admin → Users and service accounts** create a user `vic` with no roles. Sign in as `vic` and try to plan a run from a URL-opened experiment, or note that New is disabled.
- **Expected:**
  - Step 1: "Couldn't verify the audit trail. LabRat can't be reached. Check your connection and try again. Nothing was saved."
  - Step 2: "Couldn't load the run. That item doesn't exist, or you can't see it. Check the ID, or ask whoever shared it."
  - Step 3: New's items are disabled for vic; Home's Get started says the scientist role is needed. Where a call is refused, the message says "You don't have the role this needs" and names the role.
- **Result:** Pass / Fail · Notes:

### UAT-13: Keyboard, screen reader, narrow screen

- **Requirements:** SPEC-025-R03, R04, R07, R10, R11, R30
- **As:** anyone
- **Steps:**
  1. With the keyboard only: Ctrl+K, type the experiment name, Enter. Tab to **Plan run**, open it, Escape. Use the arrow keys in the sidebar tree.
  2. Turn on the OS "reduce motion" setting and open a dialog.
  3. Narrow the window to about 768 px wide.
  4. Collapse and expand the bottom panel; reload.
- **Expected:**
  - Focus is always visible (a teal outline); dialogs keep focus inside and return it to the button that opened them; Escape closes them. Icon-only buttons are announced by name.
  - With reduced motion, dialogs and toasts appear without animation.
  - At 768 px the sidebar is hidden behind a navigation button in the top bar that opens it as a drawer; no page scrolls sideways; wide tables scroll inside their card.
  - The panel's open state is remembered across reloads. Starting a run with bad parameters opens it on Problems.
- **Result:** Pass / Fail · Notes:

## 3. Traceability

| Requirement | Cases | Automated test |
|---|---|---|
| SPEC-025-R01 | UAT-01 | - |
| SPEC-025-R02 | UAT-01 | - |
| SPEC-025-R03 | UAT-13 | - |
| SPEC-025-R04 | UAT-13 | - |
| SPEC-025-R05 | UAT-01 | - |
| SPEC-025-R06 | UAT-05, UAT-11 | - |
| SPEC-025-R07 | UAT-13 | - |
| SPEC-025-R08 | UAT-01 | - |
| SPEC-025-R09 | UAT-01 | - |
| SPEC-025-R10 | UAT-13 | - |
| SPEC-025-R11 | UAT-13 | - |
| SPEC-025-R12 | UAT-10 | - |
| SPEC-025-R13 | UAT-02, UAT-10 | - |
| SPEC-025-R14 | UAT-02 | - |
| SPEC-025-R15 | UAT-02 | - |
| SPEC-025-R16 | UAT-10 (Runs in progress) | - |
| SPEC-025-R17 | UAT-06, UAT-09, UAT-11 | - |
| SPEC-025-R18 | UAT-07 | - |
| SPEC-025-R19 | UAT-12 | - |
| SPEC-025-R20 | UAT-03, UAT-08, UAT-11 | - |
| SPEC-025-R21 | UAT-03 | - |
| SPEC-025-R22 | UAT-04, UAT-05 | - |
| SPEC-025-R23 | UAT-05, UAT-08 | - |
| SPEC-025-R24 | UAT-06, UAT-08 | - |
| SPEC-025-R25 | UAT-06 | - |
| SPEC-025-R26 | UAT-07 | - |
| SPEC-025-R27 | UAT-07 | - |
| SPEC-025-R28 | UAT-11 | SPEC-008 e2e (restyled views) |
| SPEC-025-R29 | UAT-09 | - |
| SPEC-025-R30 | UAT-13 | - |
| SPEC-025-R31 | UAT-01 | - |

## 4. Sign-off

| Tester | Role | Date | Outcome | Notes |
|---|---|---|---|---|
| | | | Accepted · Accepted with issues · Rejected | |
