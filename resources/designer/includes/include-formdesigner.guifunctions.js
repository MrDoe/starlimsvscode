/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
/*
Description.. :	GUI helper functions for FormDesigner
Author....... :	DC
Date......... : 2023-11-03
*/
var pnlSelected = new Panel();
pnlSelected.Id = "pnlSelected";
pnlSelected.Type = "Panel";
pnlSelected.Visible = false;
pnlSelected.BackColor = "Transparent";
pnlSelected.setStyle("border", "1px dotted #f00");

// create new form
async function CreateEmptyForm()
{
    // create form panel
    _Form1.Id = "_Form1";
    _Form1.Type = _Form1.xType = "Form";
    _Form1.Guid = System.Guid.NewGuid().ToString();
    _Form1.setStyle('border', '1px dotted black');
    _Form1.CloseOnEscape = false;
    _Form1.ValidateOnClose = false;
    _Form1.title = "";
    htControls.Add(_Form1.Guid, _Form1);
    _Form1.Controls.Add(pnlSelected);
    selectedControl = _Form1;

    // XFD-MULTISELECT: drop stale interaction state from any previous form
    XfdResetInteractionState();

    // load properties into grid
    LoadDataProperties(_Form1);

    // clear extjs tree store
    await _treePanel.store.getRootNode().removeAll();
    ResetTreeNodeIndex();

    var node = Ext.create("ControlNode", {
        guid: _Form1.Guid,
        text: "_Form1",
        icon: 'htmlruntime/images/10B98BB5-80D7-B54B-A9BF-F87A586A5675',
        leaf: true,
        expandable: false,
        control: _Form1,
        properties: _Form1.DataPropertiesXml
    });

    // add form to outline
    _treePanel.getRootNode().appendChild(node);
    RegisterTreeNode(node);
    _treePanel.getRootNode().expand(true);

    // bind click event
    $('[automation-id="_Form1"]').click(__control_OnClick);

    selectedControl = _Form1;
}

// add new control to form
// XFD-UNIQID: controlCounter is a PAGE-session counter (wire.js) and loaded
// forms keep their original Ids (Button0, Label1, ...) without advancing it,
// so the bare counter mint collides with loaded Ids on reopened forms. Scan
// the live htControls map and bump the numeric suffix until the Id is free
// scan case-insensitively so XML-loaded Ids that differ only in case also
// count as taken).
// MUST run before htControls.Add of the new control (the scan skips nothing,
// a self-hit would loop) - both mint sites in AddControl satisfy that.
function XfdMintUniqueId(controlType)
{
    var inUse = {}, i;
    for (i = 0; i < htControls.Keys.length; ++i)
    {
        var c = htControls[htControls.Keys[i]];
        if (c && c.Id)
            inUse[String(c.Id).toLowerCase()] = true;
    }

    var id;
    do
        id = controlType + (controlCounter++).toString();
    while (inUse[id.toLowerCase()]);
    return id;
}

async function AddControl(controlType)
{
    var control;
    switch (controlType)
    {
        case "Button":
            control = new Button();
            control.xType = "Button";
            control.Width = 100;
            control.Height = 26;
            control.BackColor = "White";
            control.ForeColor = "Black";
            control.Image = "htmlruntime/images/3FCCF003-E470-428F-8AAF-8B96D4A43643";
            control.ImageAlign = "LEFT";
            control.VisualStyle = "FLAT";
            break;
        case "ButtonBar":
            control = new ButtonBar();
            control.xType = "ButtonBar";
            control.Width = 200;
            control.Height = 250;
            control.BorderStyle = "SINGLE";
            break;
        case "CheckBox":
            control = new CheckBox();
            control.Width = 100;
            control.Height = 26;
            control.xType = "CheckBox";
            break;
        case "CheckedListBox":
            control = new CheckedListBox();
            control.Width = 300;
            control.Height = 400;
            control.xType = "CheckedListBox";
            break;
        case "ComboBox":
            control = new ComboBox();
            control.Width = 100;
            control.Height = 26;
            control.xType = "ComboBox";
            break;
        case "DataGrid":
            control = new DataGrid();
            control.xType = "DataGrid";
            control.Width = 500;
            control.Height = 300;
            break;
        case "DateTimePicker":
            control = new DateTimePicker();
            control.Width = 100;
            control.Height = 26;
            control.xType = "DateTimePicker";
            control.Value = new Date();
            break;
        case "Frame":
            control = new Frame();
            control.Width = 500;
            control.Height = 300;
            control.xType = "Frame";
            break;
        case "GroupBox":
            control = new GroupBox();
            control.xType = "GroupBox";
            control.Width = 500;
            control.Height = 300;
            break;
        case "Image":
            control = new Image();
            control.xType = "Image";
            control.Width = 32;
            control.Height = 32;
            break;
        case "Line":
            control = new Line();
            control.xType = "Line";
            control.Width = 100;
            break;
        case "Label":
            control = new Label();
            control.Width = 100;
            control.Height = 26;
            control.xType = "Label";
            break;
        case "LinkBar":
            control = new LinkBar();
            control.xType = "LinkBar";
            control.Width = 200;
            control.Height = 250;
            control.BorderStyle = "SINGLE";
            break;
        case "LinkButton":
            control = new LinkButton();
            control.xType = "LinkButton";
            control.Width = 100;
            control.Height = 26;
            control.BackColor = "Transparent";
            control.ForeColor = "Blue";
            control.Image = "htmlruntime/images/3FCCF003-E470-428F-8AAF-8B96D4A43643";
            control.ImageAlign = "LEFT";
            control.VisualStyle = "FLAT";
            break;
        case "LinkLabel":
            control = new LinkLabel();
            control.xType = "LinkLabel";
            control.Width = 100;
            control.Height = 26;
            control.BackColor = "Transparent";
            control.ForeColor = "Blue";
            control.VisualStyle = "FLAT";
            break;
        case "ListBox":
            control = new ListBox();
            control.xType = "ListBox";
            control.Width = 300;
            control.Height = 400;
            break;
        case "ListView":
            control = new ListView();
            control.xType = "ListView";
            control.Width = 300;
            control.Height = 400;
            break;
        case "MonthCalendar":
            control = new MonthCalendar();
            control.xType = "MonthCalendar";
            control.Width = 200;
            control.Height = 200;
            break;
        case "MultiChoice":
            control = new MultiChoice();
            control.xType = "MultiChoice";
            control.Width = 300;
            control.Height = 400;
            break;
        case "Panel":
            control = new Panel();
            control.xType = "Panel";
            control.Width = 500;
            control.Height = 300;
            control.BorderStyle = "FIXEDSINGLE";
            break;
        case "ProgressBar":
            control = new ProgressBar();
            control.xType = "ProgressBar";
            control.Width = 100;
            control.Height = 26;
            break;
        case "RadioButton":
            control = new RadioButton();
            control.xType = "RadioButton";
            control.Text = "RadioButton";
            control.Width = 100;
            control.Height = 26;
            break;
        case "ReportViewer":
            control = new ReportViewer();
            control.xType = "ReportViewer";
            control.Width = 500;
            control.Height = 300;
            break;
        case "RichTextBox":
            control = new RichTextBox();
            control.xType = "RichTextBox";
            control.Width = 500;
            control.Height = 300;
            break;
        case "Schedule":
            control = new Schedule();
            control.xType = "Schedule";
            control.Width = 500;
            control.Height = 300;
            break;
        case "ScriptEditor":
            control = new ScriptEditor();
            control.xType = "ScriptEditor";
            control.Width = 500;
            control.Height = 300;
            break;
        case "SplitContainerH":
            control = new StarlimsSplitContainerH();
            control.xType = "SplitContainerH";
            control.FixedPanel = "PANEL1";
            control.SplitterWidth = 3;
            control.Width = 500;
            control.Height = 300;
            break;
        case "SplitContainerV":
            control = new StarlimsSplitContainerV();
            control.xType = "SplitContainerV";
            control.FixedPanel = "PANEL1";
            control.SplitterWidth = 3;
            control.Width = 500;
            control.Height = 300;
            break;
        case "TabControl":
            control = new TabControl();
            control.Id = XfdMintUniqueId(controlType);   // XFD-UNIQID
            control.xType = "TabControl";
            control.Width = 500;
            control.Height = 300;
            control.Alignment = "TOP";
            control.ShowCloseButton = false;
            ApplyContextMenu(control);
            break;
        case "TextArea":
            control = new TextArea();
            control.xType = "TextArea";
            control.Width = 200;
            control.Height = 26;
            break;
        case "TextBox":
            control = new TextBox();
            control.xType = "TextBox";
            control.Width = 100;
            control.Height = 26;
            break;
        case "TreeListView":
            control = new TreeListView();
            control.xType = "TreeListView";
            control.Width = 300;
            control.Height = 400;
            break;
        case "TreeView":
            control = new TreeView();
            control.xType = "TreeView";
            control.Width = 300;
            control.Height = 400;
            break;
        case "WebBrowser":
            control = new WebBrowser();
            control.xType = "WebBrowser";
            control.Width = 500;
            control.Height = 300;
            break;
    }

    // set initial properties
    if (!control.Id)
    {
        control.Id = XfdMintUniqueId(controlType);   // XFD-UNIQID
        control.Guid = System.Guid.NewGuid().ToString();
    }

    if (control.xType != "TabControl" && control.xType != "DateTimePicker")
        control.Text = control.Id;

    control.Top = 20;
    control.Left = 20;

    LoadDataProperties(control);

    // add control to form or as child of selected control
    if (selectedControl && selectedControl.Controls)
        selectedControl.Controls.Add(control);
    else
    {
        selectedControl = _Form1;
        _Form1.Controls.Add(control);
    }

    // add control to outline
    let selectedNode = await FindNodeByGuid(selectedControl.Guid);
    await AddControlToOutline(control, selectedNode);

    // add control to hashtable
    htControls.Add(control.Guid, control);

    // XFD-SAVEV3: a toolbox insert is a USER addition — the binary adopts the
    // new item ONLY because of this stamp (runtime-created items stay refused).
    if (window.XfdJournal)
        XfdJournal.stampAdded(control);

    let event = new Object();
    event.target = control;
    __control_OnClick(event);
    LoadCboControls();

    // add root table to outline
    if (control.xType === "DataGrid")
    {
        let rootTable = new StarlimsDataGridTable();
        rootTable.xType = "StarlimsDataGridTable";
        rootTable.Id = control.Id + "_RootTable";
        control.RootTable = rootTable;
        LoadDataProperties(rootTable);
        let node = await FindNodeByGuid(control.Guid);
        AddControlToOutline(rootTable, node);
    }

    _treePanel.getRootNode().expand(true);

    control = $('[automation-id="' + control.Id + '"]');

    // bind events to control
    // click event
    control.click(__control_OnClick);

    // make control draggable
    control.mousedown(__control_OnDrag);

    // move control via arrow keys
    control.keydown(__control_OnKeyDown);

    // recalculate z-index
    SetZIndex();
}

async function BindControlEvents(control)
{
    var designerControl = control;
    var controlElement = $('[automation-id="' + designerControl.Id + '"]');

    // remove existing click event
    controlElement.off("click");

    // bind click event
    controlElement.click(__control_OnClick);

    if (designerControl.Id !== "_Form1")
    {
        // bind mouse drag event
        controlElement.mousedown(__control_OnDrag);

        // bind keyDown event
        controlElement.keydown(__control_OnKeyDown);
    }

    // recursively bind events to child controls
    if (designerControl.Controls)
    {
        for (let i = 0; i < designerControl.Controls.Count; ++i)
            BindControlEvents(designerControl.Controls[i]);
    }

    // recursively bind events to child panels
    if (designerControl.Panel1)
        BindControlEvents(designerControl.Panel1);
    if (designerControl.Panel2)
        BindControlEvents(designerControl.Panel2);
}

// load controls from hashtable to combobox
async function LoadCboControls()
{
    _cboControl.Items.Clear();

    for (let i = 0; i < htControls.Keys.length; ++i)
    {
        let guid = htControls.Keys[i];
        let control = htControls[guid];

        _cboControl.Items.Add(guid, control.Id + " (" + control.xType + ")");
    }
    _cboControl.SelectedValue = selectedControl.Guid;
}

// loads control's properties on click
async function __control_OnClick(e)
{
    if (form.Variables["PreventClickEvents"] === true)
        return;

    // The click is never stopPropagation()ed (live widgets - tabs, comboboxes,
    // grids, checkboxes - are driven by Ext's delegated handling up at the
    // document, so swallowing it would kill their native click semantics). It
    // DOES reach this handler once per binding the event passes - but as a
    // fresh clone each time, so the XFD-EVTGUARD generation counter (not an
    // event marker) decides who owns the click. The claim happens before any
    // early return: a suppressed post-drag click must still consume the
    // physical click, or the form's clone would run and collapse the group.
    if (!XfdClaimEvent(e, _xfdClickGuard))
        return;

    // XFD-MULTISELECT: a click that follows a real drag/marquee/resize must
    // not replace the selection the gesture just established
    if (_xfdSuppressClick)
    {
        _xfdSuppressClick = false;
        return;
    }

    // XFD-INTERACTION: robust walk-up resolution to the owning designer
    // control, falling back to the legacy element.id lookup
    let control = XfdResolveControlFromEvent(e);

    if (!control)
    {
        // get clicked dom element
        let element = e.target;

        // get dom element id
        var elementId;
        if (!element.id)
            if (element.parentElement && element.parentElement.id)
                elementId = element.parentElement.id;
            else
                return;
        else
            elementId = element.id;

        // get extjs control from element
        control = Ext.Component.from(elementId);

        // get control from hashtable for non-extjs controls
        if (!control && e.target.Guid)
            control = htControls[e.target.Guid];
    }

    if (!control || !control.Id)
        return;

    // XFD-MULTISELECT: plain click replaces the selection, Ctrl+click
    // toggles membership; outline/cbo/grid follow the primary control
    if (XfdIsDesignerControl(control))
    {
        XfdSelectControl(control, !!e.ctrlKey);

        if (e.ctrlKey && !XfdIsControlSelected(control))
        {
            control = XfdGetPrimaryControl();
            if (!control)
            {
                pnlSelected.Visible = false;
                XfdRefreshSelectionVisuals();
                return;
            }
        }
    }
    else
        selectedControl = control;   // legacy non-designer widget (e.g. a tab)

    form.Variables["PreventLoadCboControl"] = true;
    _cboControl.SelectedValue = control.Guid;
    form.Variables["PreventLoadCboControl"] = false;

    // select node in outline _treePanel
    selectedNode = await FindNodeByGuid(control.Guid);
    _treePanel.getSelectionModel().select(selectedNode);

    // update selection frame
    pnlSelected.Visible = true;
    UpdateSelectionFrame(control);

    XfdShowProperties(control);
}

// load a control's DataProperties into the properties grid
// (XFD-INTERACTION: shared by __control_OnClick and the outline select listener)
function XfdShowProperties(control)
{
    // update properties grid
    _dgdProperties.Data = control.DataPropertiesXml;

    // loop over data rows and set values
    for (let i = 0; i < _dgdProperties.RowCount; ++i)
    {
        let row = _dgdProperties.DataSet.Tables[0].Rows[i];
        let sPropertyName = row["PROPERTY_NAME"];

        // skip resources
        if (sPropertyName === "Resources")
            continue;

        let value = control[sPropertyName];

        value = GetPropertyDisplayValue(control, sPropertyName);

        if (sPropertyName.includes("On") && value === "")
            continue;

        row["PROPERTY_VALUE"] = value;
    }

    _dgdProperties.DataSet.AcceptChanges();
}

// move control via arrow keys
function __control_OnKeyDown(e)
{
    // XFD-MULTISELECT: arrow keys nudge the whole move set (Shift = 10px)
    let control = XfdResolveControlFromEvent(e);
    if (control && XfdIsDesignerControl(control) && !XfdIsControlSelected(control))
        XfdSelectControl(control, false);

    let targets = XfdMoveSet();
    if (!targets.length && XfdIsMovable(selectedControl))
        targets = [selectedControl];

    let step = e.shiftKey ? 10 : 1;
    let handled = true;

    if (e.keyCode === 37)
        targets.forEach(function (c) { c.Left -= step; });
    else if (e.keyCode === 38)
        targets.forEach(function (c) { c.Top -= step; });
    else if (e.keyCode === 39)
        targets.forEach(function (c) { c.Left += step; });
    else if (e.keyCode === 40)
        targets.forEach(function (c) { c.Top += step; });
    else
        handled = false;

    if (handled)
    {
        // XFD-SAVEV3: arrow-nudge is a USER move — journal membership (the
        // posted value comes from the save-time hint anyway).
        if (window.XfdJournal)
            targets.forEach(function (c) { XfdJournal.stamp(c, "Left"); XfdJournal.stamp(c, "Top"); });

        if (e.preventDefault)
            e.preventDefault();

        // update selection frame
        UpdateSelectionFrame(selectedControl);
        XfdRefreshSelectionVisuals();
    }
}

// make control draggable
// XFD-INTERACTION: unified press dispatcher - a press whose cursor is over a
// control MOVES that control (XFD-SNAP: with snap-to-control alignment, Alt
// bypasses) and the press selects it; the selection band only ever starts from
// the form's empty canvas surface, never over a control. A press without
// movement is a plain click: it selects the control / clears the selection on
// the empty canvas. Ctrl+drag resizes, Shift+drag bands from anywhere. The
// whole engine lives in FormDesigner.Interaction
// (include-formdesigner.interaction.js).
function __control_OnDrag(e)
{
    XfdHandleMouseDown(e);
}

// draw a selection frame around the selected control
async function UpdateSelectionFrame(sender)
{
    $('[automation-id="pnlSelected"]').css("cssText", "border: 1px dotted rgb(255, 0, 0); z-index: 99999; pointer-events: none; position: sticky !important;");

    // iterate over all parents and add positions to get absolute position
    let top = sender.Top ? sender.Top : 0;
    let left = sender.Left ? sender.Left : 0;
    let width = sender.Width ? sender.Width + 2 : 0;
    let height = sender.Height ? sender.Height + 2 : 0;
    let parent = sender.Parent;

    // don't set width and height above form width
    width = Math.min(width, _Form1.Width - 5);
    height = Math.min(height, _Form1.Height - 5);

    let nTabPages = 0;
    while (parent && parent.Id !== "_Form1")
    {
        if (parent.xType === "TabControl" && parent.ShowTabs == true)
            nTabPages++;

        top += parent.Top;
        left += parent.Left;
        parent = parent.Parent;
    }
    const tabHeaderSize = 29; // set this according to your css style
    let tabCorrectionTop = nTabPages * tabHeaderSize;
    let tabCorrectionLeft = nTabPages * 2;
    pnlSelected.Top = top - 2 + tabCorrectionTop;
    pnlSelected.Left = left - 2 + tabCorrectionLeft;

    // use jquery to set width and height to avoid automatic resizing for sticky elements
    $('[automation-id="pnlSelected"]').width(width);
    $('[automation-id="pnlSelected"]').height(height);
}

function SetProperties(sPropertyName, sPropertyValue)
{
    // switch type of PROPERTY_VALUE column depending on PROPERTY_TYPE
    var sColumn = _dgdProperties.RootTable.Columns.FindById("PROPERTY_VALUE");

    if (sPropertyValue === "True" || sPropertyValue === "False")
    {
        sColumn.Type = "ComboBox";
        sColumn.DataArray = [["True", "True"], ["False", "False"]];
        return;
    }

    // get event handler functions
    if (sPropertyName.includes("On"))
    {
        sColumn.Type = "ComboBox";

        // convert functionNames array to DataArray
        let functionNames = form.Variables["FunctionNames"];
        if (functionNames && functionNames.length > 0)
        {
            let aValues = new Array(functionNames.length + 1);

            aValues[0] = ["", ""];
            for (let i = 0; i < functionNames.length; ++i)
                aValues[i + 1] = [functionNames[i], functionNames[i]];

            sColumn.DataArray = aValues;
        }
        else
            sColumn.DataArray = [["", ""]];
        return;
    }

    if (IsColorPropertyName(sPropertyName))
    {
        sColumn.Type = "UD";
        return;
    }

    switch (sPropertyName)
    {
        case "Anchor":
            sColumn.Type = "UD";
            break;
        case "Align":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["BEGIN", "BEGIN"], ["MIDDLE", "MIDDLE"], ["END", "END"], ["STRETCH", "STRETCH"], ["STRETCHMAX", "STRETCHMAX"]];
            break;
        case "Alignment":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["TOP", "TOP"], ["BOTTOM", "BOTTOM"], ["LEFT", "LEFT"], ["RIGHT", "RIGHT"]];
            break;
        case "CheckBehavior":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["MULTIPLE", "MULTIPLE"], ["MULTIPLEEXTENDED", "MULTIPLEEXTENDED"], ["SINGLE", "SINGLE"]];
            break;
        case "ContentOverflow":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["SCROLL", "SCROLL"], ["RESIZE", "RESIZE"], ["HIDE", "HIDE"], ["ANCHOR", "ANCHOR"]];
            break;
        case "DisplayMode":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["AUTO", "AUTO"], ["CENTER", "CENTER"], ["NORMAL", "NORMAL"], ["STRETCH", "STRETCH"]];
            break;
        case "FirstDayOfWeek":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["DEFAULT", "DEFAULT"], ["SUNDAY", "SUNDAY"], ["MONDAY", "MONDAY"], ["TUESDAY", "TUESDAY"], ["WEDNESDAY", "WEDNESDAY"], ["THURSDAY", "THURSDAY"], ["FRIDAY", "FRIDAY"], ["SATURDAY", "SATURDAY"]];
            break;
        case "Layout":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["ABSOLUTE", "ABSOLUTE"], ["HBOX", "HBOX"], ["VBOX", "VBOX"]];
            break;
        case "Pack":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["START", "START"], ["CENTER", "CENTER"], ["END", "END"]];
            break;
        case "BackgroundImage":
        case "Image":
            sColumn.Type = "UD";
            break;
        case "ImageAlign":
            sColumn.Type = "ComboBox";
            if (selectedControl.xType === "Button")
                sColumn.DataArray = [["LEFT", "LEFT"], ["RIGHT", "RIGHT"], ["TOP", "TOP"], ["BOTTOM", "BOTTOM"], ["CENTER", "CENTER"]];
            if (selectedControl.xType === "LinkButton")
                sColumn.DataArray = [["LEFT", "LEFT"], ["MIDDLELEFT", "MIDDLELEFT"], ["RIGHT", "RIGHT"], ["MIDDLERIGHT", "MIDDLERIGHT"], ["TOP", "TOP"], ["TOPCENTER", "TOPCENTER"], ["BOTTOM", "BOTTOM"], ["BOTTOMCENTER", "BOTTOMCENTER"]];
            break;
        case "DataBindingBehavior":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["APPEND", "APPEND"], ["REPLACE", "REPLACE"], ["REPLACEUNSELECTED", "REPLACEUNSELECTED"]];
            break;
        case "DataLoadingBehavior":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["AUTOLOAD", "AUTOLOAD"], ["ONDEMAND", "ONDEMAND"], ["RESETDATA", "RESETDATA"]];
        case "FixedPanel":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["PANEL1", "PANEL1"], ["PANEL2", "PANEL2"]];
            break;
        case "Font":
            sColumn.Type = "UD";
            break;
        case "Format":
            if (selectedControl.xType === "DateTimePicker")
            {
                sColumn.Type = "ComboBox";
                sColumn.DataArray = [["SHORT", "SHORT"], ["LONG", "LONG"], ["TIME", "TIME"], ["CUSTOM", "CUSTOM"]];
            }
            else
                sColumn.Type = "TextBox";
            break;
        case "FrameStyle":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["FRAME", "FRAME"], ["TOP", "TOP"], ["NONE", "NONE"]];
            break;
        case "SelectedPage":
            sColumn.Type = "ComboBox";
            var aValues = [["0", "0"]];

            for (let i = 1; i <= selectedControl.TabPages.Count; ++i)
                aValues.push([i.toString(), i.toString()]);

            sColumn.DataArray = aValues;
            break;
        case "ScriptLanguage":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["STARLIMS", "STARLIMS"], ["JSCRIPT", "JSCRIPT"], ["SQL", "SQL"], ["XML", "XML"]];
            break;
        case "TextAlign":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["Left", "Left"], ["Center", "Center"], ["Right", "Right"]];
            break;
        case "TextPosition":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["AFTER", "AFTER"], ["BEFORE", "BEFORE"]];
            break;
        case "BorderStyle":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["NONE", "NONE"], ["FIXEDSINGLE", "FIXEDSINGLE"], ["FIXED3D", "FIXED3D"]];
            break;
        case "RightToLeft":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["NONE", "NONE"], ["YES", "YES"], ["INHERIT", "INHERIT"]];
            break;
        case "Dock":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["NONE", "NONE"], ["TOP", "TOP"], ["BOTTOM", "BOTTOM"], ["LEFT", "LEFT"], ["RIGHT", "RIGHT"], ["FILL", "FILL"]];
            break;
        case "Cursor":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["Default", "Default"], ["Arrow", "Arrow"], ["Cross", "Cross"], ["Hand", "Hand"], ["Help", "Help"], ["IBeam", "IBeam"], ["No", "No"], ["SizeAll", "SizeAll"], ["SizeNESW", "SizeNESW"], ["SizeNS", "SizeNS"], ["SizeNWSE", "SizeNWSE"], ["SizeWE", "SizeWE"], ["UpArrow", "UpArrow"], ["Wait", "Wait"]];
            break;
        case "SelectionMode":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["NONE", "NONE"], ["ONE", "ONE"], ["MULTIPLE", "MULTIPLE"]];
            break;
        case "VisualStyle":
            sColumn.Type = "ComboBox";
            switch (selectedcontrol.xType)
            {
                case "Button":
                    // BMBH custom styles
                    sColumn.DataArray = [["FLAT", "FLAT"], ["RAISED", "RAISED"], ["GREEN", "GREEN"], ["ORANGE", "ORANGE"]];
                    // STARLIMS standard styles
                    //sColumn.DataArray = [["FLAT", "FLAT"], ["RAISED", "RAISED"]];
                    break;
                case "ButtonBar":
                    sColumn.DataArray = [["CLASSIC", "CLASSIC"], ["OFFICE2003", "OFFICE2003"]];
                    break;
                case "LinkBar":
                    sColumn.DataArray = [["OFFICE2003", "OFFICE2003"], ["CLASSIC", "CLASSIC"], ["XP", "XP"]];
                    break;
                case "DataGrid":
                    sColumn.DataArray = [["DEFAULT", "DEFAULT"], ["STANDARD", "STANDARD"], ["OFFICE2003", "OFFICE2003"]];
                    break;
                case "TabControl":
                    sColumn.DataArray = [["CLASSIC", "CLASSIC"], ["OFFICE2003", "OFFICE2003"], ["ELEGANT", "ELEGANT"]];
                    break;
            }
            break;
        case "HeaderStyle":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["CLICKABLE", "CLICKABLE"], ["NONCLICKABLE", "NONCLICKABLE"], ["NONE", "NONE"]];
            break;
        case "ViewMode":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["DETAILS", "DETAILS"], ["HLIST", "HLIST"], ["VLIST", "VLIST"]];
            break;
        case "Type":
            sColumn.Type = "ComboBox";
            sColumn.DataArray = [["Button", "Button"], ["ButtonBar", "ButtonBar"], ["CheckBox", "CheckBox"], ["ComboBox", "ComboBox"], ["DateTimePicker", "DateTimePicker"], ["Label", "Label"], ["ListBox", "ListBox"], ["ListView", "ListView"], ["RadioButton", "RadioButton"], ["TextBox", "TextBox"], ["TreeView", "TreeView"], ["TextArea", "TextArea"], ["Image", "Image"], ["Panel", "Panel"], ["GroupBox", "GroupBox"], ["TabControl", "TabControl"], ["DataGrid", "DataGrid"], ["SplitContainerH", "SplitContainerH"], ["SplitContainerV", "SplitContainerV"]];
        default:
            sColumn.Type = "TextBox";
    }
    return sColumn;
}

async function handleAnchorSelect(sAnchors, pos)
{
    if (form.Variables["AnchorWindow"])
        return;

    var formArgs = [sAnchors];

    var windowConfig = {
        resizable: false,
        x: pos.x,
        y: pos.y,
        header: false
    };

    return await form.ShowModalDialog(lims.GetFormSource("FormDesigner.dlgAnchor"), formArgs, null, windowConfig);
}
