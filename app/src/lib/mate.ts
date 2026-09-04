import {
  AdaptersResponseSchema,
  PostCommandResponseSchema,
  StateResponseSchema,
  type AdaptersResponse,
  type ExternalCommand,
  type PostCommandResponse,
  type StateResponse,
} from "@aibleton/protocol";
import type { ZodType, ZodTypeDef } from "zod";

/** Base URL of the mate service; configurable through NEXT_PUBLIC_MATE_URL. */
export function mateUrl(path = ""): string {
  const base = (process.env.NEXT_PUBLIC_MATE_URL ?? "http://localhost:4545").replace(/\/$/, "");
  return `${base}${path}`;
}

async function request<T>(path: string, schema: ZodType<T, ZodTypeDef, unknown>, init?: RequestInit): Promise<T> {
  const res = await fetch(mateUrl(path), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`mate ${init?.method ?? "GET"} ${path} -> ${res.status}${body ? `: ${body}` : ""}`);
  }
  return schema.parse(await res.json());
}

export function getState(): Promise<StateResponse> {
  return request("/state", StateResponseSchema);
}

export function getAdapters(): Promise<AdaptersResponse> {
  return request("/adapters", AdaptersResponseSchema);
}

export function postCommand(command: ExternalCommand): Promise<PostCommandResponse> {
  return request("/commands", PostCommandResponseSchema, {
    method: "POST",
    body: JSON.stringify({ command }),
  });
}
