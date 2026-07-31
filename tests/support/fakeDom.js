/**
 * tests/support/fakeDom.js
 *
 * Purpose: a minimal, purpose-built DOM shim for unit-testing the Phase 11
 * UI layer (research/src/ui/) under plain Node, with no browser and no
 * jsdom dependency -- following the same spirit as fakeIndexedDB.js, which
 * already does this for IndexedDB-backed governance code in this codebase.
 *
 * Covers only what research/src/ui/*.js actually uses: createElement,
 * appendChild/removeChild, textContent, className, classList add/contains,
 * setAttribute/getAttribute, addEventListener/dispatch (click), style
 * (plain object), children/parentNode, and a minimal `head`/`querySelector`
 * on the fake Document for Phase11Styles.js's style-injection check.
 *
 * This is NOT a general-purpose DOM implementation -- it exists solely to
 * make the isolated UI's own logic (composition, updates, event wiring)
 * testable without pulling in a real browser engine.
 *
 * Public API: createFakeDocument.
 */

class FakeClassList {
  constructor(el) { this._el = el; }
  add(...names) {
    const set = new Set(this._el._className.split(' ').filter(Boolean));
    for (const n of names) set.add(n);
    this._el._className = [...set].join(' ');
  }
  contains(name) {
    return this._el._className.split(' ').filter(Boolean).includes(name);
  }
}

class FakeElement {
  constructor(doc, tagName) {
    this.ownerDocument = doc;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._className = '';
    this._attrs = new Map();
    this._text = '';
    this._listeners = new Map();
    this.style = {};
  }
  get className() { return this._className; }
  set className(v) { this._className = v ?? ''; }
  get classList() { return new FakeClassList(this); }
  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => c.textContent || '').join('');
  }
  set textContent(v) {
    this._text = v == null ? '' : String(v);
    this.children = [];
  }
  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    this._text = ''; // appending children clears any prior plain-text content, like real DOM
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name, value) { this._attrs.set(name, String(value)); }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  hasAttribute(name) { return this._attrs.has(name); }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const arr = this._listeners.get(type) || [];
    const idx = arr.indexOf(handler);
    if (idx >= 0) arr.splice(idx, 1);
  }
  /** Test helper: simulates a user click. */
  click() {
    for (const handler of this._listeners.get('click') || []) handler({ target: this });
  }
  querySelector(selector) {
    // Only supports the `[data-attr]` and `tag[data-attr]` forms Phase11Styles.js needs.
    const match = /^(\w*)\[([\w-]+)\]$/.exec(selector.trim());
    if (!match) return null;
    const [, tag, attr] = match;
    const search = (node) => {
      for (const child of node.children) {
        if ((!tag || child.tagName.toLowerCase() === tag.toLowerCase()) && child.hasAttribute(attr)) return child;
        const found = search(child);
        if (found) return found;
      }
      return null;
    };
    return search(this);
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super(null, '#document');
    this.ownerDocument = this;
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.appendChild(this.head);
    this.appendChild(this.body);
  }
  createElement(tag) {
    return new FakeElement(this, tag);
  }
}

/** @returns {FakeDocument} A fresh fake document instance. */
export function createFakeDocument() {
  return new FakeDocument();
}
