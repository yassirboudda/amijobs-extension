// AmiJobs — Google reCAPTCHA: solvers elsewhere; Indeed = manual native token only (v1.5.6)
// Indeed Smart Apply: Enterprise v2 visible checkbox. Tokens expire ~120s — never
// pre-solve early in the wizard, and re-solve when UI shows "expiré".
// Inject must call ONLY the visible widget callback — firing the invisible client's
// promise-callback with the visible token breaks Indeed's React captcha state.
(function () {
  if (window.__AmijobsRecaptchaLoaded) return;
  window.__AmijobsRecaptchaLoaded = true;

  let solving = false;
  let lastSolveAt = 0;
  let lastInjected = "";
  let lastInjectedAt = 0;

  // HAR 2026-08-15 Smart Apply review:
  // - visible checkbox: 6Ldn8Qwp… size=normal type=image (THIS is what blocks Déposer)
  // - invisible: 6Lcr30sp… size=invisible (must NOT win sitekey ranking)
  const INDEED_SMARTAPPLY_VISIBLE_SITEKEY = "6Ldn8QwpAAAAAAYahgoiLgJ0lHSu9PRHngswlkls";
  const INDEED_SMARTAPPLY_INVISIBLE_SITEKEY = "6Lcr30spAAAAANOd2aQVyfNwAwHyAW6WsatMvrqU";
  // legacy alias
  const INDEED_SMARTAPPLY_SITEKEY = INDEED_SMARTAPPLY_VISIBLE_SITEKEY;
  const TOKEN_MAX_AGE_MS = 90000; // reCAPTCHA v2 tokens die ~2min; stay under 90s

  function clickEl(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      const x = r.left + Math.min(28, Math.max(10, r.width * 0.15));
      const y = r.top + r.height / 2;
      const t = document.elementFromPoint(x, y) || el;
      const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, buttons: 1 };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        try {
          t.dispatchEvent(new MouseEvent(type, o));
        } catch (_e) {}
      }
      try {
        el.click();
      } catch (_e) {}
      return true;
    } catch (_e) {
      return false;
    }
  }

  function clickRecaptcha() {
    let clicked = 0;
    for (const el of document.querySelectorAll(
      '#recaptcha-anchor, .recaptcha-checkbox, .recaptcha-checkbox-border, span[role="checkbox"]'
    )) {
      if (clickEl(el)) clicked++;
    }
    try {
      if (window.top === window) {
        for (const frame of document.querySelectorAll(
          'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], iframe[title*="recaptcha" i]'
        )) {
          if (clickEl(frame)) clicked++;
        }
      }
    } catch (_e) {}
    return clicked > 0;
  }

  function decodeCoParam(co) {
    if (!co) return "";
    try {
      const raw = atob(co);
      return raw.replace(/:443$/, "").replace(/:80$/, "");
    } catch (_e) {
      return "";
    }
  }

  function pageText() {
    try {
      return String(document.body?.innerText || document.documentElement?.innerText || "");
    } catch (_e) {
      return "";
    }
  }

  /** Indeed FR: "Le test de validation a expiré. Cochez à nouveau la case." */
  function isRecaptchaExpiredUi() {
    const t = pageText();
    return /test de validation a expir[ée]|validation a expir[ée]|expir[ée].*case|expired\.?\s*check|verification expired|timed out|a expir[ée]/i.test(
      t
    );
  }

  function readToken() {
    return String(
      window.__AmijobsRecaptchaToken ||
        lastInjected ||
        document.querySelector('textarea[name="g-recaptcha-response"]')?.value ||
        document.querySelector("#g-recaptcha-response")?.value ||
        ""
    );
  }

  function clearToken(reason = "") {
    lastInjected = "";
    lastInjectedAt = 0;
    window.__AmijobsRecaptchaToken = "";
    try {
      window.__AmijobsRecaptchaFreshLogged = false;
    } catch (_e) {}
    try {
      for (const a of document.querySelectorAll(
        'textarea[name="g-recaptcha-response"], #g-recaptcha-response, textarea.g-recaptcha-response'
      )) {
        a.value = "";
        a.innerHTML = "";
      }
    } catch (_e) {}
    try {
      document.documentElement.removeAttribute("data-amijobs-recaptcha-token");
    } catch (_e) {}
    if (reason) {
      try {
        chrome.runtime
          .sendMessage({ action: "appendLog", message: `reCAPTCHA reset: ${reason}`, level: "warn" })
          .catch(() => {});
      } catch (_e) {}
    }
  }

  function hasFreshToken(maxAgeMs = TOKEN_MAX_AGE_MS) {
    if (isRecaptchaExpiredUi()) return false;
    const t = readToken();
    if (!t || t.length < 200) return false;
    if (/^HF[A-Za-z0-9_-]+$/.test(t) && t.length < 1000) return false;
    if (!/^(03A|0cA|03a)/i.test(t) && t.length < 1000) return false;
    if (!lastInjectedAt) return false; // unknown age → treat as stale
    return Date.now() - lastInjectedAt < maxAgeMs;
  }

  function collectSiteKeys(doc = document) {
    const keys = [];
    const push = (k, score = 0) => {
      if (!k || !/^6L[A-Za-z0-9_-]{20,}/.test(k)) return;
      const existing = keys.find((x) => x.key === k);
      if (existing) existing.score = Math.max(existing.score, score);
      else keys.push({ key: k, score });
    };

    const href = doc.location?.href || location.href || "";
    const params = new URLSearchParams(doc.location?.search || location.search || "");
    const fromQuery = params.get("k") || params.get("sitekey");
    const isImage = /[?&]type=image\b|\/bframe/i.test(href);
    const isAnchor = /\/anchor|anchor\?/i.test(href) || /[?&]size=normal\b/i.test(href);
    push(fromQuery, isImage ? 1 : isAnchor ? 95 : 40);

    for (const el of doc.querySelectorAll("[data-sitekey], .g-recaptcha[data-sitekey], [data-recaptcha-sitekey]")) {
      push(el.getAttribute("data-sitekey") || el.getAttribute("data-recaptcha-sitekey"), 85);
    }
    for (const iframe of doc.querySelectorAll('iframe[src*="recaptcha"]')) {
      const src = iframe.getAttribute("src") || "";
      const m = src.match(/[?&]k=(6L[^&]+)/);
      if (!m) continue;
      const k = decodeURIComponent(m[1]);
      let score = 40;
      // Visible review checkbox (HAR: size=normal) must beat invisible
      if (/[?&]size=normal\b/i.test(src)) score = 130;
      else if (/[?&]type=image\b|\/bframe/i.test(src)) score = 5;
      else if (/[?&]size=invisible\b/i.test(src)) score = 20;
      else if (/\/enterprise\/.+anchor|\/api2\/anchor|\/anchor/i.test(src)) score = 90;
      else if (/\/enterprise\//i.test(src)) score = 60;
      push(k, score);
    }

    if (/smartapply\.indeed|indeed\.(com|[a-z]{2})/i.test(href + " " + (document.referrer || ""))) {
      push(INDEED_SMARTAPPLY_VISIBLE_SITEKEY, 125);
      push(INDEED_SMARTAPPLY_INVISIBLE_SITEKEY, 15);
    }

    keys.sort((a, b) => b.score - a.score);
    return keys.map((x) => x.key);
  }

  function detectApiDomain(doc = document) {
    const href = doc.location?.href || location.href || "";
    // Indeed Smart Apply always loads enterprise from recaptcha.net (HAR)
    if (/smartapply\.indeed|indeed\.(com|[a-z]{2})/i.test(href + " " + (document.referrer || ""))) {
      return "www.recaptcha.net";
    }
    if (/recaptcha\.net/i.test(href)) return "www.recaptcha.net";
    for (const iframe of doc.querySelectorAll('iframe[src*="recaptcha"]')) {
      const src = iframe.getAttribute("src") || "";
      if (/recaptcha\.net/i.test(src)) return "www.recaptcha.net";
    }
    return "www.google.com";
  }

  function normalizePageUrl(raw) {
    const href = String(raw || "").trim();
    if (!href) return "";
    try {
      const u = new URL(href);
      // Solvers dislike :443 in origin; Indeed co= often includes it
      if (u.port === "443" || u.port === "80") u.port = "";
      if (/smartapply\.indeed\.com/i.test(u.hostname)) {
        return `${u.origin}${u.pathname}${u.search}`;
      }
      return u.href;
    } catch (_e) {
      return href.replace(/:443(?=\/|$)/, "").replace(/:80(?=\/|$)/, "");
    }
  }

  function hostPageUrl() {
    let href = "";
    try {
      if (window.top && window.top !== window) {
        try {
          href = window.top.location.href;
        } catch (_e) {}
      }
    } catch (_e) {}
    if (!href) {
      const params = new URLSearchParams(location.search || "");
      const fromCo = decodeCoParam(params.get("co"));
      if (fromCo) href = fromCo;
      else if (document.referrer && /indeed|glassdoor|smartapply/i.test(document.referrer)) {
        href = document.referrer;
      } else {
        href = location.href;
      }
    }
    // SPA often stays on applybyapplyablejobid while review-module is shown —
    // CapSolver must bind the token to the review URL Indeed validates against.
    try {
      const u = new URL(href);
      if (/smartapply\.indeed\.com/i.test(u.hostname)) {
        const body = document.body?.innerText || "";
        const onReviewUi =
          /review/i.test(u.pathname) ||
          /relisez votre candidature|passez en revue|déposer ma candidature|je ne suis pas un robot/i.test(body);
        if (onReviewUi && !/review/i.test(u.pathname)) {
          href = `${u.origin}/beta/indeedapply/form/review-module`;
        }
      }
    } catch (_e) {}
    return normalizePageUrl(href) || href;
  }

  function extractEnterpriseS(doc = document) {
    for (const el of doc.querySelectorAll("[data-s], [data-grecaptcha-s]")) {
      const s = el.getAttribute("data-s") || el.getAttribute("data-grecaptcha-s") || "";
      if (s && s.length > 16) return s;
    }
    for (const iframe of doc.querySelectorAll('iframe[src*="recaptcha"]')) {
      const src = iframe.getAttribute("src") || "";
      // Only from visible/normal widget — invisible s is a different session
      if (/[?&]size=invisible\b/i.test(src)) continue;
      const m = src.match(/[?&]s=([^&]+)/);
      if (m) {
        try {
          return decodeURIComponent(m[1]);
        } catch (_e) {
          return m[1];
        }
      }
    }
    return "";
  }

  function runInPage(fnSource, arg) {
    try {
      const script = document.createElement("script");
      script.textContent = `(${fnSource})(${JSON.stringify(arg)});`;
      (document.documentElement || document.head || document.body).appendChild(script);
      script.remove();
      return true;
    } catch (_e) {
      return false;
    }
  }

  // Args: { token, visibleKey, invisibleKey }
  const PAGE_INJECT_FN = function (opts) {
    try {
      const token = typeof opts === "string" ? opts : opts?.token;
      const visibleKey =
        (typeof opts === "object" && opts?.visibleKey) ||
        "6Ldn8QwpAAAAAAYahgoiLgJ0lHSu9PRHngswlkls";
      const invisibleKey =
        (typeof opts === "object" && opts?.invisibleKey) ||
        "6Lcr30spAAAAANOd2aQVyfNwAwHyAW6WsatMvrqU";
      if (!token) return;

      window.__AmijobsRecaptchaToken = token;
      const ensure = () => {
        let area =
          document.querySelector('textarea[name="g-recaptcha-response"]') ||
          document.querySelector("#g-recaptcha-response");
        if (!area) {
          area = document.createElement("textarea");
          area.name = "g-recaptcha-response";
          area.id = "g-recaptcha-response";
          area.style.cssText = "display:none !important";
          (document.body || document.documentElement).appendChild(area);
        }
        area.value = token;
        area.innerHTML = token;
        try {
          area.dispatchEvent(new Event("input", { bubbles: true }));
          area.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (_e) {}
      };
      ensure();
      for (const area of document.querySelectorAll(
        'textarea[name="g-recaptcha-response"], #g-recaptcha-response, textarea.g-recaptcha-response'
      )) {
        area.value = token;
        area.innerHTML = token;
      }

      const patchApi = (api) => {
        if (!api || typeof api !== "object") return;
        try {
          api.getResponse = function () {
            return token;
          };
        } catch (_e) {}
        try {
          if (api.enterprise) {
            api.enterprise.getResponse = function () {
              return token;
            };
          }
        } catch (_e) {}
      };
      patchApi(window.grecaptcha);

      // Indeed SubmitApplication reads captcha.reCaptchaToken from React state,
      // filled by the VISIBLE widget's success callback — not the invisible one.
      // Calling invisible promise-callback with a visible-key token breaks submit.
      const shouldInvoke = (key) => {
        const k = String(key || "");
        if (/expired|error|timeout|reset|cancel|close/i.test(k)) return false;
        // Visible checkbox uses "callback"; do NOT fire promise-callback here
        // (that is the invisible client's path).
        return /^(callback|success-callback|successCallback)$/i.test(k);
      };
      const tryCall = (fn) => {
        if (typeof fn !== "function") return;
        try {
          fn(token);
        } catch (_e) {}
      };
      const findSitekeys = (obj, depth, out) => {
        if (!obj || depth > 8) return;
        try {
          if (typeof obj === "string" && /^6L[A-Za-z0-9_-]{20,}/.test(obj)) out.push(obj);
          else if (typeof obj === "object") {
            for (const k of Object.keys(obj)) {
              const v = obj[k];
              if (typeof v === "string" && /sitekey|siteKey|^k$/i.test(k) && /^6L/.test(v)) out.push(v);
              else if (v && typeof v === "object") findSitekeys(v, depth + 1, out);
            }
          }
        } catch (_e) {}
      };
      const clientKind = (client) => {
        const keys = [];
        findSitekeys(client, 0, keys);
        if (keys.some((k) => k === visibleKey || k.indexOf("6Ldn8Qwp") === 0)) return "visible";
        if (keys.some((k) => k === invisibleKey || k.indexOf("6Lcr30sp") === 0)) return "invisible";
        // clients[0] is usually visible on Smart Apply; 100000 = invisible
        return "unknown";
      };
      const walkSuccess = (obj, depth) => {
        if (!obj || depth > 10) return;
        try {
          for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (typeof v === "function" && shouldInvoke(k)) tryCall(v);
            else if (v && typeof v === "object") walkSuccess(v, depth + 1);
          }
        } catch (_e) {}
      };
      try {
        if (window.___grecaptcha_cfg?.clients) {
          const ids = Object.keys(window.___grecaptcha_cfg.clients);
          const ranked = ids
            .map((id) => {
              const client = window.___grecaptcha_cfg.clients[id];
              const kind = clientKind(client);
              let score = 0;
              if (kind === "visible") score = 100;
              else if (kind === "invisible") score = -50;
              else if (String(id) === "0") score = 40;
              else if (Number(id) >= 100000) score = -40;
              return { id, client, kind, score };
            })
            .sort((a, b) => b.score - a.score);

          for (const row of ranked) {
            if (row.kind === "invisible" || row.score < 0) continue;
            try {
              const gg = row.client?.G?.G;
              if (gg) tryCall(gg.callback);
            } catch (_e) {}
            walkSuccess(row.client, 0);
            // One visible client is enough for Indeed's React state
            if (row.kind === "visible" || row.score >= 40) break;
          }
        }
      } catch (_e) {}

      for (const el of document.querySelectorAll("[data-callback]")) {
        const name = el.getAttribute("data-callback");
        if (name && typeof window[name] === "function") {
          try {
            window[name](token);
          } catch (_e) {}
        }
      }
      try {
        document.dispatchEvent(new CustomEvent("amijobs-recaptcha-solved", { detail: { token } }));
      } catch (_e) {}
    } catch (_e) {}
  };

  function injectToken(token) {
    if (!token || String(token).length < 200) return false;
    if (/^HF[A-Za-z0-9_-]+$/.test(String(token)) && String(token).length < 1000) return false;
    lastInjected = token;
    lastInjectedAt = Date.now();
    window.__AmijobsRecaptchaToken = token;
    try {
      let area =
        document.querySelector('textarea[name="g-recaptcha-response"]') ||
        document.querySelector("#g-recaptcha-response");
      if (!area) {
        area = document.createElement("textarea");
        area.name = "g-recaptcha-response";
        area.id = "g-recaptcha-response";
        area.style.display = "none";
        (document.body || document.documentElement).appendChild(area);
      }
      area.value = token;
      for (const a of document.querySelectorAll(
        'textarea[name="g-recaptcha-response"], #g-recaptcha-response, textarea.g-recaptcha-response'
      )) {
        a.value = token;
        a.innerHTML = token;
      }
    } catch (_e) {}

    runInPage(PAGE_INJECT_FN.toString(), {
      token,
      visibleKey: INDEED_SMARTAPPLY_VISIBLE_SITEKEY,
      invisibleKey: INDEED_SMARTAPPLY_INVISIBLE_SITEKEY,
    });

    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: "amijobs-recaptcha", token }, "*");
      }
    } catch (_e) {}
    try {
      document.documentElement.setAttribute("data-amijobs-recaptcha-token", "1");
      document.documentElement.setAttribute("data-amijobs-recaptcha-at", String(lastInjectedAt));
    } catch (_e) {}
    return true;
  }

  function isWidgetReady() {
    if (isRecaptchaExpiredUi()) return false;
    const token = readToken();
    if (token.length < 40) return false;
    if (!lastInjectedAt) return false;
    if (Date.now() - lastInjectedAt > TOKEN_MAX_AGE_MS) return false;
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

  window.__AmijobsInjectRecaptchaToken = injectToken;
  window.__AmijobsClickRecaptcha = clickRecaptcha;
  window.__AmijobsClearRecaptcha = clearToken;
  window.__AmijobsRecaptchaExpired = isRecaptchaExpiredUi;
  window.__AmijobsHasFreshRecaptchaToken = hasFreshToken;
  window.__AmijobsRecaptchaWidgetReady = isWidgetReady;

  const onRecaptchaHost = /google\.com\/recaptcha|recaptcha\.net/i.test(location.href);
  const onApplyHost = /smartapply\.indeed|indeed\.(com|fr)|glassdoor\./i.test(location.href);

  async function solveVia2Captcha(force = false) {
    // Never burn 2captcha from inside google/recaptcha iframes — host page owns solves.
    if (onRecaptchaHost) {
      try {
        const params = new URLSearchParams(location.search || "");
        const k = params.get("k") || "";
        if (k && !/[?&]type=image\b/i.test(location.href)) {
          window.parent.postMessage(
            { source: "amijobs-recaptcha-sitekey", sitekey: k, href: location.href },
            "*"
          );
        }
      } catch (_e) {}
      return false;
    }

    if (isRecaptchaExpiredUi()) {
      clearToken("ui_expired");
      force = true;
    }

    if (hasFreshToken() && !force) return true;

    // Indeed: try AmiJobs exit API (server CapSolver with user-IP when tunnel supports TCP).
    // If cloud solve fails, content/indeed.js waits for native browser token (manual).
    const onIndeed =
      /smartapply\.indeed|indeed\.(com|[a-z]{2})/i.test(location.href) ||
      /smartapply\.indeed|indeed\.(com|[a-z]{2})/i.test(document.referrer || "");
    if (onIndeed) {
      if (hasFreshToken()) return true;
      const native = String(
        document.querySelector('textarea[name="g-recaptcha-response"]')?.value ||
          document.querySelector("#g-recaptcha-response")?.value ||
          ""
      );
      if (native.length >= 200 && !(/^HF[A-Za-z0-9_-]+$/.test(native) && native.length < 1000)) {
        injectToken(native);
        return true;
      }
      // Fall through to solver path (background → exit.amijobs.com)
    }

    if (solving) return hasFreshToken();
    // Cooldown only when we already have a fresh token; failures retry quickly
    if (!force && Date.now() - lastSolveAt < 5000 && !hasFreshToken()) {
      /* allow */
    } else if (!force && hasFreshToken()) {
      return true;
    } else if (!force && Date.now() - lastSolveAt < 8000) {
      return hasFreshToken();
    }

    const keys = collectSiteKeys(document);
    if (!keys.length) {
      const iframe = document.querySelector('iframe[src*="recaptcha"]');
      const m = (iframe?.getAttribute("src") || "").match(/[?&]k=(6L[^&]+)/);
      if (m) keys.push(decodeURIComponent(m[1]));
    }
    if (!keys.length) return false;

    solving = true;
    lastSolveAt = Date.now();
    // Drop stale token before requesting a new one
    if (force || isRecaptchaExpiredUi() || !hasFreshToken()) clearToken();

    try {
      const pageUrl = hostPageUrl();
      const apiDomain = detectApiDomain(document);
      const enterpriseS = extractEnterpriseS(document);
      const userAgent = navigator.userAgent || "";
      let lastErr = "";

      const attempts = [
        { type: "recaptcha_v2", isEnterprise: false },
        { type: "recaptcha_enterprise", isEnterprise: true },
      ];

      for (const key of keys.slice(0, 3)) {
        for (const attempt of attempts) {
          try {
            chrome.runtime
              .sendMessage({
                action: "appendLog",
                message: `reCAPTCHA ${attempt.type} via solvers key=${key.slice(0, 12)}…`,
                level: "warn",
              })
              .catch(() => {});
          } catch (_e) {}
          try {
            const res = await chrome.runtime.sendMessage({
              action: "solveCaptcha",
              type: attempt.type,
              websiteURL: pageUrl,
              websiteKey: key,
              isEnterprise: attempt.isEnterprise,
              apiDomain,
              userAgent,
              enterprisePayload: enterpriseS ? { s: enterpriseS } : undefined,
              recaptchaDataSValue: enterpriseS || "",
              injectInTab: true,
            });
            if (res?.ok && res.token) {
              injectToken(res.token);
              setTimeout(() => {
                try {
                  injectToken(res.token);
                } catch (_e) {}
              }, 400);
              return true;
            }
            lastErr = res?.reason || "no_token";
          } catch (e) {
            lastErr = e?.message || "send_failed";
          }
        }
      }
      try {
        chrome.runtime
          .sendMessage({ action: "appendLog", message: `reCAPTCHA solvers échec: ${lastErr}`, level: "warn" })
          .catch(() => {});
      } catch (_e) {}
    } finally {
      solving = false;
    }
    return hasFreshToken();
  }

  window.__AmijobsSolveRecaptcha = solveVia2Captcha;
  window.__AmijobsHasRecaptchaToken = () => hasFreshToken() || readToken().length > 40;

  window.addEventListener("message", (ev) => {
    const d = ev?.data;
    if (d && d.source === "amijobs-recaptcha" && d.token) {
      injectToken(d.token);
    }
    if (d && d.source === "amijobs-recaptcha-sitekey" && d.sitekey && onApplyHost) {
      // Only remember sitekey — do NOT auto-solve (tokens expire before review)
      try {
        window.__AmijobsRecaptchaSitekey = d.sitekey;
      } catch (_e) {}
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "injectRecaptchaToken" && msg.token) {
      injectToken(msg.token);
      sendResponse({ ok: true });
      return;
    }
    if (msg.action === "solveRecaptchaNow") {
      solveVia2Captcha(true).then((ok) => sendResponse({ ok, fresh: hasFreshToken() }));
      return true;
    }
    if (msg.action === "clearRecaptchaToken") {
      clearToken(msg.reason || "msg");
      sendResponse({ ok: true });
      return;
    }
  });

  if (onRecaptchaHost) {
    // Inside widget iframe: forward sitekey only (host solves on review)
    setTimeout(() => {
      try {
        const params = new URLSearchParams(location.search || "");
        const k = params.get("k") || "";
        if (k && !/[?&]type=image\b/i.test(location.href)) {
          window.parent.postMessage(
            { source: "amijobs-recaptcha-sitekey", sitekey: k, href: location.href },
            "*"
          );
        }
      } catch (_e) {}
    }, 800);
  } else if (onApplyHost) {
    // Watch for expiry UI and clear stale tokens — do NOT auto-burn 2captcha credits
    setInterval(() => {
      if (isRecaptchaExpiredUi() && readToken().length > 40) {
        clearToken("ui_expired_watch");
      }
    }, 2000);
  }
})();
