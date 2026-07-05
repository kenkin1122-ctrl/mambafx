/**
 * ui/floatingPanel.js
 *
 * Generic floating/movable/resizable/collapsible panel behavior, attached
 * to an existing DOM element — not a new panel of its own. Used first for
 * the decomposition banner, reusable for any future panel that wants the
 * same behavior.
 *
 * What's implemented: drag by a title bar, resize via a corner handle,
 * collapse/expand, and position+size persistence in localStorage keyed by
 * a caller-supplied id (so different panels remember their own state
 * independently). Bounds-clamped so the panel can never be dragged
 * entirely off-screen and become unreachable.
 *
 * What's explicitly NOT implemented yet, stated plainly rather than
 * silently absent: snap-to-dock (left/right/top/bottom). The panel is
 * freely positioned, and its saved-state shape includes a `dock` field
 * left as `null` for now specifically so a future pass can add dock-zone
 * detection and snapping without changing the persisted-state format —
 * but the actual drag-to-edge detection and dock-preview UI isn't built.
 * Building a full VSCode-style dock system was judged separate, larger
 * work from "make this panel floating," not a natural sub-step of it.
 */

const STORAGE_PREFIX = 'mtf_floating_panel_';

function loadState(id) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveState(id, state) {
  try { localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(state)); } catch { /* non-fatal */ }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * @param {HTMLElement} el the panel's root element — must be position:absolute or fixed in its own stacking context
 * @param {{id:string, titleBarSelector:string, collapseBtnSelector?:string, minWidth?:number, minHeight?:number, defaultPos?:{x:number,y:number}, defaultSize?:{w:number,h:number}}} opts
 */
export function makeFloatingPanel(el, opts) {
  const { id, titleBarSelector } = opts;
  const minWidth = opts.minWidth ?? 180;
  const minHeight = opts.minHeight ?? 60;
  const titleBar = el.querySelector(titleBarSelector);
  const collapseBtn = opts.collapseBtnSelector ? el.querySelector(opts.collapseBtnSelector) : null;

  const saved = loadState(id);
  const state = {
    x: saved?.x ?? opts.defaultPos?.x ?? 16,
    y: saved?.y ?? opts.defaultPos?.y ?? 16,
    w: saved?.w ?? opts.defaultSize?.w ?? 320,
    h: saved?.h ?? opts.defaultSize?.h ?? 80,
    collapsed: saved?.collapsed ?? false,
    dock: saved?.dock ?? null,
  };

  function bounds() {
    const parent = el.offsetParent || document.body;
    const pw = parent.clientWidth || window.innerWidth;
    const ph = parent.clientHeight || window.innerHeight;
    return { maxX: Math.max(0, pw - 40), maxY: Math.max(0, ph - 32) };
  }

  function apply() {
    el.style.left = state.x + 'px';
    el.style.top = state.y + 'px';
    el.style.width = state.w + 'px';
    el.style.height = state.collapsed ? 'auto' : state.h + 'px';
    el.classList.toggle('floating-panel-collapsed', state.collapsed);
    if (collapseBtn) collapseBtn.textContent = state.collapsed ? '▸' : '▾';
  }

  function persist() { saveState(id, state); }

  function startDrag(e) {
    if (e.target.closest('[data-no-drag]')) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY, origX = state.x, origY = state.y;
    const { maxX, maxY } = bounds();
    function onMove(ev) {
      state.x = clamp(origX + (ev.clientX - startX), 0, maxX);
      state.y = clamp(origY + (ev.clientY - startY), 0, maxY);
      apply();
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      persist();
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY, origW = state.w, origH = state.h;
    function onMove(ev) {
      state.w = Math.max(minWidth, origW + (ev.clientX - startX));
      state.h = Math.max(minHeight, origH + (ev.clientY - startY));
      apply();
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      persist();
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  if (titleBar) titleBar.addEventListener('mousedown', startDrag);

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'floating-panel-resize-handle';
  resizeHandle.addEventListener('mousedown', startResize);
  el.appendChild(resizeHandle);

  if (collapseBtn) collapseBtn.addEventListener('click', e => {
    e.stopPropagation();
    state.collapsed = !state.collapsed;
    apply();
    persist();
  });

  apply();

  return {
    getState: () => ({ ...state }),
    resetPosition: () => {
      state.x = opts.defaultPos?.x ?? 16;
      state.y = opts.defaultPos?.y ?? 16;
      state.w = opts.defaultSize?.w ?? 320;
      state.h = opts.defaultSize?.h ?? 80;
      apply();
      persist();
    },
  };
}
