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
  public resolveStatics(): string {
    const configured = vscode.workspace.getConfiguration("STARLIMS").get<string>("designer.statics", "").trim();
    if (configured && !fs.existsSync(configured)) {
      this.output.appendLine(`warning: STARLIMS.designer.statics '${configured}' does not exist - designer will load without client statics`);
    }
    return configured;
  }

  /** Fixtures directory in extension global storage (survives updates, never in git). */
  public fixturesDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, "designer", "fixtures");
  }

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
    const child = cp.spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
   * code-behind/resources sidecars + provider data sidecars) into the
   * staging dir. Always overwrite: the shell is extension payload, never a
   * user edit; target forms (<guid>.* staged per open) are left untouched.
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
  }

  /**
   * Fetch the target form read-only and stage it as `<guid>.ui.xml` +
   * `<guid>.codebehind.wire.js` (+ resources when present). The stored
   * HTMLFORMCODE arrives wire-ready: the EnterpriseService normalizes
   * '#include' lines to '//#include' for JS items, exactly what the
   * eval-based artifact composition needs.
   */
  public async stageForm(
    enterpriseService: EnterpriseService,
    uri: string,
    langId: string,
    guid: string
  ): Promise<void> {
    const fixtures = this.fixturesDir();
    fs.mkdirSync(fixtures, { recursive: true });

    const xml = await enterpriseService.getEnterpriseItemCodeResult(uri, langId);
    if (!xml.ok || !xml.data?.code) {
      throw new Error(xml.error || `Could not retrieve form XML for ${uri}.`);
    }
    fs.writeFileSync(path.join(fixtures, `${guid}.ui.xml`), xml.data.code, "utf8");

    const cbUri = deriveCodeBehindUri(uri);
    if (cbUri) {
      const behind = await enterpriseService.getEnterpriseItemCodeResult(cbUri, langId);
      if (behind.ok && behind.data?.code) {
        fs.writeFileSync(path.join(fixtures, `${guid}.codebehind.wire.js`), behind.data.code, "utf8");
      } else {
        this.output.appendLine(`note: no code-behind for ${cbUri} (${behind.error ?? "empty"})`);
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

/** /Applications/X/HTMLForms/XML/Name -> .../HTMLForms/CodeBehind/Name */
export function deriveCodeBehindUri(uri: string): string | undefined {
  if (/\/HTMLForms\/XML\//i.test(uri)) {
    return uri.replace(/\/HTMLForms\/XML\//i, "/HTMLForms/CodeBehind/");
  }
  return undefined;
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
