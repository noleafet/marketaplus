/** Browser requests hit this same-origin prefix; next.config.ts forwards it to the API. */
export const API = "/api/proxy";

export async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Turn a DRF validation payload into a short sentence instead of raw JSON.
 */
export function readableError(reason: unknown, fallback: string) {
  if (!(reason instanceof Error)) return fallback;
  const text = reason.message;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const messages = Object.entries(parsed)
      .flatMap(([field, value]) => {
        const label = field === "detail" ? "" : `${field.replace(/_/g, " ")}: `;
        const items = Array.isArray(value) ? value : [value];
        return items
          .map((item) => String(item).trim())
          .filter(Boolean)
          .map((item) => `${label}${item.replace(/\.?$/, ".")}`);
      })
      .filter(Boolean);
    if (messages.length) return messages.join(" · ");
  } catch {
    /* The API answered with plain text. */
  }
  return text || fallback;
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = "";
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length) {
        message = JSON.stringify(parsed);
      }
    } catch {
      const trimmed = text.trim();
      if (trimmed && trimmed.length <= 200 && !trimmed.startsWith("<")) message = trimmed;
    }
    throw new Error(message || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/**
 * The API answers with a backend path such as /api/pattern-shots/1/image/, which the browser
 * can only reach through the same-origin proxy prefix, so the /api part is swapped out.
 */
export const proxied = (path: string) => `${API}${path.replace(/^\/api/, "")}`;
