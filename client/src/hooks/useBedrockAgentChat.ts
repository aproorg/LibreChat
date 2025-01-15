import { useMutation } from '@tanstack/react-query';
import { dataService } from 'librechat-data-provider';

export const useBedrockAgentChat = () => {
  return useMutation({
    mutationFn: dataService.invokeBedrockAgentChat,
  });
};

export default useBedrockAgentChat;
