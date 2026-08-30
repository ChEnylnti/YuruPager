import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { UserSummary } from "@yurupager/shared";

import type { Config } from "./config.js";
import { hashLocalPassword } from "./database.js";
import { HttpError } from "./errors.js";

const cookieName = "yp_session";

export interface AuthContext {
  user: UserSummary;
  sessionId: string;
}

export async function authenticateRequest(
  request: FastifyRequest,
  pool: Pool,
  config: Config,
): Promise<AuthContext> {
  const token = request.cookies[cookieName];
  if (token === undefined) {
    throw new HttpError(401, "unauthenticated", "Sign in is required");
  }
  return authenticateSessionToken(token, pool, config);
}

export async function authenticateSessionToken(
  token: string,
  pool: Pool,
  config: Config,
): Promise<AuthContext> {
  const result = await pool.query<{
    session_id: string;
    user_id: string;
    email: string;
    display_name: string;
  }>(
    `
      UPDATE web_sessions s
      SET last_seen_at = now()
      FROM app_users u
      WHERE s.user_id = u.id
        AND s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
      RETURNING s.id AS session_id, u.id AS user_id, u.email, u.display_name
    `,
    [sessionTokenHash(token, config.sessionSecret)],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new HttpError(401, "session_expired", "Your session has expired");
  }
  return {
    sessionId: row.session_id,
    user: { id: row.user_id, email: row.email, name: row.display_name },
  };
}

export function browserOriginAllowed(origin: string | undefined, config: Config): boolean {
  if (origin === undefined) return true;
  try {
    return new URL(origin).origin === new URL(config.webOrigin).origin;
  } catch {
    return false;
  }
}

export function assertBrowserMutationOrigin(request: FastifyRequest, config: Config): void {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
  const origin = singleHeader(request.headers.origin);
  if (!browserOriginAllowed(origin, config)) {
    throw new HttpError(403, "origin_denied", "Request origin is not allowed");
  }
}

export async function isWebSessionActive(
  pool: Pool,
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM web_sessions
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [sessionId, userId],
  );
  return result.rowCount === 1;
}

export async function loginLocal(
  pool: Pool,
  config: Config,
  email: string,
  password: string,
  reply: FastifyReply,
): Promise<UserSummary> {
  if (config.authMode !== "local") {
    throw new HttpError(404, "local_auth_disabled", "Local authentication is disabled");
  }
  const result = await pool.query<{
    user_id: string;
    email: string;
    display_name: string;
    password_salt: string;
    password_hash: string;
  }>(
    `
      SELECT u.id AS user_id, u.email, u.display_name,
             c.password_salt, c.password_hash
      FROM app_users u
      JOIN local_credentials c ON c.user_id = u.id
      WHERE lower(u.email) = lower($1)
    `,
    [email.trim()],
  );
  const row = result.rows[0];
  const supplied = hashLocalPassword(password, row?.password_salt ?? "invalid-salt");
  const expected = row?.password_hash ?? "0".repeat(supplied.length);
  if (!constantTimeHexEqual(supplied, expected) || row === undefined) {
    throw new HttpError(401, "invalid_credentials", "Email or password is incorrect");
  }

  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO web_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '12 hours')`,
    [row.user_id, sessionTokenHash(token, config.sessionSecret)],
  );
  reply.setCookie(cookieName, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.webOrigin.startsWith("https://"),
    path: config.cookiePath,
    maxAge: 12 * 60 * 60,
  });
  return { id: row.user_id, email: row.email, name: row.display_name };
}

export async function logout(
  request: FastifyRequest,
  reply: FastifyReply,
  pool: Pool,
  config: Config,
): Promise<void> {
  const token = request.cookies[cookieName];
  if (token !== undefined) {
    await pool.query(
      "UPDATE web_sessions SET revoked_at = now() WHERE token_hash = $1",
      [sessionTokenHash(token, config.sessionSecret)],
    );
  }
  reply.clearCookie(cookieName, {
    path: config.cookiePath,
    secure: config.webOrigin.startsWith("https://"),
  });
}

function sessionTokenHash(token: string, secret: string): string {
  return createHash("sha256").update(secret).update("\0").update(token).digest("hex");
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
  );
}
