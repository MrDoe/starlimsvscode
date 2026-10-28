"use strict";

import type { NextFunction, Request, Response } from "express";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";

/**
 * Loopback reverse proxy that makes the LIVE STARLIMS web runtime work
 * inside a VS Code webview (the "Open Form" runner).
 *
 * Why this exists (see .opencode/wiki/concepts/openform-in-vscode.md):
 * - the live server's session cookie is SameSite=Lax, so a cross-site
 *   webview iframe never sends it (white, unauthenticated boot);
 * - the stock htmlruntime reads window.top.AI, which is blocked
 *   cross-origin from the webview.
 * Serving under http://127.0.0.1:<callbackPort><appPath> makes the iframe
 * SAME-ORIGIN: the boot page (proxied), the login screen, and every
 * `<script>.lims` CallServer POST — all built relative to
 * window.location.pathname by the runtime — hit THIS proxy instead.
 *
 * The proxy:
 * 1. guards the mount with a per-session token (?xfdtk= on the boot URL,
 *    then an xfdrtk cookie; other local processes get 401 — the proxied
 *    session must not be reachable machine-wide);
 * 2. serves /htmlruntime|support-html|images from the designer's
 *    XFD-SANDBOX-patched statics dir (fixes the window.top reads; same
 *    tree `xfd-cli serve` uses);
 * 3. proxies everything else to the real server, holding the server's
 *    ASP.NET_SessionId (and friends) in a Node-side jar — the iframe
 *    itself never sees server cookies, and the login flow (including
 *    MFA/site-role variants) runs unmodified inside the panel.
 *
 * MUST be registered BEFORE express.json() (the raw request body is
 * piped upstream; a consumed stream would break every CallServer POST).
 */

export type FormRunnerTarget = {
    /** Real server base URL, e.g. https://host/starlims (server app path included). */
    baseUrl: string;
    /** Directory with the patched statics (htmlruntime/, support-html/, images/). May be "". */
    staticsRoot: string;
};

const COOKIE_NAME = "xfdrtk";

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".bmp": "image/bmp",
    ".pdf": "application/pdf",
    ".wasm": "application/wasm"
};

/** One jar per server base URL: switching servers must not leak a session. */
const sessionJars = new Map<string, Map<string, string>>();

/** Paths whose static-file miss was already reported (bounded). */
const reportedStaticMisses = new Set<string>();

function getJar(baseUrl: string): Map<string, string> {
    let jar = sessionJars.get(baseUrl);
    if (!jar) {
        jar = new Map<string, string>();
        sessionJars.set(baseUrl, jar);
    }
    return jar;
}

/** Wipe captured sessions (e.g. after the extension logs out / switches user). */
export function clearFormRunnerSessions(): void {
    sessionJars.clear();
}

function parseClientCookies(req: Request): Map<string, string> {
    const out = new Map<string, string>();
    const header = req.headers.cookie;
    if (!header) {
        return out;
    }
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0) {
            out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
        }
    }
    return out;
}

/**
 * The ?xfdtk= token carried by the document URL (Referer). Same-origin
 * subresource requests send the full referring URL, query included - a second
 * token source for contexts where the cookie is not sent (VS Code webviews
 * are a cross-site embedding, so SameSite rules apply).
 */
function tokenFromReferer(referer: string | undefined): string | undefined {
    if (!referer) {
        return undefined;
    }
    try {
        return new URL(referer).searchParams.get("xfdtk") ?? undefined;
    } catch {
        return undefined;
    }
}

function jarToHeader(jar: Map<string, string>): string | undefined {
    const pairs = [...jar.entries()].map(([k, v]) => `${k}=${v}`);
    return pairs.length > 0 ? pairs.join("; ") : undefined;
}

/** name=value of the first cookie segment; empty value deletes the entry. */
function captureSetCookies(jar: Map<string, string>, setCookie: string[] | undefined): void {
    for (const line of setCookie ?? []) {
        const pair = line.split(";")[0];
        const eq = pair.indexOf("=");
        if (eq <= 0) {
            continue;
        }
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value.length === 0) {
            jar.delete(name);
        } else {
            jar.set(name, value);
        }
    }
}

function tryServeStatic(staticsRoot: string, relPath: string, res: Response): boolean {
    if (!staticsRoot || relPath.length === 0) {
        return false;
    }
    const root = path.resolve(staticsRoot);
    const target = path.resolve(root, "." + path.posix.normalize(relPath));
    if (target !== root && !target.startsWith(root + path.sep)) {
        return false; // traversal attempt
    }
    let stat: fs.Stats;
    try {
        stat = fs.statSync(target);
    } catch {
        return false;
    }
    if (!stat.isFile()) {
        return false;
    }
    const type = MIME_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream";
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-cache"); // dev loop: patched statics get hot-edited
    fs.createReadStream(target).pipe(res);
    return true;
}

function proxyToServer(proxyPrefix: string, targetBaseUrl: string, req: Request, res: Response, jar: Map<string, string>): void {
    const upstreamBase = new URL(targetBaseUrl);
    const isHttps = upstreamBase.protocol === "https:";
    const client = isHttps ? https : http;

    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase();
        if (["host", "cookie", "connection", "keep-alive", "upgrade", "origin", "referer"].includes(lower)) {
            continue;
        }
        if (value !== undefined) {
            headers[name] = value;
        }
    }
    headers["host"] = upstreamBase.host;
    // The server may check request provenance — present the real-site pair.
    headers["origin"] = upstreamBase.origin;
    headers["referer"] = upstreamBase.origin + upstreamBase.pathname;
    const cookieHeader = jarToHeader(jar);
    if (cookieHeader) {
        headers["cookie"] = cookieHeader;
    }

    const upstreamReq = client.request(
        {
            protocol: upstreamBase.protocol,
            hostname: upstreamBase.hostname,
            port: upstreamBase.port !== "" ? Number(upstreamBase.port) : undefined,
            path: req.originalUrl,
            method: req.method,
            headers
        },
        (upstreamRes) => {
            captureSetCookies(jar, upstreamRes.headers["set-cookie"]);

            const outHeaders: http.OutgoingHttpHeaders = {};
            for (const [name, value] of Object.entries(upstreamRes.headers)) {
                const lower = name.toLowerCase();
                // X-Frame-Options AND the CSP must never ride through: the
                // live server sends SAMEORIGIN plus
                // "Content-Security-Policy: frame-ancestors *". Chromium
                // evaluates CSP frame-ancestors INSTEAD of XFO (CSP wins),
                // and the "*" source does NOT match the opaque-scheme
                // vscode-webview:// ancestor — the panel's embedder chain is
                // [top workbench, vscode-webview://<uuid>, <inner webview
                // doc>], so EVERY ancestor is unmatched and the loaded
                // document is refused RENDERING
                // (HTTP 200 + net::ERR_BLOCKED_BY_RESPONSE + a
                // chrome-error:// frame = the fourth/fifth white-panel
                // cause). The ?xfdtk= token gate is the actual access
                // control for this mount.
                if (["set-cookie", "connection", "keep-alive", "transfer-encoding", "upgrade", "x-frame-options", "content-security-policy"].includes(lower)) {
                    continue;
                }
                if (value !== undefined) {
                    outHeaders[name] = value;
                }
            }
            // Absolute redirects back to the real server must stay on the proxy.
            const location = outHeaders["location"];
            if (typeof location === "string" && location.startsWith(upstreamBase.origin)) {
                outHeaders["location"] = proxyPrefix + location.slice(upstreamBase.origin.length);
            }
            res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
            upstreamRes.pipe(res);
        }
    );

    upstreamReq.on("error", (error) => {
        if (!res.headersSent) {
            res.status(502).send(`form runner proxy: upstream request failed: ${(error as Error).message}`);
        } else {
            res.destroy();
        }
    });
    // Long-polling/SSE/batch calls must not be cut by node's default timeout.
    upstreamReq.setTimeout(0);
    req.pipe(upstreamReq);
}

/**
 * Mounts the runner on the extension's loopback express app.
 *
 * @param getAppPathProvider current proxy mount prefix ("" disables the runner)
 * @param getTarget current upstream/statics configuration (undefined disables)
 * @param token loopback access token minted by the caller (ExpressServer)
 * @param log optional diagnostic sink (the STARLIMS output channel)
 */
export function registerFormRunnerRoutes(
    app: { use: (handler: (req: Request, res: Response, next: NextFunction) => void) => unknown },
    getTarget: () => FormRunnerTarget | undefined,
    token: string,
    log?: (line: string) => void
): void {
    app.use((req: Request, res: Response, next: NextFunction) => {
        const target = getTarget();
        if (!target) {
            next();
            return;
        }
        let appPath: string;
        try {
            appPath = new URL(target.baseUrl).pathname.replace(/\/+$/, "");
        } catch {
            next();
            return;
        }
        if (appPath.length === 0) {
            next();
            return;
        }
        const pathname = decodeURIComponent(req.path);
        if (pathname !== appPath && !pathname.startsWith(appPath + "/")) {
            next();
            return;
        }

        // Loopback token: the boot URL carries ?xfdtk=; its own response sets
        // the cookie for every later call. The check ACCEPTS ANY source that
        // matches — order only decides which cookie is (re-)set, never who is
        // refused. Strict priority on the cookie was the third white-panel
        // bug: the webview cookie jar SURVIVES a window reload, but
        // runnerToken is re-minted per activation, so the stale cookie
        // shadowed the fresh ?xfdtk= query of the new boot and 401'd it.
        // VS Code embeds the panel iframe in a vscode-webview:// document, i.e.
        // a CROSS-SITE context: a SameSite cookie is not sent there at all.
        // The cookie is therefore SameSite=None; Secure (Chromium lets Secure
        // cookies set on the trustworthy loopback origin), and the Referer
        // query is a cookie-free fallback.
        const queryToken = typeof req.query.xfdtk === "string" ? req.query.xfdtk : undefined;
        const clientCookies = parseClientCookies(req);
        const refererToken = tokenFromReferer(req.headers.referer);
        const cookieToken = clientCookies.get(COOKIE_NAME);
        const clientToken = [queryToken, cookieToken, refererToken].find((t) => t === token);
        if (clientToken !== token) {
            log?.(`[FormRunner] 401 ${pathname} (cookie=${clientCookies.has(COOKIE_NAME)}, query=${queryToken !== undefined}, referer=${req.headers.referer !== undefined})`);
            res.status(401).send("STARLIMS form runner: missing or wrong xfdtk token.");
            return;
        }

        const jar = getJar(target.baseUrl);

        // The boot navigation (query token) (re-)writes the cookie so a stale
        // one from an earlier window session cannot outlive this one.
        if (queryToken === token) {
            log?.(`[FormRunner] boot ${pathname} (statics=${target.staticsRoot || "NONE"})`);
            res.append("Set-Cookie", `${COOKIE_NAME}=${token}; Path=${appPath || "/"}; HttpOnly; SameSite=None; Secure`);
        }

        // Patched client statics win over the server copies; dynamic paths
        // (*.lims etc.) fall through to the proxy.
        const relPath = pathname.slice(appPath.length);
        if (req.method === "GET" || req.method === "HEAD") {
            if (tryServeStatic(target.staticsRoot, relPath, res)) {
                return;
            }
            // A client file that is NOT in the local statics tree goes to the
            // server copy - which is the UNPATCHED htmlruntime and boots white
            // inside a webview (window.top reads). Name it once per path.
            if (/^\/(htmlruntime|support-html)\//.test(relPath) && !reportedStaticMisses.has(relPath)) {
                reportedStaticMisses.add(relPath);
                log?.(`[FormRunner] static MISS ${relPath} -> server copy is unpatched (statics=${target.staticsRoot || "NONE"})`);
            }
        }

        const proxyPrefix = `http://${req.headers.host ?? "127.0.0.1"}${appPath}`;
        proxyToServer(proxyPrefix, target.baseUrl, req, res, jar);
    });
}
