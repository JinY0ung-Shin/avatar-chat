import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AppConfig,
  AppState,
  AuditEvent,
  ChatMode,
  Invite,
  Session,
  User,
  UserRole,
} from "./types.js";

const SESSION_DAYS = 14;

function now(): string {
  return new Date().toISOString();
}

export function hashSecret(secret: string, salt: string): string {
  return crypto
    .createHash("sha256")
    .update(`${salt}:${secret}`)
    .digest("hex");
}

function randomCode(): string {
  return crypto.randomBytes(18).toString("base64url");
}

function emptyState(): AppState {
  return {
    users: [],
    invites: [],
    sessions: [],
    messages: [],
    audit: [],
  };
}

export class JsonStore {
  private readonly filePath: string;

  constructor(private readonly config: AppConfig) {
    this.filePath = path.join(config.dataDir, "app-state.json");
    fs.mkdirSync(config.dataDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.write(emptyState());
    }
  }

  read(): AppState {
    const raw = fs.readFileSync(this.filePath, "utf8");
    return { ...emptyState(), ...JSON.parse(raw) } as AppState;
  }

  write(state: AppState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmpPath, this.filePath);
  }

  update<T>(mutator: (state: AppState) => T): T {
    const state = this.read();
    const result = mutator(state);
    this.write(state);
    return result;
  }

  authenticateOwner(name: string, code: string): { user: User; sessionToken: string } | null {
    if (code !== this.config.ownerSetupCode) {
      return null;
    }
    return this.update((state) => {
      let user = state.users.find((candidate) => candidate.role === "owner");
      if (!user) {
        user = {
          id: crypto.randomUUID(),
          name,
          role: "owner",
          projectScope: this.config.defaultProjectScope,
          createdAt: now(),
        };
        state.users.push(user);
      } else {
        user.name = name || user.name;
        user.lastSeenAt = now();
      }
      const sessionToken = this.createSessionForState(state, user.id);
      return { user, sessionToken };
    });
  }

  authenticateInvite(name: string, code: string): { user: User; sessionToken: string } | null {
    const codeHash = hashSecret(code, this.config.sessionSecret);
    return this.update((state) => {
      const invite = state.invites.find(
        (candidate) =>
          candidate.codeHash === codeHash &&
          !candidate.revokedAt &&
          candidate.uses < candidate.maxUses,
      );
      if (!invite) {
        return null;
      }
      invite.uses += 1;
      const user: User = {
        id: crypto.randomUUID(),
        name,
        role: invite.role,
        projectScope: invite.projectScope,
        createdAt: now(),
      };
      state.users.push(user);
      const sessionToken = this.createSessionForState(state, user.id);
      return { user, sessionToken };
    });
  }

  getUserBySessionToken(token: string | undefined): User | null {
    if (!token) {
      return null;
    }
    const tokenHash = hashSecret(token, this.config.sessionSecret);
    const current = now();
    return this.update((state) => {
      state.sessions = state.sessions.filter((session) => session.expiresAt > current);
      const session = state.sessions.find((candidate) => candidate.tokenHash === tokenHash);
      if (!session) {
        return null;
      }
      const user = state.users.find((candidate) => candidate.id === session.userId) ?? null;
      if (user) {
        user.lastSeenAt = current;
      }
      return user;
    });
  }

  revokeSession(token: string | undefined): void {
    if (!token) {
      return;
    }
    const tokenHash = hashSecret(token, this.config.sessionSecret);
    this.update((state) => {
      state.sessions = state.sessions.filter((session) => session.tokenHash !== tokenHash);
    });
  }

  createInvite(input: {
    label: string;
    role: UserRole;
    projectScope: string;
    maxUses: number;
    createdBy: string;
  }): Invite & { code: string } {
    const code = randomCode();
    const invite: Invite = {
      id: crypto.randomUUID(),
      label: input.label,
      codeHash: hashSecret(code, this.config.sessionSecret),
      codePreview: code.slice(-6),
      role: input.role,
      projectScope: input.projectScope,
      maxUses: Math.max(1, Math.min(input.maxUses, 500)),
      uses: 0,
      createdBy: input.createdBy,
      createdAt: now(),
    };
    this.update((state) => {
      state.invites.unshift(invite);
    });
    return { ...invite, code };
  }

  listInvites(): Invite[] {
    return this.read().invites;
  }

  addMessages(messages: AppState["messages"]): void {
    this.update((state) => {
      state.messages.push(...messages);
      state.messages = state.messages.slice(-500);
    });
  }

  addAudit(event: Omit<AuditEvent, "id" | "createdAt">): AuditEvent {
    const auditEvent: AuditEvent = {
      ...event,
      id: crypto.randomUUID(),
      createdAt: now(),
    };
    this.update((state) => {
      state.audit.unshift(auditEvent);
      state.audit = state.audit.slice(0, 300);
    });
    return auditEvent;
  }

  listAudit(limit = 80): AuditEvent[] {
    return this.read().audit.slice(0, limit);
  }

  listMessagesForUser(userId: string, mode?: ChatMode): AppState["messages"] {
    return this.read()
      .messages.filter((message) => message.userId === userId && (!mode || message.mode === mode))
      .slice(-80);
  }

  private createSessionForState(state: AppState, userId: string): string {
    const token = randomCode();
    const createdAt = now();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const session: Session = {
      id: crypto.randomUUID(),
      tokenHash: hashSecret(token, this.config.sessionSecret),
      userId,
      createdAt,
      expiresAt,
    };
    state.sessions.push(session);
    return token;
  }
}

export function createMessage(input: {
  conversationId: string;
  userId: string;
  mode: ChatMode;
  role: "user" | "assistant" | "system";
  content: string;
  response?: AppState["messages"][number]["response"];
}): AppState["messages"][number] {
  return {
    id: crypto.randomUUID(),
    conversationId: input.conversationId,
    userId: input.userId,
    mode: input.mode,
    role: input.role,
    content: input.content,
    response: input.response,
    createdAt: now(),
  };
}
