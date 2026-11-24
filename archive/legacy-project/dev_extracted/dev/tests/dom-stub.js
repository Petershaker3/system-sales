// dom-stub.js — بيئة محاكاة خفيفة لتشغيل منطق التطبيق في Node بدون متصفح حقيقي
// (لا يوجد اتصال إنترنت متاح لتثبيت jsdom أو تشغيل متصفح Playwright حقيقي)

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
    _dump: () => Object.fromEntries(map),
    _clear: () => map.clear(),
  };
}

function makeElement(id) {
  const el = {
    id: id || '',
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    children: [],
    _classes: new Set(),
    classList: {
      add: (...c) => c.forEach(x => el._classes.add(x)),
      remove: (...c) => c.forEach(x => el._classes.delete(x)),
      toggle: (c) => el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c),
      contains: (c) => el._classes.has(c),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: (child) => { el.children.push(child); return child; },
    remove: () => {},
    focus: () => {},
    click: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => null,
    setAttribute: () => {},
    scrollTo: () => {},
    scrollBy: () => {},
    closest: () => null,
  };
  return el;
}

function makeDocument() {
  const elements = new Map();
  const doc = {
    _elements: elements,
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    createElement: () => makeElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    body: makeElement('body'),
    documentElement: { scrollTop: 0 },
  };
  return doc;
}

function buildSandbox() {
  const localStorage = makeStorage();
  const document = makeDocument();
  const sandbox = {
    localStorage,
    document,
    console,
    setTimeout: (fn, ms) => 0, // fake: don't actually schedule (avoids hanging the test process)
    setInterval: (fn, ms) => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    Date, JSON, Math, parseFloat, parseInt, isNaN, String, Number, Array, Object, Boolean,
    Map, Set, Promise, RegExp, Error,
    navigator: { share: undefined, clipboard: { writeText: async () => {} } },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    alert: () => {}, confirm: () => true, prompt: () => '',
    location: { href: '', reload: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    scrollTo: () => {},
    innerWidth: 400, innerHeight: 800,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} }),
    window: null, // patched below to self-reference
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

module.exports = { buildSandbox, makeStorage };
