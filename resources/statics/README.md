# Patched client statics (runner overlay)

The in-VS-Code form runner (`src/services/formRunnerProxy.ts`) serves these
files from the loopback proxy INSTEAD of the live server's copies. Everything
else is deliberately NOT here: the proxy falls back to the upstream server
for every other `/htmlruntime/**` path, and those copies are byte-identical
to what this tree mirrors (verified by MD5 against bmbh02, 26.10).

Only files carrying client-side deviations belong in this overlay:

| file | markers | why |
|---|---|---|
| `htmlruntime/desktop/starlims-all.js` | `XFD-SANDBOX-PATCH` (AI/bridge/`XfdTop` + PubSub bus), `XFD-ISO-DATE-PATCH` (×2 `_parseValidDate`) | webview cross-frame reads; ISO `<MinDate>` crash |
| `htmlruntime/desktop/common/common-controls.js` | `XFD-SANDBOX-PATCH` | same PubSub bus (dynamic-load follow-on) |

Baseline provenance: copies of the deployed 12.6.2 client under
`D:\temp\xfdrs\statics` (`*.xfd-orig.js` = unpatched original, MD5-matches
the server).

## Updating against a new server build

1. Fetch the fresh file from the server (`/<app>/htmlruntime/desktop/...`).
2. Diff it against `*.xfd-orig.js`; re-apply every marker block onto the new
   file (grep the markers in the old patched file).
3. `node --check` the result, replace it here, refresh `*.xfd-orig.js` in
   the mirror, and verify: Open Form → login → form renders, plus the
   `[FormRunner]` boot line in the STARLIMS output channel.

Resolution order (runner): `STARLIMS.designer.statics` (full-tree override
for dev machines) → this overlay (packaged default). The DESIGNER still
needs a FULL local statics tree via the setting — `xfd-cli serve` has no
server fallback.
