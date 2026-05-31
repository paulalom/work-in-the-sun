const agentStore = require("./lib/agent-store");

const PROTOCOL_VERSION = "2025-03-26";
const MAX_MCP_MESSAGE_BYTES = finitePositiveNumber(process.env.WITS_MCP_MESSAGE_BYTES, 256 * 1024);

function finitePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const tools = [
  {
    name: "send_feedback",
    description: "Send progress, result, or status text back to the Work in the Sun remote UI.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Feedback text to show in the remote UI.",
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

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function success(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function failure(id, code, message, data) {
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

function toolText(text, isError = false) {
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

async function callTool(name, args = {}) {
  switch (name) {
    case "send_feedback": {
      const event = await agentStore.appendEvent({
        text: args.text,
        level: args.level,
        commandId: args.commandId,
        targetId: args.targetId,
        speak: args.speak,
        source: "mcp",
      });

      return toolText(`Feedback sent: ${event.id}`);
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

async function handleRequest(message) {
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
            "Use send_feedback to report progress back to the user's remote Work in the Sun UI.",
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

async function handleMessage(message) {
  if (!message || typeof message !== "object") {
    return failure(null, -32600, "Invalid request.");
  }

  if (message.id === undefined) {
    return null;
  }

  return handleRequest(message);
}

async function handleLine(line) {
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
