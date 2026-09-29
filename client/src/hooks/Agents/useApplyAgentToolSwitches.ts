import { useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { useRecoilCallback, useSetRecoilState } from 'recoil';
import { Constants, getAgentToolSwitches } from 'librechat-data-provider';
import type { Agent, TEphemeralAgent } from 'librechat-data-provider';
import { ephemeralAgentByConvoId, mcpValuesAtomFamily } from '~/store';
import { applyAgentToolSwitchDefaults } from '~/utils';

export function useApplyAgentToolSwitches({
  agent,
  conversationId,
}: {
  agent?: Pick<Agent, 'id' | 'tools' | 'tool_options'> | null;
  conversationId?: string | null;
}) {
  const convoId = conversationId ?? Constants.NEW_CONVO;
  const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(convoId));
  const setMCPValues = useSetAtom(mcpValuesAtomFamily(convoId));
  const getEphemeralAgent = useRecoilCallback(
    ({ snapshot }) =>
      () =>
        snapshot.getLoadable(ephemeralAgentByConvoId(convoId)).contents as TEphemeralAgent | null,
    [convoId],
  );
  const seededRef = useRef<{ convoId: string; seedKey: string } | null>(null);
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
    const previousSeed = seededRef.current;
    const seedKey = `${agentId}:${switchesKey}`;
    seededRef.current = { convoId, seedKey };
    /** A new chat that just received its real id already carries the user's
     *  choices, copied over from the submission; persist them instead of reseeding. */
    const carried =
      previousSeed?.convoId === Constants.NEW_CONVO &&
      previousSeed.seedKey === seedKey &&
      convoId !== Constants.NEW_CONVO
        ? getEphemeralAgent()
        : null;
    if (carried) {
      if (Array.isArray(carried.mcp)) {
        setMCPValues(carried.mcp);
      }
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
  }, [agentId, switchesKey, convoId, setEphemeralAgent, setMCPValues, getEphemeralAgent]);
}
