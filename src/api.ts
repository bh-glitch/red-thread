export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    let detail = "The line went quiet. Please try again.";
    try {
      const data = await response.json();
      detail = typeof data.detail === "string" ? data.detail : detail;
    } catch {
      /* Non-JSON proxy failure. */
    }
    throw new Error(detail);
  }
  return response.json();
}
export async function stream(
  path: string,
  body: unknown,
  onEvent: (kind: string, data: any) => void,
  signal?: AbortSignal,
) {
  const response = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.detail || "Connection interrupted.");
  }
  if (!response.body) throw new Error("This browser cannot stream replies.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const packet = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const kind = packet
        .split("\n")
        .find((l) => l.startsWith("event: "))
        ?.slice(7);
      const data = packet
        .split("\n")
        .find((l) => l.startsWith("data: "))
        ?.slice(6);
      if (kind && data) onEvent(kind, JSON.parse(data));
    }
  }
}
