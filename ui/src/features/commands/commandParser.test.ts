import { describe, expect, it } from "vitest";
import {
  parseAgentTargetCommand,
  parseSingleVoiceCommand,
  parseSpokenNumber,
  splitCommandComposition,
} from "./commandParser";

describe("command parser", () => {
  it("parses generic agent target phrases", () => {
    expect(parseAgentTargetCommand("use codex work in the sun agent chat")).toMatchObject({
      provider: "codex",
      route: "work in the sun agent chat",
      sessionHint: "work in the sun agent chat",
      mode: "existing",
      label: "Codex / work in the sun agent chat",
    });
  });

  it("parses new target mode", () => {
    expect(parseAgentTargetCommand("use codex work in the sun new")).toMatchObject({
      provider: "codex",
      sessionHint: "work in the sun",
      mode: "new",
      workspaceQuery: "work in the sun",
    });
  });

  it("parses short new Codex project target phrases", () => {
    expect(parseAgentTargetCommand("use new work in the sun")).toMatchObject({
      provider: "codex",
      route: "work in the sun",
      sessionHint: "work in the sun",
      workspaceQuery: "work in the sun",
      mode: "new",
    });
    expect(parseAgentTargetCommand("use work in the sun new")).toMatchObject({
      provider: "codex",
      route: "work in the sun",
      sessionHint: "work in the sun",
      workspaceQuery: "work in the sun",
      mode: "new",
    });
    expect(parseAgentTargetCommand("use work-in-the-sun new")).toMatchObject({
      provider: "codex",
      route: "work in the sun",
      sessionHint: "work in the sun",
      workspaceQuery: "work in the sun",
      mode: "new",
    });
    expect(parseSingleVoiceCommand("use new work in the sun")).toMatchObject({
      type: "setAgentTarget",
      target: {
        provider: "codex",
        workspaceQuery: "work in the sun",
        mode: "new",
      },
    });
  });

  it("parses listed chat numbers from speech variants", () => {
    expect(parseSpokenNumber("one")).toBe(1);
    expect(parseSpokenNumber("listed two")).toBe(2);
    expect(parseSpokenNumber("chat aid")).toBe(8);
  });

  it("parses short listed item selection", () => {
    expect(parseSingleVoiceCommand("use one")).toEqual({ type: "useListedItem", number: 1 });
  });

  it("preserves project chat list phrases", () => {
    expect(parseSingleVoiceCommand("list work in the sun")).toEqual({
      type: "listChats",
      project: "work in the sun",
    });
  });

  it("parses thread rename commands", () => {
    expect(parseSingleVoiceCommand("rename to ui style")).toEqual({
      type: "renameThread",
      title: "ui style",
    });
  });

  it("uses choice context for project or chat answers", () => {
    expect(parseSingleVoiceCommand("projects", { activeListContext: { kind: "choices" } })).toEqual({
      type: "listProjects",
    });
    expect(parseSingleVoiceCommand("chats", { activeListContext: { kind: "choices" } })).toEqual({
      type: "listChats",
    });
  });

  it("splits composed commands only when all parts are commands", () => {
    expect(splitCommandComposition("echo off, commands on")).toEqual(["echo off", "commands on"]);
    expect(splitCommandComposition("append fish and chips")).toEqual(["append fish and chips"]);
  });

  it("parses stop as a global audio stop command", () => {
    expect(parseSingleVoiceCommand("stop")).toEqual({ type: "stopAudio" });
    expect(parseSingleVoiceCommand("stop audio")).toEqual({ type: "stopAudio" });
    expect(parseSingleVoiceCommand("stop speaking")).toEqual({ type: "stopAudio" });
  });
});
