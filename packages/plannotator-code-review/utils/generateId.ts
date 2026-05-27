/** Short random ID for AI chat messages (question/response pairs). Not crypto-safe. */
export const generateId = () => Math.random().toString(36).substring(2, 9);
