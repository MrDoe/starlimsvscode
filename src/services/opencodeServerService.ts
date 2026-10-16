"use strict";

import { spawn, type ChildProcess } from "child_process";

export type OpenCodeServerServiceOptions = {
  hostname: string;
  port: number;
  command: string;
  commandArgs: string[];
  workingDirectory: string;
  username?: string;
  password?: string;
  /**
   * Git identity applied to the spawned server process via the
   * GIT_AUTHOR_* and GIT_COMMITTER_* environment variables. Every git command
   * the OpenCode agent runs in its shell inherits them, so commits made during
   * OpenCode sessions are attributed to a bot user instead of the machine's
   * own git identity. Applies only to servers this service spawns.
   */
  gitIdentity?: { name: string; email: string };
  /**
   * Called with the password the spawned server generated (the
   * "server password <token>" stdout line) so the caller can persist it.
   * Persisting lets later extension windows authenticate against a still
   * running server and reuse it instead of starting a second one.
   */
  onGeneratedPassword?: (password: string) => void | Promise<void>;
  log?: (message: string) => void;
};

const DEFAULT_SERVER_USERNAME = "opencode";
const SERVER_START_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_CAPTURED_SERVER_OUTPUT_LINES = 200;
const MESSAGE_PAGE_LIMIT = 50;
const SERVER_PASSWORD_LINE = /^server password (\S+)$/;

type ResolvedModel = {
  providerID: string;
  modelID: string;
};

type ServerProbe = "ready" | "locked" | "incompatible" | "absent";

/** Model.Ref for the v2 API: { id, providerID } where id is the model id. */
type V2ModelRef = {
  id: string;
  providerID: string;
};

type V2ModelInfo = {
  id: string;
  modelID?: string;
  providerID: string;
};

type V2MessagePart = {
  type: string;
  text?: string;
};

type V2Message = {
  id: string;
  type: string;
  time: { created: number };
  content?: V2MessagePart[];
};

/**
 * Client for the OpenCode v2 server API (`opencode serve`).
 *
 * The extension spawns `opencode serve` on demand or reuses a server that is
 * already running on the configured hostname/port. All ticket sessions are
 * created and driven through the v2 HttpApi (`/api/session/...` and friends)
 * with plain fetch and HTTP basic auth.
 *
 * Auth: if STARLIMS provides a password it is passed to the spawned server via
 * OPENCODE_SERVER_PASSWORD; otherwise OpenCode v2 generates a random password
 * and prints it on startup ("server password <token>"), which is captured from
 * the child process output and handed to the caller via onGeneratedPassword so
 * it can be persisted - a later window that knows the password reuses the
 * still-running server instead of starting a second one. A server running with
 * a password we do not know cannot be reused and is reported as "locked".
 *
 * The server is only started when it is actually needed: ensureServer()
 * reuses any reachable server, and a server that died since it was marked
 * ready is detected (spawned child exit, connection-level fetch failures) so
 * the next ensureServer() re-probes and starts a fresh one.
 *
 * Prompt delivery is asynchronous: POST /api/session/{id}/prompt queues the
 * message into the session inbox and the session becomes "running" while it
 * drains. Completion is detected by polling GET /api/session/active plus the
 * `idle` marker message that OpenCode appends after each drain (messages are
 * returned newest-first).
 *
 * Requires OpenCode v2; the OpenCode 1.x server API is not supported.
 */
export class OpenCodeServerService {
  private readonly options: OpenCodeServerServiceOptions;
  private child: ChildProcess | undefined;
  private ensurePromise: Promise<void> | undefined;
  private ready = false;
  private generatedPassword: string | undefined;
  private serverPid: number | undefined;
  private modelCache: Map<string, ResolvedModel | undefined> = new Map();
  private agentIdCache: Set<string> | undefined;
  private promptedAtBySession: Map<string, number> = new Map();
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
   * Makes sure an OpenCode v2 server is reachable on the configured port.
   * Reuses an already running server, otherwise spawns `opencode serve` in the
   * configured working directory and waits until it answers /api/info.
   */
  public async ensureServer(): Promise<void> {
    if (this.child && this.child.exitCode !== null) {
      this.log("The previously spawned OpenCode server process has exited; it will be replaced.");
      this.child = undefined;
      this.serverPid = undefined;
      this.ready = false;
      this.generatedPassword = undefined;
    }
    if (this.ready) {
      return;
    }
    if (this.ensurePromise) {
      return this.ensurePromise;
    }

    this.ensurePromise = (async () => {
      const probe = await this.probeServer();
      if (probe === "ready") {
        this.log(`OpenCode server already running at ${this.serverUrl}.`);
        this.ready = true;
        return;
      }
      if (probe === "locked") {
        throw new Error(
          `An OpenCode server is already running at ${this.serverUrl} but is password-protected with a password this extension does not know. ` +
            "Set the same password with the command \"STARLIMS: Set OpenCode server password\", or stop that server so the extension can start its own."
        );
      }
      if (probe === "incompatible") {
        throw new Error(
          `The server at ${this.serverUrl} does not expose the OpenCode v2 API (GET /api/info). ` +
            "OpenCode 1.x is not supported - upgrade OpenCode to v2 and restart the server on this port."
        );
      }
      await this.startServer();
    })().finally(() => {
      this.ensurePromise = undefined;
    });

    return this.ensurePromise;
  }

  private get effectivePassword(): string | undefined {
    return this.options.password || this.generatedPassword;
  }

  private authHeaders(): Record<string, string> {
    const password = this.effectivePassword;
    if (!password) {
      return {};
    }
    const credentials = Buffer.from(
      `${this.options.username || DEFAULT_SERVER_USERNAME}:${password}`
    ).toString("base64");
    return { Authorization: `Basic ${credentials}` };
  }

  /**
   * fetch against the configured server; a connection-level failure means a
   * server we believed was running is gone, so the ready flag is cleared and
   * the next ensureServer() re-probes and only then starts a new server.
   */
  private async fetchServer(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (this.ready) {
        this.log("Lost the connection to the OpenCode server; it will be restarted when needed.");
        this.ready = false;
      }
      throw error;
    }
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchServer(`${this.serverUrl}${path}`, {
      method,
      headers: {
        ...this.authHeaders(),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: string; error?: { message?: string } };
        detail = parsed?.message || parsed?.error?.message || detail;
      } catch {
        /* keep raw excerpt */
      }
      throw new Error(`OpenCode API ${method} ${path} failed with HTTP ${response.status}: ${detail}`);
    }

    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  /**
   * Classifies the server reachable on the configured port by calling
   * GET /api/info: 200 => ready, 401/403 => locked (foreign password),
   * other HTTP answers => not an OpenCode v2 API, network error => absent.
   */
  private async probeServer(): Promise<ServerProbe> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      const response = await this.fetchServer(`${this.serverUrl}/api/info`, {
        headers: this.authHeaders(),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (response.ok) {
        try {
          const info = (await response.json()) as { pid?: number };
          if (typeof info.pid === "number") {
            this.serverPid = info.pid;
          }
        } catch {
          /* pid is optional */
        }
        return "ready";
      }
      if (response.status === 401 || response.status === 403) {
        return "locked";
      }
      return "incompatible";
    } catch {
      return "absent";
    }
  }

  private async startServer(): Promise<void> {
    const args = [
      ...this.options.commandArgs,
      "serve",
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
    if (this.options.gitIdentity?.name && this.options.gitIdentity.email) {
      env.GIT_AUTHOR_NAME = this.options.gitIdentity.name;
      env.GIT_AUTHOR_EMAIL = this.options.gitIdentity.email;
      env.GIT_COMMITTER_NAME = this.options.gitIdentity.name;
      env.GIT_COMMITTER_EMAIL = this.options.gitIdentity.email;
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
        const match = SERVER_PASSWORD_LINE.exec(line);
        if (match && !this.options.password && !this.generatedPassword) {
          this.generatedPassword = match[1];
          this.log("[OpenCode server] captured generated server password for authentication.");
          // Let the caller persist it so other windows can reuse this server.
          void Promise.resolve(this.options.onGeneratedPassword?.(match[1])).catch((error: unknown) => {
            this.log(`Could not persist the generated OpenCode server password: ${errorMessage(error)}`);
          });
        }
        this.log(`[OpenCode server] ${match ? "server password ***" : line}`);
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
      // Without a configured password the server prints its generated one;
      // requests cannot authenticate until it has been captured.
      if ((this.options.password || this.generatedPassword) && (await this.probeServer()) === "ready") {
        this.log(`OpenCode server is ready at ${this.serverUrl}.`);
        this.ready = true;
        return;
      }
      await sleep(500);
    }

    const exitCode = await Promise.race([exitPromise, Promise.resolve(undefined)]);
    if (exitCode !== undefined || child.exitCode !== null) {
      const serverOutput = this.capturedServerOutput.map((line) => (SERVER_PASSWORD_LINE.test(line) ? "server password ***" : line)).join("\n");
      const outputSuffix = serverOutput ? `\nServer output:\n${serverOutput}` : "";
      throw new Error(`OpenCode server exited with code ${exitCode ?? child.exitCode} before becoming ready.${outputSuffix}`);
    }

    this.stopChild();
    throw new Error(`Timed out waiting for the OpenCode server to become ready at ${this.serverUrl}.`);
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new Error("The OpenCode server is not ready yet.");
    }
  }

  /**
   * Creates a new session on the server and returns its id. The plan agent and
   * model can be bound at creation time in the v2 API.
   */
  public async createSession(
    title: string,
    options?: { agent?: string; model?: string }
  ): Promise<string> {
    this.assertReady();
    const model = options?.model ? await this.resolveModel(options.model) : undefined;
    const response = await this.requestJson<{ data: { id: string } }>("POST", "/api/session", {
      title,
      ...(options?.agent ? { agent: options.agent } : {}),
      ...(model ? { model: { id: model.modelID, providerID: model.providerID } as V2ModelRef } : {})
    });
    const sessionId = response?.data?.id;
    if (!sessionId) {
      throw new Error("The OpenCode server did not return a session id.");
    }
    return sessionId;
  }

  /**
   * Sends a prompt to a session. The v2 server queues the message in the
   * session inbox and starts draining it asynchronously.
   */
  public async sendMessage(
    sessionId: string,
    text: string,
    options?: { model?: string }
  ): Promise<void> {
    this.assertReady();

    if (options?.model) {
      const model = await this.resolveModel(options.model);
      if (model) {
        await this.requestJson<void>("POST", `/api/session/${sessionId}/model`, {
          model: { id: model.modelID, providerID: model.providerID } as V2ModelRef
        });
      }
    }

    const response = await this.requestJson<{ data?: { time?: { created?: number } } }>(
      "POST",
      `/api/session/${sessionId}/prompt`,
      { text, delivery: "steer" }
    );
    const created = response?.data?.time?.created;
    if (created !== undefined) {
      this.promptedAtBySession.set(sessionId, created);
    } else {
      this.promptedAtBySession.delete(sessionId);
    }
  }

  private async getActiveSessionIds(): Promise<Set<string>> {
    const response = await this.requestJson<{ data?: Record<string, { type: string }> }>("GET", "/api/session/active");
    return new Set(Object.keys(response?.data ?? {}));
  }

  /**
   * Waits until the agent run for a session finished: the session is gone from
   * GET /api/session/active after having been running, or an `idle` marker
   * message newer than the last prompt shows up as the newest message. Also
   * stops on timeout or cancellation.
   */
  public async waitUntilIdle(
    sessionId: string,
    options?: { intervalMs?: number; timeoutMs?: number; isCancelled?: () => boolean }
  ): Promise<void> {
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const baseline = this.promptedAtBySession.get(sessionId);
    const startedAt = Date.now();
    let sawRunning = false;
    let idleWithoutMarker = 0;

    while (true) {
      if (this.disposed || options?.isCancelled?.()) {
        return;
      }
      if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
        this.log(`Stopped waiting for session ${sessionId} after ${timeoutMs}ms.`);
        return;
      }

      try {
        const running = (await this.getActiveSessionIds()).has(sessionId);
        if (running) {
          sawRunning = true;
          idleWithoutMarker = 0;
        } else {
          const newest = await this.getNewestMessage(sessionId);
          if (
            newest?.type === "idle" &&
            (baseline === undefined || (newest.time?.created ?? 0) >= baseline)
          ) {
            return;
          }
          if (sawRunning) {
            idleWithoutMarker += 1;
            if (idleWithoutMarker >= 2) {
              return;
            }
          }
        }
      } catch (error) {
        this.log(`Session poll failed for ${sessionId}: ${errorMessage(error)}`);
        idleWithoutMarker = 0;
        if (!this.ready) {
          // The server connection is gone - waiting would spin until the
          // timeout, and a restarted server would not have this session.
          this.log(`Stopped waiting for session ${sessionId} because the OpenCode server went away.`);
          return;
        }
      }

      await sleep(intervalMs);
    }
  }

  private async getNewestMessage(sessionId: string): Promise<V2Message | undefined> {
    const response = await this.requestJson<{ data?: V2Message[] }>(
      "GET",
      `/api/session/${sessionId}/message?limit=1`
    );
    return response?.data?.[0];
  }

  /**
   * Returns the text of the last assistant message in a session, which is the
   * plan or result produced by the agent run.
   */
  public async getLastAssistantText(sessionId: string): Promise<string | undefined> {
    this.assertReady();
    try {
      const response = await this.requestJson<{ data?: V2Message[] }>(
        "GET",
        `/api/session/${sessionId}/message?limit=${MESSAGE_PAGE_LIMIT}`
      );
      const lastAssistant = (response?.data ?? []).find((message) => message.type === "assistant");
      if (!lastAssistant) {
        return undefined;
      }
      return (lastAssistant.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0)
        .map((part) => part.text as string)
        .join("\n");
    } catch (error) {
      this.log(`Could not read messages for session ${sessionId}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  public async abortSession(sessionId: string): Promise<void> {
    this.assertReady();
    try {
      await this.requestJson<{ interrupted?: boolean }>("POST", `/api/session/${sessionId}/interrupt`);
      this.log(`Aborted OpenCode session ${sessionId}.`);
    } catch (error) {
      this.log(`Could not abort session ${sessionId}: ${errorMessage(error)}`);
      throw new Error(`Could not abort the OpenCode session: ${errorMessage(error)}`);
    }
  }

  /**
   * Resolves a model id like "qwen3.8-flash-next" or "anthropic/claude-x" to the
   * { providerID, modelID } shape the v2 API expects. Returns undefined when
   * the model cannot be found so the server falls back to its default model.
   */
  public async resolveModel(modelId: string): Promise<ResolvedModel | undefined> {
    const query = modelId.trim();
    if (!query) {
      return undefined;
    }
    if (this.modelCache.has(query)) {
      return this.modelCache.get(query);
    }

    const resolved = await this.lookupModel(query);
    this.modelCache.set(query, resolved);
    if (!resolved) {
      this.log(`Model "${query}" was not found on the server; using the default model instead.`);
    }
    return resolved;
  }

  private async lookupModel(modelId: string): Promise<ResolvedModel | undefined> {
    try {
      const response = await this.requestJson<{ data?: V2ModelInfo[] }>("GET", "/api/model");
      for (const model of response?.data ?? []) {
        const fullId = `${model.providerID}/${model.id}`;
        if (
          model.id === modelId ||
          (model.modelID !== undefined && model.modelID === modelId) ||
          fullId === modelId
        ) {
          // Model.Ref.id is the Model.Info.id (modelID can be a backend path).
          return { providerID: model.providerID, modelID: model.id };
        }
      }
    } catch (error) {
      this.log(`Could not list models for model resolution: ${errorMessage(error)}`);
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
    this.assertReady();
    if (this.agentIdCache) {
      return [...this.agentIdCache];
    }
    try {
      const response = await this.requestJson<{ data?: Array<{ id: string }> }>("GET", "/api/agent");
      this.agentIdCache = new Set((response?.data ?? []).map((agent) => agent.id));
    } catch (error) {
      this.log(`Could not list agents: ${errorMessage(error)}`);
      this.agentIdCache = new Set();
    }
    return [...this.agentIdCache];
  }

  private stopChild(): void {
    if (this.child) {
      // On Windows the child is a cmd wrapper (shell: true); killing it would
      // orphan the actual opencode server. Kill the reported server process
      // tree instead when the pid is known.
      if (process.platform === "win32" && this.serverPid && this.child.exitCode === null) {
        try {
          spawn("taskkill", ["/F", "/T", "/PID", String(this.serverPid)], { windowsHide: true });
        } catch (error) {
          this.log(`taskkill for OpenCode server pid ${this.serverPid} failed: ${errorMessage(error)}`);
        }
      }
      if (this.child.exitCode === null) {
        this.child.kill();
      }
    }
    this.child = undefined;
    this.serverPid = undefined;
  }

  /**
   * Stops the spawned server process. Called when the extension deactivates.
   */
  public dispose(): void {
    this.disposed = true;
    this.stopChild();
    this.ready = false;
    this.generatedPassword = undefined;
    this.promptedAtBySession.clear();
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
