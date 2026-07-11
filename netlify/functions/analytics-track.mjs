import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const STORE_NAME = "site-analytics";
const MAX_BODY_BYTES = 8192;
const ALLOWED_EVENTS = new Set(["pageview", "outbound_click"]);

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders,
  });
}

function clampString(value, max = 240) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function getClientIp(headers) {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return (
    headers.get("x-nf-client-connection-ip") ||
    headers.get("client-ip") ||
    headers.get("x-real-ip") ||
    ""
  );
}

function hashVisitor(ip, userAgent) {
  const salt = process.env.ANALYTICS_SALT || process.env.SITE_ID || "azizhazim.com";
  return crypto
    .createHash("sha256")
    .update(`${salt}|${ip}|${userAgent}`)
    .digest("hex")
    .slice(0, 32);
}

function parseUserAgent(userAgent) {
  const ua = userAgent.toLowerCase();
  const browser = ua.includes("edg/")
    ? "Edge"
    : ua.includes("opr/") || ua.includes("opera")
      ? "Opera"
      : ua.includes("chrome") || ua.includes("crios")
        ? "Chrome"
        : ua.includes("safari") && !ua.includes("chrome")
          ? "Safari"
          : ua.includes("firefox") || ua.includes("fxios")
            ? "Firefox"
            : "Other";

  const os = ua.includes("iphone") || ua.includes("ipad")
    ? "iOS"
    : ua.includes("android")
      ? "Android"
      : ua.includes("windows")
        ? "Windows"
        : ua.includes("mac os") || ua.includes("macintosh")
          ? "macOS"
          : ua.includes("linux")
            ? "Linux"
            : "Other";

  const device = /mobile|iphone|ipod|android.*mobile/.test(ua)
    ? "Mobile"
    : /ipad|tablet|android/.test(ua)
      ? "Tablet"
      : "Desktop";

  return { browser, os, device };
}

function normalizePath(value) {
  const path = clampString(value, 500) || "/";
  if (!path.startsWith("/")) return "/";
  return path;
}

function normalizeReferrer(value) {
  const referrer = clampString(value, 500);
  if (!referrer) return "";
  try {
    const url = new URL(referrer);
    if (url.hostname === "azizhazim.com" || url.hostname.endsWith(".azizhazim.com")) {
      return "Internal";
    }
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return referrer;
  }
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getGeo(context) {
  const geo = context.geo || {};
  return {
    city: clampString(geo.city || "", 120) || null,
    country: clampString(geo.country?.name || geo.country?.code || "", 120) || null,
    region: clampString(geo.subdivision?.name || geo.region?.name || "", 120) || null,
    timezone: clampString(geo.timezone || "", 120) || null,
  };
}

function sanitizeCampaign(utm = {}) {
  return {
    source: clampString(utm.source, 120),
    medium: clampString(utm.medium, 120),
    campaign: clampString(utm.campaign, 160),
    term: clampString(utm.term, 160),
    content: clampString(utm.content, 160),
  };
}

function sanitizeScreen(screen = {}) {
  return {
    width: normalizeNumber(screen.width),
    height: normalizeNumber(screen.height),
    viewportWidth: normalizeNumber(screen.viewportWidth),
    viewportHeight: normalizeNumber(screen.viewportHeight),
    pixelRatio: normalizeNumber(screen.pixelRatio, 1),
  };
}

function eventKey(date, id) {
  return `events/${date}/${id}.json`;
}

export default async (request, context) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: "Payload too large" }, 413);
  }

  let payload;
  try {
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) {
      return json({ error: "Payload too large" }, 413);
    }
    payload = JSON.parse(body || "{}");
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const eventType = ALLOWED_EVENTS.has(payload.event) ? payload.event : "pageview";
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const userAgent = request.headers.get("user-agent") || "";
  const ip = getClientIp(request.headers);
  const client = parseUserAgent(userAgent);
  const visitorId = hashVisitor(ip, userAgent);
  const id = `${now.toISOString()}-${crypto.randomUUID()}`;

  const event = {
    id,
    event: eventType,
    ts: now.toISOString(),
    page: normalizePath(payload.page),
    title: clampString(payload.title, 180),
    referrer: normalizeReferrer(payload.referrer),
    sessionId: clampString(payload.sessionId, 80),
    visitorId,
    client,
    geo: getGeo(context),
    language: clampString(payload.language, 80),
    timezone: clampString(payload.timezone, 120),
    colorScheme: payload.colorScheme === "dark" ? "dark" : "light",
    connection: clampString(payload.connection, 80),
    screen: sanitizeScreen(payload.screen),
    campaign: sanitizeCampaign(payload.utm),
    targetUrl: eventType === "outbound_click" ? clampString(payload.targetUrl, 500) : "",
    targetText: eventType === "outbound_click" ? clampString(payload.targetText, 160) : "",
  };

  try {
    const store = getStore(STORE_NAME);
    await store.setJSON(eventKey(date, id), event, {
      metadata: {
        event: event.event,
        date,
      },
    });
  } catch (error) {
    console.error("analytics-track failed", error);
    return json({ error: "Analytics unavailable" }, 500);
  }

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
};

export const config = {
  path: "/api/analytics/track",
};

