const normalizeSessionId = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return 'default';
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
  return safe || 'default';
};

const getSessionIdFromRequest = (req) => {
  const header = req.headers?.['x-session-id'];
  const query = req.query?.sessionId;
  const body = req.body?.sessionId;
  return normalizeSessionId(header || query || body);
};

export { getSessionIdFromRequest };
