# End-to-end tests

Run with the server up (`make up`, then `make ui` and `go run ./cmd/server`), after `npx playwright install chromium` (once).

- Run: `make e2e` (set `LABRAT_URL` to target another server; default `http://localhost:8080`).
- Every test cites its requirement on the line above `test(`: `// SPEC-NNN-Rxx`.
- Results are written to `web/test-results/results.json`, and `make validate` reads them. A citation must be a `// SPEC-NNN-Rxx` comment on the line directly above `test(`, with the title as a string literal on that line.
- `make validate` counts the results only if the run started at or after the HEAD commit's time. Run `make e2e` after the last commit, or the requirements these tests cite show `NOT VERIFIED`.
