import type { JsonRecord } from "./types";

const { spawn } = require("child_process");
const path = require("path");
const codexBridge = require("./codex-bridge");
const { PROJECT_ROOT } = require("./project-root");
type PowerShellResult = { stdout: string; stderr: string };

const ACTIVE_WINDOW_SCRIPT = path.join(PROJECT_ROOT, "scripts", "window-screenshot.ps1");
const SCREENSHOT_TIMEOUT_MS = finitePositiveNumber(process.env.WITS_SCREENSHOT_TIMEOUT_MS, 45_000);
const SCREENSHOT_OUTPUT_BYTES = finitePositiveNumber(
  process.env.WITS_SCREENSHOT_OUTPUT_BYTES,
  32 * 1024 * 1024,
);

function finitePositiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isCodexTarget(target: JsonRecord = {}) {
  return String(target.provider || "").toLowerCase() === "codex";
}

function runPowerShell(args: string[], options: JsonRecord = {}): Promise<PowerShellResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs || SCREENSHOT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes || SCREENSHOT_OUTPUT_BYTES;
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    const child = spawn(process.env.POWERSHELL_PATH || "powershell", args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    function settle(callback: (value: any) => void, value: any) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      callback(value);
    }

    function appendOutput(current: string, chunk: Buffer) {
      if (Buffer.byteLength(current) + chunk.length > maxOutputBytes) {
        outputTooLarge = true;
        child.kill();
        return current;
      }

      return current + chunk;
    }

    child.stdout?.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", (error) => settle(reject, error));
    child.on("close", (code) => {
      if (timedOut) {
        settle(reject, new Error("Screenshot capture timed out."));
        return;
      }

      if (outputTooLarge) {
        settle(reject, new Error("Screenshot capture produced too much output."));
        return;
      }

      if (code === 0) {
        settle(resolve, { stdout, stderr });
        return;
      }

      settle(reject, new Error(stderr.trim() || stdout.trim() || `PowerShell exited with code ${code}`));
    });
  });
}

function parseScreenshotResult(output: string) {
  let parsed;

  try {
    parsed = JSON.parse(String(output || "").trim());
  } catch {
    throw new Error("Screenshot capture did not return valid JSON.");
  }

  if (!parsed.ok) {
    throw new Error(parsed.error || "Screenshot capture failed.");
  }

  if (!parsed.imageBase64) {
    throw new Error("Screenshot capture did not return image data.");
  }

  return parsed;
}

async function captureActiveWindow() {
  if (process.platform !== "win32") {
    throw new Error("Active-window screenshots are available on Windows only.");
  }

  const result = await runPowerShell(
    [
      "-STA",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      ACTIVE_WINDOW_SCRIPT,
    ],
    { cwd: PROJECT_ROOT },
  );

  return parseScreenshotResult(result.stdout);
}

async function captureForTarget(target: JsonRecord = {}) {
  if (isCodexTarget(target) && codexBridge.screenshotRoute(target).accepted) {
    return codexBridge.captureTargetScreenshot(target);
  }

  return captureActiveWindow();
}

module.exports = {
  captureActiveWindow,
  captureForTarget,
};
