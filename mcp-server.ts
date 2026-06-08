import type { JsonRecord } from "./lib/types";

const agentStore = require("./lib/agent-store");

const PROTOCOL_VERSION = "2025-03-26";
const MAX_MCP_MESSAGE_BYTES = finitePositiveNumber(process.env.WITS_MCP_MESSAGE_BYTES, 256 * 1024);

function finitePositiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const tools = [
  {
    name: "send_feedback",
    description:
      "Send a concise summarized progress, result, or status message back to the Work in the Sun remote UI.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Summarized feedback text to show in the remote UI; do not include raw prompt prefixes or chat history.",
        },
        level: {
          type: "string",
          enum: ["progress", "result", "system", "warning", "error"],
          description: "How the remote UI should present the feedback.",
        },
        commandId: {
          type: "string",
          description: "Optional command id this feedback is responding to.",
        },
        targetId: {
          type: "string",
          description: "Optional active target id this feedback is associated with.",
        },
        speak: {
          type: "boolean",
          description: "Whether the remote UI should read this feedback aloud when response audio is enabled.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "use_mcp_concise_replies",
    description:
      "Tell the agent to send summarized messages to the Work in the Sun UI with send_feedback while it works.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Whether concise UI reply mode should be enabled. Defaults to true.",
        },
        maxWords: {
          type: "number",
          description: "Target maximum words per progress reply. Defaults to 28; accepted range is 8-80.",
        },
        cadence: {
          type: "string",
          description: "When to send summarized UI messages, such as meaningful milestones, blockers, and final result.",
        },
        note: {
          type: "string",
          description: "Optional extra context for the agent's reply style.",
        },
        announce: {
          type: "boolean",
          description: "Whether to add a small system message to the remote UI. Defaults to false.",
        },
        commandId: {
          type: "string",
          description: "Optional command id this reply preference applies to.",
        },
        targetId: {
          type: "string",
          description: "Optional active target id this reply preference is associated with.",
        },
      },
    },
  },
  {
    name: "list_commands",
    description: "Read queued user commands from the Work in the Sun command inbox.",
    inputSchema: {
      type: "object",
      properties: {
        after: {
          type: "number",
          description: "Line cursor returned by a previous list_commands call.",
        },
        limit: {
          type: "number",
          description: "Maximum commands to return, up to 500.",
        },
      },
    },
  },
  {
    name: "get_active_target",
    description: "Return the currently selected desktop agent target.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "set_active_target",
    description: "Set the currently selected desktop agent target.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Agent provider or host, such as codex, claude, cursor, or a local router name.",
        },
        label: {
          type: "string",
          description: "Human-readable label to show in the app.",
        },
        workspace: {
          type: "string",
          description: "Workspace path or alias.",
        },
        sessionHint: {
          type: "string",
          description: "Chat/session/thread hint used by the consuming agent router.",
        },
        mode: {
          type: "string",
          enum: ["existing", "new"],
          description: "Whether to route to an existing session or ask the agent router to create a new one.",
        },
        route: {
          type: "string",
          description: "Free-form route phrase for agent-specific target resolution.",
        },
        id: {
          type: "string",
          description: "Optional stable target id.",
        },
      },
      required: ["provider"],
    },
  },
];

function writeMessage(message: any) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function success(id: any, result: any) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function failure(id: any, code: number, message: string, data?: any) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

function toolText(text: string, isError = false) {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    isError,
  };
}

function conciseReplyInstructions(preferences: JsonRecord) {
  if (!preferences.enabled) {
    return "MCP concise replies are disabled. Resume the agent's normal chat and feedback style.";
  }

  const note = preferences.note ? ` Extra note: ${preferences.note}` : "";
  return [
    `Send summarized messages to the Work in the Sun UI with send_feedback (target: ${preferences.maxWords} words per update).`,
    "Agent instructions:",
    "- Use send_feedback for compact summaries of meaningful milestones, blockers, and final result.",
    "- Do not send raw prompt prefixes, full chat history, or tool instructions to the remote UI.",
    "- Keep each UI message one compact line, outcome-first, with no routine narration.",
    `- Cadence: ${preferences.cadence}.${note}`,
  ].join("\n");
}

async function callTool(name: string, args: JsonRecord = {}) {
  switch (name) {
    case "send_feedback": {
      const target = args.targetId
        ? undefined
        : await agentStore.getActiveTarget().catch(() => undefined);
      const event = await agentStore.appendEvent({
        text: args.text,
        level: args.level,
        commandId: args.commandId,
        targetId: args.targetId,
        target,
        speak: args.speak,
        source: "mcp",
      });

      return toolText(`Feedback sent: ${event.id}`);
    }

    case "use_mcp_concise_replies": {
      const preferences = await agentStore.setReplyPreferences({
        enabled: args.enabled,
        maxWords: args.maxWords,
        cadence: args.cadence,
        note: args.note,
        source: "mcp",
      });

      if (args.announce === true) {
        await agentStore.appendEvent({
          text: preferences.enabled ? "Concise UI replies on." : "Concise UI replies off.",
          level: "system",
          commandId: args.commandId,
          targetId: args.targetId,
          speak: false,
          source: "mcp",
        });
      }

      return toolText(conciseReplyInstructions(preferences));
    }

    case "list_commands": {
      const result = await agentStore.readCommands({
        after: args.after,
        limit: args.limit,
      });

      return toolText(JSON.stringify({ cursor: result.cursor, total: result.total, commands: result.records }, null, 2));
    }

    case "get_active_target": {
      const target = await agentStore.getActiveTarget();
      return toolText(JSON.stringify(target, null, 2));
    }

    case "set_active_target": {
      const target = await agentStore.setActiveTarget(args);
      return toolText(JSON.stringify(target, null, 2));
    }

    default:
      return toolText(`Unknown tool: ${name}`, true);
  }
}

async function handleRequest(message: JsonRecord) {
  const id = message.id;

  try {
    switch (message.method) {
      case "initialize": {
        const requestedVersion = message.params?.protocolVersion || PROTOCOL_VERSION;
        return success(id, {
          protocolVersion: requestedVersion,
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: "work-in-the-sun",
            version: "0.1.0",
          },
          instructions:
            "Use use_mcp_concise_replies when asked. Use send_feedback to send concise summarized progress, result, or status messages back to the user's remote Work in the Sun UI.",
        });
      }

      case "ping":
        return success(id, {});

      case "tools/list":
        return success(id, { tools });

      case "tools/call": {
        const result = await callTool(message.params?.name, message.params?.arguments || {});
        return success(id, result);
      }

      default:
        return failure(id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    return failure(id, -32603, error.message || "Internal error.");
  }
}

async function handleMessage(message: any) {
  if (!message || typeof message !== "object") {
    return failure(null, -32600, "Invalid request.");
  }

  if (message.id === undefined) {
    return null;
  }

  return handleRequest(message);
}

async function handleLine(line: string) {
  let message;

  try {
    message = JSON.parse(line);
  } catch {
    writeMessage(failure(null, -32700, "Parse error."));
    return;
  }

  if (Array.isArray(message)) {
    const responses = (await Promise.all(message.map(handleMessage))).filter(Boolean);

    if (responses.length) {
      writeMessage(responses);
    }

    return;
  }

  const response = await handleMessage(message);

  if (response) {
    writeMessage(response);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;

  if (Buffer.byteLength(buffer) > MAX_MCP_MESSAGE_BYTES) {
    buffer = "";
    writeMessage(failure(null, -32600, "Request is too large."));
    return;
  }

  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";

  lines
    .filter((line) => line.trim())
    .forEach((line) => {
      handleLine(line).catch((error) => {
        writeMessage(failure(null, -32603, error.message || "Internal error."));
      });
    });
});

process.stdin.on("end", () => {
  if (buffer.trim()) {
    handleLine(buffer).catch((error) => {
      writeMessage(failure(null, -32603, error.message || "Internal error."));
    });
  }
});
