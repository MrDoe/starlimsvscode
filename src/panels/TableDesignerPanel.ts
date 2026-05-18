import * as vscode from "vscode";
import { DOMParser } from "@xmldom/xmldom";
import { getNonce } from "../utilities/getNonce";
import { getUri } from "../utilities/getUri";
import { EnterpriseService } from "../services/enterpriseService";

// --- XML to JSON / JSON to XML helpers ---

interface TableField {
  name: string;
  type: string;
  length: number;
  precision: number;
  scale: number;
  defaultValue: string;
  isNullable: boolean;
  description: string;
  controlType: string;
  picture: string;
  viewPrivilege: string;
  editPrivilege: string;
  ddlState?: string;
}

interface TableIndex {
  name: string;
  type: string; // P, U, R
  ddlState?: string;
  fields: { fieldName: string; sort: string }[];
}

interface TableRelation {
  name: string;
  refTableName: string;
  cascadeDelete: boolean;
  cascadeUpdate: boolean;
  ddlState?: string;
  fields: { fieldName: string; refFieldName: string }[];
}

interface TableDesignerModel {
  tableName: string;
  description: string;
  isSystem: boolean;
  auditType: string;
  ddlState: string;
  id: string;
  fields: TableField[];
  indexes: TableIndex[];
  relations: TableRelation[];
}

const STARLIMS_TYPES = [
  "INTEGER", "SMALLINT", "BIGINT", "DECIMAL", "FLOAT", "DOUBLE",
  "CHAR", "VARCHAR", "LONG VARCHAR", "TEXT",
  "DATE", "TIME", "DATETIME", "TIMESTAMP",
  "BLOB", "LONG VARBINARY", "IMAGE", "BIT"
];

function xmlToModel(xml: string): TableDesignerModel {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  const root: any = doc.documentElement;
  if (!root) {
    throw new Error("Could not parse table XML document.");
  }

  // getText finds FIRST match among *descendants* — safe for unique tags like __array__Fields
  const getDescendantText = (parent: any, tag: string): string => {
    const elements = parent?.getElementsByTagName(tag);
    const el = elements?.length > 0 ? elements[0] : null;
    return el?.textContent ?? "";
  };

  // getDirectChildText finds FIRST direct child with given tagName — safe for Name, Id, etc.
  const getDirectChildText = (parent: any, tag: string): string => {
    if (!parent?.childNodes) { return ""; }
    for (let i = 0; i < parent.childNodes.length; i++) {
      const node = parent.childNodes[i];
      if (node.nodeType === 1 && node.nodeName === tag) {
        return node.textContent ?? "";
      }
    }
    return "";
  };

  const getDirectChildBool = (parent: any, tag: string): boolean => {
    const val = getDirectChildText(parent, tag).toLowerCase();
    return val === "true" || val === "y";
  };

  const model: TableDesignerModel = {
    tableName: getDirectChildText(root, "Name"),
    description: getDirectChildText(root, "Description"),
    isSystem: getDirectChildBool(root, "IsSystem"),
    auditType: getDirectChildText(root, "AuditType"),
    ddlState: getDirectChildText(root, "DdlState"),
    id: getDirectChildText(root, "Id"),
    fields: [],
    indexes: [],
    relations: []
  };

  // parse fields — use direct-child lookup for field-level tags inside each item
  const fieldsArrEl: any = root.getElementsByTagName("__array__Fields")?.[0];
  if (fieldsArrEl) {
    const fieldElements: any[] = Array.from(fieldsArrEl.getElementsByTagName("item") || []);
    for (const f of fieldElements) {
      model.fields.push({
        name: getDirectChildText(f, "Name"),
        type: getDirectChildText(f, "Type"),
        length: parseInt(getDirectChildText(f, "Length") || "0", 10),
        precision: parseInt(getDirectChildText(f, "Precision") || "0", 10),
        scale: parseInt(getDirectChildText(f, "Scale") || "0", 10),
        defaultValue: getDirectChildText(f, "DefaultValue"),
        isNullable: !(getDirectChildText(f, "IsNullable") === "false"),
        description: getDirectChildText(f, "Description"),
        controlType: getDirectChildText(f, "ControlType"),
        picture: getDirectChildText(f, "Picture"),
        viewPrivilege: getDirectChildText(f, "ViewPrivilege"),
        editPrivilege: getDirectChildText(f, "EditPrivilege"),
        ddlState: getDirectChildText(f, "DdlState")
      });
    }
  }

  // parse indexes
  const indexesArrEl: any = root.getElementsByTagName("__array__Indexes")?.[0];
  if (indexesArrEl) {
    const indexElements: any[] = Array.from(indexesArrEl.getElementsByTagName("item") || []);
    for (const ix of indexElements) {
      const idx: TableIndex = {
        name: getDirectChildText(ix, "Name"),
        type: getDirectChildText(ix, "Type"),
        ddlState: getDirectChildText(ix, "DdlState"),
        fields: []
      };
      const ixFieldsEl: any = ix.getElementsByTagName("__array__Fields")?.[0];
      if (ixFieldsEl) {
        const ixFieldEls: any[] = Array.from(ixFieldsEl.getElementsByTagName("item") || []);
        for (const ixf of ixFieldEls) {
          idx.fields.push({
            fieldName: getDirectChildText(ixf, "FieldName"),
            sort: getDirectChildText(ixf, "Sort")
          });
        }
      }
      model.indexes.push(idx);
    }
  }

  // parse relations
  const relationsArrEl: any = root.getElementsByTagName("__array__Relations")?.[0];
  if (relationsArrEl) {
    const relElements: any[] = Array.from(relationsArrEl.getElementsByTagName("item") || []);
    for (const r of relElements) {
      const rel: TableRelation = {
        name: getDirectChildText(r, "Name"),
        refTableName: getDirectChildText(r, "RefTableName"),
        cascadeDelete: getDirectChildText(r, "CascadeDelete").toLowerCase() === "true" || getDirectChildText(r, "CascadeDelete") === "Y",
        cascadeUpdate: getDirectChildText(r, "CascadeUpdate").toLowerCase() === "true" || getDirectChildText(r, "CascadeUpdate") === "Y",
        ddlState: getDirectChildText(r, "DdlState"),
        fields: []
      };
      const relFieldsEl: any = r.getElementsByTagName("__array__Fields")?.[0];
      if (relFieldsEl) {
        const relFieldEls: any[] = Array.from(relFieldsEl.getElementsByTagName("item") || []);
        for (const rf of relFieldEls) {
          rel.fields.push({
            fieldName: getDirectChildText(rf, "FieldName"),
            refFieldName: getDirectChildText(rf, "RefFieldName")
          });
        }
      }
      model.relations.push(rel);
    }
  }

  return model;
}

function modelToXml(model: TableDesignerModel, originalXml: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(originalXml, "text/xml");
  const root: any = doc.documentElement;
  if (!root) {
    throw new Error("Could not parse original table XML.");
  }

  const setText = (tag: string, value: string) => {
    const elements = root.getElementsByTagName(tag);
    let el = elements?.length > 0 ? elements[0] : null;
    if (!el) {
      el = doc.createElement(tag);
      root.appendChild(el);
    }
    el.textContent = value;
  };

  // update scalar values
  setText("Name", model.tableName);
  setText("Description", model.description);
  setText("DdlState", "Modified");
  setText("IsMetadataDirty", "true");

  // rebuild Fields
  const fieldsArrEl: any = root.getElementsByTagName("__array__Fields")?.[0];
  if (fieldsArrEl) {
    while (fieldsArrEl.firstChild) { fieldsArrEl.removeChild(fieldsArrEl.firstChild); }
    for (const f of model.fields) {
      const item = doc.createElement("item");
      item.setAttribute("type", "FieldDTO");
      const addEl = (t: string, v: string) => { const e = doc.createElement(t); e.textContent = v; item.appendChild(e); };
      addEl("DdlState", f.ddlState ?? "New");
      addEl("IsMetadataDirty", "false");
      addEl("CommitState", "");
      addEl("CommitError", "");
      addEl("Name", f.name);
      addEl("Id", "");
      addEl("TableId", model.id);
      addEl("Type", f.type);
      addEl("Description", f.description);
      addEl("Length", String(f.length));
      addEl("Precision", String(f.precision));
      addEl("Scale", String(f.scale));
      addEl("DefaultValue", f.defaultValue);
      addEl("IsNullable", f.isNullable ? "true" : "false");
      addEl("ControlType", f.controlType);
      addEl("Picture", f.picture);
      addEl("ViewPrivilege", f.viewPrivilege);
      addEl("EditPrivilege", f.editPrivilege);
      const caps = doc.createElement("__array__Captions");
      item.appendChild(caps);
      addEl("SCaptions", "");
      addEl("LayerID", "");
      fieldsArrEl.appendChild(item);
    }
  }

  // rebuild Indexes
  const indexesArrEl: any = root.getElementsByTagName("__array__Indexes")?.[0];
  if (indexesArrEl) {
    while (indexesArrEl.firstChild) { indexesArrEl.removeChild(indexesArrEl.firstChild); }
    for (const ix of model.indexes) {
      // Never re-apply the primary key — skip it entirely
      if (ix.type === "P") { continue; }
      const item = doc.createElement("item");
      item.setAttribute("type", "IndexDTO");
      const addEl = (t: string, v: string) => { const e = doc.createElement(t); e.textContent = v; item.appendChild(e); };
      addEl("DdlState", ix.ddlState ?? "New");
      addEl("IsMetadataDirty", "false");
      addEl("CommitState", "");
      addEl("CommitError", "");
      addEl("Id", "");
      addEl("TableName", model.tableName);
      addEl("TableId", model.id);
      addEl("Name", ix.name);
      addEl("Type", ix.type);
      const ixFields = doc.createElement("__array__Fields");
      for (const ixf of ix.fields) {
        const ixItem = doc.createElement("item");
        ixItem.setAttribute("type", "IndexFieldDTO");
        const a = (t: string, v: string) => { const e = doc.createElement(t); e.textContent = v; ixItem.appendChild(e); };
        a("DdlState", "Modified");
        a("IsMetadataDirty", "false");
        a("CommitState", "");
        a("CommitError", "");
        a("FieldName", ixf.fieldName);
        a("Sort", ixf.sort);
        a("Sorter", "1");
        a("Included", "false");
        ixFields.appendChild(ixItem);
      }
      item.appendChild(ixFields);
      indexesArrEl.appendChild(item);
    }
  }

  // rebuild Relations
  const relationsArrEl: any = root.getElementsByTagName("__array__Relations")?.[0];
  if (relationsArrEl) {
    while (relationsArrEl.firstChild) { relationsArrEl.removeChild(relationsArrEl.firstChild); }
    for (const rel of model.relations) {
      const item = doc.createElement("item");
      item.setAttribute("type", "RelationDTO");
      const addEl = (t: string, v: string) => { const e = doc.createElement(t); e.textContent = v; item.appendChild(e); };
      addEl("DdlState", rel.ddlState ?? "New");
      addEl("IsMetadataDirty", "false");
      addEl("CommitState", "");
      addEl("CommitError", "");
      addEl("Id", "");
      addEl("TableName", model.tableName);
      addEl("TableId", model.id);
      addEl("Name", rel.name);
      addEl("RefTableName", rel.refTableName);
      addEl("CascadeDelete", rel.cascadeDelete ? "Y" : "N");
      addEl("CascadeUpdate", rel.cascadeUpdate ? "Y" : "N");
      const relFields = doc.createElement("__array__Fields");
      for (const rf of rel.fields) {
        const rfItem = doc.createElement("item");
        rfItem.setAttribute("type", "RelationFieldDTO");
        const a = (t: string, v: string) => { const e = doc.createElement(t); e.textContent = v; rfItem.appendChild(e); };
        a("DdlState", "Modified");
        a("IsMetadataDirty", "false");
        a("CommitState", "");
        a("CommitError", "");
        a("FieldName", rf.fieldName);
        a("RefFieldName", rf.refFieldName);
        relFields.appendChild(rfItem);
      }
      item.appendChild(relFields);
      relationsArrEl.appendChild(item);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const serializer = new (require("@xmldom/xmldom").XMLSerializer)();
  return serializer.serializeToString(doc);
}

// --- Panel Class ---

export class TableDesignerPanel {
  public static currentPanel: TableDesignerPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _extensionUri: vscode.Uri;
  private _enterpriseService: EnterpriseService;
  private _tableUri: string;
  private _originalXml: string = "";
  private _model: TableDesignerModel | null = null;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    enterpriseService: EnterpriseService,
    tableUri: string
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._enterpriseService = enterpriseService;
    this._tableUri = tableUri;

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);
    this._setWebviewMessageListener(this._panel.webview);
  }

  public static async render(
    extensionUri: vscode.Uri,
    enterpriseService: EnterpriseService,
    tableUri: string,
    tableName: string
  ) {
    if (TableDesignerPanel.currentPanel) {
      TableDesignerPanel.currentPanel.dispose();
    }

    const panel = vscode.window.createWebviewPanel(
      "table-designer",
      `Table Designer: ${tableName}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")]
      }
    );

    const instance = new TableDesignerPanel(panel, extensionUri, enterpriseService, tableUri);
    TableDesignerPanel.currentPanel = instance;

    // load table XML in background and send to webview
    const xml = await enterpriseService.getTableDefinitionXml(tableUri);
    if (xml) {
      instance._originalXml = xml;
      instance._model = xmlToModel(xml);
      panel.webview.postMessage({ command: "loadModel", payload: JSON.stringify(instance._model) });
    } else {
      panel.webview.postMessage({ command: "error", payload: "Could not load table definition." });
    }
  }

  public dispose() {
    TableDesignerPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) { disposable.dispose(); }
    }
  }

  private _getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const webviewUri = getUri(webview, extensionUri, ["dist", "webview.js"]);
    const styleUri = getUri(webview, extensionUri, ["dist", "style.css"]);
    const codiconUri = getUri(webview, extensionUri, ["dist", "codicon.css"]);

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <link rel="stylesheet" href="${codiconUri}">
  <title>Table Designer</title>
</head>
<body>
  <div id="app">
    <div class="td-header">
      <h1 id="table-name-label">Table Designer</h1>
      <vscode-button id="save-btn" appearance="primary">Save Changes</vscode-button>
    </div>
    <div id="loading-indicator">Loading table definition...</div>
    <div id="editor-content" style="display:none">
      <!-- Table Info -->
      <section class="td-section">
        <h2>Table Properties</h2>
        <div class="td-form-grid">
          <label>Table Name</label>
          <input type="text" id="prop-tableName" />
          <label>Description</label>
          <input type="text" id="prop-description" />
        </div>
      </section>

      <!-- Columns -->
      <section class="td-section">
        <div class="td-section-header">
          <h2>Columns</h2>
          <vscode-button id="add-column-btn" appearance="secondary">+ Add Column</vscode-button>
        </div>
        <div class="td-table-wrapper">
          <table class="td-table" id="columns-table">
            <thead><tr>
              <th>Name</th><th>Type</th><th>Length</th><th>Nullable</th><th>Default</th><th>Description</th><th></th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </section>

      <!-- Indexes -->
      <section class="td-section">
        <div class="td-section-header">
          <h2>Indexes</h2>
          <vscode-button id="add-index-btn" appearance="secondary">+ Add Index</vscode-button>
        </div>
        <div class="td-table-wrapper">
          <table class="td-table" id="indexes-table">
            <thead><tr>
              <th>Name</th><th>Type</th><th>Fields</th><th></th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </section>

      <!-- Foreign Keys -->
      <section class="td-section">
        <div class="td-section-header">
          <h2>Foreign Keys</h2>
          <vscode-button id="add-fk-btn" appearance="secondary">+ Add Foreign Key</vscode-button>
        </div>
        <div class="td-table-wrapper">
          <table class="td-table" id="relations-table">
            <thead><tr>
              <th>Name</th><th>Ref Table</th><th>Fields</th><th>Cascade Delete</th><th></th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let model = null;

    const STARLIMS_TYPES = ${JSON.stringify(STARLIMS_TYPES)};

    window.addEventListener("message", (e) => {
      const msg = e.data;
      if (msg.command === "loadModel") {
        model = JSON.parse(msg.payload);
        renderAll();
        document.getElementById("loading-indicator").style.display = "none";
        document.getElementById("editor-content").style.display = "block";
      } else if (msg.command === "error") {
        document.getElementById("loading-indicator").textContent = "Error: " + msg.payload;
      }
    });

    function renderAll() {
      document.getElementById("prop-tableName").value = model.tableName || "";
      document.getElementById("prop-description").value = model.description || "";
      document.getElementById("table-name-label").textContent = "Table Designer: " + (model.tableName || "");
      renderColumns();
      renderIndexes();
      renderRelations();
    }

    function renderColumns() {
      const tbody = document.querySelector("#columns-table tbody");
      tbody.innerHTML = "";
      (model.fields || []).forEach((f, i) => {
        const tr = document.createElement("tr");
        tr.innerHTML = \`<td><input value="\${esc(f.name)}" data-idx="\${i}" data-field="name" class="td-input" /></td>
          <td><select data-idx="\${i}" data-field="type" class="td-select">\${STARLIMS_TYPES.map(t => \`<option value="\${t}" \${f.type===t?'selected':''}>\${t}</option>\`).join("")}</select></td>
          <td><input value="\${f.length||0}" data-idx="\${i}" data-field="length" class="td-input td-num" type="number" /></td>
          <td><input type="checkbox" data-idx="\${i}" data-field="isNullable" \${f.isNullable?'checked':''} /></td>
          <td><input value="\${esc(f.defaultValue)}" data-idx="\${i}" data-field="defaultValue" class="td-input" /></td>
          <td><input value="\${esc(f.description)}" data-idx="\${i}" data-field="description" class="td-input" /></td>
          <td><vscode-button appearance="icon" class="td-del-btn" data-idx="\${i}" data-type="field" title="Remove">\u2715</vscode-button></td>\`;
        tbody.appendChild(tr);
      });
      bindInputs("field");
    }

    function renderIndexes() {
      const tbody = document.querySelector("#indexes-table tbody");
      tbody.innerHTML = "";
      (model.indexes || []).forEach((ix, i) => {
        const fieldsStr = (ix.fields || []).map(f => f.fieldName + (f.sort==="D"?" DESC":"")).join(", ");
        const tr = document.createElement("tr");
        tr.innerHTML = \`<td><input value="\${esc(ix.name)}" data-idx="\${i}" data-field="name" data-type="index" class="td-input" /></td>
          <td><select data-idx="\${i}" data-field="type" data-type="index" class="td-select"><option value="P" \${ix.type==='P'?'selected':''}>PK</option><option value="U" \${ix.type==='U'?'selected':''}>Unique</option><option value="R" \${ix.type==='R'?'selected':''}>Regular</option></select></td>
          <td><input value="\${esc(fieldsStr)}" data-idx="\${i}" data-field="fieldsStr" data-type="index" class="td-input" placeholder="col1,col2 ASC" /></td>
          <td><vscode-button appearance="icon" class="td-del-btn" data-idx="\${i}" data-type="index" title="Remove">\u2715</vscode-button></td>\`;
        tbody.appendChild(tr);
      });
      bindInputs("index");
    }

    function renderRelations() {
      const tbody = document.querySelector("#relations-table tbody");
      tbody.innerHTML = "";
      (model.relations || []).forEach((rel, i) => {
        const fieldsStr = (rel.fields || []).map(f => f.fieldName + "->" + f.refFieldName).join(", ");
        const tr = document.createElement("tr");
        tr.innerHTML = \`<td><input value="\${esc(rel.name)}" data-idx="\${i}" data-field="name" data-type="relation" class="td-input" /></td>
          <td><input value="\${esc(rel.refTableName)}" data-idx="\${i}" data-field="refTableName" data-type="relation" class="td-input" /></td>
          <td><input value="\${esc(fieldsStr)}" data-idx="\${i}" data-field="fieldsStr" data-type="relation" class="td-input" placeholder="col->refCol" /></td>
          <td><input type="checkbox" data-idx="\${i}" data-field="cascadeDelete" data-type="relation" \${rel.cascadeDelete?'checked':''} /></td>
          <td><vscode-button appearance="icon" class="td-del-btn" data-idx="\${i}" data-type="relation" title="Remove">\u2715</vscode-button></td>\`;
        tbody.appendChild(tr);
      });
      bindInputs("relation");
    }

    function bindInputs(type) {
      document.querySelectorAll(\`[data-type="\${type}"]\`).forEach(el => {
        if (el.tagName === "INPUT" && el.type === "checkbox") {
          el.onchange = () => syncCheckbox(el, type);
        } else if (el.tagName === "INPUT") {
          el.onchange = () => syncInput(el, type);
        } else if (el.tagName === "SELECT") {
          el.onchange = () => syncInput(el, type);
        }
      });
      document.querySelectorAll(\`.td-del-btn[data-type="\${type}"]\`).forEach(btn => {
        btn.onclick = () => {
          const idx = parseInt(btn.dataset.idx);
          const arr = type === "field" ? model.fields : type === "index" ? model.indexes : model.relations;
          arr.splice(idx, 1);
          if (type === "field") renderColumns();
          else if (type === "index") renderIndexes();
          else renderRelations();
        };
      });
    }

    function syncInput(el, type) {
      const idx = parseInt(el.dataset.idx);
      const field = el.dataset.field;
      const arr = type === "field" ? model.fields : type === "index" ? model.indexes : model.relations;
      if (!arr[idx]) return;
      if (field === "fieldsStr") {
        arr[idx].fields = parseFieldList(el.value.trim());
      } else if (field === "isNullable") {
        arr[idx][field] = el.checked;
      } else {
        arr[idx][field] = el.type === "number" ? parseInt(el.value, 10) || 0 : el.value;
      }
    }

    function syncCheckbox(el, type) {
      const idx = parseInt(el.dataset.idx);
      const field = el.dataset.field;
      const arr = type === "field" ? model.fields : type === "index" ? model.indexes : model.relations;
      if (!arr[idx]) return;
      arr[idx][field] = el.checked;
    }

    function parseFieldList(str) {
      if (!str) return [];
      return str.split(",").map(s => {
        const parts = s.trim().split(/\s*->\s*/);
        if (parts.length === 2) return { fieldName: parts[0].trim(), refFieldName: parts[1].trim() };
        const fp = parts[0].trim().split(/\s+/);
        return { fieldName: fp[0], sort: fp[1] === "DESC" ? "DESC" : "ASC" };
      });
    }

    function esc(s) { return (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

    // --- buttons ---
    document.getElementById("add-column-btn").onclick = () => {
      model.fields.push({ name:"NEWCOL", type:"VARCHAR", length:50, precision:0, scale:0, defaultValue:"", isNullable:true, description:"", controlType:"", picture:"", viewPrivilege:"", editPrivilege:"" });
      renderColumns();
    };
    document.getElementById("add-index-btn").onclick = () => {
      model.indexes.push({ name: "IX_" + (model.tableName||"T"), type: "R", fields: [{ fieldName: (model.fields[0]?.name||""), sort: "ASC" }] });
      renderIndexes();
    };
    document.getElementById("add-fk-btn").onclick = () => {
      model.relations.push({ name: "FK_" + (model.tableName||"T"), refTableName: "", cascadeDelete: false, cascadeUpdate: false, fields: [{ fieldName: (model.fields[0]?.name||""), refFieldName: "ORIGREC" }] });
      renderRelations();
    };
    document.getElementById("save-btn").onclick = () => {
      model.tableName = document.getElementById("prop-tableName").value.trim();
      model.description = document.getElementById("prop-description").value.trim();
      vscode.postMessage({ command: "saveModel", payload: JSON.stringify(model) });
    };

    // bind top-level inputs
    document.getElementById("prop-tableName").onchange = function() { if(model) model.tableName = this.value.trim(); };
    document.getElementById("prop-description").onchange = function() { if(model) model.description = this.value.trim(); };
  </script>
</body>
</html>`;
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (message: any) => {
        switch (message.command) {
          case "saveModel":
            if (!this._originalXml) {
              vscode.window.showErrorMessage("No original table definition to diff against.");
              return;
            }
            const model: TableDesignerModel = JSON.parse(message.payload);
            const newXml = modelToXml(model, this._originalXml);
            await this._enterpriseService.saveTableDefinition(this._tableUri, newXml);
            break;
        }
      },
      undefined,
      this._disposables
    );
  }
}
