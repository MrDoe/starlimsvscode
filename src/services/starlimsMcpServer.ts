import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { StarlimsAutomationResult, StarlimsAutomationService } from "./starlimsAutomationService";
import { RemoteScriptOutputType } from "./ticketManagementTypes";

type StarlimsMcpOptions = {
  getEnabled: () => boolean;
  getIncludeStructuredDataInText: () => boolean;
  getVersion: () => string;
  logError: (message: string, error?: unknown) => void;
  logInfo: (message: string) => void;
  requestIntegrationTestPermission: (reason?: string) => Promise<{ granted: boolean; reason: string }>;
  runIntegrationTests: () => Promise<StarlimsAutomationResult>;
};

type McpSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const toolResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional()
}).catchall(z.unknown());

const browseTreeInputSchema = z.object({
  uri: z.string().optional().describe("STARLIMS folder URI. Leave empty to browse the root tree."),
  maxItems: z.number().int().positive().optional().describe("Optional maximum number of items to return.")
});

const searchByNameInputSchema = z.object({
  query: z.string().describe("Name or partial name of the STARLIMS item to search for."),
  itemType: z.string().optional().describe("Optional STARLIMS item type filter, for example APPSS or HTMLFORMCODE."),
  exactMatch: z.boolean().optional().describe("Set to true to require an exact name match."),
  maxItems: z.number().int().positive().optional().describe("Optional maximum number of search results to return.")
});

const globalCodeSearchInputSchema = z.object({
  searchString: z.string().describe("Text to search for across STARLIMS code items."),
  itemTypes: z.array(z.string()).optional().describe("Optional STARLIMS item type codes to restrict the search. Leave empty to search all code item types."),
  maxItems: z.number().int().positive().optional().describe("Optional maximum number of search results to return.")
});

const getItemCodeInputSchema = z.object({
  uri: z.string().describe("STARLIMS item URI."),
  language: z.string().optional().describe("Optional form language identifier when reading form code. Defaults to GER for form items when omitted."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of characters to return. Omit to return the full output without truncation")
});

const getItemHistoryInputSchema = z.object({
  uri: z.string().describe("STARLIMS item URI."),
  versionId: z.string().optional().describe("Optional LIMSSOURCECONTROL version id from the history list. When set, returns the stored code snapshot of that version instead of the version list."),
  maxItems: z.number().int().positive().optional().describe("Optional maximum number of history versions to return when versionId is omitted."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of characters to return when versionId is set. Omit to return the full output without truncation")
});

const getItemHistoryDiffInputSchema = z.object({
  uri: z.string().describe("STARLIMS item URI."),
  versionId: z.string().describe("Left side: LIMSSOURCECONTROL version id to diff from (get the ids from get_item_history)."),
  compareVersionId: z.string().optional().describe("Optional right side: another LIMSSOURCECONTROL version id. Omit to diff against the current server version."),
  contextLines: z.number().int().min(0).optional().describe("Unchanged context lines kept around each hunk (default 3)."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of diff characters to return. Omit to return the full diff without truncation")
});

const checkoutItemInputSchema = z.object({
  uri: z.string().describe("STARLIMS item URI."),
  language: z.string().optional().describe("Optional form language identifier for form checkout. Defaults to GER for form items when omitted.")
});

const saveItemInputSchema = z.object({
  localPath: z.string().describe("Absolute path to the edited local STARLIMS working copy."),
  language: z.string().optional().describe("Optional form language identifier override when saving form items. Defaults to GER for form items when omitted.")
});

const refreshCheckoutTreeInputSchema = z.object({
  includeAllUsers: z.boolean().optional().describe("Set to true to refresh the checked-out tree for all users instead of just the current user.")
});

const listCheckedOutItemsInputSchema = z.object({
  includeAllUsers: z.boolean().optional().describe("Set to true to list checked out items of all users instead of just the current user."),
  maxItems: z.number().int().positive().optional().describe("Optional maximum number of checked out items to return.")
});

const listLanguagesInputSchema = z.object({
  maxItems: z.number().int().positive().optional().describe("Optional maximum number of languages to return.")
});

const executeServerScriptInputSchema = z.object({
  uri: z.string().describe("STARLIMS server script URI."),
  parameters: z.array(z.unknown()).optional().describe("Optional positional parameters passed to the server script."),
  outputType: z.enum(["ARRAY", "JSON", "XML"]).optional().describe("Requested output type. Defaults to ARRAY."),
  entryPoint: z.string().optional().describe("Optional procedure or entry point to invoke within the server script."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of characters to return. Omit to return the full output without truncation")
});

const executeDataSourceInputSchema = z.object({
  uri: z.string().describe("STARLIMS data source URI."),
  parameters: z.array(z.unknown()).optional().describe("Optional positional parameters passed to the data source."),
  outputType: z.enum(["ARRAY", "JSON", "XML"]).optional().describe("Requested output type. Defaults to ARRAY."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of characters to return. Defaults to the STARLIMS.mcp.maxScriptCharacters setting for server scripts and is unlimited for data sources unless maxRows applies."),
  maxRows: z.number().int().positive().optional().describe("Optional maximum number of data rows to return (excluding the header row). Defaults to the STARLIMS.mcp.maxDataSourceRows setting. Only applies to ARRAY output.")
});

const checkinItemInputSchema = z.object({
  uri: z.string().describe("STARLIMS item URI."),
  reason: z.string().describe("Check-in reason. When a ticket is bound to the check-in this text becomes the ticket measure, so write it as a short, complete change description."),
  language: z.string().optional().describe("Optional form language identifier for form check-in. Defaults to GER for form items when omitted."),
  ticketId: z.number().int().min(0).optional().describe("Ticket to create a completed measure for after a successful check-in. Omit to use the active ticket of the workspace (see set_active_ticket); pass 0 to check in without creating a ticket measure.")
});

const undoCheckoutInputSchema = z.object({
  uri: z.string().describe("STARLIMS item URI.")
});

const getTableDefinitionInputSchema = z.object({
  uri: z.string().describe("STARLIMS table URI."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of characters to return. Omit to return the full output without truncation")
});

const checkoutTableInputSchema = z.object({
  uri: z.string().describe("STARLIMS table URI.")
});

const checkinTableInputSchema = z.object({
  uri: z.string().describe("STARLIMS table URI."),
  reason: z.string().describe("Check-in reason.")
});

const addTableInputSchema = z.object({
  tableName: z.string().describe("New table name."),
  dsn: z.string().describe("Target table location, usually DATABASE or DICTIONARY.")
});

const editTableInputSchema = z.object({
  uri: z.string().describe("STARLIMS table URI."),
  tableXml: z.string().describe("Full serialized table XML.")
});

const createItemInputSchema = z.object({
  itemName: z.string().describe("New item name."),
  itemType: z
    .string()
    .describe(
      "STARLIMS item type, for example SS, APPSS, HTMLFORMXML, APPDS, or CS. Application item types (APP, APPSS, APPDS, APPCS, forms) require a valid categoryName/appName; global types (SS, DS, CS) require a categoryName and appName=N/A."
    ),
  language: z
    .string()
    .describe(
      "Item language. Use SQL for data sources (DS/APPDS), SSL for STARLIMS server scripts (SS/APPSS), JS for client scripts (CS/APPCS), and a form language like GER for forms. Never pass N/A for code items - the backend falls back to the correct default (SQL for data sources) but the local sync depends on a valid language."
    ),
  categoryName: z
    .string()
    .describe(
      "For application items: the APPLICATION CATEGORY (the parent folder of the app under /Applications, e.g. BMBH_Modules - NOT the literal string 'app'). For global items (SS/DS/CS): the category folder name (e.g. BMBH). Browse /Applications or search_by_name to get the real category. A wrong category silently aborts creation."
    ),
  appName: z
    .string()
    .describe(
      "For application items: the application name under the category (e.g. BMBH_Ticketmanagement, from the URI /Applications/<category>/<appName>/...). Use N/A for global items and categories."
    )
});

const runIntegrationTestsInputSchema = z.object({
  reason: z.string().optional().describe("Optional explanation shown to the user when asking permission to run integration tests."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of characters to return. Omit to return the full output without truncation")
});

const readLogInputSchema = z.object({
  user: z.string().optional().describe("STARLIMS user name whose log to read. Defaults to the current user configured in starlimsvscode."),
  lastLines: z.number().int().positive().optional().describe("Number of the most recent lines of the log to return. Defaults to 20. Passed to the backend as the LastLines query parameter so only the tail is transferred."),
  maxLines: z.number().int().positive().optional().describe("Deprecated alias of lastLines, kept for backward compatibility. lastLines takes precedence when both are given.")
});

const transferItemInputSchema = z.object({
  targetServer: z.string().describe("Name of the configured STARLIMS target server (STARLIMS.servers) to transfer the checked out items to."),
  saveLocalEdits: z.boolean().optional().describe("Set to true to push local working copy edits of the checked out items to the source server before exporting. Defaults to true.")
});

const listTicketsInputSchema = z.object({
  mine: z.boolean().optional().describe("Return only tickets assigned to the currently logged-in STARLIMS user."),
  assignedTo: z.string().optional().describe("Return only tickets assigned to this STARLIMS user name. Ignored when mine is true."),
  statusGroup: z.string().optional().describe("Return only tickets in this status group: Offen, In Bearbeitung, In Pruefung, Fertig or Zurueckgestellt. Case and umlauts are flexible (Prüfung == Pruefung)."),
  status: z.string().optional().describe("Return only tickets with this exact status name."),
  titleContains: z.string().optional().describe("Return only tickets whose title contains this text (case-insensitive)."),
  modifiedWithinDays: z.number().int().positive().optional().describe("Return only tickets modified within the last N days."),
  maxItems: z.number().int().positive().optional().describe("Optional maximum number of tickets to return.")
});

const ticketIdInputSchema = z.object({
  ticketId: z.number().int().positive().describe("Ticket id (ORIGREC of BMBH_TICKETS), for example 2210.")
});

const getTicketDetailsInputSchema = z.object({
  ticketId: z.number().int().positive().describe("Ticket id."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of characters per text field (description, stack trace, comments). Omit to return the full text.")
});

const getTicketHistoryInputSchema = z.object({
  ticketId: z.number().int().positive().describe("Ticket id."),
  maxItems: z.number().int().positive().optional().describe("Optional maximum number of change entries to return.")
});

const createTicketInputSchema = z.object({
  title: z.string().describe("Ticket title. Short and specific. The server generates a description by AI when none is given."),
  description: z.string().optional().describe("Detailed description of the request, error or change. Omit to let the server queue an AI job that writes it."),
  type: z.string().optional().describe("Ticket type name from the ticket dictionary (e.g. Bug, Feature Request, Support-Anfrage). Omit for the server default (Support-Anfrage). get_ticket_lookup_data lists the valid names."),
  priority: z.string().optional().describe("Ticket priority name from the ticket dictionary (e.g. Niedrig, Mittel, Hoch). Omit for the server default (Nicht definiert)."),
  username: z.string().optional().describe("Author of the ticket. Defaults to the STARLIMS user configured in the extension."),
  notifyUser: z.boolean().optional().describe("Set to true to send the author a notification mail about the new ticket. Defaults to false: no mail is sent.")
});

const undertakeTicketInputSchema = z.object({
  ticketId: z.number().int().positive().describe("Ticket id."),
  username: z.string().optional().describe("User the ticket should be assigned to. Defaults to the STARLIMS user configured in the extension.")
});

const releaseTicketInputSchema = z.object({
  ticketId: z.number().int().positive().describe("Ticket id."),
  force: z.boolean().optional().describe("Set to true to release the ticket even when it is assigned to a different user than the current one.")
});

const renameTicketInputSchema = z.object({
  ticketId: z.number().int().positive().describe("Ticket id."),
  title: z.string().describe("New ticket title.")
});

const addTicketMeasureInputSchema = z.object({
  ticketId: z.number().int().positive().describe("Ticket id."),
  title: z.string().describe("Measure title - what was done, in one line."),
  description: z.string().optional().describe("Measure details: changed items, reasoning, verification.")
});

const addTicketCommentInputSchema = z.object({
  ticketId: z.number().int().positive().describe("Ticket id."),
  comment: z.string().describe("Comment text."),
  author: z.string().optional().describe("Comment author. Defaults to the STARLIMS user configured in the extension.")
});

const setActiveTicketInputSchema = z.object({
  ticketId: z.number().int().positive().optional().describe("Ticket that subsequent check-ins should be linked to. Omit to clear the active ticket selection.")
});

export class StarlimsMcpServer {
  private readonly sessions = new Map<string, McpSession>();

  constructor(
    private readonly automationService: StarlimsAutomationService,
    private readonly options: StarlimsMcpOptions
  ) { }

  public async handleRequest(req: Request, res: Response): Promise<void> {
    if (!this.options.getEnabled()) {
      this.respondWithError(res, 404, -32004, "The STARLIMS MCP endpoint is disabled in settings.", req.body);
      return;
    }

    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      this.respondWithError(res, 405, -32000, "Method not allowed.", req.body);
      return;
    }

    const sessionId = req.header("Mcp-Session-Id");
    let session: McpSession | undefined = sessionId ? this.sessions.get(sessionId) : undefined;

    if (!session) {
      if (sessionId) {
        this.options.logInfo(`Rejected request for unknown MCP session '${sessionId}'.`);
        this.respondWithError(res, 404, -32001, `Session not found: ${sessionId}`, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        this.respondWithError(
          res,
          400,
          -32000,
          "Bad Request: Mcp-Session-Id header is required. Initialize a session first with an initialize request.",
          req.body
        );
        return;
      }

      session = await this.createSession();
    }

    try {
      if (isInitializeRequest(req.body)) {
        this.options.logInfo("STARLIMS MCP client initialized.");
      }

      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      this.options.logError("Failed to handle STARLIMS MCP request.", error);
      if (!res.headersSent) {
        this.respondWithError(res, 500, -32603, "Internal MCP server error.", req.body);
      }
    }
  }

  private async createSession(): Promise<McpSession> {
    const server = this.createServer();
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (generatedSessionId) => {
        this.sessions.set(generatedSessionId, { server, transport });
        this.options.logInfo(`STARLIMS MCP session ${generatedSessionId} initialized.`);
      },
      onsessionclosed: (closedSessionId) => {
        this.sessions.delete(closedSessionId);
        this.options.logInfo(`STARLIMS MCP session ${closedSessionId} closed.`);
        void server.close().catch((error) => {
          this.options.logError("Failed to close STARLIMS MCP server.", error);
        });
      }
    });

    await server.connect(transport);
    return { server, transport };
  }

  private createServer(): McpServer {
    const server = new McpServer(
      {
        name: "starlims-vscode",
        version: this.options.getVersion()
      },
      {
        capabilities: {
          logging: {},
          tools: {}
        }
      }
    );

    server.registerTool(
      "browse_tree",
      {
        annotations: { readOnlyHint: true },
        description: "Browse STARLIMS items under a folder URI or from the root tree.",
        inputSchema: browseTreeInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, maxItems }) => this.executeTool(
        "browse_tree",
        { maxItems, uri },
        () => this.automationService.browseTree(uri, maxItems),
        (result) => {
        const actual = Array.isArray(result.items) ? result.items.length : 0;
        const total = this.toCount(result.totalItems);
        return actual < total
          ? `Retrieved ${actual} of ${total} item(s) from ${this.toUriLabel(result.uri)}.`
          : `Retrieved ${actual} item(s) from ${this.toUriLabel(result.uri)}.`;
      }
      )
    );

    server.registerTool(
      "search_by_name",
      {
        annotations: { readOnlyHint: true },
        description: "Search STARLIMS items by name or partial name.",
        inputSchema: searchByNameInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ query, itemType, exactMatch, maxItems }) => this.executeTool(
        "search_by_name",
        { exactMatch, itemType, maxItems, query },
        () => this.automationService.searchByName(query, itemType, exactMatch, maxItems),
        (result) => `Found ${this.toCount(result.totalItems)} matching item(s) for '${query}'.`
      )
    );

    server.registerTool(
      "global_code_search",
      {
        annotations: { readOnlyHint: true },
        description: "Search for text across STARLIMS code items.",
        inputSchema: globalCodeSearchInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ searchString, itemTypes, maxItems }) => this.executeTool(
        "global_code_search",
        { itemTypes, maxItems, searchString },
        () => this.automationService.globalCodeSearch(searchString, itemTypes, maxItems),
        (result) => `Found ${this.toCount(result.totalItems)} code match(es) for '${searchString}'.`
      )
    );

    server.registerTool(
      "list_languages",
      {
        annotations: { readOnlyHint: true },
        description: "List the STARLIMS languages available for form checkout and code retrieval.",
        inputSchema: listLanguagesInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ maxItems }) => this.executeTool(
        "list_languages",
        { maxItems },
        () => this.automationService.listLanguages(maxItems),
        (result) => `Retrieved ${this.toCount(result.totalItems)} language option(s).`
      )
    );

    server.registerTool(
      "get_item_code",
      {
        annotations: { readOnlyHint: true },
        description: "Read code for a STARLIMS item.",
        inputSchema: getItemCodeInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, language, maxCharacters }) => this.executeTool(
        "get_item_code",
        { language, maxCharacters, uri },
        () => this.automationService.getItemCode(uri, language, maxCharacters),
        (result) => `Retrieved ${this.toCount(result.totalCharacters)} character(s) from ${this.toUriLabel(result.uri)}.`
      )
    );

    server.registerTool(
      "get_item_history",
      {
        annotations: { readOnlyHint: true },
        description: "Read the source control history of a STARLIMS item from LIMSSOURCECONTROL: the list of check-out/check-in versions (version number, user, date, reason) or, when versionId is set, the stored code snapshot of that version.",
        inputSchema: getItemHistoryInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, versionId, maxItems, maxCharacters }) => this.executeTool(
        "get_item_history",
        { maxCharacters, maxItems, uri, versionId },
        () => this.automationService.getItemHistory(uri, versionId, maxItems, maxCharacters),
        (result) => typeof result.code === "string"
          ? `Retrieved ${this.toCount(result.totalCharacters)} character(s) of code for history version '${result.versionId}' of ${this.toUriLabel(result.uri)}.`
          : `Found ${this.toCount(result.totalItems)} history version(s) for ${this.toUriLabel(result.uri)}.`
      )
    );

    server.registerTool(
      "get_item_history_diff",
      {
        annotations: { readOnlyHint: true },
        description: "Unified line diff between two server-side versions of a STARLIMS item: a LIMSSOURCECONTROL history version against another history version or (default) the current server version. Read-only history/diff browsing; nothing is modified.",
        inputSchema: getItemHistoryDiffInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, versionId, compareVersionId, contextLines, maxCharacters }) => this.executeTool(
        "get_item_history_diff",
        { compareVersionId, contextLines, maxCharacters, uri, versionId },
        () => this.automationService.getItemHistoryDiff(uri, versionId, compareVersionId, contextLines, maxCharacters),
        (result) => result.changed === true
          ? `Diff of ${this.toUriLabel(result.uri)}: +${this.toCount(result.addedLines)} / -${this.toCount(result.removedLines)} line(s) against ${typeof result.compareVersionId === "string" && result.compareVersionId.length > 0 ? `version ${result.compareVersionId}` : "the current server version"}.`
          : `The versions of ${this.toUriLabel(result.uri)} are identical.`
      )
    );

    server.registerTool(
      "read_log",
      {
        annotations: { readOnlyHint: true },
        description: "Read the STARLIMS server log file for a specified user (default: current user). Returns the last lastLines lines of the current log.",
        inputSchema: readLogInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ user, lastLines, maxLines }) => this.executeTool(
        "read_log",
        { lastLines, maxLines, user },
        () => this.automationService.readLog(user, lastLines ?? maxLines),
        (result) => `Retrieved ${this.toCount(result.totalLines)} line(s) from log for user '${result.user}'.`
      )
    );

    server.registerTool(
      "checkout_item",
      {
        description: "Check out a STARLIMS item and sync the local working copy into the SLVSCODE workspace.",
        inputSchema: checkoutItemInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, language }) => this.executeTool(
        "checkout_item",
        { language, uri },
        () => this.automationService.checkoutItem(uri, language),
        (result) => `Checked out ${this.toUriLabel(result.uri)} to ${typeof result.localPath === "string" ? result.localPath : "the local workspace"}.`
      )
    );

    server.registerTool(
      "save_item",
      {
        description: "Save an edited local STARLIMS working copy back to the remote STARLIMS item.",
        inputSchema: saveItemInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ localPath, language }) => this.executeTool(
        "save_item",
        { language, localPath },
        () => this.automationService.saveItem(localPath, language),
        (result) => `Saved ${this.toUriLabel(result.uri)} from ${typeof result.localPath === "string" ? result.localPath : "the local workspace"}.`
      )
    );

    server.registerTool(
      "refresh_checkout_tree",
      {
        description: "Refresh the checked-out tree in VS Code from the STARLIMS server.",
        inputSchema: refreshCheckoutTreeInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ includeAllUsers }) => this.executeTool(
        "refresh_checkout_tree",
        { includeAllUsers },
        () => this.automationService.refreshCheckoutTree(includeAllUsers === true),
        (result) => `Refreshed the checked-out tree${result.includeAllUsers === true ? " for all users" : ""}.`
      )
    );

    server.registerTool(
      "list_checked_out_items",
      {
        description: "List the items currently checked out on the STARLIMS server, with URI, item type, owner, and language.",
        inputSchema: listCheckedOutItemsInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ includeAllUsers, maxItems }) => this.executeTool(
        "list_checked_out_items",
        { includeAllUsers, maxItems },
        () => this.automationService.listCheckedOutItems(includeAllUsers, maxItems),
        (result) => `Found ${this.toCount(result.totalItems)} checked out item(s)${result.includeAllUsers === true ? " across all users" : " for the current user"}.`
      )
    );

    server.registerTool(
      "checkin_item",
      {
        description: "Check in a STARLIMS enterprise item after local edits are complete. When a ticket is bound (explicit ticketId or the workspace's active ticket) a completed ticket measure is created from the check-in reason; a failing measure never reverts the check-in but is reported as measureError.",
        inputSchema: checkinItemInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, reason, language, ticketId }) => this.executeTool(
        "checkin_item",
        { language, reason, ticketId, uri },
        () => this.automationService.checkinItem(uri, reason, language, ticketId),
        (result) => {
          const measureText = typeof result.measureId === "number"
            ? ` Created ticket measure ${result.measureId} for ticket #${this.toCount(result.ticketId)}.`
            : (result.measureError
              ? " WARNING: the ticket measure could not be created - see measureError."
              : "");
          return `Checked in ${this.toUriLabel(result.uri)}.${measureText}`;
        }
      )
    );

    server.registerTool(
      "undo_checkout",
      {
        description: "Undo checkout of a STARLIMS item and discard the active checkout on the server.",
        inputSchema: undoCheckoutInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri }) => this.executeTool(
        "undo_checkout",
        { uri },
        () => this.automationService.undoCheckout(uri),
        (result) => `Undid checkout for ${this.toUriLabel(result.uri)}.`
      )
    );

    server.registerTool(
      "execute_server_script",
      {
        description: "Execute a STARLIMS server script and return the captured output.",
        inputSchema: executeServerScriptInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, parameters, outputType, entryPoint, maxCharacters }) => this.executeTool(
        "execute_server_script",
        { entryPoint, maxCharacters, outputType, parameters, uri },
        () => this.automationService.executeServerScript(
          uri,
          parameters,
          outputType as RemoteScriptOutputType | undefined,
          entryPoint,
          maxCharacters
        ),
        (result) => `Executed ${this.toUriLabel(result.uri)} and captured ${this.toCount(result.totalCharacters)} character(s) of output.`
      )
    );

    server.registerTool(
      "execute_data_source",
      {
        description: "Execute a STARLIMS data source and return the captured output.",
        inputSchema: executeDataSourceInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, parameters, outputType, maxCharacters, maxRows }) => this.executeTool(
        "execute_data_source",
        { maxCharacters, maxRows, outputType, parameters, uri },
        () => this.automationService.executeDataSource(
          uri,
          parameters,
          outputType as RemoteScriptOutputType | undefined,
          maxCharacters,
          maxRows
        ),
        (result) => `Executed ${this.toUriLabel(result.uri)} and captured ${this.toCount(result.totalCharacters)} character(s) of output.`
      )
    );

    server.registerTool(
      "create_item",
      {
        description:
          "Create a STARLIMS enterprise item. For application items (APP, APPSS, APPDS, APPCS, forms) pass the APPLICATION CATEGORY as categoryName (parent of the app under /Applications, e.g. BMBH_Modules - never the literal 'app') and the app name as appName. For global items (SS, DS, CS) pass the category and appName=N/A. Language: SQL for data sources, SSL for STARLIMS server scripts, JS for client scripts, GER/ENG for forms.",
        inputSchema: createItemInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ appName, categoryName, itemName, itemType, language }) => this.executeTool(
        "create_item",
        { appName, categoryName, itemName, itemType, language },
        () => this.automationService.createItem(itemName, itemType, language, categoryName, appName),
        (result) => `Created ${typeof result.itemType === "string" ? result.itemType : "item"} ${typeof result.itemName === "string" ? result.itemName : ""}.`
      )
    );

    server.registerTool(
      "get_table_definition",
      {
        annotations: { readOnlyHint: true },
        description: "Read the full XML table definition for a STARLIMS table.",
        inputSchema: getTableDefinitionInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, maxCharacters }) => this.executeTool(
        "get_table_definition",
        { maxCharacters, uri },
        () => this.automationService.getTableDefinition(uri, maxCharacters),
        (result) => `Retrieved ${this.toCount(result.totalCharacters)} character(s) from ${this.toUriLabel(result.uri)}.`
      )
    );

    server.registerTool(
      "checkout_table",
      {
        description: "Check out a STARLIMS table and sync the local XML working copy into the SLVSCODE workspace.",
        inputSchema: checkoutTableInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri }) => this.executeTool(
        "checkout_table",
        { uri },
        () => this.automationService.checkoutTable(uri),
        (result) => `Checked out ${this.toUriLabel(result.uri)} to ${typeof result.localPath === "string" ? result.localPath : "the local workspace"}.`
      )
    );

    server.registerTool(
      "checkin_table",
      {
        description: "Check in a STARLIMS table.",
        inputSchema: checkinTableInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, reason }) => this.executeTool(
        "checkin_table",
        { reason, uri },
        () => this.automationService.checkinTable(uri, reason),
        (result) => `Checked in ${this.toUriLabel(result.uri)}.`
      )
    );

    server.registerTool(
      "create_table",
      {
        description: "Create a new STARLIMS table.",
        inputSchema: addTableInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ tableName, dsn }) => this.executeTool(
        "create_table",
        { dsn, tableName },
        () => this.automationService.addTable(tableName, dsn),
        (result) => `Created table ${typeof result.tableName === "string" ? result.tableName : ""} in ${typeof result.dsn === "string" ? result.dsn : "the target location"}.`
      )
    );

    server.registerTool(
      "edit_table",
      {
        description: "Save a modified STARLIMS table XML definition.",
        inputSchema: editTableInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, tableXml }) => this.executeTool(
        "edit_table",
        { uri, tableXml },
        () => this.automationService.editTable(uri, tableXml),
        (result) => `Saved ${this.toUriLabel(result.uri)}.`
      )
    );

    server.registerTool(
      "run_integration_tests",
      {
        description: "Run the VS Code extension integration tests (`npm test`). The extension always prompts the local user for permission before starting the test run.",
        inputSchema: runIntegrationTestsInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ reason, maxCharacters }) => this.runIntegrationTestsTool(reason, maxCharacters)
    );

    server.registerTool(
      "transfer_item_to_server",
      {
        description: "Transfer all checked out items of the current user to another configured STARLIMS server. Exports an SDP package from the source server and imports it on the target server, automatically generating a new version of each item on the target. Optionally pushes local working copy edits to the source server first. Items on the source server remain checked out. After a successful import the transferred items are fetched back from the target server and written as local working copies into the target server's SLVSCODE workspace folder.",
        inputSchema: transferItemInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ targetServer, saveLocalEdits }) => this.executeTool(
        "transfer_item_to_server",
        { saveLocalEdits, targetServer },
        () => this.automationService.transferItems(targetServer, saveLocalEdits),
        (result) => {
          const targetLabel = typeof result.targetServer === "string" && result.targetServer.length > 0
            ? result.targetServer
            : "the target server";
          const itemCount = this.toCount(result.totalItems);
          const summary = itemCount > 0
            ? `Transferred ${itemCount} checked-out item(s) to '${targetLabel}'. New versions were created on the target server.`
            : `Transferred the checked out items to '${targetLabel}'. New versions were created on the target server.`;
          const localSyncCount = Array.isArray(result.localSyncedFiles) ? result.localSyncedFiles.length : 0;
          const localSyncText = localSyncCount > 0
            ? ` Updated ${localSyncCount} local file copy(ies) in the '${targetLabel}' SLVSCODE folder.`
            : "";
          const localSyncErrorCount = Array.isArray(result.localSyncErrors) ? result.localSyncErrors.length : 0;
          const localSyncErrorText = localSyncErrorCount > 0
            ? ` WARNING: ${localSyncErrorCount} local file copy(ies) could not be refreshed from the target server.`
            : "";
          const unconfirmed = Array.isArray(result.unconfirmedItems)
            ? result.unconfirmedItems.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
            : [];
          const warnings = [
            unconfirmed.length > 0
              ? `WARNING: the import log does not mention ${unconfirmed.length} transferred item(s); they may not have arrived: ${unconfirmed.join(", ")}. Verify them on the target server.`
              : "",
            localSyncErrorText.trim()
          ].filter((warning) => warning.length > 0).join(" ");
          return warnings.length > 0
            ? `${summary}${localSyncText} ${warnings}`
            : `${summary}${localSyncText}`;
        }
      )
    );

    server.registerTool(
      "list_tickets",
      {
        annotations: { readOnlyHint: true },
        description: "List STARLIMS tickets of the connected server with status, assignee, priority and dates. Filters are applied to the full ticket list. Sub-tickets of merged tickets are not returned.",
        inputSchema: listTicketsInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ assignedTo, maxItems, mine, modifiedWithinDays, status, statusGroup, titleContains }) => this.executeTool(
        "list_tickets",
        { assignedTo, maxItems, mine, modifiedWithinDays, status, statusGroup, titleContains },
        () => this.automationService.listTickets({
          assignedTo,
          maxItems,
          mine,
          modifiedWithinDays,
          status,
          statusGroup,
          titleContains
        }),
        (result) => {
          const total = this.toCount(result.totalItems);
          const actual = Array.isArray(result.tickets) ? result.tickets.length : 0;
          return actual < total
            ? `Found ${actual} of ${total} ticket(s).`
            : `Found ${actual} ticket(s).`;
        }
      )
    );

    server.registerTool(
      "get_ticket_details",
      {
        annotations: { readOnlyHint: true },
        description: "Read everything known about one ticket: overview fields, description, stack trace and comments.",
        inputSchema: getTicketDetailsInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ ticketId, maxCharacters }) => this.executeTool(
        "get_ticket_details",
        { maxCharacters, ticketId },
        () => this.automationService.getTicketDetails(ticketId, maxCharacters),
        (result) => `Retrieved details for ticket #${this.toCount(result.ticketId)}.`
      )
    );

    server.registerTool(
      "get_ticket_history",
      {
        annotations: { readOnlyHint: true },
        description: "Read the field-level change history of a ticket: which field changed, old and new value, who changed it and when.",
        inputSchema: getTicketHistoryInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ ticketId, maxItems }) => this.executeTool(
        "get_ticket_history",
        { maxItems, ticketId },
        () => this.automationService.getTicketHistory(ticketId, maxItems),
        (result) => `Found ${this.toCount(result.totalItems)} change entr(ies|y) for ticket #${this.toCount(result.ticketId)}.`
      )
    );

    server.registerTool(
      "get_ticket_lookup_data",
      {
        annotations: { readOnlyHint: true },
        description: "Read the ticket dictionaries (statuses, types, priorities, severities) as name/code pairs. Use it to pick valid type and priority names for create_ticket.",
        inputSchema: z.object({}),
        outputSchema: toolResultSchema
      },
      async () => this.executeTool(
        "get_ticket_lookup_data",
        {},
        () => this.automationService.getTicketLookupData(),
        () => "Retrieved the ticket status/type/priority/severity dictionaries."
      )
    );

    server.registerTool(
      "create_ticket",
      {
        description: "Create a ticket in the BMBH ticket management. The ticket gets the server default status (Offen). When no description is given the STARLIMS server queues an AI job that writes one; no mail is sent unless notifyUser is true.",
        inputSchema: createTicketInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ description, notifyUser, priority, title, type, username }) => this.executeTool(
        "create_ticket",
        { description, notifyUser, priority, title, type, username },
        () => this.automationService.createTicket({ description, notifyUser, priority, title, type, username }),
        (result) => `Created ticket #${this.toCount(result.ticketId)}${typeof result.title === "string" ? ` '${result.title}'` : ""}.`
      )
    );

    server.registerTool(
      "undertake_ticket",
      {
        description: "Move a ticket to 'In Bearbeitung' and assign it to a user (default: the configured STARLIMS user). Call it before starting work on a ticket.",
        inputSchema: undertakeTicketInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ ticketId, username }) => this.executeTool(
        "undertake_ticket",
        { ticketId, username },
        () => this.automationService.undertakeTicket(ticketId, username),
        (result) => `Ticket #${this.toCount(result.ticketId)} is now In Bearbeitung${typeof result.assignedTo === "string" ? ` (assigned to ${result.assignedTo})` : ""}.`
      )
    );

    server.registerTool(
      "release_ticket",
      {
        description: "Release a ticket back to 'Offen' and clear its assignee. Refused when the ticket is assigned to a different user unless force is true.",
        inputSchema: releaseTicketInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ ticketId, force }) => this.executeTool(
        "release_ticket",
        { force, ticketId },
        () => this.automationService.releaseTicket(ticketId, force),
        (result) => `Ticket #${this.toCount(result.ticketId)} was released back to Offen.`
      )
    );

    server.registerTool(
      "solve_ticket",
      {
        description: "Mark a ticket as 'Fertig' (solved). Record what was done as a measure first (add_ticket_measure, or checkin_item with a ticketId), because a solved ticket should not need follow-up questions.",
        inputSchema: ticketIdInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ ticketId }) => this.executeTool(
        "solve_ticket",
        { ticketId },
        () => this.automationService.solveTicket(ticketId),
        (result) => `Ticket #${this.toCount(result.ticketId)} was marked as Fertig.`
      )
    );

    server.registerTool(
      "rename_ticket",
      {
        description: "Change the title of a ticket.",
        inputSchema: renameTicketInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ ticketId, title }) => this.executeTool(
        "rename_ticket",
        { ticketId, title },
        () => this.automationService.renameTicket(ticketId, title),
        (result) => `Renamed ticket #${this.toCount(result.ticketId)}.`
      )
    );

    server.registerTool(
      "add_ticket_measure",
      {
        description: "Add a completed measure to a ticket - the record of what was actually done. checkin_item does this automatically for bound tickets; use this tool for work that did not go through a check-in.",
        inputSchema: addTicketMeasureInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ description, ticketId, title }) => this.executeTool(
        "add_ticket_measure",
        { description, ticketId, title },
        () => this.automationService.addTicketMeasure(ticketId, title, description ?? ""),
        (result) => `Added measure ${this.toCount(result.measureId)} to ticket #${this.toCount(result.ticketId)}.`
      )
    );

    server.registerTool(
      "add_ticket_comment",
      {
        description: "Add a comment to a ticket thread (questions, status updates, information for the ticket author).",
        inputSchema: addTicketCommentInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ author, comment, ticketId }) => this.executeTool(
        "add_ticket_comment",
        { author, comment, ticketId },
        () => this.automationService.addTicketComment(ticketId, comment, author),
        (result) => `Added a comment to ticket #${this.toCount(result.ticketId)}.`
      )
    );

    server.registerTool(
      "set_active_ticket",
      {
        description: "Set the ticket this workspace works on - the same selection the tickets tree makes. The active ticket filters the checked-out tree, appears in the status bar, and is used by checkin_item when no ticketId is passed. Omit ticketId to clear it.",
        inputSchema: setActiveTicketInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ ticketId }) => this.executeTool(
        "set_active_ticket",
        { ticketId },
        () => this.automationService.setActiveTicket(ticketId),
        (result) => result.cleared === true
          ? "Cleared the active ticket selection."
          : `Ticket #${this.toCount(result.ticketId)} is now the active ticket.`
      )
    );

    server.registerTool(
      "get_active_ticket",
      {
        annotations: { readOnlyHint: true },
        description: "Show the ticket that is currently selected as active for this workspace and server.",
        inputSchema: z.object({}),
        outputSchema: toolResultSchema
      },
      async () => this.executeTool(
        "get_active_ticket",
        {},
        async () => this.automationService.getActiveTicket(),
        (result) => {
          const activeTicket = result.activeTicket as { id?: number } | undefined;
          return activeTicket
            ? `The active ticket is #${this.toCount(activeTicket.id)}.`
            : "No active ticket is set.";
        }
      )
    );

    return server;
  }

  private respondWithError(
    res: Response,
    statusCode: number,
    errorCode: number,
    message: string,
    body: unknown
  ): void {
    res.status(statusCode).json({
      error: {
        code: errorCode,
        message
      },
      id: this.getRequestId(body),
      jsonrpc: "2.0"
    });
  }

  private getRequestId(body: unknown): unknown {
    if (body && typeof body === "object" && "id" in body) {
      return (body as { id?: unknown }).id ?? null;
    }

    return null;
  }

  private toCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  private async executeTool(
    toolName: string,
    input: Record<string, unknown>,
    operation: () => Promise<StarlimsAutomationResult>,
    successMessageFactory: (result: StarlimsAutomationResult) => string
  ) {
    this.options.logInfo(`${toolName} request ${this.stringifyForLog(input)}`);
    let result: StarlimsAutomationResult;
    try {
      result = await operation();
    } catch (error: any) {
      this.options.logError(`${toolName} threw an exception: ${error?.message ?? error}`);
      result = { ok: false, error: error?.message ?? "Unknown error." };
    }
    this.options.logInfo(
      result.ok
        ? `${toolName} completed successfully.`
        : `${toolName} failed: ${result.error ?? "Unknown STARLIMS error."}`
    );

    return this.toToolResult(result, successMessageFactory);
  }

  private stringifyForLog(value: Record<string, unknown>): string {
    const serializedValue = JSON.stringify(value);
    if (!serializedValue) {
      return "";
    }

    return serializedValue.length > 500 ? `${serializedValue.slice(0, 497)}...` : serializedValue;
  }

  private toToolResult(
    result: StarlimsAutomationResult,
    successMessageFactory: (result: StarlimsAutomationResult) => string
  ) {
    let text = result.ok ? successMessageFactory(result) : result.error ?? "STARLIMS operation failed.";
    // Append warning to visible text if present (always meaningful for AI agents)
    if (result.warning) {
      text += `\nWARNING: ${result.warning}`;
    }
    // Append info/note to visible text if present
    if (result.info) {
      text += `\n${result.info}`;
    } else if (result.note) {
      text += `\nNote: ${result.note}`;
    }
    // Make truncation visible — a cut-off result must not look complete
    if (result.truncated === true) {
      text += `\n${this.formatTruncationNote(result)}`;
    }
    // Include the full payload in the visible text so clients that only read
    // content[].text (opencode, Claude Desktop, generic aggregators) receive
    // the actual items/code/output instead of just a summary.
    if (result.ok && this.options.getIncludeStructuredDataInText()) {
      const serialized = this.serializeResultForText(result);
      if (serialized) {
        text += `\n\n--- Structured result ---\n${serialized}`;
      }
    }

    return {
      content: [
        {
          text,
          type: "text" as const
        }
      ],
      isError: !result.ok,
      structuredContent: result
    };
  }

  private serializeResultForText(result: StarlimsAutomationResult): string {
    try {
      return JSON.stringify(result);
    } catch (error) {
      this.options.logError("Failed to serialize STARLIMS MCP tool result for text content.", error);
      return "";
    }
  }

  private formatTruncationNote(result: StarlimsAutomationResult): string {
    const limit = this.toCount(result.maxCharacters) || this.toCount(result.limit) || this.toCount(result.maxLines);
    const total = this.toCount(result.totalCharacters) || this.toCount(result.totalItems) || this.toCount(result.totalLines);
    const range = limit > 0 && total > 0
      ? `${limit} of ${total}`
      : limit > 0
        ? String(limit)
        : total > 0
          ? String(total)
          : undefined;
    return `TRUNCATED: the result was cut off${range ? ` (${range})` : ""}. Omit maxCharacters/maxItems or increase the limit to receive the full result.`;
  }

  private async runIntegrationTestsTool(reason: string | undefined, maxCharacters?: number) {
    const permission = await this.options.requestIntegrationTestPermission(reason);
    if (!permission.granted) {
      return this.toToolResult(
        {
          ok: false,
          error: permission.reason,
          permissionGranted: false,
          permissionRequired: true
        },
        (result) => result.error ?? "Integration test execution was not permitted."
      );
    }

    this.options.logInfo("run_integration_tests request accepted by user.");
    const result = await this.options.runIntegrationTests();
    const boundedOutput = this.limitTextOutput(this.getIntegrationTestOutput(result), maxCharacters);
    const structuredContent: StarlimsAutomationResult = {
      ...result,
      maxCharacters: boundedOutput.maxCharacters,
      output: boundedOutput.text,
      totalCharacters: boundedOutput.totalCharacters,
      truncated: boundedOutput.truncated
    };

    return this.toToolResult(
      structuredContent,
      (toolResult) => toolResult.ok
        ? `Integration tests completed successfully with ${this.toCount(toolResult.totalCharacters)} character(s) of captured output.`
        : toolResult.error ?? "Integration tests failed."
    );
  }

  private getIntegrationTestOutput(result: StarlimsAutomationResult): string {
    const sections: string[] = [];

    if (typeof result.command === "string" && result.command.length > 0) {
      sections.push(`Command: ${result.command}`);
    }

    if (typeof result.cwd === "string" && result.cwd.length > 0) {
      sections.push(`Working directory: ${result.cwd}`);
    }

    if (typeof result.stdout === "string" && result.stdout.length > 0) {
      sections.push(`STDOUT:\n${result.stdout}`);
    }

    if (typeof result.stderr === "string" && result.stderr.length > 0) {
      sections.push(`STDERR:\n${result.stderr}`);
    }

    return sections.join("\n\n").trim();
  }

  private limitTextOutput(text: string, maxCharacters?: number): {
    maxCharacters: number;
    text: string;
    totalCharacters: number;
    truncated: boolean;
  } {
    const totalCharacters = text.length;
    if (maxCharacters === undefined || !Number.isFinite(maxCharacters)) {
      return {
        maxCharacters: totalCharacters,
        text,
        totalCharacters,
        truncated: false
      };
    }

    const safeMax = Math.max(1, Math.floor(maxCharacters));
    return {
      maxCharacters: safeMax,
      text: text.length > safeMax ? text.slice(0, safeMax) : text,
      totalCharacters,
      truncated: text.length > safeMax
    };
  }

  private toUriLabel(uri: unknown): string {
    return typeof uri === "string" && uri.length > 0 ? uri : "the STARLIMS root";
  }
}