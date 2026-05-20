import * as vscode from "vscode";
import {
  TICKET_STATUS_GROUPS,
  TicketOverview,
  TicketReference,
  TicketStatusGroupName
} from "../services/ticketManagementTypes";

type TicketsTreeDataProviderOptions = {
  getActiveTicket: () => TicketReference | undefined;
  getCurrentUser: () => string;
  loadTickets: () => Promise<TicketOverview[]>;
  loadTicketDescription: (ticketId: number, stackTraceId: number | undefined) => Promise<string | undefined>;
};

export class TicketTreeItem extends vscode.TreeItem {
  public children?: TicketTreeItem[];
  public readonly itemKind: "group" | "ticket" | "placeholder";
  public readonly statusGroupName?: TicketStatusGroupName;
  public readonly ticket?: TicketOverview;
  public parent?: TicketTreeItem;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    options?: {
      children?: TicketTreeItem[];
      itemKind?: "group" | "ticket" | "placeholder";
      statusGroupName?: TicketStatusGroupName;
      ticket?: TicketOverview;
      parent?: TicketTreeItem;
      id?: string;
    }
  ) {
    super(label, collapsibleState);
    this.children = options?.children;
    this.itemKind = options?.itemKind || "ticket";
    this.statusGroupName = options?.statusGroupName;
    this.ticket = options?.ticket;
    this.parent = options?.parent;
    this.id = options?.id;
  }
}

export class TicketsTreeDataProvider implements vscode.TreeDataProvider<TicketTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TicketTreeItem | null>();
  readonly onDidChangeTreeData: vscode.Event<TicketTreeItem | null> = this.onDidChangeTreeDataEmitter.event;
  private readonly descriptionCache = new Map<number, string | undefined>();
  private readonly pendingDescriptionLoads = new Map<number, Promise<string | undefined>>();
  private rootItems: TicketTreeItem[] = [];
  private pendingRootItemsLoad: Promise<TicketTreeItem[]> | undefined;
  private hasLoadedRootItems = false;
  private titleFilter = "";

  constructor(private readonly options: TicketsTreeDataProviderOptions) { }

  public refresh(): void {
    this.descriptionCache.clear();
    this.pendingDescriptionLoads.clear();
    this.rootItems = [];
    this.pendingRootItemsLoad = undefined;
    this.hasLoadedRootItems = false;
    this.onDidChangeTreeDataEmitter.fire(null);
  }

  public getTreeItem(item: TicketTreeItem): vscode.TreeItem {
    return item;
  }

  public getParent(item: TicketTreeItem): TicketTreeItem | undefined {
    return item.parent;
  }

  public getTitleFilterText(): string {
    return this.titleFilter;
  }

  public setTitleFilter(filterText: string | undefined): void {
    const normalizedFilter = (filterText || "").trim();
    if (normalizedFilter === this.titleFilter) {
      return;
    }

    this.titleFilter = normalizedFilter;
    this.onDidChangeTreeDataEmitter.fire(null);
  }

  public async resolveTreeItem(item: TicketTreeItem, _element: TicketTreeItem, token: vscode.CancellationToken): Promise<TicketTreeItem> {
    if (item.itemKind !== "ticket" || !item.ticket) {
      return item;
    }

    const ticket = item.ticket;
    if (ticket.fullDescription === undefined) {
      ticket.fullDescription = await this.loadDescription(ticket.id, ticket.stackTraceId);
    }

    if (token.isCancellationRequested) {
      return item;
    }

    const ticketState = this.getTicketState(ticket);
    item.tooltip = this.buildTooltip(ticket, ticketState.isActiveTicket, ticketState.isLockedByOtherUser, ticketState.isInProgressByCurrentUser);
    return item;
  }

  public async getChildren(item?: TicketTreeItem): Promise<TicketTreeItem[]> {
    if (item) {
      return item.children ?? [];
    }

    return this.getRootItems();
  }

  public async findStatusGroupItem(statusGroupName: TicketStatusGroupName): Promise<TicketTreeItem | undefined> {
    const rootItems = await this.getRootItems();
    return rootItems.find((item) => item.statusGroupName === statusGroupName);
  }

  public async findTicketItem(ticketId: number): Promise<TicketTreeItem | undefined> {
    const rootItems = await this.getRootItems();
    for (const groupItem of rootItems) {
      const matchingTicketItem = groupItem.children?.find((child) => child.ticket?.id === ticketId);
      if (matchingTicketItem) {
        return matchingTicketItem;
      }
    }

    return undefined;
  }

  private async getRootItems(): Promise<TicketTreeItem[]> {
    if (this.hasLoadedRootItems) {
      return this.rootItems;
    }

    if (this.pendingRootItemsLoad) {
      return this.pendingRootItemsLoad;
    }

    this.pendingRootItemsLoad = (async () => {
      try {
        const tickets = await this.options.loadTickets();
        const activeTicket = this.options.getActiveTicket();
        const currentUser = this.options.getCurrentUser();
        this.rootItems = this.createStatusGroupItems(tickets, activeTicket, currentUser);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not load tickets.";
        this.rootItems = [this.createPlaceholderItem(message)];
      } finally {
        this.hasLoadedRootItems = true;
        this.pendingRootItemsLoad = undefined;
      }

      return this.rootItems;
    })();

    return this.pendingRootItemsLoad;
  }

  private createStatusGroupItems(tickets: TicketOverview[], activeTicket: TicketReference | undefined, currentUser: string): TicketTreeItem[] {
    const hasActiveTitleFilter = this.titleFilter.length > 0;
    const visibleTickets = this.applyTitleFilter(tickets);

    if (hasActiveTitleFilter && visibleTickets.length === 0) {
      return [this.createPlaceholderItem(`No tickets match "${this.titleFilter}".`)];
    }

    return TICKET_STATUS_GROUPS
      .map((statusGroupName) => {
        const groupedTickets = visibleTickets.filter((ticket) => ticket.statusGroupName === statusGroupName);
        const children = groupedTickets.map((ticket) => this.createTicketItem(ticket, activeTicket, currentUser));
        const item = new TicketTreeItem(
          statusGroupName,
          children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
          {
            children,
            itemKind: "group",
            statusGroupName,
            id: `ticketStatusGroup:${statusGroupName}`
          }
        );

        for (const child of children) {
          child.parent = item;
        }

        item.contextValue = "ticketStatusGroup";
        item.description = String(groupedTickets.length);
        item.iconPath = this.getStatusGroupIcon(statusGroupName);
        item.tooltip = `${statusGroupName}: ${groupedTickets.length}`;
        return item;
      })
      .filter((groupItem) => !hasActiveTitleFilter || (groupItem.children?.length ?? 0) > 0);
  }

  private applyTitleFilter(tickets: TicketOverview[]): TicketOverview[] {
    if (!this.titleFilter) {
      return tickets;
    }

    const normalizedFilter = this.titleFilter.toLocaleLowerCase();
    return tickets.filter((ticket) => (ticket.title || "").toLocaleLowerCase().includes(normalizedFilter));
  }

  private createTicketItem(ticket: TicketOverview, activeTicket: TicketReference | undefined, currentUser: string): TicketTreeItem {
    const ticketState = this.getTicketState(ticket, activeTicket, currentUser);
    const { isActiveTicket, isLockedByOtherUser, isInProgressByCurrentUser } = ticketState;
    const label = `#${ticket.id} ${ticket.title}`;
    const item = new TicketTreeItem(label, vscode.TreeItemCollapsibleState.None, {
      itemKind: "ticket",
      ticket,
      id: `ticket:${ticket.id}`
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
    item.contextValue = isActiveTicket 
      ? "activeTicket" 
      : (isLockedByOtherUser 
        ? "lockedTicket" 
        : (isInProgressByCurrentUser ? "ticketInProgressByCurrentUser" : "ticket"));
    item.iconPath = isLockedByOtherUser 
      ? new vscode.ThemeIcon("lock", new vscode.ThemeColor("errorForeground"))
      : isInProgressByCurrentUser
      ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("terminal.ansiGreen"))
      : new vscode.ThemeIcon(isActiveTicket ? "check-all" : "issues");

    // Reuse the same URI decoration scheme as checked-out items so label text color matches.
    if (isInProgressByCurrentUser) {
      item.resourceUri = vscode.Uri.parse("starlims:/checkedOutByMe");
    } else if (isLockedByOtherUser) {
      item.resourceUri = vscode.Uri.parse("starlims:/checkedOutByOtherUser");
    }
    
    // Highlight active ticket and color own in-progress tickets green
    if (isActiveTicket && !isInProgressByCurrentUser) {
      item.label = {
        label: label,
        highlights: [[0, label.length]]
      };
    } else if (isLockedByOtherUser) {
      // Add visual indicator for locked tickets (no highlighting)
      item.label = `🔒 ${label}`;
    } else if (isInProgressByCurrentUser) {
      // Add green indicator for own in-progress tickets (no highlighting)
      item.label = `✓ ${label}`;
    }
    
    // Leave tooltip unresolved so VS Code invokes resolveTreeItem on hover.
    item.tooltip = undefined;
    return item;
  }

  private getTicketState(
    ticket: TicketOverview,
    activeTicket: TicketReference | undefined = this.options.getActiveTicket(),
    currentUser: string = this.options.getCurrentUser()
  ): { isActiveTicket: boolean; isLockedByOtherUser: boolean; isInProgressByCurrentUser: boolean } {
    const normalizedCurrentUser = currentUser.trim();
    const normalizedAssignedTo = (ticket.assignedTo || "").trim();
    const isInProgressStatus = ticket.statusGroupName === "In Bearbeitung";
    const isActiveTicket = activeTicket?.id === ticket.id;
    const isLockedByOtherUser = !!(isInProgressStatus && normalizedAssignedTo.length > 0 && normalizedAssignedTo !== normalizedCurrentUser);
    const isInProgressByCurrentUser = !!(isInProgressStatus && normalizedAssignedTo.length > 0 && normalizedAssignedTo === normalizedCurrentUser);

    return {
      isActiveTicket,
      isLockedByOtherUser,
      isInProgressByCurrentUser
    };
  }

  private async loadDescription(ticketId: number, stackTraceId: number | undefined): Promise<string | undefined> {
    if (this.descriptionCache.has(ticketId)) {
      return this.descriptionCache.get(ticketId);
    }

    const pendingRequest = this.pendingDescriptionLoads.get(ticketId);
    if (pendingRequest) {
      return pendingRequest;
    }

    const request = this.options
      .loadTicketDescription(ticketId, stackTraceId)
      .then((description) => {
        this.descriptionCache.set(ticketId, description);
        return description;
      })
      .catch(() => undefined)
      .finally(() => {
        this.pendingDescriptionLoads.delete(ticketId);
      });

    this.pendingDescriptionLoads.set(ticketId, request);
    return request;
  }

  private buildTooltip(ticket: TicketOverview, isActiveTicket: boolean, isLockedByOtherUser: boolean = false, isInProgressByCurrentUser: boolean = false): string {
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

    if (isLockedByOtherUser) {
      lines.push("", "⚠️ This ticket is currently being worked on by " + (ticket.assignedTo || "another user") + ".");
      lines.push("You cannot undertake this ticket until it is released by the current assignee.");
    }

    if (isInProgressByCurrentUser && !isActiveTicket) {
      lines.push("", "✓ You are currently working on this ticket.");
      lines.push("You can use 'Undertake Ticket' to make it the active ticket for check-in and Git commits.");
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