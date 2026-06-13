import pino from "pino";

const level =
  process.env.LOG_LEVEL ??
  (process.env.NODE_ENV === "test" ? "silent" : "info");

const logger = pino({
  level,
  // Defense-in-depth secret hygiene: call sites are already careful never to log
  // secret values, but redact censors them automatically if a token/secret/auth
  // header ever lands in a logged object (one nested level via the `*.` paths).
  redact: {
    paths: [
      "token",
      "*.token",
      "password",
      "*.password",
      "secret",
      "*.secret",
      "sessionSecret",
      "*.sessionSecret",
      "gitToken",
      "*.gitToken",
      "authorization",
      "*.authorization",
      "headers.authorization",
      "*.headers.authorization",
    ],
    censor: "[redacted]",
  },
  transport:
    process.env.NODE_ENV !== "production"
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
        }
      : undefined,
});

export default logger;
export type Logger = pino.Logger;
