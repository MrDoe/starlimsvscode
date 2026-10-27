/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
/*
Description.. :	Layout-Editor-style interaction for the FormDesigner canvas:
			- plain drag MOVES a control (XFD-SNAP: snaps edges/centers to
			  neighbouring controls, Alt held = no snapping)
			- marquee (bounding box) multi-select + group move (XFD-MULTISELECT)
			- dropping into Form/Panel/GroupBox/TabPage/SplitterPanel REPARENTS
			  the control, moves its outline node and recomputes the depth based
			  z-index through SetZIndex() (XFD-REPARENT); the outline tree
			  drag/drop runs through the same component-sync helper.
	Grep markers: XFD-INTERACTION, XFD-SNAP, XFD-MULTISELECT, XFD-REPARENT.
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
// (walks Ext.Component.from up the Parent chain until a htControls member)
function XfdResolveControlFromEvent(e)
{
    // synthetic events from AddControl/AddColumn/combo pass the control itself
    if (e.target && e.target.Guid && htControls.ContainsKey(e.target.Guid))
        return e.target;

    var dom = e.target;
    if (!dom || !dom.closest)
        return null;

    // never claim clicks on the tab strip headers
    if (dom.closest(".x-tab"))
        return null;

    var c = null;
    try { c = Ext.Component.from(dom); } catch (err) { c = null; }

    while (c)
    {
        if (XfdIsDesignerControl(c))
            return c;
        c = c.Parent || (c.getParent ? c.getParent() : null);
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
    var overlay = XfdOverlay();
    if (!overlay)
        return { left: 0, top: 0 };
    var r = overlay.dom.getBoundingClientRect();
    return { left: r.left, top: r.top };
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

        XfdAddOverlayBox("xfd-selbox", r.left - origin.left - 1, r.top - origin.top - 1,
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
        xs.push(r.left, r.left + r.width / 2, r.left + r.width);
        ys.push(r.top, r.top + r.height / 2, r.top + r.height);
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
        members = XfdMoveSet();
    else
    {
        XfdSetSelection([hitControl]);
        members = [hitControl];
    }
    if (!members.length)
    {
        console.log("XFD-DEBUG BeginMove empty members");   // XFD-DEBUG
        return;
    }

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

        if (!state.logged)                                   // XFD-DEBUG
        {
            state.logged = true;
            console.log("XFD-DEBUG first mousemove page:", ev.pageX, ev.pageY,
                "start:", state.x0, state.y0, "d:", dx, dy);
        }

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
                XfdReparentComponent(st.c, target, pageXY);
                await XfdMoveOutlineNode(st.c, target);     // savexml + z-index truth
                st.movedTree = true;
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

        var origin = XfdFormOrigin();
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
// ---------------------------------------------------------------------------

function XfdHandleMouseDown(e, explicitControl)
{
    if (form.Variables["PreventClickEvents"] === true)
        return;

    // left button only
    if (e.which !== undefined && e.which !== 1)
        return;

    _xfdSuppressClick = false;

    if (e.target && e.target.closest && e.target.closest(".x-tab"))
        return;                                              // tab strip: leave to Ext

    var control = explicitControl || XfdResolveControlFromEvent(e);

    console.log("XFD-DEBUG mousedown", e.type, "which:", e.which, "ctrl:", e.ctrlKey, "shift:", e.shiftKey,
        "prevent:", form.Variables["PreventClickEvents"], "hit:", control && control.Id, control && control.xType,
        "movable:", XfdIsMovable(control));   // XFD-DEBUG

    if (e.ctrlKey)                                           // Ctrl+drag: resize
    {
        if (control && control !== _Form1)
        {
            if (e.stopPropagation) e.stopPropagation();
            if (e.preventDefault) e.preventDefault();
            XfdBeginResize(e);
        }
        return;
    }

    if (e.shiftKey)                                          // Shift+drag: band anywhere
    {
        if (e.stopPropagation) e.stopPropagation();
        if (e.preventDefault) e.preventDefault();
        XfdBeginMarquee(e);
        return;
    }

    if (control && XfdIsMovable(control))                    // plain drag: move
    {
        console.log("XFD-DEBUG branch: move", control.Id);   // XFD-DEBUG
        if (e.stopPropagation) e.stopPropagation();
        XfdBeginMove(e, control);
        return;
    }

    // press on a NON-movable surface (TabPage/SplitterPanel body, columns,
    // bars...): if a movable ANCESTRAL control is currently selected, the
    // press belongs to it and moves the whole selection instead
    var carrier = null;
    for (var a = control; a; a = a.Parent)
    {
        if (XfdIsMovable(a) && XfdIsControlSelected(a))
        { carrier = a; break; }
    }
    if (carrier)
    {
        console.log("XFD-DEBUG branch: group-move via selected ancestor", carrier.Id); // XFD-DEBUG
        if (e.stopPropagation) e.stopPropagation();
        XfdBeginMove(e, carrier);
        return;
    }

    // empty canvas or a non-movable surface (TabPage/SplitterPanel body,
    // grid columns, button bars...): plain drag draws the band
    console.log("XFD-DEBUG branch: marquee", control && control.Id);   // XFD-DEBUG
    if (e.stopPropagation) e.stopPropagation();
    XfdBeginMarquee(e);
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
