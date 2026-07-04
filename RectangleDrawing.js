/**
 * drawing/ids.js — shared id generator (previously inlined in model.js;
 * pulled out so objects/DrawingObject.js can use it without importing
 * model.js, which itself needs to import the factory that builds these
 * classes — that would be a cycle).
 */
let idSeq = 1;
export function newId() {
  return "d" + Date.now().toString(36) + (idSeq++);
}
