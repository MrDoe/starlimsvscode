import * as vscode from "vscode";
import { getNonce } from "../utilities/getNonce";
import { getUri } from "../utilities/getUri";
import { EnterpriseService } from "../services/enterpriseService";
import { TicketComment, TicketMeasure, TicketReference } from "../services/ticketManagementTypes";

/** One measure as rendered by the webview (dates already formatted). */
type TicketMeasureCard = {
  id: number;
  title: string;
  description: string;
  status: string;
  finishedAt: string;
};

/** One comment as rendered by the webview (dates already formatted). */
type TicketCommentCard = {
  id: number;
  text: string;
  author: string;
  createdAt: string;
};

/** Payload sent to the webview for rendering. */
type TicketActivityPayload = {
  ticket: {
    id: number;
    title: string;
    statusName: string;
    assignedTo: string;
    serverName: string;
  };
  measures: TicketMeasureCard[];
  comments: TicketCommentCard[];
  measuresError?: string;
  commentsError?: string;
};

/**
 * Webview panel showing the activity of one ticket: the measures recorded for it
 * (what was actually done) and its comment thread. Both lists can be added to,
 * edited and deleted - a measure or a comment is addressed by its id.
 */
export class TicketActivityPanel {
  private static readonly panels = new Map<number, TicketActivityPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _enterpriseService: EnterpriseService;
  private readonly _ticket: TicketReference;
  private _saving = false;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    enterpriseService: EnterpriseService,
    ticket: TicketReference
  ) {
    this._panel = panel;
    this._enterpriseService = enterpriseService;
    this._ticket = ticket;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);
    this._setWebviewMessageListener(this._panel.webview);
    this._panel.onDidChangeViewState(
      (event) => {
        if (event.webviewPanel.visible) {
          void this.postActivity();
        }
      },
      null,
      this._disposables
    );
  }

  /** Opens the panel of a ticket, or reveals and refreshes the existing one. */
  public static render(
    extensionUri: vscode.Uri,
    enterpriseService: EnterpriseService,
    ticket: TicketReference
  ): void {
    const existing = TicketActivityPanel.panels.get(ticket.id);
    if (existing) {
      existing._panel.reveal(vscode.ViewColumn.One);
      void existing.postActivity();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "starlims-ticket-activity",
      TicketActivityPanel.panelTitle(ticket),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")]
      }
    );

    TicketActivityPanel.panels.set(
      ticket.id,
      new TicketActivityPanel(panel, extensionUri, enterpriseService, ticket)
    );
  }

  /** Refreshes the panel of a ticket when it is open (for example after a check-in added a measure). */
  public static refreshIfOpen(ticketId: number | undefined): void {
    if (!ticketId) {
      return;
    }

    const panel = TicketActivityPanel.panels.get(ticketId);
    if (panel) {
      void panel.postActivity();
    }
  }

  public dispose() {
    if (TicketActivityPanel.panels.get(this._ticket.id) === this) {
      TicketActivityPanel.panels.delete(this._ticket.id);
    }

    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private static panelTitle(ticket: TicketReference): string {
    const shortTitle = (ticket.title || "").trim();
    const clipped = shortTitle.length > 40 ? `${shortTitle.slice(0, 37)}...` : shortTitle;
    return clipped.length > 0
      ? `#${ticket.id} measures & comments - ${clipped}`
      : `Ticket #${ticket.id} measures & comments`;
  }

  /** DATE_FINISHED arrives as "2026-10-16T09:26:36.360+02:00" (or "2026-10-16 09:26:36.360000"); show a locale date/time when parseable. */
  private static formatTimestamp(value: string | undefined): string {
    const normalized = (value || "").trim();
    if (!normalized) {
      return "";
    }

    const withoutFraction = normalized.replace(/\.\d+/, "");
    const timestamp = Date.parse(withoutFraction.replace(" ", "T"));
    if (!Number.isFinite(timestamp)) {
      return withoutFraction;
    }

    return new Date(timestamp).toLocaleString();
  }

  private static toMeasureCard(measure: TicketMeasure): TicketMeasureCard {
    return {
      id: measure.id,
      title: measure.title || "Measure",
      description: measure.description || "",
      status: measure.status || "",
      finishedAt: TicketActivityPanel.formatTimestamp(measure.dateFinished)
    };
  }

  private static toCommentCard(comment: TicketComment): TicketCommentCard {
    return {
      id: comment.id,
      text: comment.text || "",
      author: comment.author || "",
      createdAt: TicketActivityPanel.formatTimestamp(comment.createdOn)
    };
  }

  /** Loads the measures and comments of the ticket and pushes them to the webview. */
  private async postActivity(): Promise<void> {
    const serverName = this._enterpriseService.getCurrentServerName() || "";
    const payload: TicketActivityPayload = {
      ticket: {
        id: this._ticket.id,
        title: this._ticket.title || "",
        statusName: this._ticket.statusName || "",
        assignedTo: this._ticket.assignedTo || "",
        serverName
      },
      measures: [],
      comments: []
    };

    const [measuresResult, commentsResult] = await Promise.all([
      this._enterpriseService.getTicketMeasuresResult(this._ticket.id),
      this._enterpriseService.getTicketCommentsResult(this._ticket.id)
    ]);

    if (!measuresResult.ok) {
      payload.measuresError = `${measuresResult.error ?? `Could not retrieve measures for ticket #${this._ticket.id}.`} A SCM_API backend with TicketManagement.GetTicketMeasures is required; the extension installs it automatically on activation, so reload the window if this error persists.`;
    } else {
      payload.measures = (measuresResult.data ?? []).map(TicketActivityPanel.toMeasureCard);
    }

    if (!commentsResult.ok) {
      payload.commentsError = `${commentsResult.error ?? `Could not retrieve comments for ticket #${this._ticket.id}.`} A SCM_API backend with TicketManagement.GetTicketComments is required; the extension installs it automatically on activation, so reload the window if this error persists.`;
    } else {
      payload.comments = (commentsResult.data ?? []).map(TicketActivityPanel.toCommentCard);
    }

    void this._panel.webview.postMessage({
      command: "receiveActivity",
      payload: JSON.stringify(payload)
    });
  }

  private parsePayload(rawPayload: unknown): Record<string, unknown> {
    try {
      const parsed = JSON.parse(String(rawPayload ?? "{}"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private postError(message: string): void {
    void this._panel.webview.postMessage({
      command: "activityError",
      payload: JSON.stringify({ message })
    });
  }

  /** Adds a measure to the ticket, then reloads the list. */
  private async addMeasure(rawPayload: unknown): Promise<void> {
    if (this._saving) {
      return;
    }

    const parsed = this.parsePayload(rawPayload);
    const title = String(parsed.title ?? "").trim();
    const description = String(parsed.description ?? "").trim();

    if (!title) {
      this.postError("The measure title cannot be empty.");
      return;
    }

    this._saving = true;
    try {
      const measureResult = await this._enterpriseService.addTicketMeasureResult(
        this._ticket.id,
        title,
        description
      );

      if (!measureResult.ok) {
        const message = measureResult.error ?? `Could not add a measure to ticket #${this._ticket.id}.`;
        void vscode.window.showErrorMessage(message);
        this.postError(message);
        return;
      }

      void vscode.window.showInformationMessage(
        `Added measure ${measureResult.data} to ticket #${this._ticket.id}.`
      );
      await this.postActivity();
    } finally {
      this._saving = false;
    }
  }

  /** Changes the title and description of an existing measure. */
  private async updateMeasure(rawPayload: unknown): Promise<void> {
    if (this._saving) {
      return;
    }

    const parsed = this.parsePayload(rawPayload);
    const measureId = Number(parsed.id);
    const title = String(parsed.title ?? "").trim();
    const description = String(parsed.description ?? "").trim();

    if (!Number.isFinite(measureId) || measureId <= 0) {
      this.postError("The measure to update is unknown - refresh the panel and try again.");
      return;
    }

    if (!title) {
      this.postError("The measure title cannot be empty.");
      return;
    }

    this._saving = true;
    try {
      const measureResult = await this._enterpriseService.updateTicketMeasureResult(
        this._ticket.id,
        measureId,
        title,
        description
      );

      if (!measureResult.ok) {
        const message = measureResult.error ?? `Could not update measure ${measureId} of ticket #${this._ticket.id}.`;
        void vscode.window.showErrorMessage(message);
        this.postError(message);
        return;
      }

      void vscode.window.showInformationMessage(
        `Updated measure ${measureId} of ticket #${this._ticket.id}.`
      );
      await this.postActivity();
    } finally {
      this._saving = false;
    }
  }

  /** Deletes a measure after the user confirmed the deletion. */
  private async deleteMeasure(rawPayload: unknown): Promise<void> {
    if (this._saving) {
      return;
    }

    const parsed = this.parsePayload(rawPayload);
    const measureId = Number(parsed.id);
    if (!Number.isFinite(measureId) || measureId <= 0) {
      this.postError("The measure to delete is unknown - refresh the panel and try again.");
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Delete measure ${measureId} of ticket #${this._ticket.id}? This cannot be undone.`,
      { modal: true },
      "Delete"
    );
    if (confirmation !== "Delete") {
      return;
    }

    this._saving = true;
    try {
      const measureResult = await this._enterpriseService.deleteTicketMeasureResult(
        this._ticket.id,
        measureId
      );

      if (!measureResult.ok) {
        const message = measureResult.error ?? `Could not delete measure ${measureId} of ticket #${this._ticket.id}.`;
        void vscode.window.showErrorMessage(message);
        this.postError(message);
        return;
      }

      void vscode.window.showInformationMessage(
        `Deleted measure ${measureId} of ticket #${this._ticket.id}.`
      );
      await this.postActivity();
    } finally {
      this._saving = false;
    }
  }

  /** Adds a comment to the ticket thread, then reloads the list. */
  private async addComment(rawPayload: unknown): Promise<void> {
    if (this._saving) {
      return;
    }

    const parsed = this.parsePayload(rawPayload);
    const text = String(parsed.text ?? "").trim();
    const author = String(parsed.author ?? "").trim();

    if (!text) {
      this.postError("The comment text cannot be empty.");
      return;
    }

    this._saving = true;
    try {
      const commentResult = await this._enterpriseService.insertTicketCommentResult(
        this._ticket.id,
        text,
        author || this._enterpriseService.getCurrentUser()
      );

      if (!commentResult.ok) {
        const message = commentResult.error ?? `Could not add a comment to ticket #${this._ticket.id}.`;
        void vscode.window.showErrorMessage(message);
        this.postError(message);
        return;
      }

      void vscode.window.showInformationMessage(
        `Added a comment to ticket #${this._ticket.id}.`
      );
      await this.postActivity();
    } finally {
      this._saving = false;
    }
  }

  /** Changes the text of an existing comment (author and date stay untouched). */
  private async updateComment(rawPayload: unknown): Promise<void> {
    if (this._saving) {
      return;
    }

    const parsed = this.parsePayload(rawPayload);
    const commentId = Number(parsed.id);
    const text = String(parsed.text ?? "").trim();

    if (!Number.isFinite(commentId) || commentId <= 0) {
      this.postError("The comment to update is unknown - refresh the panel and try again.");
      return;
    }

    if (!text) {
      this.postError("The comment text cannot be empty.");
      return;
    }

    this._saving = true;
    try {
      const commentResult = await this._enterpriseService.updateTicketCommentResult(
        this._ticket.id,
        commentId,
        text
      );

      if (!commentResult.ok) {
        const message = commentResult.error ?? `Could not update comment ${commentId} of ticket #${this._ticket.id}.`;
        void vscode.window.showErrorMessage(message);
        this.postError(message);
        return;
      }

      void vscode.window.showInformationMessage(
        `Updated comment ${commentId} of ticket #${this._ticket.id}.`
      );
      await this.postActivity();
    } finally {
      this._saving = false;
    }
  }

  /** Deletes a comment after the user confirmed the deletion. */
  private async deleteComment(rawPayload: unknown): Promise<void> {
    if (this._saving) {
      return;
    }

    const parsed = this.parsePayload(rawPayload);
    const commentId = Number(parsed.id);
    if (!Number.isFinite(commentId) || commentId <= 0) {
      this.postError("The comment to delete is unknown - refresh the panel and try again.");
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Delete comment ${commentId} of ticket #${this._ticket.id}? This cannot be undone.`,
      { modal: true },
      "Delete"
    );
    if (confirmation !== "Delete") {
      return;
    }

    this._saving = true;
    try {
      const commentResult = await this._enterpriseService.deleteTicketCommentResult(
        this._ticket.id,
        commentId
      );

      if (!commentResult.ok) {
        const message = commentResult.error ?? `Could not delete comment ${commentId} of ticket #${this._ticket.id}.`;
        void vscode.window.showErrorMessage(message);
        this.postError(message);
        return;
      }

      void vscode.window.showInformationMessage(
        `Deleted comment ${commentId} of ticket #${this._ticket.id}.`
      );
      await this.postActivity();
    } finally {
      this._saving = false;
    }
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (message: { command?: string; payload?: unknown }) => {
        switch (message.command) {
          case "requestData":
          case "refreshActivity":
            await this.postActivity();
            break;

          case "addMeasure":
            await this.addMeasure(message.payload);
            break;

          case "updateMeasure":
            await this.updateMeasure(message.payload);
            break;

          case "deleteMeasure":
            await this.deleteMeasure(message.payload);
            break;

          case "addComment":
            await this.addComment(message.payload);
            break;

          case "updateComment":
            await this.updateComment(message.payload);
            break;

          case "deleteComment":
            await this.deleteComment(message.payload);
            break;
        }
      },
      undefined,
      this._disposables
    );
  }

  private _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const styleUri = getUri(webview, extensionUri, ["dist", "style.css"]);
    const ticketLine = this.escapeXml(
      `#${this._ticket.id} ${this._ticket.title || ""}`.trim()
    );
    const metaParts = [
      this._ticket.statusName ? `Status: ${this._ticket.statusName}` : "",
      this._ticket.assignedTo ? `Assigned to: ${this._ticket.assignedTo}` : "unassigned",
      this._ticket.serverName ? `Server: ${this._ticket.serverName}` : ""
    ].filter((part) => part.length > 0);
    const currentUser = this.escapeXml(this._enterpriseService.getCurrentUser() || "");

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Ticket measures and comments</title>
</head>
<body>
  <div id="activity-app">
    <div class="tm-header">
      <div>
        <h1 id="activity-ticket">${ticketLine}</h1>
        <div class="tm-meta">${this.escapeXml(metaParts.join(" | "))}</div>
      </div>
      <div class="tm-actions">
        <button id="add-measure-btn" class="tm-btn tm-btn-primary" type="button">+ Add measure</button>
        <button id="add-comment-btn" class="tm-btn tm-btn-primary" type="button">+ Add comment</button>
        <button id="refresh-activity-btn" class="tm-btn tm-btn-secondary" type="button">Refresh</button>
      </div>
    </div>

    <section class="tm-section" id="measure-form" hidden>
      <div class="tm-section-header"><h2 id="measure-form-title">New measure</h2></div>
      <label class="tm-label" for="measure-title">Title</label>
      <input class="tm-input" type="text" id="measure-title" maxlength="255"
        placeholder="What was done, in one line (becomes the measure title)" />
      <label class="tm-label" for="measure-description">Description</label>
      <textarea class="tm-input tm-textarea" id="measure-description" rows="6"
        placeholder="Details: changes, items touched, open follow-ups..."></textarea>
      <div class="tm-form-actions">
        <button id="measure-save-btn" class="tm-btn tm-btn-primary" type="button">Save measure</button>
        <button id="measure-cancel-btn" class="tm-btn tm-btn-secondary" type="button">Cancel</button>
      </div>
    </section>

    <section class="tm-section" id="comment-form" hidden>
      <div class="tm-section-header"><h2 id="comment-form-title">New comment</h2></div>
      <label class="tm-label" for="comment-text">Comment</label>
      <textarea class="tm-input tm-textarea" id="comment-text" rows="6"
        placeholder="Question, status update or information for the ticket author..."></textarea>
      <label class="tm-label" for="comment-author">Author</label>
      <input class="tm-input" type="text" id="comment-author" maxlength="40" value="${currentUser}" />
      <div class="tm-form-actions">
        <button id="comment-save-btn" class="tm-btn tm-btn-primary" type="button">Save comment</button>
        <button id="comment-cancel-btn" class="tm-btn tm-btn-secondary" type="button">Cancel</button>
      </div>
    </section>

    <p id="activity-status" class="tm-status" aria-live="polite">Loading measures and comments...</p>

    <section class="tm-section">
      <div class="tm-section-header"><h2>Measures (<span id="measure-count">0</span>)</h2></div>
      <div id="measures-list"></div>
    </section>

    <section class="tm-section">
      <div class="tm-section-header"><h2>Comments (<span id="comment-count">0</span>)</h2></div>
      <div id="comments-list"></div>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const statusElement = document.getElementById("activity-status");
    const measureListElement = document.getElementById("measures-list");
    const commentListElement = document.getElementById("comments-list");
    const measureCountElement = document.getElementById("measure-count");
    const commentCountElement = document.getElementById("comment-count");
    const measureFormElement = document.getElementById("measure-form");
    const measureFormTitleElement = document.getElementById("measure-form-title");
    const measureTitleElement = document.getElementById("measure-title");
    const measureDescriptionElement = document.getElementById("measure-description");
    const measureSaveButton = document.getElementById("measure-save-btn");
    const measureCancelButton = document.getElementById("measure-cancel-btn");
    const commentFormElement = document.getElementById("comment-form");
    const commentFormTitleElement = document.getElementById("comment-form-title");
    const commentTextElement = document.getElementById("comment-text");
    const commentAuthorElement = document.getElementById("comment-author");
    const commentSaveButton = document.getElementById("comment-save-btn");
    const commentCancelButton = document.getElementById("comment-cancel-btn");
    const addMeasureButton = document.getElementById("add-measure-btn");
    const addCommentButton = document.getElementById("add-comment-btn");
    const refreshButton = document.getElementById("refresh-activity-btn");

    let editingMeasureId = 0;
    let editingCommentId = 0;
    let measures = [];
    let comments = [];

    function setStatus(text, isError) {
      if (!statusElement) {
        return;
      }
      statusElement.textContent = text || "";
      statusElement.classList.toggle("tm-status-error", isError === true);
    }

    function setMeasureFormVisible(visible) {
      if (!measureFormElement) {
        return;
      }
      measureFormElement.hidden = !visible;
      if (visible && measureTitleElement) {
        measureTitleElement.focus();
      }
    }

    function setCommentFormVisible(visible) {
      if (!commentFormElement) {
        return;
      }
      commentFormElement.hidden = !visible;
      if (visible && commentTextElement) {
        commentTextElement.focus();
      }
    }

    function clearMeasureForm() {
      editingMeasureId = 0;
      if (measureTitleElement) {
        measureTitleElement.value = "";
      }
      if (measureDescriptionElement) {
        measureDescriptionElement.value = "";
      }
      if (measureFormTitleElement) {
        measureFormTitleElement.textContent = "New measure";
      }
      if (measureSaveButton) {
        measureSaveButton.disabled = false;
        measureSaveButton.textContent = "Save measure";
      }
    }

    function clearCommentForm() {
      editingCommentId = 0;
      if (commentTextElement) {
        commentTextElement.value = "";
      }
      if (commentFormTitleElement) {
        commentFormTitleElement.textContent = "New comment";
      }
      if (commentSaveButton) {
        commentSaveButton.disabled = false;
        commentSaveButton.textContent = "Save comment";
      }
    }

    function openMeasureForm(measure) {
      clearMeasureForm();
      if (measure) {
        editingMeasureId = measure.id;
        if (measureTitleElement) {
          measureTitleElement.value = measure.title || "";
        }
        if (measureDescriptionElement) {
          measureDescriptionElement.value = measure.description || "";
        }
        if (measureFormTitleElement) {
          measureFormTitleElement.textContent = "Edit measure " + measure.id;
        }
        if (measureSaveButton) {
          measureSaveButton.textContent = "Save changes";
        }
      }
      setCommentFormVisible(false);
      clearCommentForm();
      setMeasureFormVisible(true);
    }

    function openCommentForm(comment) {
      clearCommentForm();
      if (comment) {
        editingCommentId = comment.id;
        if (commentTextElement) {
          commentTextElement.value = comment.text || "";
        }
        if (commentFormTitleElement) {
          commentFormTitleElement.textContent = "Edit comment " + comment.id;
        }
        if (commentSaveButton) {
          commentSaveButton.textContent = "Save changes";
        }
      }
      setMeasureFormVisible(false);
      clearMeasureForm();
      setCommentFormVisible(true);
    }

    function addActionButton(container, label, action, id, cssClass) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = cssClass;
      button.textContent = label;
      button.setAttribute("data-action", action);
      button.setAttribute("data-id", String(id));
      container.appendChild(button);
      return button;
    }

    function appendMeasureCard(measure) {
      const card = document.createElement("article");
      card.className = "tm-card";

      const head = document.createElement("div");
      head.className = "tm-card-head";

      const title = document.createElement("h3");
      title.className = "tm-card-title";
      title.textContent = measure.title || "Measure";
      head.appendChild(title);

      const meta = document.createElement("div");
      meta.className = "tm-card-meta";
      const metaParts = [];
      if (measure.finishedAt) {
        metaParts.push(measure.finishedAt);
      }
      if (measure.status) {
        metaParts.push(measure.status);
      }
      metaParts.push("measure " + measure.id);
      meta.textContent = metaParts.join(" | ");
      head.appendChild(meta);
      card.appendChild(head);

      if (measure.description) {
        const description = document.createElement("p");
        description.className = "tm-card-description";
        description.textContent = measure.description;
        card.appendChild(description);
      }

      const actions = document.createElement("div");
      actions.className = "tm-card-actions";
      addActionButton(actions, "Edit", "edit-measure", measure.id, "tm-btn tm-btn-secondary");
      addActionButton(actions, "Delete", "delete-measure", measure.id, "tm-btn tm-btn-danger");
      card.appendChild(actions);

      measureListElement.appendChild(card);
    }

    function appendCommentCard(comment) {
      const card = document.createElement("article");
      card.className = "tm-card";

      const head = document.createElement("div");
      head.className = "tm-card-head";

      const title = document.createElement("h3");
      title.className = "tm-card-title";
      title.textContent = comment.author || "Comment";
      head.appendChild(title);

      const meta = document.createElement("div");
      meta.className = "tm-card-meta";
      const metaParts = [];
      if (comment.createdAt) {
        metaParts.push(comment.createdAt);
      }
      metaParts.push("comment " + comment.id);
      meta.textContent = metaParts.join(" | ");
      head.appendChild(meta);
      card.appendChild(head);

      const text = document.createElement("p");
      text.className = "tm-card-description";
      text.textContent = comment.text || "";
      card.appendChild(text);

      const actions = document.createElement("div");
      actions.className = "tm-card-actions";
      addActionButton(actions, "Edit", "edit-comment", comment.id, "tm-btn tm-btn-secondary");
      addActionButton(actions, "Delete", "delete-comment", comment.id, "tm-btn tm-btn-danger");
      card.appendChild(actions);

      commentListElement.appendChild(card);
    }

    function findMeasure(id) {
      return measures.filter(function (measure) { return measure.id === id; })[0];
    }

    function findComment(id) {
      return comments.filter(function (comment) { return comment.id === id; })[0];
    }

    function handleAction(action, id) {
      if (action === "edit-measure") {
        const measure = findMeasure(id);
        if (measure) {
          openMeasureForm(measure);
        }
        return;
      }
      if (action === "delete-measure") {
        vscode.postMessage({ command: "deleteMeasure", payload: JSON.stringify({ id: id }) });
        return;
      }
      if (action === "edit-comment") {
        const comment = findComment(id);
        if (comment) {
          openCommentForm(comment);
        }
        return;
      }
      if (action === "delete-comment") {
        vscode.postMessage({ command: "deleteComment", payload: JSON.stringify({ id: id }) });
      }
    }

    function renderActivity(payload) {
      if (measureListElement) {
        measureListElement.textContent = "";
      }
      if (commentListElement) {
        commentListElement.textContent = "";
      }

      measures = Array.isArray(payload.measures) ? payload.measures : [];
      comments = Array.isArray(payload.comments) ? payload.comments : [];

      if (measureCountElement) {
        measureCountElement.textContent = String(measures.length);
      }
      if (commentCountElement) {
        commentCountElement.textContent = String(comments.length);
      }

      const problems = [];
      if (payload.measuresError) {
        problems.push(payload.measuresError);
      }
      if (payload.commentsError) {
        problems.push(payload.commentsError);
      }

      if (problems.length > 0) {
        setStatus(problems.join(" "), true);
      } else {
        setStatus(measures.length + (measures.length === 1 ? " measure" : " measures") + " and " + comments.length + (comments.length === 1 ? " comment" : " comments"), false);
      }

      measures.forEach(appendMeasureCard);
      comments.forEach(appendCommentCard);
    }

    window.addEventListener("message", (event) => {
      const message = event.data || {};
      let payload = {};
      if (message.payload) {
        try {
          payload = JSON.parse(message.payload);
        } catch (error) {
          payload = {};
        }
      }

      if (message.command === "receiveActivity") {
        clearMeasureForm();
        setMeasureFormVisible(false);
        clearCommentForm();
        setCommentFormVisible(false);
        renderActivity(payload);
      } else if (message.command === "activityError") {
        setStatus(payload.message || "The change could not be saved.", true);
        if (measureSaveButton) {
          measureSaveButton.disabled = false;
          measureSaveButton.textContent = editingMeasureId > 0 ? "Save changes" : "Save measure";
        }
        if (commentSaveButton) {
          commentSaveButton.disabled = false;
          commentSaveButton.textContent = editingCommentId > 0 ? "Save changes" : "Save comment";
        }
      }
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target || !target.getAttribute) {
        return;
      }
      const action = target.getAttribute("data-action");
      if (!action) {
        return;
      }
      event.preventDefault();
      handleAction(action, Number(target.getAttribute("data-id")));
    });

    if (addMeasureButton) {
      addMeasureButton.addEventListener("click", () => {
        openMeasureForm(null);
      });
    }

    if (addCommentButton) {
      addCommentButton.addEventListener("click", () => {
        openCommentForm(null);
      });
    }

    if (refreshButton) {
      refreshButton.addEventListener("click", () => {
        vscode.postMessage({ command: "refreshActivity" });
      });
    }

    if (measureCancelButton) {
      measureCancelButton.addEventListener("click", () => {
        clearMeasureForm();
        setMeasureFormVisible(false);
      });
    }

    if (commentCancelButton) {
      commentCancelButton.addEventListener("click", () => {
        clearCommentForm();
        setCommentFormVisible(false);
      });
    }

    if (measureSaveButton) {
      measureSaveButton.addEventListener("click", () => {
        const title = (measureTitleElement && measureTitleElement.value || "").trim();
        if (!title) {
          setStatus("A measure needs a title.", true);
          if (measureTitleElement) {
            measureTitleElement.focus();
          }
          return;
        }

        measureSaveButton.disabled = true;
        measureSaveButton.textContent = "Saving...";
        setStatus("Saving measure...", false);
        const description = (measureDescriptionElement && measureDescriptionElement.value || "").trim();
        if (editingMeasureId > 0) {
          vscode.postMessage({
            command: "updateMeasure",
            payload: JSON.stringify({ id: editingMeasureId, title: title, description: description })
          });
        } else {
          vscode.postMessage({
            command: "addMeasure",
            payload: JSON.stringify({ title: title, description: description })
          });
        }
      });
    }

    if (commentSaveButton) {
      commentSaveButton.addEventListener("click", () => {
        const text = (commentTextElement && commentTextElement.value || "").trim();
        if (!text) {
          setStatus("A comment needs a text.", true);
          if (commentTextElement) {
            commentTextElement.focus();
          }
          return;
        }

        commentSaveButton.disabled = true;
        commentSaveButton.textContent = "Saving...";
        setStatus("Saving comment...", false);
        if (editingCommentId > 0) {
          vscode.postMessage({
            command: "updateComment",
            payload: JSON.stringify({ id: editingCommentId, text: text })
          });
        } else {
          vscode.postMessage({
            command: "addComment",
            payload: JSON.stringify({
              text: text,
              author: (commentAuthorElement && commentAuthorElement.value || "").trim()
            })
          });
        }
      });
    }

    vscode.postMessage({ command: "requestData" });
  </script>
</body>
</html>`;
  }

  private escapeXml(unsafe: unknown): string {
    if (unsafe === undefined || unsafe === null) {
      return "";
    }

    return String(unsafe)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/'/g, "&apos;")
      .replace(/"/g, "&quot;");
  }
}
