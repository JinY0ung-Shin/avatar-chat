import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AppConfig } from "../types.js";
import { ensureClone, knowledgeRepoContextFor, readFile as readRepoFile } from "../knowledgeRepo.js";
import { OWNER_ONLY, cloneFailureMessage, readFileErrorMessage } from "./repoToolKit.js";
import { text } from "./mcpTools.js";
import { formatBrainHits, normalizeWikiPath, rankBrainNotes } from "./brainSearch.js";

/**
 * Per-conversation context for the PERSONAL second-brain search tools. Read-only
 * recall over the owner's knowledge-repo `wiki/`. The repo is ALWAYS resolved
 * from `avatarUserId` (the owner) — never the viewer — so a trusted teammate's
 * search hits the OWNER's vault, mirroring `mcp__repo__read_file` read-parity.
 */
export interface BrainToolsContext {
  /** The avatar (== owner) whose second brain these tools read. */
  avatarUserId: string;
  /** True only when the present viewer IS the owner and the run is interactive. */
  viewerIsOwner: boolean;
  /**
   * True for the owner OR a trusted same-group teammate (interactive turn). Gates
   * the read tools so teammates can search — but not edit — the owner's brain.
   * Defaults to `viewerIsOwner` when omitted.
   */
  elevated?: boolean;
  config: AppConfig;
  /**
   * Set only on a personal-agent (bot) run: the bot's OWN memory namespace inside
   * the owner's knowledge repo (`root` is repo-relative, no trailing slash — its
   * `wiki/`+`raw/` are the vault). Recall then reaches THAT subtree instead of the
   * owner's root vault, and the tool text says so — the bot must never present the
   * owner's second brain (or another bot's memory) as its own.
   */
  scope?: { root: string; botName: string };
}

/** MCP server name; tools surface to the model as `mcp__brain__<tool>`. */
export const BRAIN_SERVER_NAME = "brain";

/** Tool names the model may call, in `allowedTools` form. */
export const BRAIN_TOOL_NAMES = ["mcp__brain__search", "mcp__brain__get_note"] as const;

const NO_REPO =
  "No knowledge repository is connected yet, so there is no second brain to search. If you are the owner, create and connect one with the `mcp__repo__create_repo` tool first, then capture notes under `wiki/`. Do not walk through manual setup — use `create_repo`.";
const NO_VAULT =
  "Your knowledge repository has no `wiki/` vault yet (it predates the second-brain layout). Run the `brain-migrate` skill ONCE to create the vault skeleton (it never overwrites existing files), then capture notes with the `brain-ingest` skill and retry. Do not use Bash — use the repo tools.";
// A bot chat has no `create_repo` (the tool refuses under a path scope), so the
// scoped no-repo text points at the one place it CAN be done instead.
const NO_REPO_SCOPED =
  "No knowledge repository is connected yet, so you have no memory to search. The OWNER has to create and connect one from their MAIN avatar chat — `create_repo` is not available in a bot chat. Tell them that instead of walking through manual setup, and answer from this conversation for now.";

/**
 * An empty memory namespace is NORMAL (a new bot has captured nothing yet), not
 * the legacy-repo state the root `NO_VAULT` describes: `brain-migrate` seeds the
 * ROOT vault, so pointing a bot at it would send it outside its own scope.
 */
function noVaultScoped(root: string): string {
  return `Your memory is still empty — nothing has been captured under \`${root}/wiki/\` yet, so answer from this conversation. When something durable comes up, write it as a note under \`${root}/wiki/\` (or a raw capture under \`${root}/raw/\`) with \`mcp__repo__write_file\` and push it with \`mcp__repo__commit\`; from then on this search finds it.`;
}

/**
 * Build the personal second-brain tool definitions. Read-only and gated on
 * `elevated` (owner OR trusted same-group teammate); there is no write tool here
 * (capture/consolidate go through the owner-only `mcp__repo__*` tools via the
 * brain-ingest/brain-reflect skills). Exposed separately for direct testing.
 * `ctx.scope` re-points every read at a bot's own memory subtree.
 */
export function buildBrainTools(store: Store, ctx: BrainToolsContext) {
  const canRead = ctx.elevated ?? ctx.viewerIsOwner;
  const repoCtx = () => knowledgeRepoContextFor(store, ctx.avatarUserId, ctx.config);
  const scope = ctx.scope;
  const scopeOpts = scope ? { root: scope.root } : undefined;
  const noRepo = scope ? NO_REPO_SCOPED : NO_REPO;
  // Descriptions are build-time: on a bot run they must advertise the bot's OWN
  // memory, or the model reaches for the owner's brain and gets refusals instead.
  const searchDescription = scope
    ? `Search YOUR OWN memory — the notes under \`${scope.root}/wiki/\` in the owner's knowledge repository, where you (${scope.botName}) have distilled past conversations, decisions, people, and concepts. This namespace is YOURS ALONE: it is SEPARATE from the owner's own second brain and from every other bot's memory, and neither is reachable from this chat. **Call this BEFORE answering any question that could draw on accumulated knowledge** (the owner's preferences, prior decisions, people/projects, recurring topics) instead of answering from the live conversation alone. Returns the most relevant notes ranked by title/aliases, tags, then body, each with the note path and a snippet; read a full hit with \`get_note\` or \`mcp__repo__read_file\`. (read-only)`
    : "Search your SECOND BRAIN — the curated notes under `wiki/` in your knowledge repository, where past conversations, decisions, people, and concepts have been distilled. **Call this BEFORE answering any question that could draw on accumulated knowledge** (the owner's preferences, prior decisions, people/projects, recurring topics) instead of answering from the live conversation alone. Returns the most relevant notes ranked by title/aliases, tags, then body, each with the note path and a snippet; read a full hit with `get_note` or `mcp__repo__read_file`. (owner or trusted same-group teammates; read-only)";
  const getNoteDescription = scope
    ? `Read a full note from YOUR OWN memory by its path (as returned by \`search\`). A thin, vault-scoped convenience over \`read_file\`: the path must live under \`${scope.root}/wiki/\` — your memory, never the owner's second brain. Use it to pull the complete note after \`search\` surfaces a relevant hit. (read-only)`
    : "Read a full note from your second brain by its `wiki/` path (as returned by `search`). A thin, wiki-scoped convenience over `read_file`: the path must live under `wiki/`. Use it to pull the complete note after `search` surfaces a relevant hit. (owner or trusted same-group teammates; read-only)";

  return [
    tool(
      "search",
      searchDescription,
      {
        query: z.string().describe("What to look for, in natural language or keywords."),
        limit: z.number().int().optional().describe("Max notes to return (default 8, max 20)."),
      },
      async (args) => {
        if (!canRead) return text(OWNER_ONLY, true);
        const c = repoCtx();
        if (!c) return text(noRepo, true);
        try {
          const repoRoot = await ensureClone(c);
          const result = await rankBrainNotes(repoRoot, args.query, args.limit, scopeOpts);
          if (result.kind === "no_vault") {
            // Scoped: an empty namespace is not an error state — the bot should
            // just answer and capture, so this stays a normal (non-error) result.
            return scope ? text(noVaultScoped(scope.root)) : text(NO_VAULT, true);
          }
          if (result.hits.length === 0) {
            return text(
              scope
                ? `No notes in your memory matched "${args.query}". It may not be captured yet — if it is durable, write it as a note under \`${scope.root}/wiki/\` with \`mcp__repo__write_file\` and push it with \`mcp__repo__commit\`.`
                : `No notes in your second brain matched "${args.query}". It may not be captured yet — if it is durable, capture it with the brain-ingest skill.`,
            );
          }
          return text(
            `Top ${result.hits.length} note(s) from your ${scope ? "memory" : "second brain"} for "${args.query}":\n${formatBrainHits(
              result.hits,
            )}\n\nRead a full note with get_note or mcp__repo__read_file.`,
          );
        } catch (error) {
          return text(cloneFailureMessage(error), true);
        }
      },
    ),
    tool(
      "get_note",
      getNoteDescription,
      {
        path: z
          .string()
          .describe(
            scope
              ? `Repository-relative path under ${scope.root}/wiki/ (e.g. ${scope.root}/wiki/concepts/deploy.md)`
              : "Repository-relative path under wiki/ (e.g. wiki/concepts/deploy.md)",
          ),
      },
      async (args) => {
        if (!canRead) return text(OWNER_ONLY, true);
        const c = repoCtx();
        if (!c) return text(noRepo, true);
        // Wiki-scoped: normalize first so `wiki/../CLAUDE.md` can't escape the
        // vault into other repo files. (readFile's resolveInRepo still guards
        // repo containment; this restricts the surface to wiki/ specifically.)
        const w = normalizeWikiPath(args.path, scopeOpts);
        if (!w.ok) {
          return text(
            scope
              ? `get_note only reads notes under \`${scope.root}/wiki/\` — your own memory. Use mcp__repo__read_file for other paths inside that folder.`
              : "get_note only reads notes under `wiki/`. Use mcp__repo__read_file for other paths.",
            true,
          );
        }
        try {
          const repoRoot = await ensureClone(c);
          return text(await readRepoFile(repoRoot, w.norm));
        } catch (error) {
          return text(readFileErrorMessage(error), true);
        }
      },
    ),
  ];
}

/** Build the in-process MCP server exposing the personal second-brain tools. */
export function buildBrainServer(store: Store, ctx: BrainToolsContext) {
  return createSdkMcpServer({
    name: BRAIN_SERVER_NAME,
    version: "0.1.0",
    tools: buildBrainTools(store, ctx),
  });
}
