import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const STORE_NAME = "site-analytics";
const MAX_DAYS = 180;

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

function isAuthorized(request) {
  const expected = process.env.ANALYTICS_ADMIN_TOKEN;
  if (!expected) return false;

  const supplied =
    request.headers.get("x-analytics-token") ||
    new URL(request.url).searchParams.get("token") ||
    "";

  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function daysBack(days) {
  const dates = [];
  const now = new Date();
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    date.setUTCDate(date.getUTCDate() - index);
    dates.push(dayKey(date));
  }
  return dates;
}

function increment(map, key, amount = 1) {
  const label = key || "Unknown";
  map.set(label, (map.get(label) || 0) + amount);
}

function top(map, limit = 10) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

function screenLabel(screen = {}) {
  const width = Number(screen.width || screen.viewportWidth || 0);
  if (!width) return "Unknown";
  if (width < 768) return "Mobile width";
  if (width < 1100) return "Tablet width";
  return "Desktop width";
}

function referrerLabel(referrer) {
  if (!referrer) return "Direct / unknown";
  return referrer;
}

function createDayBucket(date) {
  return {
    date,
    pageViews: 0,
    uniqueVisitors: 0,
    sessions: 0,
    outboundClicks: 0,
    visitorSet: new Set(),
    sessionSet: new Set(),
  };
}

function finalizeDay(bucket) {
  return {
    date: bucket.date,
    pageViews: bucket.pageViews,
    uniqueVisitors: bucket.visitorSet.size,
    sessions: bucket.sessionSet.size,
    outboundClicks: bucket.outboundClicks,
  };
}

async function readEvents(store, dates) {
  const events = [];
  for (const date of dates) {
    const { blobs } = await store.list({ prefix: `events/${date}/` });
    const entries = await Promise.all(
      blobs.map(async (blob) => {
        try {
          return await store.get(blob.key, { type: "json" });
        } catch (error) {
          console.error("analytics-report failed reading blob", blob.key, error);
          return null;
        }
      })
    );
    events.push(...entries.filter(Boolean));
  }
  return events.sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

function aggregate(events, dates) {
  const buckets = new Map(dates.map((date) => [date, createDayBucket(date)]));
  const visitors = new Set();
  const sessions = new Set();
  const pages = new Map();
  const referrers = new Map();
  const countries = new Map();
  const cities = new Map();
  const browsers = new Map();
  const operatingSystems = new Map();
  const devices = new Map();
  const languages = new Map();
  const timezones = new Map();
  const screenSizes = new Map();
  const utmSources = new Map();
  const utmCampaigns = new Map();
  const outboundClicks = new Map();

  let pageViews = 0;
  let clickCount = 0;

  for (const event of events) {
    const date = String(event.ts || "").slice(0, 10);
    const bucket = buckets.get(date) || createDayBucket(date);
    buckets.set(date, bucket);

    if (event.visitorId) {
      visitors.add(event.visitorId);
      bucket.visitorSet.add(event.visitorId);
    }

    if (event.sessionId) {
      sessions.add(event.sessionId);
      bucket.sessionSet.add(event.sessionId);
    }

    increment(countries, event.geo?.country || "Unknown");
    increment(cities, event.geo?.city || "Unknown");
    increment(browsers, event.client?.browser || "Unknown");
    increment(operatingSystems, event.client?.os || "Unknown");
    increment(devices, event.client?.device || "Unknown");
    increment(languages, event.language || "Unknown");
    increment(timezones, event.timezone || event.geo?.timezone || "Unknown");
    increment(screenSizes, screenLabel(event.screen));

    if (event.campaign?.source) increment(utmSources, event.campaign.source);
    if (event.campaign?.campaign) increment(utmCampaigns, event.campaign.campaign);

    if (event.event === "outbound_click") {
      clickCount += 1;
      bucket.outboundClicks += 1;
      increment(outboundClicks, event.targetUrl || event.targetText || "Unknown");
      continue;
    }

    pageViews += 1;
    bucket.pageViews += 1;
    increment(pages, event.page || "/");
    increment(referrers, referrerLabel(event.referrer));
  }

  const recent = [...events]
    .reverse()
    .slice(0, 50)
    .map((event) => ({
      ts: event.ts,
      event: event.event,
      page: event.page,
      referrer: event.referrer || "",
      targetUrl: event.targetUrl || "",
      country: event.geo?.country || "",
      city: event.geo?.city || "",
      device: event.client?.device || "",
      browser: event.client?.browser || "",
      os: event.client?.os || "",
    }));

  return {
    totals: {
      pageViews,
      uniqueVisitors: visitors.size,
      sessions: sessions.size,
      outboundClicks: clickCount,
      events: events.length,
    },
    series: [...buckets.values()].map(finalizeDay),
    tables: {
      pages: top(pages, 12),
      referrers: top(referrers, 12),
      countries: top(countries, 12),
      cities: top(cities, 12),
      browsers: top(browsers, 8),
      operatingSystems: top(operatingSystems, 8),
      devices: top(devices, 8),
      languages: top(languages, 8),
      timezones: top(timezones, 8),
      screenSizes: top(screenSizes, 8),
      utmSources: top(utmSources, 8),
      utmCampaigns: top(utmCampaigns, 8),
      outboundClicks: top(outboundClicks, 12),
    },
    recent,
  };
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!process.env.ANALYTICS_ADMIN_TOKEN) {
    return json({
      error: "Analytics dashboard is not configured",
      setup: "Set ANALYTICS_ADMIN_TOKEN in Netlify environment variables with Functions scope.",
    }, 503);
  }

  if (!isAuthorized(request)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") || 30), 1), MAX_DAYS);
  const dates = daysBack(days);

  try {
    const store = getStore(STORE_NAME);
    const events = await readEvents(store, dates);
    return json({
      generatedAt: new Date().toISOString(),
      range: {
        days,
        from: dates[0],
        to: dates[dates.length - 1],
      },
      privacy: "Raw IP addresses are not stored. Visitor IDs are one-way hashes generated in the Netlify Function.",
      ...aggregate(events, dates),
    });
  } catch (error) {
    console.error("analytics-report failed", error);
    return json({ error: "Analytics report unavailable" }, 500);
  }
};

export const config = {
  path: "/api/analytics/report",
};

