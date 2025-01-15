import { useMutation } from '@tanstack/react-query';
import { invokeBedrockAgentChat } from 'librechat-data-provider/react-query';

export const useBedrockAgentChat = () => {
  return useMutation({
    mutationFn: invokeBedrockAgentChat,
  });
};

export default useBedrockAgentChat;
