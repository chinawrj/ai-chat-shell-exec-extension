#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    Object.assign(this, options);
  }
}

class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.isConnected = true;
    this.visible = true;
    this.id = "";
    this.innerText = "";
    this.textContent = "";
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  matches(selector) {
    if (selector.includes('[data-testid="send-button"]')) {
      return this.getAttribute("data-testid") === "send-button";
    }
    if (selector.includes('[data-testid="composer-send-button"]')) {
      return this.getAttribute("data-testid") === "composer-send-button";
    }
    return false;
  }

  closest(selector) {
    if (selector === "form") {
      return this.form || null;
    }
    if (selector.includes("textarea") && this instanceof FakeTextAreaElement) {
      return this;
    }
    if (selector.includes("input") && this instanceof FakeInputElement) {
      return this;
    }
    return null;
  }

  contains(node) {
    return node === this || this.children.includes(node);
  }

  querySelectorAll() {
    return [];
  }

  getBoundingClientRect() {
    return this.visible
      ? { width: 600, height: 48, left: 0, right: 600, top: 0, bottom: 48 }
      : { width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 };
  }

  focus() {}

  dispatchEvent() {
    return true;
  }
}

class FakeButtonElement extends FakeElement {
  constructor() {
    super();
    this.disabled = false;
  }
}

class FakeInputElement extends FakeElement {
  constructor() {
    super();
    this._value = "";
    this.disabled = false;
    this.readOnly = false;
    this.type = "text";
  }

  get value() {
    return this._value;
  }

  set value(value) {
    this._value = String(value);
  }
}

class FakeTextAreaElement extends FakeElement {
  constructor() {
    super();
    this._value = "";
    this.disabled = false;
    this.readOnly = false;
  }

  get value() {
    return this._value;
  }

  set value(value) {
    this._value = String(value);
  }
}

function loadContentContext() {
  const submittedMessages = [];
  const selectorResults = new Map();
  const localStore = {};
  const context = {
    CSS: { escape: (value) => String(value) },
    Element: FakeElement,
    Event: FakeEvent,
    HTMLElement: FakeElement,
    HTMLButtonElement: FakeButtonElement,
    HTMLInputElement: FakeInputElement,
    HTMLTextAreaElement: FakeTextAreaElement,
    InputEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    SubmitEvent: FakeEvent,
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    Node: {
      DOCUMENT_POSITION_FOLLOWING: 4,
      DOCUMENT_POSITION_PRECEDING: 2
    },
    chrome: {
      runtime: {
        id: "lkmeogidbglhedgekjgbpbfjkpapnhke",
        sendMessage: async () => ({ ok: true })
      },
      storage: {
        onChanged: { addListener() {} },
        sync: { get: async () => ({ enabled: false }) },
        local: {
          async get(keys) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (Object.prototype.hasOwnProperty.call(localStore, key)) {
                result[key] = localStore[key];
              }
            }
            return result;
          },
          async set(values) {
            Object.assign(localStore, values || {});
          },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete localStore[key];
            }
          }
        }
      }
    },
    clearTimeout,
    console,
    document: {
      activeElement: null,
      body: null,
      documentElement: new FakeElement(),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll(selector) {
        if (selector.includes("data-message-author-role") || selector.includes("data-author-role")) {
          return submittedMessages;
        }
        return selectorResults.get(selector) || [];
      },
      addEventListener() {},
      removeEventListener() {}
    },
    location: {
      href: "https://chatgpt.com/c/send-actuator",
      hostname: "chatgpt.com",
      origin: "https://chatgpt.com",
      pathname: "/c/send-actuator",
      port: "",
      protocol: "https:"
    },
    setTimeout,
    window: {
      confirm: () => true,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      addEventListener() {},
      removeEventListener() {}
    }
  };
  context.window.Element = context.Element;
  context.window.HTMLInputElement = context.HTMLInputElement;
  context.window.HTMLTextAreaElement = context.HTMLTextAreaElement;
  context.__submittedMessages = submittedMessages;
  context.__selectorResults = selectorResults;

  vm.createContext(context);
  const source = fs.readFileSync(
    path.join(__dirname, "..", "extension", "src", "content.js"),
    "utf8"
  );
  vm.runInContext(source, context, { filename: "content.js" });
  return context;
}

async function testTrackedTextareaUpdatesHostState() {
  const context = loadContentContext();
  const composer = new context.HTMLTextAreaElement();
  composer.id = "tracked-composer";
  let trackedValue = "";
  let hostEditorState = "";

  // Model React's per-instance value tracker. A normal `composer.value = x`
  // updates both DOM and tracker, so the later input event looks unchanged to
  // the host. Calling the prototype's native setter bypasses this tracker and
  // lets the input event carry the new value into host state.
  Object.defineProperty(composer, "value", {
    configurable: true,
    get() {
      return this._value;
    },
    set(value) {
      this._value = String(value);
      trackedValue = this._value;
    }
  });
  composer.dispatchEvent = (event) => {
    if (event.type === "input" && trackedValue !== composer._value) {
      hostEditorState = composer._value;
      trackedValue = composer._value;
    }
    return true;
  };
  context.findReplyInput = async () => composer;

  const intended = "Shell call result:\n\nstdout:\ntracked textarea";
  const returned = await context.insertReply(intended, { preserveExisting: true });

  assert.equal(returned, composer);
  assert.equal(composer.value, intended, "The exact plugin text must be visible in the textarea.");
  assert.equal(
    hostEditorState,
    intended,
    "Insertion must update host editor state, not only the textarea DOM value."
  );
}

async function testThirdButtonAttemptCanRecoverFromTwoNoOps() {
  const context = loadContentContext();
  const intended = "Shell call result:\n\nstdout:\nthird click succeeds";
  const composer = new context.Element();
  composer.innerText = intended;
  composer.textContent = intended;
  let clicks = 0;
  const button = new context.HTMLButtonElement();
  button.getAttribute = (name) => name === "aria-disabled" ? "false" : null;
  button.click = () => {
    clicks += 1;
    if (clicks === 3) {
      context.__submittedMessages.push({ innerText: intended, textContent: intended });
      composer.innerText = "";
      composer.textContent = "";
    }
  };
  context.findSendButton = () => button;
  context.trySubmitForm = () => false;
  context.tryKeyboardSubmit = () => false;
  context.sleep = async () => {};

  assert.equal(await context.clickSendWhenReady(composer, () => true, intended), true);
  assert.equal(clicks, 3, "Two transient no-op clicks must not permanently disable button fallback.");
}

async function testExplicitChineseDistantBindingIsUsable() {
  const context = loadContentContext();
  const intended = "Shell call result:\n\nstdout:\n显式绑定发送";
  const composer = new context.Element();
  composer.id = "chat-composer";
  composer.innerText = intended;
  composer.textContent = intended;
  composer.getBoundingClientRect = () => ({
    width: 500,
    height: 50,
    left: 0,
    right: 500,
    top: 0,
    bottom: 50
  });

  let clicks = 0;
  const button = new context.HTMLButtonElement();
  button.id = "manual-chinese-send";
  button.setAttribute("aria-label", "发送");
  button.getBoundingClientRect = () => ({
    width: 40,
    height: 40,
    left: 1800,
    right: 1840,
    top: 900,
    bottom: 940
  });
  button.click = () => {
    clicks += 1;
    context.__submittedMessages.push({ innerText: intended, textContent: intended });
    composer.innerText = "";
    composer.textContent = "";
  };
  context.__selectorResults.set("#manual-chinese-send", [button]);
  vm.runInContext('savedSendSelector = "#manual-chinese-send";', context);
  context.sleep = async () => {};

  assert.equal(
    context.findSendButton(composer, false),
    button,
    "An explicit per-origin binding must support localized labels and non-proximate layouts."
  );
  assert.equal(await context.clickSendWhenReady(composer, () => true, intended), true);
  assert.equal(clicks, 1);
}

async function testUserDraftChangeStopsEverySendSideEffect() {
  const context = loadContentContext();
  const intended = "Shell call result:\n\nstdout:\nowned output";
  const composer = new context.Element();
  composer.innerText = intended;
  composer.textContent = intended;
  let buttonClicks = 0;
  let formSubmits = 0;
  let focuses = 0;
  let keyboardEvents = 0;
  const form = {
    requestSubmit() {
      formSubmits += 1;
    }
  };
  composer.form = form;
  composer.focus = () => {
    focuses += 1;
  };
  composer.dispatchEvent = () => {
    keyboardEvents += 1;
    return true;
  };
  const button = new context.HTMLButtonElement();
  button.click = () => {
    buttonClicks += 1;
  };
  context.findSendButton = () => {
    composer.innerText = "用户正在输入的草稿";
    composer.textContent = composer.innerText;
    return button;
  };
  context.sleep = async () => {};

  assert.equal(await context.clickSendWhenReady(composer, () => true, intended), false);
  assert.deepEqual(
    { buttonClicks, formSubmits, focuses, keyboardEvents },
    { buttonClicks: 0, formSubmits: 0, focuses: 0, keyboardEvents: 0 },
    "Once exact ownership is lost, button, form, focus, and keyboard paths must all stop."
  );
}

async function main() {
  await testTrackedTextareaUpdatesHostState();
  await testThirdButtonAttemptCanRecoverFromTwoNoOps();
  await testExplicitChineseDistantBindingIsUsable();
  await testUserDraftChangeStopsEverySendSideEffect();
  console.log("content_send_actuator.test.js: all tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
