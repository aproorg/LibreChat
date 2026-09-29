import { useEffect, useRef } from 'react';
import { useSetRecoilState } from 'recoil';
import { Constants, getAgentToolSwitches } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import { applyAgentToolSwitchDefaults } from '~/utils';
import { ephemeralAgentByConvoId } from '~/store';

export function useApplyAgentToolSwitches({
  agent,
  conversationId,
}: {
  agent?: Pick<Agent, 'id' | 'tools' | 'tool_options'> | null;
  conversationId?: string | null;
}) {
  const convoId = conversationId ?? Constants.NEW_CONVO;
  const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(convoId));
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const agentId = agent?.id;
  /** The saved agent's cache entry is replaced in place when its creator edits it,
   *  so reseed on a change in the switch config itself, not just the agent id. */
  const switchesKey = agent ? JSON.stringify(getAgentToolSwitches(agent)) : '';

  useEffect(() => {
    const current = agentRef.current;
    if (!current) {
      return;
    }
    const switches = getAgentToolSwitches(current);
    const switchableServers = Object.keys(switches.mcp);
    if (Object.keys(switches.builtins).length === 0 && switchableServers.length === 0) {
      return;
    }
    const seeded = applyAgentToolSwitchDefaults({
      agent: current,
      convoId,
      isNewConvo: convoId === Constants.NEW_CONVO,
    });
    setEphemeralAgent((previous) => ({
      ...previous,
      ...seeded,
      ...(seeded.mcp && {
        mcp: [
          ...(previous?.mcp ?? []).filter((name) => !switchableServers.includes(name)),
          ...seeded.mcp,
        ],
      }),
    }));
  }, [agentId, switchesKey, convoId, setEphemeralAgent]);
}
