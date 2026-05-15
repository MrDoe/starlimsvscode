import type { Server } from 'http';
import express, { Express, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import dotenv from 'dotenv';
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
    onOpenCodeBehind: (formId: string, functionName: string) => void | Thenable<unknown> | Promise<unknown>;
};

export class ExpressServer
{
    private app: Express;
    private host: string;
    private httpServer: Server | undefined;
    private mcpApp: Express | undefined;
    private mcpHost: string;
    private mcpHttpServer: Server | undefined;
    private mcpPort: number;
    private readonly mcpServer: StarlimsMcpServer | undefined;
    private readonly onOpenCodeBehind: (formId: string, functionName: string) => void | Thenable<unknown> | Promise<unknown>;
    private port: number;

    constructor(options: ExpressServerOptions)
    {
        this.host = options.host ?? '127.0.0.1';
        this.app = express();
        this.mcpHost = options.mcpHost ?? '127.0.0.1';
        this.mcpServer = options.mcpServer;
        this.mcpApp = this.mcpServer ? createMcpExpressApp({ host: this.mcpHost }) : undefined;
        this.onOpenCodeBehind = options.onOpenCodeBehind;
        this.mcpPort = options.mcpPort ?? 3002;
        this.port = 0;
        this.registerRoutes();
    }

    public async start(): Promise<number | undefined>
    {
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

        return this.getPort();
    }

    public getPort(): number | undefined
    {
        return this.httpServer && this.port > 0 ? this.port : undefined;
    }

    public async stop(): Promise<void>
    {
        const server = this.httpServer;
        this.httpServer = undefined;

        const mcpServer = this.mcpHttpServer;
        this.mcpHttpServer = undefined;

        await this.closeServer(server);
        await this.closeServer(mcpServer);
    }

    public dispose(): void
    {
        void this.stop();
    }

    private registerRoutes(): void
    {
        this.app.get('/', (req: Request, res: Response) => {
            res.send('Starlims VS Code HTTP Server');
        });

        /**
         * Open the code behind file for the form id
         * @param FormId The form id to open
         * @returns OK if successful, error message if failed
         */
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

        if (!this.mcpApp) {
            return;
        }

        this.mcpApp.get('/', (req: Request, res: Response) => {
            res.send('Starlims VS Code MCP HTTP Server');
        });

        this.mcpApp.get('/health', (req: Request, res: Response) => {
            res.json({
                ok: true,
                service: 'starlims-vscode-mcp-server'
            });
        });

        this.mcpApp.all('/mcp', async (req: Request, res: Response) => {
            if (!this.mcpServer) {
                res.status(404).json({
                    error: {
                        code: -32004,
                        message: 'STARLIMS MCP endpoint is unavailable.'
                    },
                    id: null,
                    jsonrpc: '2.0'
                });
                return;
            }

            await this.mcpServer.handleRequest(req, res);
        });
    }

    private async startFormCallbackServer(): Promise<Server | undefined> {
        for (let candidatePort = FORM_CALLBACK_PORT_RANGE_START; candidatePort <= FORM_CALLBACK_PORT_RANGE_END; candidatePort += 1) {
            try {
                const server = await this.listen(this.app, candidatePort, this.host);
                this.port = candidatePort;
                vscode.window.showInformationMessage(
                    `Starlims VS Code form callback server running on http://${this.host}:${this.port}`
                );
                return server;
            } catch (error) {
                const listenError = error as NodeJS.ErrnoException;
                if (listenError.code === 'EADDRINUSE') {
                    continue;
                }

                vscode.window.showErrorMessage(`Failed to start STARLIMS form callback server: ${error}`);
                return undefined;
            }
        }

        vscode.window.showErrorMessage(
            `Failed to start STARLIMS form callback server: no free port was available on ${this.host} in the range ${FORM_CALLBACK_PORT_RANGE_START}-${FORM_CALLBACK_PORT_RANGE_END}.`
        );
        return undefined;
    }

    private listen(app: Express, port: number, host: string): Promise<Server> {
        return new Promise((resolve, reject) => {
            const onError = (error: Error) => {
                reject(error);
            };

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
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    }
}
