export interface AvatarApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type AvatarTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface AvatarTask {
  id: string;
  ownerUserId: string;
  apiKeyId: string;
  conversationId: string;
  message: string;
  status: AvatarTaskStatus;
  runId: string | null;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  userMessagePersisted: boolean;
}
