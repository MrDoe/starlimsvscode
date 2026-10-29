/**
 * Runtime-generated patched client overlay for the in-VS-Code form runner.
 *
 * LICENSE RULE (user, 26.10): the extension must NEVER bundle proprietary
 * STARLIMS client files (starlims-all.js & friends). Only THIS file - our
 * own patch definitions - ships. At "Open Form" the stock client files are
 * fetched from the USER'S OWN connected server (the same server the runner
 * proxies anyway), the deviations below are applied locally, and the result
 * is cached under the extension's globalStorage. The user therefore only
 * ever executes client code they are licensed to run.
 *
 * The `find` strings are the shortest unique anchors that locate each
 * patch site in the stock file; `occurrences` is the exact number of times
 * the anchor must appear (drift guard: a new server build that moves or
 * changes a patch site aborts the file instead of corrupting it, and the
 * upstream copy is used unchanged instead).
 *
 * See .opencode/wiki/concepts/openform-in-vscode.md (runner) and the
 * XFD-SANDBOX-PATCH / XFD-ISO-DATE-PATCH bullets in AGENTS.md for WHY each
 * patch exists.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";

export type OverlayPatch = {
    /** Exact text to locate in the stock (LF-normalized) file. */
    find: string;
    /** Replacement text. */
    replace: string;
    /** Exact number of occurrences the anchor must have AT APPLY TIME. */
    occurrences: number;
    /** Which occurrence to replace (default 0) - for shared anchors. */
    applyTo?: number;
};

export type OverlayTarget = {
    /** Path below the server app root AND below the overlay root. */
    relPath: string;
    patches: OverlayPatch[];
};

/** The ONLY client files that deviate from the server (MD5-verified 26.10). */
export const OVERLAY_TARGETS: OverlayTarget[] = [
    {
        relPath: "htmlruntime/desktop/starlims-all.js",
        patches: [
            {
                // XFD-SANDBOX-PATCH: resolve AI/bridge on window.top only when
                // it is same-origin; a webview iframe must fall back to itself.
                find: "const AI = window.top.AI || {};",
                replace: "/*XFD-SANDBOX-PATCH*/var XfdTop = window; try { if (window.top !== window) { void window.top.AI; } XfdTop = window.top; } catch (xfdE) {} const AI = XfdTop.AI || {};",
                occurrences: 1,
            },
            {
                find: "const bridge = window.top.bridge || {};",
                replace: "const bridge = XfdTop.bridge || {};",
                occurrences: 1,
            },
            {
                // XFD-ISO-DATE-PATCH 1/2 (DateTimePicker): keep the raw value
                // so the ISO fallback below can re-parse it.
                find: 'Utils.checkArguments([value], ["String"]);\n      value = Utils._parseDate(null, value);',
                replace: 'Utils.checkArguments([value], ["String"]);\n      var xfdRawDate = String(value); /*XFD-ISO-DATE-PATCH*/\n      value = Utils._parseDate(null, value);',
                occurrences: 2,
                applyTo: 0, // first occurrence = StarlimsDateTimePicker
            },
            {
                // XFD-ISO-DATE-PATCH 2/2 (MonthCalendar): same, second anchor
                // occurrence after the picker was rewritten above.
                find: 'Utils.checkArguments([value], ["String"]);\n      value = Utils._parseDate(null, value);',
                replace: 'Utils.checkArguments([value], ["String"]);\n      var xfdRawDate2 = String(value); /*XFD-ISO-DATE-PATCH*/\n      value = Utils._parseDate(null, value);',
                occurrences: 1, // picker copy no longer matches the 2-line anchor
                applyTo: 0,
            },
            {
                // .NET-serialized "1753-01-01T00:00:00" is ISO, not
                // dd.MM.yyyy - without this fallback the setter THROWS and
                // the whole designer/form load aborts.
                find: '        if (newDate === null)\n          throw "Fehler: Falsches Datumsformat!";',
                replace:
                    "        if (newDate === null) {\n" +
                    '          /*XFD-ISO-DATE-PATCH*/var xfdIso = /^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2}))?$/.exec(xfdRawDate);\n' +
                    "          if (xfdIso)\n" +
                    "            newDate = new Date(+xfdIso[1], +xfdIso[2] - 1, +xfdIso[3], +xfdIso[4], +xfdIso[5], +(xfdIso[6] || 0));\n" +
                    "        }\n" +
                    '        if (newDate === null)\n          throw "Fehler: Falsches Datumsformat!";',
                occurrences: 1,
            },
            {
                find: '        if (value === null)\n          throw "Falsches Datumsformat! Erwartetes Format: dd.MM.yyyy";',
                replace:
                    "        if (value === null) {\n" +
                    '          /*XFD-ISO-DATE-PATCH*/var xfdIso2 = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(xfdRawDate2);\n' +
                    "          if (xfdIso2)\n" +
                    "            value = new Date(+xfdIso2[1], +xfdIso2[2] - 1, +xfdIso2[3]);\n" +
                    "        }\n" +
                    '        if (value === null)\n          throw "Falsches Datumsformat! Erwartetes Format: dd.MM.yyyy";',
                occurrences: 1,
            },
            {
                // XFD-SANDBOX-PATCH: the PubSub bus - see common-controls entry.
                find: "window.top.PubSub = (function () {",
                replace: "/*XFD-SANDBOX-PATCH*/var XfdPubSubBus = (function () {",
                occurrences: 1,
            },
            {
                find: "  };\n})();\nExt.override(Ext.view.Table, {",
                replace:
                    "  };\n/*XFD-SANDBOX-PATCH*/})(); try { if (window.top !== window) { void window.top.PubSub; } window.top.PubSub = XfdPubSubBus; } " +
                    'catch (xfdE) { if (!(window.PubSub && typeof window.PubSub.subscribe === "function")) { window.PubSub = XfdPubSubBus; } }\n' +
                    "Ext.override(Ext.view.Table, {",
                occurrences: 1,
            },
        ],
    },
    {
        relPath: "htmlruntime/desktop/common/common-controls.js",
        patches: [
            {
                find: "window.top.PubSub = (function () {",
                replace: "/*XFD-SANDBOX-PATCH*/var XfdCommonControlsPubSub = (function () {",
                occurrences: 1,
            },
            {
                // Cross-origin window.top makes the raw assign throw (and this
                // file has NO try/catch upstream) - install the WORKING bus on
                // the local document instead of the old empty-object fallback.
                find: "\t};\n})();",
                replace:
                    "\t};\n/*XFD-SANDBOX-PATCH*/})(); try { if (window.top !== window) { void window.top.PubSub; } window.top.PubSub = XfdCommonControlsPubSub; } " +
                    'catch (xfdE) { if (!(window.PubSub && typeof window.PubSub.subscribe === "function")) { window.PubSub = XfdCommonControlsPubSub; } }',
                occurrences: 1,
            },
        ],
    },
];

const MARKER_NAME = "_overlay.json";

type OverlayMarker = {
    baseUrl: string;
    generatedAt: string;
    files: Record<string, { srcSha256: string; outSha256: string }>;
};

/** CRLF -> LF so anchors are EOL-agnostic; overlay files are written as LF. */
export function normalizeEol(text: string): string {
    return text.replace(/\r\n/g, "\n");
}

/**
 * Apply the target's patches to the stock source. Returns null when any
 * anchor's occurrence guard fails (server-build drift) - never partial
 * output, the caller keeps the upstream copy in that case.
 */
export function applyOverlayPatches(source: string, target: OverlayTarget): string | null {
    let text = normalizeEol(source);
    for (const patch of target.patches) {
        const parts = text.split(patch.find);
        const found = parts.length - 1;
        if (found !== patch.occurrences) {
            return null;
        }
        const which = patch.applyTo ?? 0;
        if (which < 0 || which >= found) {
            return null;
        }
        // Replace only the `which`-th occurrence.
        const before = parts.slice(0, which + 1).join(patch.find);
        const after = parts.slice(which + 1).join(patch.find);
        text = before + patch.replace + after;
    }
    return text;
}

function sha256(text: string): string {
    return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function readMarker(overlayRoot: string): OverlayMarker | undefined {
    try {
        return JSON.parse(fs.readFileSync(path.join(overlayRoot, MARKER_NAME), "utf8")) as OverlayMarker;
    } catch {
        return undefined;
    }
}

/** True when the marker matches the server AND every overlay file is on disk. */
function markerUsable(marker: OverlayMarker | undefined, overlayRoot: string, baseUrl: string): boolean {
    if (!marker || marker.baseUrl !== baseUrl.trim().replace(/\/+$/, "")) {
        return false;
    }
    return OVERLAY_TARGETS.every((t) => fs.existsSync(path.join(overlayRoot, ...t.relPath.split("/"))));
}

/**
 * Synchronous provider view: returns overlayRoot when a usable overlay
 * exists for ANY server (the per-request provider does not know the final
 * baseUrl comparison cheaply - regeneration happens via ensureOverlay),
 * otherwise "".
 */
export function overlayDirState(overlayRoot: string): string {
    try {
        const marker = JSON.parse(fs.readFileSync(path.join(overlayRoot, MARKER_NAME), "utf8")) as OverlayMarker;
        const ok = OVERLAY_TARGETS.every((t) => fs.existsSync(path.join(overlayRoot, ...t.relPath.split("/"))));
        return ok && Object.keys(marker.files ?? {}).length > 0 ? overlayRoot : "";
    } catch {
        return "";
    }
}

function fetchText(url: string, timeoutMs = 30_000): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith("https:") ? https : http;
        const req = client.get(url, { timeout: timeoutMs }, (res) => {
            const status = res.statusCode ?? 0;
            const location = res.headers.location;
            if (status >= 300 && status < 400 && location && !location.includes("\n")) {
                res.resume();
                const next = location.startsWith("http") ? location : new URL(location, url).toString();
                fetchText(next, timeoutMs).then(resolve, reject);
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (c: Buffer) => {
                size += c.length;
                if (size > 32 * 1024 * 1024) {
                    res.destroy();
                    reject(new Error("response exceeds 32 MB"));
                    return;
                }
                chunks.push(c);
            });
            res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", reject);
        });
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", reject);
    });
}

/**
 * Generate the overlay for `baseUrl` unless a fresh one already exists.
 * Fetches each stock file from the (user's) server, applies OUR patches,
 * caches under overlayRoot. Never throws; failures are logged and simply
 * leave the runner serving upstream copies for the affected files.
 *
 * @returns the usable overlay directory or "" when nothing could be built.
 */
export async function ensureOverlay(opts: { baseUrl: string; overlayRoot: string; log?: (line: string) => void }): Promise<string> {
    const { baseUrl, overlayRoot } = opts;
    const base = baseUrl.trim().replace(/\/+$/, "");
    const log = opts.log ?? (() => undefined);
    if (markerUsable(readMarker(overlayRoot), overlayRoot, base)) {
        return overlayRoot;
    }
    const marker: OverlayMarker = { baseUrl: base, generatedAt: new Date().toISOString(), files: {} };
    let built = 0;
    for (const target of OVERLAY_TARGETS) {
        const url = `${base}/${target.relPath}`;
        try {
            const res = await fetchText(url);
            if (res.status !== 200) {
                log(`[FormRunner] overlay SKIP ${target.relPath}: HTTP ${res.status} from ${url}`);
                continue;
            }
            const patched = applyOverlayPatches(res.body, target);
            if (patched === null) {
                // Anchor drift: a newer server build moved a patch site. The
                // deviation must be re-derived against that build (see the
                // wiki page); until then the runner may boot white on webview
                // (the exact condition these patches prevent).
                log(`[FormRunner] overlay DRIFT ${target.relPath}: patch anchors do not match this server build - re-derive XFD-*-PATCH definitions (upstream copy served instead).`);
                void vscodeWindowWarn(
                    "The STARLIMS update detected on the server no longer matches the form-runner patch definitions - the in-VS-Code runner may degrade until they are re-derived."
                );
                continue;
            }
            const outFile = path.join(overlayRoot, ...target.relPath.split("/"));
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            fs.writeFileSync(outFile, patched, "utf8");
            marker.files[target.relPath] = { srcSha256: sha256(normalizeEol(res.body)), outSha256: sha256(patched) };
            built += 1;
            log(`[FormRunner] overlay PATCHED ${target.relPath} (source sha256 ${marker.files[target.relPath].srcSha256.slice(0, 12)}…)`);
        } catch (error) {
            log(`[FormRunner] overlay SKIP ${target.relPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (built === 0) {
        return "";
    }
    try {
        fs.mkdirSync(overlayRoot, { recursive: true });
        fs.writeFileSync(path.join(overlayRoot, MARKER_NAME), JSON.stringify(marker, undefined, 2), "utf8");
    } catch {
        return "";
    }
    return overlayRoot;
}

// Small indirection so the module stays import-clean outside VS Code (tests).
function vscodeWindowWarn(message: string): unknown {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscode = require("vscode") as typeof import("vscode");
        return vscode.window.showWarningMessage(message);
    } catch {
        return undefined;
    }
}
