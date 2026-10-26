"use strict";

import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import { EnterpriseService } from "./enterpriseService";

/** Where the local designer backend listens plus the staging directory it serves. */
export interface DesignerBackend {
  port: number;
  baseUrl: string;
  fixturesDir: string;
}

/**
 * Manages the local STARLIMS designer backend process.
 *
 * The heavy lifting (byte-exact Form.ToJson projection, statics, data-provider
 * sidecars) is done by `xfd-cli serve` - the Rust core from designer-rs. This
 * service owns its lifecycle: binary/statics resolution (settings with
 * auto-detect), fixture staging (designer shell from resources/designer,
 * target forms fetched read-only via the EnterpriseService), spawn on a free
 * port, readiness probe, and shutdown.
 *
 * The served contract is documented in the workspace wiki
 * (.opencode/wiki/entities/htmlruntime-serve-contract.md):
 *   /Starthtml.lims?FormId=<id>&LangId=<lang>  boot replica
 *   <id>.ui.xml / <id>.html.xml                form definition (ui wins)
 *   <id>.codebehind.wire.js                    stored code-behind (//# includes)
 *   <id>.resources.xml                         resolved Resources item
 *   data-<guid>.json                           provider sidecars (Newtonsoft DataSet JSON)
 */
export class DesignerServerService {
  private child: cp.ChildProcess | undefined;
  private backend: DesignerBackend | undefined;
  private starting: Promise<DesignerBackend> | undefined;
  private output: vscode.OutputChannel;

  constructor(private context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("STARLIMS Designer");
    context.subscriptions.push(this.output);
  }

  /** Settings override first (STARLIMS.designer.command), else the bundled binary. */
  public resolveBinary(): string {
    const configured = vscode.workspace.getConfiguration("STARLIMS").get<string>("designer.command", "").trim();
    const candidate = configured || bundledBinaryPath(this.context);
    if (!fs.existsSync(candidate)) {
      throw new Error(
        `Designer backend binary not found: '${candidate}'. ` +
        `Build it from designer-rs (cargo build --release -p xfd-cli) and copy it to resources/bin/xfd-cli.exe, ` +
        `or set STARLIMS.designer.command.`
      );
    }
    return candidate;
  }

  /** Directory holding the deployed htmlruntime client files (may be empty). */
  public resolveStatics(): string {    const configured = vscode.workspace.getConfiguration("STARLIMS").get<string>("designer.statics", "").trim();
    if (configured && !fs.existsSync(configured)) {
      this.output.appendLine(`warning: STARLIMS.designer.statics '${configured}' does not exist - designer will load without client statics`);
    }
    return configured;
  }

  /** Fixtures directory in extension global storage (survives updates, never in git). */
  public fixturesDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, "designer", "fixtures");
  }

  /**
   * Provides this window's VS Code express callback port to the backend at
   * spawn time (`XFD_CALLBACK_PORT`); serve answers the designer's
   * `SCM_API.FormCallbackPort.GetPort` with it, completing the deployed
   * OpenCodeBehind convention without touching the real server.
   */
  public callbackPortProvider?: () => number | undefined;

  /** Start the backend once and reuse it; concurrent calls share one startup. */
  public async ensureRunning(): Promise<DesignerBackend> {
    if (this.backend && this.child && !this.child.killed && this.child.exitCode === null) {
      return this.backend;
    }
    if (!this.starting) {
      this.starting = this.start().finally(() => { this.starting = undefined; });
    }
    return this.starting;
  }

  private async start(): Promise<DesignerBackend> {
    const binary = this.resolveBinary();
    const statics = this.resolveStatics();
    const fixtures = this.fixturesDir();
    fs.mkdirSync(fixtures, { recursive: true });
    this.seedDesignShell(fixtures);

    const port = await getFreePort();
    const args = ["serve", fixtures, String(port)];
    if (statics) {
      args.push(statics);
    }

    this.output.appendLine(`starting: ${binary} ${args.join(" ")}`);
    const env: NodeJS.ProcessEnv = { ...process.env };
    const callbackPort = this.callbackPortProvider?.();
    if (callbackPort) {
      env.XFD_CALLBACK_PORT = String(callbackPort);
    }
    const child = cp.spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    child.stdout?.on("data", (d) => this.output.appendLine(String(d).trimEnd()));
    child.stderr?.on("data", (d) => this.output.appendLine(String(d).trimEnd()));
    child.on("exit", (code) => {
      this.output.appendLine(`designer backend exited (code ${code})`);
      this.backend = undefined;
      this.child = undefined;
    });

    const backend: DesignerBackend = { port, baseUrl: `http://127.0.0.1:${port}`, fixturesDir: fixtures };
    await waitForReady(backend.baseUrl);
    this.child = child;
    this.backend = backend;
    this.output.appendLine(`designer backend ready: ${backend.baseUrl}`);
    return backend;
  }

  /**
   * Copy the bundled designer-shell fixtures (FormDesigner form + its
   * code-behind/resources sidecars + provider data sidecars + the designer's
   * own behavior client-scripts) into the staging dir. Always overwrite: the
   * shell is extension payload, never a user edit; target forms (<guid>.*
   * staged per open) are left untouched.
   */
  private seedDesignShell(fixtures: string): void {
    const src = path.join(this.context.extensionPath, "resources", "designer");
    if (!fs.existsSync(src)) {
      this.output.appendLine(`warning: no bundled designer shell at ${src} - the FormDesigner itself cannot be served`);
      return;
    }
    for (const file of fs.readdirSync(src)) {
      if (!/\.(ui\.xml|wire\.js|resources\.xml|json|xml)$/i.test(file)) {
        continue;
      }
      fs.copyFileSync(path.join(src, file), path.join(fixtures, file));
    }
    // Behavior client-scripts (`#include` payload the serve stitcher appends):
    // resources/designer/includes/include-<lowername>.js -> fixtures root.
    const includes = path.join(src, "includes");
    if (fs.existsSync(includes)) {
      for (const file of fs.readdirSync(includes)) {
        if (!/^include-.+\.js$/i.test(file)) {
          continue;
        }
        fs.copyFileSync(path.join(includes, file), path.join(fixtures, file));
      }
    } else {
      this.output.appendLine(`warning: no bundled designer includes at ${includes} - the FormDesigner will load without behavior scripts`);
    }
  }

  /**
   * Fetch the target form read-only and stage it as `<guid>.ui.xml` +
   * `<guid>.codebehind.wire.js` (+ resources when present). The stored
   * HTMLFORMCODE arrives wire-ready: the EnterpriseService normalizes
   * '#include' lines to '//#include' for JS items, exactly what the
   * eval-based artifact composition needs.
   *
   * Two prefetches make the staged form designer-loadable without touching
   * the server from the browser (read-only rule):
   *   * every `#include "X.Y"` of the code-behind is fetched from the app's
   *     ClientScripts folder and stored as `include-<x.y>.js` (serve's
   *     ProcessScripts replica appends them to the artifact);
   *   * the dsControlProperties property schema is fetched per control type
   *     used by the form XML and stored as
   *     `data-formdesigner.dscontrolproperties-<type>.json` (ReadXML's
   *     lims.GetData round-trips land on serve's sidecar route).
   */
  public async stageForm(
    enterpriseService: EnterpriseService,
    uri: string,
    langId: string,
    guid: string
  ): Promise<void> {
    const fixtures = this.fixturesDir();
    fs.mkdirSync(fixtures, { recursive: true });

    // Normalize FIRST: the command may arrive from the [XML] node, the
    // [Code Behind] node or a synced code-behind editor - all parts share
    // one GUID but only the XML part carries the form document.
    const xmlUri = deriveFormPartUri(uri, "XML") ?? uri;
    const cbUri = deriveFormPartUri(uri, "CodeBehind");

    const xml = await enterpriseService.getEnterpriseItemCodeResult(xmlUri, langId);
    if (!xml.ok || !xml.data?.code) {
      throw new Error(xml.error || `Could not retrieve form XML for ${xmlUri}.`);
    }
    fs.writeFileSync(path.join(fixtures, `${guid}.ui.xml`), xml.data.code, "utf8");

    const behind = await this.stageCodeBehind(enterpriseService, cbUri, langId, guid, fixtures);
    await this.stageIncludes(enterpriseService, xmlUri, langId, behind, fixtures);
    await this.prefetchControlSchemas(enterpriseService, xml.data.code, fixtures);
  }

  /** Fetch + write `<guid>.codebehind.wire.js`; returns the stored text. */
  private async stageCodeBehind(
    enterpriseService: EnterpriseService,
    cbUri: string | undefined,
    langId: string,
    guid: string,
    fixtures: string
  ): Promise<string | undefined> {
    if (!cbUri) {
      return undefined;
    }
    const behind = await enterpriseService.getEnterpriseItemCodeResult(cbUri, langId);
    if (behind.ok && behind.data?.code) {
      fs.writeFileSync(path.join(fixtures, `${guid}.codebehind.wire.js`), behind.data.code, "utf8");
      return behind.data.code;
    }
    this.output.appendLine(`note: no code-behind for ${cbUri} (${behind.error ?? "empty"})`);
    return undefined;
  }

  /**
   * Resolve `#include "FormDesigner.GUIFunctions"`-style lines against the
   * app's ClientScripts folder (`/Applications/<App>[/<Sub>]/ClientScripts/<name>`,
   * the layout all FormDesigner-family apps use) and store the bodies as the
   * `include-<lowername>.js` sidecars the serve stitcher expects. A script
   * that does not resolve is logged and skipped — serve skips it too, so the
   * designer still loads the form minus that behavior.
   */
  private async stageIncludes(
    enterpriseService: EnterpriseService,
    formUri: string,
    langId: string,
    codeBehind: string | undefined,
    fixtures: string
  ): Promise<void> {
    if (!codeBehind) {
      return;
    }
    const names = new Set<string>();
    for (const m of codeBehind.matchAll(/^(?:\/\/)?\s*#include\s+"([\w.]+)"/gm)) {
      names.add(m[1]);
    }
    const scriptsBase = formUri.replace(/\/HTMLForms\/.*$/i, "/ClientScripts");
    for (const name of names) {
      const sidecar = path.join(fixtures, `include-${name.toLowerCase()}.js`);
      // A `#include "FormDesigner.GUIFunctions"` id is <appName>.<scriptName>;
      // dictionary ClientScripts items are registered under the plain script
      // name below the app folder, the dotted form as a fallback.
      const candidates = [`${scriptsBase}/${name}`, `${scriptsBase}/${name.split(".").pop()}`];
      let code: string | undefined;
      let lastError: string | undefined;
      for (const candidate of candidates) {
        const res = await enterpriseService.getEnterpriseItemCodeResult(candidate, langId);
        if (res.ok && res.data?.code) {
          code = res.data.code;
          break;
        }
        lastError = res.error;
      }
      if (code) {
        fs.writeFileSync(sidecar, code, "utf8");
      } else {
        this.output.appendLine(`note: include '${name}' not staged (${lastError ?? "no such item"}) - form loads without it`);
      }
    }
  }

  /**
   * dsControlProperties schema prefetch. The designer calls
   * lims.GetData("FormDesigner.dsControlProperties", [<schemaType>]) per
   * control type while loading a form; the serve side answers from
   * per-type sidecars. Types come from the form XML's xsi:type members
   * (plus 'Form' for the root — the deployed GetControlSchemaType just
   * strips the 'Starlims' prefix). Already-cached types are skipped, so the
   * bundled shell schemas act as the seed. The wire JSON comes straight off
   * Runtime_Support.GetDataAsJson (exact Newtonsoft DataSet format).
   * STRUCTURAL_TYPES below are additionally always fetched: the designer's
   * ReadXML synthesizes those sub-objects client-side (a SplitContainerH's
   * panels, a TabControl's pages, a DataGrid's root table + columns), so
   * they never appear as xsi:type members, yet SaveForm's XML walk iterates
   * every control's DataProperties — undefined there silently rejects the
   * async save and NO save request ever reaches the server.
   */
  private static readonly STRUCTURAL_TYPES = [
    "SplitterPanel", "TabPage", "DataGridTable", "DataGridColumn",
  ];

  private async prefetchControlSchemas(enterpriseService: EnterpriseService, formXml: string, fixtures: string): Promise<void> {
    const types = new Set<string>(["Form", ...DesignerServerService.STRUCTURAL_TYPES]);
    for (const m of formXml.matchAll(/xsi:type="(\w+)"/g)) {
      types.add(m[1]);
    }
    for (const type of types) {
      const sidecar = path.join(fixtures, `data-formdesigner.dscontrolproperties-${type.toLowerCase()}.json`);
      if (fs.existsSync(sidecar)) {
        continue;
      }
      const res = await enterpriseService.getDataSourceJsonResult("FormDesigner.dsControlProperties", [type]);
      if (res.ok && res.data !== undefined && res.data !== null && res.data !== "") {
        fs.writeFileSync(sidecar, JSON.stringify(res.data), "utf8");
      } else {
        this.output.appendLine(`note: no dsControlProperties schema for '${type}' (${res.error ?? "empty"}) - properties panel will report it`);
      }
    }
  }

  public stop(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
      this.child = undefined;
      this.backend = undefined;
    }
  }

  public dispose(): void {
    this.stop();
  }
}

function bundledBinaryPath(context: vscode.ExtensionContext): string {
  return context.asAbsolutePath(path.join("resources", "bin", "xfd-cli.exe"));
}

/**
 * Rewrite an HTMLForms item URI to a sibling part: any
 * `/Applications/X/HTMLForms/<part>/<Name>` (XML, CodeBehind, Guide,
 * Resources) maps to `/Applications/X/HTMLForms/<target>/<Name>`. All parts
 * of one form share a GUID, so "Design Form" works no matter which tree node
 * (`[XML]`, `[Code Behind]`, …) or synced code-behind editor the command was
 * invoked from.
 */
export function deriveFormPartUri(uri: string, target: string): string | undefined {
  const m = /^(.*\/HTMLForms\/)[^/]+\/([^/]+)$/i.exec(uri);
  return m ? `${m[1]}${target}/${m[2]}` : undefined;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll the serve /api/forms route until it answers (bind is sync, this is belt + braces). */
function waitForReady(baseUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const probe = () => {
      const req = http.get(`${baseUrl}/api/forms`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry();
        }
      });
      req.on("error", retry);
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error("designer backend did not become ready within 5s"));
      } else {
        setTimeout(probe, 100);
      }
    };
    probe();
  });
}
