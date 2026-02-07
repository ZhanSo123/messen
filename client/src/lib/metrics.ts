"use client";

export type MetricEventName = "silent_enabled" | "silent_disabled";

export async function trackMetric(opts: { apiBase: string; token: string; name: MetricEventName }) {
  try {
    await fetch(`${opts.apiBase}/metrics/event`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: opts.name })
    });
  } catch {
    // Best-effort only.
  }
}

