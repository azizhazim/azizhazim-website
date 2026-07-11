(function () {
  var endpoint = "/api/analytics/track";
  var sessionKey = "azizhazim.analytics.session";
  var timeoutMs = 30 * 60 * 1000;

  if (location.protocol === "file:" || location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return;
  }

  if (navigator.doNotTrack === "1" || window.doNotTrack === "1") {
    return;
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
  }

  function getSessionId() {
    var now = Date.now();
    try {
      var stored = JSON.parse(sessionStorage.getItem(sessionKey) || "null");
      if (stored && stored.id && now - stored.updatedAt < timeoutMs) {
        stored.updatedAt = now;
        sessionStorage.setItem(sessionKey, JSON.stringify(stored));
        return stored.id;
      }
      var next = { id: uuid(), updatedAt: now };
      sessionStorage.setItem(sessionKey, JSON.stringify(next));
      return next.id;
    } catch (_error) {
      return uuid();
    }
  }

  function getUtm() {
    var params = new URLSearchParams(location.search);
    return {
      source: params.get("utm_source") || "",
      medium: params.get("utm_medium") || "",
      campaign: params.get("utm_campaign") || "",
      term: params.get("utm_term") || "",
      content: params.get("utm_content") || "",
    };
  }

  function basePayload(eventName) {
    return {
      event: eventName,
      page: location.pathname + location.search,
      title: document.title,
      referrer: document.referrer,
      sessionId: getSessionId(),
      language: navigator.language || "",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      colorScheme: window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      connection: navigator.connection ? navigator.connection.effectiveType || "" : "",
      screen: {
        width: window.screen ? window.screen.width : 0,
        height: window.screen ? window.screen.height : 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        pixelRatio: window.devicePixelRatio || 1,
      },
      utm: getUtm(),
    };
  }

  function send(payload) {
    var body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      var blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(endpoint, blob)) return;
    }

    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body,
      keepalive: true,
    }).catch(function () {});
  }

  function trackPageView() {
    send(basePayload("pageview"));
  }

  function trackOutboundClick(event) {
    var link = event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;

    var href = link.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#") return;

    var url;
    try {
      url = new URL(href, location.href);
    } catch (_error) {
      return;
    }

    var isOutbound = url.hostname !== location.hostname || url.protocol === "mailto:" || url.protocol === "tel:";
    if (!isOutbound) return;

    var payload = basePayload("outbound_click");
    payload.targetUrl = url.href;
    payload.targetText = (link.textContent || link.getAttribute("aria-label") || "").trim().slice(0, 160);
    send(payload);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", trackPageView, { once: true });
  } else {
    trackPageView();
  }

  document.addEventListener("click", trackOutboundClick, { capture: true });
})();

