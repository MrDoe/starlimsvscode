"use strict";

import { spawn, type ChildProcess } from "child_process";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
import type { Part, SessionStatus } from "@opencode-ai/sdk/client";

export type OpenCodeServerServiceOptions = {
  hostname: string;
  port: number;
  command: string;
  commandArgs: string[];
  workingDirectory: string;
  username?: string;
  password?: string;
  log?: (message: string) => void;
};

const DEFAULT_SERVER_USERNAME = "opencode";
const SERVER_START_TIMEOUT_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_CAPTURED_SERVER_OUTPUT_LINES = 200;

type ResolvedModel = {
  providerID: string;
  modelID: string;
};

/**
 * Client for the OpenCode server API (opencode web/serve).
 *
 * The extension spawns `opencode web` on demand (API + browser UI on the same
 * port) or reuses a server that is already running on the configured
 * hostname/port. All ticket sessions are created and driven through the
 * official @opencode-ai/sdk typed client.
 */
export class OpenCodeServerService {
  private readonly options: OpenCodeServerServiceOptions;
  private client: OpencodeClient | undefined;
  private child: ChildProcess | undefined;
  private ensurePromise: Promise<void> | undefined;
  private modelCache: Map<string, ResolvedModel | undefined> = new Map();
  private agentIdCache: Set<string> | undefined;
  private disposed = false;
  private capturedServerOutput: string[] = [];

  constructor(options: OpenCodeServerServiceOptions) {
    this.options = options;
  }

  public get serverUrl(): string {
    return `http://${this.options.hostname}:${this.options.port}`;
  }

  public get isSpawned(): boolean {
    return !!this.child;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /**
   * Makes sure an OpenCode server is reachable on the configured port.
   * Reuses an already running server, otherwise spawns `opencode web` in the
   * configured working directory and waits until it responds to health checks.
   */
  public async ensureServer(): Promise<void> {
    if (this.client) {
      return;
    }
    if (this.ensurePromise) {
      return this.ensurePromise;
    }

    this.ensurePromise = (async () => {
      if (await this.checkHealth()) {
        this.log(`OpenCode server already running at ${this.serverUrl}.`);
      } else {
        await this.startServer();
      }
      this.client = this.createClient();
    })().finally(() => {
      this.ensurePromise = undefined;
    });

    return this.ensurePromise;
  }

  private createClient(): OpencodeClient {
    return createOpencodeClient({
      baseUrl: this.serverUrl,
      fetch: this.createAuthenticatedFetch()
    });
  }

  private createAuthenticatedFetch(): typeof fetch {
    const password = this.options.password;
    if (!password) {
      return fetch.bind(globalThis);
    }

    const credentials = Buffer.from(
      `${this.options.username || DEFAULT_SERVER_USERNAME}:${password}`
    ).toString("base64");

    return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? new Request(input) : new Request(input, init);
      request.headers.set("Authorization", `Basic ${credentials}`);
      return fetch(request);
    };
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
      const response = await fetch(`${this.serverUrl}/global/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) {
        return false;
      }
      const payload = (await response.json()) as { healthy?: boolean };
      return payload.healthy === true;
    } catch {
      return false;
    }
  }

  private async startServer(): Promise<void> {
    const args = [
      ...this.options.commandArgs,
      "web",
      "--hostname",
      this.options.hostname,
      "--port",
      String(this.options.port)
    ];

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.options.password) {
      env.OPENCODE_SERVER_PASSWORD = this.options.password;
      env.OPENCODE_SERVER_USERNAME = this.options.username || DEFAULT_SERVER_USERNAME;
    }

    this.log(`Spawning OpenCode server: ${this.options.command} ${args.join(" ")} (cwd: ${this.options.workingDirectory})`);

    const child = spawn(this.options.command, args, {
      cwd: this.options.workingDirectory,
      env,
      shell: process.platform === "win32",
      windowsHide: true
    });
    this.child = child;

    const captureOutput = (chunk: Buffer | string) => {
      const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
      this.capturedServerOutput.push(...lines);
      if (this.capturedServerOutput.length > MAX_CAPTURED_SERVER_OUTPUT_LINES) {
        this.capturedServerOutput.splice(0, this.capturedServerOutput.length - MAX_CAPTURED_SERVER_OUTPUT_LINES);
      }
      for (const line of lines) {
        this.log(`[OpenCode server] ${line}`);
      }
    };
    child.stdout?.on("data", captureOutput);
    child.stderr?.on("data", captureOutput);

    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.on("error", (error) => {
        this.log(`OpenCode server process error: ${error.message}`);
        resolve(null);
      });
    });

    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.disposed) {
        throw new Error("OpenCode server start was cancelled because the extension is shutting down.");
      }
      if (child.exitCode !== null) {
        break;
      }
      if (await this.checkHealth()) {
        this.log(`OpenCode server is ready at ${this.serverUrl}.`);
        return;
      }
      await sleep(500);
    }

    const exitCode = await Promise.race([exitPromise, Promise.resolve(undefined)]);
    if (exitCode !== undefined || child.exitCode !== null) {
      const serverOutput = this.capturedServerOutput.join("\n");
      const outputSuffix = serverOutput ? `\nServer output:\n${serverOutput}` : "";
      throw new Error(`OpenCode server exited with code ${exitCode ?? child.exitCode} before becoming ready.${outputSuffix}`);
    }

    this.stopChild();
    throw new Error(`Timed out waiting for the OpenCode server to become ready at ${this.serverUrl}.`);
  }

  /**
   * Creates a new session on the server and returns its id.
   */
  public async createSession(title: string): Promise<string> {
    const client = this.getClient();
    const session = unwrapData(await client.session.create({ body: { title } }));
    return session.id;
  }

  /**
   * Sends a message to a session without waiting for the response.
   */
  public async sendMessage(
    sessionId: string,
    text: string,
    options?: { model?: string; agent?: string }
  ): Promise<void> {
    const client = this.getClient();
    const model = options?.model ? await this.resolveModel(options.model) : undefined;
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        agent: options?.agent,
        model,
        parts: [{ type: "text", text }]
      }
    });
  }

  public async getSessionStatus(sessionId: string): Promise<SessionStatus | undefined> {
    try {
      const client = this.getClient();
      const statuses = unwrapData(await client.session.status());
      return statuses[sessionId];
    } catch (error) {
      this.log(`Could not read status for session ${sessionId}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Polls the session status until the session is idle (agent run finished),
   * the timeout elapses, or the caller cancels. A session that is missing from
   * the status map has not started processing yet and is treated as running.
   */
  public async waitUntilIdle(
    sessionId: string,
    options?: { intervalMs?: number; timeoutMs?: number; isCancelled?: () => boolean }
  ): Promise<void> {
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const startedAt = Date.now();
    let missingSince: number | undefined;

    while (true) {
      if (this.disposed || options?.isCancelled?.()) {
        return;
      }
      if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
        this.log(`Stopped waiting for session ${sessionId} after ${timeoutMs}ms.`);
        return;
      }

      const status = await this.getSessionStatus(sessionId);
      if (status && status.type === "idle") {
        return;
      }
      if (!status) {
        missingSince = missingSince ?? Date.now();
        if (Date.now() - missingSince > 60_000) {
          this.log(`Session ${sessionId} has not started after 60s; keeping the session open.`);
          missingSince = undefined;
        }
      } else {
        missingSince = undefined;
      }

      await sleep(intervalMs);
    }
  }

  /**
   * Returns the text of the last assistant message in a session, which is the
   * plan or result produced by the agent run.
   */
  public async getLastAssistantText(sessionId: string): Promise<string | undefined> {
    try {
      const client = this.getClient();
      const messages = unwrapData(await client.session.messages({ path: { id: sessionId } }));
      const lastAssistant = [...messages].reverse().find((entry) => entry.info.role === "assistant");
      if (!lastAssistant) {
        return undefined;
      }
      return lastAssistant.parts
        .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
        .filter((part) => !part.ignored && part.text.length > 0)
        .map((part) => part.text)
        .join("\n");
    } catch (error) {
      this.log(`Could not read messages for session ${sessionId}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  public async abortSession(sessionId: string): Promise<void> {
    try {
      const client = this.getClient();
      await client.session.abort({ path: { id: sessionId } });
      this.log(`Aborted OpenCode session ${sessionId}.`);
    } catch (error) {
      this.log(`Could not abort session ${sessionId}: ${errorMessage(error)}`);
      throw new Error(`Could not abort the OpenCode session: ${errorMessage(error)}`);
    }
  }

  /**
   * Resolves a model id like "glm-5.1" or "anthropic/claude-x" to the
   * { providerID, modelID } shape the API expects. Returns undefined when the
   * model cannot be found so the server falls back to its default model.
   */
  public async resolveModel(modelId: string): Promise<ResolvedModel | undefined> {
    if (!modelId.trim()) {
      return undefined;
    }
    if (this.modelCache.has(modelId)) {
      return this.modelCache.get(modelId);
    }

    const resolved = await this.lookupModel(modelId);
    this.modelCache.set(modelId, resolved);
    if (!resolved) {
      this.log(`Model "${modelId}" was not found on the server; using the default model instead.`);
    }
    return resolved;
  }

  private async lookupModel(modelId: string): Promise<ResolvedModel | undefined> {
    try {
      const client = this.getClient();
      const providers = unwrapData(await client.provider.list());
      for (const provider of providers.all) {
        if (provider.models[modelId]) {
          return { providerID: provider.id, modelID: modelId };
        }
      }
    } catch (error) {
      this.log(`Could not list providers for model resolution: ${errorMessage(error)}`);
    }

    const slashIndex = modelId.indexOf("/");
    if (slashIndex > 0 && slashIndex < modelId.length - 1) {
      return {
        providerID: modelId.slice(0, slashIndex),
        modelID: modelId.slice(slashIndex + 1)
      };
    }
    return undefined;
  }

  /**
   * Returns the ids of the agents available on the server (e.g. "plan").
   */
  public async getAgentIds(): Promise<string[]> {
    if (this.agentIdCache) {
      return [...this.agentIdCache];
    }
    try {
      const client = this.getClient();
      const agents = unwrapData(await client.app.agents());
      this.agentIdCache = new Set(agents.map((agent) => agent.name));
    } catch (error) {
      this.log(`Could not list agents: ${errorMessage(error)}`);
      this.agentIdCache = new Set();
    }
    return [...this.agentIdCache];
  }

  private getClient(): OpencodeClient {
    if (!this.client) {
      throw new Error("The OpenCode server is not ready yet.");
    }
    return this.client;
  }

  private stopChild(): void {
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
    }
    this.child = undefined;
  }

  /**
   * Stops the spawned server process. Called when the extension deactivates.
   */
  public dispose(): void {
    this.disposed = true;
    this.stopChild();
    this.client = undefined;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const candidate = error as Error & { data?: { message?: string } };
    return candidate.data?.message || candidate.message;
  }
  return String(error);
}

function unwrapData<T>(result: { data?: T | undefined; error?: unknown }): T {
  if (result.data === undefined) {
    const candidate = result.error as { name?: string; data?: { message?: string } } | undefined;
    throw new Error(candidate?.data?.message || candidate?.name || "The OpenCode server returned no data.");
  }
  return result.data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
