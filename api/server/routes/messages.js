const express = require('express');
const { ContentTypes } = require('librechat-data-provider');
const { saveConvo, saveMessage, getMessages, updateMessage, deleteMessages } = require('~/models');
const { requireJwtAuth, validateMessageReq } = require('~/server/middleware');
const { countTokens } = require('~/server/utils');
const { logger } = require('~/config');

const router = express.Router();
router.use(requireJwtAuth);

/* Note: It's necessary to add `validateMessageReq` within route definition for correct params */
router.get('/:conversationId', validateMessageReq, async (req, res) => {
  try {
    const { conversationId } = req.params;
    logger.debug('[Messages] Fetching messages:', {
      conversationId,
      params: req.params,
      query: req.query,
      user: req.user?.id
    });
    
    // Ensure we have a valid conversation ID
    if (!conversationId) {
      logger.error('[Messages] Missing conversation ID');
      return res.status(400).json({ error: 'Conversation ID is required' });
    }

    // Handle new conversations
    if (conversationId === 'new') {
      logger.debug('[Messages] New conversation requested');
      return res.status(200).json([]);
    }

    // Get messages for the conversation
    const messages = await getMessages({ conversationId, user: req.user.id }, '-_id -__v -user');
    
    logger.debug('[Messages] Found messages:', {
      conversationId,
      count: messages?.length ?? 0,
      messages: messages?.map(m => ({
        messageId: m.messageId,
        sender: m.sender,
        endpoint: m.endpoint
      }))
    });
    
    // Return empty array if no messages found (don't treat as 404)
    if (!messages || messages.length === 0) {
      logger.debug('[Messages] No messages found for conversation:', { conversationId });
      return res.status(200).json([]);
    }
    
    res.status(200).json(messages);
  } catch (error) {
    logger.error('[Messages] Error fetching messages:', {
      error: error.message,
      stack: error.stack,
      conversationId: req.params.conversationId,
      user: req.user?.id
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:conversationId', validateMessageReq, async (req, res) => {
  try {
    const message = req.body;
    const savedMessage = await saveMessage(
      req,
      { ...message, user: req.user.id },
      { context: 'POST /api/messages/:conversationId' },
    );
    if (!savedMessage) {
      return res.status(400).json({ error: 'Message not saved' });
    }
    await saveConvo(req, savedMessage, { context: 'POST /api/messages/:conversationId' });
    res.status(201).json(savedMessage);
  } catch (error) {
    logger.error('Error saving message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:conversationId/:messageId', validateMessageReq, async (req, res) => {
  try {
    const { conversationId, messageId } = req.params;
    const message = await getMessages({ conversationId, messageId }, '-_id -__v -user');
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.status(200).json(message);
  } catch (error) {
    logger.error('Error fetching message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:conversationId/:messageId', validateMessageReq, async (req, res) => {
  try {
    const { conversationId, messageId } = req.params;
    const { text, index, model } = req.body;

    if (index === undefined) {
      const tokenCount = await countTokens(text, model);
      const result = await updateMessage(req, { messageId, text, tokenCount });
      return res.status(200).json(result);
    }

    if (typeof index !== 'number' || index < 0) {
      return res.status(400).json({ error: 'Invalid index' });
    }

    const message = (await getMessages({ conversationId, messageId }, 'content tokenCount'))?.[0];
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const existingContent = message.content;
    if (!Array.isArray(existingContent) || index >= existingContent.length) {
      return res.status(400).json({ error: 'Invalid index' });
    }

    const updatedContent = [...existingContent];
    if (!updatedContent[index]) {
      return res.status(400).json({ error: 'Content part not found' });
    }

    if (updatedContent[index].type !== ContentTypes.TEXT) {
      return res.status(400).json({ error: 'Cannot update non-text content' });
    }

    const oldText = updatedContent[index].text;
    updatedContent[index] = { type: ContentTypes.TEXT, text };

    let tokenCount = message.tokenCount;
    if (tokenCount !== undefined) {
      const oldTokenCount = await countTokens(oldText, model);
      const newTokenCount = await countTokens(text, model);
      tokenCount = Math.max(0, tokenCount - oldTokenCount) + newTokenCount;
    }

    const result = await updateMessage(req, { messageId, content: updatedContent, tokenCount });
    return res.status(200).json(result);
  } catch (error) {
    logger.error('Error updating message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:conversationId/:messageId', validateMessageReq, async (req, res) => {
  try {
    const { messageId } = req.params;
    await deleteMessages({ messageId });
    res.status(204).send();
  } catch (error) {
    logger.error('Error deleting message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
