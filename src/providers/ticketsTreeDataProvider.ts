import * as vscode from "vscode";
import {
  TICKET_STATUS_GROUPS,
  TicketOverview,
  TicketReference,
  TicketStatusGroupName
} from "../services/ticketManagementTypes";

type TicketsTreeDataProviderOptions = {
  getActiveTicket: () => TicketReference | undefined;
  loadTickets: () => Promise<TicketOverview[]>;
};

export class TicketTreeItem extends vscode.TreeItem {
  public readonly children?: TicketTreeItem[];
  public readonly itemKind: "group" | "ticket" | "placeholder";
  public readonly statusGroupName?: TicketStatusGroupName;
  public readonly ticket?: TicketOverview;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    options?: {
      children?: TicketTreeItem[];
      itemKind?: "group" | "ticket" | "placeholder";
      statusGroupName?: TicketStatusGroupName;
      ticket?: TicketOverview;
    }
  ) {
    super(label, collapsibleState);
    this.children = options?.children;
    this.itemKind = options?.itemKind || "ticket";
    this.statusGroupName = options?.statusGroupName;
    this.ticket = options?.ticket;
  }
}

export class TicketsTreeDataProvider implements vscode.TreeDataProvider<TicketTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TicketTreeItem | null>();
  readonly onDidChangeTreeData: vscode.Event<TicketTreeItem | null> = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly options: TicketsTreeDataProviderOptions) { }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(null);
  }

  public getTreeItem(item: TicketTreeItem): vscode.TreeItem {
    return item;
  }

  public async getChildren(item?: TicketTreeItem): Promise<TicketTreeItem[]> {
    if (item) {
      return item.children ?? [];
    }

    try {
      const tickets = await this.options.loadTickets();
      const activeTicket = this.options.getActiveTicket();
      return this.createStatusGroupItems(tickets, activeTicket);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load tickets.";
      return [this.createPlaceholderItem(message)];
    }
  }

  private createStatusGroupItems(tickets: TicketOverview[], activeTicket: TicketReference | undefined): TicketTreeItem[] {
    return TICKET_STATUS_GROUPS.map((statusGroupName) => {
      const groupedTickets = tickets.filter((ticket) => ticket.statusGroupName === statusGroupName);
      const children = groupedTickets.map((ticket) => this.createTicketItem(ticket, activeTicket));
      const item = new TicketTreeItem(
        statusGroupName,
        children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        {
          children,
          itemKind: "group",
          statusGroupName
        }
      );

      item.contextValue = "ticketStatusGroup";
      item.description = String(groupedTickets.length);
      item.iconPath = this.getStatusGroupIcon(statusGroupName);
      item.tooltip = `${statusGroupName}: ${groupedTickets.length}`;
      return item;
    });
  }

  private createTicketItem(ticket: TicketOverview, activeTicket: TicketReference | undefined): TicketTreeItem {
    const isActiveTicket = activeTicket?.id === ticket.id;
    const label = `#${ticket.id} ${ticket.title}`;
    const item = new TicketTreeItem(label, vscode.TreeItemCollapsibleState.None, {
      itemKind: "ticket",
      ticket
    });
    const descriptionParts: string[] = [];

    if (ticket.assignedTo && ticket.assignedTo.trim().length > 0) {
      descriptionParts.push(ticket.assignedTo.trim());
    } else {
      descriptionParts.push("unassigned");
    }

    if (isActiveTicket) {
      descriptionParts.push("active");
    }

    item.description = descriptionParts.join(" | ");
    item.contextValue = isActiveTicket ? "activeTicket" : "ticket";
    item.iconPath = new vscode.ThemeIcon(isActiveTicket ? "check" : "issues");
    item.tooltip = this.buildTooltip(ticket, isActiveTicket);
    item.command = {
      command: "STARLIMS.SelectActiveTicket",
      title: "Use ticket for STARLIMS check-in",
      arguments: [item]
    };

    return item;
  }

  private buildTooltip(ticket: TicketOverview, isActiveTicket: boolean): string {
    const normalizedDescription = (ticket.fullDescription || "").replace(/\r\n/g, "\n").trim();
    const lines = [
      `Ticket #${ticket.id}`,
      ticket.title,
      ""
    ];

    if (normalizedDescription) {
      lines.push("Description:", normalizedDescription, "");
    }

    lines.push(
      `Status: ${ticket.statusName}`,
      `Assigned to: ${ticket.assignedTo && ticket.assignedTo.trim().length > 0 ? ticket.assignedTo : "Unassigned"}`
    );

    if (ticket.typeName) {
      lines.push(`Type: ${ticket.typeName}`);
    }

    if (ticket.priorityName) {
      lines.push(`Priority: ${ticket.priorityName}`);
    }

    if (ticket.author) {
      lines.push(`Author: ${ticket.author}`);
    }

    if (ticket.modifiedOn) {
      lines.push(`Modified: ${ticket.modifiedOn}`);
    }

    if (isActiveTicket) {
      lines.push("", "Used for STARLIMS check-in and Git commit messages.");
    }

    return lines.join("\n");
  }

  private getStatusGroupIcon(statusGroupName: TicketStatusGroupName): vscode.ThemeIcon {
    switch (statusGroupName) {
      case "Fertig":
        return new vscode.ThemeIcon("pass");
      case "Zurückgestellt":
        return new vscode.ThemeIcon("history");
      case "In Bearbeitung":
        return new vscode.ThemeIcon("tools");
      case "In Prüfung":
        return new vscode.ThemeIcon("eye");
      case "Offen":
      default:
        return new vscode.ThemeIcon("issues");
    }
  }

  private createPlaceholderItem(message: string): TicketTreeItem {
    const item = new TicketTreeItem(message, vscode.TreeItemCollapsibleState.None, {
      itemKind: "placeholder"
    });
    item.contextValue = "ticketPlaceholder";
    item.iconPath = new vscode.ThemeIcon("info");
    item.tooltip = message;
    return item;
  }
}