// World History Timeline — sync Edge Function.
//
// The app calls this with the *publishable* key (safe to ship) and a secret
// timeline id in the body. All DB access goes through ctx.supabaseAdmin (the
// secret key, server-side only), so the `private_timeline` table stays locked
// to the client. Access is gated by knowing the unguessable timeline id.
import { withSupabase } from "npm:@supabase/server";

const TABLE = "private_timeline";

export default {
  fetch: withSupabase({ auth: "publishable" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return Response.json({ error: "POST only" }, { status: 405 });
    }

    let body: { action?: string; id?: string; data?: unknown };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }

    const { action, id, data } = body ?? {};
    if (typeof id !== "string" || id.length < 8) {
      return Response.json({ error: "missing id" }, { status: 400 });
    }

    if (action === "load") {
      const { data: row, error } = await ctx.supabaseAdmin
        .from(TABLE)
        .select("data")
        .eq("id", id)
        .maybeSingle();
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json(row?.data ?? null);
    }

    if (action === "save") {
      if (!data || typeof data !== "object") {
        return Response.json({ error: "missing data" }, { status: 400 });
      }
      const { error } = await ctx.supabaseAdmin.from(TABLE).upsert({
        id,
        data,
        updated_at: new Date().toISOString(),
      });
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ ok: true });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  }),
};
