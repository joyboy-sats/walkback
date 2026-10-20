/**
 * Forward a write to the Coolify API and attach the shared secret.
 *
 * This is the only server code the Vercel app runs for a write. It does not
 * import the database, Walrus, or `lib/env.ts` — those modules require
 * provider keys that exist only on Coolify. The secret is read from
 * `API_SHARED_SECRET` and is never sent to the browser.
 */
import { NextResponse } from "next/server";

export async function proxyWrite(path: string, req: Request): Promise<NextResponse> {
  const base = process.env.NEXT_PUBLIC_API_URL;
  const secret = process.env.API_SHARED_SECRET;
  if (!base || !secret) {
    return NextResponse.json(
      {
        error: "API is not configured",
        detail: "Set NEXT_PUBLIC_API_URL and API_SHARED_SECRET on the Vercel server.",
      },
      { status: 500 },
    );
  }

  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: await req.text(),
  });

  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
