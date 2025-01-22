import type { EventSubmission, TMessage, TPayload, TSubmission, TConversation, EModelEndpoint } from 'librechat-data-provider';
import {
  /* @ts-ignore */
  createPayload,
  isAgentsEndpoint,
  isAssistantsEndpoint,
  removeNullishValues,
  request,
} from 'librechat-data-provider';
import { useGetStartupConfig, useGetUserBalance } from 'librechat-data-provider/react-query';
import { useEffect, useState } from 'react';
import { useSetRecoilState } from 'recoil';
import { SSE } from 'sse.js';
import { v4 } from 'uuid';
import type { TResData } from '~/common';
import { useGenTitleMutation } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import store from '~/store';
import type { EventHandlerParams } from './useEventHandlers';
import useEventHandlers from './useEventHandlers';

type ChatHelpers = Pick<
  EventHandlerParams,
  | 'setMessages'
  | 'getMessages'
  | 'setConversation'
  | 'setIsSubmitting'
  | 'newConversation'
  | 'resetLatestMessage'
>;

export default function useSSE(
  submission: TSubmission | null,
  chatHelpers: ChatHelpers,
  isAddedRequest = false,
  runIndex = 0,
) {
  const genTitle = useGenTitleMutation();
  const setActiveRunId = useSetRecoilState(store.activeRunFamily(runIndex));

  const { token, isAuthenticated } = useAuthContext();
  const [completed, setCompleted] = useState(new Set());
  const setAbortScroll = useSetRecoilState(store.abortScrollFamily(runIndex));
  const setShowStopButton = useSetRecoilState(store.showStopButtonByIndex(runIndex));

  const {
    setMessages,
    getMessages,
    setConversation,
    setIsSubmitting,
    newConversation,
    resetLatestMessage,
  } = chatHelpers;

  const {
    stepHandler,
    syncHandler,
    finalHandler,
    errorHandler,
    messageHandler,
    contentHandler,
    createdHandler,
    attachmentHandler,
    abortConversation,
  } = useEventHandlers({
    genTitle,
    setMessages,
    getMessages,
    setCompleted,
    isAddedRequest,
    setConversation,
    setIsSubmitting,
    newConversation,
    setShowStopButton,
    resetLatestMessage,
  });

  const { data: startupConfig } = useGetStartupConfig();
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.checkBalance,
  });

  useEffect(() => {
    if (submission === null || Object.keys(submission).length === 0) {
      return;
    }

    const payloadData = createPayload(submission);
    let { payload } = payloadData;
    let userMessage = submission?.userMessage;
    if (isAssistantsEndpoint(payload.endpoint) || isAgentsEndpoint(payload.endpoint)) {
      payload = removeNullishValues(payload) as TPayload;
    }

    let textIndex = null;

    const chatEndpoint = payload.endpoint === 'bedrockAgents' ? '/api/endpoints/bedrockAgents/chat' : payloadData.server;
    const fullEndpoint = chatEndpoint.startsWith('http') ? chatEndpoint : `${window.location.origin}${chatEndpoint}`;

    // Ensure we have a valid conversation ID for all endpoints
    const generateConvId = () => `conv-${Date.now()}`;
    const validateConvId = (id: string | null | undefined): boolean => 
      !!id && id !== 'new' && (id.startsWith('conv-') || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));

    if (!validateConvId(payload.conversationId)) {
      payload.conversationId = generateConvId();
      // Update conversation state to match
      setConversation?.((prev: TConversation | null) => {
        const newState: TConversation = {
          conversationId: payload.conversationId ?? '',
          endpoint: payload.endpoint as EModelEndpoint,
          endpointType: payload.endpoint as EModelEndpoint,
          model: payload.model ?? null,
          messages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          title: null,
          jailbreak: false,
        };
        
        if (!prev) {
          return newState;
        }
        
        return {
          ...prev,
          ...newState,
        };
      });
    }

    // Log SSE connection details
    console.log('Creating SSE connection with:', {
      url: fullEndpoint,
      payload,
      endpoint: payload.endpoint,
      token,
      conversationId: payload.conversationId
    });

    // Initialize SSE connection
    const sse = new SSE(fullEndpoint, {
      payload: JSON.stringify(payload),
      headers: { 
        'Content-Type': 'application/json', 
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${token}` 
      },
      method: 'POST'
    });

    sse.addEventListener('attachment', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        attachmentHandler({ data, submission: submission as EventSubmission });
      } catch (error) {
        console.error(error);
      }
    });

    sse.addEventListener('message', (e: MessageEvent) => {
      console.log('SSE message received:', e.data);
      const data = JSON.parse(e.data);

      if (data.final != null) {
        const { plugins } = data;
        finalHandler(data, { ...submission, plugins } as EventSubmission);
        (startupConfig?.checkBalance ?? false) && balanceQuery.refetch();
        console.log('final', data);
        return;
      } else if (data.created != null) {
        const runId = v4();
        setActiveRunId(runId);
        userMessage = {
          ...userMessage,
          ...data.message,
          overrideParentMessageId: userMessage.overrideParentMessageId,
        };

        createdHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data.event != null) {
        stepHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data.sync != null) {
        const runId = v4();
        setActiveRunId(runId);
        /* synchronize messages to Assistants API as well as with real DB ID's */
        syncHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data.type != null) {
        const { text, index } = data;
        if (text != null && index !== textIndex) {
          textIndex = index;
        }

        contentHandler({ data, submission: submission as EventSubmission });
      } else {
        const text = data.text ?? data.response;
        const { plugin, plugins } = data;

        const initialResponse = {
          ...(submission.initialResponse as TMessage),
          parentMessageId: data.parentMessageId,
          messageId: data.messageId,
        };

        if (data.message != null) {
          messageHandler(text, { ...submission, plugin, plugins, userMessage, initialResponse });
        }
      }
    });

    sse.addEventListener('open', () => {
      setAbortScroll(false);
      console.log('SSE connection opened:', {
        readyState: sse.readyState,
        url: payloadData.server
      });
    });

    sse.addEventListener('cancel', async () => {
      const streamKey = (submission as TSubmission | null)?.['initialResponse']?.messageId;
      if (completed.has(streamKey)) {
        setIsSubmitting(false);
        setCompleted((prev) => {
          prev.delete(streamKey);
          return new Set(prev);
        });
        return;
      }

      setCompleted((prev) => new Set(prev.add(streamKey)));
      const latestMessages = getMessages() ?? [];
      // Ensure we have a valid conversation ID by checking all possible sources
      const conversationId = 
        latestMessages[latestMessages.length - 1]?.conversationId ?? 
        userMessage?.conversationId ?? 
        submission?.conversationId ?? 
        `conv-${Date.now()}`;
      
      return await abortConversation(
        conversationId,
        submission as EventSubmission,
        latestMessages,
      );
    });

    sse.addEventListener('error', async (e: MessageEvent) => {
      /* @ts-ignore */
      if (e.responseCode === 401) {
        /* token expired, refresh and retry */
        try {
          const refreshResponse = await request.refreshToken();
          const token = refreshResponse?.token ?? '';
          if (!token) {
            throw new Error('Token refresh failed.');
          }
          sse.headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          };

          request.dispatchTokenUpdatedEvent(token);
          sse.stream();
          return;
        } catch (error) {
          /* token refresh failed, continue handling the original 401 */
          console.log(error);
        }
      }

      console.log('error in server stream.');
      (startupConfig?.checkBalance ?? false) && balanceQuery.refetch();

      let data: TResData | undefined = undefined;
      try {
        data = JSON.parse(e.data) as TResData;
      } catch (error) {
        console.error(error);
        console.log(e);
        setIsSubmitting(false);
      }

      errorHandler({ data, submission: { ...submission, userMessage } as EventSubmission });
    });

    setIsSubmitting(true);
    sse.stream();

    return () => {
      const isCancelled = sse.readyState <= 1;
      sse.close();
      if (isCancelled) {
        const e = new Event('cancel');
        /* @ts-ignore */
        sse.dispatchEvent(e);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission]);
}
