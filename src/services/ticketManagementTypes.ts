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