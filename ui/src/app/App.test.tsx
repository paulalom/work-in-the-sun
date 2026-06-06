import { describe, expect, it } from "vitest";
import { feedKeyFromAgentEvent, feedKeyFromTarget, GLOBAL_FEED_KEY } from "./App";

describe("feedKeyFromTarget", () => {
  it("keeps new targets in the uncategorized feed until Codex returns a thread id", () => {
    expect(
      feedKeyFromTarget({
        provider: "codex",
        label: "Work in the Sun / New chat",
        workspace: "F:\\projects\\work-in-the-sun",
        sessionHint: "work in the sun",
        mode: "new",
        route: "work in the sun",
      }),
    ).toBe(GLOBAL_FEED_KEY);
  });

  it("uses concrete thread ids even when the target came from a new chat", () => {
    expect(
      feedKeyFromTarget({
        provider: "codex",
        sessionHint: "123e4567-e89b-12d3-a456-426614174000",
        mode: "new",
      }),
    ).toBe("codex:thread:123e4567-e89b-12d3-a456-426614174000");
  });

  it("keeps unresolved Codex current targets in the uncategorized feed", () => {
    expect(
      feedKeyFromTarget({
        provider: "codex",
        label: "Codex / current chat",
        sessionHint: "current",
        route: "current",
        mode: "existing",
      }),
    ).toBe(GLOBAL_FEED_KEY);
  });
});

describe("feedKeyFromAgentEvent", () => {
  it("uses the original command feed when feedback only has a command id", () => {
    expect(feedKeyFromAgentEvent({ commandId: "cmd-1" }, { "cmd-1": "codex:thread:abc" })).toBe(
      "codex:thread:abc",
    );
  });

  it("promotes feedback to a concrete thread id when Codex provides one", () => {
    expect(
      feedKeyFromAgentEvent(
        {
          commandId: "cmd-1",
          target: {
            provider: "codex",
            sessionHint: "123e4567-e89b-12d3-a456-426614174000",
            mode: "existing",
          },
        },
        { "cmd-1": GLOBAL_FEED_KEY },
      ),
    ).toBe("codex:thread:123e4567-e89b-12d3-a456-426614174000");
  });
});
