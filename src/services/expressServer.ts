import type { Server } from 'http';
import express, { Express, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import * as vscode from 'vscode';
import { StarlimsMcpServer } from './starlimsMcpServer';

dotenv.config();

const FORM_CALLBACK_PORT_RANGE_START = 3003;
const FORM_CALLBACK_PORT_RANGE_END = 3099;

export type ExpressServerOptions = {
    host?: string;
    mcpHost?: string;
    mcpPort?: number;
    mcpServer?: StarlimsMcpServer;
    opencodeProxyEnabled?: boolean;
    opencodeProxyHost?: string;
    opencodeProxyPort?: number;
    opencodeProxyTargetUrl?: string;
    onOpenCodeBehind: (formId: string, functionName: string) => void | Thenable<unknown> | Promise<unknown>;
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
    private opencodeApp: Express | undefined;
    private opencodeHttpServer: Server | undefined;
    private readonly opencodeProxyEnabled: boolean;
    private readonly opencodeProxyHost: string;
    private readonly opencodeProxyPort: number;
    private readonly opencodeProxyTargetUrl: string;
    private readonly onOpenCodeBehind: (formId: string, functionName: string) => void | Thenable<unknown> | Promise<unknown>;
    private port: number;

    private static readonly opencodeProxySessionTitle = 'STARLIMS Copilot Proxy';

    constructor(options: ExpressServerOptions) {
        this.host = options.host ?? '127.0.0.1';
        this.app = express();
        this.mcpHost = options.mcpHost ?? '127.0.0.1';
        this.mcpServer = options.mcpServer;
        this.mcpApp = this.mcpServer ? createMcpExpressApp({ host: this.mcpHost }) : undefined;
        this.onOpenCodeBehind = options.onOpenCodeBehind;
        this.mcpPort = options.mcpPort ?? 3002;
        this.port = 0;
        this.opencodeProxyEnabled = options.opencodeProxyEnabled ?? false;
        this.opencodeProxyHost = options.opencodeProxyHost ?? '127.0.0.1';
        this.opencodeProxyPort = options.opencodeProxyPort ?? 3005;
        this.opencodeProxyTargetUrl = options.opencodeProxyTargetUrl ?? 'http://localhost:4096';
        this.opencodeApp = this.opencodeProxyEnabled ? express() : undefined;
        this.registerRoutes();
    }

    public async start(): Promise<number | undefined> {
        if (!this.httpServer) {
            this.httpServer = await this.startFormCallbackServer();
        }

        if (!this.mcpHttpServer && this.mcpApp) {
            try {
                this.mcpHttpServer = await this.listen(this.mcpApp, this.mcpPort, this.mcpHost);
                vscode.window.showInformationMessage(
                    `Starlims VS Code MCP server running on http://${this.mcpHost}:${this.mcpPort}/mcp`
                );
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to start STARLIMS MCP server: ${error}`);
            }
        }

        if (!this.opencodeHttpServer && this.opencodeApp) {
            try {
                this.opencodeHttpServer = await this.listen(this.opencodeApp, this.opencodeProxyPort, this.opencodeProxyHost);
                vscode.window.showInformationMessage(
                    `OpenCode proxy running on http://${this.opencodeProxyHost}:${this.opencodeProxyPort} → ${this.opencodeProxyTargetUrl}`
                );
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to start OpenCode proxy: ${error}`);
            }
        }

        return this.getPort();
    }

    public getPort(): number | undefined {
        return this.httpServer && this.port > 0 ? this.port : undefined;
    }

    public async stop(): Promise<void> {
        const server = this.httpServer;
        this.httpServer = undefined;

        const mcpServer = this.mcpHttpServer;
        this.mcpHttpServer = undefined;

        const opencodeServer = this.opencodeHttpServer;
        this.opencodeHttpServer = undefined;

        await this.closeServer(server);
        await this.closeServer(mcpServer);
        await this.closeServer(opencodeServer);
    }

    public dispose(): void {
        void this.stop();
    }

    private registerRoutes(): void {
        this.app.get('/', (req: Request, res: Response) => {
            res.send('Starlims VS Code HTTP Server');
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
        this.registerOpencodeProxyRoutes();
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

    private registerOpencodeProxyRoutes(): void {
        if (!this.opencodeApp) {
            return;
        }

        const modelRoutes = ['/models', '/v1/models'];
        const chatCompletionRoutes = ['/chat/completions', '/v1/chat/completions'];
        const completionRoutes = [
            '/completions',
            '/engines/*/completions',
            '/v1/completions',
            '/v1/engines/*/completions'
        ];

        // Increase limits for large Copilot context windows
        this.opencodeApp.use(express.json({ limit: '50mb' }));

        this.opencodeApp.get('/', (req: Request, res: Response) => {
            res.send('Starlims VS Code OpenCode Proxy');
        });

        this.opencodeApp.get('/health', (req: Request, res: Response) => {
            res.json({
                ok: true,
                service: 'starlims-vscode-opencode-proxy',
                target: this.opencodeProxyTargetUrl
            });
        });

        // Copilot will query for available models - proxy to OpenCode backend
        this.opencodeApp.get(modelRoutes, async (req: Request, res: Response) => {
            try {
                const normalizedTargetUrl = this.normalizeOpenCodeTargetUrl();
                const modelsUrl = this.buildOpenCodeApiUrl(normalizedTargetUrl, '/models');
                const response = await fetch(modelsUrl);
                const modelsData = await response.json();
                res.json(modelsData);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error('Failed to fetch models from OpenCode:', message);
                res.status(500).json({ error: { message } });
            }
        });

        // 1. CHAT COMPLETIONS (For the Copilot Chat panel)
        this.opencodeApp.post(chatCompletionRoutes, async (req: Request, res: Response) => {
            await this.handleOpenAIRequest(req, res, true);
        });

        // 2. INLINE COMPLETIONS (For Ghost Text in the editor)
        // Copilot sometimes uses the engines endpoint for autocomplete
        this.opencodeApp.post(completionRoutes, async (req: Request, res: Response) => {
            await this.handleOpenAIRequest(req, res, false);
        });
    }

    /**
    * Unified handler to intercept Copilot requests, send to OpenCode, and stream responses back
    */
    private async handleOpenAIRequest(req: Request, res: Response, isChat: boolean): Promise<void> {
        try {
            const isStream = req.body.stream === true;
            let prompt = '';

            // Extract prompt depending on whether it's Chat (messages array) or Inline (prompt string)
            if (isChat) {
                const messages = req.body.messages || [];
                prompt = messages.map((m: any) => `${m.role}: ${m.content}`).join('\n');
            } else {
                // Copilot often sends prefix and suffix in standard completions
                prompt = req.body.prompt || '';
            }

            const responseText = await this.getOpenCodeResponseText(prompt);

            if (isStream) {
                // 🚀 VITAL FOR COPILOT: Fake an SSE stream
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                const chunkId = `chatcmpl-${Math.floor(Date.now() / 1000)}`;
                const created = Math.floor(Date.now() / 1000);
                const model = req.body.model || 'opencode-go';

                // 1. Send the text payload chunk
                const dataChunk = {
                    id: chunkId,
                    object: isChat ? 'chat.completion.chunk' : 'text_completion',
                    created: created,
                    model: model,
                    choices: isChat ? [
                        { index: 0, delta: { content: responseText }, finish_reason: null }
                    ] : [
                        { text: responseText, index: 0, finish_reason: null }
                    ]
                };
                res.write(`data: ${JSON.stringify(dataChunk)}\n\n`);

                // 2. Send the stop signal chunk
                const finishChunk = {
                    id: chunkId,
                    object: isChat ? 'chat.completion.chunk' : 'text_completion',
                    created: created,
                    model: model,
                    choices: isChat ? [
                        { index: 0, delta: {}, finish_reason: 'stop' }
                    ] : [
                        { text: '', index: 0, finish_reason: 'stop' }
                    ]
                };
                res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);

                // 3. Send done signal
                res.write(`data: [DONE]\n\n`);
                res.end();
            } else {
                // Standard non-streaming fallback
                res.json({
                    id: `cmpl-${Math.floor(Date.now() / 1000)}`,
                    object: isChat ? 'chat.completion' : 'text_completion',
                    created: Math.floor(Date.now() / 1000),
                    model: req.body.model || 'opencode-go',
                    choices: [
                        isChat ? {
                            index: 0,
                            message: { role: 'assistant', content: responseText },
                            finish_reason: 'stop'
                        } : {
                            text: responseText,
                            index: 0,
                            logprobs: null,
                            finish_reason: 'stop'
                        }
                    ]
                });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('OpenCode Proxy Error:', message);
            res.status(500).json({ error: message });
        }
    }

    private async getOpenCodeResponseText(prompt: string): Promise<string> {
        const normalizedTargetUrl = this.normalizeOpenCodeTargetUrl();
        if (normalizedTargetUrl.pathname.endsWith('/run')) {
            return this.getLegacyOpenCodeResponseText(prompt, normalizedTargetUrl);
        }

        return this.getSessionApiOpenCodeResponseText(prompt, normalizedTargetUrl);
    }

    private normalizeOpenCodeTargetUrl(): URL {
        const targetUrl = new URL(this.opencodeProxyTargetUrl);
        if (!targetUrl.pathname || targetUrl.pathname === '') {
            targetUrl.pathname = '/';
        }

        return targetUrl;
    }

    private buildOpenCodeApiUrl(baseUrl: URL, path: string): string {
        const normalizedBaseUrl = new URL(baseUrl.toString());
        normalizedBaseUrl.pathname = normalizedBaseUrl.pathname.endsWith('/')
            ? normalizedBaseUrl.pathname
            : `${normalizedBaseUrl.pathname}/`;

        return new URL(path.replace(/^\//, ''), normalizedBaseUrl).toString();
    }

    private async getLegacyOpenCodeResponseText(prompt: string, targetUrl: URL): Promise<string> {
        const headers: Record<string, string> = {};
        headers['Content-Type'] = 'application/json';

        const response = await fetch(targetUrl.toString(), {
            method: 'POST',
            headers,
            body: JSON.stringify({ prompt })
        });

        const data = await this.readOpenCodeJsonResponse(response);
        return this.extractOpenCodeResponseText(data);
    }

    private async getSessionApiOpenCodeResponseText(prompt: string, baseUrl: URL): Promise<string> {
        const headers: Record<string, string> = {};
        headers['Content-Type'] = 'application/json';

        const createSessionResponse = await fetch(this.buildOpenCodeApiUrl(baseUrl, '/session'), {
            method: 'POST',
            headers,
            body: JSON.stringify({ title: ExpressServer.opencodeProxySessionTitle })
        });

        const sessionData = await this.readOpenCodeJsonResponse(createSessionResponse);
        const sessionId = typeof sessionData.id === 'string' ? sessionData.id : undefined;
        if (!sessionId) {
            throw new Error('OpenCode session creation did not return a session ID.');
        }

        try {
            const messageResponse = await fetch(this.buildOpenCodeApiUrl(baseUrl, `/session/${sessionId}/message`), {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    parts: [{ type: 'text', text: prompt }]
                })
            });

            const messageData = await this.readOpenCodeJsonResponse(messageResponse);
            return this.extractOpenCodeResponseText(messageData);
        } finally {
            await this.deleteOpenCodeSession(baseUrl, sessionId);
        }
    }

    private async deleteOpenCodeSession(baseUrl: URL, sessionId: string): Promise<void> {
        try {
            await fetch(this.buildOpenCodeApiUrl(baseUrl, `/session/${sessionId}`), {
                method: 'DELETE'
            });
        } catch {
            // Ignore cleanup failures; the proxy request has already completed.
        }
    }

    private async readOpenCodeJsonResponse(response: fetch.Response): Promise<any> {
        const responseText = await response.text();
        if (!response.ok) {
            throw new Error(`OpenCode request failed with ${response.status}: ${responseText}`);
        }

        try {
            return JSON.parse(responseText);
        } catch {
            throw new Error(`OpenCode returned a non-JSON response: ${responseText}`);
        }
    }

    private extractOpenCodeResponseText(data: any): string {
        if (typeof data?.output === 'string') {
            return data.output;
        }

        if (Array.isArray(data?.parts)) {
            const textParts = data.parts
                .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
                .map((part: any) => part.text);
            if (textParts.length > 0) {
                return textParts.join('');
            }
        }

        return JSON.stringify(data);
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