# SPEC-024: Standards-aligned starter schemas

| | |
|---|---|
| **Status** | Draft |
| **Owner** | Rob Bassett |
| **Created / Updated** | 2026-11-06 / 2026-11-06 |
| **Regulatory refs** | none |
| **Depends on** | `SPEC-009` |

Design: [design.md](design.md) · Tasks: [tasks.md](tasks.md)

This is a brief, not yet agreed requirements. The `spec-writer` finishes it with Rob.

## 1. Problem

A new LabRat tenant has an empty schema registry (SPEC-009), so every lab starts by inventing its own definitions of a sample, a material lot and a piece of equipment. Labs that follow open standards, or must exchange data with MES, ERP and instrument systems, need those definitions to match the standards' terms. Without them, LabRat data can't be mapped onto ISA-95, ISA-88 or Allotrope without hand translation.

## 2. Scope (proposed)

**In scope**
- A small set of published schemas in the system namespace `lde`, seeded into every tenant when it is created. Tenants are created in `storage.EnsureTenant` (dev) and `labrat bootstrap-admin`.
  - `lde/material-lot` (`reagent`): property names after the ISA-95 material lot (MESA B2MML V0700, royalty-free with attribution).
  - `lde/equipment` (`instrument`): after ISA-95 equipment, with an ISA-88 physical model level: enterprise, site, area, process cell, unit, equipment module or control module.
  - `lde/sample` (`sample`): fields tagged with Allotrope Foundation Ontology (AFO, CC BY 4.0) term IRIs, in an `x-lde-term` keyword.
- Attribution for MESA and the Allotrope Foundation in a `NOTICE` file and in the schemas' descriptions.
- Seeding is audited, like any other publish.

**Out of scope**
- Allotrope Simple Model (ASM) schemas. They are licensed CC BY-NC 4.0, non-commercial only, so LabRat can't ship them. Importing ASM schemas a customer holds a licence for is a later spec, likely alongside the parsers (SPEC-013), since ASM describes instrument results.
- The ISA-88 procedural model (procedure, unit procedure, operation, phase), which concerns protocols rather than schemas.
- Exchanging B2MML messages with an MES or ERP.

## 3. Requirements (EARS)

To be written with Rob. Candidate business-critical rule: seeded schemas are published and immutable like any other, which SPEC-009-R01 already covers.

## 4. Open questions

| # | Question | Owner | Answer (date) |
|---|---|---|---|
| 1 | B2MML V0700 (with its JSON schema) is a free download from MESA's resource centre, but needs an account. Can Rob register and provide the files, so field names follow the published schema rather than secondary sources? | Rob Bassett | |
| 2 | Which AFO terms should `lde/sample` use? The current AFO release (REC/2026/03) needs checking, along with the attribution file for terms under other licences (some are CC BY-SA). | Rob Bassett | |
| 3 | Does SPEC-015 build on these schemas in place of its own `lde/reagent-lot` and `lde/instrument-status`? | Rob Bassett | |
| 4 | `lde` is a controlled namespace in SPEC-010. Until SPEC-010 lands, who may publish a new `lde` version? Recommendation: nobody through the API; only the seed. | Rob Bassett | |
