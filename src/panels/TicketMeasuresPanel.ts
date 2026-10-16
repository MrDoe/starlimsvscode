import * as vscode from "vscode";
import { getNonce } from "../utilities/getNonce";
import { getUri } from "../utilities/getUri";
import { EnterpriseService } from "../services/enterpriseService";
import { TicketMeasure, TicketReference } from "../services/ticketManagementTypes";

/** One measure as rendered by the webview (dates already formatted). */
type TicketMeasureCard = {
  id: number;
  title: string;
  description: string;
  status: string;
  finishedAt: string;
};

/** Payload sent to the webview for rendering. */
type TicketMeasuresPayload = {
  ticket: {
    id: number;
    title: string;
    statusName: string;
    assignedTo: string;
    serverName: string;
  };
  measures: TicketMeasureCard[];
  error?: string;
};

/**
 * Webview panel showing the measures recorded for one ticket (what was actually
 * done) as cards, newest first. A measure can also be added from the panel; that
 * uses the same backend procedure as the check-in flow (TicketManagement.AddCompletedMeasure).
 */
export class TicketMeasuresPanel {
  private static readonly panels = new Map<number, TicketMeasuresPanel>();

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
          void this.postMeasures();
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
    const existing = TicketMeasuresPanel.panels.get(ticket.id);
    if (existing) {
      existing._panel.reveal(vscode.ViewColumn.One);
      void existing.postMeasures();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "starlims-ticket-measures",
      TicketMeasuresPanel.panelTitle(ticket),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")]
      }
    );

    TicketMeasuresPanel.panels.set(
      ticket.id,
      new TicketMeasuresPanel(panel, extensionUri, enterpriseService, ticket)
    );
  }

  /** Refreshes the panel of a ticket when it is open (for example after a check-in added a measure). */
  public static refreshIfOpen(ticketId: number | undefined): void {
    if (!ticketId) {
      return;
    }

    const panel = TicketMeasuresPanel.panels.get(ticketId);
    if (panel) {
      void panel.postMeasures();
    }
  }

  public dispose() {
    if (TicketMeasuresPanel.panels.get(this._ticket.id) === this) {
      TicketMeasuresPanel.panels.delete(this._ticket.id);
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
    return clipped.length > 0 ? `#${ticket.id} measures - ${clipped}` : `Ticket #${ticket.id} measures`;
  }

  /** DATE_FINISHED arrives as "2026-10-16T09:26:36.360+02:00" (or "2026-10-16 09:26:36.360000"); show a locale date/time when parseable. */
  private static formatFinishedAt(value: string | undefined): string {
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

  private static toCard(measure: TicketMeasure): TicketMeasureCard {
    return {
      id: measure.id,
      title: measure.title || "Measure",
      description: measure.description || "",
      status: measure.status || "",
      finishedAt: TicketMeasuresPanel.formatFinishedAt(measure.dateFinished)
    };
  }

  /** Loads the measures of the ticket and pushes them to the webview. */
  private async postMeasures(): Promise<void> {
    const serverName = this._enterpriseService.getCurrentServerName() || "";
    const payload: TicketMeasuresPayload = {
      ticket: {
        id: this._ticket.id,
        title: this._ticket.title || "",
        statusName: this._ticket.statusName || "",
        assignedTo: this._ticket.assignedTo || "",
        serverName
      },
      measures: []
    };

    const measuresResult = await this._enterpriseService.getTicketMeasuresResult(this._ticket.id);
    if (!measuresResult.ok) {
      payload.error = `${measuresResult.error ?? `Could not retrieve measures for ticket #${this._ticket.id}.`} A SCM_API backend with TicketManagement.GetTicketMeasures is required; the extension installs it automatically on activation, so reload the window if this error persists.`;
    } else {
      payload.measures = (measuresResult.data ?? []).map(TicketMeasuresPanel.toCard);
    }

    void this._panel.webview.postMessage({
      command: "receiveMeasures",
      payload: JSON.stringify(payload)
    });
  }

  /** Adds a measure to the ticket, then reloads the list. */
  private async addMeasure(rawPayload: unknown): Promise<void> {
    if (this._saving) {
      return;
    }

    let title = "";
    let description = "";
    try {
      const parsed = JSON.parse(String(rawPayload ?? "{}"));
      title = String(parsed?.title ?? "").trim();
      description = String(parsed?.description ?? "").trim();
    } catch {
      title = "";
    }

    if (!title) {
      const message = "The measure title cannot be empty.";
      void this._panel.webview.postMessage({
        command: "measureError",
        payload: JSON.stringify({ message })
      });
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
        void this._panel.webview.postMessage({
          command: "measureError",
          payload: JSON.stringify({ message })
        });
        return;
      }

      void vscode.window.showInformationMessage(
        `Added measure ${measureResult.data} to ticket #${this._ticket.id}.`
      );
      await this.postMeasures();
    } finally {
      this._saving = false;
    }
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (message: { command?: string; payload?: unknown }) => {
        switch (message.command) {
          case "requestData":
          case "refreshMeasures":
            await this.postMeasures();
            break;

          case "addMeasure":
            await this.addMeasure(message.payload);
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

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Ticket measures</title>
</head>
<body>
  <div id="measures-app">
    <div class="tm-header">
      <div>
        <h1 id="measures-ticket">${ticketLine}</h1>
        <div class="tm-meta">${this.escapeXml(metaParts.join(" | "))}</div>
      </div>
      <div class="tm-actions">
        <button id="add-measure-btn" class="tm-btn tm-btn-primary" type="button">+ Add measure</button>
        <button id="refresh-measures-btn" class="tm-btn tm-btn-secondary" type="button">Refresh</button>
      </div>
    </div>

    <section class="tm-section" id="measure-form" hidden>
      <div class="tm-section-header"><h2>New measure</h2></div>
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

    <p id="measures-status" class="tm-status" aria-live="polite">Loading measures...</p>
    <div id="measures-list"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const statusElement = document.getElementById("measures-status");
    const listElement = document.getElementById("measures-list");
    const formElement = document.getElementById("measure-form");
    const titleElement = document.getElementById("measure-title");
    const descriptionElement = document.getElementById("measure-description");
    const saveButton = document.getElementById("measure-save-btn");
    const cancelButton = document.getElementById("measure-cancel-btn");
    const addButton = document.getElementById("add-measure-btn");
    const refreshButton = document.getElementById("refresh-measures-btn");

    function setStatus(text, isError) {
      if (!statusElement) {
        return;
      }
      statusElement.textContent = text || "";
      statusElement.classList.toggle("tm-status-error", isError === true);
    }

    function setFormVisible(visible) {
      if (!formElement) {
        return;
      }
      formElement.hidden = !visible;
      if (visible && titleElement) {
        titleElement.focus();
      }
    }

    function clearForm() {
      if (titleElement) {
        titleElement.value = "";
      }
      if (descriptionElement) {
        descriptionElement.value = "";
      }
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = "Save measure";
      }
    }

    function requestMeasures() {
      setStatus("Loading measures...", false);
      vscode.postMessage({ command: "requestData" });
    }

    function appendCard(measure) {
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

      listElement.appendChild(card);
    }

    function renderMeasures(payload) {
      if (!listElement) {
        return;
      }
      listElement.textContent = "";

      const measures = Array.isArray(payload.measures) ? payload.measures : [];
      if (payload.error) {
        setStatus(payload.error, true);
        return;
      }

      if (measures.length === 0) {
        setStatus("No measures are recorded for this ticket yet. Use '+ Add measure' to document what was done.", false);
        return;
      }

      setStatus(measures.length + (measures.length === 1 ? " measure" : " measures"), false);
      measures.forEach(appendCard);
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

      if (message.command === "receiveMeasures") {
        clearForm();
        setFormVisible(false);
        renderMeasures(payload);
      } else if (message.command === "measureError") {
        setStatus(payload.message || "Could not add the measure.", true);
        if (saveButton) {
          saveButton.disabled = false;
          saveButton.textContent = "Save measure";
        }
      }
    });

    if (addButton) {
      addButton.addEventListener("click", () => {
        clearForm();
        setFormVisible(true);
      });
    }

    if (refreshButton) {
      refreshButton.addEventListener("click", () => {
        vscode.postMessage({ command: "refreshMeasures" });
      });
    }

    if (cancelButton) {
      cancelButton.addEventListener("click", () => {
        clearForm();
        setFormVisible(false);
      });
    }

    if (saveButton) {
      saveButton.addEventListener("click", () => {
        const title = (titleElement && titleElement.value || "").trim();
        if (!title) {
          setStatus("A measure needs a title.", true);
          if (titleElement) {
            titleElement.focus();
          }
          return;
        }

        saveButton.disabled = true;
        saveButton.textContent = "Saving...";
        setStatus("Saving measure...", false);
        vscode.postMessage({
          command: "addMeasure",
          payload: JSON.stringify({
            title: title,
            description: (descriptionElement && descriptionElement.value || "").trim()
          })
        });
      });
    }

    requestMeasures();
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
