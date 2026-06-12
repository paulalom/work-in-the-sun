import { describe, expect, it } from "vitest";
import {
  compareThreadItems,
  draftWithAppendedText,
  draftWithDictationText,
  feedKeyFromAgentEvent,
  feedKeyFromTarget,
  GLOBAL_FEED_KEY,
} from "./App";

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

describe("compareThreadItems", () => {
  it("keeps uncategorized left of more active chats", () => {
    const items = [
      { kind: "chat" as const, order: 0, sortAt: 300 },
      { kind: "uncategorized" as const, order: Number.MAX_SAFE_INTEGER, sortAt: 0 },
      { kind: "chat" as const, order: 1, sortAt: 500 },
    ].sort(compareThreadItems);

    expect(items.map((item) => item.kind)).toEqual(["uncategorized", "chat", "chat"]);
  });

  it("keeps regular chats sorted by activity and then order", () => {
    const items = [
      { kind: "chat" as const, order: 2, sortAt: 300 },
      { kind: "chat" as const, order: 1, sortAt: 500 },
      { kind: "chat" as const, order: 0, sortAt: 500 },
    ].sort(compareThreadItems);

    expect(items.map((item) => item.order)).toEqual([0, 1, 2]);
  });
});

describe("draftWithAppendedText", () => {
  it("uses dictated text as the draft when the draft is empty", () => {
    expect(draftWithAppendedText("", "First message")).toBe("First message");
  });

  it("appends dictated text to an existing draft", () => {
    expect(draftWithAppendedText("First message", "Second message")).toBe("First message Second message");
  });

  it("trims the join without disturbing leading draft whitespace", () => {
    expect(draftWithAppendedText("  First message  ", "  Second message  ")).toBe("  First message Second message");
  });
});

describe("draftWithDictationText", () => {
  it("appends dictated text when append mode is enabled", () => {
    expect(draftWithDictationText("First message", "Second message", true)).toBe("First message Second message");
  });

  it("replaces the draft when append mode is disabled", () => {
    expect(draftWithDictationText("First message", "Second message", false)).toBe("Second message");
  });
});
