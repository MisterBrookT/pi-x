/**
 * Control protocol handler for Claude CLI stream-json communication.
 *
 * Processes control_request messages from Claude CLI stdout and writes
 * control_response messages to stdin.
 *
 * - Custom MCP tools (mcp__custom-tools__*): DENIED — pi executes these
 * - Everything else (user MCP tools, internal tools): ALLOWED — Claude handles
 */

import type { ClaudeControlRequest } from "./types";
import { CUSTOM_TOOLS_MCP_PREFIX } from "./tool-mapping.js";

export const TOOL_EXECUTION_DENIED_MESSAGE =
  "Tool execution is unavailable in this environment.";

/** Prefix for MCP (Model Context Protocol) tool names. */
export const MCP_PREFIX = "mcp__";

interface ControlResponse {
  type: "control_response";
  request_id: string;
  response: {
    subtype: "success";
    response: {
      behavior: "allow" | "deny";
      message?: string;
    };
  };
}

/**
 * Handle a control_request from the Claude CLI.
 *
 * Denies custom MCP tools (mcp__custom-tools__*) so pi can execute them.
 * Allows everything else (user MCP tools, internal Claude tools).
 *
 * @returns true if the tool was allowed, false if denied
 */
export function handleControlRequest(
  msg: ClaudeControlRequest,
  stdin: NodeJS.WritableStream,
): boolean {
  if (!msg.request_id || !msg.request) {
    console.error(
      "[pi-claude-cli] Malformed control_request: missing request_id or request object",
      msg,
    );
    return false;
  }

  const toolName = msg.request?.tool_name ?? "";
  const isCustomTool = toolName.startsWith(CUSTOM_TOOLS_MCP_PREFIX);

  const response: ControlResponse = {
    type: "control_response",
    request_id: msg.request_id,
    response: {
      subtype: "success",
      response: isCustomTool
        ? { behavior: "deny", message: TOOL_EXECUTION_DENIED_MESSAGE }
        : { behavior: "allow" },
    },
  };

  stdin.write(JSON.stringify(response) + "\n");
  return !isCustomTool;
}
