/**
 * Per-conversation "working repository" selection for general git repos.
 *
 * Direction B (single working surface): the avatar no longer edits a registered
 * repo through MCP file tools. Instead it OPENS one repo as the conversation's
 * working directory (`mcp__git_repo__open_repo`); from the NEXT turn the chat
 * route points the SDK cwd at that repo's clone and the avatar edits/tests it
 * with native tools (Read/Edit/Bash), while remote git (push/sync) stays MCP.
 *
 * The SDK cwd is fixed when a turn starts and the model cannot repoint it
 * mid-turn, so the selection has to live OUTSIDE the model turn. This holds it
 * per conversation, in memory — single-process, matching `activeRepoLock` and
 * the rest of the app (in-process SQLite + runRegistry). A server restart clears
 * it (the avatar simply re-opens the repo); persist to a column later if needed.
 */
const selectedByConversation = new Map<string, string>();

/** Set (or clear, when `repoName` is null) the working repo for a conversation. */
export function setWorkspaceRepo(conversationId: string, repoName: string | null): void {
  if (repoName) {
    selectedByConversation.set(conversationId, repoName);
  } else {
    selectedByConversation.delete(conversationId);
  }
}

/** The working repo opened for this conversation, or null when none is open. */
export function getWorkspaceRepo(conversationId: string): string | null {
  return selectedByConversation.get(conversationId) ?? null;
}
