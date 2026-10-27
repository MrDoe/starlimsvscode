/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
/*
Description.. :	Layout-Editor-style interaction for the FormDesigner canvas,
			following the Starlims Designer stance on the left button
			(XFD-INTERACTION):
			- press on a control + drag MOVES it (the press selects it, just
			  like the designer does; XFD-SNAP: snaps edges/centers to
			  neighbouring controls, Alt held = no snapping)
			- press on the EMPTY CANVAS + drag draws the selection bounding
			  box - the band NEVER starts over a control (XFD-MULTISELECT)
			- click SELECTS the pressed control; click on the empty canvas
			  clears the selection
			- group move of a multi-selection, Ctrl+click toggles membership
			- presses are never stopPropagation()ed: interactive widgets (tabs,
			  comboboxes, grids, checkboxes) keep their native Ext click
			  semantics - only the designer gestures are suppressed
			- XFD-EVTGUARD: the event bus clones one physical event per bound
			  handler (markers on the event object do not survive the clone);
			  a document-capture generation counter lets exactly one handler
			  call per physical click/press through
			- dropping into Form/Panel/GroupBox/TabPage/SplitterPanel REPARENTS
			  the control, moves its outline node and recomputes the depth based
			  z-index through SetZIndex() (XFD-REPARENT); the outline tree
			  drag/drop runs through the same component-sync helper.
			- XFD-KEYNAV: arrow keys nudge the selected control(s) from anywhere
			  on the canvas (Shift = 10 px); a document-level handler with
			  focus guards, since the per-control keydown binding only fires
			  for controls whose element actually has focus.
			- COORDINATE CONVENTION: all internal snap/overlay coordinates are
			  PAGE space (getXY semantics). getBoundingClientRect() results
			  MUST be converted with window.scrollX/scrollY before they are
			  compared with, or subtracted against, getXY-based values - the
			  mixing is invisible at scroll == 0 but silently kills Y-snapping
			  on a scrolled canvas and draws guides/ghosts scroll-offset.
	Grep markers: XFD-INTERACTION, XFD-SNAP, XFD-MULTISELECT, XFD-REPARENT,
	XFD-EVTGUARD, XFD-KEYNAV.
	Save semantics are untouched: savexml serializes from the outline tree,
	which is exactly why every reparent moves the tree NODE (not just CSS).
Author....... :	DC (VS Code designer shell extension)
Date......... :	2026-10-27
*/

// ---------------------------------------------------------------------------
// constants (XFD-INTERACTION)
// ---------------------------------------------------------------------------
var XFD_SNAP_DISTANCE = 6;    // px attraction radius for snap lines (XFD-SNAP)
var XFD_MOVE_THRESHOLD = 4;   // px of press-drag before a move starts (click stays click)
var XFD_MARQUEE_THRESHOLD = 2;

// valid reparent targets for canvas drops AND tree drops (XFD-REPARENT)
var XFD_REPARENT_TYPES = { Form: true, Panel: true, GroupBox: true, TabPage: true, SplitterPanel: true };

// child kinds whose placement is managed by their host control (never freely movable)
var XFD_STRUCTURAL_TYPES = {
    TabPage: true, SplitterPanel: true, DataGridColumn: true,
    DataGridTable: true, ButtonBarGroup: true, LinkBarGroup: true
};

// selection model (XFD-MULTISELECT): StarlimsControls, last entry = primary.
// "selectedControl" (wire global) always equals the primary.
var _xfdSelection = [];
var _xfdSuppressClick = false;

// XFD-EVTGUARD: the deployed event bus delivers one physical mouse event to
// EVERY designer binding it passes (the control's own handler, the form's, a
// treeview re-binding...), CLONING it into a fresh plain object per handler -
// a marker set on the event object never reaches the next clone (the reason
// Ctrl+click toggled twice: add, then immediately remove). Dedup by
// capture-phase generation instead: document sees each dispatched event
// exactly once before any handler, so (generation, target) identifies the
// physical event. Programmatic callers pass plain { target: control } objects
// that were never dispatched - those always pass.
var _xfdEvtGen = { click: 0, mousedown: 0 };
document.addEventListener("click", function () { _xfdEvtGen.click++; }, true);
document.addEventListener("mousedown", function () { _xfdEvtGen.mousedown++; }, true);

function XfdClaimEvent(e, guard)
{
    if (e.__xfdClaimed)                           // same object delivered twice
        return false;

    if (e.target && e.target.nodeType === undefined)  // programmatic call
    {
        e.__xfdClaimed = true;
        return true;
    }

    var gen = _xfdEvtGen[guard.type];
    if (guard.gen === gen && guard.tgt === e.target)
        return false;                             // another clone of this event
    guard.gen = gen;
    guard.tgt = e.target;
    e.__xfdClaimed = true;
    return true;
}

var _xfdClickGuard = { type: "click", gen: -1, tgt: null };
var _xfdMdownGuard = { type: "mousedown", gen: -1, tgt: null };

// XFD-KEYNAV: arrow keys nudge the selection from ANYWHERE on the canvas.
// The legacy .keydown(__control_OnKeyDown) binding fires only when the
// control's own element has focus - clicking a label/grid/panel never focuses
// it - so the arrows were effectively dead in practice. One document-level
// handler fixes reachability. It yields when (a) real text/widget focus is in
// the path (inputs, the property grid, the outline tree, combos, iframes -
// arrow keys belong to those widgets there) or (b) the event resolves to a
// designer control - that control's own legacy binding handles it and moving
// here too would double-step. Group semantics mirror __control_OnKeyDown:
// whole move set, Shift = 10 px, journal membership stamped.
if (!window.__xfdArrowBound)
{
    window.__xfdArrowBound = true;
    document.addEventListener("keydown", function (e)
    {
        // e.key first: untrusted/a11y-generated events carry keyCode 0
        var KEYMAP = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
        var code = KEYMAP[e.key] || e.keyCode || e.which;
        if (code < 37 || code > 40)                       // arrows only
            return;

        var t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
            return;
        // Real Ext widget chrome (property grid = x-grid, outline = x-tree,
        // combos/text = x-form-field). NOTE: [automation-id='_dgdProperties']
        // style lookups are DEAD here - those components carry generated
        // ids (StarlimsDataGrid-N / treepanel-N), so match widget classes.
        if (t && t.closest && t.closest(".x-grid, .x-tree, .x-form-field, iframe"))
            return;
        if (XfdResolveControlFromEvent(e))
            return;                                       // legacy binding owns it

        var targets = XfdMoveSet();
        if (!targets.length && XfdIsMovable(selectedControl))
            targets = [selectedControl];
        if (!targets.length)
            return;                                       // nothing selected: let it scroll

        var step = e.shiftKey ? 10 : 1;
        if (code === 37) targets.forEach(function (c) { c.Left -= step; });
        else if (code === 38) targets.forEach(function (c) { c.Top -= step; });
        else if (code === 39) targets.forEach(function (c) { c.Left += step; });
        else targets.forEach(function (c) { c.Top += step; });

        // XFD-SAVEV3: a keyboard nudge is a user move - journal membership
        if (window.XfdJournal)
            targets.forEach(function (c)
            {
                window.XfdJournal.stamp(c, "Left");
                window.XfdJournal.stamp(c, "Top");
            });

        if (e.preventDefault) e.preventDefault();
        UpdateSelectionFrame(selectedControl);
        XfdRefreshSelectionVisuals();
    }, false);
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

// the absolute-layout positioning context of a container control (Ext's
// abs layout positions items into the layout's innerElement)
function XfdContextEl(container)
{
    if (!container)
        return null;

    try
    {
        var layout = container.getLayout ? container.getLayout() : null;
        if (layout && layout.innerElement)
            return layout.innerElement;
    }
    catch (e) { /* fall through */ }

    if (container.body)
        return container.body;

    return container.getEl ? container.getEl() : null;
}

function XfdElOf(control)
{
    if (!control || typeof control.getEl !== "function")
        return null;

    try
    {
        var el = control.getEl();
        return (el && el.dom) ? el : null;
    }
    catch (e) { return null; }
}

// origin (page xy) of the form's positioning context - all overlay
// coordinates are form-context-local
function XfdFormOrigin()
{
    var ctx = XfdContextEl(_Form1);
    if (!ctx)
        return [0, 0];
    var xy = ctx.getXY();
    return [xy[0], xy[1]];
}

function XfdIsDesignerControl(c)
{
    return !!(c && c.Guid && htControls.ContainsKey(c.Guid));
}

// all designer controls as a plain array
function XfdAllControls()
{
    var list = [];
    for (var i = 0; i < htControls.Keys.length; ++i)
    {
        var c = htControls[htControls.Keys[i]];
        if (c)
            list.push(c);
    }
    return list;
}

// resolve a mouse/key event target to the designer control that owns it
// (walks Ext's component chain until a htControls member; a press inside ANY
// designer control must resolve to it, otherwise the band would start over a
// control - XFD-INTERACTION). Tab strip headers included: they belong to their
// TabControl, which is what makes the TabControl selectable/draggable at all
// (Ext already activated the tab on its own, deeper handler).
function XfdResolveControlFromEvent(e)
{
    // synthetic events from AddControl/AddColumn/combo pass the control itself
    if (e.target && e.target.Guid && htControls.ContainsKey(e.target.Guid))
        return e.target;

    var dom = e.target;
    if (!dom || !dom.closest)
        return null;

    var c = null;
    try { c = dom.nodeType === 1 ? Ext.Component.from(dom) : dom; } catch (err) { c = null; }

    // Ext-internal parts (a grid's view, a title text, a toolbar body...) are
    // not on the DTO Parent chain - they only reach their widget through
    // ownerCt, so follow both links upwards.
    for (var hop = 0; c && hop < 40; ++hop)
    {
        if (XfdIsDesignerControl(c))
            return c;
        c = c.Parent || (c.getParent ? c.getParent() : null) || c.ownerCt || null;
    }
    return null;
}

// true when c is freely movable and part of the designed form
function XfdIsMovable(c)
{
    if (!c || c === _Form1 || !XfdIsDesignerControl(c))
        return false;
    if (XFD_STRUCTURAL_TYPES[c.xType])
        return false;
    if (typeof c.Left !== "number" || typeof c.Top !== "number")
        return false;
    if (!XfdElOf(c))
        return false;
    if (c.Parent && c.Parent.xType === "TabControl")   // tab pages etc.
        return false;
    return true;
}

function XfdIsDescendantOf(c, ancestor)
{
    var p = c ? c.Parent : null;
    while (p)
    {
        if (p === ancestor)
            return true;
        p = p.Parent;
    }
    return false;
}

// can the container accept freely movable children at an absolute position?
function XfdCanContain(container, dragged)
{
    if (!container || !container.xType)
        return false;
    if (container !== _Form1 && !XFD_REPARENT_TYPES[container.xType])
        return false;
    if (container === dragged)
        return false;
    if (XfdIsDescendantOf(container, dragged))       // no dropping into self
        return false;

    var layout = (container.Layout || "ABSOLUTE").toString().toUpperCase();
    if (layout !== "ABSOLUTE")                       // HBOX/VBOX panels: no
        return false;

    return true;
}

// find the container under a viewport point (dragged elements are ignored)
function XfdHitContainer(clientX, clientY, members)
{
    var i;
    for (i = 0; i < members.length; ++i)
    {
        var el = XfdElOf(members[i]);
        if (el)
            el.dom.style.pointerEvents = "none";
    }

    var target = null;
    try
    {
        var dom = document.elementFromPoint(clientX, clientY);
        var c = null;
        try { c = dom ? Ext.Component.from(dom) : null; } catch (err) { c = null; }
        while (c)
        {
            var valid = true;
            for (i = 0; i < members.length; ++i)
            {
                if (c === members[i] || XfdIsDescendantOf(c, members[i]))
                { valid = false; break; }
            }
            if (valid && XfdCanContain(c, members[0]))
            { target = c; break; }
            c = c.Parent || (c.getParent ? c.getParent() : null);
        }
    }
    finally
    {
        for (i = 0; i < members.length; ++i)
        {
            var el2 = XfdElOf(members[i]);
            if (el2)
                el2.dom.style.pointerEvents = "";
        }
    }
    return target;
}

function XfdPointInsideForm(clientX, clientY)
{
    var el = XfdElOf(_Form1);
    if (!el)
        return false;
    var r = el.dom.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

// ---------------------------------------------------------------------------
// selection API (XFD-MULTISELECT)
// ---------------------------------------------------------------------------

function XfdGetPrimaryControl()
{
    return _xfdSelection.length ? _xfdSelection[_xfdSelection.length - 1] : null;
}

function XfdIsControlSelected(c)
{
    return _xfdSelection.indexOf(c) >= 0;
}

// replace the selection; "selectedControl" follows the primary
function XfdSetSelection(list)
{
    _xfdSelection = (list || []).filter(function (c) { return c && c !== _Form1; });
    if (_xfdSelection.length)
        selectedControl = _xfdSelection[_xfdSelection.length - 1];
    else
        selectedControl = _Form1;

    XfdRefreshSelectionVisuals();
}

// plain click: replace; Ctrl+click: toggle membership
function XfdSelectControl(c, toggle)
{
    if (!c || c === _Form1)
    {
        XfdSetSelection([]);
        return;
    }

    if (!toggle)
    {
        XfdSetSelection([c]);
        return;
    }

    var list = _xfdSelection.slice();
    var idx = list.indexOf(c);
    if (idx >= 0)
        list.splice(idx, 1);
    else
        list.push(c);

    XfdSetSelection(list);
}

// silent sync when the outline tree drives the selection (no recursion).
// The group survives when the tree merely reflects the CURRENT primary
// (click-driven tree selection round-trips through this listener).
function XfdSyncTreeSelection(c)
{
    if (XfdGetPrimaryControl() === c)
        return;
    _xfdSelection = (c && c !== _Form1) ? [c] : [];
}

function XfdClearSelection()
{
    XfdSetSelection([]);
    if (pnlSelected)
        pnlSelected.Visible = false;
}

// the controls a group-move/drag actually translates: selected movable
// controls whose (selected) ancestor is not itself in the move set - the
// ancestor carries its children along
function XfdMoveSet()
{
    var movable = _xfdSelection.filter(XfdIsMovable);
    return movable.filter(function (c)
    {
        for (var i = 0; i < movable.length; ++i)
            if (movable[i] !== c && XfdIsDescendantOf(c, movable[i]))
                return false;
        return true;
    });
}

// the delete set: everything selected except controls under another selected control
function XfdTopLevelSelection()
{
    return _xfdSelection.filter(function (c)
    {
        for (var i = 0; i < _xfdSelection.length; ++i)
            if (_xfdSelection[i] !== c && XfdIsDescendantOf(c, _xfdSelection[i]))
                return false;
        return true;
    });
}

// ---------------------------------------------------------------------------
// overlay visuals (XFD-MULTISELECT / XFD-SNAP)
// ---------------------------------------------------------------------------

var _xfdOverlay = null;

function XfdOverlay()
{
    var ctx = XfdContextEl(_Form1);
    if (!ctx)
        return null;

    if (_xfdOverlay && _xfdOverlay.dom && _xfdOverlay.dom.parentNode !== ctx.dom)
        _xfdOverlay = null;

    if (!_xfdOverlay || !_xfdOverlay.dom)
    {
        var div = document.createElement("div");
        div.id = "xfdOverlay";
        div.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:99998;pointer-events:none;";
        ctx.dom.appendChild(div);
        _xfdOverlay = Ext.get(div);
    }
    return _xfdOverlay;
}

function XfdOverlayRect()
{
    // CONVENTION (see header): PAGE space. The overlay is pinned to the form
    // context origin, but its rect is CLIENT space - add window scroll.
    var overlay = XfdOverlay();
    if (!overlay)
        return { left: 0, top: 0 };
    var r = overlay.dom.getBoundingClientRect();
    return { left: r.left + window.scrollX, top: r.top + window.scrollY };
}

function XfdClearOverlayBoxes(cls)
{
    var overlay = XfdOverlay();
    if (!overlay)
        return;

    var kids = Array.prototype.slice.call(overlay.dom.childNodes);
    for (var i = 0; i < kids.length; ++i)
    {
        if (!cls || kids[i].className === cls)
            overlay.dom.removeChild(kids[i]);
    }
}

function XfdAddOverlayBox(cls, x, y, w, h, css)
{
    var overlay = XfdOverlay();
    if (!overlay)
        return;

    var div = document.createElement("div");
    div.className = cls;
    div.style.cssText = "position:absolute;pointer-events:none;left:" + Math.round(x) +
        "px;top:" + Math.round(y) + "px;width:" + Math.round(w) +
        "px;height:" + Math.round(h) + "px;" + (css || "");
    overlay.dom.appendChild(div);
}

// blue dashed frames around all selected members except the primary
// (the primary keeps the red pnlSelected frame)
function XfdRefreshSelectionVisuals()
{
    XfdClearOverlayBoxes("xfd-selbox");
    if (!_xfdSelection.length)
        return;

    var origin = XfdOverlayRect();
    var primary = XfdGetPrimaryControl();

    for (var i = 0; i < _xfdSelection.length; ++i)
    {
        var c = _xfdSelection[i];
        if (c === primary)
            continue;

        var el = XfdElOf(c);
        if (!el)
            continue;

        var r = el.dom.getBoundingClientRect();
        if (r.width <= 0 && r.height <= 0)
            continue;

        // r is CLIENT space, origin (XfdOverlayRect) is PAGE space
        XfdAddOverlayBox("xfd-selbox", r.left + window.scrollX - origin.left - 1,
            r.top + window.scrollY - origin.top - 1,
            r.width + 2, r.height + 2, "border:1px dashed #157fcc;");
    }
}

// single box that follows a drag/marquee (XFD-MULTISELECT)
function XfdShowDragFrame(pageX, pageY, w, h)
{
    var origin = XfdOverlayRect();
    XfdClearOverlayBoxes("xfd-marquee");
    XfdAddOverlayBox("xfd-marquee", pageX - origin.left, pageY - origin.top, w, h,
        "border:1px dashed #157fcc;background:rgba(21,127,204,0.10);");
}

// alignment guides during a snapped move (XFD-SNAP)
function XfdShowSnapGuides(vLines, hLines)
{
    var origin = XfdOverlayRect();
    XfdClearOverlayBoxes("xfd-guide");

    var i;
    for (i = 0; i < vLines.length; ++i)
        XfdAddOverlayBox("xfd-guide", vLines[i] - origin.left, -4000, 1, 8000, "background:#e04040;");
    for (i = 0; i < hLines.length; ++i)
        XfdAddOverlayBox("xfd-guide", -4000, hLines[i] - origin.top, 8000, 1, "background:#e04040;");
}

function XfdHideTransient()
{
    XfdClearOverlayBoxes("xfd-marquee");
    XfdClearOverlayBoxes("xfd-guide");
}

function XfdResetInteractionState()
{
    _xfdSelection = [];
    _xfdSuppressClick = false;

    if (_xfdOverlay && _xfdOverlay.dom && _xfdOverlay.dom.parentNode)
        _xfdOverlay.dom.parentNode.removeChild(_xfdOverlay.dom);
    _xfdOverlay = null;
}

// ---------------------------------------------------------------------------
// snapping (XFD-SNAP)
// ---------------------------------------------------------------------------

// candidate page-space lines (edges + centers) of every visible control
function XfdCollectSnapLines(members)
{
    var xs = [], ys = [];

    var add = function (r)
    {
        // rect -> PAGE space (header convention): the drag candidates are
        // getXY/pageY based, so raw client lines would sit scrollX/scrollY
        // away from their true position while the document is scrolled
        // (XFD-SNAP: this is what used to kill Y-snapping on a scrolled canvas)
        var sx = window.scrollX, sy = window.scrollY;
        xs.push(r.left + sx, r.left + r.width / 2 + sx, r.left + r.width + sx);
        ys.push(r.top + sy, r.top + r.height / 2 + sy, r.top + r.height + sy);
    };

    var formEl = XfdElOf(_Form1);
    if (formEl)
        add(formEl.dom.getBoundingClientRect());

    var all = XfdAllControls();
    for (var i = 0; i < all.length; ++i)
    {
        var c = all[i];
        if (c === _Form1 || !XfdIsDesignerControl(c))
            continue;

        var skip = false;
        for (var m = 0; m < members.length; ++m)
        {
            if (c === members[m] || XfdIsDescendantOf(c, members[m]))
            { skip = true; break; }
        }
        if (skip)
            continue;

        var el = XfdElOf(c);
        if (!el || !el.dom.offsetParent)
            continue;

        var r = el.dom.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0)
            continue;

        add(r);
    }
    return { xs: xs, ys: ys };
}

// smallest |delta| <= XFD_SNAP_DISTANCE aligning pos/center/end with a line
function XfdSnapDelta(pos, size, lines)
{
    var best = null;
    for (var i = 0; i < lines.length; ++i)
    {
        var options = [lines[i] - pos, lines[i] - (pos + size), lines[i] - (pos + size / 2)];
        for (var o = 0; o < options.length; ++o)
        {
            var d = options[o];
            if (Math.abs(d) <= XFD_SNAP_DISTANCE && (best === null || Math.abs(d) < Math.abs(best)))
                best = d;
        }
    }
    return best === null ? 0 : best;
}

// ---------------------------------------------------------------------------
// drag layer + reparent (XFD-REPARENT)
// ---------------------------------------------------------------------------

// Move the members' DOM elements into the form's positioning context for the
// duration of the drag - every panel body is overflow:hidden and would clip
// a control dragged out of it. DOM-only: Controls/Parent/tree are untouched,
// so a cancelled drag restores with one appendChild back.
function XfdLiftForDrag(state)
{
    // the form context origin is probed once per drag (synchronous Left/Top
    // zero probe - all within one JS turn, so nothing is ever painted)
    if (!state.formOrigin)
    {
        var probeMember = state.members.filter(function (m) { return XfdElOf(m.c); })[0];
        state.formOrigin = probeMember
            ? XfdProbeOrigin(probeMember.c, XfdContextEl(_Form1))
            : XfdFormOrigin();
    }

    var i;
    for (i = 0; i < state.members.length; ++i)
    {
        var st = state.members[i];
        var el = XfdElOf(st.c);
        if (!el)
            continue;

        st.z0 = el.dom.style.zIndex || "";
        el.dom.style.zIndex = "99992";

        if (st.parent0 !== _Form1)
        {
            var ctx = XfdContextEl(_Form1);
            if (ctx && el.dom.parentNode !== ctx.dom)
                ctx.dom.appendChild(el.dom);
            st.lifted = true;
        }

        st.baseX = st.page0[0] - state.formOrigin[0];
        st.baseY = st.page0[1] - state.formOrigin[1];
    }
}

// Synchronously determine which page coordinates Left/Top zero mean for a
// control inside a given positioning context: park the element at 0/0, read
// its page position (that IS the context origin), restore the old values.
// Never trust parsed style left/top - Ext positions through setPosition and
// wrappers can shift the context by border/padding pixels.
function XfdProbeOrigin(c, ctxEl)
{
    var el = XfdElOf(c);
    if (!el || !ctxEl)
        return XfdFormOrigin();

    if (el.dom.parentNode !== ctxEl.dom)
        ctxEl.dom.appendChild(el.dom);

    var l0 = c.Left, t0 = c.Top;
    try
    {
        c.Left = 0;
        c.Top = 0;
        var xy = el.getXY();
        var origin = [xy[0], xy[1]];
        c.Left = l0;
        c.Top = t0;
        return origin;
    }
    catch (e)
    {
        try { c.Left = l0; c.Top = t0; } catch (e2) { }
        return XfdFormOrigin();
    }
}

// Move a component into another container WITHOUT losing its visual page
// position (the outline node move is the caller's job - savexml nests from
// the tree!). Ext's remove actionMode hides the element, so visibility is
// captured and restored explicitly.
function XfdReparentComponent(c, target, keepPageXY)
{
    var oldParent = c.Parent;
    if (!oldParent || oldParent === target || !oldParent.Controls || !target.Controls)
        return false;

    if (!XfdIsMovable(c) && c !== _Form1)
        return false;

    var el = XfdElOf(c);
    if (!el)
        return false;

    if (!keepPageXY)
        keepPageXY = el.getXY();

    var wasVisible = c.Visible;

    oldParent.Controls.Remove(c);          // -> Ext remove(item,false): hides, no destroy
    target.Controls.Add(c);                // -> Ext add: el moves into target's items

    if (c.hidden)
        c.show();
    c.Visible = wasVisible;

    // park at 0/0 inside the NEW context to read its page origin, then
    // restore the visual position exactly
    var origin = XfdProbeOrigin(c, XfdContextEl(target));
    c.Left = Math.round(keepPageXY[0] - origin[0]);
    c.Top = Math.round(keepPageXY[1] - origin[1]);
    return true;
}

// move the outline node under the target's node (savexml + SetZIndex truth)
async function XfdMoveOutlineNode(c, target)
{
    var node = await FindNodeByGuid(c.Guid);
    var targetNode = (target === _Form1)
        ? _treePanel.getRootNode().firstChild
        : await FindNodeByGuid(target.Guid);

    if (!node || !targetNode)
        return false;

    if (node.parentNode !== targetNode)
    {
        targetNode.appendChild(node);
        targetNode.expand();
    }
    return true;
}

// restore a lifted member into its original parent context (cancelled drop)
function XfdRestoreMember(st)
{
    var el = XfdElOf(st.c);
    if (!el)
        return;

    if (st.lifted)
    {
        var ctx = XfdContextEl(st.parent0);
        if (ctx && el.dom.parentNode !== ctx.dom)
            ctx.dom.appendChild(el.dom);
        st.lifted = false;
    }

    var origin = XfdProbeOrigin(st.c, XfdContextEl(st.parent0));

    st.c.Left = Math.round(st.page0[0] - origin[0]);
    st.c.Top = Math.round(st.page0[1] - origin[1]);

    if (st.z0 !== undefined)
        el.dom.style.zIndex = st.z0;
}

// ---------------------------------------------------------------------------
// move engine (XFD-SNAP / XFD-MULTISELECT / XFD-REPARENT)
// ---------------------------------------------------------------------------

function XfdBeginMove(e, hitControl)
{
    var members;
    if (XfdIsControlSelected(hitControl))
        members = XfdMoveSet();                              // group move
    else
    {
        // the press selects what it grabs (designer behavior), so a control
        // that was not selected yet becomes the single member
        XfdSetSelection([hitControl]);
        members = [hitControl];
    }
    if (!members.length)
        return;

    var state = { members: [], x0: e.pageX, y0: e.pageY, moved: false, snap: null };
    for (var i = 0; i < members.length; ++i)
    {
        var el = XfdElOf(members[i]);
        state.members.push({
            c: members[i],
            parent0: members[i].Parent,
            page0: el.getXY(),
            lifted: false
        });
    }

    if (pnlSelected)
        pnlSelected.Visible = false;

    function handle_moving(ev)
    {
        var dx = ev.pageX - state.x0;
        var dy = ev.pageY - state.y0;

        if (!state.moved)
        {
            if (Math.abs(dx) < XFD_MOVE_THRESHOLD && Math.abs(dy) < XFD_MOVE_THRESHOLD)
                return;
            state.moved = true;
            _xfdSuppressClick = true;
            XfdLiftForDrag(state);

            // snap lines in the SAME context-local space as the member base
            // coordinates (they are collected in page space; o0 is the drag
            // context's ACTUAL page origin, derived during the lift) XFD-SNAP
            var snap = XfdCollectSnapLines(state.members.map(function (m) { return m.c; }));
            var o0 = state.formOrigin || XfdFormOrigin();
            state.snap = {
                xs: snap.xs.map(function (v) { return v - o0[0]; }),
                ys: snap.ys.map(function (v) { return v - o0[1]; })
            };
            state.origin = o0;
        }

        if (ev.preventDefault)
            ev.preventDefault();

        // union box of the (lifted) members at raw delta - page space
        var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, j;
        for (j = 0; j < state.members.length; ++j)
        {
            var st = state.members[j];
            var el = XfdElOf(st.c);
            if (!el)
                continue;
            var bx = st.baseX + dx, by = st.baseY + dy;
            var r = el.dom.getBoundingClientRect();
            minX = Math.min(minX, bx); minY = Math.min(minY, by);
            maxX = Math.max(maxX, bx + r.width); maxY = Math.max(maxY, by + r.height);
        }

        var snx = 0, sny = 0, guidesV = [], guidesH = [];
        if (!ev.altKey && state.snap)                        // XFD-SNAP: Alt = off
        {
            snx = XfdSnapDelta(minX, maxX - minX, state.snap.xs);
            sny = XfdSnapDelta(minY, maxY - minY, state.snap.ys);

            // report the lines that attracted (page space)
            if (snx !== 0)
                guidesV = [minX + snx, minX + snx + (maxX - minX) / 2, minX + snx + (maxX - minX)];
            if (sny !== 0)
                guidesH = [minY + sny, minY + sny + (maxY - minY) / 2, minY + sny + (maxY - minY)];
        }

        for (j = 0; j < state.members.length; ++j)
        {
            var st2 = state.members[j];
            st2.c.Left = Math.round(st2.baseX + dx + snx);   // group: equal delta
            st2.c.Top = Math.round(st2.baseY + dy + sny);
        }

        var origin = state.origin || XfdFormOrigin();
        XfdShowSnapGuides(guidesV.map(function (v) { return v + origin[0]; }),
                          guidesH.map(function (v) { return v + origin[1]; }));
        XfdShowDragFrame(minX + snx + origin[0], minY + sny + origin[1], maxX - minX, maxY - minY);
    }

    async function handle_up(ev)
    {
        $('body').off('mousemove', handle_moving).off('mouseup', handle_up);

        XfdHideTransient();

        if (!state.moved)
        {
            if (pnlSelected)
                pnlSelected.Visible = true;
            UpdateSelectionFrame(XfdGetPrimaryControl() || _Form1);
            return;
        }

        // resolve the drop target (XFD-REPARENT)
        var inside = XfdPointInsideForm(ev.clientX, ev.clientY);
        var target = null;
        if (inside)
            target = XfdHitContainer(ev.clientX, ev.clientY, state.members.map(function (m) { return m.c; }));

        for (var j = 0; j < state.members.length; ++j)
        {
            var st = state.members[j];
            var el = XfdElOf(st.c);

            if (!inside)
            {
                // dropped outside the canvas: restore original parent + position
                XfdRestoreMember(st);
                continue;
            }

            if (target && target !== st.parent0 && XfdCanContain(target, st.c))
            {
                var pageXY = el ? el.getXY() : st.page0;
                var reparented = XfdReparentComponent(st.c, target, pageXY);
                await XfdMoveOutlineNode(st.c, target);     // savexml + z-index truth
                st.movedTree = true;

                // save-v3: a reparent is journaled as __del__ under the OLD
                // parent + __add__ under the NEW one with the SAME guid - the
                // journaled add copy carries the recomputed Left/Top, so no
                // scalar stamps here. Cancelled drops never reach this branch
                // (XfdRestoreMember restores without a Controls change).
                if (reparented && window.XfdJournal)
                {
                    window.XfdJournal.stampDeleted(st.c);
                    window.XfdJournal.stampAdded(st.c);
                }
                else if (!reparented && window.XfdJournal)
                {
                    // reparent declined (not movable-into / no el): the member
                    // sits where the drag left it under its OLD parent - that
                    // is still a user move, journal it as one
                    window.XfdJournal.stamp(st.c, "Left");
                    window.XfdJournal.stamp(st.c, "Top");
                }
            }
            else
            {
                // stays in its parent - just settle where the drag left it
                if (st.lifted && el)
                {
                    var xyNow = el.getXY();
                    // move back into the original parent's context (no
                    // Controls change) keeping the current visual position
                    var origin = XfdProbeOrigin(st.c, XfdContextEl(st.parent0));
                    st.c.Left = Math.round(xyNow[0] - origin[0]);
                    st.c.Top = Math.round(xyNow[1] - origin[1]);
                    st.lifted = false;
                    if (st.z0 !== undefined)
                        el.dom.style.zIndex = st.z0;
                }

                // save-v3: the drag owns this member's final position - one
                // membership stamp per (control, Left/Top) at gesture END
                // (handle_moving wrote intermediate + probe values; the merge
                // takes the final value from the save-time hint anyway)
                if (window.XfdJournal)
                {
                    window.XfdJournal.stamp(st.c, "Left");
                    window.XfdJournal.stamp(st.c, "Top");
                }
            }
        }

        SetZIndex();                                         // XFD-REPARENT: z from tree depth
        XfdRefreshSelectionVisuals();

        var primary = XfdGetPrimaryControl();
        if (primary)
        {
            if (pnlSelected)
                pnlSelected.Visible = true;
            UpdateSelectionFrame(primary);
            XfdSelectPrimaryInTree(primary);
        }
    }

    $('body').on('mouseup', handle_up).on('mousemove', handle_moving);
}

// select the primary in the outline tree without driving selection back
function XfdSelectPrimaryInTree(c)
{
    (async function ()
    {
        var node = await FindNodeByGuid(c.Guid);
        if (node)
            _treePanel.getSelectionModel().select(node);
    })();
}

// ---------------------------------------------------------------------------
// resize (Ctrl+drag) - kept from the original, plus click suppression
// ---------------------------------------------------------------------------

function XfdBeginResize(e)
{
    var control = XfdGetPrimaryControl() || selectedControl;
    if (!control || control === _Form1)
        return;

    if (pnlSelected)
        pnlSelected.Visible = false;

    var state = {
        x0: e.pageX, y0: e.pageY, moved: false,
        w0: control.Width, h0: control.Height
    };

    function handle_resizing(ev)
    {
        if (!state.moved && Math.abs(ev.pageX - state.x0) < XFD_MOVE_THRESHOLD &&
            Math.abs(ev.pageY - state.y0) < XFD_MOVE_THRESHOLD)
            return;
        state.moved = true;
        _xfdSuppressClick = true;
        control.Width = state.w0 + (ev.pageX - state.x0);
        control.Height = state.h0 + (ev.pageY - state.y0);
    }

    function handle_up(ev)
    {
        $('body').off('mousemove', handle_resizing).off('mouseup', handle_up);

        if (state.moved)
        {
            control.Width = Math.max(1, state.w0 + (ev.pageX - state.x0));
            control.Height = Math.max(1, state.h0 + (ev.pageY - state.y0));

            // save-v3: gesture-end membership stamp (final value rides the hint)
            if (window.XfdJournal)
            {
                window.XfdJournal.stamp(control, "Width");
                window.XfdJournal.stamp(control, "Height");
            }
        }

        if (pnlSelected)
            pnlSelected.Visible = true;
        UpdateSelectionFrame(control);
        XfdRefreshSelectionVisuals();
    }

    $('body').on('mouseup', handle_up).on('mousemove', handle_resizing);
}

// ---------------------------------------------------------------------------
// marquee selection (XFD-MULTISELECT)
// ---------------------------------------------------------------------------

function XfdMarqueeCandidates()
{
    var list = [];
    var all = XfdAllControls();
    for (var i = 0; i < all.length; ++i)
    {
        var c = all[i];
        if (!XfdIsMovable(c))
            continue;
        var el = XfdElOf(c);
        if (!el || !el.dom.offsetParent)
            continue;
        var r = el.dom.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0)
            continue;
        list.push({ c: c, r: r });
    }
    return list;
}

function XfdBeginMarquee(e)
{
    var x0 = e.pageX, y0 = e.pageY;
    var base = e.shiftKey || e.ctrlKey ? _xfdSelection.slice() : [];
    var moved = false;

    function hitList(bx, by, bw, bh)
    {
        // INTERSECT semantics: any movable control the band touches (XFD-MULTISELECT)
        var hits = [];
        var cand = XfdMarqueeCandidates();
        for (var i = 0; i < cand.length; ++i)
        {
            var r = cand[i].r;
            var l = r.left + window.scrollX, t = r.top + window.scrollY;
            if (l < bx + bw && l + r.width > bx && t < by + bh && t + r.height > by)
                hits.push(cand[i].c);
        }
        return hits;
    }

    function handle_moving(ev)
    {
        var bx = Math.min(x0, ev.pageX), by = Math.min(y0, ev.pageY);
        var bw = Math.abs(ev.pageX - x0), bh = Math.abs(ev.pageY - y0);

        if (!moved && bw < XFD_MARQUEE_THRESHOLD && bh < XFD_MARQUEE_THRESHOLD)
            return;
        moved = true;
        _xfdSuppressClick = true;
        if (ev.preventDefault)
            ev.preventDefault();

        XfdShowDragFrame(bx, by, bw, bh);

        XfdSetSelection(base.concat(hitList(bx, by, bw, bh))
            .filter(function (c, idx, arr) { return c && arr.indexOf(c) === idx; }));
    }

    function handle_up(ev)
    {
        $('body').off('mousemove', handle_moving).off('mouseup', handle_up);
        XfdHideTransient();

        if (!moved)
            return;                                          // plain click follows

        XfdRefreshSelectionVisuals();
        var primary = XfdGetPrimaryControl();
        if (primary)
        {
            if (pnlSelected)
                pnlSelected.Visible = true;
            UpdateSelectionFrame(primary);
            XfdSelectPrimaryInTree(primary);
        }
        else if (pnlSelected)
        {
            pnlSelected.Visible = false;
        }
    }

    $('body').on('mouseup', handle_up).on('mousemove', handle_moving);
}

// ---------------------------------------------------------------------------
// unified mousedown entry (bound by guifunctions' __control_OnDrag and the
// canvas binding) - dispatches to move / resize / marquee
//
// Starlims Designer left-button stance (XFD-INTERACTION):
//   - press on a control + drag        -> MOVES the control (the press
//     selects it first; a selected control drags its whole selection along)
//   - press on the empty canvas + drag -> draws the selection bounding box
//   - a press that does not move       -> the plain click SELECTS the pressed
//     control, or CLEARS the selection on the empty canvas
// The band NEVER starts while the cursor is above a control - only a press on
// the form's own surface can draw it. Shift+drag is the explicit escape hatch
// and bands from anywhere.
//
// Presses are never stopPropagation()ed: tabs, comboboxes, grids and
// checkboxes stay live widgets (Ext delegates their handling up to the
// document), so the designer suppresses GESTURES only, never the widget's own
// click semantics - clicking a tab still changes the TabControl's page.
// ---------------------------------------------------------------------------

// the form's own surface - everything else counts as "a control", including
// the surfaces of non-movable children (TabPage/SplitterPanel body, grid
// columns, button/link bars): only a press here may start the band
function XfdIsEmptyCanvas(control)
{
    return !control || control === _Form1;
}

// which control (if any) does this press grab for a move? A movable control is
// grabbed directly (XfdBeginMove selects it when it is not selected yet). A
// press on a NON-movable surface is carried by the selected movable ANCESTOR,
// so a selected container can be grabbed by its own child chrome.
function XfdGrabbedForMove(control)
{
    if (XfdIsEmptyCanvas(control))
        return null;

    if (XfdIsMovable(control))
        return control;

    for (var a = control.Parent; a; a = a.Parent)
        if (XfdIsMovable(a) && XfdIsControlSelected(a))
            return a;

    return null;
}

function XfdHandleMouseDown(e, explicitControl)
{
    if (form.Variables["PreventClickEvents"] === true)
        return;

    // left button only
    if (e.which !== undefined && e.which !== 1)
        return;

    // XFD-EVTGUARD: the event bus clones the native event into a FRESH plain
    // object for every bound handler (the press reaches this function twice:
    // the control binding and the canvas binding). Expando markers on the
    // event object are therefore useless - the second clone never sees them.
    // The bus also never stopPropagation()s designer events on purpose: tabs,
    // comboboxes, grids and checkboxes are live Ext widgets whose handling is
    // delegated up to the document, so swallowing the event would kill their
    // native click semantics. Only gestures are suppressed, never activation.
    if (!XfdClaimEvent(e, _xfdMdownGuard))
        return;

    _xfdSuppressClick = false;

    var control = explicitControl || XfdResolveControlFromEvent(e);

    if (e.ctrlKey)                                           // Ctrl+drag: resize
    {
        if (control && control !== _Form1)
        {
            if (e.preventDefault) e.preventDefault();
            XfdBeginResize(e);
            return;
        }

        // Ctrl+press on the empty canvas: start an ADDITIVE band (Ctrl+click
        // already toggles membership on a control, so the press must not
        // swallow the gesture)
        XfdBeginMarquee(e);
        return;
    }

    if (e.shiftKey)                                          // Shift+drag: band anywhere
    {
        if (e.preventDefault) e.preventDefault();
        XfdBeginMarquee(e);
        return;
    }

    var grabbed = XfdGrabbedForMove(control);

    if (grabbed)                                  // cursor over a control: drag moves it
    {
        XfdBeginMove(e, grabbed);
        return;
    }

    if (XfdIsEmptyCanvas(control))                // empty canvas: drag draws the band
    {
        XfdBeginMarquee(e);
        return;
    }

    // a control that cannot move and has no selected movable ancestor (a grid
    // column, a bar group...): no gesture at all - the band must not start
    // here; its plain click still selects it via __control_OnClick
}

// ---------------------------------------------------------------------------
// outline tree drag/drop sync (XFD-REPARENT) - replaces the old teleport
// ---------------------------------------------------------------------------

var _xfdTreeDragOrigin = null;

function XfdOnTreeDragStart(node)
{
    _xfdTreeDragOrigin = null;
    if (!node || !node.parentNode)
        return;
    _xfdTreeDragOrigin = { parent: node.parentNode, index: node.parentNode.indexOf(node), control: node.data && node.data.control };
}

function XfdApplyTreeDrop(node)
{
    if (!node || !node.data || !node.data.control)
        return;

    var ctrl = node.data.control;
    var hostNode = node.parentNode;
    var hostCtrl = hostNode && hostNode.data ? hostNode.data.control : null;

    var revert = function ()
    {
        if (_xfdTreeDragOrigin && _xfdTreeDragOrigin.parent && _xfdTreeDragOrigin.control === ctrl)
        {
            var target = _xfdTreeDragOrigin.parent;
            var idx = Math.min(_xfdTreeDragOrigin.index, target.childNodes.length);
            target.insertChild(idx, node);
        }
    };

    if (XfdIsMovable(ctrl))
    {
        // movable controls only live in valid absolute containers
        if (!hostCtrl || !XfdCanContain(hostCtrl, ctrl))
        {
            revert();
        }
        else if (ctrl.Parent !== hostCtrl)
        {
            XfdReparentComponent(ctrl, hostCtrl);            // keeps page position
            _xfdTreeDragOrigin = null;
            SetZIndex();
            XfdRefreshSelectionVisuals();
            return;
        }
    }
    else if (!XfdIsStructuralPlacementOk(ctrl, hostCtrl, hostNode))
    {
        revert();
    }

    _xfdTreeDragOrigin = null;
    SetZIndex();
    XfdRefreshSelectionVisuals();
}

// node placements that are legitimate for structural children
function XfdIsStructuralPlacementOk(ctrl, hostCtrl, hostNode){
    if (!ctrl || !ctrl.xType)
        return true;                                         // unknown: don't fight Ext
    if (!XFD_STRUCTURAL_TYPES[ctrl.xType])
        return true;                                         // plain control in odd host: revert elsewhere
    if (!hostCtrl)
        return false;

    switch (ctrl.xType)
    {
        case "TabPage":
            return hostCtrl.xType === "TabControl";
        case "SplitterPanel":
            return hostCtrl.xType === "SplitContainerH" || hostCtrl.xType === "SplitContainerV";
        case "ButtonBarGroup":
            return hostCtrl.xType === "ButtonBar";
        case "LinkBarGroup":
            return hostCtrl.xType === "LinkBar";
        case "DataGridTable":
        case "DataGridColumn":
            return hostCtrl.xType === "DataGrid";
    }
    return false;
}

// ---------------------------------------------------------------------------
// delete the whole selection (XFD-MULTISELECT) - __control_OnDelete removes
// children recursively, so only top-level members are iterated
// ---------------------------------------------------------------------------

async function XfdDeleteSelectedControls()
{
    var targets = XfdTopLevelSelection().filter(function (c) { return c !== _Form1; });
    if (!targets.length && selectedControl && selectedControl !== _Form1)
        targets = [selectedControl];

    for (var i = 0; i < targets.length; ++i)
        await __control_OnDelete(targets[i]);

    XfdClearSelection();
    XfdRefreshSelectionVisuals();
}
