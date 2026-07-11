(function () {
  var endpoint = "/api/analytics/track";
  var sessionKey = "azizhazim.analytics.session";
  var visitKey = "azizhazim.analytics.visit";
  var timeoutMs = 30 * 60 * 1000;
  var startedAt = Date.now();
  var activeSeconds = 0;
  var lastSentActiveSeconds = -1;
  var maxScrollPercent = 0;
  var maxScrollPx = 0;
  var sectionsSeen = {};
  var counters = {
    ctaClicks: 0,
    contactClicks: 0,
    outboundClicks: 0,
    formStarts: 0,
    formSubmits: 0,
  };

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

  function getVisitState() {
    var now = new Date().toISOString();
    try {
      var stored = JSON.parse(localStorage.getItem(visitKey) || "null");
      if (stored && stored.firstSeen) {
        stored.lastSeen = now;
        stored.visitCount = Number(stored.visitCount || 0) + 1;
        stored.isReturning = true;
        localStorage.setItem(visitKey, JSON.stringify(stored));
        return stored;
      }

      var next = {
        firstSeen: now,
        lastSeen: now,
        visitCount: 1,
        isReturning: false,
      };
      localStorage.setItem(visitKey, JSON.stringify(next));
      return next;
    } catch (_error) {
      return {
        firstSeen: now,
        lastSeen: now,
        visitCount: 1,
        isReturning: false,
      };
    }
  }

  var sessionId = getSessionId();
  var visitState = getVisitState();

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

  function safeText(value, max) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, max || 160);
  }

  function basePayload(eventName) {
    return {
      event: eventName,
      page: location.pathname + location.search,
      title: document.title,
      referrer: document.referrer,
      sessionId: sessionId,
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
      visit: {
        firstSeen: visitState.firstSeen,
        visitCount: visitState.visitCount,
        isReturning: Boolean(visitState.isReturning),
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

  function updateScrollMetrics() {
    var doc = document.documentElement;
    var body = document.body;
    var scrollTop = window.scrollY || doc.scrollTop || body.scrollTop || 0;
    var viewport = window.innerHeight || doc.clientHeight || 0;
    var height = Math.max(body.scrollHeight, doc.scrollHeight, body.offsetHeight, doc.offsetHeight, viewport);
    var percent = height ? Math.round(Math.min(100, ((scrollTop + viewport) / height) * 100)) : 0;
    maxScrollPercent = Math.max(maxScrollPercent, percent);
    maxScrollPx = Math.max(maxScrollPx, Math.round(scrollTop + viewport));
  }

  function trackPageView() {
    updateScrollMetrics();
    send(basePayload("pageview"));
  }

  function getLinkLocation(link) {
    if (link.closest(".site-nav")) return "Navigation";
    if (link.closest(".hero")) return "Hero";
    if (link.closest(".source-strip")) return "Proof strip";
    if (link.closest(".case-study")) {
      var heading = link.closest(".case-study").querySelector("h3");
      return heading ? safeText(heading.textContent, 80) : "Case study";
    }
    if (link.closest("#builds")) return "Selected builds";
    if (link.closest("#services")) return "Services";
    if (link.closest("#about")) return "About";
    if (link.closest("#contact")) return "Contact";
    if (link.closest("footer")) return "Footer";
    return "Page";
  }

  function getLinkCategory(url) {
    if (url.protocol === "mailto:") return "Email";
    if (url.protocol === "tel:") return "Phone";
    if (url.hash && url.hostname === location.hostname && url.pathname === location.pathname) return "Anchor navigation";
    if (url.hostname.includes("apps.apple.com")) return "App Store";
    if (url.hostname.includes("chromewebstore.google.com")) return "Chrome Web Store";
    if (url.hostname.includes("github.com")) return "GitHub";
    if (url.hostname.includes("linkedin.com")) return "LinkedIn";
    if (url.hostname !== location.hostname) return "External site";
    return "Internal link";
  }

  function isTrackedCta(link) {
    return Boolean(
      link.closest(".hero-actions") ||
      link.closest(".source-strip") ||
      link.closest(".contact-links") ||
      link.matches(".btn, .nav-cta") ||
      link.closest(".nav-links")
    );
  }

  function linkPayload(eventName, link, url) {
    var payload = basePayload(eventName);
    payload.targetUrl = url.href;
    payload.targetText = safeText(link.textContent || link.getAttribute("aria-label"), 160);
    payload.linkCategory = getLinkCategory(url);
    payload.linkLocation = getLinkLocation(link);
    payload.isPrimaryCta = link.classList.contains("btn-primary") || link.classList.contains("nav-cta");
    return payload;
  }

  function trackLinkClick(event) {
    var link = event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;

    var href = link.getAttribute("href") || "";
    if (!href) return;

    var url;
    try {
      url = new URL(href, location.href);
    } catch (_error) {
      return;
    }

    var category = getLinkCategory(url);
    var isOutbound = url.hostname !== location.hostname || url.protocol === "mailto:" || url.protocol === "tel:";
    var trackedCta = isTrackedCta(link);

    if (trackedCta) {
      counters.ctaClicks += 1;
      send(linkPayload("cta_click", link, url));
    }

    if (category === "Email" || category === "Phone" || category === "LinkedIn") {
      counters.contactClicks += 1;
      send(linkPayload("contact_click", link, url));
      return;
    }

    if (isOutbound) {
      counters.outboundClicks += 1;
      send(linkPayload("outbound_click", link, url));
    }
  }

  function sectionTitle(section) {
    var heading = section.querySelector("h1, h2, h3");
    if (heading) return safeText(heading.textContent, 120);
    if (section.classList.contains("source-strip")) return "Public proof links";
    return section.id || "Unnamed section";
  }

  function trackSections() {
    if (!("IntersectionObserver" in window)) return;

    var sections = Array.from(document.querySelectorAll("section[id], .source-strip"));
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.35) return;

        var section = entry.target;
        var id = section.id || "proof-strip";
        if (sectionsSeen[id]) return;

        sectionsSeen[id] = true;
        var payload = basePayload("section_view");
        payload.sectionId = id;
        payload.sectionTitle = sectionTitle(section);
        payload.sectionIndex = sections.indexOf(section) + 1;
        send(payload);
      });
    }, { threshold: [0.35, 0.6] });

    sections.forEach(function (section) {
      observer.observe(section);
    });
  }

  function trackFormActivity() {
    var forms = Array.from(document.querySelectorAll("form"));
    forms.forEach(function (form) {
      var started = false;
      var formName = form.getAttribute("name") || form.getAttribute("id") || "form";

      form.addEventListener("input", function (event) {
        if (started) return;
        started = true;
        counters.formStarts += 1;
        var payload = basePayload("form_start");
        payload.formName = formName;
        payload.fieldName = event.target && event.target.name ? event.target.name : "";
        send(payload);
      }, { capture: true });

      form.addEventListener("submit", function () {
        counters.formSubmits += 1;
        var payload = basePayload("form_submit");
        payload.formName = formName;
        send(payload);
        sendEngagement("form_submit", true);
      });
    });
  }

  function engagementPayload(reason) {
    updateScrollMetrics();
    var payload = basePayload("engagement");
    payload.engagement = {
      reason: reason,
      durationSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      activeSeconds: activeSeconds,
      maxScrollPercent: maxScrollPercent,
      maxScrollPx: maxScrollPx,
      sectionsSeen: Object.keys(sectionsSeen).length,
      ctaClicks: counters.ctaClicks,
      contactClicks: counters.contactClicks,
      outboundClicks: counters.outboundClicks,
      formStarts: counters.formStarts,
      formSubmits: counters.formSubmits,
    };
    return payload;
  }

  function sendEngagement(reason, force) {
    if (!force && activeSeconds === lastSentActiveSeconds) return;
    if (!force && activeSeconds < 5 && maxScrollPercent < 50) return;
    lastSentActiveSeconds = activeSeconds;
    send(engagementPayload(reason));
  }

  var scrollTicking = false;
  window.addEventListener("scroll", function () {
    if (scrollTicking) return;
    scrollTicking = true;
    window.requestAnimationFrame(function () {
      updateScrollMetrics();
      scrollTicking = false;
    });
  }, { passive: true });

  setInterval(function () {
    if (!document.hidden) {
      activeSeconds += 1;
    }
  }, 1000);

  setTimeout(function () {
    sendEngagement("initial_engagement", false);
  }, 15000);

  setInterval(function () {
    sendEngagement("heartbeat", false);
  }, 30000);

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      sendEngagement("hidden", true);
    }
  });

  window.addEventListener("pagehide", function () {
    sendEngagement("pagehide", true);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      trackPageView();
      trackSections();
      trackFormActivity();
    }, { once: true });
  } else {
    trackPageView();
    trackSections();
    trackFormActivity();
  }

  document.addEventListener("click", trackLinkClick, { capture: true });
})();
