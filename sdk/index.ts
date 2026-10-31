import { createClient, type Config } from "./generated/client/index.js";
export * as BlyggerApi from "./generated/sdk.gen.js";
export type * from "./generated/types.gen.js";
export type BlyggerClient = ReturnType<typeof createClient>;
export type BlyggerClientOptions = Config;

/** Each server request should create its own client to keep credentials isolated. */
export const createBlyggerClient = (options: Config = {}) => createClient({ credentials: "same-origin", ...options });

export class BlyggerApiError extends Error {
  constructor(readonly statusCode: number, readonly body: unknown) {
    super(typeof body === "object" && body !== null && "message" in body ? String(body.message) : `API request failed (${statusCode})`);
    this.name = "BlyggerApiError";
  }
}

/** Optional throwing interface; generated methods also expose typed data/error/response fields. */
export async function unwrap<T>(pending: Promise<{ data?: T; error?: unknown; response?: Response }>): Promise<T> {
  const result = await pending;
  if (!result.response) throw result.error;
  if (!result.response.ok) throw new BlyggerApiError(result.response.status, result.error);
  return result.data as T;
}
