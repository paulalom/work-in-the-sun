import type { AgentTarget, ListContext } from "../../shared/types";

export const commandHelp = [
  "send",
  "clear draft",
  "delete last word",
  "echo on / echo off",
  "auto send on / auto send off",
  "responses on / responses off",
  "commands on / commands off",
  "list",
  "list projects / list chats",
  "list work in the sun",
  "list chats in work in the sun",
  "continue",
  "use one / use listed one",
  "screenshot",
  "use codex work in the sun agent chat",
  "use codex work in the sun new",
  "use new work in the sun",
  "use work in the sun new",
  "stop audio",
  "read draft",
  "append ...",
  "prepend ...",
  "replace with ...",
  "combine commands with comma, then, or and",
];

export type VoiceCommandAction =
  | { type: "send" }
  | { type: "screenshot" }
  | { type: "clear" }
  | { type: "deleteLastWord" }
  | { type: "echoOn" }
  | { type: "echoOff" }
  | { type: "autoSendOn" }
  | { type: "autoSendOff" }
  | { type: "responsesOn" }
  | { type: "responsesOff" }
  | { type: "commandModeOn" }
  | { type: "commandModeOff" }
  | { type: "stopAudio" }
  | { type: "readDraft" }
  | { type: "help" }
  | { type: "listPrompt" }
  | { type: "listProjects" }
  | { type: "listChats"; project?: string }
  | { type: "continueList" }
  | { type: "setAgentTarget"; target: AgentTarget }
  | { type: "useListedChat"; number: number | null }
  | { type: "replace"; text: string }
  | { type: "append"; text: string }
  | { type: "prepend"; text: string };

export interface CommandParseContext {
  activeListContext?: ListContext;
}

export function parseSingleVoiceCommand(command: string, context: CommandParseContext = {}): VoiceCommandAction | null {
  const cleaned = extractCommandText(command);
  const normalized = normalizeCommand(cleaned);

  if (!normalized) {
    return null;
  }

  const listedChatNumber = parseUseListedCommand(cleaned);

  if (listedChatNumber !== null) {
    return { type: "useListedChat", number: listedChatNumber };
  }

  const agentTarget = parseAgentTargetCommand(cleaned);

  if (agentTarget) {
    return { type: "setAgentTarget", target: agentTarget };
  }

  if (matchesCommand(normalized, ["list", "show list", "what can i list"])) {
    return { type: "listPrompt" };
  }

  if (
    matchesCommand(normalized, ["list projects", "show projects"]) ||
    (context.activeListContext?.kind === "choices" && matchesCommand(normalized, ["projects", "project"]))
  ) {
    return { type: "listProjects" };
  }

  if (
    matchesCommand(normalized, ["list chats", "show chats", "list conversations", "show conversations"]) ||
    (context.activeListContext?.kind === "choices" && matchesCommand(normalized, ["chats", "chat", "conversations"]))
  ) {
    return { type: "listChats" };
  }

  if (matchesCommand(normalized, ["continue", "more", "next", "next page"])) {
    return { type: "continueList" };
  }

  const projectChatList = parseProjectChatListCommand(cleaned, context);

  if (projectChatList) {
    return { type: "listChats", project: projectChatList };
  }

  const commandGroups: Array<{ type: VoiceCommandAction["type"]; commands: string[] }> = [
    {
      type: "send",
      commands: ["send", "send it", "send message", "queue", "queue it", "submit"],
    },
    {
      type: "screenshot",
      commands: [
        "screenshot",
        "screen shot",
        "take screenshot",
        "take screen shot",
        "send screenshot",
        "send a screenshot",
        "send screen shot",
        "send a screen shot",
        "capture screenshot",
        "capture screen shot",
        "capture window",
        "show screen",
        "show active window",
      ],
    },
    {
      type: "clear",
      commands: ["clear", "clear draft", "discard", "discard draft", "scratch that", "delete draft"],
    },
    {
      type: "deleteLastWord",
      commands: ["delete last word", "remove last word"],
    },
    {
      type: "echoOn",
      commands: ["echo on", "turn echo on"],
    },
    {
      type: "echoOff",
      commands: ["echo off", "turn echo off"],
    },
    {
      type: "autoSendOn",
      commands: ["auto send on", "turn auto send on", "autosend on"],
    },
    {
      type: "autoSendOff",
      commands: ["auto send off", "turn auto send off", "autosend off"],
    },
    {
      type: "responsesOn",
      commands: [
        "responses on",
        "response audio on",
        "read responses on",
        "turn responses on",
        "turn response audio on",
      ],
    },
    {
      type: "responsesOff",
      commands: [
        "responses off",
        "response audio off",
        "read responses off",
        "turn responses off",
        "turn response audio off",
      ],
    },
    {
      type: "commandModeOn",
      commands: [
        "commands on",
        "command mode on",
        "text commands on",
        "chat commands on",
        "send commands on",
      ],
    },
    {
      type: "commandModeOff",
      commands: [
        "commands off",
        "command mode off",
        "text commands off",
        "chat commands off",
        "send commands off",
        "messages on",
        "message mode on",
      ],
    },
    {
      type: "stopAudio",
      commands: [
        "stop",
        "stop audio",
        "stop speaking",
        "stop reading",
        "stop readback",
        "stop read back",
        "stop talking",
        "silence",
        "quiet",
      ],
    },
    {
      type: "readDraft",
      commands: ["read draft", "read it back", "repeat draft"],
    },
    {
      type: "help",
      commands: ["help", "list commands", "show commands", "what can i say"],
    },
  ];

  for (const group of commandGroups) {
    if (matchesCommand(normalized, group.commands)) {
      return { type: group.type } as VoiceCommandAction;
    }
  }

  const replacement = commandRemainder(cleaned, [
    "replace draft with",
    "replace message with",
    "replace with",
    "change it to",
    "change to",
    "set draft to",
    "new message",
  ]);

  if (replacement !== null) {
    return { type: "replace", text: replacement };
  }

  const appendText = commandRemainder(cleaned, [
    "append to draft",
    "append to message",
    "add to draft",
    "add to message",
    "append",
    "add",
  ]);

  if (appendText !== null) {
    return { type: "append", text: appendText };
  }

  const prependText = commandRemainder(cleaned, ["prepend", "start with", "put before"]);

  if (prependText !== null) {
    return { type: "prepend", text: prependText };
  }

  return null;
}

export function splitCommandComposition(command: string, context: CommandParseContext = {}) {
  const hardParts = splitCommandParts(command, /\s*(?:[,;]|\band then\b|\bthen\b)\s*/i);

  if (hardParts.length > 1 && hardParts.every((part) => parseSingleVoiceCommand(part, context))) {
    return hardParts;
  }

  const andParts = splitCommandParts(command, /\s+\band\s+/i);

  if (andParts.length > 1 && andParts.every((part) => parseSingleVoiceCommand(part, context))) {
    return andParts;
  }

  return [command];
}

export function splitCommandParts(command: string, separator: RegExp) {
  return command
    .split(separator)
    .map((part) => extractCommandText(part))
    .filter(Boolean);
}

export function parseAgentTargetCommand(command: string): AgentTarget | null {
  const cleaned = extractCommandText(command);
  const words = cleaned.split(/\s+/).filter(Boolean);

  if (words.length < 2 || normalizeCommand(words[0]) !== "use") {
    return null;
  }

  const newProjectPrefix = commandRemainder(cleaned, ["use new"]);

  if (newProjectPrefix) {
    return newCodexProjectTarget(newProjectPrefix);
  }

  const firstRouteWord = normalizeCommand(words[1]);
  const usesExplicitProvider = ["agent", "claude", "codex", "cursor"].includes(firstRouteWord);
  const routeAfterUse = extractCommandValue(words.slice(1).join(" "));

  if (!usesExplicitProvider && normalizeCommand(routeAfterUse).endsWith(" new")) {
    const project = extractCommandValue(routeAfterUse.replace(/\bnew\b$/i, ""));

    if (project) {
      return newCodexProjectTarget(project);
    }
  }

  if (words.length < 3) {
    return null;
  }

  const provider = words[1].toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const route = extractCommandValue(words.slice(2).join(" "));

  if (!provider || !route) {
    return null;
  }

  const normalizedRoute = normalizeCommand(route);
  const mode = normalizedRoute.endsWith(" new") || normalizedRoute === "new" ? "new" : "existing";
  const sessionHint = mode === "new" ? extractCommandValue(route.replace(/\bnew\b$/i, "")) || "new" : route;

  return {
    provider,
    route,
    sessionHint,
    mode,
    workspaceQuery: mode === "new" && sessionHint !== "new" ? sessionHint : undefined,
    label: `${titleCase(provider)} / ${route}`,
  };
}

function newCodexProjectTarget(project: string): AgentTarget {
  return {
    provider: "codex",
    route: project,
    sessionHint: project,
    mode: "new",
    workspaceQuery: project,
    label: `Codex / ${project}`,
  };
}

export function parseSpokenNumber(text: string) {
  const normalized = normalizeCommand(text);
  const candidates = [
    normalized,
    normalized.replace(/^(?:number|chat|listed)\s+/, ""),
    normalized.split(" ").at(-1) || "",
  ].filter(Boolean);
  const words = new Map<string, number>([
    ["zero", 0],
    ["oh", 0],
    ["o", 0],
    ["one", 1],
    ["first", 1],
    ["won", 1],
    ["two", 2],
    ["second", 2],
    ["to", 2],
    ["too", 2],
    ["three", 3],
    ["third", 3],
    ["four", 4],
    ["fourth", 4],
    ["for", 4],
    ["fore", 4],
    ["five", 5],
    ["fifth", 5],
    ["six", 6],
    ["sixth", 6],
    ["seven", 7],
    ["seventh", 7],
    ["eight", 8],
    ["eighth", 8],
    ["ate", 8],
    ["aid", 8],
    ["nine", 9],
    ["ninth", 9],
    ["niner", 9],
    ["ten", 10],
    ["tenth", 10],
  ]);

  for (const candidate of candidates) {
    if (/^\d+$/.test(candidate)) {
      return Number(candidate);
    }

    if (words.has(candidate)) {
      return words.get(candidate) ?? null;
    }
  }

  return null;
}

export function parseUseListedCommand(command: string) {
  const value = commandRemainder(command, [
    "use listed chat",
    "use listed",
    "use list",
    "use number",
    "use",
    "select listed chat",
    "select listed",
    "select number",
  ]);

  if (value === null) {
    return null;
  }

  return parseSpokenNumber(value);
}

export function parseProjectChatListCommand(command: string, context: CommandParseContext = {}) {
  const project = commandRemainder(command, [
    "list chats in",
    "list chats for",
    "show chats in",
    "show chats for",
    "list conversations in",
    "list conversations for",
    "show conversations in",
    "show conversations for",
    "list in",
    "show in",
  ]);

  if (project !== null) {
    return project;
  }

  const listTarget = commandRemainder(command, ["list", "show"]);
  const normalizedTarget = normalizeCommand(listTarget || "");
  const reservedListTargets = ["projects", "project", "chats", "chat", "conversations"];

  if (
    listTarget !== null &&
    !reservedListTargets.some((target) => normalizedTarget === target || normalizedTarget.startsWith(`${target} `))
  ) {
    return listTarget;
  }

  const cleaned = extractCommandValue(command);

  if (context.activeListContext?.kind === "choices" && cleaned) {
    return cleaned;
  }

  return null;
}

export function titleCase(text: string) {
  return String(text || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function normalizeCommand(command: string) {
  return extractCommandValue(command).toLowerCase().replace(/\s+/g, " ");
}

export function extractCommandText(text: string) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2018\u2019\u201a\u201b`]/g, "'")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/^[\s.,!?;:]+|[\s.,!?;:]+$/g, "")
    .replace(/\s+/g, " ");
}

export function extractCommandValue(text: string) {
  return extractCommandText(text)
    .replace(/["']/g, "")
    .replace(/[.,!?;:()[\]{}]+/g, " ")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesCommand(normalizedCommand: string, commands: string[]) {
  return commands.some((command) => normalizedCommand === normalizeCommand(command));
}

export function commandRemainder(command: string, prefixes: string[]) {
  const cleaned = extractCommandText(command);
  const normalizedCommand = normalizeCommand(cleaned);

  for (const prefix of prefixes) {
    const normalizedPrefix = normalizeCommand(prefix);
    const prefixWords = normalizedPrefix.split(" ").filter(Boolean);

    if (!prefixWords.length) {
      continue;
    }

    if (normalizedCommand.startsWith(`${normalizedPrefix} `)) {
      const value = cleaned.split(/\s+/).slice(prefixWords.length).join(" ");
      const cleanedValue = extractCommandValue(value);

      if (cleanedValue) {
        return cleanedValue;
      }
    }
  }

  return null;
}
