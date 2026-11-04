const {
  isEnabled,
  OMIT_UNAVAILABLE_OPENID_HEADERS,
  IGNORE_OPENID_TOKENS_IN_HEADERS,
} = require('@librechat/api');

/**
 * Mount right after `requireRemoteAgentAuth` on every `/v1/*` Agents API router.
 * With REMOTE_AGENTS_OMIT_UNAVAILABLE_OPENID_HEADERS on, the bearer a remote caller sent is for
 * LibreChat, not model endpoints: header resolution ignores it. `federatedTokens` stays because
 * MCP OBO falls back to it (resolveOboToken).
 */
function applyRemoteHeaderPolicy(req, _res, next) {
  if (req.user && isEnabled(process.env.REMOTE_AGENTS_OMIT_UNAVAILABLE_OPENID_HEADERS)) {
    req.user[OMIT_UNAVAILABLE_OPENID_HEADERS] = true;
    req.user[IGNORE_OPENID_TOKENS_IN_HEADERS] = true;
  }
  next();
}

module.exports = { applyRemoteHeaderPolicy };
