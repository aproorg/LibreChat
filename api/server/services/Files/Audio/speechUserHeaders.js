/**
 * The speech request's end user as a header, for a gateway that tracks spend per user (apro-gateway reads
 * `x-user-email`, the header the chat endpoints already send). Speech config takes no `headers`, so this is
 * opt-in by environment: SPEECH_USER_EMAIL_HEADER names the header. Unset, nothing is sent, since it hands
 * the user's email to the speech provider.
 * @param {{ email?: string } | undefined} user - `req.user`
 * @returns {Record<string, string>}
 */
function speechUserHeaders(user) {
  const name = process.env.SPEECH_USER_EMAIL_HEADER?.trim();
  const email = user?.email;
  if (!name || typeof email !== 'string' || !email || /[\r\n]/.test(email)) {
    return {};
  }
  return { [name]: email };
}

module.exports = { speechUserHeaders };
