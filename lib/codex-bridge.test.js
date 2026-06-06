const assert = require("node:assert/strict");
const test = require("node:test");

const BRIDGE_PATH = require.resolve("./codex-bridge");
const ENV_KEYS = ["CODEX_DELIVERY_MODE", "CODEX_DIRECT_SEND", "WITS_MAX_LABEL_CHARS"];

function withBridgeEnv(env, callback) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }

  delete require.cache[BRIDGE_PATH];
  const bridge = require("./codex-bridge");

  try {
    callback(bridge);
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }

    delete require.cache[BRIDGE_PATH];
  }
}

test("routes new Codex workspace targets through app-server even when Windows UI is the default", () => {
  withBridgeEnv({ CODEX_DELIVERY_MODE: "windows-ui", CODEX_DIRECT_SEND: "1" }, (bridge) => {
    assert.deepEqual(
      bridge.dispatchRoute({
        target: {
          provider: "codex",
          mode: "new",
          workspace: "F:\\projects\\work-in-the-sun",
        },
      }),
      { accepted: true, mode: "new" },
    );
  });
});

test("keeps the visible UI fallback for unresolved new Codex targets", () => {
  withBridgeEnv({ CODEX_DELIVERY_MODE: "windows-ui", CODEX_DIRECT_SEND: "1" }, (bridge) => {
    const route = bridge.dispatchRoute({
      target: {
        provider: "codex",
        mode: "new",
      },
    });

    if (process.platform === "win32") {
      assert.deepEqual(route, { accepted: true, mode: "windows-ui", newChat: true });
    } else {
      assert.deepEqual(route, { accepted: false, reason: "windows-ui-unavailable" });
    }
  });
});

test("honors explicit Windows UI delivery for new Codex workspace targets", () => {
  withBridgeEnv({ CODEX_DELIVERY_MODE: "app-server-stdio", CODEX_DIRECT_SEND: "1" }, (bridge) => {
    const route = bridge.dispatchRoute({
      target: {
        provider: "codex",
        mode: "new",
        deliveryMode: "windows-ui",
        workspace: "F:\\projects\\work-in-the-sun",
      },
    });

    if (process.platform === "win32") {
      assert.deepEqual(route, { accepted: true, mode: "windows-ui", newChat: true });
    } else {
      assert.deepEqual(route, { accepted: false, reason: "windows-ui-unavailable" });
    }
  });
});

test("compacts verbose initial Codex UI chat titles before storing the target", () => {
  withBridgeEnv(
    { CODEX_DELIVERY_MODE: "windows-ui", CODEX_DIRECT_SEND: "1", WITS_MAX_LABEL_CHARS: "160" },
    (bridge) => {
      const longTitle = Array.from({ length: 32 }, (_, index) => `detailed instruction ${index + 1}`).join(" ");
      const target = bridge._internals.targetForCurrentDesktopChat(
        {
          target: {
            provider: "codex",
            workspace: process.cwd(),
            label: "Codex / New chat",
          },
        },
        { chatTitle: longTitle },
      );

      assert.equal(target.provider, "codex");
      assert.equal(target.mode, "existing");
      assert.equal(target.route, "current");
      assert.equal(target.sessionHint, "current");
      assert.equal(target.deliveryMode, "windows-ui");
      assert.match(target.label, /^Codex \/ /);
      assert.match(target.label, /\.\.\.$/);
      assert.ok(target.label.length <= 160);
    },
  );
});
