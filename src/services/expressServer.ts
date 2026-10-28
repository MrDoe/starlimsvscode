import type { Server } from 'http';
import express, { Express, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import * as crypto from 'crypto';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import * as vscode from 'vscode';
import { StarlimsMcpServer } from './starlimsMcpServer';
import { FormRunnerTarget, registerFormRunnerRoutes } from './formRunnerProxy';

dotenv.config();

const FORM_CALLBACK_PORT_RANGE_START = 3003;
const FORM_CALLBACK_PORT_RANGE_END = 3099;
const MCP_WATCHDOG_INTERVAL_MS = 30_000;

export type DesignerSaveKind = "document" | "codebehind";
export type DesignerSaveResult = { ok: boolean; error?: string };

export type ExpressServerOptions = {
    host?: string;
    mcpHost?: string;
    mcpPort?: number;
    mcpServer?: StarlimsMcpServer;
    onOpenCodeBehind: (formId: string, functionName: string) => void | Thenable<unknown> | Promise<unknown>;
    onDesignerSave?: (kind: DesignerSaveKind, args: unknown[]) => Promise<DesignerSaveResult>;
    /** Live-server target for the in-VS-Code form runner (undefined = runner off). */
    runnerTargetProvider?: () => FormRunnerTarget | undefined;
    /** Diagnostic sink for the form-runner proxy (the STARLIMS output channel). */
    log?: (line: string) => void;
};

export class ExpressServer {
    private app: Express;
    private host: string;
    private httpServer: Server | undefined;
    private mcpApp: Express | undefined;
    private mcpHost: string;
    private mcpHttpServer: Server | undefined;
    private mcpPort: number;
    private readonly mcpServer: StarlimsMcpServer | undefined;
    private readonly onOpenCodeBehind: (formId: string, functionName: string) => void | Thenable<unknown> | Promise<unknown>;
    private readonly onDesignerSave: ((kind: DesignerSaveKind, args: unknown[]) => Promise<DesignerSaveResult>) | undefined;
    private readonly runnerTargetProvider: (() => FormRunnerTarget | undefined) | undefined;
    private readonly log: ((line: string) => void) | undefined;
    private mcpWatchdogTimer: ReturnType<typeof setInterval> | undefined;
    private port: number;
    /** Loopback guard token for the form runner proxy (see formRunnerProxy.ts). */
    public readonly runnerToken: string = crypto.randomBytes(16).toString('hex');

    constructor(options: ExpressServerOptions) {
        this.host = options.host ?? '127.0.0.1';
        this.app = express();
        this.mcpHost = options.mcpHost ?? '127.0.0.1';
        this.mcpServer = options.mcpServer;
        this.mcpApp = this.mcpServer ? createMcpExpressApp({ host: this.mcpHost }) : undefined;
        this.onOpenCodeBehind = options.onOpenCodeBehind;
        this.onDesignerSave = options.onDesignerSave;
        this.runnerTargetProvider = options.runnerTargetProvider;
        this.log = options.log;
        this.mcpPort = options.mcpPort ?? 3002;
        this.port = 0;
        this.registerRoutes();
    }

    public async start(): Promise<number | undefined> {
        if (!this.httpServer) {
            this.httpServer = await this.startFormCallbackServer();
        }

        await this.startMcpServer();
        this.startMcpWatchdog();

        return this.getPort();
    }

    public getPort(): number | undefined {
        return this.httpServer && this.port > 0 ? this.port : undefined;
    }

    public async stop(): Promise<void> {
        this.stopMcpWatchdog();

        const server = this.httpServer;
        this.httpServer = undefined;

        const mcpServer = this.mcpHttpServer;
        this.mcpHttpServer = undefined;

        await this.closeServer(server);
        await this.closeServer(mcpServer);
    }

    public dispose(): void {
        this.stopMcpWatchdog();
        void this.stop();
    }

    private registerRoutes(): void {
        // Form runner proxy FIRST: it pipes raw request bodies upstream and
        // must see CallServer POSTs before express.json() consumes them.
        if (this.runnerTargetProvider) {
            registerFormRunnerRoutes(this.app, this.runnerTargetProvider, this.runnerToken, this.log);
        }

        // Designer save forwards from serve carry the full form XML in a JSON
        // array body; generous limit, loopback-only server.
        this.app.use(express.json({ limit: '50mb' }));

        this.app.get('/', (req: Request, res: Response) => {
            res.send('Starlims VS Code HTTP Server');
        });

        // Designer save forwards (from the xfd-cli serve): the CallServer
        // array VERBATIM - [guid, lang, xml] or [guid, code] - persisted to
        // the CHECKED-OUT item through the extension's authenticated session.
        // This is SAVE; check-in stays a user-only action. Answer {} on
        // success / {error} on failure; serve logs both, the designer ignores
        // the response either way, so failures surface as notifications here.
        this.app.post('/DesignerSaveXFDDocument', (req: Request, res: Response) => {
            void this.handleDesignerSave('document', req, res);
        });

        this.app.post('/DesignerSaveCodeBehind', (req: Request, res: Response) => {
            void this.handleDesignerSave('codebehind', req, res);
        });

        this.app.get('/OpenCodeBehind/:formId/:functionName', async (req: Request, res: Response) => {
            const formId = req.params.formId;
            const functionName = req.params.functionName;
            try {
                await Promise.resolve(this.onOpenCodeBehind(formId, functionName));
                res.send(`OK for form id ${formId}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to open form id ${formId}: ${error}`);
                res.send(`Failed to open form id ${formId}: ${error}`);
            }
        });

        this.registerMcpRoutes();
    }

    private async handleDesignerSave(kind: DesignerSaveKind, req: Request, res: Response): Promise<void> {
        const args = Array.isArray(req.body) ? (req.body as unknown[]) : [];
        const id = typeof args[0] === 'string' ? args[0] : '?';
        try {
            if (!this.onDesignerSave) {
                res.json({ error: 'no designer save handler' });
                return;
            }
            const result = await this.onDesignerSave(kind, args);
            if (result.ok) {
                res.json({});
            } else {
                const message = result.error ?? 'save failed';
                vscode.window.showErrorMessage(`Designer save failed for ${id}: ${message}`);
                res.json({ error: message });
            }
        } catch (error) {
            const message = String((error as any)?.message ?? error);
            vscode.window.showErrorMessage(`Designer save failed for ${id}: ${message}`);
            res.json({ error: message });
        }
    }

    private registerMcpRoutes(): void {
        if (!this.mcpApp) {
            return;
        }

        this.mcpApp.get('/', (req: Request, res: Response) => {
            res.send('Starlims VS Code MCP HTTP Server');
        });

        this.mcpApp.get('/health', (req: Request, res: Response) => {
            res.json({ ok: true, service: 'starlims-vscode-mcp-server' });
        });

        this.mcpApp.all('/mcp', async (req: Request, res: Response) => {
            if (!this.mcpServer) {
                res.status(404).json({
                    error: { code: -32004, message: 'STARLIMS MCP endpoint is unavailable.' },
                    id: null,
                    jsonrpc: '2.0'
                });
                return;
            }
            await this.mcpServer.handleRequest(req, res);
        });
    }

    private async startMcpServer(): Promise<void> {
        if (this.mcpHttpServer || !this.mcpApp) {
            return;
        }

        try {
            this.mcpHttpServer = await this.listen(this.mcpApp, this.mcpPort, this.mcpHost);
            vscode.window.showInformationMessage(
                `Starlims VS Code MCP server running on http://${this.mcpHost}:${this.mcpPort}/mcp`
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to start STARLIMS MCP server: ${error}`);
        }
    }

    private startMcpWatchdog(): void {
        this.stopMcpWatchdog();
        this.mcpWatchdogTimer = setInterval(async () => {
            if (!this.mcpApp) {
                return;
            }

            if (this.mcpHttpServer) {
                try {
                    const res = await fetch(`http://${this.mcpHost}:${this.mcpPort}/health`);
                    if (res.ok) {
                        return;
                    }
                } catch {
                    // Server is unreachable — fall through to restart.
                }

                await this.closeServer(this.mcpHttpServer).catch(() => { /* best-effort */ });
                this.mcpHttpServer = undefined;
            }

            await this.startMcpServer();
        }, MCP_WATCHDOG_INTERVAL_MS);
    }

    private stopMcpWatchdog(): void {
        if (this.mcpWatchdogTimer) {
            clearInterval(this.mcpWatchdogTimer);
            this.mcpWatchdogTimer = undefined;
        }
    }

    private async startFormCallbackServer(): Promise<Server | undefined> {
        for (let candidatePort = FORM_CALLBACK_PORT_RANGE_START; candidatePort <= FORM_CALLBACK_PORT_RANGE_END; candidatePort += 1) {
            try {
                const server = await this.listen(this.app, candidatePort, this.host);
                this.port = candidatePort;
                return server;
            } catch (error) {
                const listenError = error as NodeJS.ErrnoException;
                if (listenError.code === 'EADDRINUSE') {
                    continue;
                }
                return undefined;
            }
        }
        return undefined;
    }

    private listen(app: Express, port: number, host: string): Promise<Server> {
        return new Promise((resolve, reject) => {
            const onError = (error: Error) => { reject(error); };
            const server = app.listen(port, host, () => {
                server.off('error', onError);
                resolve(server);
            });
            server.once('error', onError);
        });
    }

    private async closeServer(server: Server | undefined): Promise<void> {
        if (!server) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) { reject(error); return; }
                resolve();
            });
        });
    }
}
