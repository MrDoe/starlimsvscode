export type RemoteScriptOutputType = "ARRAY" | "JSON" | "XML";

export type RemoteScriptExecutionOptions = {
  parameters?: unknown[];
  outputType?: RemoteScriptOutputType;
  entryPoint?: string;
};

export const TICKET_STATUS_GROUPS = [
  "Offen",
  "Fertig",
  "Zurückgestellt",
  "In Bearbeitung",
  "In Prüfung"
] as const;

export type TicketStatusGroupName = typeof TICKET_STATUS_GROUPS[number];

export type TicketOverview = {
  id: number;
  title: string;
  statusName: string;
  statusGroupName: TicketStatusGroupName;
  statusCode?: number;
  typeName?: string;
  priorityName?: string;
  severityName?: string;
  author?: string;
  assignedTo?: string;
  fullDescription?: string;
  stackTraceId?: number;
  createdOn?: string;
  modifiedOn?: string;
  dueOn?: string;
  reportCount?: number;
  isAdminTicket?: boolean;
};

export type TicketReference = {
  id: number;
  title: string;
  statusName?: string;
  typeName?: string;
  priorityName?: string;
  assignedTo?: string;
  serverName?: string;
};

export type TicketMeasureDraft = {
  title: string;
  description: string;
};

export type TicketDataDetails = {
  description: string;
  stackTrace: string;
};

export type TicketFullInfo = TicketDataDetails & {
  comments: string;
};

/** One row of a BMBH_TICKET_* lookup dictionary (status, type, priority, severity). */
export type TicketLookupOption = {
  code: number;
  name: string;
};

/** All ticket lookup dictionaries, used to resolve human names to the numeric codes the ticket scripts expect. */
export type TicketLookupData = {
  statuses: TicketLookupOption[];
  types: TicketLookupOption[];
  priorities: TicketLookupOption[];
  severities: TicketLookupOption[];
};

/** One change-history row of a ticket (BMBH_TICKET_TXN_SET joined with BMBH_TICKET_TXN). */
export type TicketHistoryEntry = {
  changedField?: string;
  oldValue?: string;
  newValue?: string;
  changedOn?: string;
  modifiedBy?: string;
};

/** Client-side filter for listing tickets (see StarlimsAutomationService.listTickets). */
export type TicketListFilter = {
  /** Match the assigned-to user case-insensitively. Ignored when `mine` is set. */
  assignedTo?: string;
  /** Restrict to tickets assigned to the currently logged-in STARLIMS user. */
  mine?: boolean;
  /** Status group name (German), for example "In Bearbeitung" or "Fertig". */
  statusGroup?: string;
  /** Exact status name, umlaut- and case-insensitive. */
  status?: string;
  /** Case-insensitive substring match on the ticket title. */
  titleContains?: string;
  /** Omit tickets older than this many days (based on MODIFIEDON). */
  modifiedWithinDays?: number;
  /** Maximum number of tickets to return. */
  maxItems?: number;
};