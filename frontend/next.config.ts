import type { NextConfig } from "next";

/** Browser requests hit this same-origin prefix; the rewrite below forwards them to the API. */
const proxyPrefix = "/api/proxy";
const fallbackBackend = "http://localhost:8000";

/**
 * The rewrite destination is frozen into the build, so the backend URL must be a build-time value.
 * Docker passes it as the `BACKEND_URL` build argument (see frontend/Dockerfile and docker-compose.yml);
 * `NEXT_PUBLIC_API_URL` is still accepted so images built with the older variable keep working.
 * A missing, malformed, or non-HTTP value falls back to the local default instead of emitting a
 * rewrite that points at the frontend container itself.
 */
function backendBase(): string {
  const raw = (process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL ?? fallbackBackend).trim();
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return fallbackBackend;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return fallbackBackend;
  // Older setups passed a full API base such as https://host/api; the rewrite appends /api itself.
  const path = target.pathname.replace(/\/api\/?$/, "").replace(/\/+$/, "");
  return `${target.origin}${path}`;
}

const nextConfig: NextConfig = {
  output: "standalone",
  skipTrailingSlashRedirect: true,
  async rewrites() {
    const apiTarget = `${backendBase()}/api`;
    return [
      {
        source: `${proxyPrefix}/:path*`,
        destination: `${apiTarget}/:path*/`,
      },
      {
        source: "/api/:path*",
        destination: `${apiTarget}/:path*/`,
      },
    ];
  },
};

export default nextConfig;
