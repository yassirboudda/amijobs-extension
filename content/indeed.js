// AmiJobs — Indeed auto-apply content script (phase-based, v1.2.7)
(function () {
  const PLATFORM = "indeed";
  const VERSION = "1.6.3";
  const INDEED_LOGIN_URL = "https://secure.indeed.com/auth";

  function checkLoginStateQuick() {
    try {
      const u = new URL(location.href);
      const host = u.hostname || "";
      const path = u.pathname || "";
      if (/(^|\.)secure\.indeed\.com$/i.test(host) && /^\/(auth|account|login)/i.test(path)) {
        return { loggedIn: false, reason: "login_wall_url", platform: PLATFORM, loginUrl: INDEED_LOGIN_URL };
      }
      if (/(^|\.)account\.indeed\.com$/i.test(host)) {
        return { loggedIn: false, reason: "account_host", platform: PLATFORM, loginUrl: INDEED_LOGIN_URL };
      }
      if (/\/account\/login\b|\/m\/login\b/i.test(path + u.search)) {
        return { loggedIn: false, reason: "login_path", platform: PLATFORM, loginUrl: INDEED_LOGIN_URL };
      }
    } catch (_e) {}
    return null;
  }

  window.__AmijobsCheckLogin = function () {
    if (typeof window.__AmijobsIndeedCheckLoginFull === "function") {
      try {
        return window.__AmijobsIndeedCheckLoginFull();
      } catch (_e) {}
    }
    const quick = checkLoginStateQuick();
    if (quick) return quick;
    // Before full script loads: do not claim logged-out (false-blocked Start)
    return {
      loggedIn: true,
      reason: "unknown_optimistic",
      platform: PLATFORM,
      loginUrl: INDEED_LOGIN_URL,
      uncertain: true,
    };
  };

  if (!window.__AmijobsIndeedLoginMsg) {
    window.__AmijobsIndeedLoginMsg = true;
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.action !== "CHECK_LOGIN") return;
      try {
        sendResponse(window.__AmijobsCheckLogin());
      } catch (_e) {
        sendResponse({ loggedIn: false, reason: "error", platform: PLATFORM, loginUrl: INDEED_LOGIN_URL });
      }
    });
  }

  if (window.__AmijobsIndeedLoaded) return;
  window.__AmijobsIndeedLoaded = true;

  const S = () => window.AmiJobsShared;
  let isRunning = false;
  let shouldStop = false;
  let lastIndeedRunAt = 0;

  /**
   * HAR-proven signals (2026-08-15 session):
   * - apply.indeed.com /api/v1/env → applyUrl applybyapplyablejobid
   * - apis.indeed.com/graphql SubmitApplication → success
   */
  function installIndeedNetworkHooks() {
    if (window.__AmijobsIndeedNetHooks) return;
    window.__AmijobsIndeedNetHooks = true;
    const captureEnv = (text) => {
      try {
        const raw = String(text || "");
        const un = raw.replace(/\\u002F/g, "/");
        const m =
          un.match(/https:\/\/smartapply\.indeed\.com\/beta\/indeedapply\/applybyapplyablejobid\?[^"\\]+/i) ||
          un.match(/"applyUrl"\s*:\s*"(https:[^"]+smartapply[^"]+)"/i);
        if (!m) return;
        const url = (m[1] || m[0]).replace(/\\u002F/g, "/").replace(/\\\//g, "/");
        if (!/smartapply\.indeed\.com/i.test(url)) return;
        window.__AmijobsLastApplyUrl = url;
        chrome.storage.local.set({ amijobsIndeedApplyUrl: { url, at: Date.now() } }).catch(() => {});
        // Do NOT auto-open here — env fires on panel load before Postuler (HAR).
        // applyCurrentJob opens after the click.
      } catch (_e) {}
    };
    const captureSubmit = (text, url) => {
      try {
        const blob = `${url || ""} ${text || ""}`;
        if (!/SubmitApplication|submitApplication/i.test(blob)) return;
        const raw = String(text || "");
        // GraphQL errors / Indeed soft-fails must NOT count as applied
        if (
          /CAPTCHA_VALIDATION_FAILED|Invalid ReCaptcha token/i.test(raw) ||
          /"errors"\s*:\s*\[/.test(raw) ||
          /submitApplication"\s*:\s*null/i.test(raw)
        ) {
          window.__AmijobsSubmitApplicationFail = Date.now();
          window.__AmijobsCaptchaRejected = Date.now();
          window.__AmijobsRejectedToken = String(window.__AmijobsRecaptchaToken || "");
          window.__AmijobsCaptchaRejectCount = (window.__AmijobsCaptchaRejectCount || 0) + 1;
          try {
            const why = /CAPTCHA_VALIDATION_FAILED/i.test(raw)
              ? "CAPTCHA_VALIDATION_FAILED"
              : /Invalid ReCaptcha/i.test(raw)
                ? "Invalid ReCaptcha token"
                : "submit_errors";
            chrome.runtime
              .sendMessage({
                action: "appendLog",
                message: `[indeed] Indeed a rejeté le captcha (${why}) — token solveur invalide`,
                level: "error",
              })
              .catch(() => {});
          } catch (_e) {}
          return;
        }
        if (/applicationId|submittedAt/i.test(raw)) {
          window.__AmijobsSubmitApplicationOk = Date.now();
        }
      } catch (_e) {}
    };
    try {
      const ofetch = window.fetch.bind(window);
      window.fetch = async function (...args) {
        const res = await ofetch(...args);
        try {
          const reqUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
          if (/apply\.indeed\.com\/api\/v1\/env/i.test(reqUrl)) {
            res
              .clone()
              .text()
              .then(captureEnv)
              .catch(() => {});
          }
          if (/apis\.indeed\.com\/graphql/i.test(reqUrl)) {
            res
              .clone()
              .text()
              .then((t) => captureSubmit(t, reqUrl))
              .catch(() => {});
          }
        } catch (_e) {}
        return res;
      };
    } catch (_e) {}
    try {
      const XO = XMLHttpRequest.prototype.open;
      const XS = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__amijobsUrl = String(url || "");
        return XO.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener("load", function () {
          try {
            const u = this.__amijobsUrl || "";
            if (/apply\.indeed\.com\/api\/v1\/env/i.test(u)) captureEnv(this.responseText);
            if (/apis\.indeed\.com\/graphql/i.test(u)) captureSubmit(this.responseText, u);
            // Do NOT mark success from request body alone — response may be CAPTCHA_VALIDATION_FAILED
          } catch (_e) {}
        });
        return XS.apply(this, args);
      };
    } catch (_e) {}
  }
  installIndeedNetworkHooks();

  /** Nested indeed iframes must not run a second wizard (race on Continuer / CV). */
  function isTopAutomationFrame() {
    try {
      return window === window.top;
    } catch (_e) {
      return true;
    }
  }

  // Keep SERP intact: Smart Apply MUST reuse the single apply slot (never spam new tabs)
  try {
    const nativeOpen = window.open.bind(window);
    window.open = function (url, target, features) {
      const href = String(url || "");
      if (/smartapply\.indeed|indeedapply|applybyapplyablejobid/i.test(href)) {
        chrome.runtime
          .sendMessage({
            action: "ensurePlatformTab",
            platform: "indeed",
            url: href,
            active: true,
            forceNavigate: true,
          })
          .then(() =>
            chrome.runtime.sendMessage({
              action: "enforceOneTabPerPlatform",
              reason: "indeed smartapply window.open",
            })
          )
          .catch(() => {});
        return null;
      }
      if (/indeed\.(com|fr)/i.test(href)) {
        // Prefer navigating the current tab for non-apply Indeed URLs on SERP/viewjob
        if (/\/jobs\b|\/viewjob|\/rc\/clk|\/pagead\/clk/i.test(href) || isSearchPage() || isViewJobPage()) {
          window.location.href = href;
        } else {
          chrome.runtime
            .sendMessage({
              action: "ensurePlatformTab",
              platform: "indeed",
              url: href,
              active: true,
              forceNavigate: true,
            })
            .catch(() => {});
        }
        return null;
      }
      return nativeOpen(url, target, features);
    };
  } catch (_e) {
    /* ignore */
  }

  // Block "Signaler un problème" / privacy opt-out links during automation
  try {
    document.addEventListener(
      "click",
      (e) => {
        const a = e.target?.closest?.("a");
        if (!a || !a.href) return;
        if (/hrtechprivacy\.com|privacy opt out|requests\.hrtechprivacy/i.test(a.href)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
      },
      true
    );
  } catch (_e) {}

  function getIndeedHost(session) {
    if (session?.searchUrl) {
      try {
        return new URL(session.searchUrl).origin;
      } catch (_e) {
        /* ignore */
      }
    }
    if (session?.indeedOrigin) return session.indeedOrigin;
    if (globalThis.AmiJobsGeo?.indeedOriginForLocation && session?.location) {
      return globalThis.AmiJobsGeo.indeedOriginForLocation(session.location);
    }
    try {
      const h = window.location.hostname;
      if (globalThis.AmiJobsGeo?.isIndeedHostname?.(h) || /indeed\./i.test(h)) {
        return window.location.origin;
      }
    } catch (_e) {}
    return "https://www.indeed.com";
  }

  function isSearchPage(url = window.location.href) {
    return /indeed\.(?:com|[a-z]{2})\/jobs(\?|$)/.test(url) || /indeed\.(?:com|[a-z]{2})\/jobs\//.test(url);
  }

  function isViewJobPage(url = window.location.href) {
    return (
      /indeed\.(?:com|[a-z]{2})\/viewjob/.test(url) ||
      /indeed\.(?:com|[a-z]{2})\/rc\/clk/.test(url) ||
      /indeed\.(?:com|[a-z]{2})\/pagead\/clk/.test(url)
    );
  }

  function isIndeedOnboardingPage(url = window.location.href) {
    try {
      const u = new URL(url, location.href);
      return /onboarding\.indeed\.com$/i.test(u.hostname) || /\/onboarding\//i.test(u.pathname);
    } catch (_e) {
      return /onboarding\.indeed\.com/i.test(url);
    }
  }

  function isSmartApplyPage(url = window.location.href) {
    // v1.4.0: Ignore service worker iframes — they match smartapply but have no form
    let parsed = null;
    try {
      parsed = new URL(url, location.href);
    } catch (_e) {
      parsed = null;
    }
    const path = parsed ? parsed.pathname : url;
    if (/^\/_\/service_worker/i.test(path) || /^\/_\/scripts\//i.test(path) || /^\/sw_iframe/i.test(path)) {
      return false;
    }
    // Login walls carry the wizard URL inside ?continue= — matching the raw URL made
    // /auth look like a wizard and burned the full wizard timeout.
    if (isLoginWallPage(url)) return false;
    const host = parsed ? parsed.hostname : "";
    const target = host ? `${host}${path}` : url;
    return (
      /smartapply\.indeed\.com/i.test(target) ||
      /indeed\.(?:com|[a-z]{2})\/(?:beta\/)?indeedapply/i.test(target) ||
      /indeed\.(?:com|[a-z]{2})\/apply/i.test(target) ||
      /preloadresumeapply|applybyapplyablejobid/i.test(target)
    );
  }

  /** secure.indeed.com/auth — Indeed asks to re-login; no wizard will ever mount here. */
  function isLoginWallPage(url = window.location.href) {
    try {
      const u = new URL(url, location.href);
      const host = u.hostname || "";
      const path = u.pathname || "";
      if (/(^|\.)secure\.indeed\.com$/i.test(host) && /^\/(auth|account|login)/i.test(path)) return true;
      // Auth interstitial sometimes lands on account.indeed / login paths
      if (/(^|\.)account\.indeed\.com$/i.test(host)) return true;
      if (/\/account\/login\b|\/auth\/|\/oauth\/|\/m\/login\b/i.test(path + u.search)) return true;
      // continue= pointing at Smart Apply while still on secure host
      if (/(^|\.)secure\.indeed\.com$/i.test(host) && /[?&]continue=/i.test(u.search || "")) return true;
      return false;
    } catch (_e) {
      return false;
    }
  }

  function buildSearchUrl(keywords, location, page = 0, session = null) {
    const host = getIndeedHost(session);
    const p = new URLSearchParams();
    // Keep SERP extras (radius, fromage, filters) when flipping pages
    try {
      const base = session?.searchUrl || (isSearchPage() ? window.location.href : "");
      if (base) {
        const u = new URL(base);
        u.searchParams.forEach((v, k) => {
          if (/^(start|vjk|advn|adid|ad|from|jk)$/i.test(k)) return;
          p.set(k, v);
        });
      }
    } catch (_e) {}
    let kw = keywords || "";
    const contracts = session?.contracts || [];
    const wantsFreelance = (contracts || []).some((c) =>
      /freelance|independant|indépendant|contract/i.test(String(c))
    );
    if (wantsFreelance && kw && !/freelance/i.test(kw)) kw = `${kw} freelance`;
    if (wantsFreelance && !kw) kw = "freelance";
    if (kw) p.set("q", kw);
    if (location) p.set("l", location);
    // Candidature simplifiée uniquement (Same as FR UI filter / applicationType=1)
    p.set("applicationType", "1");
    p.set("iafilter", "1");
    if (!p.has("fromage")) p.set("fromage", "14");
    if (wantsFreelance) p.set("sc", "0kf:attr(DSQF7);");
    p.delete("start");
    if (page > 0) p.set("start", String(page * 10));
    if (!p.has("radius")) p.set("radius", "25");
    return `${host}/jobs?${p.toString()}`;
  }

  /** Max SERP pages to walk (10 jobs/page). Bound by session maxJobs, not a tiny hard stop. */
  function maxIndeedSerpPages(session, settings) {
    const maxJobs = Math.max(1, session?.maxJobs || settings?.maxJobsPerSession || 25);
    return Math.min(80, Math.max(15, Math.ceil(maxJobs / 10) + 8));
  }

  function isValidIndeedJobKey(jk) {
    if (!jk || typeof jk !== "string") return false;
    const key = jk.trim();
    if (key.length < 10 || key.length > 64) return false;
    if (/^(jk_)?test/i.test(key)) return false;
    if (!/^[a-z0-9_-]+$/i.test(key)) return false;

    const lower = key.toLowerCase();
    // Reject known demo keys only (substring abcdef was too aggressive on real jk)
    if (
      /^(a1b2c3d4e5f67890|0123456789abcdef|abcdef0123456789|123456789abcdef0|fedcba9876543210|890abcdef0123456|deadbeefdeadbeef|cafebabecafebabe)$/i.test(
        lower
      )
    ) {
      return false;
    }
    if (/^(jk_)?0{8,}$/i.test(lower)) return false;
    // Prefer real Indeed keys: 16-char hex with decent entropy
    if (/^[0-9a-f]{16}$/i.test(lower)) {
      const uniq = new Set(lower).size;
      if (uniq < 8) return false;
    }
    return true;
  }

  function extractJobKey(el) {
    if (!el) return null;
    const direct =
      el.getAttribute("data-jk") ||
      el.getAttribute("data-jobkey") ||
      el.closest("[data-jk]")?.getAttribute("data-jk") ||
      el.closest("[data-jobkey]")?.getAttribute("data-jobkey");
    if (direct && isValidIndeedJobKey(direct)) return direct;
    // data-jk often lives on the title <a>, while href is /pagead/clk without jk=
    const link =
      el.querySelector?.('a[data-jk], a[href*="jk="], a[href*="viewjob"], a.jcs-JobTitle') ||
      (el.matches?.('a[data-jk], a[href*="jk="], a.jcs-JobTitle') ? el : null);
    const fromLink = link?.getAttribute?.("data-jk") || link?.getAttribute?.("data-jobkey");
    if (fromLink && isValidIndeedJobKey(fromLink)) return fromLink;
    const href = link?.getAttribute?.("href") || el.getAttribute?.("href") || "";
    const m = href.match(/[?&]jk=([^&]+)/) || href.match(/[?&]vjk=([^&]+)/);
    if (m) {
      const jk = decodeURIComponent(m[1]);
      if (isValidIndeedJobKey(jk)) return jk;
    }
    const id = el.getAttribute?.("id") || "";
    const idMatch = id.match(/^(?:job_|sj_)([a-f0-9]+)$/i) || id.match(/job_([a-f0-9]+)/i);
    if (idMatch && isValidIndeedJobKey(idMatch[1])) return idMatch[1];
    return null;
  }

  async function getSession() {
    const { sessionIndeed: session = null } = await chrome.storage.local.get(["sessionIndeed"]);
    return session;
  }

  async function setSession(updates) {
    const session = await getSession();
    if (!session) return null;
    const next = { ...session, ...updates, lastRunAt: Date.now() };
    await chrome.storage.local.set({ sessionIndeed: next });
    return next;
  }

  function searchReturnUrl(session) {
    if (!session) return location.href;
    return buildSearchUrl(
      session.keywords,
      session.location,
      session.currentPage || 0,
      session
    );
  }

  /** After N successful applies on this SERP page, flip to next page (mass-apply pagination). */
  async function maybeFlipIndeedPage(session, settings, maxJobs, { navigate = true } = {}) {
    const perPage = settings?.maxJobsPerPage || 0;
    if (!perPage || perPage <= 0) return null;
    const pageApplied = session?.pageApplied || 0;
    const total = session?.applied || 0;
    if (pageApplied < perPage) return null;
    if (total >= maxJobs) return null;
    const nextPage = (session.currentPage || 0) + 1;
    if (!hasIndeedNextSerpPage() || nextPage > maxIndeedSerpPages(session, settings)) return null;
    const nextUrl = buildSearchUrl(session.keywords, session.location, nextPage, session);
    S().log(
      PLATFORM,
      `Page suivante Indeed (${nextPage + 1}) — ${pageApplied} postulé(s) sur cette page`,
      "warn"
    );
    await setSession({
      currentPage: nextPage,
      pageApplied: 0,
      queue: [],
      qIndex: 0,
      phase: "search",
      searchUrl: nextUrl,
    });
    if (navigate) window.location.href = nextUrl;
    return nextUrl;
  }

  async function endSession(reason) {
    try {
      playSessionBeep("done");
    } catch (_e) {}
    await chrome.runtime.sendMessage({
      action: "endPlatformSession",
      platform: PLATFORM,
      reason,
      openPopup: true,
    });
    if (reason) S().log(PLATFORM, `Session terminée: ${reason}`, "warn");
  }

  function playSessionBeep(type = "done") {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const gainNode = audioCtx.createGain();
      gainNode.connect(audioCtx.destination);
      gainNode.gain.value = 0.35;
      if (type === "done") {
        [0, 180].forEach((delay, i) => {
          const osc = audioCtx.createOscillator();
          osc.connect(gainNode);
          osc.type = "sine";
          osc.frequency.value = i === 0 ? 740 : 980;
          osc.start(audioCtx.currentTime + delay / 1000);
          osc.stop(audioCtx.currentTime + delay / 1000 + 0.16);
        });
        setTimeout(() => audioCtx.close(), 900);
      } else {
        const osc = audioCtx.createOscillator();
        osc.connect(gainNode);
        osc.type = "sine";
        osc.frequency.value = 660;
        osc.start();
        osc.stop(audioCtx.currentTime + 0.25);
        setTimeout(() => audioCtx.close(), 800);
      }
    } catch (_e) {}
  }

  async function humanSleep(minMs, maxMs) {
    const a = Math.max(0, Math.min(minMs, maxMs));
    const b = Math.max(minMs, maxMs);
    await S().sleep(S().randomDelay(a, b || a + 1));
  }

  /** True when SERP still has a usable Next control (or enough cards to imply another page). */
  function hasIndeedNextSerpPage() {
    const nextSels = [
      'a[data-testid="pagination-page-next"]',
      'button[data-testid="pagination-page-next"]',
      'a[aria-label="Next Page"]',
      'a[aria-label="Next"]',
      'a[aria-label="Suivant"]',
      'nav[role="navigation"] a[aria-label*="Next" i]',
      'nav[role="navigation"] a[aria-label*="Suivant" i]',
      'a[data-testid="pagination-page-next-button"]',
    ];
    for (const sel of nextSels) {
      let el;
      try {
        el = document.querySelector(sel);
      } catch (_e) {
        continue;
      }
      if (!el) continue;
      if (el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled")) continue;
      if (/disabled|inactive|aria-disabled/i.test(`${el.className || ""} ${el.getAttribute("aria-disabled") || ""}`)) {
        continue;
      }
      return true;
    }
    // No Next control → last page (do not invent start=N URLs forever)
    return false;
  }

  function detectCloudflareChallenge() {
    const text = (document.body?.innerText || "").toLowerCase();
    const title = (document.title || "").toLowerCase();
    // If job cards are visible, this is a healthy SERP — not a CF wall
    try {
      if (document.querySelectorAll('[data-jk], .job_seen_beacon, .cardOutline, a[data-jk]').length >= 3) {
        return false;
      }
    } catch (_e) {}
    return (
      text.includes("verify you are human") ||
      text.includes("vérifiez que vous êtes humain") ||
      text.includes("additional verification required") ||
      text.includes("checking your browser") ||
      text.includes("just a moment") ||
      title.includes("just a moment") ||
      title.includes("un instant") ||
      title.includes("additional verification") ||
      title.includes("security check") ||
      !!document.querySelector(
        '#challenge-stage, .cf-turnstile, iframe[src*="challenges.cloudflare.com"], #cf-challenge-running'
      )
    );
  }

  /**
   * "Request blocked" (anti-bot) used to end the whole Indeed run on first sight.
   * Pause with a growing budget instead (resume loop respects amijobsCfPause); only a
   * persistently blocked run (4th hit) ends the session.
   */
  async function handleAntiBotBlock(where = "serp") {
    let pauses = 1;
    try {
      const { sessionIndeed: s = null } = await chrome.storage.local.get(["sessionIndeed"]);
      pauses = (s?.antiBotPauses || 0) + 1;
      if (s) await chrome.storage.local.set({ sessionIndeed: { ...s, antiBotPauses: pauses } });
    } catch (_e) {}
    if (pauses > 3) {
      await endSession("Indeed a bloqué la requête (anti-bot) — 3 pauses sans succès");
      return;
    }
    const ms = 180000 * pauses;
    await markCloudflarePause(ms);
    S().log(
      PLATFORM,
      `Indeed anti-bot (${where}) — pause ${Math.round(ms / 60000)} min (${pauses}/3) puis reprise automatique`,
      "warn"
    );
  }

  async function markCloudflarePause(ms = 90000) {
    try {
      await chrome.storage.local.set({
        amijobsCfPause: { at: Date.now(), until: Date.now() + ms, platform: PLATFORM },
      });
    } catch (_e) {}
  }

  async function tryPassCloudflareChallenge() {
    // Job cards visible ⇒ already past CF
    try {
      if (collectJobCards().length > 0 || isSmartApplyPage()) {
        try {
          await chrome.storage.local.set({ amijobsCfPause: null });
        } catch (_e) {}
        return false;
      }
    } catch (_e) {}

    const text = (document.body?.innerText || "").toLowerCase();
    const hasWidget =
      detectCloudflareChallenge() ||
      text.includes("vérifiez que vous êtes humain") ||
      text.includes("verify you are human") ||
      text.includes("additional verification required") ||
      !!S().$('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile');
    if (!hasWidget) return false;

    // Freeze mass-apply while the user solves Cloudflare Turnstile by hand
    await markCloudflarePause(600000);
    S().log(
      PLATFORM,
      "Cloudflare Turnstile — cliquez le widget manuellement. AmiJobs attend (reCAPTCHA reste auto)…",
      "warn"
    );

    const start = Date.now();
    const maxMs = 600000;
    let lastHint = 0;
    while (Date.now() - start < maxMs) {
      if (shouldStop) return false;
      if (Date.now() - lastHint > 25000) {
        lastHint = Date.now();
        S().log(PLATFORM, "En attente du Turnstile Cloudflare (manuel)…", "warn");
        await markCloudflarePause(600000);
      }
      await S().sleep(2000);
      if (!detectCloudflareChallenge() && !detectBlockedPage()) {
        S().log(PLATFORM, "Challenge Cloudflare passé (manuel)", "success");
        try {
          await chrome.storage.local.set({ amijobsCfPause: null });
        } catch (_e) {}
        return true;
      }
      if (collectJobCards().length > 0 || isSmartApplyPage()) {
        S().log(PLATFORM, "Challenge Cloudflare passé (contenu chargé)", "success");
        try {
          await chrome.storage.local.set({ amijobsCfPause: null });
        } catch (_e) {}
        return true;
      }
    }
    S().log(
      PLATFORM,
      "Turnstile toujours présent — cliquez le widget Cloudflare, puis relancez si besoin",
      "warn"
    );
    await markCloudflarePause(180000);
    return false;
  }

  function detectBlockedPage() {
    const text = document.body?.innerText?.toLowerCase() || "";
    const title = document.title?.toLowerCase() || "";
    return (
      title.includes("blocked") ||
      text.includes("requête bloquée") ||
      text.includes("request blocked") ||
      text.includes("you have been blocked") ||
      text.includes("vous avez été bloqué") ||
      !!document.querySelector("#captcha-challenge, .cf-challenge, [data-testid='blocked']")
    );
  }

  function detectLoginWall() {
    // Hostname path is authoritative (never trust body copy alone on SERP)
    if (isLoginWallPage()) return true;
    const text = document.body?.innerText?.toLowerCase() || "";
    // Header "Se connecter" links exist even when logged in — require a real gate
    const hardGate =
      text.includes("connectez-vous pour continuer") ||
      text.includes("sign in to continue") ||
      text.includes("create an account to continue") ||
      text.includes("créez un compte pour continuer") ||
      text.includes("connectez-vous pour postuler") ||
      text.includes("sign in to apply") ||
      text.includes("log in to continue") ||
      text.includes("se connecter pour continuer") ||
      !!document.querySelector(
        'form[action*="login"] input[type="password"], #login-email-input, input[name="__email"], input[type="password"][name*="password" i]'
      );
    if (!hardGate) return false;
    // If job cards are visible, we are not on a login wall
    if (collectJobCards().length > 0) return false;
    if (isSearchPage() && S().$("#mosaic-provider-jobcards, .jobsearch-ResultsList, ul#job-results-list")) {
      return false;
    }
    // Avoid false positives on normal Indeed chrome — only secure/auth-like pages
    try {
      const host = location.hostname || "";
      const path = location.pathname || "";
      if (
        !/(^|\.)secure\.indeed\.com$/i.test(host) &&
        !/(^|\.)account\.indeed\.com$/i.test(host) &&
        !/\/(auth|login|account)\b/i.test(path) &&
        !/smartapply\.indeed\.com/i.test(host)
      ) {
        return false;
      }
      // Smart Apply page with a password form = login gate mid-wizard
      if (/smartapply\.indeed\.com/i.test(host) && document.querySelector('input[type="password"]')) {
        return true;
      }
    } catch (_e) {}
    return true;
  }

  function checkLoginState() {
    if (isLoginWallPage() || detectLoginWall()) {
      return { loggedIn: false, reason: "login_wall", platform: PLATFORM, loginUrl: INDEED_LOGIN_URL };
    }
    const text = String(document.body?.innerText || "").slice(0, 3500);
    const welcome = /Bienvenue,\s*\S+/i.test(text) || /Welcome,\s*\S+/i.test(text);
    const accountMenu = !!document.querySelector(
      [
        '[data-tn-element="accountMenu"]',
        "#accountMenu",
        '[data-testid="account-menu"]',
        'button[aria-label*="Account" i]',
        'button[aria-label*="Compte" i]',
        'a[href*="account/profile"]',
        'a[href*="/secure/account"]',
        '[data-gnav-element-name="AccountMenu"]',
      ].join(", ")
    );
    if (welcome || accountMenu) {
      return {
        loggedIn: true,
        reason: welcome ? "welcome" : "account_menu",
        platform: PLATFORM,
        loginUrl: INDEED_LOGIN_URL,
      };
    }

    const signInLinks = [
      ...document.querySelectorAll('a[href*="secure.indeed.com/auth"], a[href*="/account/login"], a[href*="secure.indeed.com/account"]'),
    ];
    const signInVisible = signInLinks.some((a) => {
      try {
        const st = window.getComputedStyle(a);
        if (st.display === "none" || st.visibility === "hidden") return false;
        const label = String(a.textContent || a.getAttribute("aria-label") || "");
        return /sign in|log in|se connecter|connexion|identifiez/i.test(label) || /\/auth/i.test(a.href || "");
      } catch (_e) {
        return true;
      }
    });

    const hasJobs =
      (typeof collectJobCards === "function" && collectJobCards().length > 0) ||
      !!document.querySelector("#mosaic-provider-jobcards, .jobsearch-ResultsList, ul#job-results-list, [data-jk]");

    if (signInVisible && !accountMenu && !welcome) {
      return { loggedIn: false, reason: "signin_link", platform: PLATFORM, loginUrl: INDEED_LOGIN_URL };
    }
    if (hasJobs && !signInVisible) {
      return { loggedIn: true, reason: "jobs_no_signin", platform: PLATFORM, loginUrl: INDEED_LOGIN_URL };
    }
    // Absence of auth wall on a normal Indeed page → treat as logged in enough to start
    if (!signInVisible && !isLoginWallPage()) {
      return { loggedIn: true, reason: "no_auth_wall", platform: PLATFORM, loginUrl: INDEED_LOGIN_URL };
    }
    // Uncertain — pre-start fail-open (mid-session wall still catches real auth)
    return { loggedIn: true, reason: "unknown_optimistic", platform: PLATFORM, loginUrl: INDEED_LOGIN_URL, uncertain: true };
  }

  window.__AmijobsIndeedCheckLoginFull = checkLoginState;
  window.__AmijobsCheckLogin = checkLoginState;

  function detectNoResultsPage() {
    const text = document.body?.innerText?.toLowerCase() || "";
    return (
      text.includes("aucun emploi ne correspond") ||
      text.includes("aucune offre ne correspond") ||
      text.includes("did not match any jobs") ||
      text.includes("no matching jobs") ||
      text.includes("0 emplois") ||
      !!S().$('[data-testid="zero-results"]') ||
      !!S().$(".jobsearch-NoResult")
    );
  }

  function detectMissingJobPage() {
    const text = (document.body?.innerText || "").toLowerCase();
    const title = (document.title || "").toLowerCase();
    const h1 = (S().$("h1")?.textContent || "").toLowerCase();
    return (
      text.includes("page introuvable") ||
      text.includes("we can’t find this page") ||
      text.includes("we can't find this page") ||
      text.includes("this job has expired") ||
      text.includes("cette offre a expiré") ||
      text.includes("offre n'est plus disponible") ||
      text.includes("additional verification required") ||
      text.includes("vérification supplémentaire") ||
      title.includes("page introuvable") ||
      title.includes("additional verification") ||
      /page introuvable|not found|404|additional verification/.test(h1)
    );
  }

  function collectJobCards() {
    const selectors = [
      "#mosaic-provider-jobcards .cardOutline",
      "#mosaic-provider-jobcards [data-testid='slider_item']",
      ".job_seen_beacon",
      "div.job_seen_beacon",
      "li[data-jk]",
      "div[data-jk]",
      ".tapItem",
      ".resultContent",
      "ul#job-results-list > li",
      ".jobsearch-ResultsList > li",
      '[data-testid="slider_item"]',
      '[data-testid="job-card"]',
      ".jobsearch-SerpJobCard",
      "div.slider_item",
      "a.jcs-JobTitle[data-jk]",
      "h2.jobTitle a[data-jk]",
      "a[data-jk]",
    ];
    const nodes = new Set();
    for (const sel of selectors) {
      for (const el of S().$$(sel)) {
        // Prefer real card shells — bare <li> matches mosaic chrome without data-jk
        const card =
          el.closest(".job_seen_beacon, .cardOutline, [data-testid='slider_item'], [data-testid='job-card'], li[data-jk], div[data-jk]") ||
          (el.matches?.("a[data-jk], a.jcs-JobTitle") ? el : null) ||
          el;
        nodes.add(card);
      }
    }
    const out = [];
    const seen = new Set();
    for (const el of nodes) {
      const jk = extractJobKey(el);
      if (!jk || seen.has(jk)) continue;
      const titleEl =
        (el.matches?.("a.jcs-JobTitle, a[data-jk], h2 a") ? el : null) ||
        el.querySelector?.(
          "h2.jobTitle span, h2.jobTitle a, .jobTitle, [data-testid='job-title'], a.jcs-JobTitle, a[data-jk]"
        );
      const title = (titleEl?.textContent || "").trim();
      // Ghost / ad shells often expose fake jk without a real title
      if (!title || title.length < 3) continue;
      if (/page introuvable|not found|job expired/i.test(title)) continue;
      seen.add(jk);
      const company =
        el.querySelector?.("[data-testid='company-name'], .companyName, .company, span.companyName")
          ?.textContent?.trim() ||
        el.closest?.(".job_seen_beacon, .cardOutline, li, [data-testid='slider_item']")
          ?.querySelector?.("[data-testid='company-name'], .companyName, span.companyName")
          ?.textContent?.trim() ||
        "";
      const shell =
        el.closest?.(".job_seen_beacon, .cardOutline, [data-testid='slider_item'], li") || el;
      const easy = cardLooksLikeEasyApply(shell) || cardLooksLikeEasyApply(el);
      out.push({ element: shell || el, jobId: jk, title, company, easyApply: easy });
    }
    // Prefer cards that show Easy Apply / candidature simplifiée.
    // Do NOT force easyApply=true just because applicationType=1 — Indeed still lists
    // company-site jobs that cost ~20s each if we wait for a Postuler CTA that never comes.
    if (out.some((c) => c.easyApply)) {
      return out.filter((c) => c.easyApply);
    }
    return out;
  }

  async function waitForJobCards(maxWaitMs = 45000, { minCards = 3 } = {}) {
    const start = Date.now();
    let attempt = 0;
    let best = [];
    let stableCount = 0;
    let lastLen = -1;
    await dismissIndeedPopups().catch(() => {});
    while (Date.now() - start < maxWaitMs) {
      attempt++;
      if (detectBlockedPage()) return best;
      if (detectNoResultsPage() && attempt > 3) return best;
      const scrollRoot =
        S().$("#mosaic-provider-jobcards") ||
        S().$(".jobsearch-ResultsList") ||
        S().$('[class*="JobCard"]')?.closest("ul, div") ||
        S().$("main") ||
        document.scrollingElement;
      if (scrollRoot) {
        scrollRoot.scrollTop = Math.min((scrollRoot.scrollTop || 0) + 700, scrollRoot.scrollHeight || 8000);
      } else {
        window.scrollBy(0, 700);
      }
      await S().sleep(450);
      const cards = collectJobCards();
      if (cards.length > best.length) best = cards;
      if (cards.length === lastLen && cards.length > 0) stableCount++;
      else stableCount = 0;
      lastLen = cards.length;
      // Keep scrolling until a usable SERP batch is loaded
      if (cards.length >= minCards) {
        S().log(PLATFORM, `${cards.length} offres détectées (tentative ${attempt})`);
        window.scrollTo(0, 0);
        return cards;
      }
      // Stable partial page — don't burn the full timeout
      if (cards.length > 0 && (stableCount >= 3 || Date.now() - start > maxWaitMs * 0.55)) {
        S().log(PLATFORM, `${cards.length} offres détectées (partiel, tentative ${attempt})`, "warn");
        window.scrollTo(0, 0);
        return cards;
      }
      await S().sleep(900);
    }
    if (best.length) {
      S().log(PLATFORM, `${best.length} offres détectées (timeout)`, "warn");
    } else {
      S().log(
        PLATFORM,
        `0 offre détectée après ${Math.round(maxWaitMs / 1000)}s (URL=${location.pathname}${location.search.slice(0, 80)})`,
        "warn"
      );
    }
    window.scrollTo(0, 0);
    return best.length ? best : collectJobCards();
  }

  function getJobInfoFromPage(jobId) {
    let title =
      S().$('[data-testid="jobsearch-JobInfoHeader-title"]')?.textContent?.trim() ||
      S().$(".jobsearch-JobInfoHeader-title")?.textContent?.trim() ||
      S().$("h1.jobsearch-JobInfoHeader-title")?.textContent?.trim() ||
      S().$('[data-testid="jobTitle"]')?.textContent?.trim() ||
      "";
    // SERP h1 is often "Emplois freelance (Île-de-France)" — never treat as job title
    if (
      !title ||
      /^(emplois|jobs|offres)\b/i.test(title) ||
      /\(île-de-france|ile-de-france\)/i.test(title) ||
      title === (document.title || "").split("|")[0].trim()
    ) {
      const h2 = S().$(".jobsearch-JobInfoHeader-title-container h2, [data-testid='jobsearch-JobInfoHeader-title'] span")?.textContent?.trim();
      if (h2 && !/^(emplois|jobs|offres)\b/i.test(h2)) title = h2;
      else title = "";
    }
    const company =
      S().$('[data-testid="inlineHeader-companyName"]')?.textContent?.trim() ||
      S().$('[data-testid="company-name"]')?.textContent?.trim() ||
      S().$(".jobsearch-InlineCompanyRating-companyHeader a")?.textContent?.trim() ||
      S().$(".jobsearch-CompanyInfoWithoutHeaderImage a")?.textContent?.trim() ||
      "";
    const location =
      S().$('[data-testid="job-location"]')?.textContent?.trim() ||
      S().$(".jobsearch-JobInfoHeader-subtitle")?.textContent?.trim() ||
      "";
    return {
      jobId: jobId || jkFromUrl(),
      title,
      company,
      location,
      url: window.location.href,
    };
  }

  function jkFromUrl() {
    const m =
      window.location.href.match(/[?&]vjk=([^&]+)/) ||
      window.location.href.match(/[?&]jk=([^&]+)/) ||
      window.location.href.match(/indeedApplyableJobId=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : `indeed_${Date.now()}`;
  }

  function isDisplayedEl(el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    } catch (_e) {
      return false;
    }
  }

  function applyCtaLabel(el) {
    if (!el) return "";
    return `${el.innerText || el.textContent || ""} ${el.getAttribute?.("aria-label") || ""}`
      .replace(/\s+/g, " ")
      .trim();
  }

  function isApplyCtaLoading(el) {
    if (!el) return true;
    const visible = `${el.innerText || el.textContent || ""}`.replace(/\s+/g, " ").trim().toLowerCase();
    if (/^chargement(\s+en\s+cours)?\.?$|^loading(\.\.\.)?$|please wait/i.test(visible)) return true;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return true;
    return false;
  }

  function isIndeedEasyApplyLabel(text) {
    const t = (text || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 160) return false;
    if (/^\s*candidature simplifi[ée]e\s*$/i.test(t)) return false;
    if (/continuer (pour |à )?postuler|continue (to )?apply|postuler sur le site|company site/i.test(t)) {
      return false;
    }
    return (
      /postuler sur indeed|postuler maintenant|indeed apply|apply with indeed|apply on indeed|apply now|postuler facilement|candidature facile/i.test(
        t
      ) || /^\s*postuler(\s+maintenant)?\s*$/i.test(t)
    );
  }

  function resolveIndeedApplyClickable(el) {
    if (!el) return null;
    if (el.matches?.("button, a, [role='button']")) return el;
    const btn =
      el.closest?.("#jobsearch-ViewJobButtons-container")?.querySelector?.(
        'button[aria-label*="Postuler" i], button[aria-label*="Apply" i], button[data-testid$="-test"]'
      ) ||
      el.closest?.("button, a, [role='button']") ||
      el.querySelector?.("button, a, [role='button']");
    return btn || el;
  }

  /**
   * Live FR SERP (browser-use probe 2026-08-16):
   * - Visible CTA: BUTTON[data-testid$="-test"] aria="Postuler sur Indeed opens in a new tab"
   * - Wrapper SPAN.indeed-apply-status-not-applied[data-indeed-apply-jk] (hashed testid, no -test suffix)
   * - contentHtml model may say "Postuler maintenant" while painted text is "Postuler sur Indeed"
   * - During hydrate, button text is "chargement en cours" and often disabled — wait, don't skip
   */
  function findIndeedEasyApplyButton(opts = {}) {
    const allowLoading = !!opts.allowLoading;
    // Already-applied jobs often keep a dead Postuler control — never click it
    if (detectAlreadyAppliedUi()) return null;

    const roots = [];
    const panel = getIndeedJobPanelRoot();
    if (panel) roots.push(panel);
    roots.push(document);
    try {
      for (const frame of document.querySelectorAll("iframe")) {
        try {
          const doc = frame.contentDocument || frame.contentWindow?.document;
          if (doc) roots.push(doc);
        } catch (_e) {}
      }
    } catch (_e) {}

    const pick = (el) => {
      if (!el || !isDisplayedEl(el) || isCompanySiteApplyButton(el) || isContinueToApplyButton(el)) {
        return null;
      }
      const clickable = resolveIndeedApplyClickable(el);
      if (!clickable || !isDisplayedEl(clickable)) return null;
      if (isCompanySiteApplyButton(clickable) || isContinueToApplyButton(clickable)) return null;
      const label = applyCtaLabel(clickable);
      const loading = isApplyCtaLoading(clickable) || clickable.disabled || clickable.getAttribute("aria-disabled") === "true";
      if (loading && !allowLoading) return null;
      // Prefer labelled CTAs; allow data-indeed-apply-jk shells while loading
      if (!isIndeedEasyApplyLabel(label) && !clickable.closest?.("[data-indeed-apply-jk], [class*='indeed-apply-status']")) {
        return null;
      }
      if (!isIndeedEasyApplyLabel(label) && !loading) return null;
      return clickable;
    };

    const selectors = [
      // Highest confidence — live FR panel
      '#jobsearch-ViewJobButtons-container button[aria-label*="Postuler" i]',
      '#jobsearch-ViewJobButtons-container button[aria-label*="Apply" i]',
      "#jobsearch-ViewJobButtons-container button[data-testid$='-test']",
      "#jobsearch-ViewJobButtons-container button",
      "[class*='indeed-apply-status-not-applied']",
      "[data-indeed-apply-jk]",
      '[data-indeed-apply-onapplied]',
      '[data-testid="indeedApplyButton"]',
      "#indeedApplyButton",
      "[data-indeed-apply-button]",
      "button.ia-IndeedApplyButton",
      'button[aria-label*="Postuler sur Indeed" i]',
      'button[aria-label*="Postuler maintenant" i]',
      'button[aria-label*="Indeed Apply" i]',
      'button[aria-label*="Apply now" i]',
      'a[aria-label*="Postuler sur Indeed" i]',
      'a[aria-label*="Postuler maintenant" i]',
      "#applyButtonLinkContainer button",
      ".jobsearch-IndeedApplyButton-newDesign",
      'button[id*="indeedApply"]',
      // Hashed ids (scoped check via label)
      'button[data-testid$="-test"]',
      '[data-testid$="-test"][aria-label*="Postuler" i]',
      '[data-testid$="-test"][aria-label*="Indeed" i]',
    ];

    for (const root of roots) {
      for (const sel of selectors) {
        let nodes;
        try {
          nodes = root.querySelectorAll(sel);
        } catch (_e) {
          continue;
        }
        for (const btn of nodes) {
          const hit = pick(btn);
          if (hit) return hit;
        }
      }

      for (const el of root.querySelectorAll("button, a, [role='button']")) {
        const label = applyCtaLabel(el);
        if (!isIndeedEasyApplyLabel(label)) continue;
        const hit = pick(el);
        if (hit) return hit;
      }

      for (const span of root.querySelectorAll(
        "span.indeed-apply-status-not-applied, [class*='indeed-apply-status-not-applied'], span[data-indeed-apply-jk], [data-indeed-apply-jk]"
      )) {
        const hit = pick(span);
        if (hit) return hit;
      }
    }
    return null;
  }

  function isContinueToApplyButton(btn) {
    if (!btn) return false;
    const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.toLowerCase();
    return /continuer (pour |à )?postuler|continue (to )?apply|apply on company|postuler sur le site/i.test(
      text
    );
  }

  function findContinueToApplyButton() {
    for (const el of S().$$("button, a, [role='button'], span")) {
      const t = (el.textContent || "").trim();
      if (!/continuer (pour |à )?postuler|continue (to )?apply/i.test(t)) continue;
      const clickable = el.closest("button, a, [role='button']") || (el.tagName === "BUTTON" || el.tagName === "A" ? el : el.parentElement);
      if (clickable && S().isVisible(clickable) && !isCompanySiteApplyButton(clickable)) return clickable;
    }
    return S().findActionButtonDeep([
      /continuer pour postuler/i,
      /continuer à postuler/i,
      /continue to apply/i,
      /continue applying/i,
    ]);
  }

  function findApplyButton() {
    // Prefer Indeed Easy Apply — never confuse with "Continuer pour postuler" (external)
    return findIndeedEasyApplyButton();
  }

  function isCompanySiteApplyButton(btn) {
    if (!btn) return false;
    if (isContinueToApplyButton(btn)) return true;
    const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.toLowerCase();
    return /site (de l['’]entreprise|de l['’]employeur)|company (site|website)|sur le site|externe|external apply/i.test(
      text
    );
  }

  function panelShowsNonEasyApplyOnly() {
    if (findContinueToApplyButton()) return true;
    const root =
      document.querySelector("#jobsearch-ViewJobButtons-container") ||
      document.querySelector("[data-testid='jobsearch-ViewJobButtons-container']") ||
      document;
    for (const btn of root.querySelectorAll("button, a[role='button'], a")) {
      if (!isDisplayedEl(btn)) continue;
      if (isCompanySiteApplyButton(btn) || isContinueToApplyButton(btn)) return true;
    }
    return false;
  }

  async function ensureEasyApplyOnlyFilter() {
    if (/[?&]applicationType=1\b/i.test(window.location.href)) return false;
    if (!/\/jobs\b/i.test(window.location.pathname || "")) return false;
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("applicationType", "1");
      u.searchParams.set("iafilter", "1");
      S().log(PLATFORM, "Filtre candidature simplifiée (applicationType=1)", "warn");
      window.location.href = u.toString();
      return true;
    } catch (_e) {
      return false;
    }
  }

  function detectApplySuccess() {
    // HAR: GraphQL SubmitApplication completes the apply
    if (window.__AmijobsSubmitApplicationOk && Date.now() - window.__AmijobsSubmitApplicationOk < 120000) {
      return true;
    }
    const path = window.location.pathname || "";
    const href = window.location.href || "";
    const title = (document.title || "").toLowerCase();
    // HAR live session: title "Votre candidature a été envoyée | Indeed"
    if (/votre candidature a (été|ete) envoyée|application (has been )?submitted|candidature envoyée/i.test(title)) {
      return true;
    }
    if (/\/post-apply/i.test(path) || /application-submitted/i.test(path) || /\/conversion\/?/i.test(path)) {
      return true;
    }
    if (/\/conversion\//i.test(href)) return true;
    const body = document.body?.innerText?.toLowerCase() || "";
    return (
      body.includes("application submitted") ||
      body.includes("your application has been submitted") ||
      body.includes("vous avez postulé") ||
      body.includes("candidature a été envoyée") ||
      body.includes("votre candidature a été envoyée") ||
      body.includes("we have received your application") ||
      body.includes("nous avons bien reçu") ||
      body.includes("votre candidature a bien été") ||
      !!S().$('[data-testid="apply-success"], .ia-BasePage-heading, [data-testid="post-apply"]')
    );
  }

  /** Smart Apply URL from HAR flow: applybyapplyablejobid / preloadresumeapply. */
  function extractSmartApplyUrlFromDom() {
    const roots = [document];
    try {
      for (const frame of document.querySelectorAll("iframe")) {
        try {
          const doc = frame.contentDocument || frame.contentWindow?.document;
          if (doc) roots.push(doc);
        } catch (_e) {}
      }
    } catch (_e) {}
    for (const root of roots) {
      for (const a of root.querySelectorAll(
        'a[href*="smartapply.indeed.com"], a[href*="applybyapplyablejobid"], a[href*="preloadresumeapply"], a[href*="indeedapply"]'
      )) {
        const href = a.href || a.getAttribute("href") || "";
        if (/smartapply\.indeed\.com|applybyapplyablejobid|preloadresumeapply/i.test(href)) return href;
      }
      for (const el of root.querySelectorAll(
        "[data-indeed-apply-joburl], [data-indeed-apply-continueurl], [data-indeed-apply-url], [data-apply-url]"
      )) {
        const href =
          el.getAttribute("data-indeed-apply-joburl") ||
          el.getAttribute("data-indeed-apply-continueurl") ||
          el.getAttribute("data-indeed-apply-url") ||
          el.getAttribute("data-apply-url") ||
          "";
        if (/smartapply\.indeed\.com|applybyapplyablejobid|preloadresumeapply/i.test(href)) return href;
      }
    }
    try {
      const html = document.documentElement?.innerHTML || "";
      const m =
        html.match(/https:\/\/smartapply\.indeed\.com\/beta\/indeedapply\/applybyapplyablejobid\?[^"'\\\s<]+/i) ||
        html.match(/https:\\\/\\\/smartapply\.indeed\.com\\\/beta\\\/indeedapply\\\/applybyapplyablejobid\?[^"'\\]+/i);
      if (m) return m[0].replace(/\\\//g, "/").replace(/&amp;/g, "&");
    } catch (_e) {}
    return null;
  }

  /** Keep session.currentPage aligned with ?start= on the live SERP (HAR: start=10 → page 2). */
  async function syncSerpPageFromLocation(session) {
    if (!session || !isSearchPage()) return session;
    try {
      const u = new URL(window.location.href);
      const start = parseInt(u.searchParams.get("start") || "0", 10) || 0;
      const page = Math.max(0, Math.floor(start / 10));
      const searchUrl = `${u.origin}${u.pathname}?${u.searchParams.toString()}`;
      if (page !== (session.currentPage || 0) || !session.searchUrl) {
        S().log(PLATFORM, `SERP sync page ${page + 1} (start=${start})`, "warn");
        return await setSession({ currentPage: page, searchUrl, phase: "search" });
      }
      if (session.searchUrl !== searchUrl) {
        return await setSession({ searchUrl });
      }
    } catch (_e) {}
    return session;
  }

  /** Right-hand job pane (or full viewjob) — not the SERP card list. */
  function getIndeedJobPanelRoot() {
    return (
      S().$(
        '#jobsearch-ViewjobPaneWrapper, [data-testid="jobsearch-JobComponent"], .jobsearch-JobComponent, #viewJobSSRRoot, .jobsearch-RightPane, [data-testid="jobsearch-ViewJobButtons-container"], #jobsearch-ViewJobButtons-container'
      ) ||
      (!isSearchPage() ? document.body : null)
    );
  }

  /** Card-level "already applied" badge on the SERP list. */
  function cardAlreadyApplied(cardEl) {
    if (!cardEl) return false;
    if (cardEl.querySelector?.('[data-testid="appliedSnippet"], [data-testid*="appliedSnippet" i]')) {
      return true;
    }
    const t = `${cardEl.innerText || cardEl.textContent || ""}`.toLowerCase();
    return /candidature envoyée|already applied|vous avez déjà postulé|application sent/i.test(t);
  }

  /**
   * Job detail already applied. Live FR UI (2026): data-testid="appliedSnippet"
   * ("Candidature envoyée") while #jobsearch-ViewJobButtons-container may still
   * show a non-working Postuler control — treat snippet as authoritative.
   */
  function detectAlreadyAppliedUi() {
    const panel = getIndeedJobPanelRoot();
    if (panel) {
      if (panel.querySelector?.('[data-testid="appliedSnippet"], [data-testid*="appliedSnippet" i]')) {
        return true;
      }
      if (
        panel.querySelector?.(
          '[data-testid*="already-applied" i], [aria-label*="déjà postulé" i], [aria-label*="already applied" i]'
        )
      ) {
        return true;
      }
      const panelText = (panel.innerText || "").toLowerCase();
      // Snippet text wins even when a dead Postuler button is still in the DOM
      if (
        /candidature envoyée|candidature déjà envoyée|candidature deja envoyee|vous avez déjà postulé|you have already applied|already applied to this job|application sent/i.test(
          panelText
        )
      ) {
        return true;
      }
    }
    if (!isSearchPage()) {
      const t = (document.body?.innerText || "").toLowerCase();
      if (
        t.includes("vous avez déjà postulé") ||
        t.includes("vous avez deja poste") ||
        t.includes("you have already applied") ||
        t.includes("already applied to this job") ||
        t.includes("candidature déjà envoyée") ||
        t.includes("candidature deja envoyee")
      ) {
        return true;
      }
      if (S().$('[data-testid="appliedSnippet"], [data-testid*="appliedSnippet" i]')) return true;
    }
    return false;
  }

  async function waitForApplyButton(timeoutMs = 2800) {
    // Easy Apply / candidature simplifiée only — ignore "Continuer pour postuler"
    // When the job panel is still hydrating (data-indeed-apply-jk shell), wait longer.
    let effectiveTimeout = timeoutMs;
    try {
      const hydrating =
        !!document.querySelector("[data-indeed-apply-jk]") ||
        !!document.querySelector(
          "#jobsearch-ViewjobButtons-container, #jobsearch-ViewJobButtons-container, [class*='indeed-apply-status']"
        ) ||
        (isViewJobPage() &&
          !!document.querySelector(
            "[data-testid='jobsearch-JobInfoHeader-title'], .jobsearch-JobInfoHeader-title, #jobsearch-ViewjobPaneWrapper"
          ));
      if (hydrating && effectiveTimeout < 8000) effectiveTimeout = S().randomDelay(8000, 12000);
    } catch (_e) {}

    const start = Date.now();
    let dismissed = false;
    while (Date.now() - start < effectiveTimeout) {
      if (!dismissed || Date.now() - start < 900) {
        dismissed = (await dismissIndeedPopups().catch(() => false)) || dismissed;
      }
      if (detectAlreadyAppliedUi()) return null;
      if (findContinueToApplyButton() || panelShowsNonEasyApplyOnly()) {
        // Definitive non-Easy-Apply CTA — don't burn the timeout
        return null;
      }
      const easy = findIndeedEasyApplyButton({ allowLoading: true });
      if (easy && !isApplyCtaLoading(easy) && isIndeedEasyApplyLabel(applyCtaLabel(easy))) {
        return easy;
      }
      // Still loading — keep waiting instead of giving up early
      if (easy && isApplyCtaLoading(easy)) {
        await humanSleep(200, 400);
        continue;
      }
      await humanSleep(120, 280);
    }
    return null;
  }

  async function waitForSerpJobPanel(jobId, title, timeoutMs = 1100) {
    const start = Date.now();
    let sawShell = false;
    let sawLoading = false;
    const titleNeedle = (title || "").slice(0, 24).toLowerCase();
    while (Date.now() - start < timeoutMs) {
      if (detectAlreadyAppliedUi()) return "applied";
      if (detectCloudflareChallenge() || /v[ée]rification suppl[ée]mentaire|just a moment/i.test(document.title || "")) {
        return "blocked";
      }
      // Company-site / Continuer pour postuler → skip immediately
      if (findContinueToApplyButton() || panelShowsNonEasyApplyOnly()) return "no_easy_apply";

      const jkSel = jobId ? `[data-indeed-apply-jk="${String(jobId).replace(/"/g, "")}"]` : null;
      const shell =
        (jkSel && document.querySelector(jkSel)) ||
        document.querySelector(
          "#jobsearch-ViewjobButtons-container, #jobsearch-ViewJobButtons-container, [data-testid='jobsearch-JobInfoHeader-title'], .jobsearch-JobInfoHeader-title"
        );
      if (shell) sawShell = true;

      const btn = findIndeedEasyApplyButton({ allowLoading: true });
      if (btn && !isApplyCtaLoading(btn) && isIndeedEasyApplyLabel(applyCtaLabel(btn))) return "ready";
      if (btn && isApplyCtaLoading(btn)) {
        sawLoading = true;
        await humanSleep(180, 360);
        continue;
      }

      // Panel hydrated with no Easy Apply CTA → fast skip (500–1000ms budget)
      if (sawShell && !sawLoading && Date.now() - start >= 450) {
        const header =
          document.querySelector(
            '[data-testid="jobsearch-JobInfoHeader-title"], .jobsearch-JobInfoHeader-title'
          )?.textContent || "";
        if (!titleNeedle || !header || header.toLowerCase().includes(titleNeedle.slice(0, 10))) {
          return "no_easy_apply";
        }
      }
      await humanSleep(100, 220);
    }
    if (findIndeedEasyApplyButton({ allowLoading: true })) return "loading";
    return "no_easy_apply";
  }

  function cardLooksLikeEasyApply(cardEl) {
    if (!cardEl) return false;
    const text = `${cardEl.innerText || cardEl.textContent || ""}`.toLowerCase();
    if (/candidature simplifi|indeed apply|postuler facilement|easy apply/i.test(text)) return true;
    if (cardEl.querySelector?.(".iaIcon, .indeed-apply-widget, [class*='indeedApply'], [data-indeed-apply-button]")) {
      return true;
    }
    return false;
  }

  async function alreadyApplied(appliedJobs, jobId) {
    if (!jobId) return false;
    return !!(appliedJobs[jobId] || appliedJobs[`ind_${jobId}`]);
  }

  async function alreadyHandled(jobId) {
    if (!jobId) return false;
    const { appliedJobs = {}, skippedJobs = {}, errorJobs = {} } = await chrome.storage.local.get([
      "appliedJobs",
      "skippedJobs",
      "errorJobs",
    ]);
    const keys = [jobId, `ind_${jobId}`];
    // Do NOT treat seenJobIds as terminal — a failed open / interrupted viewjob must retry
    return keys.some((k) => appliedJobs[k] || skippedJobs[k] || errorJobs[k]);
  }

  async function markSeenJob(jobId) {
    if (!jobId) return;
    const session = await getSession();
    if (!session) return;
    const seenJobIds = { ...(session.seenJobIds || {}), [jobId]: Date.now() };
    await setSession({ seenJobIds });
  }

  async function shouldSkipCompany(company) {
    return S().shouldSkipCompany(company);
  }

  function smartApplyPath() {
    try {
      return new URL(window.location.href).pathname;
    } catch (_e) {
      return window.location.pathname || "";
    }
  }

  async function fillProfileLocationStep() {
    // Live DOM (headed Chrome + HAR cookies): profile-location page
    const profile = await S().getProfile();
    const city = (profile.location || "").split(",")[0].trim() || "Paris";
    const postal = profile.postalCode || "75001";
    const address = profile.address || profile.street || "1 Rue de Rivoli";
    const map = [
      ['[data-testid="location-fields-postal-code-input"]', "#location-fields-postal-code-input", postal],
      ['[data-testid="location-fields-locality-input"]', "#location-fields-locality-input", city],
      ['[data-testid="location-fields-address-input"]', "#location-fields-address-input", address],
      ['input[name*="postal" i]', null, postal],
      ['input[name*="city" i], input[name*="locality" i]', null, city],
      ['input[name*="address" i], input[autocomplete="street-address"]', null, address],
    ];
    for (const [a, b, val] of map) {
      const el = (a && S().$(a)) || (b && S().$(b));
      if (el && S().isVisible(el) && !(el.value || "").trim()) {
        await S().humanType(el, val);
        await S().sleep(200);
      }
    }
    // Advance if Continuer is already enabled on this step
    const cont =
      S().$('[data-testid="continue-button"]') ||
      [...S().$$("button")].find((b) => /^continuer$/i.test((b.textContent || "").trim()) && isDisplayed(b));
    if (cont && !cont.disabled && cont.getAttribute("aria-disabled") !== "true") {
      await S().humanClick(cont);
      await S().sleep(1200);
    }
  }

  /** Indeed sometimes inserts preferences onboarding mid-apply (onboarding.indeed.com). */
  async function handleIndeedOnboardingPage() {
    S().log(PLATFORM, "Onboarding Indeed — préférences / localisation", "warn");
    const profile = await S().getProfile();
    const city = (profile.location || "").split(",")[0].trim() || "Paris";
    const postal = profile.postalCode || "75001";
    // Fill empty city / postal inputs (page often prefilled)
    for (const el of S().$$('input[type="text"], input:not([type]), input[name*="location" i], input[name*="postal" i], input[name*="city" i]')) {
      if (!S().isVisible(el) || (el.value || "").trim()) continue;
      const hint = `${el.name || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""} ${el.placeholder || ""}`.toLowerCase();
      const val = /postal|zip|code/i.test(hint) ? postal : city;
      await S().humanType(el, val);
      await S().sleep(250);
    }
    const cont =
      S().$('[data-testid="continue-button"], [data-testid*="continue" i]') ||
      [...S().$$("button")].find((b) => {
        if (!isDisplayed(b) || b.disabled || b.getAttribute("aria-disabled") === "true") return false;
        return /^continuer$|^continue$|^suivant$|^next$/i.test((b.textContent || "").trim());
      });
    if (cont) {
      S().log(PLATFORM, "Clic Continuer (onboarding)");
      await S().humanClick(cont);
      await S().sleep(2000);
      return true;
    }
    S().log(PLATFORM, "Onboarding sans Continuer — attente", "warn");
    await S().sleep(1500);
    return false;
  }

  function resumePageText() {
    return (document.body?.innerText || "").replace(/\s+/g, " ");
  }

  /** Indeed CV service down → only file upload works ("Importer un CV"). */
  function needsForcedCvUpload() {
    const t = resumePageText();
    if (
      /Indeed CV est actuellement indisponible|Importer un CV|Types de fichiers acceptés|use an uploaded resume|Sélectionnez un fichier pour continuer|Select a file to continue/i.test(
        t
      )
    ) {
      return true;
    }
    // Upload button visible on resume step
    const uploadBtn = [...S().$$("button, [role='button'], label")].some(
      (b) => S().isVisible(b) && /S[ée]lectionner un fichier|Choose file|Upload (a )?resume/i.test(b.textContent || "")
    );
    return uploadBtn && !!S().$('input[type="file"]');
  }

  function resumeUploadErrorVisible() {
    return /Sélectionnez un fichier pour continuer|Select a file to continue/i.test(resumePageText());
  }

  /** Indeed only advances when the uploaded filename is visible — input.files alone is a false positive. */
  function resumeFileUiAccepted(cvName = "") {
    if (resumeUploadErrorVisible()) {
      window.__AmijobsResumeUploadedAt = 0;
      return false;
    }
    const t = resumePageText();
    const name = String(cvName || window.__AmijobsResumeFileName || "").trim();
    const stem = name.replace(/\.[^.]+$/, "").slice(0, 40);
    if (stem.length >= 5 && t.toLowerCase().includes(stem.toLowerCase())) return true;
    if (name && t.toLowerCase().includes(name.toLowerCase())) return true;

    // Explicit filename chip (not the radio card / help text)
    const chip = [...S().$$("[data-testid], [class*='FileName'], [class*='fileName'], [class*='ia-File'], span, p")].find(
      (el) => {
        if (!S().isVisible(el)) return false;
        const tx = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!/\.(pdf|docx?|rtf|txt)$/i.test(tx) || tx.length > 140) return false;
        if (/Types de fichiers|acceptés|PDF,\s*DOC/i.test(tx)) return false;
        const tid = `${el.getAttribute("data-testid") || ""} ${el.className || ""}`;
        if (/radio|resume-selection-file-resume|card-group/i.test(tid)) return false;
        return true;
      }
    );
    return !!chip;
  }

  function resumeLooksReady() {
    if (resumeUploadErrorVisible()) {
      window.__AmijobsResumeUploadedAt = 0;
      return false;
    }

    // Forced upload path (Indeed CV down): never trust radios or bare input.files
    if (needsForcedCvUpload() || /resume-selection/i.test(smartApplyPath())) {
      if (window.__AmijobsResumeUploadedAt && Date.now() - window.__AmijobsResumeUploadedAt < 120000) {
        return resumeFileUiAccepted(window.__AmijobsResumeFileName || "");
      }
      return resumeFileUiAccepted(window.__AmijobsResumeFileName || "");
    }

    if (window.__AmijobsResumeUploadedAt && Date.now() - window.__AmijobsResumeUploadedAt < 120000) {
      return true;
    }

    for (const input of S().$$('input[type="file"]')) {
      if (input.files && input.files.length > 0) return true;
    }

    if (resumeFileUiAccepted()) return true;

    const checked =
      S().$('input[type="radio"][name*="resume"]:checked') ||
      S().$('[data-testid*="resume"][aria-checked="true"]');
    return !!checked;
  }

  function resumeOptionalWithoutCv() {
    const t = resumePageText();
    return /Postuler sans CV|Apply without (a )?resume|CV est facultatif|resume is optional/i.test(t);
  }

  async function clickResumeIfNeeded() {
    if (resumeLooksReady()) return true;

    // Some Glassdoor→Indeed offers allow continue without a file
    if (resumeOptionalWithoutCv() && !resumeUploadErrorVisible()) {
      const opt =
        S().$('[data-testid*="no-resume"], [data-testid*="without-resume"], [data-testid*="optional-resume"]') ||
        [...S().$$("button, label, [role='button'], [role='radio']")].find((b) =>
          S().isVisible(b) && /Postuler sans CV|Apply without (a )?resume|sans CV/i.test(b.textContent || "")
        );
      if (opt) {
        await S().humanClick(opt);
        await S().sleep(400);
        window.__AmijobsResumeUploadedAt = Date.now();
        window.__AmijobsResumeFileName = window.__AmijobsResumeFileName || "optional-no-cv";
        S().log(PLATFORM, "CV facultatif — Postuler sans CV", "warn");
        return true;
      }
      // Continuer alone is enough when Indeed says CV is optional and no validation error
      if (!needsForcedCvUpload() || /CV est facultatif|resume is optional/i.test(resumePageText())) {
        window.__AmijobsResumeUploadedAt = Date.now();
        window.__AmijobsResumeFileName = "optional-no-cv";
        return true;
      }
    }

    const cvEarly = await S().getCvFile();
    const hasConfiguredCv = !!(cvEarly?.base64);

    // 1) Prefer Indeed-hosted resume radio (fast path when account already has a CV)
    if (!needsForcedCvUpload()) {
      const label =
        S().$('[data-testid="resume-selection-file-resume-radio-card-label"]') ||
        S().$('[data-testid="resume-selection-file-resume-radio-card"]') ||
        S().$('[data-testid="resume-selection-radio-card-group"] label') ||
        S().$('[data-testid*="resume-selection"][data-testid*="radio"] label') ||
        S().$('label[data-testid*="resume"]');
      if (label && S().isVisible(label)) {
        await S().humanClick(label);
        await S().sleep(450);
        if (resumeLooksReady()) return true;
      }
      const radio =
        S().$('[data-testid="resume-selection-file-resume-radio-card-input"]') ||
        S().$('input[type="radio"][name="resume-selection"]') ||
        S().$('input[type="radio"][name*="resume"]') ||
        S().$('input[type="radio"][id*="resume" i]');
      if (radio) {
        try {
          radio.checked = true;
          radio.dispatchEvent(new Event("input", { bubbles: true }));
          radio.dispatchEvent(new Event("change", { bubbles: true }));
          const wrap = radio.closest('[data-testid*="resume"]') || radio.parentElement;
          if (wrap) await S().humanClick(wrap);
        } catch (_e) {
          /* ignore */
        }
        await S().sleep(450);
        if (resumeLooksReady()) return true;
      }
    }

    // 2) File upload path (forced when Indeed CV is down, or radio did not stick)
    if (!hasConfiguredCv) {
      S().log(
        PLATFORM,
        "Aucun CV configuré (Options → CV) — impossible de continuer la candidature Indeed",
        "error"
      );
      return false;
    }
    if (cvEarly?.name) window.__AmijobsResumeFileName = cvEarly.name;
    const ok = await uploadCvFallback();
    if (ok || resumeLooksReady()) return true;
    S().log(PLATFORM, "Échec sélection/upload CV sur resume-selection", "warn");
    return false;
  }

  // Upload AmiJobs CV to hidden file inputs (Indeed FR "Sélectionner un fichier").
  // DataTransfer alone is often ignored by React — CDP file-chooser is the reliable path.
  async function uploadCvFallback() {
    // Never burn CDP on preload / contact / questions — file input only exists on resume-selection
    const path = smartApplyPath();
    if (path && !/resume-selection|resume\/|\/resume/i.test(path) && !resumeUploadErrorVisible()) {
      return false;
    }
    const cv = await S().getCvFile();
    if (!cv?.base64) return false;
    window.__AmijobsResumeFileName = cv.name || "cv.pdf";

    // Already accepted for this wizard — never re-download/upload the same CV in a loop
    if (resumeFileUiAccepted(cv.name) && !resumeUploadErrorVisible()) {
      window.__AmijobsResumeUploadedAt = Date.now();
      return true;
    }
    const cdpTries = window.__AmijobsCvCdpTries || 0;
    if (cdpTries >= 2 && resumeFileUiAccepted(cv.name)) {
      S().log(PLATFORM, "CV déjà présent — skip re-upload", "warn");
      return true;
    }

    // Indeed mounts the file input a beat after the resume step renders. Calling CDP
    // before it exists always returned no_file_input and cost ~8s per job.
    const hasFileInput = () => !!S().$('input[type="file"]');
    if (!hasFileInput()) {
      for (let i = 0; i < 8 && !hasFileInput(); i++) await S().sleep(400);
      if (!hasFileInput()) return false;
    }

    const markAccepted = (label) => {
      window.__AmijobsResumeUploadedAt = Date.now();
      window.__AmijobsResumeFileName = cv.name || window.__AmijobsResumeFileName;
      S().log(PLATFORM, label, "success");
      return true;
    };

    // CDP first when Indeed CV is down — DataTransfer leaves a fake checkmark + red error
    if (needsForcedCvUpload() || resumeUploadErrorVisible()) {
      if (cdpTries >= 2) {
        S().log(PLATFORM, "CDP CV déjà tenté 2× — pas de nouvel upload", "warn");
        return resumeFileUiAccepted(cv.name);
      }
      window.__AmijobsCvCdpTries = cdpTries + 1;
      try {
        S().log(PLATFORM, "Upload CV via debugger (CDP)…", "warn");
        const res = await chrome.runtime.sendMessage({ action: "uploadCvViaDebugger" });
        S().log(
          PLATFORM,
          `CDP: ok=${!!res?.ok} accepted=${!!res?.accepted} name=${res?.hasName ? "yes" : "no"} err=${!!res?.stillError} chooser=${!!res?.viaChooser} reason=${res?.reason || "-"}`,
          res?.accepted ? "success" : "warn"
        );
        if (res?.accepted || (res?.ok && !res?.stillError && res?.hasName)) {
          for (let i = 0; i < 10; i++) {
            if (resumeFileUiAccepted(cv.name)) return markAccepted(`CV importé CDP (${res.name || cv.name})`);
            await S().sleep(400);
          }
          if (!resumeUploadErrorVisible() && res?.hasName) {
            return markAccepted(`CV accepté CDP (${res.name || cv.name})`);
          }
        }
      } catch (e) {
        S().log(PLATFORM, `Upload CDP erreur: ${e?.message || e}`, "warn");
      }
    }

    // Prefer real file inputs; some testids wrap a hidden input
    const candidates = [
      ...S().$$('input[type="file"]'),
      ...S().$$('[data-testid*="resume-upload"], [data-testid*="file-upload"], [data-testid*="FileUpload"]'),
    ];
    const seen = new Set();
    for (const node of candidates) {
      const input =
        node.tagName === "INPUT" && (node.getAttribute("type") || "").toLowerCase() === "file"
          ? node
          : node.querySelector?.('input[type="file"]');
      if (!input || seen.has(input)) continue;
      seen.add(input);
      const ok = await S().uploadCvToFileInput(input);
      if (ok) {
        // Indeed renders the filename async — a single short check fell through to CDP
        // and cost ~40s per job even though this upload had actually worked.
        for (let i = 0; i < 12; i++) {
          await S().sleep(400);
          if (resumeFileUiAccepted(cv.name) && !resumeUploadErrorVisible()) {
            return markAccepted(`CV importé (${cv.name || "fichier"})`);
          }
        }
      }
    }

    // Drop onto upload zone (some Indeed UIs listen for drop, not change)
    try {
      const file = await cvToFile(cv);
      if (file) {
        const zones = [
          ...S().$$("[data-testid*='upload'], [class*='Upload'], [class*='upload']"),
          ...[...S().$$("button, [role='button']")].filter((b) =>
            /^S[ée]lectionner un fichier|Choose (a )?file|Upload/i.test((b.textContent || "").replace(/\s+/g, " ").trim())
          ),
        ];
        for (const zone of zones.slice(0, 4)) {
          const dt = new DataTransfer();
          dt.items.add(file);
          for (const type of ["dragenter", "dragover", "drop"]) {
            zone.dispatchEvent(
              new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
            );
          }
          await S().sleep(700);
          if (resumeFileUiAccepted(cv.name) && !resumeUploadErrorVisible()) {
            return markAccepted(`CV déposé (${cv.name || "fichier"})`);
          }
        }
      }
    } catch (_e) {
      /* ignore */
    }

    // Final CDP attempt if not already tried / previous attempt failed UI check
    if (!resumeFileUiAccepted(cv.name) && (window.__AmijobsCvCdpTries || 0) < 2) {
      window.__AmijobsCvCdpTries = (window.__AmijobsCvCdpTries || 0) + 1;
      try {
        S().log(PLATFORM, "Upload CV via debugger (CDP) retry…", "warn");
        const res = await chrome.runtime.sendMessage({ action: "uploadCvViaDebugger" });
        S().log(
          PLATFORM,
          `CDP retry: ok=${!!res?.ok} accepted=${!!res?.accepted} err=${!!res?.stillError} reason=${res?.reason || "-"}`,
          res?.accepted ? "success" : "warn"
        );
        for (let i = 0; i < 12; i++) {
          if (resumeFileUiAccepted(cv.name)) return markAccepted(`CV importé CDP (${res?.name || cv.name})`);
          await S().sleep(450);
        }
      } catch (e) {
        S().log(PLATFORM, `Upload CDP erreur: ${e?.message || e}`, "warn");
      }
    }

    return resumeFileUiAccepted(cv.name);
  }

  async function cvToFile(cv) {
    if (!cv?.base64) return null;
    try {
      const bin = atob(cv.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], cv.name || "cv.pdf", {
        type: cv.mime || "application/pdf",
        lastModified: Date.now(),
      });
    } catch (_e) {
      return null;
    }
  }

  async function fillRelevantExperienceStep() {
    const profile = await S().getProfile();
    const title = profile.title || jobInfoTitleFallback() || "Développeur";
    const company = profile.company || profile.currentCompany || "Freelance";
    const titleEl = S().$('[data-testid="job-title-input"]') || S().$("#job-title-input");
    const companyEl = S().$('[data-testid="company-name-input"]') || S().$("#company-name-input");
    if (titleEl && S().isVisible(titleEl) && !titleEl.value) await S().humanType(titleEl, title);
    if (companyEl && S().isVisible(companyEl) && !companyEl.value) await S().humanType(companyEl, company);
  }

  function jobInfoTitleFallback() {
    return (
      S().$('[data-testid="ia-JobHeader-headerContainer"]')?.textContent?.trim()?.split("\n")[0] || ""
    );
  }

  function isDisplayed(el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      // Sticky footers can be partially off-screen — allow tiny height
      return rect.width > 2 && rect.height > 2;
    } catch (_e) {
      return false;
    }
  }

  function isSmartApplyChromeOnlyButton(btn) {
    if (!btn) return true;
    const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
    return (
      !text ||
      /^(1 new update|enregistrer et fermer|signaler( un problème)?|retour|back|page d['’]accueil|avis sur les entreprises|estimation de salaire|messages|notifications|mes emplois|entreprises\s*\/|logo indeed|règles de confidentialité|conditions d['’]utilisation)$/i.test(
        text
      ) ||
      /ExitLinkWithModal|midApplyFeedback|gnav-|Logo Indeed/i.test(
        `${btn.getAttribute("data-testid") || ""} ${btn.className || ""} ${btn.getAttribute("aria-label") || ""}`
      )
    );
  }

  /** True when Smart Apply path is mounted but CTAs (Continuer / Déposer) are not yet in DOM. */
  function isSmartApplyShellOnly() {
    const path = String(location.pathname || "");
    if (!/indeedapply|smartapply/i.test(path + location.href)) return false;
    // Disabled Continuer still counts — resume step shows it before CV is accepted
    if (findSubmitButton(true)) return false;
    for (const sel of [
      '[data-testid="continue-button"]',
      '[data-testid^="hp-continue-button"]',
      '[data-testid="resume-selection-continue-button"]',
    ]) {
      for (const el of S().$$(sel)) {
        if (isDisplayed(el)) return false;
      }
    }
    for (const btn of S().$$("button, a[role='button'], [role='button']")) {
      if (!isDisplayed(btn)) continue;
      const text = `${btn.textContent || ""}`.replace(/\s+/g, " ").trim();
      if (/^continuer$/i.test(text) || /^continue$/i.test(text) || /^suivant$/i.test(text)) return false;
    }
    // Resume upload / radio UI counts as real module content
    if (
      document.querySelector(
        'input[type="radio"], input[type="file"], [data-testid*="resume" i], [data-testid*="Resume" i]'
      ) ||
      /Ajoutez un CV|Importer un CV|Upload (a )?resume|Sélectionnez un CV|Add a resume/i.test(
        document.body?.innerText || ""
      )
    ) {
      return false;
    }
    const actionable = [...S().$$("button, a[role='button'], [role='button'], input[type='submit']")].filter(
      (b) => isDisplayed(b) && !isSmartApplyChromeOnlyButton(b)
    );
    return actionable.length === 0;
  }

  function isSmartApplyLoading() {
    const path = String(location.pathname || location.href || "");
    // Review owns its own wait/retry (preview fail → Réessayer, modal → Vérifier).
    // Never soft-deadlock the wizard on lingering "préparation de l'aperçu" copy.
    if (/review/i.test(path)) {
      return false;
    }
    // Narrow loaders only — broad "[class*=Spinner]" / aria-busy matched chrome and blocked forever
    const loaders = [
      '[data-testid="loading-indicator"]',
      '[data-testid="ia-loading"]',
      '[class*="LoadingSpinner"]',
      '[class*="loadingSpinner"]',
      '[class*="ia-Loading"]',
      '[role="progressbar"][aria-busy="true"]',
      'svg[aria-label*="chargement" i]',
      'svg[aria-label*="loading" i]',
    ];
    for (const sel of loaders) {
      const el = S().$(sel);
      if (el && isDisplayed(el)) {
        // If Continuer/Déposer already mounted (even disabled), don't stall
        if (findSubmitButton(true)) return false;
        for (const btn of S().$$("button")) {
          if (!isDisplayed(btn)) continue;
          if (/^continuer$|^continue$|déposer|submit/i.test((btn.textContent || "").trim())) return false;
        }
        return true;
      }
    }
    const t = (document.body?.innerText || "").replace(/\s+/g, " ").toLowerCase();
    if (/chargement en cours|préparation de l['’]aperçu|loading\.\.\.|please wait/i.test(t)) {
      if (findSubmitButton(true)) return false;
      if (/relisez|passez en revue|coordonn[ée]es|d[ée]poser ma candidature/i.test(t)) return false;
      for (const btn of S().$$("button")) {
        if (!isDisplayed(btn)) continue;
        if (/^continuer$|^continue$|déposer|submit/i.test((btn.textContent || "").trim())) return false;
      }
      // Real resume module copy means not a blank loader shell
      if (/ajoutez un cv|importer un cv|upload (a )?resume/i.test(t)) return false;
      return true;
    }
    if (isSmartApplyShellOnly()) return true;
    return false;
  }

  function findSubmitButton(includeDisabled = true) {
    const submitRe = [
      /d[ée]poser\s*(ma|votre)?\s*candidature/i,
      /submit (my )?application/i,
      /soumettre (ma |votre )?candidature/i,
      /envoyer (ma |votre )?candidature/i,
      /send application/i,
      /^soumettre$/i,
      /finalize/i,
      /^d[ée]poser$/i,
      /postuler maintenant/i,
      /^apply now$/i,
      /candidater/i,
      // Live FR review footer sometimes short-labels
      /^postuler$/i,
      /^envoyer$/i,
    ];
    const testIds = [
      '[data-testid="submit-application-button"]',
      '[data-testid="submit-application"]',
      '[data-testid="submit-button"]',
      '[data-testid="indeed-apply-submit"]',
      '[data-testid="ia-submitApplication-footerButton"]',
      '[data-testid="ia-continueButton"]',
      '[data-testid*="submitApplication"]',
      '[data-testid*="SubmitApplication"]',
      '[data-testid*="submitApplication-footer"]',
      '[data-testid*="footerButton" i]',
      'footer button[type="submit"]',
      'button[type="submit"]',
      'button.ia-continueButton[type="submit"]',
      'button.ia-Button--primary[type="submit"]',
    ];
    // IMPORTANT: do NOT use S().isVisible here — it treats disabled as invisible,
    // and Indeed keeps "Déposer" disabled until the captcha UI flips.
    // Also NEVER treat generic primary/continue classes as submit without text match.
    for (const sel of testIds) {
      let nodes = [];
      try {
        nodes = S().$$(sel);
      } catch (_e) {
        continue;
      }
      for (const el of nodes) {
        if (!isDisplayed(el)) continue;
        if (!includeDisabled && (el.disabled || el.getAttribute("aria-disabled") === "true")) continue;
        const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
        if (/enregistrer et fermer|signaler|retour|quitter|1 new update|^continuer$|^continue$|^suivant$/i.test(text)) {
          continue;
        }
        // Generic type=submit / data-testid*submit can match non-apply chrome — require wording when ambiguous
        if (/type="submit"|data-testid\*="submit"|footerButton/i.test(sel) || sel.includes('[data-testid*="submit"]')) {
          if (text && !submitRe.some((p) => p.test(text)) && !/submit|déposer|soumettre|envoyer|apply|postuler/i.test(text)) {
            continue;
          }
        }
        return el;
      }
    }
    // Primary/continue class candidates — TEXT must look like submit
    for (const el of S().$$("button.ia-continueButton, button.ia-Button--primary, button[class*='Primary'], footer button")) {
      if (!isDisplayed(el)) continue;
      if (!includeDisabled && (el.disabled || el.getAttribute("aria-disabled") === "true")) continue;
      const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
      if (!text || /enregistrer et fermer|signaler|retour|quitter|^continuer$|^continue$|^suivant$|^next$/i.test(text)) {
        continue;
      }
      if (submitRe.some((p) => p.test(text))) return el;
    }
    for (const btn of S().$$("button, a[role='button'], input[type='submit'], [role='button']")) {
      if (!isDisplayed(btn)) continue;
      if (!includeDisabled && (btn.disabled || btn.getAttribute("aria-disabled") === "true")) continue;
      const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""} ${btn.value || ""}`
        .replace(/\s+/g, " ")
        .trim();
      if (
        !text ||
        /signaler|fermer|close|exit|options de cv|passer au contenu|enregistrer et fermer|quitter|retour|back|preview|aperçu|1 new update/i.test(
          text
        )
      ) {
        continue;
      }
      if (submitRe.some((p) => p.test(text))) return btn;
    }
    // Sticky footer below the fold: rect can be 0 until we scroll
    for (const btn of S().$$("button, a[role='button'], input[type='submit'], [role='button']")) {
      const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""} ${btn.value || ""}`
        .replace(/\s+/g, " ")
        .trim();
      if (submitRe.some((p) => p.test(text))) return btn;
    }
    return null;
  }

  function hasRecaptchaWidget() {
    return (
      !!document.querySelector(
        'iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey], textarea[name="g-recaptcha-response"]'
      ) || /je ne suis pas un robot|i'?m not a robot|test de validation/i.test(document.body?.innerText || "")
    );
  }

  /**
   * HAR 2026-08-16 review stuck: CreatePreview.reCaptchaKey=null but invisible
   * 6Lcr30sp still mounts (clr). That must NOT block Déposer / force-submit.
   * Only the visible checkbox (6Ldn8Qwp / size=normal / "Je ne suis pas un robot") requires 2captcha.
   */
  function hasVisibleRecaptchaChallenge() {
    const body = document.body?.innerText || "";
    if (/je ne suis pas un robot|i'?m not a robot/i.test(body)) return true;
    if (recaptchaExpiredUi()) return true;
    for (const iframe of document.querySelectorAll('iframe[src*="recaptcha"]')) {
      const src = iframe.getAttribute("src") || "";
      if (/[?&]size=invisible\b/i.test(src)) continue;
      if (/[?&]size=normal\b/i.test(src) || /[?&]type=image\b/i.test(src)) return true;
      // visible Indeed Smart Apply key
      if (/k=6Ldn8Qwp/i.test(src)) return true;
      try {
        const r = iframe.getBoundingClientRect();
        // Invisible badges are tiny; checkbox iframe is ~300x70+
        if (r.width >= 120 && r.height >= 40) return true;
      } catch (_e) {}
    }
    const box = document.querySelector(
      '#recaptcha-anchor, .recaptcha-checkbox, .g-recaptcha[data-size="normal"], [data-sitekey="6Ldn8QwpAAAAAAYahgoiLgJ0lHSu9PRHngswlkls"]'
    );
    if (box) {
      try {
        const r = box.getBoundingClientRect();
        if (r.width > 8 && r.height > 8) return true;
      } catch (_e) {
        return true;
      }
    }
    return false;
  }

  async function acceptReviewDisclaimers() {
    // click-to-call / email alias / legal opt-ins that keep Déposer aria-disabled
    let n = 0;
    for (const box of S().$$('input[type="checkbox"]')) {
      if (!S().isVisible(box) || box.checked || box.disabled) continue;
      const lab =
        `${box.getAttribute("aria-label") || ""} ${
          (box.id && document.querySelector(`label[for="${CSS.escape(box.id)}"]`)?.textContent) || ""
        } ${box.closest("label")?.textContent || ""} ${box.closest('[class*="Disclaimer"], [data-testid*="disclaimer" i]')?.textContent || ""}`.toLowerCase();
      if (
        !lab ||
        /click.?to.?call|appel|opt.?in|disclaimer|j['’]accepte|conditions|confidentialit|indeed email|alias|autoris/i.test(
          lab
        )
      ) {
        try {
          box.click();
          n++;
        } catch (_e) {
          box.checked = true;
          box.dispatchEvent(new Event("change", { bubbles: true }));
          n++;
        }
      }
    }
    if (n) S().log(PLATFORM, `Review: ${n} case(s) disclaimer/opt-in cochée(s)`, "info");
    return n;
  }

  async function dismissSubmitFailModal() {
    const body = (document.body?.innerText || "").replace(/\s+/g, " ");
    // Indeed FR: "Nous rencontrons des difficultés pour envoyer votre candidature"
    if (
      !/difficultés? pour envoyer|unable to (send|submit)|trouble (sending|submitting)|error sending your application|difficultés? à envoyer/i.test(
        body
      )
    ) {
      return false;
    }
    S().log(PLATFORM, "Indeed: échec envoi candidature (modal) — fermeture + nouveau captcha", "warn");
    try {
      if (typeof window.__AmijobsClearRecaptcha === "function") {
        window.__AmijobsClearRecaptcha("submit_fail_modal");
      }
    } catch (_e) {}
    // Prefer closing the modal over "Enregistrer et quitter" (that abandons the job)
    const closeLabels = [
      /^fermer$/i,
      /^close$/i,
      /^ok$/i,
      /^r[ée]essayer$/i,
      /^retry$/i,
      /^dismiss$/i,
    ];
    for (const el of S().$$("button, a[role='button'], [role='button'], [aria-label]")) {
      if (!isDisplayed(el)) continue;
      const t = (el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      if (closeLabels.some((re) => re.test(t))) {
        await S().humanClick(el);
        await S().sleep(900);
        return true;
      }
    }
    // Escape / click backdrop
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } catch (_e) {}
    await S().sleep(600);
    return true;
  }

  async function handleReviewBlockers() {
    const body = (document.body?.innerText || "").replace(/\s+/g, " ");
    // Modal after CreatePreview: employer answers invalid → must go back and fix
    if (
      /v[ée]rifiez vos r[ée]ponses|probl[èe]me est survenu concernant.*(questions|r[ée]ponses)|problem.*(employer|question)/i.test(
        body
      )
    ) {
      for (const el of S().$$("button, a[role='button'], [role='button']")) {
        if (!isDisplayed(el)) continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!/^v[ée]rifier$/i.test(t)) continue;
        S().log(PLATFORM, "Review: réponses employeur invalides — clic Vérifier", "warn");
        await S().humanClick(el);
        await S().sleep(1500);
        return "fix_answers";
      }
    }
    // Preview mosaic failure — Déposer is not mounted until preview succeeds
    if (
      /difficultés? à charger l['’]aperçu|unable to load.*(preview|application)|failed to load.*(preview|aperçu)/i.test(
        body
      )
    ) {
      for (const el of S().$$("button, a[role='button'], [role='button']")) {
        if (!isDisplayed(el)) continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!/^r[ée]essayer$/i.test(t) && !/^retry$/i.test(t)) continue;
        S().log(PLATFORM, "Aperçu candidature en échec — Réessayer", "warn");
        await S().humanClick(el);
        await S().sleep(2500);
        return "retry_preview";
      }
      return "preview_failed";
    }
    if (/préparation de l['’]aperçu|preparing (your )?preview|loading preview/i.test(body) && !findSubmitButton(true)) {
      return "wait_preview";
    }
    return null;
  }

  async function waitForReviewPreviewReady(maxMs = 20000) {
    const start = Date.now();
    let retries = 0;
    while (Date.now() - start < maxMs) {
      if (findSubmitButton(true)) return "ready";
      const block = await handleReviewBlockers();
      if (block === "fix_answers") return "fix_answers";
      if (block === "retry_preview") {
        retries += 1;
        if (retries > 4) return "preview_failed";
        continue;
      }
      if (block === "preview_failed") return "preview_failed";
      if (block === "wait_preview") {
        await S().sleep(500);
        continue;
      }
      // Preview content present even if submit not yet enabled
      if (
        document.querySelector('[data-testid="contactInfoSection"], [data-testid="fullName"], [data-testid="application"]') ||
        /relisez votre candidature|passez en revue|coordonn[ée]es/i.test(document.body?.innerText || "")
      ) {
        await revealReviewSubmitButton({ quick: true });
        if (findSubmitButton(true)) return "ready";
      }
      await S().sleep(350);
    }
    return findSubmitButton(true) ? "ready" : "timeout";
  }

  async function revealReviewSubmitButton(opts = {}) {
    const quick = !!opts.quick;
    // Prefer direct jump to Déposer — full-page scroll loops made review feel stuck
    let btn = findSubmitButton(true);
    if (btn) {
      try {
        btn.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      } catch (_e) {
        try {
          btn.scrollIntoView({ block: "center", inline: "nearest" });
        } catch (_e2) {}
      }
      return btn;
    }
    const scrollAll = () => {
      try {
        window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
      } catch (_e) {}
      const nodes = [
        document.scrollingElement,
        document.documentElement,
        document.body,
        ...document.querySelectorAll(
          'main, [class*="Page"], [class*="scroll"], [class*="Content"], [class*="Footer"], [data-testid*="footer" i]'
        ),
      ];
      for (const el of nodes) {
        if (!el) continue;
        try {
          el.scrollTop = el.scrollHeight;
        } catch (_e2) {}
      }
    };
    scrollAll();
    if (!quick) await S().sleep(120);
    try {
      const foot = document.querySelector(
        'footer, [class*="Footer"], [data-testid*="footer" i], [class*="ia-Footer"], [class*="ApplicationFooter"]'
      );
      foot?.scrollIntoView?.({ block: "end", inline: "nearest", behavior: "instant" });
    } catch (_e2) {}
    btn = findSubmitButton(true);
    if (btn) {
      try {
        btn.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      } catch (_e3) {}
    }
    return btn;
  }

  async function clickReviewSubmit(btn, label = "Clic submit") {
    if (!btn) return false;
    try {
      btn.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    } catch (_e) {
      try {
        btn.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (_e2) {}
    }
    await acceptReviewDisclaimers();
    // HAR 2026-08-16: CreatePreview.reCaptchaKey=null (+ invisible-only) — force enable
    if (!hasVisibleRecaptchaChallenge()) {
      forceEnableClickable(btn);
    }
    S().log(PLATFORM, `${label}: ${(btn.textContent || btn.getAttribute("aria-label") || "").trim().slice(0, 48)}`);
    // Fast click — skip shared humanClick (smooth scroll + 200–500ms)
    try {
      btn.focus?.();
    } catch (_e) {}
    await S().sleep(80 + Math.floor(Math.random() * 60));
    try {
      btn.click();
    } catch (_e) {}
    try {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } catch (_e2) {}
    return true;
  }

  function isSubmitButtonReady(btn) {
    if (!btn || !isDisplayed(btn)) return false;
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
    return true;
  }

  function isRecaptchaWidgetReady() {
    if (!hasVisibleRecaptchaChallenge()) return true;
    if (typeof window.__AmijobsRecaptchaWidgetReady === "function") {
      try {
        return !!window.__AmijobsRecaptchaWidgetReady();
      } catch (_e) {}
    }
    if (!hasFreshRecaptchaToken()) return false;
    const unchecked = document.querySelector(
      '#recaptcha-anchor[aria-checked="false"], .recaptcha-checkbox[aria-checked="false"], span[role="checkbox"][aria-checked="false"]'
    );
    if (unchecked) {
      try {
        const r = unchecked.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) return false;
      } catch (_e) {
        return false;
      }
    }
    return true;
  }

  async function waitForEnabledSubmitButton(maxMs = 8000) {
    const start = Date.now();
    let lastLog = 0;
    let tick = 0;
    const noCaptcha = !hasVisibleRecaptchaChallenge();
    while (Date.now() - start < maxMs) {
      if (tick % 3 === 0) await acceptReviewDisclaimers();
      // Only heavy-scroll when button missing; otherwise re-check readiness quickly
      let btn = findSubmitButton(true);
      if (!btn || tick % 4 === 0) {
        btn = (await revealReviewSubmitButton({ quick: true })) || findSubmitButton(true);
      }
      if (btn) {
        if (noCaptcha) {
          forceEnableClickable(btn);
          if (isDisplayed(btn)) return btn;
        } else if (isSubmitButtonReady(btn) && isRecaptchaWidgetReady()) {
          return btn;
        }
      }
      try {
        const tok = window.__AmijobsRecaptchaToken || "";
        if (tok && typeof window.__AmijobsInjectRecaptchaToken === "function") {
          window.__AmijobsInjectRecaptchaToken(tok);
        }
      } catch (_e) {}
      if (Date.now() - lastLog > 4000) {
        lastLog = Date.now();
        const b = findSubmitButton(true);
        const state = b
          ? `${(b.textContent || "").trim().slice(0, 24)}${b.disabled || b.getAttribute("aria-disabled") === "true" ? "[dis]" : ""}`
          : "aucun";
        S().log(PLATFORM, `Attente Déposer activé… (${state}${noCaptcha ? ", no-captcha/invis-only" : ""})`, "warn");
      }
      tick += 1;
      await S().sleep(220);
    }
    // Last chance: no visible captcha — return disabled button for force-click
    if (noCaptcha) {
      const btn = findSubmitButton(true);
      if (btn) {
        forceEnableClickable(btn);
        return btn;
      }
    }
    return null;
  }

  async function waitForSubmitButton(maxMs = 20000) {
    const start = Date.now();
    let lastLog = 0;
    while (Date.now() - start < maxMs) {
      const btn = findSubmitButton(true);
      if (btn) return btn;
      // Re-inject token — Indeed often mounts Déposer only after callback fires
      try {
        const tok = window.__AmijobsRecaptchaToken || "";
        if (tok && typeof window.__AmijobsInjectRecaptchaToken === "function") {
          window.__AmijobsInjectRecaptchaToken(tok);
        }
        if (typeof window.__AmijobsClickRecaptcha === "function") window.__AmijobsClickRecaptcha();
        else if (typeof window.__AmijobsSolveRecaptcha === "function") {
          /* keep solving path warm */
        }
      } catch (_e) {}
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        const sample = [...S().$$("button")]
          .filter((b) => isDisplayed(b))
          .map((b) => `${(b.textContent || "").trim().slice(0, 24)}${b.disabled ? "[dis]" : ""}`)
          .slice(0, 8)
          .join(" | ");
        S().log(PLATFORM, `Attente bouton Déposer… (${sample || "aucun"})`, "warn");
      }
      await S().sleep(700);
    }
    return null;
  }

  function findVisibleContinueOrSubmit() {
    // Prefer Indeed Smart Apply testids observed in live browser
    const submitEl = findSubmitButton(true);
    if (submitEl) return { el: submitEl, kind: "submit" };

    const testIds = [
      '[data-testid="continue-button"]',
      '[data-testid="submit-application-button"]',
      '[data-testid="submit-application"]',
      '[data-testid^="hp-continue-button"]',
      '[data-testid="resume-selection-continue-button"]',
      '[data-testid*="continue-button" i]',
      '[data-testid*="ContinueButton" i]',
      'button[data-testid*="continue" i]',
      'button.ia-continueButton',
      'button.ia-Button--primary',
    ];
    for (const sel of testIds) {
      for (const el of S().$$(sel)) {
        if (!isDisplayed(el) || el.disabled || el.getAttribute("aria-disabled") === "true") continue;
        const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
        if (/continuer (pour |à )?postuler|continue (to )?apply|company site|site de l/i.test(text)) continue;
        // submit-application* testids → treat as submit even if short label
        if (/submit-application/i.test(sel) || /d[ée]poser|soumettre|submit|envoyer/i.test(text)) {
          return { el, kind: "submit" };
        }
        return { el, kind: "next" };
      }
    }

    const nextRe = [
      /^continue$/i,
      /^continuer$/i,
      /^next$/i,
      /^suivant$/i,
      /^examiner ma candidature$/i,
      /^review my application$/i,
      /^continuer vers l['’]aperçu$/i,
      /^voir l['’]aperçu$/i,
      /^modifier$/i,
      /review( your)?( application)?/i,
      /vérifier/i,
      /examiner/i,
      /enregistrer et continuer/i,
      /save and continue/i,
      /continuer et postuler/i,
    ];

    const buttons = S().$$("button, a[role='button'], input[type='submit'], [role='button']");
    for (const btn of buttons) {
      if (!S().isVisible(btn) || btn.disabled || btn.getAttribute("aria-disabled") === "true") continue;
      const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
      if (
        !text ||
        /signaler|fermer|close|exit|options de cv|passer au contenu|enregistrer et fermer|1 new update|quitter/i.test(
          text
        )
      ) {
        continue;
      }
      if (/continuer (pour |à )?postuler|continue (to )?apply/i.test(text)) continue;
      if (nextRe.some((p) => p.test(text))) return { el: btn, kind: "next" };
    }
    return null;
  }

  function forceEnableClickable(el) {
    if (!el) return;
    try {
      el.disabled = false;
      el.removeAttribute("disabled");
      el.removeAttribute("aria-disabled");
      el.setAttribute("aria-disabled", "false");
      if (el.style) el.style.pointerEvents = "auto";
    } catch (_e) {}
  }

  async function answerFromCvOrAi(label, fieldType, el) {
    const profile = await S().getProfile();
    const fromProfile = String(profile.experience || "").match(/(\d+(?:[.,]\d+)?)/);
    const isExp =
      /antiquit|anciennet[ée]|exp[eé]rience|seniority|années?|ans\b|years?\s*(of\s*)?exp|combien d['’]?ann|de combien/i.test(
        label
      ) || fieldType === "number";
    const forceNumber =
      fieldType === "number" ||
      (S().wantsNumericAnswer && S().wantsNumericAnswer(label, el)) ||
      /nombre|combien|années?|year|ans\b|de combien/i.test(label || "");
    // Credential yes/no from CV text first (before AI invents Oui)
    if (fieldType === "radio" || /avez-vous|dipl[oô]me|certificat|infirmier|titulaire/i.test(label || "")) {
      const Q = window.AmiJobsQuestionPref;
      const prefHit = Q?.findMatchingPreference?.(window.__AmijobsQuestionPreferences || [], label);
      if (prefHit?.answer) return prefHit.answer;
      const yn = S().answerYesNoFromCv?.(label, profile.cvText || "", profile);
      if (yn) return yn;
    }
    if (isExp && fromProfile && Number(fromProfile[1]) > 0) {
      // Never return "1 an" — Indeed FR rejects non-numeric screening answers
      return forceNumber
        ? (S().coerceNumericAnswer ? S().coerceNumericAnswer(fromProfile[1], "3") : fromProfile[1].replace(/\D.*/, ""))
        : fromProfile[1];
    }
    try {
      const res = await chrome.runtime.sendMessage({
        action: "generateAnswer",
        question: label,
        fieldType: forceNumber ? "number" : fieldType || (el?.type === "number" ? "number" : "text"),
        options: [],
        jobInfo: { title: document.title || "", company: "" },
        cvText: profile.cvText || "",
      });
      let ans = String(res?.answer || "").trim();
      if (forceNumber && ans) {
        ans = S().coerceNumericAnswer ? S().coerceNumericAnswer(ans, "3") : (ans.match(/\d+/) || ["3"])[0];
      }
      if (ans && !/^(oui|yes|we|n\/?a|na|none|null)\.?$/i.test(ans)) return ans;
      if (isExp && fromProfile && Number(fromProfile[1]) > 0) {
        return S().coerceNumericAnswer ? S().coerceNumericAnswer(fromProfile[1], "3") : fromProfile[1];
      }
      if (isExp) return "3";
      // Don't default bare Oui on credential questions
      if (/avez-vous|dipl[oô]me|certificat|infirmier/i.test(label || "")) return "Non";
      return ans || "";
    } catch (_e) {
      if (/avez-vous|dipl[oô]me|certificat|infirmier/i.test(label || "")) return "Non";
      return isExp ? "3" : "";
    }
  }

  function isPlaceholderOptionText(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    return /sélectionn|selectionn|select(\s+an)?\s*option|choisir|veuillez|please select|^[-—–·•.\s]+$/i.test(t);
  }

  function selectLooksUnfilled(sel) {
    if (!sel?.options?.length) return true;
    const opt = sel.options[sel.selectedIndex];
    const text = (opt?.label || opt?.text || opt?.textContent || "").trim();
    const val = String(sel.value ?? "").trim();
    if (isPlaceholderOptionText(text)) return true;
    if (!val && sel.selectedIndex <= 0) return true;
    return false;
  }

  function fieldLabelFor(el) {
    const pref = window.AmiJobsQuestionPref;
    if (pref?.extractQuestionText) {
      const extracted = pref.extractQuestionText(el);
      if (extracted) return extracted;
    }
    if (!el) return "";
    const byFor =
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) || "";
    const wrap = el.closest("label")?.textContent || "";
    const aria = el.getAttribute("aria-label") || "";
    const block = el.closest(
      '[class*="question"], [data-testid*="question"], fieldset, .ia-Questions-item, [class*="Question"]'
    );
    const heading =
      block?.querySelector?.("legend, h1, h2, h3, [data-testid*='questionLabel' i]")?.textContent || "";
    const named = block?.querySelector?.("legend")?.textContent || "";
    const pageH1 = /questions|présélection|prescreen/i.test(document.title || "")
      ? S().$("h1, h2")?.textContent || ""
      : "";
    const raw = (heading || named || aria || byFor || wrap || pageH1 || el.getAttribute("name") || "")
      .replace(/\s+/g, " ")
      .trim();
    if (pref?.isYnOptionText?.(raw)) return "";
    return raw.replace(/(\s*(oui|non|yes|no)){1,4}\s*$/gi, "").trim();
  }

  function questionHasNumericError(el) {
    const scope =
      el?.closest?.('[class*="question"], [data-testid*="question"], fieldset, [class*="FormField"], label') ||
      el?.parentElement;
    const text = `${scope?.innerText || ""} ${el?.validationMessage || ""}`;
    return /nombre valide|nombre entier|aucune décimale|doit être un nombre|numeric value|enter a number|decimal number|num[ée]ro d[ée]cimal/i.test(
      text
    );
  }

  async function fixNumericQuestionErrors() {
    let fixed = 0;
    for (const el of S().$$(
      "input[type='text'], input[type='number'], input[type='tel'], input:not([type]), textarea"
    )) {
      if (!S().isVisible(el)) continue;
      const label = fieldLabelFor(el);
      const badVal = String(el.value || "").trim();
      const needsFix =
        (/^number-input/i.test(el.id || "") && !/^\d+(\.\d+)?$/.test(badVal)) ||
        questionHasNumericError(el) ||
        (S().wantsNumericAnswer?.(label, el) && badVal && !/^\d+(\.\d+)?$/.test(badVal)) ||
        (/\d+\s*ans?/i.test(badVal) &&
          /exp[eé]rience|année|year|combien|anciennet|antiquit/i.test(label)) ||
        (/^(oui|non|yes|no)$/i.test(badVal) &&
          (/^number-input/i.test(el.id || "") ||
            /combien|expérience|experience|année|nombre/i.test(label)));
      if (!needsFix) continue;
      const num =
        (S().coerceNumericAnswer && S().coerceNumericAnswer(badVal || (await S().getProfile()).experience || "3")) ||
        (badVal.match(/\d+/) || ["3"])[0];
      S().log(PLATFORM, `Correction nombre: "${badVal}" → "${num}" (${label.slice(0, 40)})`, "warn");
      try {
        el.focus();
        S().setNativeValue(el, "");
        await S().humanType(el, String(num));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        fixed++;
      } catch (_e) {
        S().setNativeValue(el, String(num));
        fixed++;
      }
      await S().sleep(200);
    }
    return fixed;
  }

  function pickSelectOptionText(options, label, profile, preferredAnswer = "") {
    const opts = (options || []).map((o) => String(o || "").trim()).filter(Boolean);
    const real = opts.filter((o) => !isPlaceholderOptionText(o));
    if (!real.length) return opts[0] || "";
    const want = String(preferredAnswer || "").trim();
    const l = String(label || "").toLowerCase();
    const edu = String(profile?.education || want || "").toLowerCase();

    const tryMatch = (candidates) => {
      for (const c of candidates) {
        const hit = real.find((o) => o.toLowerCase() === c) || real.find((o) => o.toLowerCase().includes(c) || c.includes(o.toLowerCase()));
        if (hit) return hit;
      }
      return null;
    };

    if (want) {
      const exact = tryMatch([want.toLowerCase()]);
      if (exact) return exact;
    }

    // Education / diplôme / niveau d'études — prefer Bac+5 / Master
    if (/niveau|[ée]tudes|dipl[oô]me|education|degree|formation|scolaire/i.test(l) || /bac\+|master|licence|dipl[oô]me/i.test(edu)) {
      const prefs = [];
      if (/doctorat|phd/i.test(edu)) prefs.push("doctorat", "phd", "bac+8");
      if (/bac\s*\+?\s*5|master|ingénieur|ingenieur|mba/i.test(edu)) prefs.push("bac +5", "bac+5", "master", "ingénieur", "ingenieur");
      if (/bac\s*\+?\s*4|maîtrise|maitrise/i.test(edu)) prefs.push("bac +4", "bac+4", "maîtrise", "maitrise");
      if (/bac\s*\+?\s*3|licence|bachelor/i.test(edu)) prefs.push("bac +3", "bac+3", "licence", "bachelor");
      if (/bac\s*\+?\s*2|bts|dut|deug/i.test(edu)) prefs.push("bac +2", "bac+2", "bts", "dut");
      if (/bac(?!\s*\+)/i.test(edu)) prefs.push("baccalauréat", "baccalaureat", "bac");
      if (!prefs.length) prefs.push("bac +5", "bac+5", "master", "bac +4", "bac +3", "licence", "bac +2");
      const eduHit = tryMatch(prefs);
      if (eduHit) return eduHit;
      // Prefer highest common degree among options
      const rank = (o) => {
        const t = o.toLowerCase();
        if (/doctorat|phd|bac\s*\+?\s*8/.test(t)) return 80;
        if (/bac\s*\+?\s*5|master|ingénieur|ingenieur|mba/.test(t)) return 50;
        if (/bac\s*\+?\s*4|maîtrise|maitrise/.test(t)) return 40;
        if (/bac\s*\+?\s*3|licence|bachelor/.test(t)) return 30;
        if (/bac\s*\+?\s*2|bts|dut/.test(t)) return 20;
        if (/baccalauréat|baccalaureat|\bbac\b/.test(t)) return 10;
        return 0;
      };
      const ranked = [...real].sort((a, b) => rank(b) - rank(a));
      if (rank(ranked[0]) > 0) return ranked[0];
    }

    if (/antiquit|anciennet|exp[eé]rience|années|seniority|ans\b/i.test(l) && want) {
      const n = want.match(/(\d+)/)?.[1];
      if (n) {
        const hit =
          real.find((o) => new RegExp(`\\b${n}\\b`).test(o)) ||
          real.find((o) => o.includes(n));
        if (hit) return hit;
      }
    }

    return real[0];
  }

  function applyNativeSelectValue(sel, optionText) {
    if (!sel || !optionText) return false;
    const opt = [...sel.options].find((o) => (o.text || o.label || "").trim() === optionText);
    if (!opt) return false;
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
      if (desc?.set) desc.set.call(sel, opt.value);
      else sel.value = opt.value;
    } catch (_e) {
      sel.value = opt.value;
    }
    opt.selected = true;
    sel.selectedIndex = opt.index;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return !selectLooksUnfilled(sel);
  }

  async function fillComboboxTriggers(profile) {
    const triggers = S().$$(
      'button[role="combobox"], [role="combobox"]:not(select), [aria-haspopup="listbox"]'
    );
    for (const trigger of triggers) {
      if (!S().isVisible(trigger)) continue;
      const current = (trigger.textContent || trigger.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      if (current && !isPlaceholderOptionText(current) && trigger.getAttribute("aria-expanded") !== "true") {
        // Already shows a real value
        if (!/sélectionn|select an option|choisir/i.test(current)) continue;
      }
      const label = fieldLabelFor(trigger) || current;
      // Don't invent BTS/engineering diplomas for "titulaire d'un des diplômes" lists
      if (/titulaire|dipl[oô]mes?\s+cit|avez-vous.*(bts|dipl[oô]me)/i.test(label)) {
        continue;
      }
      await S().humanClick(trigger);
      await S().sleep(350);
      let listbox =
        document.querySelector(`[role="listbox"][id="${trigger.getAttribute("aria-controls") || ""}"]`) ||
        document.querySelector('[role="listbox"]');
      for (let wait = 0; wait < 8 && !listbox; wait++) {
        await S().sleep(120);
        listbox = document.querySelector('[role="listbox"]');
      }
      const optionEls = listbox
        ? [...listbox.querySelectorAll('[role="option"], li, [data-value]')]
        : [...document.querySelectorAll('[role="option"]')].filter(S().isVisible);
      const optionTexts = optionEls.map((o) => (o.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
      let preferred = "";
      if (/niveau|[ée]tudes|dipl[oô]me|education|degree/i.test(label)) {
        preferred = profile.education || "Bac+5";
      } else if (/antiquit|anciennet|exp[eé]rience|années|seniority/i.test(label)) {
        preferred = await answerFromCvOrAi(label, "select", trigger);
      } else {
        preferred = (await answerFromCvOrAi(label, "select", trigger)) || "";
      }
      const picked = pickSelectOptionText(optionTexts, label, profile, preferred);
      const target =
        optionEls.find((o) => (o.textContent || "").replace(/\s+/g, " ").trim() === picked) ||
        optionEls.find((o) => !isPlaceholderOptionText((o.textContent || "").trim()));
      if (target) {
        await S().humanClick(target);
        S().log(PLATFORM, `Liste: "${label.slice(0, 48)}" → ${picked}`, "info");
      } else {
        // Keyboard fallback — Indeed listboxes often ignore programmatic option clicks
        try {
          trigger.focus();
          trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
          await S().sleep(80);
          trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          await S().sleep(120);
          const after = (trigger.textContent || "").replace(/\s+/g, " ").trim();
          if (isPlaceholderOptionText(after) || /sélectionn|select an option|choisir/i.test(after)) {
            trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          } else {
            S().log(PLATFORM, `Liste(kbd): "${label.slice(0, 48)}" → ${after.slice(0, 40)}`, "info");
          }
        } catch (_e) {
          try {
            trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          } catch (_e2) {}
        }
      }
      await S().sleep(180);
    }
  }

  function hasUnfilledRequiredQuestions() {
    for (const sel of S().$$("select")) {
      if (!selectLooksUnfilled(sel)) continue;
      const req =
        sel.required ||
        sel.getAttribute("aria-required") === "true" ||
        /\*/.test(fieldLabelFor(sel)) ||
        !!sel.closest('[class*="error"], [aria-invalid="true"]') ||
        /obligatoire|required/i.test(
          sel.closest('[class*="question"], fieldset, .ia-Questions-item')?.textContent || ""
        );
      // Only required/errored selects block Continuer — optional empty selects must not stall mass-apply
      if (req) return true;
    }
    for (const trigger of S().$$('button[role="combobox"], [role="combobox"]:not(select)')) {
      if (!S().isVisible(trigger)) continue;
      const t = (trigger.textContent || "").replace(/\s+/g, " ").trim();
      if (!(isPlaceholderOptionText(t) || /sélectionn|select an option|choisir/i.test(t))) continue;
      const req =
        trigger.getAttribute("aria-required") === "true" ||
        /\*/.test(fieldLabelFor(trigger)) ||
        /obligatoire|required/i.test(
          trigger.closest('[class*="question"], fieldset, .ia-Questions-item')?.textContent || ""
        ) ||
        trigger.closest('[class*="error"], [aria-invalid="true"]');
      if (req) return true;
    }
    // Visible validation errors (incl. numeric screening)
    const err = [...document.querySelectorAll('[class*="error"], [role="alert"], [aria-invalid="true"]')].some(
      (el) =>
        S().isVisible(el) &&
        /sélectionn|select|obligatoire|required|continuer|nombre valide|nombre entier|aucune décimale|doit être un nombre|numeric/i.test(
          el.textContent || ""
        )
    );
    if (err) return true;
    for (const el of S().$$("input[type='text'], input[type='number'], input:not([type]), textarea")) {
      if (!S().isVisible(el)) continue;
      if (questionHasNumericError(el)) return true;
      const req =
        el.required ||
        el.getAttribute("aria-required") === "true" ||
        /\*/.test(fieldLabelFor(el)) ||
        el.getAttribute("aria-invalid") === "true";
      if (!req) continue;
      const v = String(el.value || "").trim();
      if (!v) return true;
      if (/\d+\s*ans?/i.test(v) && /exp[eé]rience|année|combien/i.test(fieldLabelFor(el))) return true;
    }
    // Unchecked required radio groups
    const radioNames = new Set();
    for (const radio of S().$$('input[type="radio"]')) {
      if (!S().isVisible(radio) || !radio.name || radioNames.has(radio.name)) continue;
      radioNames.add(radio.name);
      const group = S().$$(`input[type="radio"][name="${CSS.escape(radio.name)}"]`).filter((r) =>
        S().isVisible(r)
      );
      if (!group.length || group.some((r) => r.checked)) continue;
      const req = group.some(
        (r) =>
          r.required ||
          r.getAttribute("aria-required") === "true" ||
          /\*/.test(fieldLabelFor(r)) ||
          /obligatoire|required/i.test(
            r.closest('[class*="question"], fieldset, .ia-Questions-item')?.textContent || ""
          )
      );
      if (req) return true;
    }
    return false;
  }

  async function fillQuestionsStep() {
    const profile = await S().getProfile();
    const Q = window.AmiJobsQuestionPref;
    window.__AmijobsFilling = true;
    try {
    const isDemographic =
      /demographic/i.test(smartApplyPath()) ||
      /auto-identification|identification volontaire|demographic|equal employment|eeo/i.test(
        document.body?.innerText || ""
      );

    // Demographic / EEO: prefer "ne pas répondre" before inventing answers
    if (isDemographic) {
      for (const el of S().$$("input[type='radio'], input[type='checkbox'], label, [role='option'], button")) {
        if (!S().isVisible(el)) continue;
        const t = `${el.textContent || ""} ${el.value || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
        if (
          /pr[eé]f[eè]re?r? (de )?ne pas|ne (souhaite|d[eé]sire) pas|prefer not|decline|i do not wish|choose not to/i.test(
            t
          )
        ) {
          if (/approuver|accept|confidentialit|privacy|avis de/i.test(t) && !/ne pas/i.test(t)) continue;
          try {
            await S().humanClick(el);
          } catch (_e) {
            try {
              el.click();
            } catch (_e2) {}
          }
          await S().sleep(80);
        }
      }
      // Click short "Approuver" / agree labels
      for (const el of S().$$("label, [role='option'], button, span")) {
        if (!S().isVisible(el)) continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!/^(approuver|j['’]accepte|i agree|accept)$/i.test(t)) continue;
        try {
          await S().humanClick(el);
        } catch (_e) {
          try {
            el.click();
          } catch (_e2) {}
        }
        await S().sleep(80);
      }
      // Privacy / attestation checkboxes unlock "Examiner ma candidature"
      for (const box of S().$$('input[type="checkbox"]')) {
        if (!S().isVisible(box) || box.disabled) continue;
        const lab =
          `${fieldLabelFor(box)} ${box.closest("label")?.textContent || ""} ${
            box.closest('[class*="question"], fieldset')?.textContent || ""
          }`.toLowerCase();
        const needs =
          box.getAttribute("aria-invalid") === "true" ||
          /accept|confidentialit|privacy|j['’]ai lu|d[eé]clare|attest|consent|avis de|approuver|obligatoire/i.test(
            lab
          );
        if (!needs) continue;
        try {
          const labEl =
            (box.id && document.querySelector(`label[for="${CSS.escape(box.id)}"]`)) ||
            box.closest("label") ||
            box;
          await S().humanClick(labEl);
        } catch (_e) {
          try {
            box.click();
          } catch (_e2) {}
        }
        if (!box.checked) {
          try {
            const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
            if (desc?.set) desc.set.call(box, true);
            else box.checked = true;
          } catch (_e) {
            box.checked = true;
          }
          box.dispatchEvent(new Event("click", { bubbles: true }));
          box.dispatchEvent(new Event("input", { bubbles: true }));
          box.dispatchEvent(new Event("change", { bubbles: true }));
        }
      await S().sleep(80);
    }
  }

    // Radios: preferences first, then CV-aware Oui/Non — never invent diplômes
    const radioNames = new Set();
    const cvText = profile.cvText || "";
    for (const radio of S().$$('input[type="radio"]')) {
      if (!S().isVisible(radio) || !radio.name || radioNames.has(radio.name)) continue;
      radioNames.add(radio.name);
      const group = S().$$(`input[type="radio"][name="${CSS.escape(radio.name)}"]`).filter((r) =>
        S().isVisible(r)
      );
      if (!group.length || group.some((r) => r.checked)) continue;
      const qText =
        fieldLabelFor(radio) ||
        radio.closest('[class*="question"], [data-testid*="question"], fieldset, .ia-Questions-item')
          ?.innerText ||
        "";
      const prefHit = Q?.findMatchingPreference?.(window.__AmijobsQuestionPreferences || [], qText);
      const yn =
        (prefHit?.answer && String(prefHit.answer)) ||
        (S().answerYesNoFromCv && S().answerYesNoFromCv(qText, cvText, profile)) ||
        (await answerFromCvOrAi(qText, "radio", radio));
      const wantOui = /^(oui|yes|true|1)$/i.test(String(yn || "").trim());
      const wantNon = /^(non|no|false|0)$/i.test(String(yn || "").trim());
      const labelOf = (r) =>
        `${r.value || ""} ${r.id || ""} ${document.querySelector(`label[for="${r.id}"]`)?.textContent || ""} ${r.closest("label")?.textContent || ""}`;
      let preferred = null;
      if (wantNon) {
        preferred =
          group.find((r) => /non|no|false|0/i.test(labelOf(r))) ||
          group.find((r) => !/oui|yes|true/i.test(labelOf(r)));
      } else if (wantOui) {
        preferred = group.find((r) => /oui|yes|true|1/i.test(labelOf(r)));
      }

      // Soft questions (disponibilité) → Oui; credential unknown → Non
      if (!preferred) {
        const isCred = /dipl[oô]me|certificat|infirmier|permis|habilitation|titulaire|avez-vous/i.test(qText);
        preferred = isCred
          ? group.find((r) => /non|no/i.test(labelOf(r))) || group[group.length - 1]
          : group.find((r) => /oui|yes|disponible/i.test(labelOf(r))) || group[0];
      }
      const chosen =
        wantNon ? "Non" : wantOui ? "Oui" : (preferred?.value || labelOf(preferred) || "?").trim();
      S().log(PLATFORM, `Radio: "${String(qText).slice(0, 70)}" → ${chosen}`, "info");
      if (qText && S().rememberAutoAnswer) S().rememberAutoAnswer(qText, chosen);
      try {
        const lab =
          (preferred.id && document.querySelector(`label[for="${CSS.escape(preferred.id)}"]`)) ||
          preferred.closest("label");
        if (lab) await S().humanClick(lab);
        else preferred.click();
      } catch (_e) {
        preferred.checked = true;
        preferred.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await S().sleep(120);
    }

    // Checkboxes: tick required-looking ones (consent / attestations)
    for (const box of S().$$('input[type="checkbox"]')) {
      if (!S().isVisible(box) || box.checked) continue;
      const lab =
        (box.id && document.querySelector(`label[for="${box.id}"]`)?.textContent) ||
        box.closest("label")?.textContent ||
        box.getAttribute("aria-label") ||
        "";
      if (/obligatoire|required|\*/i.test(lab) || /certif|attest|accept|consent|j['’]ai lu/i.test(lab)) {
        try {
          box.click();
        } catch (_e) {
          box.checked = true;
          box.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await S().sleep(100);
      }
    }

    // Native <select> — also fill visually-hidden selects (Indeed custom UI often keeps them in DOM)
    for (const sel of S().$$("select")) {
      if (!selectLooksUnfilled(sel)) continue;
      // Skip truly detached / display:none without a sibling combobox UI
      const style = window.getComputedStyle(sel);
      const hiddenHard = style.display === "none" && !sel.closest('[class*="question"], form, [role="form"]');
      if (hiddenHard) continue;
      const label = fieldLabelFor(sel);
      const options = [...sel.options].map((o) => (o.text || o.label || "").trim()).filter(Boolean);
      let preferred = "";
      if (/niveau|[ée]tudes|dipl[oô]me|education|degree|formation/i.test(label)) {
        preferred = profile.education || "Bac+5";
      } else if (/antiquit|anciennet|exp[eé]rience|années|seniority/i.test(label)) {
        preferred = await answerFromCvOrAi(label, "select", sel);
      } else {
        preferred = (await answerFromCvOrAi(label || "question", "select", sel)) || "";
      }
      const picked = pickSelectOptionText(options, label, profile, preferred);
      if (picked && applyNativeSelectValue(sel, picked)) {
        S().log(PLATFORM, `Select: "${label.slice(0, 48)}" → ${picked}`, "info");
      } else if (picked) {
        // Retry via selectedIndex
        const idx = options.findIndex((o) => o === picked);
        if (idx >= 0) {
          sel.selectedIndex = idx;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          S().log(PLATFORM, `Select(idx): "${label.slice(0, 48)}" → ${picked}`, "info");
        }
      }
      await S().sleep(100);
    }

    // Custom listbox / combobox (Indeed Smart Apply design system)
    await fillComboboxTriggers(profile);

    // Text / number / date / textarea — use CV/AI for experience / antiquity
    for (const el of S().$$(
      "textarea, input[type='text'], input[type='number'], input[type='date'], input[type='tel'], input:not([type])"
    )) {
      if (!S().isVisible(el)) continue;
      const curVal = String(el.value || "").trim();
      const labelRaw = fieldLabelFor(el) || el.getAttribute("placeholder") || el.id || "";
      const label = labelRaw.toLowerCase();
      const hint = `${label} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
      const numericQ =
        el.type === "number" ||
        /^number-input/i.test(el.id || "") ||
        S().wantsNumericAnswer?.(labelRaw, el) ||
        questionHasNumericError(el) ||
        /de combien|combien d['’]?ann|années?\s*d['’]?exp|years?\s*(of\s*)?exp/i.test(label);
      // Re-fill when value is invalid prose like "1 an"
      if (curVal && !(numericQ && (!/^\d+(\.\d+)?$/.test(curVal) || questionHasNumericError(el)))) {
        continue;
      }
      if (numericQ && curVal) {
        S().setNativeValue(el, "");
      }

      if (S().isDateFieldHint?.(hint, el) || el.type === "date" || /date|naissance|birth|dob|jj\/mm|dd\/mm|xx\/xx|disponib|démarrage|début|debut/i.test(hint)) {
        const dateVal = S().formatDateAnswer?.(profile, el, hint) || "01/09/2026";
        if (el.type === "date") {
          S().setNativeValue(el, dateVal);
        } else {
          await S().humanType(el, dateVal);
        }
      } else if (/url|link|http|linkedin|portfolio|github/i.test(label)) {
        await S().humanType(el, profile.linkedin || "https://www.linkedin.com");
      } else if (/rythme|alternance.*(école|ecole|entreprise)|jours?\s*(école|ecole)/i.test(label)) {
        await S().humanType(el, "2 jours école / 3 jours entreprise");
      } else if (
        numericQ ||
        /antiquit|anciennet[ée]|exp[eé]rience|seniority|année|year|ans\b|poste|previous|précédent/i.test(label)
      ) {
        let answer = await answerFromCvOrAi(labelRaw || "années d'expérience", "number", el);
        answer = S().coerceNumericAnswer ? S().coerceNumericAnswer(answer, "3") : (String(answer).match(/\d+/) || ["3"])[0];
        await S().humanType(el, answer);
        S().log(PLATFORM, `Expérience (nombre): ${answer}`, "info");
      } else if (/salaire|salary|prétention|compensation/i.test(label)) {
        const sal = S().coerceNumericAnswer
          ? S().coerceNumericAnswer(profile.salaryExpectation || "45000", "45000")
          : String(profile.salaryExpectation || "45000").replace(/\D/g, "") || "45000";
        await S().humanType(el, sal);
      } else if (/phone|téléphone|tel/i.test(label)) {
        await S().humanType(el, profile.phone || "0612345678");
      } else {
        const ai = await answerFromCvOrAi(labelRaw || "question candidature", "text", el);
        await S().humanType(el, ai && !/^(we)\.?$/i.test(ai) ? ai : "Oui");
      }
      // React-controlled fields sometimes ignore humanType — native setter + blur
      try {
        const v = String(el.value || "").trim();
        if (!v) {
          const fallback = numericQ ? "3" : "Oui";
          const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (desc?.set) desc.set.call(el, fallback);
          else el.value = fallback;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        }
      } catch (_e) {}
      await S().sleep(120);
    }
    await fixNumericQuestionErrors();

    // contenteditable / Indeed custom text boxes
    for (const el of S().$$('[contenteditable="true"], [role="textbox"]')) {
      if (!S().isVisible(el)) continue;
      const cur = String(el.textContent || el.innerText || "").trim();
      if (cur && cur.length > 1) continue;
      const label = fieldLabelFor(el) || el.getAttribute("aria-label") || "";
      let answer = "Oui";
      if (/exp[eé]rience|année|ans|combien|nombre|year/i.test(label)) answer = "3";
      else if (/salaire|salary/i.test(label)) answer = "45000";
      else {
        const ai = await answerFromCvOrAi(label || "question candidature", "text", el);
        if (ai && !/^(we)\.?$/i.test(ai)) answer = ai;
      }
      try {
        el.focus();
        el.textContent = answer;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: answer }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (_e) {}
      await S().sleep(80);
    }
    } finally {
      await S().sleep(350);
      window.__AmijobsFilling = false;
    }
  }

  function recaptchaExpiredUi() {
    if (typeof window.__AmijobsRecaptchaExpired === "function") {
      try {
        return !!window.__AmijobsRecaptchaExpired();
      } catch (_e) {}
    }
    const t = document.body?.innerText || "";
    return /test de validation a expir[ée]|validation a expir[ée]|expir[ée].*case|verification expired/i.test(t);
  }

  function hasFreshRecaptchaToken() {
    if (recaptchaExpiredUi()) return false;
    // Indeed rejected last inject — do not reuse that token
    if (window.__AmijobsCaptchaRejected && Date.now() - window.__AmijobsCaptchaRejected < 120000) {
      const tok = String(window.__AmijobsRecaptchaToken || "");
      if (tok && tok === window.__AmijobsRejectedToken) return false;
    }
    if (typeof window.__AmijobsHasFreshRecaptchaToken === "function") {
      try {
        return !!window.__AmijobsHasFreshRecaptchaToken();
      } catch (_e) {}
    }
    const token = String(
      window.__AmijobsRecaptchaToken ||
        document.querySelector('textarea[name="g-recaptcha-response"]')?.value ||
        ""
    );
    // CapSolver junk (~522 HF…) must not pass as "fresh"
    if (token.length < 200) return false;
    if (/^HF[A-Za-z0-9_-]+$/.test(token) && token.length < 1000) return false;
    return /^(03A|0cA|03a)/i.test(token) || token.length >= 1000;
  }

  function readNativeRecaptchaToken() {
    try {
      const t = String(
        document.querySelector('textarea[name="g-recaptcha-response"]')?.value ||
          document.querySelector("#g-recaptcha-response")?.value ||
          ""
      );
      if (t.length >= 200 && !(/^HF[A-Za-z0-9_-]+$/.test(t) && t.length < 1000)) return t;
    } catch (_e) {}
    return "";
  }

  async function waitAndSolveRecaptcha(maxMs = 240000) {
    const start = Date.now();
    const hasWidget = () =>
      !!document.querySelector(
        'iframe[src*="recaptcha"][src*="size=normal"], iframe[src*="recaptcha"][src*="type=image"], .g-recaptcha[data-size="normal"], #recaptcha-anchor'
      ) || /je ne suis pas un robot|i'?m not a robot|test de validation/i.test(document.body?.innerText || "");

    if (!hasWidget() && !hasVisibleRecaptchaChallenge()) return true;

    // Drop solver-injected / rejected junk — only native Google tokens are safe on Indeed
    if (recaptchaExpiredUi() || window.__AmijobsCaptchaRejected) {
      try {
        if (typeof window.__AmijobsClearRecaptcha === "function") {
          window.__AmijobsClearRecaptcha(window.__AmijobsCaptchaRejected ? "indeed_rejected" : "expired_ui");
        }
      } catch (_e) {}
      window.__AmijobsCaptchaRejected = 0;
      window.__AmijobsRejectedToken = "";
    }

    // Already have a native-looking token
    {
      const native = readNativeRecaptchaToken();
      if (native) {
        try {
          if (typeof window.__AmijobsInjectRecaptchaToken === "function") {
            window.__AmijobsInjectRecaptchaToken(native);
          }
        } catch (_e) {}
        if (!window.__AmijobsRecaptchaFreshLogged) {
          window.__AmijobsRecaptchaFreshLogged = true;
          S().log(PLATFORM, "reCAPTCHA OK (navigateur) — dépôt candidature", "success");
        }
        return true;
      }
    }

    // Manual only: same IP + fingerprint as the user's Indeed session (no CapSolver/2captcha)
    S().log(
      PLATFORM,
      "reCAPTCHA Indeed — mode manuel (même IP que votre navigateur). Cochez « Je ne suis pas un robot »",
      "warn"
    );
    try {
      chrome.runtime.sendMessage({ action: "openPopup" }).catch(() => {});
    } catch (_e) {}
    try {
      const frame = document.querySelector(
        'iframe[src*="recaptcha"][src*="size=normal"], iframe[title*="reCAPTCHA" i], .g-recaptcha'
      );
      frame?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "instant" });
    } catch (_e) {}

    let tick = 0;
    let reminded = false;
    while (Date.now() - start < maxMs) {
      if (shouldStop) return false;

      if (recaptchaExpiredUi()) {
        try {
          if (typeof window.__AmijobsClearRecaptcha === "function") window.__AmijobsClearRecaptcha("expired_loop");
        } catch (_e) {}
        if (!reminded) {
          S().log(PLATFORM, "reCAPTCHA expiré — cochez à nouveau la case", "warn");
          reminded = true;
        }
      }

      const native = readNativeRecaptchaToken();
      if (native) {
        try {
          if (typeof window.__AmijobsInjectRecaptchaToken === "function") {
            window.__AmijobsInjectRecaptchaToken(native);
          }
        } catch (_e) {}
        S().log(PLATFORM, "reCAPTCHA coché — reprise du dépôt", "success");
        await S().sleep(250);
        return true;
      }

      // Also accept helper state if user solved and inject already ran
      if (hasFreshRecaptchaToken() && !window.__AmijobsCaptchaRejected) {
        S().log(PLATFORM, "reCAPTCHA token navigateur — dépôt candidature", "success");
        await S().sleep(250);
        return true;
      }

      if (tick % 4 === 0) {
        try {
          await chrome.storage.local.set({
            indeedWizardBusy: {
              at: Date.now(),
              path: smartApplyPath(),
              title: window.__AmijobsCurrentJobTitle || "",
            },
          });
          await chrome.runtime.sendMessage({
            action: "acquireSmartApplyLock",
            owner: "indeed",
            handoff: !!window.__AmijobsWizardIsHandoff,
          });
        } catch (_e) {}
      }
      if (tick > 0 && tick % 20 === 0) {
        S().log(PLATFORM, "En attente du clic reCAPTCHA…", "warn");
      }
      tick += 1;
      await S().sleep(1000);
    }
    S().log(PLATFORM, "reCAPTCHA non coché à temps", "warn");
    return !!readNativeRecaptchaToken();
  }

  async function runApplyWizard(jobInfo, settings) {
    if (!isTopAutomationFrame()) {
      return { success: false, reason: "iframe_skip" };
    }
    if (isLoginWallPage()) {
      S().log(PLATFORM, "Indeed demande une reconnexion — offre abandonnée", "error");
      await chrome.runtime
        .sendMessage({ action: "indeedLoginWall", url: window.location.href })
        .catch(() => {});
      return { success: false, reason: "login_wall" };
    }
    if (!isSmartApplyPage()) {
      S().log(PLATFORM, "Wizard ignoré (pas une page Smart Apply)", "warn");
      return { success: false, reason: "not_smartapply" };
    }
    S().log(PLATFORM, `Assistant Smart Apply — ${smartApplyPath()}`);
    window.__AmijobsCvCdpTries = 0;
    window.__AmijobsCurrentJobTitle = jobInfo?.title || "";
    window.__AmijobsSubmitApplicationOk = 0;
    try {
      const { sessionIndeed: sOwner = null, sessionGlassdoor: sGd = null } =
        await chrome.storage.local.get(["sessionIndeed", "sessionGlassdoor"]);
      // Dual mode: Indeed's own session stays active, so fromGlassdoor is often false —
      // still treat Glassdoor awaitingIndeed as a handoff for lock heartbeats.
      window.__AmijobsWizardIsHandoff = !!(sOwner?.fromGlassdoor || sGd?.awaitingIndeed);
    } catch (_e) {
      window.__AmijobsWizardIsHandoff = false;
    }
    try {
      await chrome.storage.local.set({
        indeedWizardBusy: { at: Date.now(), path: smartApplyPath(), title: jobInfo?.title || "" },
      });
    } catch (_e) {}
    let resumeContinueClicks = 0;
    let resumeUploadAttempts = 0;
    let incompleteQuestionsTries = 0;
    let reviewCaptchaAttempts = 0;
    const MAX_REVIEW_CAPTCHA = 4;
    try {
    for (let step = 0; step < 80; step++) {
      try {
      if (shouldStop) return { success: false, reason: "stopped" };
      if (/hrtechprivacy\.com|privacy opt out|requests\.hrtechprivacy/i.test(location.href)) {
        S().log(PLATFORM, "Redirection privacy Indeed — retour Smart Apply", "warn");
        try {
          history.back();
        } catch (_e) {}
        await S().sleep(1200);
        continue;
      }
      if (detectApplySuccess()) return { success: true };

      // Keep busy flag + Smart Apply lock fresh so Glassdoor doesn't steal mid-wizard
      if (step % 5 === 0) {
        try {
          await chrome.storage.local.set({
            indeedWizardBusy: { at: Date.now(), path: smartApplyPath(), title: jobInfo?.title || "" },
          });
          await chrome.runtime.sendMessage({
            action: "acquireSmartApplyLock",
            owner: "indeed",
            handoff: !!window.__AmijobsWizardIsHandoff,
          });
        } catch (_e) {}
      }

      // reCAPTCHA only on review — don't burn 2captcha on every wizard step
      try {
        if (typeof window.__AmijobsClickTurnstile === "function") window.__AmijobsClickTurnstile();
        if (typeof window.__AmijobsSolveTurnstile === "function") window.__AmijobsSolveTurnstile();
      } catch (_e) {}

      const path = smartApplyPath();
      // Do NOT click / pre-solve reCAPTCHA here — early tokens expire before submit
      // ("Le test de validation a expiré"). waitAndSolveRecaptcha handles it below.
      // Wait for SPA loaders / empty chrome shell (only "Enregistrer et fermer" + "1 new update")
      if (isSmartApplyLoading()) {
        window.__AmijobsShellWait = (window.__AmijobsShellWait || 0) + 1;
        if (window.__AmijobsShellWait % 3 === 1) {
          S().log(
            PLATFORM,
            `Chargement Smart Apply… (${path.split("/").pop() || path}, wait=${window.__AmijobsShellWait})`,
            "warn"
          );
        }
        // applybyapplyablejobid often hangs as empty chrome — soft reload once, then skip
        const onApplyableShell = /applybyapplyablejobid/i.test(path);
        const shellLimit = onApplyableShell ? 18 : 45;
        if (onApplyableShell && window.__AmijobsShellWait === 8 && !window.__AmijobsApplyableReloaded) {
          window.__AmijobsApplyableReloaded = true;
          S().log(PLATFORM, "applybyapplyablejobid vide — soft reload", "warn");
          try {
            location.reload();
          } catch (_e) {}
          await S().sleep(2500);
          continue;
        }
        if (window.__AmijobsShellWait > shellLimit) {
          S().log(PLATFORM, "Smart Apply shell vide trop longtemps — abandon offre", "error");
          window.__AmijobsApplyableReloaded = false;
          return { success: false, reason: "wizard_shell_timeout" };
        }
        await S().sleep(onApplyableShell ? 1100 : 1400);
        continue;
      }
      window.__AmijobsShellWait = 0;
      window.__AmijobsApplyableReloaded = false;
      const loader = S().$('[data-testid="loading-indicator"], [class*="LoadingSpinner"], [aria-busy="true"]');
      if (loader && S().isVisible(loader)) {
        await S().sleep(1800);
        continue;
      }

      if (/profile-location/i.test(path)) {
        await fillProfileLocationStep();
      }
      if (/resume-selection/i.test(path)) {
        const cvMeta = await S().getCvFile();
        if (cvMeta?.name) window.__AmijobsResumeFileName = cvMeta.name;
        const ready = await clickResumeIfNeeded();
        const fileOk = resumeFileUiAccepted(cvMeta?.name || "");
        const radioOk = resumeLooksReady() && !needsForcedCvUpload();
        if (!ready) {
          if (!cvMeta?.base64 && !resumeOptionalWithoutCv()) {
            S().log(PLATFORM, "Skip — aucun CV configuré (Options → CV)", "error");
            return { success: false, reason: "no_cv_file" };
          }
          resumeUploadAttempts += 1;
          if (resumeUploadAttempts > 10) {
            S().log(PLATFORM, "Upload CV impossible après plusieurs essais — abandon offre", "error");
            return { success: false, reason: "resume_upload_failed" };
          }
          // Don't spam Continuer — Indeed shows "Sélectionnez un fichier pour continuer"
          S().log(PLATFORM, `Attente upload CV (essai ${resumeUploadAttempts}) — pas de Continuer`, "warn");
          if (cvMeta?.base64) await uploadCvFallback();
          await S().sleep(1500);
          continue;
        }
        // Accept Indeed radio OR uploaded filename UI
        if (resumeUploadErrorVisible() || (!fileOk && !radioOk)) {
          S().log(PLATFORM, "CV pas encore accepté par Indeed — skip Continuer", "warn");
          await S().sleep(1000);
          continue;
        }
        const cont =
          S().$('[data-testid="resume-selection-continue-button"]') ||
          S().$('[data-testid="continue-button"]') ||
          [...S().$$("button")].find(
            (b) =>
              isDisplayed(b) &&
              /^(continuer|continue|suivant|next)$/i.test((b.textContent || "").trim())
          );
        if (cont && S().isVisible(cont) && !cont.disabled) {
          if (resumeContinueClicks >= 6) {
            S().log(PLATFORM, "Resume-selection bloqué après plusieurs Continuer — abandon offre", "error");
            return { success: false, reason: "resume_stuck" };
          }
          resumeContinueClicks += 1;
          const before = smartApplyPath();
          S().log(PLATFORM, `Clic Continuer (CV) #${resumeContinueClicks}`);
          await S().humanClick(cont);
          await S().sleep(2200);
          // If validation error / still on same step, force re-upload next loop
          if (/resume-selection/i.test(smartApplyPath())) {
            if (resumeUploadErrorVisible() || !resumeFileUiAccepted(cvMeta?.name || "")) {
              S().log(PLATFORM, "Toujours sur CV après Continuer — re-upload CDP", "warn");
              window.__AmijobsResumeUploadedAt = 0;
              await uploadCvFallback();
            } else if (smartApplyPath() === before) {
              // Filename visible but step stuck — click Continuer again, do NOT re-download CV
              S().log(PLATFORM, "CV accepté mais étape inchangée — nouvel essai Continuer (sans re-upload)", "warn");
            }
          } else {
            resumeContinueClicks = 0;
            resumeUploadAttempts = 0;
            window.__AmijobsCvCdpTries = 0;
          }
          continue;
        }
      } else {
        resumeContinueClicks = 0;
      }
      if (/relevant-experience/i.test(path)) {
        await fillRelevantExperienceStep();
      }
      if (/questions|demographic/i.test(path)) {
        await fillQuestionsStep();
        if (hasUnfilledRequiredQuestions() && !/demographic/i.test(path)) {
          incompleteQuestionsTries += 1;
          S().log(PLATFORM, "Questions incomplètes — correction (nombre/select)", "warn");
          await fixNumericQuestionErrors();
          await fillQuestionsStep();
          await S().sleep(700);
          if (hasUnfilledRequiredQuestions()) {
            await fixNumericQuestionErrors();
            await S().sleep(900);
            if (incompleteQuestionsTries >= 8) {
              S().log(
                PLATFORM,
                "Questions bloquées après plusieurs essais — offre ignorée",
                "error"
              );
              return { success: false, reason: "questions_stuck" };
            }
            continue;
          }
        } else {
          // Required fields look filled — still count Continuer-disabled stalls
          incompleteQuestionsTries = Math.max(0, incompleteQuestionsTries);
        }
        // Always attempt Continuer after a fill pass — even if some optional fields look empty
        const qContinue = findVisibleContinueOrSubmit();
        if (qContinue?.kind === "next" || (qContinue?.el && /questions|demographic/i.test(path))) {
          const btn = qContinue.el;
          if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
            incompleteQuestionsTries += 1;
            if (!hasUnfilledRequiredQuestions() || incompleteQuestionsTries >= 2) {
              forceEnableClickable(btn);
            }
          }
          if (!btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
            const beforeQ = smartApplyPath();
            await S().humanClick(btn);
            try {
              btn.click();
            } catch (_e) {}
            await S().sleep(
              S().randomDelay(settings.delayBetweenSteps?.min || 500, settings.delayBetweenSteps?.max || 1400)
            );
            // Continuer clicked but same questions URL — try Enter / requestSubmit
            if (/questions/i.test(smartApplyPath()) && smartApplyPath() === beforeQ) {
              try {
                btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
                const form = btn.closest("form") || document.querySelector("form");
                if (form?.requestSubmit) form.requestSubmit();
              } catch (_e) {}
              await S().sleep(900);
            }
            continue;
          }
        } else if (/questions/i.test(path)) {
          incompleteQuestionsTries += 1;
        }
        // Soft advance after enough fill attempts even if Continuer stays disabled
        if (incompleteQuestionsTries >= 3) {
          const anyNext =
            findVisibleContinueOrSubmit()?.el ||
            [...S().$$("button")].find((b) =>
              /^continuer$|^continue$|^suivant$|^next$/i.test((b.textContent || "").trim())
            );
          if (anyNext) {
            forceEnableClickable(anyNext);
            await S().humanClick(anyNext);
            try {
              anyNext.click();
              anyNext.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
              const form = anyNext.closest("form") || document.querySelector("form");
              if (form?.requestSubmit) form.requestSubmit();
            } catch (_e) {}
            await S().sleep(1200);
            incompleteQuestionsTries += 1;
            if (incompleteQuestionsTries >= 8) {
              return { success: false, reason: "questions_stuck" };
            }
            continue;
          }
        }
      } else {
        await S().fillVisibleFields(jobInfo, PLATFORM);
        await fixNumericQuestionErrors();
      }

      // Review / captcha step: solve FRESH then submit (HAR: reCaptchaKey often null on FR)
      const onReviewLike =
        /review/i.test(path) ||
        (!!hasRecaptchaWidget() && !!findSubmitButton(true)) ||
        /relisez votre candidature|passez en revue le contenu/i.test(document.body?.innerText || "");
      if (onReviewLike) {
        window.__AmijobsReviewMisses = window.__AmijobsReviewMisses || 0;
        if (reviewCaptchaAttempts >= MAX_REVIEW_CAPTCHA) {
          S().log(PLATFORM, "reCAPTCHA review bloqué — abandon offre", "error");
          return { success: false, reason: "captcha_stuck" };
        }

        const previewState = await waitForReviewPreviewReady(18000);
        if (previewState === "fix_answers") {
          incompleteQuestionsTries += 1;
          if (incompleteQuestionsTries >= 8) {
            return { success: false, reason: "questions_stuck" };
          }
          continue;
        }
        if (previewState === "preview_failed" || previewState === "timeout") {
          window.__AmijobsReviewMisses += 1;
          await acceptReviewDisclaimers();
          await revealReviewSubmitButton();
          // Button may mount late after CreatePreview even when wait timed out
          const lateBtn = findSubmitButton(true);
          if (lateBtn) {
            S().log(PLATFORM, "Déposer apparu après timeout aperçu — poursuite", "warn");
          } else {
            S().log(
              PLATFORM,
              `Aperçu review non prêt (${previewState}, miss=${window.__AmijobsReviewMisses})`,
              "warn"
            );
            if (window.__AmijobsReviewMisses >= 6) {
              return { success: false, reason: "preview_failed" };
            }
            await S().sleep(1500);
            continue;
          }
        }

        // No VISIBLE captcha (CreatePreview.reCaptchaKey=null / invisible-only) — force Déposer
        if (!hasVisibleRecaptchaChallenge()) {
          await acceptReviewDisclaimers();
          let submitBtn = (await waitForEnabledSubmitButton(5000)) || (await revealReviewSubmitButton({ quick: true }));
          if (submitBtn && settings.autoSubmit !== false) {
            S().log(PLATFORM, "Review sans captcha visible (invis-only OK) — force Déposer", "warn");
            await clickReviewSubmit(submitBtn, "Clic submit (no-captcha)");
            await S().sleep(1200);
            for (let i = 0; i < 14; i++) {
              if (detectApplySuccess() || /post-apply/i.test(smartApplyPath())) return { success: true };
              await S().sleep(700);
            }
            if (detectApplySuccess() || /post-apply/i.test(smartApplyPath())) return { success: true };
            window.__AmijobsReviewMisses += 1;
            if (window.__AmijobsReviewMisses >= 6) {
              S().log(PLATFORM, "Review no-captcha sans confirmation — abandon offre", "error");
              return { success: false, reason: "submit_no_confirm" };
            }
            continue;
          }
          window.__AmijobsReviewMisses += 1;
          S().log(
            PLATFORM,
            `Bouton Déposer introuvable (path=${smartApplyPath()}, miss=${window.__AmijobsReviewMisses}) — boutons: ${[
              ...S().$$("button"),
            ]
              .filter((b) => isDisplayed(b))
              .map((b) => {
                const t = (b.textContent || "").trim().slice(0, 28);
                return `${t}${b.disabled || b.getAttribute("aria-disabled") === "true" ? "[dis]" : ""}`;
              })
              .slice(0, 10)
              .join(" | ")}`,
            "warn"
          );
          if (window.__AmijobsReviewMisses >= 8) {
            return { success: false, reason: "submit_button_missing" };
          }
          await S().sleep(1200);
          continue;
        }
        for (let captchaTry = 0; captchaTry < 3; captchaTry++) {
          const ok = await waitAndSolveRecaptcha(150000);
          if (!ok) break;
          reviewCaptchaAttempts += 1;
          // Wait briefly for Indeed to enable Déposer — click ASAP once ready
          let submitBtn = (await waitForEnabledSubmitButton(6000)) || findSubmitButton(true);
          if (!submitBtn || !isSubmitButtonReady(submitBtn) || !isRecaptchaWidgetReady()) {
            submitBtn = await waitForEnabledSubmitButton(3500);
          }
          if (!submitBtn || settings.autoSubmit === false) {
            if (!submitBtn) {
              window.__AmijobsReviewMisses += 1;
              S().log(
                PLATFORM,
                `Bouton Déposer introuvable (path=${smartApplyPath()}, miss=${window.__AmijobsReviewMisses}) — boutons: ${[
                  ...S().$$("button"),
                ]
                  .filter((b) => isDisplayed(b))
                  .map((b) => {
                    const t = (b.textContent || "").trim().slice(0, 28);
                    return `${t}${b.disabled || b.getAttribute("aria-disabled") === "true" ? "[dis]" : ""}`;
                  })
                  .slice(0, 8)
                  .join(" | ")}`,
                "warn"
              );
              if (window.__AmijobsReviewMisses >= 8) {
                S().log(PLATFORM, "Review sans Déposer après plusieurs essais — abandon offre", "error");
                return { success: false, reason: "submit_button_missing" };
              }
            }
            break;
          }
          window.__AmijobsReviewMisses = 0;
          try {
            const tok = window.__AmijobsRecaptchaToken || "";
            if (tok && typeof window.__AmijobsInjectRecaptchaToken === "function") {
              window.__AmijobsInjectRecaptchaToken(tok);
            }
          } catch (_e) {}
          // Re-check expiry right before click (token can die while waiting)
          if (recaptchaExpiredUi() || !hasFreshRecaptchaToken() || !isRecaptchaWidgetReady()) {
            S().log(PLATFORM, `reCAPTCHA pas prêt avant submit — retry ${captchaTry + 1}/3`, "warn");
            try {
              if (typeof window.__AmijobsClearRecaptcha === "function") window.__AmijobsClearRecaptcha("pre_submit");
            } catch (_e2) {}
            continue;
          }
          await clickReviewSubmit(submitBtn);
          await S().sleep(1100);
          for (let i = 0; i < 12; i++) {
            if (detectApplySuccess() || /post-apply/i.test(smartApplyPath())) return { success: true };
            if (await dismissSubmitFailModal()) {
              S().log(PLATFORM, "Submit rejeté par Indeed — nouveau token captcha", "warn");
              break;
            }
            if (recaptchaExpiredUi()) {
              S().log(PLATFORM, "reCAPTCHA expiré après submit — nouveau token", "warn");
              try {
                if (typeof window.__AmijobsClearRecaptcha === "function") window.__AmijobsClearRecaptcha("post_submit");
              } catch (_e2) {}
              break;
            }
            await S().sleep(700);
          }
          if (detectApplySuccess() || /post-apply/i.test(smartApplyPath())) return { success: true };
          if (!recaptchaExpiredUi() && /review/i.test(smartApplyPath())) {
            // Still on review but not expired — don't loop forever
            break;
          }
        }
      }

      // Never advance resume-selection without a file/radio accepted
      if (/resume-selection/i.test(smartApplyPath()) && !resumeLooksReady()) {
        await clickResumeIfNeeded();
        await S().sleep(900);
        continue;
      }

      let action = findVisibleContinueOrSubmit();
      if (!action && onReviewLike) {
        const sb = findSubmitButton(true);
        if (sb) action = { el: sb, kind: "submit" };
      }
      if (!action) {
        if (onReviewLike) {
          await waitAndSolveRecaptcha(150000);
          const sb = (await waitForEnabledSubmitButton(5000)) || findSubmitButton(true);
          if (sb && isDisplayed(sb) && settings.autoSubmit !== false && (!hasVisibleRecaptchaChallenge() || (hasFreshRecaptchaToken() && isRecaptchaWidgetReady()))) {
            S().log(PLATFORM, `Clic submit (retry): ${(sb.textContent || "").trim().slice(0, 40)}`);
            await clickReviewSubmit(sb, "Clic submit (retry)");
            await S().sleep(1100);
            if (detectApplySuccess() || /post-apply/i.test(smartApplyPath())) return { success: true };
          }
          window.__AmijobsReviewMisses = (window.__AmijobsReviewMisses || 0) + 1;
          if (window.__AmijobsReviewMisses >= 8) {
            return { success: false, reason: "submit_button_missing" };
          }
          await S().sleep(1200);
          continue;
        }
        if (/questions/i.test(path)) {
          await fillQuestionsStep();
          await S().sleep(900);
          continue;
        }
        await S().sleep(900);
        if (detectApplySuccess()) return { success: true };
        continue;
      }

      if (action.kind === "submit") {
        const captchaOk = await waitAndSolveRecaptcha(150000);
        if (!captchaOk) {
          S().log(PLATFORM, "Submit bloqué — captcha non résolu", "warn");
          await S().sleep(1500);
          continue;
        }
        if (recaptchaExpiredUi() || !hasFreshRecaptchaToken()) {
          S().log(PLATFORM, "Submit bloqué — captcha expiré, re-solve…", "warn");
          try {
            if (typeof window.__AmijobsClearRecaptcha === "function") window.__AmijobsClearRecaptcha("submit_gate");
          } catch (_e) {}
          continue;
        }
        // Re-inject token right before click (MAIN world)
        try {
          const tok = window.__AmijobsRecaptchaToken || "";
          if (tok && typeof window.__AmijobsInjectRecaptchaToken === "function") {
            window.__AmijobsInjectRecaptchaToken(tok);
          }
        } catch (_e) {}
        if (settings.autoSubmit !== false) {
          if (hasVisibleRecaptchaChallenge() && (!isSubmitButtonReady(action.el) || !isRecaptchaWidgetReady())) {
            await S().sleep(1200);
            continue;
          }
          await clickReviewSubmit(action.el, "Clic submit");
          await S().sleep(1200);
          for (let i = 0; i < 16; i++) {
            if (detectApplySuccess()) return { success: true };
            if (/post-apply/i.test(smartApplyPath())) return { success: true };
            if (await dismissSubmitFailModal()) {
              S().log(PLATFORM, "Submit rejeté — clear captcha et nouvel essai", "warn");
              break;
            }
            // Captcha expired / cleared after failed submit — force fresh 2captcha
            if (
              document.querySelector('iframe[src*="recaptcha"]') &&
              /review/i.test(smartApplyPath()) &&
              (recaptchaExpiredUi() || !hasFreshRecaptchaToken())
            ) {
              try {
                if (typeof window.__AmijobsClearRecaptcha === "function") {
                  window.__AmijobsClearRecaptcha("post_submit_loop");
                }
              } catch (_e) {}
              await waitAndSolveRecaptcha(90000);
              const again = findVisibleContinueOrSubmit();
              if (again?.kind === "submit" && hasFreshRecaptchaToken() && !recaptchaExpiredUi()) {
                try {
                  const tok = window.__AmijobsRecaptchaToken || "";
                  if (tok && typeof window.__AmijobsInjectRecaptchaToken === "function") {
                    window.__AmijobsInjectRecaptchaToken(tok);
                  }
                } catch (_e) {}
                await S().humanClick(again.el);
              }
            }
            await S().sleep(700);
          }
          if (/post-apply/i.test(smartApplyPath())) return { success: true };
          // Still on review after clicks → don't fake success
          if (/review/i.test(smartApplyPath())) {
            reviewCaptchaAttempts += 1;
            if (reviewCaptchaAttempts >= MAX_REVIEW_CAPTCHA) {
              return { success: false, reason: "captcha_stuck" };
            }
            S().log(PLATFORM, "Submit review sans confirmation — nouvel essai captcha", "warn");
            try {
              if (typeof window.__AmijobsClearRecaptcha === "function") window.__AmijobsClearRecaptcha("no_confirm");
            } catch (_e) {}
            continue;
          }
          return { success: true, reason: "submitted" };
        }
        return { success: false, reason: "review" };
      }

      if (action.el.disabled || action.el.getAttribute("aria-disabled") === "true") {
        if (/questions/i.test(path)) await fillQuestionsStep();
        if (onReviewLike || action.kind === "submit") {
          await waitAndSolveRecaptcha(150000);
          if (hasFreshRecaptchaToken() && isRecaptchaWidgetReady() && isSubmitButtonReady(action.el) && action.kind === "submit" && settings.autoSubmit !== false) {
            S().log(PLATFORM, `Clic submit (unlock): ${(action.el.textContent || "").trim().slice(0, 40)}`);
            await S().humanClick(action.el);
            try {
              action.el.click();
            } catch (_e) {}
            await S().sleep(2000);
            if (detectApplySuccess() || /post-apply/i.test(smartApplyPath())) return { success: true };
          }
        }
        await S().sleep(800);
        continue;
      }

      // Never let generic Continuer fire on resume-selection without accepted CV
      if (/resume-selection/i.test(smartApplyPath()) && !resumeFileUiAccepted(window.__AmijobsResumeFileName || "")) {
        await uploadCvFallback();
        await S().sleep(1000);
        continue;
      }

      await S().humanClick(action.el);
      await S().sleep(
        S().randomDelay(settings.delayBetweenSteps?.min || 500, settings.delayBetweenSteps?.max || 1400)
      );
      } catch (stepErr) {
        S().log(PLATFORM, `Wizard: ${String(stepErr?.message || stepErr)}`, "warn");
        await S().sleep(800);
      }
    }
    return { success: false, reason: "wizard_timeout" };
    } finally {
      try {
        await chrome.storage.local.set({ indeedWizardBusy: null });
      } catch (_e) {}
      // Always free Smart Apply mutex — Glassdoor handoffs own the lock as "glassdoor"
      try {
        const handoff = !!window.__AmijobsWizardIsHandoff;
        await chrome.runtime.sendMessage({
          action: "releaseSmartApplyLock",
          owner: handoff ? "glassdoor" : "indeed",
          fair: true,
        });
        if (handoff) {
          await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "indeed" });
        }
      } catch (_e) {}
    }
  }

  async function applyCurrentJob(settings, jobInfo) {
    const info = jobInfo || getJobInfoFromPage();

    if (isSmartApplyPage()) {
      return runApplyWizard(info, settings);
    }

    if (detectAlreadyAppliedUi()) {
      return { success: false, reason: "already_applied_ui" };
    }

    // Longer wait when viewjob / apply shell is hydrating
    const panelHydrating = !!(
      document.querySelector("[data-indeed-apply-jk]") ||
      document.querySelector("#jobsearch-ViewjobButtons-container, #jobsearch-ViewJobButtons-container")
    );
    const btn = await waitForApplyButton(panelHydrating || isViewJobPage() ? S().randomDelay(9000, 12000) : undefined);
    if (!btn) {
      if (detectAlreadyAppliedUi()) return { success: false, reason: "already_applied_ui" };
      // Easy Apply only for now — skip company-site / "Continuer pour postuler"
      if (findContinueToApplyButton() || panelShowsNonEasyApplyOnly()) {
        S().log(PLATFORM, "Offre sans candidature simplifiée (site entreprise) — ignorée", "warn");
        return { success: false, reason: "no_indeed_apply" };
      }
      return { success: false, reason: "no_indeed_apply" };
    }

    // Safety: never treat Continuer as Smart Apply
    if (isContinueToApplyButton(btn) || isCompanySiteApplyButton(btn)) {
      S().log(PLATFORM, "Bouton externe détecté — skip (Easy Apply only)", "warn");
      return { success: false, reason: "no_indeed_apply" };
    }

    const popupState = { opened: false };
    const popupPromise = new Promise((resolve) => {
      const onMsg = (msg) => {
        if (msg?.action === "indeedSmartApplyOpened") {
          chrome.runtime.onMessage.removeListener(onMsg);
          popupState.opened = true;
          resolve(true);
        }
      };
      chrome.runtime.onMessage.addListener(onMsg);
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(onMsg);
        resolve(popupState.opened);
      }, 14000);
    });

    // HAR: Postuler → apply.indeed.com buttonClick → env.applyUrl → smartapply
    const preHref =
      btn.getAttribute?.("href") ||
      btn.closest?.("a")?.href ||
      extractSmartApplyUrlFromDom();
    // Clear stale apply URL before click so env hook can populate a fresh one
    try {
      window.__AmijobsLastApplyUrl = null;
      await chrome.storage.local.remove(["amijobsIndeedApplyUrl"]);
    } catch (_e) {}
    await S().humanClick(btn);
    await S().sleep(S().randomDelay(1200, 2200));

    if (detectAlreadyAppliedUi()) {
      return { success: false, reason: "already_applied_ui" };
    }
    if (detectApplySuccess()) {
      return { success: true };
    }
    if (isSmartApplyPage()) {
      return runApplyWizard(info, settings);
    }

    // Left Indeed entirely (external ATS) — hand off to company-site apply worker
    if (!/indeed\.(com|[a-z]{2})|smartapply/i.test(window.location.hostname)) {
      if (settings?.allowExternalApply === false || !window.AmiJobsCompanySite) {
        return { success: false, reason: "external_ats" };
      }
      const externalUrl = window.location.href;
      S().log(PLATFORM, `ATS externe détecté — candidature: ${externalUrl.slice(0, 100)}`);
      const extRes = await Promise.race([
        window.AmiJobsCompanySite.apply({
          url: externalUrl,
          jobInfo: {
            jobId: info.jobId,
            title: info.title,
            company: info.company,
            url: info.url || externalUrl,
          },
          sourcePlatform: "indeed",
        }),
        S().sleep(55000).then(() => ({ ok: false, success: false, reason: "timeout" })),
      ]);
      if (extRes?.ok || extRes?.success) {
        return { success: true, reason: "company_site_applied", url: extRes.url || externalUrl };
      }
      return { success: false, reason: extRes?.reason || "external_ats" };
    }

    // Poll for same-tab Smart Apply OR popup tab (HAR opens smartapply after ~1–2s)
    // Also wait for /api/v1/env applyUrl capture (HAR-proven).
    for (let i = 0; i < 20; i++) {
      if (isSmartApplyPage()) return runApplyWizard(info, settings);
      if (detectApplySuccess()) return { success: true };
      if (popupState.opened) return { success: true, reason: "smartapply_tab" };
      const tabs = await chrome.runtime.sendMessage({ action: "listIndeedTabs" }).catch(() => null);
      if (tabs?.hasSmartApply || tabs?.hasApplyTab) {
        return { success: true, reason: "smartapply_tab" };
      }
      let envUrl = window.__AmijobsLastApplyUrl || null;
      try {
        const { amijobsIndeedApplyUrl = null } = await chrome.storage.local.get(["amijobsIndeedApplyUrl"]);
        if (amijobsIndeedApplyUrl?.url && Date.now() - (amijobsIndeedApplyUrl.at || 0) < 60000) {
          envUrl = amijobsIndeedApplyUrl.url;
        }
      } catch (_e) {}
      if (envUrl && /smartapply|applybyapplyablejobid|preloadresumeapply/i.test(envUrl)) {
        S().log(PLATFORM, `Smart Apply via env.applyUrl: ${envUrl.slice(0, 88)}…`, "warn");
        try {
          await chrome.runtime.sendMessage({ action: "openIndeedSmartApply", url: envUrl });
          return { success: true, reason: "smartapply_tab" };
        } catch (_e) {
          window.location.href = envUrl;
          await S().sleep(2000);
          if (isSmartApplyPage()) return runApplyWizard(info, settings);
        }
      }
      await S().sleep(500);
    }

    if (popupState.opened || (await popupPromise)) {
      return { success: true, reason: "smartapply_tab" };
    }

    // Fallback: navigate directly to applybyapplyablejobid (from env/DOM — HAR applyUrl)
    const href = window.__AmijobsLastApplyUrl || preHref || extractSmartApplyUrlFromDom();
    if (href && /smartapply|applybyapplyablejobid|preloadresumeapply|indeedapply/i.test(href)) {
      S().log(PLATFORM, `Ouverture Smart Apply directe: ${href.slice(0, 90)}…`, "warn");
      try {
        await chrome.runtime.sendMessage({ action: "openIndeedSmartApply", url: href });
        return { success: true, reason: "smartapply_tab" };
      } catch (_e) {
        window.location.href = href;
        await S().sleep(2000);
        if (isSmartApplyPage()) return runApplyWizard(info, settings);
      }
    }

    // Never run a long empty wizard on the viewjob page
    return { success: false, reason: "no_smartapply_opened" };
  }

  function indeedAlertModalVisible() {
    for (const el of document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], [class*="Modal"], [class*="modal"], [data-testid*="Modal"]'
    )) {
      try {
        if (!S().isVisible(el)) continue;
        if (
          /Confiez-nous votre recherche|Enregistrer cette alerte|Créez une alerte pour recevoir|Découvrez en premier|create (a )?job alert/i.test(
            el.innerText || ""
          )
        ) {
          return true;
        }
      } catch (_e) {}
    }
    return false;
  }

  async function dismissIndeedPopups() {
    // Job alert / newsletter modals block SERP + Postuler ("Confiez-nous votre recherche")
    if (!indeedAlertModalVisible()) {
      // Still try generic close buttons (cookie / newsletter)
      for (const sel of [
        'button[aria-label="Close"]',
        'button[aria-label="Fermer"]',
        '[data-testid="modal-close-button"]',
        '.icl-Modal-close',
      ]) {
        const btn = S().$(sel);
        if (btn && S().isVisible(btn)) {
          await S().humanClick(btn);
          await S().sleep(300);
          return true;
        }
      }
      return false;
    }

    const findCloseIn = (root) => {
      if (!root) return null;
      const nodes = root.querySelectorAll?.(
        'button, [role="button"], a, [class*="close" i], [class*="Close"], [data-testid*="close" i], [aria-label*="close" i], [aria-label*="fermer" i]'
      );
      for (const b of nodes || []) {
        if (!S().isVisible(b)) continue;
        const t = (b.textContent || "").trim();
        const al = `${b.getAttribute("aria-label") || ""} ${b.getAttribute("data-testid") || ""} ${b.className || ""}`.toLowerCase();
        if (
          t === "×" ||
          t === "✕" ||
          t === "X" ||
          /^x$/i.test(t) ||
          /close|fermer|dismiss|icon-close|modal-close/i.test(al) ||
          (t.length === 0 && /close|fermer/i.test(al))
        ) {
          return b;
        }
      }
      // Indeed alert: first tiny icon button in dialog header is usually X
      const dialogBtns = [...(root.querySelectorAll?.("button") || [])].filter((b) => S().isVisible(b));
      const saveIdx = dialogBtns.findIndex((b) => /Enregistrer cette alerte|Save (this )?alert/i.test(b.textContent || ""));
      if (saveIdx > 0) {
        // Prefer a button that is NOT the save CTA — often the X is first
        const nonSave = dialogBtns.find((b) => !/Enregistrer|Save|modifier|Modify/i.test(b.textContent || ""));
        if (nonSave) return nonSave;
      }
      return dialogBtns.find((b) => ((b.textContent || "").trim().length || 0) <= 1) || null;
    };

    const dialogs = [
      ...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="Modal"], [class*="modal"], [data-testid*="Modal"]'),
    ];
    for (const dialog of dialogs.length ? dialogs : [document.body]) {
      const xBtn = findCloseIn(dialog);
      if (xBtn) {
        try {
          xBtn.click();
        } catch (_e) {
          await S().humanClick(xBtn);
        }
        await S().sleep(600);
        if (!indeedAlertModalVisible()) {
          S().log(PLATFORM, "Alerte emploi Indeed fermée", "warn");
          return true;
        }
      }
    }

    // Escape + click backdrop
    for (let i = 0; i < 3; i++) {
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", keyCode: 27, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      } catch (_e) {}
      await S().sleep(350);
      if (!indeedAlertModalVisible()) {
        S().log(PLATFORM, "Alerte emploi Indeed fermée (Escape)", "warn");
        return true;
      }
    }

    // Last resort: remove alert modal + backdrop so Postuler is clickable
    for (const el of [
      ...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="Modal"], [class*="modal"]'),
    ]) {
      try {
        if (/Confiez-nous|Enregistrer cette alerte|Créez une alerte/i.test(el.innerText || "")) {
          el.remove();
        }
      } catch (_e) {
        try {
          el.style.setProperty("display", "none", "important");
          el.style.setProperty("pointer-events", "none", "important");
        } catch (_e2) {}
      }
    }
    for (const el of document.querySelectorAll(
      '[class*="overlay" i], [class*="Overlay"], [class*="backdrop" i], [class*="Backdrop"]'
    )) {
      try {
        if (S().isVisible(el)) {
          el.style.setProperty("pointer-events", "none", "important");
          el.style.setProperty("display", "none", "important");
        }
      } catch (_e) {}
    }
    await S().sleep(300);
    if (!indeedAlertModalVisible()) {
      S().log(PLATFORM, "Alerte emploi Indeed forcée (remove)", "warn");
      return true;
    }
    S().log(PLATFORM, "Alerte emploi Indeed toujours visible", "warn");
    return false;
  }

  async function handleSearchPage(session, settings) {
    session = (await syncSerpPageFromLocation(session)) || session;
    const maxJobs = session.maxJobs || settings.maxJobsPerSession || 25;

    await dismissIndeedPopups();

    // Force Easy Apply / candidature simplifiée only
    if (await ensureEasyApplyOnlyFilter()) {
      return;
    }

    // Defer NEW Indeed apply while ANY Smart Apply tab/wizard is open (hard 1-slot rule)
    let deferNewApply = false;
    try {
      const { indeedWizardBusy = null } = await chrome.storage.local.get(["indeedWizardBusy"]);
      const busyAge = indeedWizardBusy?.at ? Date.now() - indeedWizardBusy.at : 999999;
      const tabs = await chrome.runtime.sendMessage({ action: "listIndeedTabs" }).catch(() => null);
      const hasSmart =
        tabs?.hasSmartApply ||
        tabs?.hasApplyTab ||
        /smartapply|indeedapply/i.test(location.href);
      if (busyAge < 180000 && !hasSmart && isSearchPage()) {
        await chrome.storage.local.set({ indeedWizardBusy: null });
      } else if (hasSmart && isSearchPage()) {
        deferNewApply = true;
        try {
          await chrome.runtime.sendMessage({ action: "nudgeIndeedSmartApply" });
          await chrome.runtime.sendMessage({
            action: "enforceOneTabPerPlatform",
            reason: "indeed serp defer",
          });
        } catch (_e) {}
      }
    } catch (_e) {}

    // While Glassdoor owns the live wizard, Indeed browses but does not Postuler
    const {
      sessionGlassdoor = null,
      glassdoorSmartApply = null,
      amijobsSmartApplyPrefer = null,
      amijobsSmartApplyLock = null,
    } = await chrome.storage.local.get([
      "sessionGlassdoor",
      "glassdoorSmartApply",
      "amijobsSmartApplyPrefer",
      "amijobsSmartApplyLock",
    ]);
    // Fairness: after Glassdoor is preferred, don't steal the Smart Apply slot
    const preferGd =
      amijobsSmartApplyPrefer?.owner === "glassdoor" &&
      Date.now() - (amijobsSmartApplyPrefer.at || 0) < 40000 &&
      !!sessionGlassdoor?.active &&
      (sessionGlassdoor.applied || 0) < (sessionGlassdoor.maxJobs || 25);
    const lockHeldByOther =
      amijobsSmartApplyLock?.owner &&
      amijobsSmartApplyLock.owner !== "indeed" &&
      Date.now() - (amijobsSmartApplyLock.at || 0) < 180000;
    if ((preferGd || lockHeldByOther) && isSearchPage()) {
      deferNewApply = true;
    }
    const gdAwaiting = !!(sessionGlassdoor?.active && sessionGlassdoor?.awaitingIndeed);
    const gdSmartAge = glassdoorSmartApply ? Date.now() - (glassdoorSmartApply.at || 0) : 999999;
    const gdAwaitAge = gdAwaiting
      ? Date.now() - (sessionGlassdoor.lastRunAt || Date.parse(sessionGlassdoor.startedAt) || Date.now())
      : 999999;
    if (gdAwaiting && gdAwaitAge > 240000) {
      S().log(PLATFORM, "Libération handoff Glassdoor expiré — reprise file Indeed", "warn");
      await chrome.storage.local.set({
        sessionGlassdoor: { ...sessionGlassdoor, awaitingIndeed: false, indeedHandoffDone: false },
      });
    } else if (gdAwaiting || gdSmartAge < 120000) {
      const tabs = await chrome.runtime.sendMessage({ action: "listIndeedTabs" }).catch(() => null);
      const hasSmart =
        tabs?.hasSmartApply ||
        tabs?.hasApplyTab ||
        /smartapply|indeedapply|\/viewjob|\/rc\/clk/i.test(location.href);
      if (hasSmart || /smartapply|indeedapply/i.test(location.href)) {
        deferNewApply = true;
      }
      // Do NOT clear Glassdoor awaitingIndeed from Indeed — that aborts live handoffs.
      // Glassdoor owns stale cleanup (60s / 240s).
    }

    if (deferNewApply && isSearchPage()) {
      // Keep Indeed visibly busy: drain handled queue items, prepare cards
      let q = session.queue || [];
      let qi = session.qIndex || 0;
      let advanced = 0;
      const live =
        (await chrome.runtime.sendMessage({ action: "getState" }).catch(() => null)) || {};
      const appliedMap = live.appliedJobs || {};
      const skippedMap = live.skippedJobs || {};
      while (qi < q.length && advanced < 8) {
        const it = q[qi];
        const id = it?.jobId;
        if (id && (appliedMap[id] || skippedMap[id] || (await alreadyHandled(id)))) {
          qi += 1;
          advanced += 1;
          continue;
        }
        break;
      }
      if (advanced) await setSession({ qIndex: qi });
      if (!q.length) {
        const cards = await waitForJobCards(8000).catch(() => []);
        if (cards?.length) {
          q = cards
            .filter((c) => isValidIndeedJobKey(c.jobId) && c.title && c.title.length >= 3)
            .map((c) => ({ jobId: c.jobId, title: c.title, company: c.company }));
          await setSession({ queue: q, qIndex: 0 });
          S().log(PLATFORM, `SERP Indeed prêt (${q.length} offres) — Smart Apply partagé en cours`, "warn");
        } else {
          S().log(PLATFORM, "SERP Indeed actif — attente fin Smart Apply (Glassdoor/Indeed)", "warn");
        }
      } else {
        S().log(
          PLATFORM,
          `SERP Indeed actif (${Math.max(0, q.length - qi)} en file) — attente tour Smart Apply`,
          "warn"
        );
      }
      // Yield longer when Glassdoor is preferred / owns the lock — feels more dual
      await S().sleep(preferGd || lockHeldByOther ? 2800 : 900);
      return;
    }

    if ((session.applied || 0) >= maxJobs) {
      await endSession("Objectif session atteint");
      return;
    }

    if (detectBlockedPage() || detectCloudflareChallenge()) {
      const ok = await tryPassCloudflareChallenge();
      if (!ok && detectBlockedPage()) {
        await handleAntiBotBlock("serp");
        return;
      }
    }
    let queue = session.queue || [];
    let qIndex = session.qIndex || 0;
    // Always re-read handled jobs (skips must stick across SERP reloads)
    let liveState = (await chrome.runtime.sendMessage({ action: "getState" }).catch(() => null)) || {};
    let appliedJobs = liveState.appliedJobs || {};

    if (!queue.length) {
      if (detectNoResultsPage()) {
        await endSession("Aucun résultat pour ce lieu/mot-clé");
        return;
      }
      const cards = await waitForJobCards(45000);
      if (!cards.length) {
        const emptyRetries = (session.emptyCardRetries || 0) + 1;
        S().log(
          PLATFORM,
          `SERP vide (tentative ${emptyRetries}) — popups / anti-bot / sélecteurs`,
          "warn"
        );
        await dismissIndeedPopups().catch(() => {});
        // Retry same page twice before flipping (avoids silent page burn)
        if (emptyRetries < 3) {
          await setSession({ emptyCardRetries: emptyRetries });
          await S().sleep(2500);
          return;
        }
        const noPages = (session.noApplyPages || 0) + 1;
        await setSession({ noApplyPages: noPages, emptyCardRetries: 0 });
        if (noPages >= 3 && detectNoResultsPage()) {
          await endSession("Aucun résultat pour ce lieu/mot-clé");
          return;
        }
        if (noPages >= (settings.maxConsecutiveNoApplyPages || 12)) {
          await endSession("Aucune offre trouvée");
          return;
        }
        if (!hasIndeedNextSerpPage()) {
          await endSession(
            (session.applied || 0) > 0
              ? "Plus d'offres Easy Apply pour ce mot-clé"
              : "Aucune offre Easy Apply pour ce mot-clé"
          );
          return;
        }
        const nextPage = (session.currentPage || 0) + 1;
        S().log(PLATFORM, `Page suivante Indeed (${nextPage + 1}) — SERP vide après retries`, "warn");
        await setSession({ currentPage: nextPage, queue: [], qIndex: 0, pageApplied: 0 });
        window.location.href = buildSearchUrl(session.keywords, session.location, nextPage, session);
        return;
      }

      queue = [];
      for (const c of cards) {
        if (!isValidIndeedJobKey(c.jobId) || !c.title || c.title.length < 3) continue;
        if (cardAlreadyApplied(c.element)) continue;
        if (await alreadyHandled(c.jobId)) continue;
        if (await alreadyApplied(appliedJobs, c.jobId)) continue;
        queue.push({ jobId: c.jobId, title: c.title, company: c.company });
      }
      qIndex = 0;
      await setSession({ queue, qIndex: 0, noApplyPages: 0, emptyCardRetries: 0 });
      S().log(PLATFORM, `${queue.length} offres trouvées`);
      if (!queue.length) {
        // Cards on page but all already handled / no Easy Apply left
        if (!hasIndeedNextSerpPage()) {
          await endSession(
            (session.applied || 0) > 0
              ? "Plus d'offres Easy Apply pour ce mot-clé"
              : "Aucune offre Easy Apply pour ce mot-clé"
          );
          return;
        }
      }
    }

    // After hard reload / SPA remount: stored queue IDs often miss the live DOM.
    // Wait for cards and rebuild instead of draining "Carte absente" in 50ms.
    if (queue.length && qIndex < queue.length) {
      const probe = collectJobCards();
      const liveIds = new Set(probe.map((c) => c.jobId).filter(Boolean));
      const remaining = queue.slice(qIndex);
      const hits = remaining.filter((q) => liveIds.has(q.jobId)).length;
      if (probe.length < 3 || hits < Math.min(2, remaining.length)) {
        S().log(
          PLATFORM,
          `File SERP stale (${hits}/${remaining.length} live) — recollect…`,
          "warn"
        );
        const cards = await waitForJobCards(22000, { minCards: 8 });
        const seen = (await getSession())?.seenJobIds || {};
        const source = cards.length ? cards : probe;
        const rebuilt = [];
        for (const c of source) {
          if (!isValidIndeedJobKey(c.jobId) || seen[c.jobId]) continue;
          if (cardAlreadyApplied(c.element)) continue;
          if (await alreadyHandled(c.jobId)) continue;
          rebuilt.push({
            jobId: c.jobId,
            title: c.title,
            company: c.company,
            easyApply: c.easyApply !== false,
          });
        }
        if (rebuilt.length) {
          queue = rebuilt;
          qIndex = 0;
          await setSession({ queue, qIndex: 0, noApplyPages: 0 });
          S().log(PLATFORM, `${queue.length} offres trouvées (recollect)`);
        }
      }
    }

    // Drop any stale placeholder keys left in a previous queue
    if (queue.length) {
      const cleaned = queue.filter((q) => isValidIndeedJobKey(q.jobId));
      if (cleaned.length !== queue.length) {
        S().log(PLATFORM, `File nettoyée: ${queue.length - cleaned.length} clé(s) invalide(s) retirée(s)`, "warn");
        queue = cleaned;
        qIndex = Math.min(qIndex, queue.length);
        await setSession({ queue, qIndex });
      }
    }
    // If queue empty after clean, rebuild from live SERP
    if (!queue.length && isSearchPage()) {
      const cards = await waitForJobCards(20000);
      queue = cards
        .filter((c) => isValidIndeedJobKey(c.jobId) && c.title && c.title.length >= 3)
        .map((c) => ({ jobId: c.jobId, title: c.title, company: c.company }));
      qIndex = 0;
      await setSession({ queue, qIndex: 0, noApplyPages: 0 });
      S().log(PLATFORM, `${queue.length} offres trouvées (rebuild)`);
    }

    while (qIndex < queue.length) {
      if (shouldStop) {
        await endSession("Arrêt demandé");
        return;
      }

      const current = await getSession();
      if (!current?.active || (current.applied || 0) >= maxJobs) {
        await endSession("Objectif session atteint");
        return;
      }
      // Cap applies per SERP page then continue on page 2+
      if (await maybeFlipIndeedPage(current, settings, maxJobs)) return;

      const item = queue[qIndex];
      if (!isValidIndeedJobKey(item.jobId)) {
        qIndex++;
        await setSession({ qIndex });
        continue;
      }
      if (await alreadyHandled(item.jobId) || (await alreadyApplied(appliedJobs, item.jobId))) {
        qIndex++;
        await setSession({ qIndex });
        continue;
      }

      const skipReason = await shouldSkipCompany(item.company);
      if (skipReason) {
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: PLATFORM,
          jobId: item.jobId,
          title: item.title,
          reason:
            skipReason === "blacklist"
              ? `Blacklistée: ${item.company}`
              : `Limite entreprise (${item.company})`,
        });
        qIndex++;
        await setSession({ qIndex });
        continue;
      }

      if (
        window.AmiJobsCompanySite &&
        (await window.AmiJobsCompanySite.shouldSkipFormationOffer(item.title || "", item.company || ""))
      ) {
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: PLATFORM,
          jobId: item.jobId,
          title: item.title,
          reason: "Offre de formation / CFA (filtrée)",
        });
        qIndex++;
        await setSession({ qIndex });
        continue;
      }

      // Prefer SPA: click the card on the SERP (right panel) then "Postuler sur Indeed"
      // Avoids brittle /viewjob?jk= navigations that 404 on bad/stale keys.
      const liveCard =
        collectJobCards().find((c) => c.jobId === item.jobId) ||
        [...document.querySelectorAll("[data-jk]")].find((el) => el.getAttribute("data-jk") === item.jobId);
      const cardEl = liveCard?.element || liveCard || null;
      if (cardEl && cardAlreadyApplied(cardEl)) {
        S().log(PLATFORM, `Déjà postulé (carte): ${item.title || item.jobId}`, "warn");
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: PLATFORM,
          jobId: item.jobId,
          title: item.title,
          reason: "already_applied_ui",
        });
        qIndex++;
        await setSession({ qIndex });
        continue;
      }
      if (cardEl && isSearchPage()) {
        const link =
          cardEl.querySelector?.("a.jcs-JobTitle, h2.jobTitle a, h2 a, a[href*='jk='], a[data-jk]") ||
          (cardEl.tagName === "A" ? cardEl : null) ||
          cardEl;
        try {
          link.removeAttribute?.("target");
          link.setAttribute?.("target", "_self");
        } catch (_e) {}
        // Pace SERP opens — rapid successive opens trip Indeed "Vérification supplémentaire"
        try {
          const coolUntil = (await getSession())?.massApplyCooldownUntil || 0;
          const waitMs = coolUntil - Date.now();
          if (waitMs > 0) await S().sleep(Math.min(waitMs, 8000));
        } catch (_e) {}
        S().log(PLATFORM, `Ouverture offre SERP: ${item.title || item.jobId}`);
        window.__AmijobsMissingCardStreak = 0;
        await setSession({
          phase: "viewjob",
          currentJk: item.jobId,
          currentTitle: item.title,
          currentCompany: item.company,
          qIndex: qIndex + 1,
          massApplyCooldownUntil: Date.now() + S().randomDelay(500, 1100),
        });
        // Prefer title link, then whole card — SPA panel open is flaky on FR
        await S().humanClick(link);
        let panelState = await waitForSerpJobPanel(item.jobId, item.title, S().randomDelay(700, 1100));
        if (panelState === "loading") {
          try {
            const shell =
              cardEl.closest?.("[data-jk]") ||
              cardEl.querySelector?.("[data-jk]") ||
              cardEl;
            if (shell && shell !== link) await S().humanClick(shell);
          } catch (_e) {}
          panelState = await waitForSerpJobPanel(item.jobId, item.title, S().randomDelay(500, 900));
        }
        if (panelState === "blocked") {
          S().log(PLATFORM, "Cloudflare / vérif supplémentaire après ouverture carte — pause", "warn");
          await setSession({ phase: "search" });
          return;
        }
        if (!panelState || panelState === "no_easy_apply" || panelState === "loading") {
          const reason =
            panelState === "no_easy_apply"
              ? "Sans candidature simplifiée"
              : "Panneau offre non chargé";
          S().log(PLATFORM, `${reason}: ${item.title || item.jobId} — skip rapide`, "warn");
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: PLATFORM,
            jobId: item.jobId,
            title: item.title,
            reason,
          });
          await setSession({ phase: "search" });
          await humanSleep(500, 1000);
          setTimeout(() => {
            if (!isRunning) runAutoApplySession();
          }, S().randomDelay(200, 450));
          return;
        }
        await markSeenJob(item.jobId);
        // Panel may show appliedSnippet after open (dead Postuler still in DOM)
        if (detectAlreadyAppliedUi() || panelState === "applied") {
          S().log(PLATFORM, `Déjà postulé (panneau): ${item.title || item.jobId}`, "warn");
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: PLATFORM,
            jobId: item.jobId,
            title: item.title,
            reason: "already_applied_ui",
          });
          await setSession({ phase: "search" });
          await humanSleep(500, 1000);
          setTimeout(() => {
            if (!isRunning) runAutoApplySession();
          }, S().randomDelay(180, 400));
          return;
        }
        // Pace clicks — rapid SERP opens trip Indeed "Vérification supplémentaire"
        await humanSleep(450, 950);
        const fresh = await getSession();
        await handleViewJobPage(fresh || session, settings);
        return;
      }

      // Card not in DOM (virtualized list) — advance queue and try next; recharge later
      S().log(PLATFORM, `Carte absente du DOM: ${item.title || item.jobId} — suivante`, "warn");
      qIndex++;
      await setSession({ qIndex });
      // After several misses, rebuild queue from live cards instead of draining stale IDs
      if (!window.__AmijobsMissingCardStreak) window.__AmijobsMissingCardStreak = 0;
      window.__AmijobsMissingCardStreak += 1;
      if (window.__AmijobsMissingCardStreak >= 4) {
        window.__AmijobsMissingCardStreak = 0;
        const live = collectJobCards()
          .filter((c) => isValidIndeedJobKey(c.jobId))
          .map((c) => ({ jobId: c.jobId, title: c.title, company: c.company, easyApply: c.easyApply !== false }));
        if (live.length) {
          S().log(PLATFORM, `File SERP reconstruite (${live.length} cartes live)`, "warn");
          await setSession({ queue: live, qIndex: 0 });
          return;
        }
      }
      continue;
    }

    // Before flipping pages: if we still need applies on THIS page, reload cards
    const perPage = settings.maxJobsPerPage || 0;
    const pageApplied = (await getSession())?.pageApplied || 0;
    const totalApplied = (await getSession())?.applied || 0;
    const sessNow = await getSession();
    const rechargeAttempts = sessNow?.rechargeAttempts || 0;
    if (perPage > 0 && pageApplied < perPage && totalApplied < maxJobs && rechargeAttempts < 2) {
      await dismissIndeedPopups().catch(() => {});
      const more = await waitForJobCards(22000, { minCards: 10 });
      const seen = (await getSession())?.seenJobIds || {};
      const fresh = more
        .filter((c) => isValidIndeedJobKey(c.jobId) && !seen[c.jobId] && c.easyApply !== false)
        .filter((c) => c.easyApply)
        .map((c) => ({ jobId: c.jobId, title: c.title, company: c.company }));
      // If no easyApply flags at all, keep any unseen
      const fallback = more
        .filter((c) => isValidIndeedJobKey(c.jobId) && !seen[c.jobId])
        .map((c) => ({ jobId: c.jobId, title: c.title, company: c.company }));
      const use = fresh.length ? fresh : fallback;
      if (use.length) {
        S().log(PLATFORM, `Recharge SERP page ${(session.currentPage || 0) + 1}: ${use.length} nouvelles offres`);
        await setSession({ queue: use, qIndex: 0, noApplyPages: 0, rechargeAttempts: rechargeAttempts + 1 });
        return;
      }
    }

    const nextPage = (session.currentPage || 0) + 1;
    if (!hasIndeedNextSerpPage() || nextPage > maxIndeedSerpPages(session, settings)) {
      await endSession(
        totalApplied > 0
          ? "Plus d'offres Easy Apply pour ce mot-clé"
          : "Aucune offre Easy Apply pour ce mot-clé"
      );
      return;
    }
    const nextUrl = buildSearchUrl(session.keywords, session.location, nextPage, session);
    S().log(PLATFORM, `Page suivante Indeed (${nextPage + 1}, start=${nextPage * 10}) — file épuisée`, "warn");
    await setSession({
      currentPage: nextPage,
      pageApplied: 0,
      rechargeAttempts: 0,
      queue: [],
      qIndex: 0,
      searchUrl: nextUrl,
      phase: "search",
    });
    window.location.href = nextUrl;
  }

  async function handleViewJobPage(session, settings) {
    const jobId = session.currentJk || jkFromUrl();
    await humanSleep(400, 850);

    // Fast path: appliedSnippet / "Candidature envoyée" (Postuler may still be visible but dead)
    if (detectAlreadyAppliedUi()) {
      const title =
        session.currentTitle ||
        getJobInfoFromPage(jobId)?.title ||
        "";
      S().log(PLATFORM, `Déjà postulé (UI): ${title || jobId}`, "warn");
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        platform: PLATFORM,
        jobId: jobId || "unknown",
        title,
        reason: "already_applied_ui",
      });
      await setSession({ phase: "search" });
      if (!isSearchPage()) window.location.href = searchReturnUrl(session);
      return;
    }

    await humanSleep(280, 620);

    if (detectMissingJobPage() || !isValidIndeedJobKey(jobId)) {
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        platform: PLATFORM,
        jobId: jobId || "invalid",
        title: session.currentTitle || "Offre invalide",
        reason: "Offre introuvable / clé invalide",
      });
      await setSession({ phase: "search" });
      window.location.href = searchReturnUrl(session);
      return;
    }

    const jobInfo = getJobInfoFromPage(jobId);
    if (!jobInfo.title || /^(emplois|jobs|offres)\b/i.test(jobInfo.title)) {
      jobInfo.title =
        session.currentTitle || session.queue?.find((q) => q.jobId === jobId)?.title || "";
    }
    if (!jobInfo.company) {
      jobInfo.company =
        session.currentCompany || session.queue?.find((q) => q.jobId === jobId)?.company || "";
    }

    if (detectBlockedPage() || detectCloudflareChallenge()) {
      const ok = await tryPassCloudflareChallenge();
      if (!ok && detectBlockedPage()) {
        await handleAntiBotBlock("serp");
        return;
      }
    }

    const skipReason = await shouldSkipCompany(jobInfo.company);
    if (skipReason) {
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        platform: PLATFORM,
        jobId: jobInfo.jobId,
        title: jobInfo.title,
        reason:
          skipReason === "blacklist"
            ? `Blacklistée: ${jobInfo.company}`
            : `Limite entreprise (${jobInfo.company})`,
      });
      await setSession({ phase: "search" });
      window.location.href = searchReturnUrl(session);
      return;
    }

    // Shared mutex with Glassdoor Easy Apply — detect handoff BEFORE skip/return
    // so a failed Postuler on a GD URL doesn't poison Indeed's own SERP queue.
    let gdHandoff = false;
    let gdMeta = null;
    try {
      const { sessionGlassdoor: sGd = null, glassdoorSmartApply = null } = await chrome.storage.local.get([
        "sessionGlassdoor",
        "glassdoorSmartApply",
      ]);
      const smartAge = glassdoorSmartApply?.at ? Date.now() - glassdoorSmartApply.at : 999999;
      gdHandoff = !!(sGd?.active && (sGd.awaitingIndeed || smartAge < 180000));
      gdMeta = glassdoorSmartApply || (gdHandoff ? sGd : null);
    } catch (_e) {}
    if (gdHandoff && gdMeta) {
      if (gdMeta.jobId || gdMeta.currentJk) jobInfo.jobId = gdMeta.jobId || gdMeta.currentJk || jobInfo.jobId;
      if (gdMeta.title || gdMeta.currentTitle)
        jobInfo.title = gdMeta.title || gdMeta.currentTitle || jobInfo.title;
      if (gdMeta.company || gdMeta.currentCompany)
        jobInfo.company = gdMeta.company || gdMeta.currentCompany || jobInfo.company;
    }

    const btn = await waitForApplyButton(gdHandoff ? S().randomDelay(8000, 12000) : S().randomDelay(2200, 3200));
    if (!btn) {
      // Fallback: Smart Apply deep link sometimes present without a visible CTA yet
      const smartUrl = extractSmartApplyUrlFromDom();
      if (smartUrl && !gdHandoff) {
        S().log(PLATFORM, `Postuler absent — ouverture Smart Apply URL…`, "warn");
        const lock0 = await chrome.runtime
          .sendMessage({ action: "acquireSmartApplyLock", owner: "indeed", handoff: false })
          .catch(() => null);
        if (lock0?.ok) {
          await setSession({ phase: "apply", currentJk: jobInfo.jobId });
          try {
            await chrome.runtime.sendMessage({
              action: "ensurePlatformTab",
              platform: "indeed",
              url: smartUrl,
              active: true,
              forceNavigate: true,
            });
            return;
          } catch (_e) {
            try {
              await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "indeed" });
            } catch (_e2) {}
          }
        }
      }
      if (gdHandoff) {
        // Fail fast — don't hold GD's lock for 120s on a dead viewjob
        S().log(
          PLATFORM,
          `Handoff Glassdoor: Postuler introuvable (${jobInfo.title || jobId}) — release`,
          "warn"
        );
        try {
          const { sessionGlassdoor: sGd = null } = await chrome.storage.local.get(["sessionGlassdoor"]);
          const skipId = jobInfo.jobId || sGd?.currentJk || jobId;
          const skipTitle = jobInfo.title || sGd?.currentTitle || "";
          if (sGd?.active) {
            await chrome.storage.local.set({
              sessionGlassdoor: { ...sGd, awaitingIndeed: false, indeedHandoffDone: false },
              glassdoorSmartApply: null,
            });
          }
          // Persist skip on Glassdoor so SERP doesn't re-attack the same listing
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: "glassdoor",
            jobId: skipId,
            title: skipTitle,
            reason: "handoff_no_postuler",
          });
          await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "glassdoor" });
          // Close dead viewjob apply slot so next Easy Apply can open cleanly
          try {
            await chrome.runtime.sendMessage({ action: "closeIndeedSmartApplyTabs" });
          } catch (_e2) {}
        } catch (_e) {}
        return;
      }
      if (detectAlreadyAppliedUi()) {
        S().log(PLATFORM, `Déjà postulé (UI): ${jobInfo.title || jobId}`, "warn");
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: PLATFORM,
          jobId: jobInfo.jobId,
          title: jobInfo.title,
          reason: "already_applied_ui",
        });
      } else {
        const skipTitle =
          session.currentTitle ||
          jobInfo.title ||
          session.queue?.find((q) => q.jobId === jobInfo.jobId)?.title ||
          "";
        S().log(PLATFORM, "Bouton Postuler sur Indeed introuvable", "warn");
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: PLATFORM,
          jobId: jobInfo.jobId,
          title: skipTitle,
          reason: "Pas de candidature Indeed",
        });
      }
      await setSession({ phase: "search" });
      // Soft return on SERP — hard nav remounts the module and burns the rest of the queue
      if (isSearchPage()) {
        setTimeout(() => {
          if (!isRunning) runAutoApplySession();
        }, 600);
      } else {
        window.location.href = searchReturnUrl(session);
      }
      return;
    }
    const lock = await chrome.runtime
      .sendMessage({ action: "acquireSmartApplyLock", owner: "indeed", handoff: gdHandoff })
      .catch(() => null);
    if (!lock?.ok) {
      S().log(
        PLATFORM,
        `Smart Apply occupé (${lock?.owner || "glassdoor"}) — pause offre, retry plus tard`,
        "warn"
      );
      await setSession({ phase: "search" });
      await S().sleep(1500);
      // Soft return — avoid full SERP hard navigation when possible
      if (!isSearchPage()) {
        window.location.href = searchReturnUrl(session);
      }
      return;
    }
    if (gdHandoff || lock?.handoff) {
      window.__AmijobsWizardIsHandoff = true;
    }

    S().log(PLATFORM, `Clic: ${(btn.innerText || btn.textContent || "Postuler").trim().slice(0, 48)}`);
    await setSession({ phase: "apply", currentJk: jobInfo.jobId });
    const result = await applyCurrentJob(settings, jobInfo);

    if (result.reason === "smartapply_tab") {
      // Another tab owns the wizard; keep lock while waiting for completion
      S().log(PLATFORM, "Smart Apply ouvert dans un onglet — attente");
      const appliedBefore = (await getSession())?.applied || 0;
      for (let i = 0; i < 55; i++) {
        if (shouldStop) break;
        await S().sleep(1000);
        const fresh = await getSession();
        if (!fresh?.active) return;
        if ((fresh.applied || 0) > appliedBefore) break;
        if (fresh.phase === "search") break;
      }
      try {
        await chrome.runtime.sendMessage({
          action: "releaseSmartApplyLock",
          owner: gdHandoff || window.__AmijobsWizardIsHandoff ? "glassdoor" : "indeed",
        });
      } catch (_e) {}
      await setSession({ phase: "search" });
      window.location.href = searchReturnUrl(session);
      return;
    }

    if (result.reason === "company_site_applied" || (result.success && /company_site/i.test(result.reason || ""))) {
      await chrome.runtime.sendMessage({
        action: "markApplied",
        platform: PLATFORM,
        jobId: jobInfo.jobId,
        title: jobInfo.title,
        company: jobInfo.company,
        url: result.url || jobInfo.url,
      });
      try {
        await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "indeed", fair: true });
      } catch (_e) {}
      S().log(PLATFORM, `Postulé (site entreprise): ${jobInfo.title}`, "success");
      await setSession({ phase: "search" });
      window.location.href = searchReturnUrl(session);
      return;
    }

    if (
      result.reason === "company_site_apply" ||
      result.reason === "external_ats" ||
      result.reason === "no_smartapply_opened" ||
      result.reason === "no_indeed_apply" ||
      result.reason === "already_applied_ui"
    ) {
      try {
        await chrome.runtime.sendMessage({
          action: "releaseSmartApplyLock",
          owner: gdHandoff || window.__AmijobsWizardIsHandoff ? "glassdoor" : "indeed",
        });
      } catch (_e) {}
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        platform: PLATFORM,
        jobId: jobInfo.jobId,
        title: jobInfo.title,
        reason:
          result.reason === "already_applied_ui"
            ? "already_applied_ui"
            : result.reason === "company_site_apply"
              ? "Site entreprise (échec/indisponible)"
              : "Pas de Smart Apply Indeed",
      });
      await setSession({ phase: "search" });
      window.location.href = searchReturnUrl(session);
      return;
    }

    if (result.success) {
      const creditGd = !!(gdHandoff || window.__AmijobsWizardIsHandoff);
      let creditJobId = jobInfo.jobId;
      let creditTitle = jobInfo.title;
      let creditCompany = jobInfo.company;
      if (creditGd) {
        try {
          const { glassdoorSmartApply = null, sessionGlassdoor: sGd = null } =
            await chrome.storage.local.get(["glassdoorSmartApply", "sessionGlassdoor"]);
          creditJobId = glassdoorSmartApply?.jobId || sGd?.currentJk || creditJobId;
          creditTitle = glassdoorSmartApply?.title || sGd?.currentTitle || creditTitle;
          creditCompany = glassdoorSmartApply?.company || sGd?.currentCompany || creditCompany;
        } catch (_e) {}
      }
      await chrome.runtime.sendMessage({
        action: "markApplied",
        platform: creditGd ? "glassdoor" : PLATFORM,
        jobId: creditJobId,
        title: creditTitle,
        company: creditCompany,
        url: jobInfo.url,
      });
      // markApplied already bumps session.applied — only track per-page count here
      const sNow = await getSession();
      const pageApplied = creditGd ? sNow?.pageApplied || 0 : (sNow?.pageApplied || 0) + 1;
      await setSession({ pageApplied, phase: "search", awaitingSmartApply: false });
      try {
        await chrome.runtime.sendMessage({
          action: "releaseSmartApplyLock",
          owner: creditGd ? "glassdoor" : "indeed",
          fair: true,
        });
      } catch (_e) {}
      S().log(
        PLATFORM,
        creditGd
          ? `Postulé (via Glassdoor): ${creditTitle || creditJobId}`
          : `Postulé: ${jobInfo.title} (page ${(sNow?.currentPage || 0) + 1}, ${pageApplied}/${settings.maxJobsPerPage || "∞"} page)`,
        "success"
      );
    } else {
      if (!(gdHandoff || window.__AmijobsWizardIsHandoff)) {
        await chrome.runtime.sendMessage({
          action: "markError",
          platform: PLATFORM,
          jobId: jobInfo.jobId,
          title: jobInfo.title,
          error: result.reason || "error",
        });
      }
      await setSession({ phase: "search", awaitingSmartApply: false });
      try {
        await chrome.runtime.sendMessage({
          action: "releaseSmartApplyLock",
          owner: gdHandoff || window.__AmijobsWizardIsHandoff ? "glassdoor" : "indeed",
        });
      } catch (_e) {}
    }

    await S().sleep(
      S().randomDelay(settings.delayBetweenJobs?.min || 800, settings.delayBetweenJobs?.max || 1800)
    );
    const after = await getSession();
    const maxJobs = after?.maxJobs || settings.maxJobsPerSession || 25;
    if (result.success && (await maybeFlipIndeedPage(after, settings, maxJobs))) return;
    window.location.href = searchReturnUrl(after || session);
  }

  async function handleApplyPage(session, settings) {
    const { glassdoorSmartApply = null, sessionGlassdoor = null } = await chrome.storage.local.get([
      "glassdoorSmartApply",
      "sessionGlassdoor",
    ]);
    const fromGlassdoor =
      !!(session?.fromGlassdoor) ||
      !!(glassdoorSmartApply && Date.now() - (glassdoorSmartApply.at || 0) < 180000);

    const jobInfo = getJobInfoFromPage(session.currentJk);
    if (fromGlassdoor && glassdoorSmartApply) {
      // Prefer Glassdoor listing id so the Glassdoor wait loop can match appliedJobs
      jobInfo.jobId =
        glassdoorSmartApply.jobId ||
        sessionGlassdoor?.currentJk ||
        jobInfo.jobId ||
        session.currentJk ||
        jkFromUrl();
      if (!jobInfo.title) jobInfo.title = glassdoorSmartApply.title || session.currentTitle || sessionGlassdoor?.currentTitle || "";
      if (!jobInfo.company)
        jobInfo.company = glassdoorSmartApply.company || session.currentCompany || sessionGlassdoor?.currentCompany || "";
    } else {
      if (!jobInfo.title) jobInfo.title = session.currentTitle || "";
      if (!jobInfo.company) jobInfo.company = session.currentCompany || "";
    }

    const result = await runApplyWizard(jobInfo, settings);

    if (result.success) {
      {
        const sBefore = await getSession();
        await chrome.runtime.sendMessage({
          action: "markApplied",
          platform: fromGlassdoor ? "glassdoor" : PLATFORM,
          jobId: jobInfo.jobId || session.currentJk,
          title: jobInfo.title,
          company: jobInfo.company,
          url: jobInfo.url,
          page: fromGlassdoor
            ? (await chrome.storage.local.get(["sessionGlassdoor"])).sessionGlassdoor?.currentPage || 0
            : sBefore?.currentPage || 0,
        });
      }
      try {
        await chrome.storage.local.set({ indeedWizardBusy: null });
      } catch (_e) {}
      if (!fromGlassdoor) {
        const sNow = await getSession();
        const pageApplied = (sNow?.pageApplied || 0) + 1;
        await setSession({ pageApplied, phase: "search", awaitingSmartApply: false });
        try {
          await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "indeed", fair: true });
        } catch (_e) {}
        // Free stale Glassdoor handoff flag so GD can take its fair turn
        try {
          const { sessionGlassdoor: sGd = null } = await chrome.storage.local.get(["sessionGlassdoor"]);
          if (sGd?.active && sGd.awaitingIndeed) {
            await chrome.storage.local.set({
              sessionGlassdoor: { ...sGd, awaitingIndeed: false, indeedHandoffDone: false },
              glassdoorSmartApply: null,
            });
          }
        } catch (_e) {}
        S().log(
          PLATFORM,
          `Postulé: ${jobInfo.title || jobInfo.jobId} (page ${(sNow?.currentPage || 0) + 1}, ${pageApplied}/${settings.maxJobsPerPage || "∞"} page)`,
          "success"
        );
      } else {
        try {
          await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "glassdoor", fair: true });
        } catch (_e) {}
        S().log(
          PLATFORM,
          `Postulé${fromGlassdoor ? " (via Glassdoor)" : ""}: ${jobInfo.title || jobInfo.jobId}`,
          "success"
        );
      }
    } else if (!fromGlassdoor) {
      await chrome.runtime.sendMessage({
        action: "markError",
        platform: PLATFORM,
        jobId: jobInfo.jobId || session.currentJk,
        title: jobInfo.title,
        error: result.reason || "error",
      });
      try {
        await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "indeed" });
      } catch (_e) {}
    } else {
      // Soft retry once, then release Glassdoor waiter so mass-apply can skip & continue
      S().log(
        PLATFORM,
        `Smart Apply (Glassdoor) en cours / retry: ${result.reason || "error"}`,
        "warn"
      );
      try {
        await S().sleep(1500);
        const retry = await runApplyWizard(jobInfo, settings);
        if (retry.success) {
          await chrome.runtime.sendMessage({
            action: "markApplied",
            platform: "glassdoor",
            jobId: jobInfo.jobId || session.currentJk,
            title: jobInfo.title,
            company: jobInfo.company,
            url: jobInfo.url,
          });
          S().log(PLATFORM, `Postulé (via Glassdoor): ${jobInfo.title || jobInfo.jobId}`, "success");
          result.success = true;
        } else {
          result.reason = retry.reason || result.reason || "wizard_timeout";
        }
      } catch (_e) {
        /* ignore */
      }
    }

    if (fromGlassdoor) {
      const { sessionGlassdoor: sNow = null } = await chrome.storage.local.get(["sessionGlassdoor"]);
      if (result.success) {
        if (sNow?.active) {
          await chrome.storage.local.set({
            sessionGlassdoor: {
              ...sNow,
              awaitingIndeed: false,
              indeedHandoffDone: true,
            },
            glassdoorSmartApply: null,
          });
        } else {
          await chrome.storage.local.set({ glassdoorSmartApply: null });
        }
        await chrome.runtime.sendMessage({
          action: "closeTabAndResumeIndeed",
          searchUrl: "",
          fromGlassdoor: true,
        });
      } else {
        // Release waiter + skip job so Glassdoor can flip to next Easy Apply card
        S().log(
          PLATFORM,
          `Abandon Smart Apply Glassdoor: ${result.reason || "error"} — reprise SERP Glassdoor`,
          "warn"
        );
        if (sNow?.active) {
          await chrome.storage.local.set({
            sessionGlassdoor: {
              ...sNow,
              awaitingIndeed: false,
              indeedHandoffDone: false,
            },
            glassdoorSmartApply: null,
            indeedWizardBusy: null,
          });
        } else {
          await chrome.storage.local.set({ glassdoorSmartApply: null, indeedWizardBusy: null });
        }
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: "glassdoor",
          jobId: jobInfo.jobId || session.currentJk,
          title: jobInfo.title,
          reason: result.reason || "smartapply_failed",
        }).catch(() => {});
        await chrome.runtime.sendMessage({
          action: "closeTabAndResumeIndeed",
          searchUrl: "",
          fromGlassdoor: true,
        }).catch(() => {});
      }
      return;
    }

    const after = await getSession();
    const maxJobs = after?.maxJobs || settings.maxJobsPerSession || 25;
    const flipUrl =
      result.success ? await maybeFlipIndeedPage(after, settings, maxJobs, { navigate: false }) : null;
    // Brief settle so markApplied / post-apply UI commit before SERP resume
    if (result.success) {
      await S().sleep(S().randomDelay(1200, 2200));
      await setSession({
        phase: "search",
        massApplyCooldownUntil: Date.now() + S().randomDelay(2500, 4500),
      });
    } else {
      await setSession({ phase: "search" });
    }
    const resumeUrl = flipUrl || searchReturnUrl((await getSession()) || after || session);
    // Prefer closing smartapply tab and returning to search on fr.indeed
    if (/smartapply\.indeed\.com/i.test(window.location.href)) {
      await chrome.runtime.sendMessage({
        action: "closeTabAndResumeIndeed",
        searchUrl: resumeUrl,
      });
      return;
    }
    window.location.href = resumeUrl;
  }

  async function runAutoApplySession() {
    if (isRunning) return;
    if (!isTopAutomationFrame()) return;
    // v1.4.0: Skip service worker iframes — they're not real apply pages
    const winPath = window.location.pathname || "";
    if (/^\/_\/service_worker/i.test(winPath) || /^\/_\/scripts\//i.test(winPath) || /^\/sw_iframe/i.test(winPath)) {
      return;
    }
    const now = Date.now();
    if (now - lastIndeedRunAt < 2500) return;
    lastIndeedRunAt = now;
    isRunning = true;
    try {
      let session = await getSession();
      // Glassdoor handoff can activate Indeed apply without a full session
      if (!session?.active && isSmartApplyPage()) {
        if (isLoginWallPage() || detectLoginWall()) {
          await chrome.runtime
            .sendMessage({ action: "indeedLoginWall", url: window.location.href })
            .catch(() => {});
          return;
        }
        const { sessionGlassdoor } = await chrome.storage.local.get(["sessionGlassdoor"]);
        if (sessionGlassdoor?.active) {
          const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
          if (amijobsMeta?.indeedLoginRequired) {
            await chrome.runtime
              .sendMessage({ action: "indeedLoginWall", url: window.location.href })
              .catch(() => {});
            return;
          }
          await chrome.storage.local.set({
            sessionIndeed: {
              active: true,
              platform: PLATFORM,
              applied: sessionGlassdoor.applied || 0,
              skipped: 0,
              errors: 0,
              maxJobs: sessionGlassdoor.maxJobs || 25,
              keywords: sessionGlassdoor.keywords || "",
              location: sessionGlassdoor.location || "",
              phase: "apply",
              currentJk: sessionGlassdoor.currentJk || jkFromUrl(),
              searchUrl: sessionGlassdoor.searchUrl || "",
              fromGlassdoor: true,
            },
          });
          session = await getSession();
        }
      }
      if (!session?.active) return;

      // Paused for Indeed login — wait, or auto-resume once auth is gone
      try {
        const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
        if (amijobsMeta?.indeedLoginRequired || session.pausedForLogin) {
          if (isLoginWallPage() || detectLoginWall()) {
            S().log(PLATFORM, "En attente de connexion Indeed…", "warn");
            return;
          }
          // Logged-in again: clear gate on SERP / viewjob / Smart Apply / account→jobs redirect
          const looksAuthed =
            isSearchPage() ||
            isSmartApplyPage() ||
            isViewJobPage() ||
            !!document.querySelector(
              "#mosaic-provider-jobcards, .jobsearch-ResultsList, [data-indeed-apply-jk], [data-testid='continue-button']"
            );
          if (looksAuthed) {
            await chrome.runtime
              .sendMessage({ action: "indeedLoginResolved", reason: "indeed_page_ok" })
              .catch(() => {});
            session = await getSession();
            if (!session?.active) return;
            S().log(PLATFORM, "Connexion Indeed détectée — reprise auto", "success");
          } else {
            return;
          }
        }
      } catch (_e) {}

      if (detectCloudflareChallenge() || detectBlockedPage()) {
        const ok = await tryPassCloudflareChallenge();
        if (!ok && detectBlockedPage() && !detectCloudflareChallenge()) {
          await handleAntiBotBlock("resume");
          return;
        }
        if (!ok && detectCloudflareChallenge()) {
          // STOP — do not re-enter tryPass / navigate / kick. Spamming CF refreshes Ray ID.
          S().log(
            PLATFORM,
            "Cloudflare actif — mass apply en pause. Résolvez la case manuellement, puis rechargez la page une fois.",
            "warn"
          );
          return;
        }
        if (ok) {
          // Fall through to normal routing once cleared
        } else {
          return;
        }
      }
      if (detectLoginWall() && !isSmartApplyPage()) {
        // Sometimes Cloudflare/login interstitial looks like a login wall — try challenge first
        if (detectCloudflareChallenge()) {
          await tryPassCloudflareChallenge();
        }
        if (detectLoginWall() && !isSmartApplyPage()) {
          // Pause + keep auth tab — do not end session / close tab (user must sign in)
          await chrome.runtime
            .sendMessage({
              action: "indeedLoginWall",
              tabId: null,
              url: window.location.href,
              fromGlassdoor: !!session.fromGlassdoor,
            })
            .catch(() => {});
          S().log(
            PLATFORM,
            "Connexion Indeed requise — connectez-vous dans cet onglet; reprise auto ensuite",
            "warn"
          );
          return;
        }
      }
      if (shouldStop) {
        await endSession("Arrêt demandé");
        return;
      }

      const state = await chrome.runtime.sendMessage({ action: "getState" });
      const settings = state?.autoApplySettings || {};
      const url = window.location.href;

      S().log(PLATFORM, `Page: ${new URL(url).pathname} (phase: ${session.phase || "search"})`);

      // Route by URL first — stale phase=viewjob/apply must not steal /jobs SERP
      if (isIndeedOnboardingPage(url)) {
        await handleIndeedOnboardingPage();
      } else if (isSmartApplyPage(url)) {
        await handleApplyPage(session, settings);
      } else if (isViewJobPage(url)) {
        await handleViewJobPage(session, settings);
      } else if (isSearchPage(url)) {
        if (session.phase === "viewjob" || session.phase === "apply") {
          // SPA stayed on SERP with right panel — finish that job, else reset to search
          const hasPanel =
            !!detectAlreadyAppliedUi() ||
            !!findIndeedEasyApplyButton() ||
            !!S().$(
              '[data-testid="appliedSnippet"], [data-testid="jobsearch-JobInfoHeader-title"], .jobsearch-JobInfoHeader-title, h1.jobsearch-JobInfoHeader-title, #jobsearch-ViewJobButtons-container'
            );
          if (session.phase === "viewjob" && hasPanel && session.currentJk) {
            await handleViewJobPage(session, settings);
          } else {
            await setSession({ phase: "search" });
            await handleSearchPage({ ...session, phase: "search" }, settings);
          }
        } else {
          await handleSearchPage(session, settings);
        }
      } else if (session.phase === "apply" && /indeedapply|smartapply/i.test(url)) {
        await handleApplyPage(session, settings);
      } else {
        // Help/support scraped by Glassdoor, login walls, etc. — never yank apply tab to SERP
        // during a Glassdoor handoff (that aborts the Easy Apply flow).
        let gdAwait = false;
        try {
          const { sessionGlassdoor: sGd = null } = await chrome.storage.local.get(["sessionGlassdoor"]);
          gdAwait = !!(sGd?.active && sGd.awaitingIndeed);
        } catch (_e) {}
        const isHelp =
          /help\.|support\.|\/hc\/|guidelines|articles\//i.test(url) ||
          /accounts\.google|recaptcha|just a moment/i.test(document.title || "");
        S().log(PLATFORM, `Page non gérée: ${url}`, "warn");
        if (gdAwait || isHelp || session.fromGlassdoor) {
          return;
        }
        if (session.searchUrl) window.location.href = session.searchUrl;
      }
    } catch (err) {
      S().log(PLATFORM, `Erreur: ${err.message}`, "error");
      await chrome.runtime.sendMessage({
        action: "markError",
        platform: PLATFORM,
        error: err.message,
      });
    } finally {
      isRunning = false;
    }
  }

  async function applySingleJob() {
    if (isRunning) return;
    isRunning = true;
    try {
      const state = await chrome.runtime.sendMessage({ action: "getState" });
      const settings = state?.autoApplySettings || {};
      const jobInfo = getJobInfoFromPage();
      const result = await applyCurrentJob(settings, jobInfo);
      if (result.success) {
        await chrome.runtime.sendMessage({
          action: "markApplied",
          platform: PLATFORM,
          jobId: jobInfo.jobId,
          title: jobInfo.title,
          company: jobInfo.company,
          url: jobInfo.url,
        });
      }
    } finally {
      isRunning = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "startAutoApply") {
      runAutoApplySession().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.action === "applySingleJob") {
      applySingleJob().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.action === "stopAutoApply") {
      shouldStop = true;
      sendResponse({ ok: true });
      return;
    }
    if (msg.action === "getContentStatus") {
      sendResponse({ isRunning, url: window.location.href, version: VERSION });
      return;
    }
  });

  async function checkAndResumeSession() {
    if (!isTopAutomationFrame()) return;
    const start = Date.now();
    while (Date.now() - start < 120000) {
      if (isRunning) return;
      // Never resume-loop into Cloudflare — that reloads Ray IDs
      if (detectCloudflareChallenge()) return;
      try {
        const { amijobsCfPause = null } = await chrome.storage.local.get(["amijobsCfPause"]);
        if (amijobsCfPause?.until && Date.now() < amijobsCfPause.until) return;
      } catch (_e) {}
      const session = await getSession();
      if (!session?.active) return;
      // Don't steal focus from an open Smart Apply wizard
      try {
        const tabs = await chrome.runtime.sendMessage({ action: "listIndeedTabs" }).catch(() => null);
        if (tabs?.hasSmartApply && isSearchPage()) {
          await S().sleep(3000);
          continue;
        }
      } catch (_e) {}
      if (Date.now() - (session.lastRunAt || 0) < 2500) {
        await S().sleep(1500);
        continue;
      }
      await S().sleep(1200);
      if (!isRunning) await runAutoApplySession();
      return;
    }
  }

  S().log(PLATFORM, `Indeed module v${VERSION} chargé`);
  setTimeout(() => {
    getSession().then((session) => {
      if (session?.active || isSmartApplyPage()) runAutoApplySession();
    });
  }, 1800);
  // Early returns (empty SERP retry, Pause SERP) used to stall forever without a resume loop
  setInterval(() => {
    getSession().then((session) => {
      if (session?.active && !isRunning) checkAndResumeSession();
    });
  }, 8000);
})();
