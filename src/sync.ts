import type { TimelineEvent } from "./types";

// Supabase config is baked in at build time from .env (VITE_* vars). When any
// is missing, sync is disabled and the app stays purely local.
//
// Only the *publishable* key ships in the app. The app talks to the `timeline`
// Edge Function, which uses the secret key server-side; the secret key is never
// present in this bundle.
const env = import.meta.env as Record<string, string | undefined>;
const SUPABASE_URL = env.VITE_SUPABASE_URL;
const PUBLISHABLE_KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const TIMELINE_ID = env.VITE_TIMELINE_ID;

export const syncEnabled = Boolean(
  SUPABASE_URL && PUBLISHABLE_KEY && TIMELINE_ID,
);

const FUNCTION_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/functions/v1/timeline`
  : "";

export interface Snapshot {
  events: TimelineEvent[];
  updatedAt: number;
}

async function callFunction(
  action: "load" | "save",
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: PUBLISHABLE_KEY as string,
      Authorization: `Bearer ${PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ action, id: TIMELINE_ID, ...extra }),
  });
  if (!res.ok) {
    throw new Error(`sync ${action} failed: ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Fetch the remote snapshot, or null if none exists / sync disabled. */
export async function pullRemote(): Promise<Snapshot | null> {
  if (!syncEnabled) return null;
  const data = (await callFunction("load")) as
    | { events?: unknown; updatedAt?: unknown }
    | null;
  if (!data || !Array.isArray(data.events)) return null;
  return {
    events: data.events as TimelineEvent[],
    updatedAt: Number(data.updatedAt) || 0,
  };
}

/** Upsert the local snapshot to the remote store. */
export async function pushRemote(snap: Snapshot): Promise<void> {
  if (!syncEnabled) return;
  await callFunction("save", { data: snap });
}
