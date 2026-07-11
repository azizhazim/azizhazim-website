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

function percent(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
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

function scrollBucket(percentValue) {
  const value = Number(percentValue || 0);
  if (value >= 100) return "100%";
  if (value >= 75) return "75-99%";
  if (value >= 50) return "50-74%";
  if (value >= 25) return "25-49%";
  return "0-24%";
}

function createDayBucket(date) {
  return {
    date,
    pageViews: 0,
    uniqueVisitors: 0,
    sessions: 0,
    outboundClicks: 0,
    ctaClicks: 0,
    contactClicks: 0,
    formStarts: 0,
    formSubmits: 0,
    sectionViews: 0,
    activeSeconds: 0,
    visitorSet: new Set(),
    sessionSet: new Set(),
    engagedSessionSet: new Set(),
  };
}

function finalizeDay(bucket) {
  return {
    date: bucket.date,
    pageViews: bucket.pageViews,
    uniqueVisitors: bucket.visitorSet.size,
    sessions: bucket.sessionSet.size,
    engagedSessions: bucket.engagedSessionSet.size,
    outboundClicks: bucket.outboundClicks,
    ctaClicks: bucket.ctaClicks,
    contactClicks: bucket.contactClicks,
    formStarts: bucket.formStarts,
    formSubmits: bucket.formSubmits,
    sectionViews: bucket.sectionViews,
    activeSeconds: bucket.activeSeconds,
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

function sessionRecord(sessionId) {
  return {
    id: sessionId,
    pageViews: 0,
    events: 0,
    activeSeconds: 0,
    durationSeconds: 0,
    maxScrollPercent: 0,
    sectionsSeen: 0,
    ctaClicks: 0,
    outboundClicks: 0,
    contactClicks: 0,
    formStarts: 0,
    formSubmits: 0,
    isReturning: false,
    day: "",
  };
}

function aggregate(events, dates) {
  const buckets = new Map(dates.map((date) => [date, createDayBucket(date)]));
  const visitors = new Set();
  const returningVisitors = new Set();
  const sessions = new Map();
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
  const ctaClicks = new Map();
  const contactClicks = new Map();
  const linkCategories = new Map();
  const clickLocations = new Map();
  const sections = new Map();
  const forms = new Map();
  const eventTypes = new Map();
  const pageEngagement = new Map();

  let pageViews = 0;
  let clickCount = 0;
  let ctaClickCount = 0;
  let contactClickCount = 0;
  let formStarts = 0;
  let formSubmits = 0;
  let sectionViews = 0;
  let engagementEvents = 0;

  for (const event of events) {
    const date = String(event.ts || "").slice(0, 10);
    const bucket = buckets.get(date) || createDayBucket(date);
    buckets.set(date, bucket);

    const sessionId = event.sessionId || event.visitorId || event.id;
    const session = sessions.get(sessionId) || sessionRecord(sessionId);
    session.events += 1;
    session.day = session.day || date;
    session.isReturning = session.isReturning || Boolean(event.visit?.isReturning);
    sessions.set(sessionId, session);

    if (event.visitorId) {
      visitors.add(event.visitorId);
      bucket.visitorSet.add(event.visitorId);
      if (event.visit?.isReturning) returningVisitors.add(event.visitorId);
    }

    if (event.sessionId) {
      bucket.sessionSet.add(event.sessionId);
    }

    increment(eventTypes, event.event);
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

    if (event.event === "pageview") {
      pageViews += 1;
      bucket.pageViews += 1;
      session.pageViews += 1;
      increment(pages, event.page || "/");
      increment(referrers, referrerLabel(event.referrer));
    }

    if (event.event === "outbound_click") {
      clickCount += 1;
      bucket.outboundClicks += 1;
      session.outboundClicks += 1;
      increment(outboundClicks, event.targetUrl || event.targetText || "Unknown");
      increment(linkCategories, event.linkCategory || "Outbound");
      increment(clickLocations, event.linkLocation || "Unknown");
    }

    if (event.event === "cta_click") {
      ctaClickCount += 1;
      bucket.ctaClicks += 1;
      session.ctaClicks += 1;
      increment(ctaClicks, event.targetText || event.targetUrl || "Unknown");
      increment(linkCategories, event.linkCategory || "CTA");
      increment(clickLocations, event.linkLocation || "Unknown");
    }

    if (event.event === "contact_click") {
      contactClickCount += 1;
      bucket.contactClicks += 1;
      session.contactClicks += 1;
      increment(contactClicks, event.targetText || event.targetUrl || "Unknown");
      increment(linkCategories, event.linkCategory || "Contact");
      increment(clickLocations, event.linkLocation || "Unknown");
    }

    if (event.event === "section_view") {
      sectionViews += 1;
      bucket.sectionViews += 1;
      session.sectionsSeen = Math.max(session.sectionsSeen, Number(event.sectionIndex || 0));
      increment(sections, event.sectionTitle || event.sectionId || "Unknown section");
    }

    if (event.event === "form_start") {
      formStarts += 1;
      bucket.formStarts += 1;
      session.formStarts += 1;
      increment(forms, `${event.formName || "Form"} started`);
    }

    if (event.event === "form_submit") {
      formSubmits += 1;
      bucket.formSubmits += 1;
      session.formSubmits += 1;
      increment(forms, `${event.formName || "Form"} submitted`);
    }

    if (event.event === "engagement" && event.engagement) {
      engagementEvents += 1;
      const active = Number(event.engagement.activeSeconds || 0);
      const duration = Number(event.engagement.durationSeconds || 0);
      const scroll = Number(event.engagement.maxScrollPercent || 0);
      session.activeSeconds = Math.max(session.activeSeconds, active);
      session.durationSeconds = Math.max(session.durationSeconds, duration);
      session.maxScrollPercent = Math.max(session.maxScrollPercent, scroll);
      session.sectionsSeen = Math.max(session.sectionsSeen, Number(event.engagement.sectionsSeen || 0));
      session.ctaClicks = Math.max(session.ctaClicks, Number(event.engagement.ctaClicks || 0), session.ctaClicks);
      session.outboundClicks = Math.max(session.outboundClicks, Number(event.engagement.outboundClicks || 0), session.outboundClicks);
      session.contactClicks = Math.max(session.contactClicks, Number(event.engagement.contactClicks || 0), session.contactClicks);
      session.formStarts = Math.max(session.formStarts, Number(event.engagement.formStarts || 0), session.formStarts);
      session.formSubmits = Math.max(session.formSubmits, Number(event.engagement.formSubmits || 0), session.formSubmits);

      const pageKey = `${sessionId}|${event.page || "/"}`;
      const pageStats = pageEngagement.get(pageKey) || {
        page: event.page || "/",
        activeSeconds: 0,
        maxScrollPercent: 0,
      };
      pageStats.activeSeconds = Math.max(pageStats.activeSeconds, active);
      pageStats.maxScrollPercent = Math.max(pageStats.maxScrollPercent, scroll);
      pageEngagement.set(pageKey, pageStats);
    }
  }

  for (const session of sessions.values()) {
    const bucket = buckets.get(session.day);
    const engaged =
      session.activeSeconds >= 10 ||
      session.maxScrollPercent >= 50 ||
      session.ctaClicks > 0 ||
      session.outboundClicks > 0 ||
      session.contactClicks > 0 ||
      session.formSubmits > 0;

    if (bucket) {
      bucket.activeSeconds += session.activeSeconds;
      if (engaged) bucket.engagedSessionSet.add(session.id);
    }
  }

  const sessionList = [...sessions.values()];
  const sessionsWithEngagement = sessionList.filter((session) => session.activeSeconds > 0 || session.maxScrollPercent > 0);
  const engagedSessions = sessionList.filter((session) =>
    session.activeSeconds >= 10 ||
    session.maxScrollPercent >= 50 ||
    session.ctaClicks > 0 ||
    session.outboundClicks > 0 ||
    session.contactClicks > 0 ||
    session.formSubmits > 0
  );
  const bounceSessions = sessionList.filter((session) =>
    session.pageViews <= 1 &&
    session.activeSeconds < 10 &&
    session.maxScrollPercent < 50 &&
    session.ctaClicks === 0 &&
    session.outboundClicks === 0 &&
    session.contactClicks === 0 &&
    session.formSubmits === 0
  );

  const scrollDepth = new Map();
  for (const session of sessionList) {
    increment(scrollDepth, scrollBucket(session.maxScrollPercent));
  }

  const engagedPages = new Map();
  for (const item of pageEngagement.values()) {
    increment(engagedPages, item.page, item.activeSeconds);
  }

  const totalActiveSeconds = sessionList.reduce((sum, session) => sum + session.activeSeconds, 0);
  const totalScroll = sessionsWithEngagement.reduce((sum, session) => sum + session.maxScrollPercent, 0);
  const contactIntentSessions = sessionList.filter((session) => session.contactClicks > 0 || session.formSubmits > 0);

  const recent = [...events]
    .reverse()
    .slice(0, 75)
    .map((event) => ({
      ts: event.ts,
      event: event.event,
      page: event.page,
      referrer: event.referrer || "",
      targetUrl: event.targetUrl || "",
      targetText: event.targetText || "",
      linkCategory: event.linkCategory || "",
      linkLocation: event.linkLocation || "",
      sectionTitle: event.sectionTitle || "",
      formName: event.formName || "",
      activeSeconds: event.engagement?.activeSeconds || 0,
      maxScrollPercent: event.engagement?.maxScrollPercent || 0,
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
      returningVisitors: returningVisitors.size,
      sessions: sessions.size,
      engagedSessions: engagedSessions.length,
      bounceRate: percent(bounceSessions.length, sessions.size),
      contactIntentRate: percent(contactIntentSessions.length, sessions.size),
      outboundClicks: clickCount,
      ctaClicks: ctaClickCount,
      contactClicks: contactClickCount,
      formStarts,
      formSubmits,
      sectionViews,
      engagementEvents,
      avgActiveSeconds: sessionsWithEngagement.length ? round(totalActiveSeconds / sessionsWithEngagement.length, 1) : 0,
      avgScrollDepth: sessionsWithEngagement.length ? round(totalScroll / sessionsWithEngagement.length, 1) : 0,
      events: events.length,
    },
    series: [...buckets.values()].map(finalizeDay),
    tables: {
      eventTypes: top(eventTypes, 12),
      pages: top(pages, 12),
      engagedPages: top(engagedPages, 12),
      referrers: top(referrers, 12),
      countries: top(countries, 12),
      cities: top(cities, 12),
      browsers: top(browsers, 8),
      operatingSystems: top(operatingSystems, 8),
      devices: top(devices, 8),
      languages: top(languages, 8),
      timezones: top(timezones, 8),
      screenSizes: top(screenSizes, 8),
      scrollDepth: top(scrollDepth, 8),
      sections: top(sections, 12),
      ctaClicks: top(ctaClicks, 12),
      contactClicks: top(contactClicks, 12),
      outboundClicks: top(outboundClicks, 12),
      linkCategories: top(linkCategories, 10),
      clickLocations: top(clickLocations, 10),
      forms: top(forms, 10),
      utmSources: top(utmSources, 8),
      utmCampaigns: top(utmCampaigns, 8),
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
