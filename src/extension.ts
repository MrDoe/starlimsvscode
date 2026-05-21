"use strict";
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { execFile as execFileCallback } from "child_process";
import * as fs from "fs";
import { EnterpriseFileDecorationProvider } from "./providers/enterpriseFileDecorationProvider";
import { EnterpriseItemType, EnterpriseTreeDataProvider, TreeEnterpriseItem } from "./providers/enterpriseTreeDataProvider";
import { EnterpriseService } from "./services/enterpriseService";
import { ExpressServer } from "./services/expressServer";
import { StarlimsAutomationService } from "./services/starlimsAutomationService";
import { StarlimsMcpServer } from "./services/starlimsMcpServer";
import { EnterpriseTextDocumentContentProvider } from "./providers/enterpriseTextContentProvider";
import path = require("path");
import { ResourcesDataViewPanel } from "./panels/ResourcesDataViewPanel";
import { GenericDataViewPanel } from "./panels/GenericDataViewPanel";
import { TableDesignerPanel } from "./panels/TableDesignerPanel";
import { cleanUrl, executeWithProgress } from "./utilities/miscUtils";
import { CheckedOutTreeDataProvider } from "./providers/checkedOutTreeDataProvider";
import { TicketTreeItem, TicketsTreeDataProvider } from "./providers/ticketsTreeDataProvider";
import { ServerSelectorWebviewProvider, ServerConfig } from "./providers/serverSelectorWebviewProvider";
import { GitService } from "./services/gitService";
import { TicketFullInfo, TicketMeasureDraft, TicketOverview, TicketReference, TicketStatusGroupName } from "./services/ticketManagementTypes";
import { TicketStackTraceContentProvider } from "./providers/ticketStackTraceContentProvider";
import * as crypto from 'crypto';
import { promisify } from "util";

const { version } = require('../package.json');
const SLVSCODE_FOLDER = "SLVSCODE";
const DEFERRED_STARLIMS_INIT_MS = 250;
const MAX_CHECKIN_ITEMS_FOR_CONTEXT = 5;
const MAX_CHECKIN_DIFF_LINES = 40;
const MAX_CHECKIN_DIFF_CHARACTERS = 4000;
const MAX_CHECKIN_FILE_EXCERPT_LINES = 20;
const MAX_CHECKIN_FILE_EXCERPT_CHARACTERS = 2000;
const DEFAULT_COMMIT_MESSAGE_TIMEOUT_MS = 4000;
const DEFAULT_COMMIT_MESSAGE_MAX_LENGTH = 200;
const ACTIVE_TICKET_STATE_PREFIX = "ticketManagement.activeTicket";
const TICKET_TITLE_FILTER_CONTEXT_KEY = "starlims.ticketTitleFilterActive";
const TICKET_STACKTRACE_SCHEME = "starlims-ticket-stacktrace";
const MAX_TICKET_REFERENCE_TITLE_LENGTH = 80;
const MAX_TICKET_MEASURE_TITLE_LENGTH = 120;
const DEFAULT_COPILOT_COMMIT_MESSAGE_SYSTEM_PROMPT = [
  "You write STARLIMS check-in and git commit messages.",
  "Return plain text only.",
  "Use exactly one sentence.",
  "Mention the main item or items and the intent of the change.",
  "Do not use bullets, quotes, markdown, or prefixes."
].join("\n");
const DEFAULT_COPILOT_TICKET_MEASURE_SYSTEM_PROMPT = [
  "You write STARLIMS ticket measures for completed development work.",
  "Return valid JSON only.",
  "Use the exact schema {\"title\":\"...\",\"description\":\"...\"}.",
  "The title must be short and actionable.",
  "The description must summarize the implemented changes in plain language.",
  "Include the current date and time in the description.",
  "List each changed file with its name and a brief one-line summary of what changed.",
  "Include relevant diff snippets (truncated if needed) for each changed file.",
  "Use a clear structure: date/time header, then a section per changed file with its diff.",
  "Do not use markdown or code fences."
].join("\n");
const DEFAULT_SLVSCODE_COPILOT_INSTRUCTIONS = [
  "# SLVSCODE - Copilot Instructions",
  "",
  "## What This Workspace Is",
  "This workspace contains STARLIMS application code, synchronized scripts, forms, data sources, SQL assets, and other Enterprise Designer content.",
  "",
  "Treat the local files in this workspace as working copies of STARLIMS items, not as the authoritative source when STARLIMS MCP tools can verify the remote item.",
  "",
  "## Prefer STARLIMS MCP Tools",
  "",
  "When the task is about STARLIMS application behavior, item lookup, remote metadata, or authoritative code content, prefer STARLIMS MCP tools before generic workspace search.",
  "",
  "Prefer STARLIMS MCP when the user asks to:",
  "- find STARLIMS items by name or partial name",
  "- search STARLIMS code across scripts, forms, data sources, or server items",
  "- browse the STARLIMS folder tree",
  "- inspect the authoritative code for a STARLIMS item",
  "- check out a STARLIMS item so the local workspace is synced before editing",
  "- execute a STARLIMS server script or data source to verify behavior",
  "- manage table items through checkout, add, and edit flows when the STARLIMS server supports them",
  "",
  "Use the local workspace first only when:",
  "- the task is explicitly about already-synced local files",
  "- the user asks for a local refactor across checked-out files",
  "- MCP is unavailable or does not return enough information",
  "",
  "## Decision Rule",
  "",
  "- If the user is asking where a STARLIMS item lives, use STARLIMS search or browse tools first.",
  "- If the user is asking what a STARLIMS item currently contains, read it through STARLIMS MCP first.",
  "- If the user wants to edit a STARLIMS item, check it out through STARLIMS MCP before editing the synced local file when possible.",
  "- Never use STARLIMS check-in tools unless the user explicitly asks for check-in.",
  "- If both local code and remote STARLIMS state matter, verify remote state first and then edit locally.",
  "",
  "## Preferred Workflow",
  "",
  "1. Locate the item with STARLIMS search or tree browsing.",
  "2. Read the item code through STARLIMS MCP to confirm the current authoritative version.",
  "3. Check out the item through STARLIMS MCP when edits are needed.",
  "   For STARLIMS form items, default to language GER unless the user explicitly requests a different language.",
  "4. Edit the synced local file in this workspace.",
  "5. Leave STARLIMS check-in to the user unless they explicitly ask you to perform it.",
  "6. Use local search as a secondary source for cross-file impact analysis after the item has been identified.",
  "",
  "## Working Style",
  "",
  "Do not guess STARLIMS item names, locations, or code contents when STARLIMS MCP can verify them.",
  "Never use STARLIMS check-in tools on your own; stop after local edits unless the user explicitly asks for check-in.",
  "Use the STARLIMS execute tools only when runtime verification is necessary, and describe the expected side effects before executing remote code.",
  "If you need to run extension integration tests through MCP, ask the user for permission first and wait for approval before starting `npm test`.",
  "",
  "When a STARLIMS-specific path is appropriate, prefer the `STARLIMS` subagent or STARLIMS MCP tools over generic workspace exploration.",
  "",
  "Use Windows-compatible commands and paths in any terminal guidance.",
  "Never use Linux or Bash commands in guidance, scripts, or examples for this workspace.",
  ""
].join("\n");
const execFile = promisify(execFileCallback);

type CommitMessageDetailLevel = "short" | "standard" | "detailed";

type CommitMessageOptions = {
  generatorMode: "fast" | "copilot";
  detailLevel: CommitMessageDetailLevel;
  maxLength: number;
  prefix: string;
  includeItemType: boolean;
  includeLanguage: boolean;
  includeFileName: boolean;
  timeoutMs: number;
  modelName?: string;
  systemPrompt: string;
};

type OpenCodeLaunchOptions = {
  command: string;
  commandArgs: string[];
  planModel: string;
  buildModel: string;
  workingDirectory: string;
};

/**
 * Ensures that the SLVSCODE folder is opened as a workspace folder
 * @param slvscodePath Path to the SLVSCODE folder
 */
async function ensureSLVSCODEWorkspace(slvscodePath: string): Promise<void> {
  const fs = require('fs');

  // Create SLVSCODE folder if it doesn't exist
  if (!fs.existsSync(slvscodePath)) {
    fs.mkdirSync(slvscodePath, { recursive: true });
  }

  // Check if SLVSCODE folder is already in workspace
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const isSlvscodeOpen = workspaceFolders?.some(folder =>
    folder.uri.fsPath === slvscodePath
  );

  // If SLVSCODE folder is not in workspace, add it
  if (!isSlvscodeOpen) {
    const folderUri = vscode.Uri.file(slvscodePath);

    // If no workspace folders exist, open the SLVSCODE folder
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.workspace.updateWorkspaceFolders(0, 0, { uri: folderUri, name: "SLVSCODE" });
    } else {
      // Add SLVSCODE folder to existing workspace
      vscode.workspace.updateWorkspaceFolders(
        workspaceFolders.length,
        0,
        { uri: folderUri, name: "SLVSCODE" }
      );
    }
  }
}

function shouldManageStarlimsMcpServer(serverConfig: unknown): boolean {
  if (!serverConfig || typeof serverConfig !== "object" || Array.isArray(serverConfig)) {
    return true;
  }

  const candidate = serverConfig as { type?: unknown; url?: unknown };
  if (candidate.type !== "http" || typeof candidate.url !== "string") {
    return false;
  }

  try {
    const parsedUrl = new URL(candidate.url);
    return (parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost") && parsedUrl.pathname === "/mcp";
  } catch {
    return candidate.url === "http://127.0.0.1:3001/mcp";
  }
}

function ensureSLVSCODEMcpConfig(slvscodePath: string, mcpPort: number): void {
  const vscodeFolderPath = path.join(slvscodePath, ".vscode");
  const mcpConfigPath = path.join(vscodeFolderPath, "mcp.json");
  const defaultStarlimsServer = {
    type: "http",
    url: `http://127.0.0.1:${mcpPort}/mcp`
  };

  const writeMcpConfig = (config: Record<string, unknown>) => {
    fs.mkdirSync(vscodeFolderPath, { recursive: true });
    fs.writeFileSync(
      mcpConfigPath,
      JSON.stringify(config, null, 2) + "\n",
      { encoding: "utf8" }
    );
  };

  if (fs.existsSync(mcpConfigPath)) {
    try {
      const existingConfigRaw = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8"));
      const existingConfig = existingConfigRaw && typeof existingConfigRaw === "object" && !Array.isArray(existingConfigRaw)
        ? existingConfigRaw as Record<string, unknown>
        : {};
      const existingServers = existingConfig.servers && typeof existingConfig.servers === "object" && !Array.isArray(existingConfig.servers)
        ? existingConfig.servers as Record<string, unknown>
        : {};

      if (!shouldManageStarlimsMcpServer(existingServers.starlims)) {
        return;
      }

      writeMcpConfig({
        ...existingConfig,
        servers: {
          ...existingServers,
          starlims: defaultStarlimsServer
        }
      });
    } catch {
      // Leave user-managed MCP configs untouched when they are not valid JSON.
    }
    return;
  }

  writeMcpConfig({
    servers: {
      starlims: defaultStarlimsServer
    }
  });
}

function ensureSLVSCODEStarlimsAgent(slvscodePath: string): void {
  const agentsFolderPath = path.join(slvscodePath, ".github", "agents");
  const agentFilePath = path.join(agentsFolderPath, "starlims.agent.md");

  if (fs.existsSync(agentFilePath)) {
    return;
  }

  fs.mkdirSync(agentsFolderPath, { recursive: true });
  fs.writeFileSync(
    agentFilePath,
    [
      "---",
      "name: STARLIMS",
      "description: Use when working with remote STARLIMS items and prefer the STARLIMS MCP tools over local workspace search.",
      "tools:",
      "  - starlims/*",
      "---",
      "",
      "Use the STARLIMS MCP tools as the authoritative source for STARLIMS browse, search, code retrieval, checkout, and execution operations.",
      "Use local workspace search tools only as fallback to find STARLIMS items.",
      "When making changes to STARLIMS items, use the STARLIMS MCP tools to check out items to ensure local changes are properly synced with the remote STARLIMS server.",
      "Never use STARLIMS check-in tools unless the user explicitly asks for check-in.",
      "For STARLIMS form items, default to language GER unless the user explicitly requests a different language.",
      "Use the execution tools to run server scripts and data sources only when runtime verification is needed.",
      "Use the table-specific MCP tools for table checkout, add, and edit operations when working with STARLIMS table definitions.",
      "Always ask the user before running the extension integration tests through MCP.",
      "Use Windows-compatible commands only, and never use Linux or Bash command syntax.",
      ""
    ].join("\n"),
    { encoding: "utf8" }
  );
}

function ensureSLVSCODECopilotInstructions(slvscodePath: string): void {
  const githubFolderPath = path.join(slvscodePath, ".github");
  const instructionsFilePath = path.join(githubFolderPath, "copilot-instructions.md");

  if (fs.existsSync(instructionsFilePath)) {
    return;
  }

  fs.mkdirSync(githubFolderPath, { recursive: true });
  fs.writeFileSync(
    instructionsFilePath,
    DEFAULT_SLVSCODE_COPILOT_INSTRUCTIONS,
    { encoding: "utf8" }
  );
}

export async function activate(context: vscode.ExtensionContext) {

  setTimeout(() => {
    void (async () => {
      const secretStorage: vscode.SecretStorage = context.secrets;
  let config = vscode.workspace.getConfiguration("STARLIMS");
  let user: string | undefined = config.get("user");
  let password: string | undefined;
  let url: string | undefined = config.get("url");
  let rootPath: string | undefined = config.get("rootPath");
  let activeUser: string = user || "";
  let reloadConfig = false;
  let selectedItem: TreeEnterpriseItem | undefined;
  let activeTicket: TicketReference | undefined;
  let languages: any[] = [];
  let expressServer: ExpressServer | undefined;
  let enterpriseService!: EnterpriseService;
  let enterpriseTreeProvider!: EnterpriseTreeDataProvider;
  let enterpriseTreeView: vscode.TreeView<TreeEnterpriseItem> | undefined;
  let ticketsTreeDataProvider!: TicketsTreeDataProvider;
  let ticketStackTraceContentProvider!: TicketStackTraceContentProvider;
  let ticketsTreeView: vscode.TreeView<TicketTreeItem> | undefined;

  const workspaceKey = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "default";
  const workspaceId = crypto.createHash('sha1').update(workspaceKey).digest('hex');
  const secretKey = `${workspaceId}:userPassword`;
  const configuredServers: ServerConfig[] = config.get("servers", []);
  const selectedServerNameFromConfig = config.get("selectedServer") as string;
  const selectedServerFromConfig = configuredServers.find(s => s.name === selectedServerNameFromConfig);
  const hasConfiguredServers = configuredServers.length > 0;

  // Selected Server section
  if (selectedServerFromConfig) {
    url = selectedServerFromConfig.url || url;
    user = selectedServerFromConfig.user || user;
    activeUser = selectedServerFromConfig.user || activeUser;
  }
  let serverConfig: ServerConfig | undefined = selectedServerFromConfig;

  const serverSelectorProvider = new ServerSelectorWebviewProvider(context.extensionUri, context, () => {
    void (async () => {
      // Callback to update server config in enterprise service and refresh tree when server selection changes
      const selectedServer = serverSelectorProvider.getSelectedServer();
      if (!selectedServer) {
        return;
      }

      serverConfig = selectedServer;
      activeUser = selectedServer.user || activeUser;

      try {
        enterpriseService.updateServerConfig(serverConfig, serverConfig.name);
        await publishFormCallbackPortToScm();
        await loadStoredActiveTicketForCurrentServer();
        if (enterpriseTreeProvider) {
          enterpriseTreeProvider.refresh();
        }
        if (checkedOutTreeDataProvider) {
          await refreshCheckedOutItems(false);
        }
        if (ticketsTreeDataProvider) {
          ticketsTreeDataProvider.refresh();
        }
      } catch (error) {
        console.error('Error switching to server:', error);
        vscode.window.showErrorMessage(`Failed to connect to server: ${serverConfig.name}`);
      }
    })();
  });

  function toDisplayLabel(item: TreeEnterpriseItem): string {
    const label = typeof item.label === "string"
      ? item.label
      : item.label?.label ?? item.uri.split("/").filter(Boolean).pop() ?? "STARLIMS item";

    return label.replace(/\s+\(Checked out by .*$/, "");
  }

  function isFormItemType(itemType: EnterpriseItemType): boolean {
    return itemType === EnterpriseItemType.XFDFormXML ||
      itemType === EnterpriseItemType.XFDFormResources ||
      itemType === EnterpriseItemType.XFDFormCode ||
      itemType === EnterpriseItemType.HTMLFormXML ||
      itemType === EnterpriseItemType.HTMLFormCode ||
      itemType === EnterpriseItemType.HTMLFormGuide ||
      itemType === EnterpriseItemType.HTMLFormResources;
  }

  function isHtmlFormItemType(itemType: EnterpriseItemType): boolean {
    return itemType === EnterpriseItemType.HTMLFormXML ||
      itemType === EnterpriseItemType.HTMLFormCode ||
      itemType === EnterpriseItemType.HTMLFormGuide ||
      itemType === EnterpriseItemType.HTMLFormResources;
  }

  async function ensureLanguageOptionsLoaded(): Promise<void> {
    if (languages.length > 0) {
      return;
    }

    await enterpriseService.getLanguages();
    languages = enterpriseService.languages.map((lang) => ({
      label: lang[0],
      description: lang[1]
    }));
  }

  function resolveDefaultFormLanguage(): string | undefined {
    const latestConfig = vscode.workspace.getConfiguration("STARLIMS");
    const configuredLanguage = (latestConfig.get<string>("defaultFormLanguage", "GER") || "").trim();
    const fallbackLanguage = configuredLanguage || "GER";

    if (languages.length === 0) {
      return fallbackLanguage;
    }

    const matchingLanguage = languages.find((languageOption) => {
      const label = typeof languageOption.label === "string" ? languageOption.label : "";
      const description = typeof languageOption.description === "string" ? languageOption.description : "";
      return label.localeCompare(fallbackLanguage, undefined, { sensitivity: "accent" }) === 0 ||
        description.localeCompare(fallbackLanguage, undefined, { sensitivity: "accent" }) === 0;
    });

    return matchingLanguage?.label || fallbackLanguage;
  }

  async function resolveCheckoutTarget(item: TreeEnterpriseItem | vscode.Uri | { path?: string; fsPath?: string } | undefined): Promise<TreeEnterpriseItem | undefined> {
    if (item instanceof TreeEnterpriseItem) {
      return item;
    }

    let targetPath: string | undefined;
    if (item instanceof vscode.Uri) {
      targetPath = item.fsPath || item.path;
    } else if (item?.fsPath && typeof item.fsPath === "string") {
      targetPath = item.fsPath;
    } else if (item?.path && typeof item.path === "string") {
      targetPath = item.path;
    } else {
      targetPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    }

    if (!targetPath) {
      return undefined;
    }

    return enterpriseTreeProvider.getTreeItemFromPath(targetPath, false);
  }

  async function resolveCheckoutLanguage(item: TreeEnterpriseItem, forceLanguagePrompt: boolean): Promise<string | undefined | null> {
    if (!isFormItemType(item.type)) {
      return undefined;
    }

    if (!forceLanguagePrompt) {
      const defaultLanguage = resolveDefaultFormLanguage();
      if (defaultLanguage) {
        return defaultLanguage;
      }
    }

    await ensureLanguageOptionsLoaded();
    if (languages.length === 0) {
      vscode.window.showErrorMessage("No STARLIMS languages are available for checkout.");
      return null;
    }

    const selection = await vscode.window.showQuickPick(
      languages,
      {
        title: forceLanguagePrompt ? "Check Out in Language" : "Check Out",
        placeHolder: `Select checkout language for ${toDisplayLabel(item)}`,
        ignoreFocusOut: true
      }
    );

    if (!selection) {
      return null;
    }

    return selection.label;
  }

  async function checkOutEnterpriseItem(
    item: TreeEnterpriseItem | vscode.Uri | { path?: string; fsPath?: string } | undefined,
    options?: { forceLanguagePrompt?: boolean; htmlFormsOnly?: boolean }
  ): Promise<void> {
    const targetItem = await resolveCheckoutTarget(item);
    if (!targetItem) {
      return;
    }

    if (options?.htmlFormsOnly && !isHtmlFormItemType(targetItem.type)) {
      vscode.window.showErrorMessage("Check Out in Language is only available for HTML form items.");
      return;
    }

    const language = await resolveCheckoutLanguage(targetItem, options?.forceLanguagePrompt === true);
    if (language === null) {
      return;
    }

    const success = await enterpriseService.checkOutItem(targetItem.uri, language);
    if (!success) {
      return;
    }

    enterpriseTreeProvider.setItemCheckedOutStatus(targetItem, true, language ?? "");
    await vscode.commands.executeCommand("STARLIMS.GetLocal", targetItem);
    await refreshCheckedOutItems(false);
  }

  function truncateText(text: string, maxLength: number): string {
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
  }

  function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getSavedLocalPath(item: TreeEnterpriseItem, language: string | undefined): string | undefined {
    if (!language || !rootPath) {
      return item.filePath && fs.existsSync(item.filePath) ? item.filePath : undefined;
    }

    const serverWorkspacePath = enterpriseService.getServerWorkspacePath(rootPath);
    const localFilePath = enterpriseService.getLocalFilePath(item.uri, serverWorkspacePath, language);

    if (fs.existsSync(localFilePath)) {
      return localFilePath;
    }

    if (item.filePath && fs.existsSync(item.filePath)) {
      return item.filePath;
    }

    return undefined;
  }

  function getEnterpriseItemLanguage(item: TreeEnterpriseItem): string {
    return item.language || item.scriptLanguage || "";
  }

  function findOpenLocalDocument(item: TreeEnterpriseItem, serverWorkspacePath: string): vscode.TextDocument | undefined {
    const candidatePaths = new Set<string>();

    if (item.filePath) {
      candidatePaths.add(normalizePathForComparison(item.filePath));
    }

    const itemLanguage = getEnterpriseItemLanguage(item);
    const savedLocalPath = getSavedLocalPath(item, itemLanguage);
    if (savedLocalPath) {
      candidatePaths.add(normalizePathForComparison(savedLocalPath));
    }

    if (itemLanguage) {
      const expectedLocalPath = enterpriseService.getLocalFilePath(item.uri, serverWorkspacePath, itemLanguage);
      candidatePaths.add(normalizePathForComparison(expectedLocalPath));
    }

    if (candidatePaths.size === 0) {
      return undefined;
    }

    return vscode.workspace.textDocuments.find(
      (document) => !document.isUntitled && candidatePaths.has(normalizePathForComparison(document.uri.fsPath))
    );
  }

  function getCurrentStarlimsUser(): string {
    return enterpriseService.getCurrentUser() || activeUser || user || "";
  }

  function getCurrentStarlimsServerName(): string {
    return enterpriseService.getCurrentServerName() || serverConfig?.name || selectedServerNameFromConfig || "Default";
  }

  function getDefaultOpenCodeWorkingDirectory(): string | undefined {
    const slvscodeWorkspaceFolder = vscode.workspace.workspaceFolders?.find((folder) =>
      folder.name === SLVSCODE_FOLDER || path.basename(folder.uri.fsPath).toLocaleLowerCase() === SLVSCODE_FOLDER.toLocaleLowerCase()
    );

    if (slvscodeWorkspaceFolder) {
      return slvscodeWorkspaceFolder.uri.fsPath;
    }

    if (rootPath) {
      const candidatePath = path.join(rootPath, SLVSCODE_FOLDER);
      if (fs.existsSync(candidatePath)) {
        return candidatePath;
      }
    }

    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  function resolveOpenCodeLaunchOptions(): OpenCodeLaunchOptions | undefined {
    const currentConfig = vscode.workspace.getConfiguration("STARLIMS");
    const command = (currentConfig.get<string>("opencode.command", "opencode") || "").trim();
    const commandArgs = currentConfig.get<string[]>("opencode.commandArgs", []) || [];
    const planModel = (currentConfig.get<string>("opencode.planModel", "glm-5.1") || "").trim();
    const buildModel = (currentConfig.get<string>("opencode.buildModel", "kimi-2.6") || "").trim();
    const configuredWorkingDirectory = (currentConfig.get<string>("opencode.workingDirectory", "") || "").trim();
    const defaultWorkingDirectory = getDefaultOpenCodeWorkingDirectory();
    const workingDirectory = configuredWorkingDirectory
      ? path.isAbsolute(configuredWorkingDirectory)
        ? configuredWorkingDirectory
        : path.resolve(defaultWorkingDirectory || rootPath || process.cwd(), configuredWorkingDirectory)
      : defaultWorkingDirectory;

    if (!command) {
      vscode.window.showErrorMessage("Set STARLIMS.opencode.command before using Solve with OpenCode.");
      return undefined;
    }

    if (path.isAbsolute(command) && !fs.existsSync(command)) {
      vscode.window.showErrorMessage(`The configured OpenCode command does not exist: ${command}`);
      return undefined;
    }

    if (!planModel) {
      vscode.window.showErrorMessage("Set STARLIMS.opencode.planModel before using Solve with OpenCode.");
      return undefined;
    }

    if (!workingDirectory || !fs.existsSync(workingDirectory)) {
      vscode.window.showErrorMessage("Configure a valid STARLIMS.opencode.workingDirectory or open the SLVSCODE workspace before using Solve with OpenCode.");
      return undefined;
    }

    return {
      command,
      commandArgs,
      planModel,
      buildModel,
      workingDirectory
    };
  }

  function toPowerShellSingleQuotedLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  function toPowerShellArrayLiteral(values: string[]): string {
    if (values.length === 0) {
      return "@()";
    }

    return `@(${values.map((value) => toPowerShellSingleQuotedLiteral(value)).join(", ")})`;
  }

  function buildOpenCodeTerminalCommand(promptFilePath: string, options: OpenCodeLaunchOptions): string {
    return [
      `$starlimsPrompt = Get-Content -Raw -Path ${toPowerShellSingleQuotedLiteral(promptFilePath)}`,
      `Set-Location ${toPowerShellSingleQuotedLiteral(options.workingDirectory)}`,
      `$opencodeArgs = ${toPowerShellArrayLiteral(options.commandArgs)}`,
      "$opencodeArgs += '--agent'",
      "$opencodeArgs += 'plan'",
      "$opencodeArgs += '--model'",
      `$opencodeArgs += ${toPowerShellSingleQuotedLiteral(options.planModel)}`,
      "$opencodeArgs += '--prompt'",
      "$opencodeArgs += $starlimsPrompt",
      `& ${toPowerShellSingleQuotedLiteral(options.command)} @opencodeArgs`
    ].join("; ");
  }

  async function writeTicketOpenCodePromptFile(ticket: TicketReference, prompt: string): Promise<string> {
    const promptsDirectory = path.join(context.globalStorageUri.fsPath, "opencode-ticket-prompts");
    await fs.promises.mkdir(promptsDirectory, { recursive: true });

    const promptFilePath = path.join(promptsDirectory, `ticket-${ticket.id}.md`);
    await fs.promises.writeFile(promptFilePath, prompt, { encoding: "utf8" });
    return promptFilePath;
  }

  function getActiveTicketStorageKey(serverName: string = getCurrentStarlimsServerName()): string {
    return `${ACTIVE_TICKET_STATE_PREFIX}.${serverName}`;
  }

  function normalizeTicketReference(ticket: TicketOverview | TicketReference): TicketReference {
    return {
      id: ticket.id,
      title: ticket.title,
      statusName: ticket.statusName,
      typeName: ticket.typeName,
      priorityName: ticket.priorityName,
      assignedTo: ticket.assignedTo,
      serverName: getCurrentStarlimsServerName()
    };
  }

  async function loadStoredActiveTicketForCurrentServer(): Promise<void> {
    activeTicket = context.workspaceState.get<TicketReference>(getActiveTicketStorageKey());
    if (activeTicket) {
      activeTicket = {
        ...activeTicket,
        serverName: getCurrentStarlimsServerName()
      };
    }
  }

  async function persistActiveTicket(ticket: TicketReference | undefined): Promise<void> {
    activeTicket = ticket;
    await context.workspaceState.update(getActiveTicketStorageKey(), ticket);
  }

  async function clearActiveTicketSelection(silent: boolean = false): Promise<void> {
    await persistActiveTicket(undefined);
    if (ticketsTreeDataProvider) {
      ticketsTreeDataProvider.refresh();
    }
    if (!silent) {
      vscode.window.showInformationMessage("Cleared the active STARLIMS ticket selection.");
    }
  }

  function updateTicketTreeFilterUi(): void {
    const filterText = ticketsTreeDataProvider?.getTitleFilterText() || "";
    const hasActiveFilter = filterText.length > 0;

    if (ticketsTreeView) {
      ticketsTreeView.message = hasActiveFilter ? `Title filter: ${filterText}` : undefined;
    }

    void vscode.commands.executeCommand("setContext", TICKET_TITLE_FILTER_CONTEXT_KEY, hasActiveFilter);
  }

  async function expandEnterpriseSearchResults(): Promise<void> {
    if (!enterpriseTreeView) {
      return;
    }

    const rootItems = await enterpriseTreeProvider.getChildren();

    const getDeepestVisibleDescendant = (item: TreeEnterpriseItem): TreeEnterpriseItem => {
      let currentItem = item;
      while (currentItem.children && currentItem.children.length > 0) {
        currentItem = currentItem.children[0];
      }

      return currentItem;
    };

    for (const rootItem of rootItems) {
      const revealTarget = rootItem.collapsibleState === vscode.TreeItemCollapsibleState.None
        ? rootItem
        : getDeepestVisibleDescendant(rootItem);

      await enterpriseTreeView.reveal(revealTarget, {
        select: false,
        focus: false,
        expand: true
      });
    }
  }

  async function focusTicketInTicketsTree(ticketId: number, collapseStatusGroupName?: TicketStatusGroupName): Promise<void> {
    if (!ticketsTreeView || !ticketsTreeDataProvider) {
      return;
    }

    const ticketItem = await ticketsTreeDataProvider.findTicketItem(ticketId);
    if (!ticketItem) {
      return;
    }

    const revealOptions = {
      select: true,
      focus: true,
      expand: 1
    };

    if (!collapseStatusGroupName) {
      await ticketsTreeView.reveal(ticketItem, revealOptions);
      return;
    }

    const groupItem = await ticketsTreeDataProvider.findStatusGroupItem(collapseStatusGroupName);

    try {
      if (groupItem?.children?.length) {
        await ticketsTreeView.reveal(groupItem, {
          select: true,
          focus: true,
          expand: true
        });
        await vscode.commands.executeCommand("list.collapse");
      }
    } catch {
      // Fall back to revealing the ticket even if targeted collapse is unavailable.
    }

    await ticketsTreeView.reveal(ticketItem, revealOptions);
  }

  async function refreshCheckedOutItems(includeAllUsers: boolean = false): Promise<void> {
    const checkedOutItemsXml = await enterpriseService.getCheckedOutItems(includeAllUsers);
    checkedOutTreeDataProvider.updateData(checkedOutItemsXml);

    if (activeTicket) {
      checkedOutTreeDataProvider.setActiveTicket(activeTicket.id, activeTicket.title);
      return;
    }

    checkedOutTreeDataProvider.clearActiveTicket();
  }

  async function releaseTicket(item?: TicketTreeItem | TicketOverview | TicketReference): Promise<void> {
    const selectedTreeItem = ticketsTreeView?.selection?.[0];
    const selectedTicket = item instanceof TicketTreeItem
      ? item.ticket
      : item || selectedTreeItem?.ticket || (activeTicket ? { ...activeTicket } : undefined);

    if (!selectedTicket) {
      vscode.window.showInformationMessage("Select a ticket first.");
      return;
    }

    const ticketToRelease = normalizeTicketReference(selectedTicket);
    const currentStarlimsUser = getCurrentStarlimsUser().trim().toLowerCase();
    const assignedToUser = (selectedTicket.assignedTo || "").trim().toLowerCase();
    if (assignedToUser && assignedToUser !== currentStarlimsUser) {
      vscode.window.showWarningMessage(`Cannot release ticket #${ticketToRelease.id}. It is assigned to ${selectedTicket.assignedTo}.`);
      return;
    }

    const updateResult = await enterpriseService.setTicketOpenResult(ticketToRelease.id);

    if (!updateResult.ok) {
      const fallbackMessage = `Could not release ticket #${ticketToRelease.id}.`;
      const message = updateResult.error ?? fallbackMessage;
      vscode.window.showWarningMessage(message);
      return;
    }

    if (activeTicket?.id === ticketToRelease.id) {
      await clearActiveTicketSelection(true);
    }
    if (ticketsTreeDataProvider) {
      ticketsTreeDataProvider.refresh();
    }
    vscode.window.showInformationMessage(`Released ticket #${ticketToRelease.id} and set it back to Offen.`);
  }

  async function solveTicket(item?: TicketTreeItem | TicketOverview | TicketReference): Promise<void> {
    const selectedTreeItem = ticketsTreeView?.selection?.[0];
    const selectedTicket = item instanceof TicketTreeItem
      ? item.ticket
      : item || selectedTreeItem?.ticket || (activeTicket ? { ...activeTicket } : undefined);

    if (!selectedTicket) {
      vscode.window.showInformationMessage("Select a ticket first.");
      return;
    }

    const ticketToSolve = normalizeTicketReference(selectedTicket);
    let checkedInItems: TreeEnterpriseItem[] = [];

    // Parse checked out items and show a picker with actual item labels instead of raw XML.
    const checkedOutItemsXml = await enterpriseService.getCheckedOutItems(false);
    if (typeof checkedOutItemsXml === "string" && checkedOutItemsXml.length > 0) {
      const checkedOutItemsProvider = new CheckedOutTreeDataProvider(checkedOutItemsXml, enterpriseService);
      const items = checkedOutItemsProvider.getLeafItems();
      const selectedItems = await vscode.window.showQuickPick(
        items.map((checkedOutItem) => ({
          label: typeof checkedOutItem.label === "string" ? checkedOutItem.label : checkedOutItem.uri,
          description: checkedOutItem.uri,
          detail: checkedOutItem.tooltip?.toString(),
          item: checkedOutItem,
          picked: true
        })),
        {
          canPickMany: true,
          title: `Select items to check in with ticket #${ticketToSolve.id}`
        }
      );

      if (selectedItems && selectedItems.length > 0) {
        checkedInItems = selectedItems
          .map((selectedItem) => selectedItem.item as TreeEnterpriseItem | undefined)
          .filter((checkedOutItem): checkedOutItem is TreeEnterpriseItem => !!checkedOutItem);

        const gitAutomationReady = await ensureGitAutomationRepositoryReady();
        const gitFilePaths = gitAutomationReady
          ? Array.from(new Set(
            checkedInItems
              .map((checkedOutItem) => getSavedLocalPath(checkedOutItem, checkedOutItem.language || checkedOutItem.scriptLanguage))
              .filter((filePath): filePath is string => !!filePath && fs.existsSync(filePath))
          ))
          : [];

        let checkinReason =
          (await vscode.window.showInputBox({
            title: `Check in items for ticket #${ticketToSolve.id}`,
            prompt: "Enter check-in reason",
            value: buildAllItemsFallbackReason(checkedInItems, getCommitMessageOptions()),
            ignoreFocusOut: true,
          })) || "Checked in from VSCode";

        checkinReason = ensureTicketReferenceInMessage(checkinReason, ticketToSolve);
        let checkInFailed = false;

        for (const selectedItem of selectedItems) {
          const checkOutItem = selectedItem.item as TreeEnterpriseItem | undefined;
          if (checkOutItem?.uri) {
            const success = await enterpriseService.checkInItem(
              checkOutItem.uri,
              checkinReason,
              checkOutItem.language || checkOutItem.scriptLanguage
            );
            if (!success) {
              checkInFailed = true;
            }
          }
        }

        if (!checkInFailed) {
          const ticketMeasureContext = await buildAllItemsTicketMeasureContext(checkedInItems);
          const measureError = await createTicketMeasureForCheckIn(ticketToSolve, checkinReason, ticketMeasureContext);
          if (measureError) {
            outputChannel.appendLine(`[TicketManagement] ${measureError}`);
            vscode.window.showWarningMessage(`STARLIMS items were checked in, but the ticket measure could not be created: ${measureError}`);
          }

          if (gitAutomationReady) {
            try {
              if (gitFilePaths.length === 0) {
                vscode.window.showWarningMessage("STARLIMS items were checked in, but no local files were found to commit in the SLVSCODE Git repository.");
              }

              for (const gitFilePath of gitFilePaths) {
                await commitAndPushGitFile(checkinReason, gitFilePath);
              }
            } catch (error) {
              vscode.window.showErrorMessage(`STARLIMS items were checked in, but Git commit/push failed: ${getGitErrorMessage(error)}`);
            }
          }
        }
      }
    }

    const updateResult = await enterpriseService.setTicketFertigResult(ticketToSolve.id);

    if (!updateResult.ok) {
      const fallbackMessage = `Could not mark ticket #${ticketToSolve.id} as solved.`;
      const message = updateResult.error ?? fallbackMessage;
      vscode.window.showWarningMessage(message);
      return;
    }

    if (activeTicket?.id === ticketToSolve.id) {
      await clearActiveTicketSelection(true);
      if (checkedOutTreeDataProvider) {
        checkedOutTreeDataProvider.clearActiveTicket();
      }
    }
    if (ticketsTreeDataProvider) {
      ticketsTreeDataProvider.refresh();
    }
    if (checkedOutTreeDataProvider) {
      await refreshCheckedOutItems(false);
    }
    vscode.window.showInformationMessage(`Marked ticket #${ticketToSolve.id} as Fertig (solved).`);
  }

  async function solveTicketWithCopilot(item?: TicketTreeItem | TicketOverview | TicketReference): Promise<void> {
    const selectedTreeItem = ticketsTreeView?.selection?.[0];
    const selectedTicket = item instanceof TicketTreeItem
      ? item.ticket
      : item || selectedTreeItem?.ticket || (activeTicket ? { ...activeTicket } : undefined);

    if (!selectedTicket) {
      vscode.window.showInformationMessage("Select a ticket first.");
      return;
    }

    const ticketToSolve = normalizeTicketReference(selectedTicket);

    try {
      // Gather ticket information
      const ticketInfo = await enterpriseService.getTicketFullInfo(ticketToSolve.id);
      
      if (!ticketInfo) {
        vscode.window.showErrorMessage(`Could not retrieve full information for ticket #${ticketToSolve.id}.`);
        return;
      }

      // Build comprehensive prompt for Copilot
      const prompt = buildTicketCopilotPrompt(ticketToSolve, ticketInfo);

      // Open Copilot chat with the prompt
      await vscode.commands.executeCommand('workbench.action.chat.open', prompt);

      outputChannel.appendLine(`[TicketManagement] Opened Copilot chat for ticket #${ticketToSolve.id}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[TicketManagement] Error opening Copilot chat: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to open Copilot chat: ${errorMessage}`);
    }
  }

  async function solveTicketWithOpenCode(item?: TicketTreeItem | TicketOverview | TicketReference): Promise<void> {
    const selectedTreeItem = ticketsTreeView?.selection?.[0];
    const selectedTicket = item instanceof TicketTreeItem
      ? item.ticket
      : item || selectedTreeItem?.ticket || (activeTicket ? { ...activeTicket } : undefined);

    if (!selectedTicket) {
      vscode.window.showInformationMessage("Select a ticket first.");
      return;
    }

    const ticketToSolve = normalizeTicketReference(selectedTicket);
    const launchOptions = resolveOpenCodeLaunchOptions();
    if (!launchOptions) {
      return;
    }

    try {
      const ticketInfo = await enterpriseService.getTicketFullInfo(ticketToSolve.id);

      if (!ticketInfo) {
        vscode.window.showErrorMessage(`Could not retrieve full information for ticket #${ticketToSolve.id}.`);
        return;
      }

      const prompt = buildTicketOpenCodePrompt(ticketToSolve, ticketInfo, launchOptions);
      const promptFilePath = await writeTicketOpenCodePromptFile(ticketToSolve, prompt);
      const terminal = vscode.window.createTerminal({
        name: `OpenCode Ticket #${ticketToSolve.id}`,
        cwd: launchOptions.workingDirectory
      });

      terminal.show(true);
      terminal.sendText(buildOpenCodeTerminalCommand(promptFilePath, launchOptions), true);

      const buildModelMessage = launchOptions.buildModel
        ? ` Switch to ${launchOptions.buildModel} for implementation after you approve the plan.`
        : "";

      outputChannel.appendLine(`[TicketManagement] Opened OpenCode terminal for ticket #${ticketToSolve.id} using ${launchOptions.planModel}`);
      vscode.window.showInformationMessage(`Opened OpenCode for ticket #${ticketToSolve.id} in plan mode with ${launchOptions.planModel}.${buildModelMessage}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`[TicketManagement] Error opening OpenCode: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to open OpenCode: ${errorMessage}`);
    }
  }

  function buildTicketSolutionPrompt(ticket: TicketReference, ticketInfo: TicketFullInfo): string {
    return `# 🎯 STARLIMS Ticket Solution Request

## 📋 Ticket Details

### Identity
- **Ticket ID**: ${ticket.id}
- **Title**: ${ticket.title || 'N/A'}

### Current Status
- **Status**: ${ticket.statusName || 'N/A'}
- **Type**: ${ticket.typeName || 'N/A'}
- **Priority**: ${ticket.priorityName || 'N/A'}
- **Assigned To**: ${ticket.assignedTo || 'Unassigned'}

### Ticket Information
${ticketInfo.description || 'No description provided'}

### Stack Trace / Error Details
\`\`\`
${ticketInfo.stackTrace || 'No stack trace available'}
\`\`\`

### Comments & Notes
${ticketInfo.comments || 'No comments available'}

---

## 🛠️ Task: Help Solve This Ticket

Please analyze this ticket and provide a solution. When you need to:

### 1. **Search for STARLIMS Items**
- Use the STARLIMS MCP tools to search for scripts, forms, data sources, or server items
- Search by name, pattern, or application

### 2. **Access Item Code** 
- Use STARLIMS MCP to read the authoritative code for any STARLIMS item
- This ensures you're viewing the most current version from STARLIMS Enterprise Designer

### 3. **Make Changes**
- **CRITICAL**: Always use the STARLIMS MCP tool to **check out** items BEFORE editing
- This ensures your local workspace is synchronized with the remote STARLIMS items
- After checking out, edit the synced local file in the workspace
- Follow this workflow:
  1. Search for the item using STARLIMS MCP
  2. Read it through STARLIMS MCP to confirm current state
  3. Check it out using STARLIMS MCP
  4. Edit the local synced file
  5. Stop after the local edit unless the user explicitly asks you to perform check-in

### 4. **STARLIMS MCP Tool Usage**
- The STARLIMS MCP server is available and provides:
  - Search/browse STARLIMS items
  - Read authoritative item code
  - Check out items to workspace
  - Execute server scripts and data sources for runtime verification when needed
  - Run extension integration tests, but only after asking the user for permission
  
**Remember**: Always prefer STARLIMS MCP tools over local workspace search when working with STARLIMS items to ensure you have the correct, checked-out version.
**Do not** use STARLIMS check-in tools unless the user explicitly requests check-in, and never use Linux or Bash commands when suggesting terminal steps.

---

## ✅ Expected Outcome
Please provide:
1. Root cause analysis
2. Detailed solution steps
3. Code changes needed (if applicable)
4. Testing recommendations
5. Any STARLIMS items that need to be modified`;
  }

  function buildTicketCopilotPrompt(ticket: TicketReference, ticketInfo: TicketFullInfo): string {
    return buildTicketSolutionPrompt(ticket, ticketInfo);
  }

  function buildTicketOpenCodePrompt(
    ticket: TicketReference,
    ticketInfo: TicketFullInfo,
    launchOptions: OpenCodeLaunchOptions
  ): string {
    const buildModelLine = launchOptions.buildModel
      ? `After the plan is approved, switch to ${launchOptions.buildModel} for implementation.`
      : "After the plan is approved, switch to your preferred build model for implementation.";

    return [
      `Start this session in plan mode with ${launchOptions.planModel}.`,
      "Focus on understanding the ticket, identifying the relevant STARLIMS items, and producing a concrete implementation plan before editing files.",
      buildModelLine,
      "Stay in the current OpenCode terminal session for the full plan-to-build workflow.",
      "",
      buildTicketSolutionPrompt(ticket, ticketInfo)
    ].join("\n\n");
  }

  function sanitizeTicketDocumentSegment(value: string | undefined, fallback: string): string {
    const normalizedValue = (value || "")
      .trim()
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLocaleLowerCase();

    return normalizedValue || fallback;
  }

  function createTicketStackTraceDocumentUri(ticket: TicketReference): vscode.Uri {
    const safeServerName = sanitizeTicketDocumentSegment(ticket.serverName || getCurrentStarlimsServerName(), "default-server");
    const safeTitle = sanitizeTicketDocumentSegment(ticket.title, `ticket-${ticket.id}`);

    return vscode.Uri.from({
      scheme: TICKET_STACKTRACE_SCHEME,
      path: `/${safeServerName}/ticket-${ticket.id}-${safeTitle}.log`
    });
  }

  function buildTicketStackTraceDocument(ticket: TicketReference, ticketInfo: TicketFullInfo): string {
    const headerLines = [
      `Ticket #${ticket.id}${ticket.title ? ` - ${ticket.title}` : ""}`,
      `Server: ${ticket.serverName || getCurrentStarlimsServerName()}`,
      ticket.statusName ? `Status: ${ticket.statusName}` : undefined,
      ticket.assignedTo ? `Assigned to: ${ticket.assignedTo}` : undefined,
      `Retrieved: ${new Date().toLocaleString()}`
    ].filter((line): line is string => Boolean(line));

    return [
      ...headerLines,
      "",
      "--------------------------------------------------------------------------------",
      "",
      ticketInfo.stackTrace || "No stack trace available for this ticket."
    ].join("\n");
  }

  async function showTicketStackTrace(item?: TicketTreeItem | TicketOverview | TicketReference): Promise<void> {
    const selectedTreeItem = ticketsTreeView?.selection?.[0];
    const selectedTicket = item instanceof TicketTreeItem
      ? item.ticket
      : item || selectedTreeItem?.ticket || (activeTicket ? { ...activeTicket } : undefined);

    if (!selectedTicket) {
      vscode.window.showInformationMessage("Select a ticket first.");
      return;
    }

    const ticketToInspect = normalizeTicketReference(selectedTicket);
    const ticketInfo = await enterpriseService.getTicketFullInfo(ticketToInspect.id);

    if (!ticketInfo) {
      vscode.window.showErrorMessage(`Could not retrieve stacktrace information for ticket #${ticketToInspect.id}.`);
      return;
    }

    const uri = createTicketStackTraceDocumentUri(ticketToInspect);
    ticketStackTraceContentProvider.update(uri, buildTicketStackTraceDocument(ticketToInspect, ticketInfo));

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false
    });

    outputChannel.appendLine(`[TicketManagement] Opened stacktrace viewer for ticket #${ticketToInspect.id}`);
  }

  async function setActiveTicketSelection(ticket: TicketOverview | TicketReference, silent: boolean = false): Promise<void> {
    const normalizedTicket = normalizeTicketReference(ticket);
    await persistActiveTicket(normalizedTicket);
    if (ticketsTreeDataProvider) {
      ticketsTreeDataProvider.refresh();
    }
    if (!silent) {
      vscode.window.showInformationMessage(`Using ticket #${normalizedTicket.id} for STARLIMS check-in and Git commit messages.`);
    }
  }

  async function undertakeTicket(ticket: TicketOverview | TicketReference): Promise<void> {
    const normalizedTicket = normalizeTicketReference(ticket);
    const currentStarlimsUser = getCurrentStarlimsUser();
    const sourceStatusGroupName = "statusGroupName" in ticket ? ticket.statusGroupName : undefined;
    
    // Check if ticket is already being worked on by another user
    if (ticket instanceof Object && 'statusGroupName' in ticket && ticket.statusGroupName === "In Bearbeitung" && 
        ticket.assignedTo && ticket.assignedTo.trim() !== currentStarlimsUser.trim()) {
      vscode.window.showWarningMessage(`Cannot undertake ticket #${normalizedTicket.id}. It is currently being worked on by ${ticket.assignedTo}.`);
      return;
    }

    // If there's already an active ticket and it's different, ask user to confirm
    if (activeTicket && activeTicket.id !== normalizedTicket.id) {
      const confirmSwitch = await vscode.window.showWarningMessage(
        `You already have ticket #${activeTicket.id} active. Switch to ticket #${normalizedTicket.id}?`,
        'Switch', 'Cancel'
      );
      if (confirmSwitch !== 'Switch') {
        return;
      }
    }
    
    const updateResult = await enterpriseService.setTicketInProgressResult(normalizedTicket.id, currentStarlimsUser);

    if (!updateResult.ok) {
      vscode.window.showWarningMessage(updateResult.error ?? `Could not undertake ticket #${normalizedTicket.id}.`);
      return;
    }

    normalizedTicket.statusName = "In Bearbeitung";
    normalizedTicket.assignedTo = currentStarlimsUser;
    await persistActiveTicket(normalizedTicket);
    await setActiveTicketSelection(normalizedTicket, true);
    if (ticketsTreeDataProvider) {
      ticketsTreeDataProvider.refresh();
      await focusTicketInTicketsTree(normalizedTicket.id, sourceStatusGroupName);
    }
    if (checkedOutTreeDataProvider) {
      checkedOutTreeDataProvider.setActiveTicket(normalizedTicket.id, normalizedTicket.title);
      checkedOutTreeDataProvider.refresh();
    }

    vscode.window.showInformationMessage(`Undertook ticket #${normalizedTicket.id} for ${currentStarlimsUser}.`);
  }

  async function renameTicket(ticket: TicketOverview | TicketReference): Promise<void> {
    const normalizedTicket = normalizeTicketReference(ticket);
    
    const newTitle = await vscode.window.showInputBox({
      prompt: "Enter new ticket title",
      value: normalizedTicket.title,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return "Title cannot be empty";
        }
        return null;
      }
    });

    if (!newTitle || newTitle.trim() === normalizedTicket.title) {
      return; // Cancelled or no change
    }

    const updateResult = await enterpriseService.renameTicketResult(normalizedTicket.id, newTitle.trim());

    if (!updateResult.ok) {
      vscode.window.showWarningMessage(updateResult.error ?? `Could not rename ticket #${normalizedTicket.id}.`);
      return;
    }

    // Update the active ticket if it's the one being renamed
    if (activeTicket && activeTicket.id === normalizedTicket.id) {
      const updatedTicket = { ...activeTicket, title: newTitle.trim() };
      await persistActiveTicket(updatedTicket);
    }

    if (ticketsTreeDataProvider) {
      ticketsTreeDataProvider.refresh();
    }

    vscode.window.showInformationMessage(`Renamed ticket #${normalizedTicket.id} to "${newTitle.trim()}".`);
  }

  async function reconcileActiveTicketSelection(tickets: TicketOverview[]): Promise<void> {
    if (!activeTicket) {
      return;
    }

    const matchingTicket = tickets.find((ticket) => ticket.id === activeTicket?.id);
    if (!matchingTicket) {
      const staleTicket = activeTicket;
      await persistActiveTicket(undefined);
      vscode.window.showWarningMessage(`The active STARLIMS ticket #${staleTicket.id} is no longer open or visible and has been cleared.`);
      return;
    }

    const normalizedTicket = normalizeTicketReference(matchingTicket);
    if (
      normalizedTicket.title !== activeTicket.title ||
      normalizedTicket.statusName !== activeTicket.statusName ||
      normalizedTicket.assignedTo !== activeTicket.assignedTo ||
      normalizedTicket.typeName !== activeTicket.typeName ||
      normalizedTicket.priorityName !== activeTicket.priorityName
    ) {
      await persistActiveTicket(normalizedTicket);
    }
  }

  function buildTicketReferencePrefix(ticket: TicketReference | undefined, maxTitleLength: number = MAX_TICKET_REFERENCE_TITLE_LENGTH): string {
    if (!ticket) {
      return "";
    }

    const normalizedTitle = ticket.title.replace(/\s+/g, " ").trim();
    return `[#${ticket.id} ${truncateText(normalizedTitle, maxTitleLength)}]`;
  }

  function stripTicketReferenceFromMessage(message: string, ticket: TicketReference | undefined = activeTicket): string {
    const trimmedMessage = message.trim();
    if (!ticket || trimmedMessage.length === 0) {
      return trimmedMessage;
    }

    const exactPrefix = buildTicketReferencePrefix(ticket);
    const exactPrefixPattern = new RegExp(`^${escapeRegExp(exactPrefix)}\\s*[:\\-]?\\s*`, "i");
    const loosePrefixPattern = new RegExp(`^\\[?\\s*(ticket\\s*)?#${ticket.id}\\b[^\\]]*\\]?\\s*[:\\-]?\\s*`, "i");

    return trimmedMessage.replace(exactPrefixPattern, "").replace(loosePrefixPattern, "").trim();
  }

  function ensureTicketReferenceInMessage(message: string, ticket: TicketReference | undefined = activeTicket): string {
    const normalizedMessage = stripTicketReferenceFromMessage(message, ticket);
    if (!ticket) {
      return normalizedMessage;
    }

    const ticketPrefix = buildTicketReferencePrefix(ticket);
    return `${ticketPrefix} ${normalizedMessage}`.trim();
  }

  function buildActiveTicketContextLines(ticket: TicketReference | undefined = activeTicket): string[] {
    if (!ticket) {
      return [];
    }

    const contextLines = [`Active ticket: #${ticket.id} ${ticket.title}`];

    if (ticket.statusName) {
      contextLines.push(`Ticket status: ${ticket.statusName}`);
    }

    if (ticket.typeName) {
      contextLines.push(`Ticket type: ${ticket.typeName}`);
    }

    if (ticket.priorityName) {
      contextLines.push(`Ticket priority: ${ticket.priorityName}`);
    }

    if (ticket.assignedTo) {
      contextLines.push(`Ticket assigned to: ${ticket.assignedTo}`);
    }

    return contextLines;
  }

  function getCommitMessageGeneratorMode(): "fast" | "copilot" {
    const configuredMode = config.get<string>("git.commitMessageGenerator", "fast");
    return configuredMode === "copilot" ? "copilot" : "fast";
  }

  function getCommitMessageDetailLevel(): CommitMessageDetailLevel {
    const configuredLevel = config.get<string>("git.commitMessageDetailLevel", "standard");
    if (configuredLevel === "short" || configuredLevel === "detailed") {
      return configuredLevel;
    }

    return "standard";
  }

  function getCommitMessageMaxLength(): number {
    const configuredLength = config.get<number>("git.commitMessageMaxLength", DEFAULT_COMMIT_MESSAGE_MAX_LENGTH);
    return configuredLength && configuredLength > 20 ? configuredLength : DEFAULT_COMMIT_MESSAGE_MAX_LENGTH;
  }

  function getCommitMessagePrefix(): string {
    return (config.get<string>("git.commitMessagePrefix", "") || "").trim();
  }

  function getCopilotCommitMessageModelName(): string | undefined {
    const configuredModelName = (config.get<string>("git.copilotCommitMessageModel", "") || "").trim();
    return configuredModelName || undefined;
  }

  function getCopilotCommitMessageSystemPrompt(): string {
    const configuredPrompt = config.get<string>(
      "git.copilotCommitMessageSystemPrompt",
      DEFAULT_COPILOT_COMMIT_MESSAGE_SYSTEM_PROMPT
    );
    const trimmedPrompt = (configuredPrompt || "").trim();
    return trimmedPrompt || DEFAULT_COPILOT_COMMIT_MESSAGE_SYSTEM_PROMPT;
  }

  function getCommitMessageOptions(): CommitMessageOptions {
    return {
      generatorMode: getCommitMessageGeneratorMode(),
      detailLevel: getCommitMessageDetailLevel(),
      maxLength: getCommitMessageMaxLength(),
      prefix: getCommitMessagePrefix(),
      includeItemType: config.get<boolean>("git.includeItemTypeInCommitMessage", true) ?? true,
      includeLanguage: config.get<boolean>("git.includeLanguageInCommitMessage", true) ?? true,
      includeFileName: config.get<boolean>("git.includeFileNameInCommitMessage", false) ?? false,
      timeoutMs: getCopilotCommitMessageTimeoutMs(),
      modelName: getCopilotCommitMessageModelName(),
      systemPrompt: getCopilotCommitMessageSystemPrompt()
    };
  }

  function getCopilotCommitMessageTimeoutMs(): number {
    const configuredTimeout = config.get<number>("git.copilotCommitMessageTimeoutMs", DEFAULT_COMMIT_MESSAGE_TIMEOUT_MS);
    return configuredTimeout && configuredTimeout > 0 ? configuredTimeout : DEFAULT_COMMIT_MESSAGE_TIMEOUT_MS;
  }

  function formatMessageWithPrefix(message: string, options: CommitMessageOptions): string {
    const normalizedMessage = stripTicketReferenceFromMessage(message);
    const maxTicketTitleLength = Math.max(24, Math.min(MAX_TICKET_REFERENCE_TITLE_LENGTH, Math.floor(options.maxLength / 2)));
    const ticketPrefix = buildTicketReferencePrefix(activeTicket, maxTicketTitleLength);
    const prefixes = [ticketPrefix, options.prefix]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    const prefixedMessage = [...prefixes, normalizedMessage]
      .filter((part) => part.trim().length > 0)
      .join(" ");

    return truncateText(prefixedMessage.trim(), options.maxLength);
  }

  function buildItemDescriptor(item: TreeEnterpriseItem, options: CommitMessageOptions): string {
    const parts = [toDisplayLabel(item)];

    if (options.includeItemType) {
      parts.push(item.type);
    }

    const language = item.language || item.scriptLanguage;
    if (options.includeLanguage && language) {
      parts.push(language);
    }

    if (options.includeFileName) {
      const savedLocalPath = getSavedLocalPath(item, language);
      if (savedLocalPath) {
        parts.push(path.basename(savedLocalPath));
      }
    }

    if (options.detailLevel === "short") {
      return toDisplayLabel(item);
    }

    return parts.join(" ");
  }

  function buildSingleItemFallbackReason(item: TreeEnterpriseItem, options: CommitMessageOptions): string {
    const itemDescriptor = buildItemDescriptor(item, options);

    if (options.detailLevel === "detailed") {
      return formatMessageWithPrefix(`Update STARLIMS item ${itemDescriptor} and sync checked-in changes`, options);
    }

    return formatMessageWithPrefix(`Update ${itemDescriptor}`, options);
  }

  function buildAllItemsFallbackReason(items: TreeEnterpriseItem[], options: CommitMessageOptions): string {
    if (items.length === 0) {
      return formatMessageWithPrefix("Check in STARLIMS items", options);
    }

    if (items.length === 1) {
      return buildSingleItemFallbackReason(items[0], options);
    }

    const itemDescriptors = items.slice(0, 3).map((item) => buildItemDescriptor(item, options));
    if (options.detailLevel === "short") {
      return formatMessageWithPrefix(`Update ${items.length} STARLIMS items`, options);
    }

    if (options.detailLevel === "detailed") {
      return formatMessageWithPrefix(
        `Check in ${items.length} STARLIMS items: ${itemDescriptors.join(", ")}`,
        options
      );
    }

    return formatMessageWithPrefix(`Update ${items.length} STARLIMS items: ${itemDescriptors.join(", ")}`, options);
  }

  function truncateLines(text: string, maxLines: number, maxCharacters: number): string {
    const normalizedText = text.replace(/\r\n/g, "\n").trim();
    if (!normalizedText) {
      return "";
    }

    const lines = normalizedText.split("\n");
    const limitedLines = lines.slice(0, maxLines);
    let limitedText = limitedLines.join("\n");

    if (limitedText.length > maxCharacters) {
      limitedText = `${limitedText.slice(0, maxCharacters - 3).trimEnd()}...`;
    } else if (lines.length > maxLines) {
      limitedText = `${limitedText}\n...`;
    }

    return limitedText;
  }

  function summarizeGitStatus(statusOutput: string): string | undefined {
    const firstStatusLine = statusOutput
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .find((line) => line.length > 0);

    if (!firstStatusLine) {
      return undefined;
    }

    if (firstStatusLine.startsWith("??")) {
      return "untracked";
    }

    const statusCodes = new Set(firstStatusLine.slice(0, 2).split("").filter((code) => code !== " "));
    const statusLabels = Array.from(statusCodes).map((code) => {
      switch (code) {
        case "M":
          return "modified";
        case "A":
          return "added";
        case "D":
          return "deleted";
        case "R":
          return "renamed";
        case "C":
          return "copied";
        case "U":
          return "unmerged";
        default:
          return undefined;
      }
    }).filter((label): label is Exclude<typeof label, undefined> => label !== undefined);

    return statusLabels.length > 0 ? statusLabels.join(", ") : undefined;
  }

  function summarizeNumStat(numStatOutput: string): string | undefined {
    const totals = numStatOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .reduce((summary, line) => {
        const [added, removed] = line.split(/\s+/);
        if (added !== "-") {
          const addedCount = Number.parseInt(added, 10);
          if (!Number.isNaN(addedCount)) {
            summary.added += addedCount;
          }
        }

        if (removed !== "-") {
          const removedCount = Number.parseInt(removed, 10);
          if (!Number.isNaN(removedCount)) {
            summary.removed += removedCount;
          }
        }

        return summary;
      }, { added: 0, removed: 0 });

    if (totals.added === 0 && totals.removed === 0) {
      return undefined;
    }

    return `+${totals.added} -${totals.removed}`;
  }

  function buildFileExcerptContext(filePath: string): string | undefined {
    try {
      const fileContent = fs.readFileSync(filePath, "utf8");
      const excerpt = truncateLines(fileContent, MAX_CHECKIN_FILE_EXCERPT_LINES, MAX_CHECKIN_FILE_EXCERPT_CHARACTERS);
      return excerpt || undefined;
    } catch {
      return undefined;
    }
  }

  async function buildGitDiffContext(savedLocalPath: string): Promise<string[]> {
    const repositoryRoot = await getGitRepositoryRoot(savedLocalPath);
    if (!repositoryRoot) {
      const fileExcerpt = buildFileExcerptContext(savedLocalPath);
      return fileExcerpt
        ? [
          "Git repository: not found.",
          "Current file excerpt:",
          fileExcerpt
        ]
        : ["Git repository: not found."];
    }

    const relativePath = toRelativeGitPath(repositoryRoot, savedLocalPath);
    const statusOutput = await runGitCommand(repositoryRoot, ["status", "--porcelain", "--", relativePath]);
    const contextLines = [`Git file: ${relativePath}`];
    const gitStatus = summarizeGitStatus(statusOutput);

    if (gitStatus) {
      contextLines.push(`Git status: ${gitStatus}`);
    }

    if (!statusOutput) {
      contextLines.push("Git diff: no local changes detected.");
      return contextLines;
    }

    if (statusOutput.split(/\r?\n/).some((line) => line.startsWith("??"))) {
      const fileExcerpt = buildFileExcerptContext(savedLocalPath);
      contextLines.push("Git diff: file is untracked.");
      if (fileExcerpt) {
        contextLines.push("Current file excerpt:", fileExcerpt);
      }
      return contextLines;
    }

    const numStatOutput = await runGitCommand(repositoryRoot, ["diff", "--numstat", "--", relativePath]);
    const diffSummary = summarizeNumStat(numStatOutput);
    if (diffSummary) {
      contextLines.push(`Git diff summary: ${diffSummary}`);
    }

    const diffOutput = await runGitCommand(repositoryRoot, ["diff", "--unified=1", "--no-color", "--", relativePath]);
    const truncatedDiff = truncateLines(diffOutput, MAX_CHECKIN_DIFF_LINES, MAX_CHECKIN_DIFF_CHARACTERS);
    if (truncatedDiff) {
      contextLines.push("Git diff:", truncatedDiff);
      return contextLines;
    }

    const fileExcerpt = buildFileExcerptContext(savedLocalPath);
    if (fileExcerpt) {
      contextLines.push("Current file excerpt:", fileExcerpt);
    }

    return contextLines;
  }

  async function buildItemChangeContext(item: TreeEnterpriseItem): Promise<string> {
    const language = item.language || item.scriptLanguage;
    const savedLocalPath = getSavedLocalPath(item, language);
    const contextLines = [
      `Item: ${toDisplayLabel(item)}`,
      `URI: ${item.uri}`,
      `Type: ${item.type}`
    ];

    if (language) {
      contextLines.push(`Language: ${language}`);
    }

    if (savedLocalPath) {
      contextLines.push(`Local file: ${savedLocalPath}`);
      const fileName = path.basename(savedLocalPath);
      contextLines.push(`File name: ${fileName}`);
      try {
        contextLines.push("", ...(await buildGitDiffContext(savedLocalPath)));
      } catch {
        contextLines.push("", "Diff analysis: unavailable, use the item metadata and file path only.");
      }
    } else {
      contextLines.push("Saved local file not found; generate the reason from the item metadata only.");
    }

    return contextLines.join("\n");
  }

  async function getCheckedOutLeafItems(xmlData: string): Promise<TreeEnterpriseItem[]> {
    const treeDataProvider = new CheckedOutTreeDataProvider(xmlData, enterpriseService);
    const roots = (await treeDataProvider.getChildren()) ?? [];
    const itemsToVisit = [...roots];
    const leafItems: TreeEnterpriseItem[] = [];

    while (itemsToVisit.length > 0) {
      const currentItem = itemsToVisit.shift();
      if (!currentItem) {
        continue;
      }

      if (currentItem.children && currentItem.children.length > 0) {
        itemsToVisit.push(...currentItem.children);
        continue;
      }

      leafItems.push(currentItem);
    }

    return leafItems;
  }

  function sanitizeGeneratedReason(text: string, fallbackReason: string, options: CommitMessageOptions): string {
    const cleanedText = text
      .replace(/\r?\n+/g, " ")
      .replace(/^check[ -]?in reason:\s*/i, "")
      .replace(/^reason:\s*/i, "")
      .replace(/^['"`]+|['"`]+$/g, "")
      .trim();

    if (!cleanedText) {
      return fallbackReason;
    }

    return formatMessageWithPrefix(cleanedText, options);
  }

  async function selectCopilotCommitMessageModel(options: CommitMessageOptions): Promise<vscode.LanguageModelChat | undefined> {
    const availableModels = await vscode.lm.selectChatModels({ vendor: "copilot" });

    if (options.modelName) {
      const normalizedConfiguredName = options.modelName.trim().toLocaleLowerCase();
      const matchingModel = availableModels.find((model) => model.name.trim().toLocaleLowerCase() === normalizedConfiguredName);
      if (matchingModel) {
        return matchingModel;
      }
    }

    return availableModels[0];
  }

  function buildCopilotCommitMessagePrompt(changeContext: string, options: CommitMessageOptions): string {
    const instructionLines = [options.systemPrompt.trim()];

    if (activeTicket) {
      instructionLines.push(
        `The active ticket is #${activeTicket.id} ${activeTicket.title}.`,
        "Do not repeat or prepend the ticket reference in the generated sentence because it is added automatically."
      );
    }

    instructionLines.push(
      options.detailLevel === "short"
        ? "Keep it compact and direct."
        : options.detailLevel === "detailed"
          ? "Include concrete details such as item type, language, or filename when helpful."
          : "Use a balanced level of detail."
    );

    instructionLines.push(
      `Keep it under ${Math.max(60, options.maxLength - Math.max(0, options.prefix.length + 1))} characters when possible and never exceed ${options.maxLength} characters after formatting.`,
    );

    const ticketContextLines = buildActiveTicketContextLines();
    const promptSections = [...instructionLines, ""];
    if (ticketContextLines.length > 0) {
      promptSections.push(...ticketContextLines, "");
    }
    promptSections.push(changeContext);

    return promptSections.join("\n");
  }

  async function generateCheckInReasonWithCopilot(
    changeContext: string,
    fallbackReason: string,
    options: CommitMessageOptions
  ): Promise<string> {
    if (options.generatorMode !== "copilot") {
      return fallbackReason;
    }

    try {
      const model = await selectCopilotCommitMessageModel(options);
      if (!model) {
        return fallbackReason;
      }

      const canSendRequest = context.languageModelAccessInformation.canSendRequest(model);
      if (canSendRequest === false) {
        return fallbackReason;
      }

      const messages = [
        vscode.LanguageModelChatMessage.User(buildCopilotCommitMessagePrompt(changeContext, options))
      ];

      const cancellationSource = new vscode.CancellationTokenSource();
      const timeoutHandle = setTimeout(() => cancellationSource.cancel(), options.timeoutMs);
      let generatedText = "";

      try {
        const response = await model.sendRequest(messages, {}, cancellationSource.token);

        for await (const fragment of response.text) {
          generatedText += fragment;
        }
      } finally {
        clearTimeout(timeoutHandle);
        cancellationSource.dispose();
      }

      return sanitizeGeneratedReason(generatedText, fallbackReason, options);
    } catch (error) {
      console.warn("Falling back to default STARLIMS check-in reason.", error);
      return fallbackReason;
    }
  }

  async function buildSingleItemCheckInReason(item: TreeEnterpriseItem): Promise<string> {
    const options = getCommitMessageOptions();
    const fallbackReason = buildSingleItemFallbackReason(item, options);
    const itemContext = await buildItemChangeContext(item);
    const ticketContextLines = buildActiveTicketContextLines();
    const changeContext = ticketContextLines.length > 0
      ? [...ticketContextLines, "", itemContext].join("\n")
      : itemContext;
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        cancellable: false,
        title: "STARLIMS"
      },
      async (progress) => {
        progress.report({ message: "Generating check-in description with Copilot..." });
        return generateCheckInReasonWithCopilot(changeContext, fallbackReason, options);
      }
    );
  }

  async function getCurrentUserCheckedOutLeafItems(): Promise<TreeEnterpriseItem[]> {
    const checkedOutItems = await enterpriseService.getCheckedOutItems(false);
    if (typeof checkedOutItems !== "string" || checkedOutItems.length === 0) {
      return [];
    }

    const allLeafItems = await getCheckedOutLeafItems(checkedOutItems);
    const currentUser = getCurrentStarlimsUser();
    return allLeafItems.filter((item) => item.checkedOutBy === currentUser);
  }

  async function buildAllItemsTicketMeasureContext(userLeafItems?: TreeEnterpriseItem[]): Promise<string> {
    const items = userLeafItems ?? await getCurrentUserCheckedOutLeafItems();
    if (items.length === 0) {
      return "No STARLIMS item-level context is available for this check-in.";
    }

    const itemNames = items.map((item) => toDisplayLabel(item));
    const contextItems = await Promise.all(
      items.slice(0, MAX_CHECKIN_ITEMS_FOR_CONTEXT).map((item) => buildItemChangeContext(item))
    );

    const changeContext = [
      `Checked in ${items.length} STARLIMS items for user ${getCurrentStarlimsUser()}.`,
      `Items: ${itemNames.join(", ")}`,
      "",
      ...contextItems
    ];

    if (items.length > MAX_CHECKIN_ITEMS_FOR_CONTEXT) {
      changeContext.push(
        "",
        `Additional checked out items not expanded here: ${items.slice(MAX_CHECKIN_ITEMS_FOR_CONTEXT).map((item) => toDisplayLabel(item)).join(", ")}`
      );
    }

    return changeContext.join("\n");
  }

  async function buildAllItemsCheckInReason(): Promise<string> {
    const userLeafItems = await getCurrentUserCheckedOutLeafItems();
    if (userLeafItems.length === 0) {
      return "Checked in all items from VSCode";
    }

    const options = getCommitMessageOptions();
    const fallbackReason = buildAllItemsFallbackReason(userLeafItems, options);
    const ticketContextLines = buildActiveTicketContextLines();
    const itemContext = await buildAllItemsTicketMeasureContext(userLeafItems);
    const changeContext = ticketContextLines.length > 0
      ? [...ticketContextLines, "", itemContext].join("\n")
      : itemContext;

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        cancellable: false,
        title: "STARLIMS"
      },
      async (progress) => {
        progress.report({ message: "Generating check-in description with Copilot..." });
        return generateCheckInReasonWithCopilot(changeContext, fallbackReason, options);
      }
    );
  }

  function sanitizeTicketMeasureField(text: string, maxLength: number): string {
    const normalizedText = text
      .replace(/\r?\n+/g, " ")
      .replace(/^['"`]+|['"`]+$/g, "")
      .trim();

    return normalizedText.length > 0 ? truncateText(normalizedText, maxLength) : "";
  }

  function buildTicketMeasureFallback(ticket: TicketReference, checkinReason: string, changeContext?: string): TicketMeasureDraft {
    const normalizedReason = stripTicketReferenceFromMessage(checkinReason, ticket);
    const fallbackTitle = sanitizeTicketMeasureField(
      normalizedReason || `Document changes for ticket #${ticket.id}`,
      MAX_TICKET_MEASURE_TITLE_LENGTH
    );

    const now = new Date();
    const dateTimeLine = `${now.toLocaleDateString("de-DE")} ${now.toLocaleTimeString("de-DE")}`;

    const descriptionParts = [
      `Date/Time: ${dateTimeLine}`,
      "",
      `Check-in message: ${normalizedReason || checkinReason.trim() || "Checked in from VSCode."}`
    ];

    if (changeContext) {
      descriptionParts.push("", changeContext);
    }

    return {
      title: fallbackTitle.length > 0 ? fallbackTitle : `Document changes for ticket #${ticket.id}`,
      description: descriptionParts.join("\n")
    };
  }

  function buildCopilotTicketMeasurePrompt(ticket: TicketReference, checkinReason: string, changeContext: string): string {
    const now = new Date();
    const dateTimeLine = `${now.toLocaleDateString("de-DE")} ${now.toLocaleTimeString("de-DE")}`;

    const sections = [
      DEFAULT_COPILOT_TICKET_MEASURE_SYSTEM_PROMPT,
      "",
      `Current date/time: ${dateTimeLine}`,
      "",
      `Ticket: #${ticket.id} ${ticket.title}`
    ];

    if (ticket.statusName) {
      sections.push(`Ticket status: ${ticket.statusName}`);
    }

    if (ticket.typeName) {
      sections.push(`Ticket type: ${ticket.typeName}`);
    }

    if (ticket.priorityName) {
      sections.push(`Ticket priority: ${ticket.priorityName}`);
    }

    if (ticket.assignedTo) {
      sections.push(`Ticket assigned to: ${ticket.assignedTo}`);
    }

    sections.push(
      "",
      `Approved check-in message: ${stripTicketReferenceFromMessage(checkinReason, ticket) || checkinReason}`,
      "",
      "Change context:",
      changeContext
    );

    return sections.join("\n");
  }

  function parseTicketMeasureResponse(responseText: string, fallback: TicketMeasureDraft): TicketMeasureDraft {
    const normalizedText = responseText
      .replace(/```json/ig, "")
      .replace(/```/g, "")
      .trim();

    if (!normalizedText) {
      return fallback;
    }

    try {
      const parsed = JSON.parse(normalizedText) as Partial<TicketMeasureDraft>;
      const title = sanitizeTicketMeasureField(parsed.title || "", MAX_TICKET_MEASURE_TITLE_LENGTH);
      const description = (parsed.description || "").trim();
      if (!title || !description) {
        return fallback;
      }

      return {
        title,
        description
      };
    } catch {
      return fallback;
    }
  }

  async function generateTicketMeasureWithCopilot(
    ticket: TicketReference,
    checkinReason: string,
    changeContext: string
  ): Promise<TicketMeasureDraft> {
    const options = getCommitMessageOptions();
    const fallbackMeasure = buildTicketMeasureFallback(ticket, checkinReason, changeContext);
    if (options.generatorMode !== "copilot") {
      return fallbackMeasure;
    }

    try {
      const model = await selectCopilotCommitMessageModel(options);
      if (!model) {
        return fallbackMeasure;
      }

      const canSendRequest = context.languageModelAccessInformation.canSendRequest(model);
      if (canSendRequest === false) {
        return fallbackMeasure;
      }

      const messages = [
        vscode.LanguageModelChatMessage.User(buildCopilotTicketMeasurePrompt(ticket, checkinReason, changeContext))
      ];

      const cancellationSource = new vscode.CancellationTokenSource();
      const timeoutHandle = setTimeout(() => cancellationSource.cancel(), options.timeoutMs);
      let generatedText = "";

      try {
        const response = await model.sendRequest(messages, {}, cancellationSource.token);
        for await (const fragment of response.text) {
          generatedText += fragment;
        }
      } finally {
        clearTimeout(timeoutHandle);
        cancellationSource.dispose();
      }

      return parseTicketMeasureResponse(generatedText, fallbackMeasure);
    } catch (error) {
      console.warn("Falling back to default STARLIMS ticket measure text.", error);
      return fallbackMeasure;
    }
  }

  async function createTicketMeasureForCheckIn(
    ticket: TicketReference | undefined,
    checkinReason: string,
    changeContext: string | undefined
  ): Promise<string | undefined> {
    if (!ticket || !changeContext) {
      return undefined;
    }

    const measureDraft = await generateTicketMeasureWithCopilot(ticket, checkinReason, changeContext);
    const result = await enterpriseService.addTicketMeasureResult(ticket.id, measureDraft.title, measureDraft.description);
    if (!result.ok) {
      return result.error ?? `Could not create a ticket measure for ticket #${ticket.id}.`;
    }

    outputChannel.appendLine(`Created STARLIMS ticket measure ${result.data} for ticket #${ticket.id}.`);
    return undefined;
  }

  function normalizePathForComparison(filePath: string): string {
    return process.platform === "win32" ? filePath.toLowerCase() : filePath;
  }

  async function saveOpenDocuments(filePaths: string[]): Promise<void> {
    const normalizedPaths = new Set(filePaths.map((filePath) => normalizePathForComparison(filePath)));

    for (const document of vscode.workspace.textDocuments) {
      if (!document.isDirty || document.isUntitled) {
        continue;
      }

      if (normalizedPaths.has(normalizePathForComparison(document.uri.fsPath))) {
        await document.save();
      }
    }
  }

  async function saveActiveDocumentBeforeCheckIn(targetPath?: string): Promise<void> {
    const activeDocument = vscode.window.activeTextEditor?.document;
    if (!activeDocument || activeDocument.isUntitled || !activeDocument.isDirty) {
      return;
    }

    if (rootPath && !activeDocument.uri.fsPath.toLowerCase().startsWith(rootPath.toLowerCase())) {
      return;
    }

    if (targetPath) {
      const normalizedActivePath = normalizePathForComparison(activeDocument.uri.fsPath);
      const normalizedTargetPath = normalizePathForComparison(targetPath);
      if (normalizedActivePath !== normalizedTargetPath) {
        return;
      }
    }

    await activeDocument.save();
  }

  async function runGitCommand(workingDirectory: string, args: string[]): Promise<string> {
    const result = await execFile("git", ["-C", workingDirectory, ...args], {
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });

    return result.stdout.trim();
  }

  async function getGitRepositoryRoot(filePath: string): Promise<string | undefined> {
    try {
      const workingDirectory = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
      const repositoryRoot = await runGitCommand(workingDirectory, ["rev-parse", "--show-toplevel"]);
      return repositoryRoot || undefined;
    } catch {
      return undefined;
    }
  }

  function toRelativeGitPath(repositoryRoot: string, filePath: string): string {
    return path.relative(repositoryRoot, filePath).replace(/\\/g, "/");
  }

  function getGitErrorMessage(error: unknown): string {
    if (error && typeof error === "object") {
      const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
      const message = "message" in error && typeof error.message === "string" ? error.message.trim() : "";
      return stderr || message || "Unknown Git error";
    }

    return String(error);
  }

  function isGitAutomationEnabled(): boolean {
    return vscode.workspace.getConfiguration("STARLIMS").get<boolean>("git.enabled", false) ?? false;
  }

  async function ensureGitAutomationRepositoryReady(): Promise<boolean> {
    if (!isGitAutomationEnabled()) {
      return false;
    }

    const isGitRepo = await gitService.isGitRepository();
    if (isGitRepo) {
      return true;
    }

    const initResponse = await vscode.window.showWarningMessage(
      "Git repository not initialized in SLVSCODE folder. Would you like to initialize it now?",
      "Yes", "No"
    );

    if (initResponse !== "Yes") {
      vscode.window.showInformationMessage("Continuing without git integration for this check-in.");
      return false;
    }

    return gitService.initializeRepository();
  }

  async function commitAndPushGitFile(reason: string, filePath: string | undefined): Promise<void> {
    if (!isGitAutomationEnabled() || !filePath || !fs.existsSync(filePath)) {
      return;
    }

    await saveOpenDocuments([filePath]);

    const repositoryRoot = await getGitRepositoryRoot(filePath);
    if (!repositoryRoot) {
      vscode.window.showWarningMessage("STARLIMS item was checked in, but no Git repository was found for the local file.");
      return;
    }

    const relativePath = toRelativeGitPath(repositoryRoot, filePath);
    const normalizedRelativePath = normalizePathForComparison(relativePath);
    const autoPush = vscode.workspace.getConfiguration("STARLIMS").get<boolean>("git.autoPush", true) ?? true;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        cancellable: false,
        title: "STARLIMS"
      },
      async (progress) => {
        progress.report({ message: `${autoPush ? "Committing and pushing" : "Committing"} Git changes for ${relativePath}...` });

        const statusOutput = await runGitCommand(repositoryRoot, ["status", "--porcelain", "--", relativePath]);
        if (!statusOutput) {
          return;
        }

        const stagedBeforeAdd = await runGitCommand(repositoryRoot, ["diff", "--cached", "--name-only"]);
        const unrelatedStagedFiles = stagedBeforeAdd
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .filter((line) => normalizePathForComparison(line) !== normalizedRelativePath);

        if (unrelatedStagedFiles.length > 0) {
          vscode.window.showWarningMessage(
            `STARLIMS item was checked in, but Git auto-commit was skipped because ${repositoryRoot} already has unrelated staged changes.`
          );
          return;
        }

        await runGitCommand(repositoryRoot, ["add", "--", relativePath]);

        const stagedAfterAdd = await runGitCommand(repositoryRoot, ["diff", "--cached", "--name-only"]);
        const stagedFiles = stagedAfterAdd
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);

        if (stagedFiles.length === 0) {
          return;
        }

        const unexpectedStagedFiles = stagedFiles.filter(
          (line) => normalizePathForComparison(line) !== normalizedRelativePath
        );

        if (unexpectedStagedFiles.length > 0) {
          vscode.window.showWarningMessage(
            `STARLIMS item was checked in, but Git auto-commit was skipped because staging ${relativePath} would also commit other files.`
          );
          return;
        }

        await runGitCommand(repositoryRoot, ["commit", "-m", reason]);
        if (autoPush) {
          await runGitCommand(repositoryRoot, ["push"]);
        }

        vscode.window.showInformationMessage(
          autoPush
            ? `Committed and pushed Git changes for ${relativePath}.`
            : `Committed Git changes for ${relativePath}.`
        );
      }
    );
  }

  async function getCheckedOutLocalFilePaths(): Promise<string[]> {
    const checkedOutItems = await enterpriseService.getCheckedOutItems(false);
    if (typeof checkedOutItems !== "string" || checkedOutItems.length === 0) {
      return [];
    }

    const currentUser = enterpriseService.getCurrentUser() || activeUser || user || "";
    const allLeafItems = await getCheckedOutLeafItems(checkedOutItems);
    const userLeafItems = allLeafItems.filter((item) => item.checkedOutBy === currentUser);

    return Array.from(new Set(
      userLeafItems
        .map((checkedOutItem) => getSavedLocalPath(checkedOutItem, checkedOutItem.language || checkedOutItem.scriptLanguage))
        .filter((savedPath): savedPath is string => !!savedPath)
    ));
  }

  // register the server selector webview view provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ServerSelectorWebviewProvider.viewType,
      serverSelectorProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  const openServerSelectorView = async () => {
    try {
      await vscode.commands.executeCommand('workbench.view.extension.STARLIMSVSCode');

      const viewCommand = 'workbench.views.openView';
      const supportedCommands = await vscode.commands.getCommands(true);
      if (supportedCommands.includes(viewCommand)) {
        await vscode.commands.executeCommand(viewCommand, 'STARLIMSServerSelector');
        return;
      }
    } catch (error) {
      console.error('Error opening server selector view:', error);
    }
  };

  // ensure STARLIMS URL is defined and prompt for value if not
  if (!url && !hasConfiguredServers) {
    url = await vscode.window.showInputBox({
      title: "Configure STARLIMS",
      placeHolder: "STARLIMS URL (e. g. https://my.starlims.server.com/STARLIMS/)",
      prompt: "Please enter your STARLIMS URL.",
      ignoreFocusOut: true
    });
    if (url) {
      await config.update("url", url, false);
      reloadConfig = true;
    } else {
      vscode.window.showErrorMessage(
        "Please configure the STARLIMS URL in the extension settings."
      );
      return;
    }
  }

  // register the setPassword command
  vscode.commands.registerCommand('STARLIMS.setPassword', async () => {
    const passwordInput: string = await vscode.window.showInputBox({
      title: "Configure STARLIMS (2/4)",
      placeHolder: "STARLIMS Password",
      prompt: `Please enter the password for the STARLIMS User '${user}'.`,
      password: true,
      ignoreFocusOut: true
    }) ?? '';

    await secretStorage.store(secretKey, passwordInput);

    const selectedServerName = (vscode.workspace.getConfiguration("STARLIMS").get("selectedServer") as string) || "";
    if (selectedServerName) {
      const serverSecretKey = `${workspaceId}:${selectedServerName}:userPassword`;
      await secretStorage.store(serverSecretKey, passwordInput);
    }
  });

  // register server configuration commands
  vscode.commands.registerCommand('STARLIMS.configureServer', async () => {
    // This will be handled by the webview provider
    vscode.commands.executeCommand('workbench.view.extension.STARLIMSVSCode');
  });

  vscode.commands.registerCommand('STARLIMS.selectServer', async () => {
    // This will be handled by the webview provider
    vscode.commands.executeCommand('workbench.view.extension.STARLIMSVSCode');
  });

  // ensure Starlims user name is defined and prompt for it if not
  if (!user && !hasConfiguredServers) {
    user = await vscode.window.showInputBox({
      title: "Configure STARLIMS (3/4)",
      placeHolder: "STARLIMS Username",
      prompt: "Please enter your STARLIMS Username.",
      ignoreFocusOut: true
    });
    if (user) {
      await config.update("user", user.toUpperCase(), false);
      reloadConfig = true;
    } else {
      vscode.window.showErrorMessage(
        "Please configure the STARLIMS User in the extension settings."
      );
    }
  }

  if (!hasConfiguredServers) {
    // get password from secret storage
    password = await secretStorage.get(secretKey);

    // prompt for password if not found in secret storage
    if (!password) {
      password = await vscode.commands.executeCommand('STARLIMS.setPassword');
    }
  } else {
    const selectedServerName = (config.get("selectedServer") as string) || "";
    const selectedServerSecretKey = selectedServerName
      ? `${workspaceId}:${selectedServerName}:userPassword`
      : "";
    const selectedServerPassword = selectedServerSecretKey
      ? await secretStorage.get(selectedServerSecretKey)
      : undefined;
    const legacyPassword = await secretStorage.get(secretKey);

    if (!selectedServerPassword && !legacyPassword) {
      await vscode.commands.executeCommand('STARLIMS.setPassword');
    }
  }

  // ensure base path is defined and prompt for value if not
  if (!rootPath) {
    let newRootPath = await vscode.window.showInputBox({
      title: "Configure STARLIMS (4/4)",
      placeHolder: "STARLIMS VS Code Root Path (e. g. C:\\STARLIMS\\VSCode)",
      prompt: "Please enter a root path for the STARLIMS VS Code extension.",
      ignoreFocusOut: true
    });
    if (newRootPath) {
      await config.update("rootPath", newRootPath, false);
      reloadConfig = true;
    } else {
      vscode.window.showErrorMessage(
        "Please configure the STARLIMS VS Code Root Path in the extension settings."
      );
      return;
    }
  }

  // create root path for the extension
  rootPath = path.join(config.get("rootPath") as string, SLVSCODE_FOLDER);

  // initialize git service for SLVSCODE folder
  const gitService = new GitService(rootPath);

  // Ensure SLVSCODE folder is opened as workspace
  await ensureSLVSCODEWorkspace(rootPath);

  // reload configuration if it was updated
  if (reloadConfig) {
    config = vscode.workspace.getConfiguration("STARLIMS");
  }

  // create enterprise service
  enterpriseService = new EnterpriseService(config, secretStorage, context.workspaceState);

  // Initialize server name for path structure
  const selectedServerName = config.get("selectedServer") as string;
  if (selectedServerName) {
    // Use the selected server name
    const servers: ServerConfig[] = config.get("servers", []);
    const selectedServer = servers.find(s => s.name === selectedServerName);
    if (selectedServer) {
      enterpriseService.updateServerConfig(selectedServer, selectedServer.name);
      activeUser = selectedServer.user || activeUser;
    }
  } else if (url) {
    // For backward compatibility, use URL as default server name
    const defaultServerName = "Default";
    enterpriseService.updateServerConfig({ url, user, urlSuffix: config.get("urlSuffix", "lims") }, defaultServerName);
    activeUser = user || activeUser;
  }

  // create output channel for the extension
  const outputChannel = vscode.window.createOutputChannel("STARLIMS", 'log');

  // create output channel for the log
  const logChannel = vscode.window.createOutputChannel("STARLIMS Log", 'log');

  async function publishFormCallbackPortToScm(): Promise<void> {
    const callbackPort = expressServer?.getPort();
    if (!callbackPort) {
      return;
    }

    const result = await enterpriseService.setFormCallbackPortResult(callbackPort);
    if (!result.ok) {
      outputChannel.appendLine(
        `[FormCallback] Failed to publish callback port ${callbackPort}: ${result.error ?? "Unknown error."}`
      );
      return;
    }

    outputChannel.appendLine(`[FormCallback] Published callback port ${callbackPort} to STARLIMS SCM.`);
  }

  const getMcpConfig = () => vscode.workspace.getConfiguration("STARLIMS");
  ensureSLVSCODEMcpConfig(rootPath, getMcpConfig().get<number>("mcp.port", 3002));
  ensureSLVSCODEStarlimsAgent(rootPath);
  ensureSLVSCODECopilotInstructions(rootPath);
  const automationService = new StarlimsAutomationService(enterpriseService, {
    getDefaultFormLanguage: resolveDefaultFormLanguage,
    getMaxCodeCharacters: () => getMcpConfig().get<number>("mcp.maxCodeCharacters", 20000),
    getMaxItems: () => getMcpConfig().get<number>("mcp.maxItems", 100),
    getWorkspaceRoot: () => rootPath,
    refreshCheckoutTree: async (includeAllUsers: boolean = false) => {
      await refreshCheckedOutItems(includeAllUsers);
    }
  });
  const starlimsMcpServer = new StarlimsMcpServer(automationService, {
    getEnabled: () => getMcpConfig().get<boolean>("mcp.enabled", false),
    getVersion: () => version,
    logError: (message: string, error?: unknown) => {
      outputChannel.appendLine(`[MCP] ${message}`);
      if (error) {
        outputChannel.appendLine(`[MCP] ${error instanceof Error ? error.stack || error.message : String(error)}`);
      }
    },
    logInfo: (message: string) => {
      outputChannel.appendLine(`[MCP] ${message}`);
    },
    requestIntegrationTestPermission: async (reason?: string) => {
      const prompt = reason && reason.trim().length > 0
        ? `Copilot wants to run the STARLIMS VS Code integration tests (npm test).\n\nReason: ${reason.trim()}\n\nAllow this test run?`
        : "Copilot wants to run the STARLIMS VS Code integration tests (npm test).\n\nAllow this test run?";
      const selection = await vscode.window.showWarningMessage(
        prompt,
        { modal: true },
        "Run Tests"
      );

      return {
        granted: selection === "Run Tests",
        reason: selection === "Run Tests"
          ? "The user approved the integration test run."
          : "The user did not approve running the integration tests."
      };
    },
    runIntegrationTests: async () => {
      const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
      const command = `${npmCommand} test`;
      const cwd = context.extensionPath;

      try {
        const result = await execFile(npmCommand, ["test"], {
          cwd,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true
        });

        return {
          ok: true,
          command,
          cwd,
          exitCode: 0,
          stderr: result.stderr.trim(),
          stdout: result.stdout.trim()
        };
      } catch (error) {
        const exitCode = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1;
        const stdout = error && typeof error === "object" && "stdout" in error && typeof (error as { stdout?: unknown }).stdout === "string"
          ? (error as { stdout: string }).stdout.trim()
          : "";
        const stderr = error && typeof error === "object" && "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
          ? (error as { stderr: string }).stderr.trim()
          : (error instanceof Error ? error.message : String(error));

        return {
          ok: false,
          command,
          cwd,
          error: stderr || `Integration tests failed with exit code ${exitCode}.`,
          exitCode,
          stderr,
          stdout
        };
      }
    }
  });
  expressServer = new ExpressServer({
    mcpPort: getMcpConfig().get<number>("mcp.port", 3002),
    mcpServer: starlimsMcpServer,
    opencodeProxyEnabled: getMcpConfig().get<boolean>("opencode.proxy.enabled", false),
    opencodeProxyHost: getMcpConfig().get<string>("opencode.proxy.host", "127.0.0.1"),
    opencodeProxyPort: getMcpConfig().get<number>("opencode.proxy.port", 3000),
    opencodeProxyTargetUrl: getMcpConfig().get<string>("opencode.proxy.targetUrl", "http://localhost:4096"),
    onOpenCodeBehind: async (formId: string, functionName: string) => {
      await vscode.commands.executeCommand("STARLIMS.OpenCodeBehind", formId, functionName);
    }
  });
  context.subscriptions.push(expressServer);
  await expressServer.start();
  await publishFormCallbackPortToScm();

  // install ESlint to SLVSCODE folder if not already installed
  // check for .eslintrc.json file
  const eslintConfigFile = path.join(rootPath!, ".eslintrc.json");
  if (!await enterpriseService.fileExists(eslintConfigFile)) {
    executeWithProgress(async () => {
      // copy .eslintrc and package.json to folder
      const eslintConfig = context.asAbsolutePath("src/client/eslint/.eslintrc.json");
      const packageJson = context.asAbsolutePath("src/client/eslint/package.json");
      var fs = require('fs');
      fs.copyFileSync(eslintConfig, eslintConfigFile);
      fs.copyFileSync(packageJson, path.join(rootPath!, "package.json"));

      // install eslint vscode extension
      await vscode.commands.executeCommand("workbench.extensions.installExtension", "dbaeumer.vscode-eslint");

      // run the shell command "npm install"
      const terminal = vscode.window.createTerminal("STARLIMS");
      terminal.show();
      terminal.sendText("cd " + rootPath!);
      terminal.sendText("npm install");
    }, "Installing ESlint to SLVSCODE folder...");
  }

  // verify API version
  enterpriseService.getVersion()
    .then(async (apiVersion) => {
      if (!apiVersion) {
        vscode.window.showWarningMessage('STARLIMS VS Code API is not reachable. Please check connection info or install API package. See extension README for installation instructions.');
        return;
      }

      if (version !== apiVersion) {
        const sdpPackage = context.asAbsolutePath("dist/SCM_API.sdp");
        executeWithProgress(async () => {
          await enterpriseService.upgradeBackend(sdpPackage);
          const selection = await vscode.window.showInformationMessage(`Backend API upgraded successfully. We recommend that you restart Visual Studio Code.`,
            'Restart', 'Cancel');
          if (selection === "Restart") {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        }, "Upgrading the extension backend API.");
      }
    });

  // register the refreshLogChannel command
  vscode.commands.registerCommand("STARLIMS.RefreshLogChannel",
    async () => {
      // get current user's log
      const logUser = activeUser || user;
      const logUri = "/ServerLogs/" + logUser + ".log";
      var log = await enterpriseService.getEnterpriseItemCode(logUri, undefined);
      if (log) {
        logChannel.clear();
        logChannel.appendLine(log.code);
        logChannel.show(true);
      }
    }
  );

  // register the clearLogChannel command
  vscode.commands.registerCommand("STARLIMS.ClearLogChannel",
    async () => {
      // clear current user's log
      const logUser = activeUser || user;
      let remoteUri = "/ServerLogs/" + logUser;
      await enterpriseService.clearLog(remoteUri);

      // refresh log
      var log = await enterpriseService.getEnterpriseItemCode(remoteUri + ".log", undefined);
      if (log) {
        logChannel.clear();
        logChannel.appendLine(log.code);
        logChannel.show(true);
      }
    }
  );

  // load current user's log
  vscode.commands.executeCommand("STARLIMS.RefreshLogChannel");

  // load system languages from server into config
  await enterpriseService.getLanguages();
  for (let lang of enterpriseService.languages) {
    languages.push({ label: lang[0], description: lang[1] });
  }

  // register a custom tree data provider for the STARLIMS enterprise designer explorer
  enterpriseTreeProvider = new EnterpriseTreeDataProvider(enterpriseService);
  enterpriseTreeView = vscode.window.createTreeView("STARLIMSMainTree", {
    treeDataProvider: enterpriseTreeProvider,
    showCollapseAll: false
  });
  context.subscriptions.push(enterpriseTreeView);

  // register a custom tree data provider for the STARLIMS checked out items
  let checkedOutItems = await enterpriseService.getCheckedOutItems(false);
  const checkedOutTreeDataProvider = new CheckedOutTreeDataProvider(checkedOutItems, enterpriseService);
  vscode.window.registerTreeDataProvider("STARLIMSCheckedOutTree", checkedOutTreeDataProvider);

  // Initialize with the selected server if available
  const selectedServerConfig = serverSelectorProvider.getSelectedServer();
  if (selectedServerConfig) {
    // Update service with selected server on startup
    enterpriseService.updateServerConfig(selectedServerConfig, selectedServerConfig.name);
    activeUser = selectedServerConfig.user || activeUser;
    await publishFormCallbackPortToScm();
  }
  await loadStoredActiveTicketForCurrentServer();
  await refreshCheckedOutItems(false);

  ticketsTreeDataProvider = new TicketsTreeDataProvider({
    getActiveTicket: () => activeTicket,
    getCurrentUser: () => getCurrentStarlimsUser(),
    loadTickets: async () => {
      const ticketsResult = await enterpriseService.getTicketsResult();
      if (!ticketsResult.ok) {
        throw new Error(ticketsResult.error ?? "Could not retrieve tickets.");
      }

      const tickets = ticketsResult.data ?? [];
      await reconcileActiveTicketSelection(tickets);
      return tickets;
    },
    loadTicketDescription: async (ticketId: number, stackTraceId: number | undefined) => {
      return enterpriseService.getTicketDescription(ticketId, stackTraceId);
    }
  });
  ticketsTreeView = vscode.window.createTreeView("STARLIMSTicketsTree", {
    treeDataProvider: ticketsTreeDataProvider,
    showCollapseAll: false
  });
  context.subscriptions.push(ticketsTreeView);
  updateTicketTreeFilterUi();
  serverSelectorProvider.refresh();

  vscode.commands.registerCommand(
    "STARLIMS.RefreshTickets",
    async () => {
      ticketsTreeDataProvider.refresh();
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.FilterTicketsByTitle",
    async () => {
      const filterText = await vscode.window.showInputBox({
        title: "Filter tickets by title",
        prompt: "Show only tickets whose title contains this text.",
        placeHolder: "Leave empty to clear the current filter",
        value: ticketsTreeDataProvider.getTitleFilterText(),
        ignoreFocusOut: true
      });

      if (filterText === undefined) {
        return;
      }

      ticketsTreeDataProvider.setTitleFilter(filterText);
      updateTicketTreeFilterUi();
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.ClearTicketTitleFilter",
    async () => {
      ticketsTreeDataProvider.setTitleFilter("");
      updateTicketTreeFilterUi();
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.UndertakeTicket",
    async (item: TicketTreeItem | TicketOverview | undefined) => {
      const selectedTreeItem = ticketsTreeView?.selection?.[0];
      const ticket = item instanceof TicketTreeItem
        ? item.ticket
        : item || selectedTreeItem?.ticket || (activeTicket ? { ...activeTicket } : undefined);
      if (!ticket) {
        vscode.window.showInformationMessage("Select a ticket first.");
        return;
      }

      await undertakeTicket(ticket);
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.ReleaseTicket",
    async (item: TicketTreeItem | TicketOverview | TicketReference | undefined) => {
      await releaseTicket(item);
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.ViewTicketStackTrace",
    async (item: TicketTreeItem | TicketOverview | TicketReference | undefined) => {
      await showTicketStackTrace(item);
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.SolveTicketWithCopilot",
    async (item: TicketTreeItem | TicketOverview | TicketReference | undefined) => {
      await solveTicketWithCopilot(item);
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.SolveTicketWithOpenCode",
    async (item: TicketTreeItem | TicketOverview | TicketReference | undefined) => {
      await solveTicketWithOpenCode(item);
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.SolveTicket",
    async (item: TicketTreeItem | TicketOverview | TicketReference | undefined) => {
      await solveTicket(item);
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.RenameTicket",
    async (item: TicketTreeItem | TicketOverview | undefined) => {
      const selectedTreeItem = ticketsTreeView?.selection?.[0];
      const ticket = item instanceof TicketTreeItem
        ? item.ticket
        : item || selectedTreeItem?.ticket || (activeTicket ? { ...activeTicket } : undefined);
      if (!ticket) {
        vscode.window.showInformationMessage("Select a ticket first.");
        return;
      }

      await renameTicket(ticket);
    }
  );

  // Backward-compatible alias for previous command id.
  vscode.commands.registerCommand(
    "STARLIMS.ClearActiveTicket",
    async (item: TicketTreeItem | TicketOverview | TicketReference | undefined) => {
      await releaseTicket(item);
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.GetCheckedOutItems",
    async () => {
      await refreshCheckedOutItems(false);
    }
  );

  // register a text content provider to viewing remote code items. it responds to the starlims:/ URI
  const enterpriseTextContentProvider =
    new EnterpriseTextDocumentContentProvider(enterpriseService, enterpriseTreeProvider);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "starlims",
      enterpriseTextContentProvider
    )
  );

  ticketStackTraceContentProvider = new TicketStackTraceContentProvider();
  context.subscriptions.push(ticketStackTraceContentProvider);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      TICKET_STACKTRACE_SCHEME,
      ticketStackTraceContentProvider
    )
  );

  // register the GetAllCheckedOutItems command
  vscode.commands.registerCommand(
    "STARLIMS.GetAllCheckedOutItems",
    async () => {
      await refreshCheckedOutItems(true);
    }
  );

  // register the CheckInAllItems command
  vscode.commands.registerCommand(
    "STARLIMS.CheckInAllItems",
    async () => {
      // ask for confirmation
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to check in all items?`,
        { modal: true },
        "Yes"
      );
      if (confirm !== "Yes") {
        return;
      }

      const gitAutomationReady = await ensureGitAutomationRepositoryReady();
      const gitFilePaths = gitAutomationReady ? await getCheckedOutLocalFilePaths() : [];
      if (gitAutomationReady) {
        await saveOpenDocuments(gitFilePaths);
        await saveActiveDocumentBeforeCheckIn();
      }

      const selectedTicket = activeTicket ? { ...activeTicket } : undefined;
      const ticketMeasureContext = selectedTicket
        ? await buildAllItemsTicketMeasureContext()
        : undefined;

      const enteredCheckinReason = await vscode.window.showInputBox({
        title: "Check in all items",
        prompt: "Enter check in reason:",
        value: await buildAllItemsCheckInReason(),
        ignoreFocusOut: true,
      });

      const checkinReason = selectedTicket
        ? ensureTicketReferenceInMessage(enteredCheckinReason || "Checked in all items from VSCode", selectedTicket)
        : enteredCheckinReason || "Checked in all items from VSCode";

      const checkInSuccess = await enterpriseService.checkInAllItems(checkinReason);
      if (checkInSuccess) {
        const measureError = await createTicketMeasureForCheckIn(
          selectedTicket,
          checkinReason || "Checked in all items from VSCode",
          ticketMeasureContext
        );
        if (measureError) {
          outputChannel.appendLine(`[TicketManagement] ${measureError}`);
          vscode.window.showWarningMessage(`STARLIMS items were checked in, but the ticket measure could not be created: ${measureError}`);
        }
      }

      if (checkInSuccess && gitAutomationReady) {
        try {
          if (gitFilePaths.length === 0) {
            vscode.window.showWarningMessage("STARLIMS items were checked in, but no local files were found to commit in the SLVSCODE Git repository.");
          }

          for (const gitFilePath of gitFilePaths) {
            await commitAndPushGitFile(checkinReason || "Checked in all items from VSCode", gitFilePath);
          }
        } catch (error) {
          vscode.window.showErrorMessage(`STARLIMS items were checked in, but Git commit/push failed: ${getGitErrorMessage(error)}`);
        }
      }
      vscode.commands.executeCommand("STARLIMS.GetCheckedOutItems");
    }
  );

  // register the ExportAllCheckouts command
  vscode.commands.registerCommand(
    "STARLIMS.ExportAllCheckouts",
    async () => {
      // ask for confirmation
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to export all checked out items to an SDP file?`,
        { modal: true },
        "Yes"
      );
      if (confirm !== "Yes") {
        return;
      }

      // execute the export with progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          cancellable: false,
          title: "STARLIMS"
        },
        async (progress) => {
          progress.report({ increment: 0, message: "Exporting checked out items..." });
          const exportedPackage = await enterpriseService.exportAllCheckouts();
          progress.report({ increment: 100, message: "Done." });

          // if export was successful, save the file
          if (exportedPackage) {
            // Show save dialog
            const fileUri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(), exportedPackage.fileName)),
              filters: {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                "SDP Package": ["sdp"]
              },
              saveLabel: "Export"
            });

            if (fileUri) {
              try {
                fs.writeFileSync(fileUri.fsPath, exportedPackage.content);
                vscode.window.showInformationMessage(`Package exported successfully to: ${path.basename(fileUri.fsPath)}`);
              } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to save file: ${error.message}`);
              }
            }
          }
        }
      );
    }
  );

  // register the InitializeGitRepo command
  vscode.commands.registerCommand(
    "STARLIMS.InitializeGitRepo",
    async () => {
      // Check if git is available
      const isAvailable = await gitService.isGitAvailable();
      if (!isAvailable) {
        vscode.window.showErrorMessage("Git is not installed or not available in PATH. Please install Git first.");
        return;
      }

      // Check if already initialized
      const isRepo = await gitService.isGitRepository();
      if (isRepo) {
        vscode.window.showInformationMessage("Git repository is already initialized in SLVSCODE folder.");
        return;
      }

      // Initialize the repository
      const success = await gitService.initializeRepository();
      if (success) {
        // Ask if user wants to configure remote
        const configureRemote = await vscode.window.showInformationMessage(
          "Git repository initialized successfully. Would you like to configure a remote repository?",
          "Yes", "No"
        );
        
        if (configureRemote === "Yes") {
          vscode.commands.executeCommand("STARLIMS.ConfigureGitRemote");
        }
      }
    }
  );

  // register the ConfigureGitRemote command
  vscode.commands.registerCommand(
    "STARLIMS.ConfigureGitRemote",
    async () => {
      // Check if git is available
      const isAvailable = await gitService.isGitAvailable();
      if (!isAvailable) {
        vscode.window.showErrorMessage("Git is not installed or not available in PATH. Please install Git first.");
        return;
      }

      // Check if git repository is initialized
      const isRepo = await gitService.isGitRepository();
      if (!isRepo) {
        const initResponse = await vscode.window.showWarningMessage(
          "Git repository not initialized. Would you like to initialize it now?",
          "Yes", "No"
        );
        if (initResponse === "Yes") {
          await gitService.initializeRepository();
        } else {
          return;
        }
      }

      // Get remote URL from settings or ask user
      const config = vscode.workspace.getConfiguration("STARLIMS");
      let remoteUrl = config.get("git.remoteUrl", "");
      
      if (!remoteUrl) {
        remoteUrl = await vscode.window.showInputBox({
          title: "Configure Git Remote",
          prompt: "Enter the remote repository URL (e.g., https://github.com/user/repo.git)",
          placeHolder: "https://github.com/user/repo.git",
          ignoreFocusOut: true,
        }) || "";
      }

      if (!remoteUrl) {
        vscode.window.showWarningMessage("Remote URL not provided. Git remote not configured.");
        return;
      }

      // Get remote name from settings
      const remoteName = config.get("git.remoteName", "origin");

      // Add the remote
      const success = await gitService.addRemote(remoteName, remoteUrl);
      if (success) {
        vscode.window.showInformationMessage(`Git remote '${remoteName}' configured successfully.`);
        
        // Save the remote URL to settings for future use
        await config.update("git.remoteUrl", remoteUrl, vscode.ConfigurationTarget.Workspace);
      }
    }
  );

  // register a decoration provider for the STARLIMS enterprise tree
  const fileDecorationProvider = new EnterpriseFileDecorationProvider();
  vscode.window.registerFileDecorationProvider(fileDecorationProvider);

  // execute the STARLIMS.Save command when a document is saved
  vscode.workspace.onDidSaveTextDocument(
    async (document: vscode.TextDocument) => {
      // check if the document is in the configured workspace
      if (rootPath && document.uri.fsPath.toLowerCase().startsWith(rootPath.toLowerCase())) {
        vscode.commands.executeCommand("STARLIMS.Save", document.uri);
      }
    }
  );

  // this command activates the extension
  vscode.commands.registerCommand("STARLIMS.Connect", () => { });

  // register the selectEnterpriseItem command
  vscode.commands.registerCommand(
    "STARLIMS.selectEnterpriseItem",
    async (item: TreeEnterpriseItem | any) => {
      // if no item is defined, get the item from the active editor
      if (!(item instanceof TreeEnterpriseItem)) {
        if (item.path !== undefined) {
          item = await enterpriseTreeProvider.getTreeItemFromPath(item.path, false) as TreeEnterpriseItem;
        }
      }

      // set the selected item
      selectedItem = item;

      // open leaf nodes only and exclude dummy items ('no items found')
      if (item.collapsibleState !== vscode.TreeItemCollapsibleState.None ||
        item.type === EnterpriseItemType.EnterpriseCategory) {
        return;
      }

      // open the item
      const handler: Function | undefined = getSelectItemHandler(item);
      if (handler !== undefined) {
        executeWithProgress(async () => {
          await handler(item);
        }, "Retrieving selected item...");
      }
    }
  );

  // register the GetLocal command handler
  vscode.commands.registerCommand(
    "STARLIMS.GetLocal",
    async (item: TreeEnterpriseItem | any) => {
      // get server-specific workspace path
      const serverWorkspacePath = enterpriseService.getServerWorkspacePath(rootPath!);

      let resolvedItem = item as TreeEnterpriseItem | undefined;
      if (!(resolvedItem instanceof TreeEnterpriseItem)) {
        if (item?.path !== undefined) {
          resolvedItem = await enterpriseTreeProvider.getTreeItemFromPath(item.path, false);
        } else if (item?.uri !== undefined) {
          resolvedItem = await enterpriseTreeProvider.getTreeItemByUri(item.uri);
        }
      }

      if (!resolvedItem) {
        return;
      }

      if (resolvedItem.type === EnterpriseItemType.Table) {
        const localFilePath = await enterpriseService.getTableLocalCopy(resolvedItem.uri, serverWorkspacePath);
        if (localFilePath) {
          const uri = vscode.Uri.file(localFilePath);
          await vscode.window.showTextDocument(uri);
        }
        return;
      }

      const openDocument = findOpenLocalDocument(resolvedItem, serverWorkspacePath);
      if (openDocument?.isDirty) {
        resolvedItem.filePath = openDocument.uri.fsPath;
        await vscode.window.showTextDocument(openDocument, { preview: false });
        return;
      }

      // get local copy of the item
      const targetUri = resolvedItem.uri ||
        (item?.path
          ? item.path.slice(0, item.path.lastIndexOf("."))
          : undefined);
      const targetLanguage = getEnterpriseItemLanguage(resolvedItem);
      const localFilePath = await enterpriseService.getLocalCopy(
        targetUri,
        serverWorkspacePath,
        false,
        targetLanguage
      );
      if (localFilePath) {
        resolvedItem.filePath = localFilePath;
        let uri: vscode.Uri = vscode.Uri.file(localFilePath);
        await vscode.window.showTextDocument(uri);
      }
    }
  );

  /**
   * Returns the handler function for the selected enterprise item.
   * @param item the enterprise tree item to handle
   * @returns the handler function for the selected enterprise item
   */
  function getSelectItemHandler(item: TreeEnterpriseItem): Function | undefined {
    const config = new Map([
      [EnterpriseItemType.Table, handleSelectTableItem],
      [EnterpriseItemType.HTMLFormResources, handleSelectResourcesItem],
      [EnterpriseItemType.XFDFormResources, handleSelectResourcesItem]
    ]);

    return config.has(item.type) ? config.get(item.type) : handleSelectCodeItem;
  }

  /**
   * Handles selecting a table item in the enterprise tree.
   * @param item the enterprise tree item to handle
   */
  async function handleSelectTableItem(item: TreeEnterpriseItem) {
    const tableName = item.uri.split("/").pop() || "Table";

    // If checked out, open the full designer; otherwise show read-only definition
    if (await enterpriseService.isCheckedOut(item.uri)) {
      TableDesignerPanel.render(context.extensionUri, enterpriseService, item.uri, tableName);
      return;
    }

    const result = await enterpriseService.getTableDefinition(item.uri);
    if (result) {
      GenericDataViewPanel.render(context.extensionUri, {
        name: tableName,
        data: result,
        title: `Table Definition: ${tableName}`
      });
    }
  }

  /**
   * Handles selecting a resources item in the enterprise tree.
   * @param item the enterprise tree item to handle
   */
  async function handleSelectResourcesItem(item: TreeEnterpriseItem) {
    // get server-specific workspace path
    const serverWorkspacePath = enterpriseService.getServerWorkspacePath(rootPath!);

    // get remote URI
    const remoteUri = enterpriseService.getEnterpriseItemUri(item.uri, serverWorkspacePath);

    // get form resources
    let oParams = await enterpriseService.getFormResources(remoteUri, item.language);

    // render the data view panel
    ResourcesDataViewPanel.render(context.extensionUri, oParams, enterpriseService,
      enterpriseTreeProvider);
  }

  /**
   * Handles selecting a code type enterprise item. Such items are: server scripts, data sources, client scripts, 
   * basically anything that needs to be opened in a code editor.
   * @param item the enterprise tree item to handle
   */
  async function handleSelectCodeItem(item: TreeEnterpriseItem) {
    // get server-specific workspace path
    const serverWorkspacePath = enterpriseService.getServerWorkspacePath(rootPath!);

    // check if the item is already open, switch the tab if it is
    const openDocument = findOpenLocalDocument(item, serverWorkspacePath);

    if (openDocument) {
      item.filePath = openDocument.uri.fsPath;

      if (openDocument.isDirty) {
        await vscode.window.showTextDocument(openDocument, { preview: false });
        highlightGlobalSearchMatches(item, vscode.Uri.file(openDocument.uri.fsPath));
        return;
      }

      // reload document, if it is a log file
      if (openDocument.uri.toString().endsWith(".log")) {
        // get the remote URI
        const remoteUri = enterpriseService.getEnterpriseItemUri(
          item.uri,
          serverWorkspacePath
        );

        // update local copy
        await enterpriseService.getLocalCopy(remoteUri, serverWorkspacePath, false, item.language);

        // show the document
        await vscode.window.showTextDocument(openDocument);

        // scroll to bottom of document
        enterpriseService.scrollToBottom();
      } else {
        // other file types, just show the document
        await vscode.window.showTextDocument(openDocument);
        highlightGlobalSearchMatches(item, vscode.Uri.file(openDocument.uri.fsPath));
      }
    } else {
      // get local copy of the item
      const localFilePath = await enterpriseService.getLocalCopy(
        item.uri,
        serverWorkspacePath,
        false,
        getEnterpriseItemLanguage(item)
      );

      // open the item locally
      if (localFilePath) {
        item.filePath = localFilePath;
        let localUri: vscode.Uri = vscode.Uri.file(localFilePath);
        await vscode.window.showTextDocument(localUri, { preview: false });
        highlightGlobalSearchMatches(item, localUri);

        // scroll to bottom of log files
        if (localUri.toString().endsWith(".log")) {
          enterpriseService.scrollToBottom();
        }
      }
    }
  }

  // register the RunScript command handler
  vscode.commands.registerCommand(
    "STARLIMS.RunScript",
    async (item: TreeEnterpriseItem | any) => {
      // get item from editor if no item is defined (shortcut key pressed)
      if (item === undefined) {
        let editor = vscode.window.activeTextEditor;
        item = editor?.document.uri;
      }

      // commands can originate from the enterprise tree or from an open editor window
      let remoteUri: string = "";
      if (item instanceof TreeEnterpriseItem) {
        remoteUri = item.uri;
      }
      else {
        remoteUri = enterpriseService.getUriFromLocalPath(item.path);
      }

      if (item.checkedOutBy === (activeUser || user)) {
        // document not saved, save it first
        if (vscode.window.activeTextEditor?.document.isDirty) {
          await vscode.commands.executeCommand("STARLIMS.Save", item);
        }
      }

      outputChannel.appendLine(
        `\n${new Date().toLocaleString()} Executing remote script at URI: ${remoteUri}\n`
      );

      // get user log
      const logUser = activeUser || user;
      const logUri = "/ServerLogs/" + logUser + ".log";
      const logBeforeRunData = await enterpriseService.getEnterpriseItemCode(logUri, undefined);
      var logBeforeRun = logBeforeRunData?.code || "";

      executeWithProgress(async () => {
        const result = await enterpriseService.runScript(remoteUri.toString());
        if (result) {
          // append current user log to output channel
          const logAfterRunData = await enterpriseService.getEnterpriseItemCode(logUri, undefined);
          let logAfterRun = logAfterRunData?.code || "";
          let logDiff = logAfterRun.replace(logBeforeRun, "");
          outputChannel.appendLine("### Log output: ###");
          outputChannel.appendLine(logDiff);

          // append script output to output channel
          outputChannel.appendLine("### Script output: ###");
          outputChannel.appendLine(String(result.data));

          outputChannel.show(true);
        }
      }, "Executing script...");
    }
  );

  // register the remote compare command
  vscode.commands.registerCommand(
    "STARLIMS.Compare",
    async (uri: vscode.Uri) => {
      // command executed on the item tree
      let localUri = uri;
      if (!localUri) {
        // if not, compare with the open document
        let editor = vscode.window.activeTextEditor;
        if (editor) {
          localUri = editor.document.uri;
        }
      }

      if (localUri) {
        let remoteUriPath = enterpriseService.getUriFromLocalPath(localUri.path);
        let remoteUri = vscode.Uri.parse(`starlims://${remoteUriPath}`);
        vscode.commands.executeCommand("vscode.diff", remoteUri, localUri);
      } else {
        vscode.window.showErrorMessage(
          "STARLIMS: Working folder not found, open a workspace folder an try again."
        );
      }
    }
  );

  // register the checkout command
  vscode.commands.registerCommand(
    "STARLIMS.CheckOut",
    async (item: TreeEnterpriseItem | vscode.Uri | { path?: string; fsPath?: string } | undefined) => {
      await checkOutEnterpriseItem(item);
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.CheckOutTable",
    async (item: TreeEnterpriseItem | vscode.Uri | { path?: string; fsPath?: string } | undefined) => {
      await checkOutEnterpriseItem(item);
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.CheckOutInLanguage",
    async (item: TreeEnterpriseItem | vscode.Uri | { path?: string; fsPath?: string } | undefined) => {
      await checkOutEnterpriseItem(item, {
        forceLanguagePrompt: true,
        htmlFormsOnly: true
      });
    }
  );

  // register the check in command
  vscode.commands.registerCommand(
    "STARLIMS.Checkin",
    async (item: TreeEnterpriseItem | any) => {
      let gitFilePath: string | undefined;

      if (item instanceof vscode.Uri) {
        gitFilePath = item.fsPath;
      } else if (item?.path && typeof item.path === "string") {
        gitFilePath = item.path;
      } else if (item?.fsPath && typeof item.fsPath === "string") {
        gitFilePath = item.fsPath;
      }

      if (!item) {
        const activeEditorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (activeEditorPath) {
          gitFilePath = activeEditorPath;
          item = await enterpriseTreeProvider.getTreeItemFromPath(activeEditorPath, false);
        }
      }

      if (!(item instanceof TreeEnterpriseItem)) {
        item = await enterpriseTreeProvider.getTreeItemFromPath(gitFilePath || item.path, false);
      }
      if (!item) {
        return;
      }

      gitFilePath = gitFilePath && fs.existsSync(gitFilePath)
        ? gitFilePath
        : getSavedLocalPath(item, item.language || item.scriptLanguage);

      await saveActiveDocumentBeforeCheckIn(gitFilePath);

      const selectedTicket = activeTicket ? { ...activeTicket } : undefined;
      const ticketMeasureContext = selectedTicket
        ? await buildItemChangeContext(item)
        : undefined;

      let checkinReason: string =
        (await vscode.window.showInputBox({
          title: "Check in STARLIMS Enterprise Item",
          prompt: "Enter checkin reason",
          value: await buildSingleItemCheckInReason(item),
          ignoreFocusOut: true,
        })) || "Checked in from VSCode";

      if (selectedTicket) {
        checkinReason = ensureTicketReferenceInMessage(checkinReason, selectedTicket);
      }

      const gitAutomationReady = await ensureGitAutomationRepositoryReady();

      let bSuccess = await enterpriseService.checkInItem(item.uri, checkinReason, item.language);
      if (bSuccess) {
        const measureError = await createTicketMeasureForCheckIn(selectedTicket, checkinReason, ticketMeasureContext);
        if (measureError) {
          outputChannel.appendLine(`[TicketManagement] ${measureError}`);
          vscode.window.showWarningMessage(`STARLIMS item was checked in, but the ticket measure could not be created: ${measureError}`);
        }
      }

      if (bSuccess && gitAutomationReady) {
        try {
          await commitAndPushGitFile(checkinReason, gitFilePath);
        } catch (error) {
          vscode.window.showErrorMessage(`STARLIMS item was checked in, but Git commit/push failed: ${getGitErrorMessage(error)}`);
        }
      }

      if (bSuccess) {
        enterpriseTreeProvider.setItemCheckedOutStatus(item, false, item.language);

        // refresh checked out items
        vscode.commands.executeCommand("STARLIMS.GetCheckedOutItems");
      }
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.CheckInTable",
    async (item: TreeEnterpriseItem | any) => {
      await vscode.commands.executeCommand("STARLIMS.Checkin", item);
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.EditTable",
    async (item: TreeEnterpriseItem | any) => {
      const targetItem = item instanceof TreeEnterpriseItem ? item : selectedItem;
      if (!targetItem || targetItem.type !== EnterpriseItemType.Table) {
        vscode.window.showErrorMessage("Please select a table from the enterprise tree to edit.");
        return;
      }

      // Ensure the table is checked out
      if (!await enterpriseService.isCheckedOut(targetItem.uri)) {
        const checkoutResult = await enterpriseService.checkOutItemResult(targetItem.uri, undefined);
        if (!checkoutResult.ok) {
          vscode.window.showErrorMessage(checkoutResult.error ?? "Could not check out the table for editing.");
          return;
        }
        enterpriseTreeProvider.refresh();
        vscode.commands.executeCommand("STARLIMS.GetCheckedOutItems");
      }

      const tableName = targetItem.uri.split("/").pop() || targetItem.label?.toString() || "Table";
      TableDesignerPanel.render(context.extensionUri, enterpriseService, targetItem.uri, tableName);
    }
  );

  // register the UndoCheckOut command
  vscode.commands.registerCommand(
    "STARLIMS.UndoCheckOut",
    async (item: TreeEnterpriseItem | any) => {
      if (!(item instanceof TreeEnterpriseItem)) {
        item = await enterpriseTreeProvider.getTreeItemFromPath(item.path, false);
      }

      // remove text in brackets from item name to get the real item name
      let sItemName = item.label.toString();
      if (sItemName.indexOf("[") > 0) {
        sItemName = sItemName.substring(0, sItemName.indexOf("[") - 1);
      } else if (sItemName.indexOf('(Checked out')) {
        sItemName = sItemName.substring(0, sItemName.indexOf("(Checked out") - 1);
      }

      // ask for confirmation
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to undo checkout of '${sItemName}' and lose all changes?`,
        { modal: true },
        "Yes"
      );

      if (confirm !== "Yes") {
        return;
      }

      let bSuccess = await enterpriseService.undoCheckOut(item.uri);
      if (bSuccess) {
        enterpriseTreeProvider.setItemCheckedOutStatus(item, false, item.language);

        // refresh checked out items
        vscode.commands.executeCommand("STARLIMS.GetCheckedOutItems");
      }
    }
  );

  // register the refresh command
  vscode.commands.registerCommand(
    "STARLIMS.Refresh",
    async () => {
      enterpriseTreeProvider.refresh();
    }
  );

  // register the showTreeView command
  vscode.commands.registerCommand(
    "STARLIMS.ShowTreeView",
    async () => {
      enterpriseTreeProvider.refresh();
    }
  );

  // register the save file command
  vscode.commands.registerCommand(
    "STARLIMS.Save",
    async () => {
      const editor = vscode.window.activeTextEditor;

      if (editor) {
        let remoteUri = enterpriseService.getUriFromLocalPath(editor.document.uri.path);
        const editorItem = await enterpriseTreeProvider.getTreeItemFromPath(editor.document.uri.fsPath, true);
        if (await enterpriseService.isCheckedOut(remoteUri)) {
          if (editorItem?.type === EnterpriseItemType.Table) {
            enterpriseService.saveTableDefinition(remoteUri, editor.document.getText());
          } else {
            enterpriseService.saveEnterpriseItemCode(remoteUri, editor.document.getText(), "");
          }
        }
      }
    }
  );

  vscode.commands.registerCommand(
    "STARLIMS.AddTable",
    async (item: TreeEnterpriseItem | any) => {
      const targetItem = item instanceof TreeEnterpriseItem ? item : selectedItem;
      const isTableDatabaseNode = !!targetItem && [
        EnterpriseItemType.TableCategory,
        "ENT_TABLES_DATABASE",
        "ENT_TABLES_DICTIONARY"
      ].includes(targetItem.type);

      if (!isTableDatabaseNode) {
        vscode.window.showErrorMessage("Please select a table database node to add the table to.");
        return;
      }

      const tableName = await vscode.window.showInputBox({
        title: "Add STARLIMS Table",
        prompt: "Please enter a name for the new table.",
        placeHolder: "Table name...",
        ignoreFocusOut: true
      });

      if (!tableName) {
        return;
      }

      const normalizedTableName = tableName.trim().toUpperCase();
      const dsn = targetItem.uri.split("/").filter(Boolean).pop() || targetItem.label?.toString() || "DATABASE";
      const addResult = await enterpriseService.addTable(normalizedTableName, dsn);
      if (!addResult) {
        return;
      }

      const tableUri = `/Tables/${dsn}/${normalizedTableName}`;
      await enterpriseService.setCheckedOut(tableUri, null);
      enterpriseTreeProvider.refresh();

      await new Promise(resolve => setTimeout(resolve, 3000));

      const serverWorkspacePath = enterpriseService.getServerWorkspacePath(rootPath!);
      const localFilePath = await enterpriseService.getTableLocalCopy(tableUri, serverWorkspacePath);
      if (localFilePath) {
        const localUri = vscode.Uri.file(localFilePath);
        await vscode.window.showTextDocument(localUri, { preview: false });
      }

      const newItem = await enterpriseTreeProvider.getTreeItemByUri(tableUri);
      if (newItem !== undefined) {
        vscode.commands.executeCommand("STARLIMS.selectEnterpriseItem", newItem);
      }
    }
  );

  // register the clear log command
  vscode.commands.registerCommand("STARLIMS.ClearLog",
    async (uri: vscode.Uri) => {

      // ask for confirmation
      let name = path.parse(uri.path).name;

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to clear the log for ${name}?`,
        { modal: true },
        "Yes"
      );

      if (confirm === "Yes") {
        let remoteUri = enterpriseService.getUriFromLocalPath(uri.path);
        await enterpriseService.clearLog(remoteUri);
      }
    }
  );

  // register the search command
  vscode.commands.registerCommand("STARLIMS.Search",
    async () => {
      // ask for search text
      const itemName = await vscode.window.showInputBox({
        title: "Search for STARLIMS Enterprise Items",
        prompt: "Please enter the name or parts of the name of the item(s) to search for.",
        placeHolder: "Item name...",
        ignoreFocusOut: true
      });
      if (!itemName) {
        return;
      }
      executeWithProgress(async () => {
        await enterpriseTreeProvider.search(itemName, "", false, false);
        await expandEnterpriseSearchResults();
      }, "Searching STARLIMS Enterprise...");
    }
  );

  // register the open form command
  vscode.commands.registerCommand("STARLIMS.OpenForm",
    async (item: TreeEnterpriseItem | any) => {
      // get item from editor if no item is defined (shortcut key pressed)
      if (item === undefined) {
        let editor = vscode.window.activeTextEditor;
        item = editor?.document.uri;
      }

      // get remote path from local path if opened from editor context menu
      let remoteUri;
      if (item.uri === undefined) {
        remoteUri = enterpriseService.getUriFromLocalPath(item.path);
      }
      else {
        remoteUri = item.uri;
      }

      // get the form GUID
      const formGuid = await enterpriseService.getGUID(remoteUri);

      // get the language from the checked out item
      const sLangId = item.language;

      // open form in default browser
      const formUrl = `${cleanUrl(config.url)}/starthtml.lims?FormId=${formGuid}&LangId=${sLangId}&Debug=true`;
      vscode.env.openExternal(vscode.Uri.parse(formUrl));
    }
  );

  // register the edit HTML form command
  vscode.commands.registerCommand("STARLIMS.DesignHTMLForm",
    async (item: TreeEnterpriseItem | any) => {
      // get item from editor if no item is defined (shortcut key pressed)
      if (item === undefined) {
        let editor = vscode.window.activeTextEditor;
        item = editor?.document.uri;
      }

      // get remote path from local path if opened from editor context menu
      let remoteUri;
      if (item.uri === undefined) {
        remoteUri = enterpriseService.getUriFromLocalPath(item.path);
      }
      else {
        remoteUri = item.uri;
      }

      // get the form GUID
      const formGuid = await enterpriseService.getGUID(remoteUri);

      // open form in default browser
      const formUrl = `${cleanUrl(config.url)}/starthtml.lims?FormId=1D09BB79-2D28-4594-8B03-26306F5C8AEC&LangId=ENG&Debug=true&FormArgs=%22${formGuid}%22`;
      vscode.env.openExternal(vscode.Uri.parse(formUrl));
    }
  );

  // register the start debugging command
  vscode.commands.registerCommand("STARLIMS.DebugForm",
    async (item: TreeEnterpriseItem | any) => {
      // get item from editor if no item is defined (shortcut key pressed)
      if (item === undefined) {
        let editor = vscode.window.activeTextEditor;
        item = editor?.document.uri;
      }

      // get remote path from local path if opened from editor context menu
      let remoteUri;
      if (item.uri === undefined) {
        remoteUri = enterpriseService.getUriFromLocalPath(item.path);
      }
      else {
        remoteUri = item.uri;
      }

      // get the form GUID
      const formGuid = await enterpriseService.getGUID(remoteUri);

      // read STARLIMS.browser configuration value (edge or chrome)
      const browserType = config.get("browser") as string;

      // check if vscode debugger is already running
      const debuggerRunning = vscode.debug.activeDebugSession !== undefined;

      // get the language from the checked out item
      const sLangId = item.language;

      var debugConfig;
      if (!debuggerRunning) {
        // launch browser in debug mode
        debugConfig = {
          type: browserType,
          name: "Launch STARLIMS Debugging",
          request: "launch",
          url: `${cleanUrl(config.url)}/starthtml.lims?FormId=${formGuid}&LangId=${sLangId}&Debug=true`,
          webRoot: rootPath,
          userDataDir: path.join(context.globalStorageUri.fsPath, "edge"),
          runtimeArgs: [
            "--remote-debugging-port=9222",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-default-apps",
            "--disable-popup-blocking",
            "--disable-translate",
            "--disable-session-crashed-bubble"
          ]
        };
      }
      else {
        // check if the url is already open in debugger
        const debuggerAttached = vscode.debug.activeDebugSession?.name.includes(`FormId=${formGuid}`);

        // if not, attach new debug session to the browser
        if (!debuggerAttached) {
          debugConfig = {
            type: browserType,
            name: "Attach to STARLIMS Debugging",
            request: "attach",
            url: `${cleanUrl(config.url)}/starthtml.lims?FormId=${formGuid}&LangId=${sLangId}&Debug=true`,
            webRoot: rootPath,
            userDataDir: path.join(context.globalStorageUri.fsPath, "edge"),
            port: 9222
          };
        }
      }

      if (debugConfig) {
        // start new vscode debugger
        await vscode.debug.startDebugging(undefined, debugConfig);
      }

      // get the form script name
      const appName = remoteUri.split("/")[3];
      const fileName = remoteUri.split("/").pop() + ".js";
      const scriptName = `${appName}.${fileName}`;

      // wait until the form script has been loaded
      let formScript = await new Promise<any>(resolve => {
        var counter = 0;
        const interval = setInterval(async () => {
          // get debug protocol source from vscode loaded scripts
          const loadedScripts = await vscode.debug.activeDebugSession?.customRequest("loadedSources");

          // parse the array to find the script
          const script = loadedScripts?.sources.find((script: any) => script.name.includes(scriptName));

          // script found, resolve the promise
          if (script) {
            clearInterval(interval);
            resolve(script);
          }

          // if the script is not loaded after 1 minute, stop the interval and return undefined
          if (counter++ > 59) {
            clearInterval(interval);
            resolve(undefined);
          }
          counter++;
        }, 1000);
      });

      // script not found, abort
      if (!formScript) {
        vscode.window.showErrorMessage(`Could not find script ${scriptName} in the debugger. Are you logged in to STARLIMS?`);
        return;
      }

      // get the form script source reference
      let ref = formScript.sourceReference;

      // get debugger session id
      const sessionId = vscode.debug.activeDebugSession?.id;

      // build uri and open the remote script
      const scriptUri = vscode.Uri.parse(`debug:${cleanUrl(config.url).replace("https://", "").replace("http://", "")}/${scriptName}?session=${sessionId}&ref=${ref}`);
      const scriptDocument = await vscode.workspace.openTextDocument(scriptUri);
      await vscode.window.showTextDocument(scriptDocument);

      // set the editor to read only
      if ((await vscode.commands.getCommands()).includes("workbench.action.files.setActiveEditorReadonlyInSession")) {
        vscode.commands.executeCommand(
          "workbench.action.files.setActiveEditorReadonlyInSession"
        );
      }

      // show the debug console
      vscode.commands.executeCommand("workbench.debug.action.toggleRepl");

      // show the output channel
      //outputChannel.show();
    }
  );

  // register the add item command
  vscode.commands.registerCommand("STARLIMS.Add",
    async () => {
      // check if a folder has been selected
      if (selectedItem === undefined) {
        vscode.window.showErrorMessage("Please select a folder to add the item to.");
        return;
      }

      // get item type from uri
      let aUri = selectedItem.uri.split("/");

      // last part of the uri should be the item type
      let root = aUri[1];
      let categoryName = aUri.length > 2 ? aUri[2] : "N/A";
      let appName = aUri.length > 3 ? aUri[3] : "N/A";
      let selectedItemType = aUri.length > 0 ? aUri[aUri.length - 1] : "N/A";
      let itemType;
      let itemTypeName;
      let itemLanguage;

      // check if the item type is valid
      if (root === "Applications") {
        // add application category
        if (categoryName === "N/A") {
          itemType = "APPCATEGORY";
          itemTypeName = "Application Category";
          itemLanguage = "N/A";
        }
        // add application to category
        else if (appName === "N/A") {
          itemType = "APP";
          itemTypeName = "Application";
          itemLanguage = "N/A";
        }
        // add item to application
        else {
          // check if the selected item is a valid folder
          if (!["XFDForms", "HTMLForms", "ServerScripts", "ClientScripts", "DataSources"].includes(selectedItemType)) {
            vscode.window.showErrorMessage("Cannot add item here! Please select a valid folder to add the item to.");
            return;
          }

          switch (selectedItemType) {
            case "HTMLForms":
              itemType = "HTMLFORMXML";
              itemTypeName = "HTML Form";
              itemLanguage = "XML";
              break;

            case "XFDForms":
              itemType = "XFDFORMXML";
              itemTypeName = "XFD Form";
              itemLanguage = "XML";
              break;

            case "ServerScripts":
              itemType = "APPSS";
              itemTypeName = "App Server Script";
              itemLanguage = "SSL";
              break;

            case "ClientScripts":
              itemType = "APPCS";
              itemTypeName = "App Client Script";
              itemLanguage = "JS";
              break;

            case "DataSources":
              itemType = "APPDS";
              itemTypeName = "App Data Source";

              // ask for data source language
              itemLanguage = await vscode.window.showQuickPick(
                ["SSL", "SQL"],
                {
                  placeHolder: "Select Data Source language",
                  ignoreFocusOut: true
                }
              );
              break;
          }
        }
      }
      // add global script item
      else {
        if (aUri.length > 3) {
          vscode.window.showErrorMessage("Please select a valid folder to add the item to.");
          return;
        }

        appName = "N/A";

        switch (root) {
          case "ServerScripts":
            if (root === selectedItemType) {
              itemType = "SSCAT";
              itemTypeName = "Server Script Category";
              itemLanguage = "N/A";
            }
            else {
              itemType = "SS";
              itemTypeName = "Server Script";
              itemLanguage = "SSL";
            }
            break;

          case "ClientScripts":
            if (root === selectedItemType) {
              itemType = "CSCAT";
              itemTypeName = "Client Script Category";
              itemLanguage = "N/A";
            }
            else {
              itemType = "CS";
              itemTypeName = "Client Script";
              itemLanguage = "JS";
            }
            break;

          case "DataSources":
            if (root === selectedItemType) {
              itemType = "DSCAT";
              itemTypeName = "Data Source Category";
              itemLanguage = "N/A";
              categoryName = "Data Sources";
            }
            else {
              itemType = "DS";
              itemTypeName = "Data Source";
              categoryName = selectedItemType;

              // ask for data source language
              itemLanguage = await vscode.window.showQuickPick(
                ["SSL", "SQL"],
                {
                  placeHolder: "Select Data Source language",
                  ignoreFocusOut: true
                });
            }
            break;

          default:
            return;
        }
      }

      // abort if no language defined
      if (!itemLanguage) {
        return;
      }

      // ask for item name
      const itemName = await vscode.window.showInputBox({
        title: "Add STARLIMS Enterprise Item",
        placeHolder: `Name for new ${itemTypeName}...`,
        prompt: `Please enter a name for the new ${itemTypeName}.`,
        ignoreFocusOut: true
      });

      // abort if mandatory arguments are missing
      if (!itemName || !itemType || !itemLanguage || !categoryName || !appName) {
        return;
      }

      // create the item
      var sReturn = await enterpriseService.addItem(itemName, itemType, itemLanguage, categoryName, appName);
      if (sReturn.length === 0) {
        return;
      }

      // ask for language for forms only
      let language;
      if (itemType === "XFDFORMXML" || itemType === "HTMLFORMXML") {
        let oReturn = await vscode.window.showQuickPick(
          languages,
          {
            placeHolder: "Select language",
            ignoreFocusOut: true
          }
        );
        language = oReturn.label;

        // add item language to the selected item type
        selectedItemType = `${selectedItemType}/${itemLanguage}`;
      }

      // check out the item unless it's an enterprise item category

      let sUri = appName !== 'N/A' ? `/${root}/${categoryName}/${appName}/${selectedItemType}/${itemName}` :
        `/${root}/${categoryName}/${itemName}`;

      if (itemType.indexOf("CAT") === -1) {
        let bSuccess = await enterpriseService.checkOutItem(sUri, language);
      }

      await enterpriseTreeProvider.refresh();

      // wait for the tree to refresh
      await new Promise(resolve => setTimeout(resolve, 3000));

      // open newly created item (works only if section is expanded)
      let newItem = await enterpriseTreeProvider.getTreeItemByUri(sUri);
      if (newItem !== undefined) {
        vscode.commands.executeCommand("STARLIMS.selectEnterpriseItem", newItem);
      }

      // refresh checkout tree
      vscode.commands.executeCommand("STARLIMS.GetCheckedOutItems");
    }
  );

  // register the delete item command
  vscode.commands.registerCommand("STARLIMS.Delete",
    async () => {
      if (selectedItem === undefined || selectedItem.label === undefined) {
        vscode.window.showErrorMessage("Please select an item to delete.");
        return;
      }
      if (selectedItem.type === EnterpriseItemType.EnterpriseCategory) {
        vscode.window.showErrorMessage("Enterprise Categories cannot be deleted.");
        return;
      }
      if (selectedItem.type === EnterpriseItemType.ServerLog) {
        vscode.window.showErrorMessage("Server Logs cannot be deleted.");
        return;
      }

      // remove text in brackets from item name to get the real item name
      let sItemName = selectedItem.label.toString();
      if (sItemName.indexOf("[") > 0) {
        sItemName = sItemName.substring(0, sItemName.indexOf("[") - 1);
      } else if (sItemName.indexOf('(Checked out') > 0) {
        sItemName = sItemName.substring(0, sItemName.indexOf("(Checked out") - 1);
      }

      // ask for confirmation
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete '${sItemName}'?`,
        { modal: true },
        "Yes"
      );
      if (confirm !== "Yes") {
        return;
      }

      // delete the item
      var bSuccess = await enterpriseService.deleteItem(selectedItem.uri);
      if (bSuccess) {
        // close open document
        const openDocument = vscode.workspace.textDocuments.find(
          (doc) => selectedItem !== undefined && doc.uri.fsPath.toLowerCase() === selectedItem.filePath?.toLowerCase()
        );
        if (openDocument) {
          vscode.window.showTextDocument(openDocument).then(() => {
            vscode.commands.executeCommand("workbench.action.closeActiveEditor");
          });
        }
        selectedItem = undefined;

        // refresh trees
        enterpriseTreeProvider.refresh();
        vscode.commands.executeCommand("STARLIMS.GetCheckedOutItems");
      }
    }
  );

  // register the run data source command
  vscode.commands.registerCommand(
    "STARLIMS.RunDataSource",
    async (item: TreeEnterpriseItem | any) => {
      // get item from editor if no item is defined (shortcut key pressed)
      if (item === undefined) {
        let editor = vscode.window.activeTextEditor;
        item = editor?.document.uri;
      }

      // commands can originate from the enterprise tree or from an open editor window
      let remoteUri: string = "";
      if (item instanceof TreeEnterpriseItem) {
        remoteUri = item.uri;
      } else {
        remoteUri = enterpriseService.getUriFromLocalPath(item.path);
      }

      outputChannel.appendLine(
        `${new Date().toLocaleString()} Executing remote data source at URI: ${remoteUri}`
      );

      executeWithProgress(async () => {
        const result = await enterpriseService.runScript(remoteUri);
        if (result?.success) {
          const dataSourceName = remoteUri.split('/').pop();
          GenericDataViewPanel.render(context.extensionUri, {
            name: dataSourceName,
            data: result.data,
            title: `Data Source Output: ${dataSourceName}`
          });
        }
        outputChannel.appendLine(String(result.data));
        outputChannel.show();
      }, "Executing data source...");
    }
  );

  // register the RunXFDForm command handler
  vscode.commands.registerCommand(
    "STARLIMS.OpenXFDForm",
    async (item: TreeEnterpriseItem | any) => {
      // get item from editor if no item is defined (shortcut key pressed)
      if (item === undefined) {
        let editor = vscode.window.activeTextEditor;
        item = editor?.document.uri;
      }

      // commands can originate from the enterprise tree or from an open editor window
      let remoteUri: string = "";
      if (item instanceof TreeEnterpriseItem) {
        remoteUri = item.uri;
      } else {
        remoteUri = enterpriseService.getUriFromLocalPath(item.path);
      }

      outputChannel.appendLine(
        `${new Date().toLocaleString()} Launching remote form at URI: ${remoteUri}`
      );

      const result = await enterpriseService.runXFDForm(remoteUri.toString());
      if (result) {
        outputChannel.appendLine("Launched form successfully. Please wait while the STARLIMS HTML bridge completes the request.");
        outputChannel.show();
      }
    }
  );

  // insert text into the active editor
  const editorInsert = (text: string) => {
    const activeTextEditor = vscode.window.activeTextEditor;
    if (activeTextEditor) {
      activeTextEditor.edit(editBuilder => {
        editBuilder.insert(activeTextEditor.selection.active, text);
      });
    }
  };

  // register the generate table select command
  vscode.commands.registerCommand(
    "STARLIMS.GenerateTableSelect",
    async (item: TreeEnterpriseItem | any) => {
      const result = await enterpriseService.getTableCommand(item.uri, "SELECT");
      if (result) {
        editorInsert(result);
      }
    }
  );

  // register the generate table delete command
  vscode.commands.registerCommand(
    "STARLIMS.GenerateTableDelete",
    async (item: TreeEnterpriseItem | any) => {
      const result = await enterpriseService.getTableCommand(item.uri, "DELETE");
      if (result) {
        editorInsert(result);
      }
    }
  );

  // register the generate table insert command
  vscode.commands.registerCommand(
    "STARLIMS.GenerateTableInsert",
    async (item: TreeEnterpriseItem | any) => {
      const result = await enterpriseService.getTableCommand(item.uri, "INSERT");
      if (result) {
        editorInsert(result);
      }
    }
  );

  // register the generate table update command
  vscode.commands.registerCommand(
    "STARLIMS.GenerateTableUpdate",
    async (item: TreeEnterpriseItem | any) => {
      const result = await enterpriseService.getTableCommand(item.uri, "UPDATE");
      if (result) {
        editorInsert(result);
      }
    }
  );

  // register the send name to editor command
  vscode.commands.registerCommand(
    "STARLIMS.SendNameToEditor",
    async (item: TreeEnterpriseItem | any) => {
      editorInsert(item.label);
    }
  );

  // register the GoToServerScript command
  vscode.commands.registerCommand(
    "STARLIMS.GoToServerScript",
    async () => {
      var editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      // get the script name from editor cursor position
      const position = editor.selection.active;
      let scriptName = editor.document.getText(editor.document.getWordRangeAtPosition(position, /[\w\.]+/));
      let aScriptNameComponents = scriptName.split(".");

      // remove first and main_ component (script type in log file)
      if (aScriptNameComponents[0] === "ServerScript") {
        aScriptNameComponents.shift();
        if (aScriptNameComponents[2] === "main_") {
          aScriptNameComponents.pop();
          scriptName = aScriptNameComponents.join(".");
        }
      }

      let found = false;

      if (aScriptNameComponents.length === 0) {
        found = false;
      }
      else if (aScriptNameComponents.length === 1) {
        // this is probably a procedure in the current script
        found = findProcedureInEditor(scriptName, editor);
        if (!found) {
          // it could be in an :INCLUDEd library
          const libraryNames = findIncludedScripts(editor);
          for (const library of libraryNames) {
            found = await findScriptOnServer(library, scriptName);
            if (found) { break; }
          }
        }
      } else {
        // this is a server script or external script procedure, search on server to find the main script
        const procedureName = aScriptNameComponents.length > 2 ? aScriptNameComponents[2] : undefined;
        found = await findScriptOnServer(scriptName, procedureName);
      }

      if (!found) {
        vscode.window.showErrorMessage("Couldn't find selected item.");
      }

      async function findScriptOnServer(scriptName: string, procedureName: string | undefined) {
        let itemFound = await enterpriseTreeProvider.search(scriptName, "SS", true, false, true);
        if (itemFound) {
          await vscode.commands.executeCommand("STARLIMS.GetLocal", itemFound);
          // get new editor
          editor = vscode.window.activeTextEditor;
          if (editor && procedureName) {
            // find procedure in the newly opened editor
            return findProcedureInEditor(procedureName, editor);
          }
          return true;
        } {
          return false;
        }
      }

      function findProcedureInEditor(procedureName: string, editor: vscode.TextEditor): boolean {
        const procName = `:PROCEDURE ${[procedureName]};`;
        // search the opened document for the procedure name and set cursor to the line of occurrence
        const procPosition = editor.document.getText().indexOf(procName);
        if (procPosition > 0) {
          const position = editor.document.positionAt(procPosition);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position));
          return true;
        } else {
          return false;
        }
      }

      function findIncludedScripts(editor: vscode.TextEditor) {
        // find all included scripts in the current document
        let regex = /:INCLUDE\s+"([^"]*)";/g;
        let matches;
        let libraryNames = [];
        while ((matches = regex.exec(editor.document.getText())) !== null) {
          libraryNames.push(matches[1]); // Add the captured group to the array
        }

        return libraryNames;
      }
    }
  );

  // register the GoToDataSource command
  vscode.commands.registerCommand(
    "STARLIMS.GoToDataSource",
    async () => {
      var editor = vscode.window.activeTextEditor;
      if (editor) {
        // get the script name from editor cursor position
        const position = editor.selection.active;
        let scriptName = editor.document.getText(editor.document.getWordRangeAtPosition(position, /[\w\.]+/));
        let aScriptNameComponents = scriptName.split(".");

        // remove first and main_ component (script type in log file)
        if (aScriptNameComponents[0] === "DataSource") {
          aScriptNameComponents.shift();
          if (aScriptNameComponents[2] === "main_") {
            aScriptNameComponents.pop();
            scriptName = aScriptNameComponents.join(".");
          }
        }

        // use search to find the script
        const itemFound = await enterpriseTreeProvider.search(scriptName, "DS", true, false, true);

        // open the first item found
        if (itemFound !== undefined) {
          vscode.commands.executeCommand("STARLIMS.GetLocal", itemFound);
        }
      }
    }
  );

  // register the GoToClientScript command
  vscode.commands.registerCommand(
    "STARLIMS.GoToClientScript",
    async () => {
      var editor = vscode.window.activeTextEditor;
      if (editor) {
        // get the script name from editor cursor position
        const position = editor.selection.active;
        const scriptName = editor.document.getText(editor.document.getWordRangeAtPosition(position, /[\w\.]+/));

        // use search to find the script
        const itemFound = await enterpriseTreeProvider.search(scriptName, "CS", true, false, true);

        // open the first item found
        if (itemFound !== undefined) {
          vscode.commands.executeCommand("STARLIMS.GetLocal", itemFound);
        }
      }
    }
  );

  // register the GoToForm command
  vscode.commands.registerCommand(
    "STARLIMS.GoToForm",
    async () => {
      var editor = vscode.window.activeTextEditor;
      if (editor) {
        // get the form name from editor cursor position
        const position = editor.selection.active;
        const formName = editor.document.getText(editor.document.getWordRangeAtPosition(position, /[\w\.]+/));

        // use search to find the script
        const itemFound = await enterpriseTreeProvider.search(formName, "FORMCODEBEHIND", true, false, true);

        // open the first item found
        if (itemFound !== undefined) {
          vscode.commands.executeCommand("STARLIMS.GetLocal", itemFound);
        }
      }
    }
  );

  // register the GoToItem command
  vscode.commands.registerCommand(
    "STARLIMS.GoToItem",
    async () => {
      const autoDetectConfig = [
        {
          command: "STARLIMS.GoToServerScript",
          keywords: ["lims.CallServer", "ExecFunction", "CreateUDObject", "SubmitToBatch", "DoProc", "ServerScript"]
        },
        {
          command: "STARLIMS.GoToDataSource",
          keywords: ["lims.GetData", "DataSource"]
        },
        {
          command: "STARLIMS.GoToForm",
          keywords: ["Form"]
        },
        {
          command: "STARLIMS.GoToClientScript",
          keywords: ["#include"]
        }
      ];

      var editor = vscode.window.activeTextEditor;
      if (editor) {
        // get the current line
        const line = editor.document.lineAt(editor.selection.active.line).text;
        const match = autoDetectConfig.find(config => new RegExp(config.keywords.join("|"), "i").test(line));
        if (match) {
          vscode.commands.executeCommand(match.command);
        } else {
          vscode.window.showErrorMessage("Could not find a STARLIMS item to navigate to.");
        }
      }
    }
  );

  // register the GlobalCodeSearch command
  vscode.commands.registerCommand(
    "STARLIMS.GlobalCodeSearch",
    async () => {
      // get the search term from the user
      const searchTerm = await vscode.window.showInputBox({
        title: "Global Code Search",
        prompt: "Enter a search term to find in all code documents.",
        placeHolder: "Search term...",
        ignoreFocusOut: true
      });
      // let the user select the item types to search
      const itemTypes = await vscode.window.showQuickPick(
        [
          { label: "All", description: "All Items", itemType: "ALL" },
          { label: "Forms", description: "HTML and XFD Forms (Code Behind)", itemType: "FORMCODEBEHIND" },
          { label: "Application Client Scripts", description: "Application Client Scripts", itemType: "APPCS" },
          { label: "Application Server Scripts", description: "Application Server Scripts", itemType: "APPSS" },
          { label: "Application Data Sources", description: "Application Data Sources", itemType: "APPDS" },
          { label: "Server Scripts", description: "Global Server Scripts", itemType: "GLBSS" },
          { label: "Client Scripts", description: "Global Client Scripts", itemType: "GLBCS" },
          { label: "Data Sources", description: "Global Data Sources", itemType: "GLBDS" }
        ],
        {
          title: "Global Code Search",
          placeHolder: "Select the item types to include in the search...",
          canPickMany: true,
          ignoreFocusOut: true
        }
      );
      if (itemTypes === undefined) {
        return;
      }

      // convert item types to string
      const itemTypesString = itemTypes.map(itemType => itemType.itemType).join(",");

      // remove all breakpoints
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);

      if (searchTerm) {
        // display a progress message
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Searching STARLIMS, please wait...",
            cancellable: false
          },
          async (progress, token) => {
            // find all items matching the search term
            await enterpriseTreeProvider.search(searchTerm, itemTypesString, false, true);
            await expandEnterpriseSearchResults();
          }
        );
      }
    }
  );

  // register the Rename command
  vscode.commands.registerCommand(
    "STARLIMS.Rename",
    async () => {
      if (selectedItem === undefined) {
        vscode.window.showErrorMessage("Please select an item to rename.");
        return;
      }

      if (selectedItem.type === EnterpriseItemType.ServerLog) {
        vscode.window.showErrorMessage("Server Logs cannot be renamed.");
        return;
      }

      let aUri = selectedItem.uri.split("/");
      const oldName = aUri.pop() || "";

      // ask for confirmation
      const newName: string = await vscode.window.showInputBox({
        title: "Rename Enterprise Item",
        placeHolder: "New item name...",
        prompt: "Enter a new item name",
        ignoreFocusOut: true,
        value: oldName
      }) || "";

      // rename the item
      if (newName) {
        const bSuccess = await enterpriseService.renameItem(selectedItem.uri, newName);
        if (bSuccess) {
          // refresh trees
          enterpriseTreeProvider.refresh();
          vscode.commands.executeCommand("STARLIMS.GetCheckedOutItems");

          // close and delete (local copies) open documents with the old name
          const filteredTextDocuments = vscode.workspace.textDocuments.filter(td => td.fileName.indexOf(oldName) > 0);
          for (const td of filteredTextDocuments) {
            await vscode.window.showTextDocument(td, { preview: true, preserveFocus: false });
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            try {
              await vscode.workspace.fs.delete(td.uri);
            }
            catch (e) {
              // ignore
            }
          }
        }
      }
    }
  );

  // move item
  vscode.commands.registerCommand(
    "STARLIMS.Move",
    async () => {
      if (selectedItem === undefined) {
        vscode.window.showErrorMessage("Please select an item to move.");
        return;
      }

      if (selectedItem.type === EnterpriseItemType.ServerLog) {
        vscode.window.showErrorMessage("Server Logs cannot be renamed.");
        return;
      }

      let aUri = selectedItem.uri.split("/");
      const itemName = aUri.pop() || "";

      const refreshTreeAndCloseEditors = async (itemName: string) => {
        // refresh trees
        enterpriseTreeProvider.refresh();
        vscode.commands.executeCommand("STARLIMS.GetCheckedOutItems");

        // close and delete (local copies) open documents with the old name
        const filteredTextDocuments = vscode.workspace.textDocuments.filter(td => td.fileName.indexOf(itemName) > 0);
        for (const td of filteredTextDocuments) {
          await vscode.window.showTextDocument(td, { preview: true, preserveFocus: false });
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
          try {
            await vscode.workspace.fs.delete(td.uri);
          }
          catch (e) {
            // ignore
          }
        }
      };

      switch (selectedItem.type) {
        case EnterpriseItemType.AppClientScript:
        case EnterpriseItemType.AppDataSource:
        case EnterpriseItemType.AppServerScript:
        case EnterpriseItemType.HTMLFormCode:
        case EnterpriseItemType.HTMLFormGuide:
        case EnterpriseItemType.HTMLFormResources:
        case EnterpriseItemType.HTMLFormXML:
        case EnterpriseItemType.XFDFormCode:
        case EnterpriseItemType.XFDFormResources:
        case EnterpriseItemType.XFDFormXML:
          const appItems = await enterpriseService.getEnterpriseItems("/Applications/*");
          const applications = appItems.map(({ name }: any) => ({ label: name, description: name }));
          const application: any = await vscode.window.showQuickPick(
            applications,
            {
              title: `Moving '${itemName}' - Select Application`,
              placeHolder: "Select the application where to move the selected item...",
              canPickMany: false,
              ignoreFocusOut: true
            }
          );

          if (application) {
            const bSuccess = await enterpriseService.moveItem(selectedItem.uri, application.label);
            if (bSuccess) {
              await refreshTreeAndCloseEditors(itemName);
            }
          }

          break;
        case EnterpriseItemType.ServerScript:
          const ssCategoryItems = await enterpriseService.getEnterpriseItems("/ServerScripts");
          const ssCategories = ssCategoryItems.map(({ name }: any) => ({ label: name, description: name }));
          const ssCategory: any = await vscode.window.showQuickPick(
            ssCategories,
            {
              title: `Moving '${itemName}' - Select Server Script Category`,
              placeHolder: "Select the server scripts category where to move the selected item...",
              canPickMany: false,
              ignoreFocusOut: true
            }
          );

          if (ssCategory) {
            const bSuccess = await enterpriseService.moveItem(selectedItem.uri, ssCategory.label);
            if (bSuccess) {
              await refreshTreeAndCloseEditors(itemName);
            }
          }

          break;
        case EnterpriseItemType.DataSource:
          const dsCategoryItems = await enterpriseService.getEnterpriseItems("/DataSources");
          const dsCategories = dsCategoryItems.map(({ name }: any) => ({ label: name, description: name }));
          const dsCategory: any = await vscode.window.showQuickPick(
            dsCategories,
            {
              title: `Moving '${itemName}' - Select Data Source Category`,
              placeHolder: "Select the data sources category where to move the selected item...",
              canPickMany: false,
              ignoreFocusOut: true
            }
          );

          if (dsCategory) {
            const bSuccess = await enterpriseService.moveItem(selectedItem.uri, dsCategory.label);
            if (bSuccess) {
              await refreshTreeAndCloseEditors(itemName);
            }
          }

          break;
        case EnterpriseItemType.ClientScript:
          const csCategoryItems = await enterpriseService.getEnterpriseItems("/ClientScripts");
          const csCategories = csCategoryItems.map(({ name }: any) => ({ label: name, description: name }));
          const csCategory: any = await vscode.window.showQuickPick(
            csCategories,
            {
              title: `Moving '${itemName}' - Select Client Script Category`,
              placeHolder: "Select the client scripts category where to move the selected item...",
              canPickMany: false,
              ignoreFocusOut: true
            }
          );

          if (csCategory) {
            const bSuccess = await enterpriseService.moveItem(selectedItem.uri, csCategory.label);
            if (bSuccess) {
              await refreshTreeAndCloseEditors(itemName);
            }
          }

          break;
        default:
          vscode.window.showErrorMessage(`Items of type '${selectedItem.type}' cannot be moved.`);
          return;
      }
    }
  );

  // register the OpenCodeBehind command
  vscode.commands.registerCommand("STARLIMS.OpenCodeBehind", async (formId: string | any, functionName: string | any) => {
    // get tree item from formId
    var item = await enterpriseService.getItemByGUID(formId, EnterpriseItemType.HTMLFormCode);
    if (item === null) {
      vscode.window.showErrorMessage("Could not find the selected item.");
      return;
    }

    if (item !== undefined) {
      vscode.commands.executeCommand("STARLIMS.GetLocal", item);

      // go to the function name
      if (functionName !== undefined) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const text = editor.document.getText();
          const regex = new RegExp(`async function ${functionName}\\(`, "mig");
          const match = regex.exec(text);
          if (match) {
            const position = editor.document.positionAt(match.index);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position));
          }
        }
      }
    }
  });

  // show the connection message
  vscode.window.showInformationMessage(
    `Connected to STARLIMS on ${config.url}.`
  );

  // Git integration: automatically check in to STARLIMS when committing via Git
  void setupGitIntegration(context, rootPath!, enterpriseService, enterpriseTreeProvider, checkedOutTreeDataProvider);

    })().catch((error) => {
      console.error("STARLIMS deferred initialization failed", error);
      void vscode.window.showErrorMessage("STARLIMS failed to initialize. See logs for details.");
    });
  }, DEFERRED_STARLIMS_INIT_MS);
}

async function highlightGlobalSearchMatches(item: TreeEnterpriseItem, localUri: vscode.Uri) {
  // mark all occurrences of the global search term 
  if (item.globalSearchTerm) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const text = editor.document.getText();
      const regex = new RegExp(item.globalSearchTerm, "mig");
      const matches = text.matchAll(regex);
      if (matches) {
        // get positions of matches
        var positions = new Array<vscode.Range>();
        for (const match of matches) {
          if (match.index === undefined) {
            continue; // skip invalid matches
          }
          var start = editor.document.positionAt(match.index);
          var end = editor.document.positionAt(match.index + match[0].length);
          positions.push(new vscode.Range(start, end));
        }

        // highlight matches
        var decorationType = vscode.window.createTextEditorDecorationType({
          backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
          isWholeLine: false
        });
        const decorations = positions.map((range) => ({ range, hoverMessage: 'Matched text' }));
        editor.setDecorations(decorationType, decorations);

        // scroll to first match
        editor.revealRange(positions[0], vscode.TextEditorRevealType.InCenter);

        // set breakpoints on matches
        var breakpoints = new Array<vscode.SourceBreakpoint>();
        positions.forEach((position) => {
          var location = new vscode.Location(localUri, position);
          breakpoints.push(new vscode.SourceBreakpoint(location));
        });
        vscode.debug.addBreakpoints(breakpoints);
      }
    }
  }
}

/**
 * Sets up Git integration to automatically check in to STARLIMS when committing via Git
 * @param slvscodePath Path to the SLVSCODE folder
 * @param enterpriseService The enterprise service instance
 * @param enterpriseTreeProvider The enterprise tree provider
 * @param checkedOutTreeDataProvider The checked out tree provider
 */
async function setupGitIntegration(
  context: vscode.ExtensionContext,
  slvscodePath: string,
  enterpriseService: EnterpriseService,
  enterpriseTreeProvider: EnterpriseTreeDataProvider,
  checkedOutTreeDataProvider: CheckedOutTreeDataProvider
): Promise<void> {
  const fs = require('fs');
  const gitExtension = vscode.extensions.getExtension<{ getAPI(version: number): any }>('vscode.git');

  if (!gitExtension) {
    console.log("Built-in Git extension is unavailable, Git integration disabled");
    return;
  }

  if (!gitExtension.isActive) {
    const gitActivationListener = vscode.extensions.onDidChange(() => {
      const updatedGitExtension = vscode.extensions.getExtension<{ getAPI(version: number): any }>('vscode.git');
      if (updatedGitExtension?.isActive) {
        gitActivationListener.dispose();
        void setupGitIntegration(context, slvscodePath, enterpriseService, enterpriseTreeProvider, checkedOutTreeDataProvider);
      }
    });
    context.subscriptions.push(gitActivationListener);
    console.log("Built-in Git extension is not active yet, Git integration will initialize when it becomes available");
    return;
  }

  const gitApiProvider = gitExtension.exports;

  if (!gitApiProvider || typeof gitApiProvider.getAPI !== 'function') {
    console.log("Git API is unavailable, Git integration disabled");
    return;
  }

  const api = gitApiProvider.getAPI(1);

  if (!api || !Array.isArray(api.repositories)) {
    console.log("Git repositories API is unavailable, Git integration disabled");
    return;
  }

  // Track last known commit hash for each repository
  const lastCommitHashes = new Map<string, string>();

  // Watch for Git repository changes in the SLVSCODE folder
  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    updateGitRepositoryWatchers();
  });

  // Initial setup
  updateGitRepositoryWatchers();

  function updateGitRepositoryWatchers() {
    // Find repositories in SLVSCODE folder
    api.repositories.forEach((repo: any) => {
      const repoPath = repo.rootUri.fsPath;

      // Check if this repository is within SLVSCODE folder or contains it
      if (repoPath.includes(SLVSCODE_FOLDER) || slvscodePath.startsWith(repoPath)) {
        // Listen for state changes in this repository
        repo.state.onDidChange(() => {
          handleGitStateChange(repo, repoPath);
        });
      }
    });
  }

  async function handleGitStateChange(repo: any, repoPath: string) {
    try {
      const head = repo.state.HEAD;
      if (!head || !head.commit) {
        return;
      }

      const currentCommitHash = head.commit;
      const lastKnownHash = lastCommitHashes.get(repoPath);

      // Check if this is a new commit
      if (lastKnownHash && lastKnownHash !== currentCommitHash) {
        // New commit detected, process it
        await handleNewCommit(repo, repoPath, currentCommitHash);
      }

      // Update the last known commit hash
      lastCommitHashes.set(repoPath, currentCommitHash);

    } catch (error) {
      console.error("Error handling Git state change:", error);
    }
  }

  async function handleNewCommit(repo: any, repoPath: string, commitHash: string) {
    try {
      // Get the commit message
      const commit = await repo.getCommit(commitHash);
      if (!commit || !commit.message) {
        return;
      }

      let commitMessage = commit.message;

      // NOTE: Due to limitations in the Git extension API, we cannot reliably get the exact files
      // that were part of this specific commit. As a workaround, we check all STARLIMS files
      // that are checked out. The checkInFileToStarlims function will verify if each file is
      // actually checked out before attempting to check it in, so this is safe but may be inefficient.
      // Future enhancement: Track file modifications using a file watcher to know exactly which files
      // were part of the commit.
      const slvscodeFiles = await getSLVSCODEFilesInRepo(repoPath);

      // Check in each file to STARLIMS (only files that are checked out will actually be checked in)
      let checkedInCount = 0;
      for (const file of slvscodeFiles) {
        const success = await checkInFileToStarlims(file, commitMessage, repoPath);
        if (success) {
          checkedInCount++;
        }
      }

      if (checkedInCount > 0) {
        vscode.window.showInformationMessage(`Checked in ${checkedInCount} file(s) to STARLIMS`);
        // Refresh checked out items after check-ins
        vscode.commands.executeCommand("STARLIMS.GetCheckedOutItems");
      }

    } catch (error) {
      console.error("Error handling new commit:", error);
    }
  }

  async function getSLVSCODEFilesInRepo(repoPath: string): Promise<string[]> {
    try {
      const files: string[] = [];
      const serverWorkspacePath = enterpriseService.getServerWorkspacePath(slvscodePath);

      // Check if SLVSCODE path is within this repo
      if (!serverWorkspacePath.startsWith(repoPath)) {
        return files;
      }

      // Get all files in the SLVSCODE folder that are STARLIMS files
      const glob = require('glob');
      const pattern = path.join(serverWorkspacePath, '**', '*.{ssl,slsql}');
      const foundFiles = glob.sync(pattern);

      return foundFiles.map((file: string) =>
        file.replace(repoPath + path.sep, '')
      );
    } catch (error) {
      console.error("Error getting SLVSCODE files in repo:", error);
      return [];
    }
  }

  async function checkInFileToStarlims(relativePath: string, commitMessage: string, repoPath: string): Promise<boolean> {
    try {
      const fullPath = path.join(repoPath, relativePath);

      // Extract the URI from the file path
      // Path format: {serverName}/{ItemType}/{Category}/{ItemName}.{extension}
      const serverWorkspacePath = enterpriseService.getServerWorkspacePath(slvscodePath);

      // Check if file is within server workspace path
      if (!fullPath.startsWith(serverWorkspacePath)) {
        return false;
      }

      const relativeToslvscode = fullPath.replace(serverWorkspacePath + path.sep, '');

      // Extract item information from path
      const pathParts = relativeToslvscode.split(path.sep);
      if (pathParts.length < 2) {
        return false; // Invalid path
      }

      // Remove extension from file name
      const fileNameWithExt = pathParts[pathParts.length - 1];
      const lastDotIndex = fileNameWithExt.lastIndexOf('.');
      const fileName = lastDotIndex > 0 ? fileNameWithExt.substring(0, lastDotIndex) : fileNameWithExt;

      // Construct URI for STARLIMS
      // Format: /{ItemType}/{Category}/{ItemName}
      const itemType = pathParts[0];
      const category = pathParts.slice(1, -1).join('/');
      const uri = `/${itemType}/${category}/${fileName}`;

      // Check if file is checked out
      const isCheckedOut = await enterpriseService.isCheckedOut(uri);
      if (!isCheckedOut) {
        console.log(`File ${uri} is not checked out, skipping STARLIMS check-in`);
        return false;
      }

      // Check in to STARLIMS with Git commit message
      console.log(`Checking in ${uri} to STARLIMS with message: ${commitMessage}`);
      const success = await enterpriseService.checkInItem(uri, commitMessage, undefined);

      if (success) {
        // Update tree providers
        const item = await enterpriseTreeProvider.getTreeItemFromPath(fullPath, false);
        if (item) {
          enterpriseTreeProvider.setItemCheckedOutStatus(item, false, item.language);
        }
      }

      return success;
    } catch (error) {
      console.error(`Error checking in file to STARLIMS:`, error);
      return false;
    }
  }
}

// this method is called when your extension is deactivated
export function deactivate() { }

