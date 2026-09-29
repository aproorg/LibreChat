import { Constants } from './config';
import {
  Tools,
  actionDelimiter,
  actionDomainSeparator,
  isActionTool,
  type AgentToolOptions,
  type AllowedCaller,
} from './types/tools';
import type { TEphemeralAgent } from './types';
import type { Agent } from './types/agents';

const actionDomainSeparatorRegex = new RegExp(actionDomainSeparator, 'g');

/**
 * Collapses the encoded-domain suffix of an action tool name to the shape used
 * by runtime tool definitions. The operation id is deliberately preserved.
 */
export function normalizeActionToolName(toolName: string): string {
  if (!isActionTool(toolName)) {
    return toolName;
  }
  const delimiterIndex = toolName.lastIndexOf(actionDelimiter);
  const prefixEnd = delimiterIndex + actionDelimiter.length;
  const encodedDomain = toolName.slice(prefixEnd);
  return toolName.slice(0, prefixEnd) + encodedDomain.replace(actionDomainSeparatorRegex, '_');
}

/**
 * Removes Code Interpreter as an allowed caller without mutating the input.
 * Tool entries and unrelated options are preserved; an empty entry is removed.
 */
export function removeCodeExecutionCaller(
  toolOptions: AgentToolOptions | undefined,
): AgentToolOptions | undefined {
  if (toolOptions == null) {
    return toolOptions;
  }

  const normalized: AgentToolOptions = {};
  for (const [toolName, options] of Object.entries(toolOptions)) {
    const callers = options.allowed_callers;
    if (callers?.includes('code_execution') !== true) {
      normalized[toolName] = options;
      continue;
    }

    const allowedCallers = callers.filter(
      (caller): caller is AllowedCaller => caller !== 'code_execution',
    );
    const { allowed_callers: _removed, ...remainingOptions } = options;
    const nextOptions =
      allowedCallers.length > 0
        ? { ...remainingOptions, allowed_callers: allowedCallers }
        : remainingOptions;
    if (Object.keys(nextOptions).length > 0) {
      normalized[toolName] = nextOptions;
    }
  }

  return normalized;
}

export const switchableBuiltinTools = [
  Tools.web_search,
  Tools.execute_code,
  Tools.file_search,
] as const;

export type SwitchableBuiltinTool = (typeof switchableBuiltinTools)[number];

/** `tool_options` key for a whole MCP server (`sys__server__sys_mcp_<server>`). */
export function mcpServerToggleKey(serverName: string): string {
  return `${Constants.mcp_server}${Constants.mcp_delimiter}${serverName}`;
}

export interface AgentToolSwitches {
  /** Switchable built-ins attached to the agent; value = starts on. */
  builtins: Partial<Record<SwitchableBuiltinTool, boolean>>;
  /** Switchable attached MCP servers by name; value = starts on. */
  mcp: Record<string, boolean>;
}

type SwitchableAgent = Pick<Agent, 'tools' | 'tool_options'>;

function isServerTool(tool: string, serverName: string): boolean {
  const suffix = `${Constants.mcp_delimiter}${serverName}`;
  return tool.endsWith(suffix) || tool === `${Constants.mcp_prefix}${serverName}`;
}

function attachedServerNames(tools: string[]): string[] {
  const names = new Set<string>();
  for (const tool of tools) {
    const index = tool.lastIndexOf(Constants.mcp_delimiter);
    if (index >= 0) {
      names.add(tool.slice(index + Constants.mcp_delimiter.length));
    }
  }
  return Array.from(names);
}

/** The creator's switchable set and defaults. Locked or unattached tools never appear. */
export function getAgentToolSwitches(agent: SwitchableAgent): AgentToolSwitches {
  const tools = agent.tools ?? [];
  const options = agent.tool_options ?? {};
  const switches: AgentToolSwitches = { builtins: {}, mcp: {} };
  for (const tool of switchableBuiltinTools) {
    const toggle = options[tool]?.user_toggle;
    if (toggle != null && tools.includes(tool)) {
      switches.builtins[tool] = toggle === 'on';
    }
  }
  for (const serverName of attachedServerNames(tools)) {
    const toggle = options[mcpServerToggleKey(serverName)]?.user_toggle;
    if (toggle != null) {
      switches.mcp[serverName] = toggle === 'on';
    }
  }
  return switches;
}

/** The agent's tools after applying the chat's untrusted switch state. Only ever removes. */
export function applyAgentToolSwitches(
  agent: SwitchableAgent,
  requested: TEphemeralAgent | null | undefined,
): { tools: string[]; mcp: string[] } {
  const tools = agent.tools ?? [];
  const { builtins, mcp } = getAgentToolSwitches(agent);
  const dropped = new Set<string>();
  for (const tool of switchableBuiltinTools) {
    const requestedValue = requested?.[tool];
    const defaultValue = builtins[tool];
    const isOn = typeof requestedValue === 'boolean' ? requestedValue : defaultValue;
    if (defaultValue != null && !isOn) {
      dropped.add(tool);
    }
  }
  const requestedServers = Array.isArray(requested?.mcp) ? requested.mcp : undefined;
  const offServers = Object.entries(mcp)
    .filter(
      ([name, isDefaultOn]) => !(requestedServers ? requestedServers.includes(name) : isDefaultOn),
    )
    .map(([name]) => name);
  const kept = tools.filter(
    (tool) => !dropped.has(tool) && !offServers.some((name) => isServerTool(tool, name)),
  );
  return { tools: kept, mcp: attachedServerNames(kept) };
}
