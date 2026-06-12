import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import { generateSshKeyPair } from "../sshIdentity.js";

export interface SshIdentityToolsContext {
  /** The avatar (== owner) whose SSH identity is managed. */
  avatarUserId: string;
  /** The avatar owner, used only for key comments and audit attribution. */
  owner: { id: string; username: string; displayName: string; alias?: string };
  /** True only when the present viewer IS the owner and the run is interactive. */
  viewerIsOwner: boolean;
}

export const SSH_IDENTITY_SERVER_NAME = "ssh_identity";

export const SSH_IDENTITY_TOOL_NAMES = [
  "mcp__ssh_identity__show_public_key",
  "mcp__ssh_identity__generate_key",
] as const;

const OWNER_ONLY = "이 도구는 아바타 소유자가 참여 중인 대화에서만 사용할 수 있습니다.";

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

function defaultComment(ctx: SshIdentityToolsContext): string {
  return `avatar-chat-${ctx.owner.username || ctx.avatarUserId}`;
}

export function buildSshIdentityTools(store: Store, ctx: SshIdentityToolsContext) {
  return [
    tool(
      "show_public_key",
      "저장된 SSH 공개키를 보여준다. 개인키는 절대 반환하지 않는다. (소유자 전용)",
      {},
      async () => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const publicKey = store.getUserById(ctx.avatarUserId)?.sshPublicKey?.trim();
        if (!publicKey) {
          return text("저장된 SSH 공개키가 없습니다. generate_key로 새 키를 만들 수 있습니다.");
        }
        return text(`저장된 SSH 공개키:\n${publicKey}`);
      },
    ),
    tool(
      "generate_key",
      "새 Ed25519 SSH 키쌍을 생성해 개인키는 SSH_PRIVATE_KEY 시크릿으로 암호화 저장하고, 공개키만 반환한다. 기존 SSH 키가 있으면 덮어쓰지 않는다. (소유자 전용)",
      {
        comment: z.string().max(80).optional().describe("공개키 끝에 붙일 짧은 주석"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const user = store.getUserById(ctx.avatarUserId);
        const secretNames = store.listUserSecretNames(ctx.avatarUserId);
        if (secretNames.includes("SSH_PRIVATE_KEY") || user?.sshPublicKey) {
          const publicKey = user?.sshPublicKey?.trim();
          return text(
            publicKey
              ? `이미 SSH 키가 설정되어 있습니다. 기존 공개키:\n${publicKey}`
              : "이미 SSH_PRIVATE_KEY 시크릿이 설정되어 있습니다. 새 키를 만들려면 먼저 설정에서 기존 SSH_PRIVATE_KEY를 삭제하세요.",
            true,
          );
        }

        let pair: Awaited<ReturnType<typeof generateSshKeyPair>>;
        try {
          pair = await generateSshKeyPair(args.comment || defaultComment(ctx));
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return text(`SSH 키를 생성하지 못했습니다: ${msg}`, true);
        }
        store.setSshKeyPair(ctx.avatarUserId, pair.privateKey, pair.publicKey);
        store.audit({
          actorUserId: ctx.owner.id,
          actorName: ctx.owner.username,
          action: "ssh_identity_generate_key",
          status: "ok",
          detail: JSON.stringify({ fingerprint: pair.fingerprint }),
        });
        return text(
          `SSH 키를 생성해 저장했습니다. 개인키는 SSH_PRIVATE_KEY 시크릿으로 저장되어 다시 표시되지 않습니다.\n` +
            `지문: ${pair.fingerprint}\n` +
            `공개키:\n${pair.publicKey}`,
        );
      },
    ),
  ];
}

export function buildSshIdentityServer(store: Store, ctx: SshIdentityToolsContext) {
  return createSdkMcpServer({
    name: SSH_IDENTITY_SERVER_NAME,
    version: "0.1.0",
    tools: buildSshIdentityTools(store, ctx),
  });
}
