// AmiJobs — Google reCAPTCHA: 2captcha token inject (v1.4.17)
// Indeed Smart Apply: RecaptchaV2TaskProxyless only. Tokens expire ~120s — never
// pre-solve early in the wizard, and re-solve when UI shows "expiré".
(function () {
  if (window.__AmijobsRecaptchaLoaded) return;
  window.__AmijobsRecaptchaLoaded = true;

  let solving = false;
  let lastSolveAt = 0;
  let lastInjected = "";
  let lastInjectedAt = 0;

  // Known Indeed Smart Apply checkbox key (from live HAR /enterprise/anchor?k=…)
  const INDEED_SMARTAPPLY_SITEKEY = "6Lcr30spAAAAANOd2aQVyfNwAwHyAW6WsatMvrqU";
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
    if (t.length < 40) return false;
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
      if (/[?&]type=image\b|\/bframe/i.test(src)) score = 1;
      else if (/\/enterprise\/.+anchor|\/api2\/anchor|\/anchor/i.test(src)) score = 100;
      else if (/\/enterprise\//i.test(src)) score = 60;
      push(k, score);
    }

    if (/smartapply\.indeed|indeed\.(com|fr)/i.test(href + " " + (document.referrer || ""))) {
      push(INDEED_SMARTAPPLY_SITEKEY, 110);
    }

    keys.sort((a, b) => b.score - a.score);
    return keys.map((x) => x.key);
  }

  function detectApiDomain(doc = document) {
    const href = doc.location?.href || location.href || "";
    if (/recaptcha\.net/i.test(href)) return "www.recaptcha.net";
    for (const iframe of doc.querySelectorAll('iframe[src*="recaptcha"]')) {
      const src = iframe.getAttribute("src") || "";
      if (/recaptcha\.net/i.test(src)) return "www.recaptcha.net";
    }
    return "www.google.com";
  }

  function hostPageUrl() {
    try {
      if (window.top && window.top !== window) {
        try {
          return window.top.location.href;
        } catch (_e) {}
      }
    } catch (_e) {}
    const params = new URLSearchParams(location.search || "");
    const fromCo = decodeCoParam(params.get("co"));
    if (fromCo) return fromCo;
    if (document.referrer && /indeed|glassdoor|smartapply/i.test(document.referrer)) {
      return document.referrer;
    }
    return location.href;
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

  const PAGE_INJECT_FN = function (token) {
    try {
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

      const walk = (obj, depth) => {
        if (!obj || depth > 10) return;
        try {
          for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (typeof v === "function" && /callback|promise|resolve|success/i.test(String(k))) {
              try {
                v(token);
              } catch (_e) {}
            } else if (v && typeof v === "object") walk(v, depth + 1);
          }
        } catch (_e) {}
      };
      try {
        if (window.___grecaptcha_cfg?.clients) {
          for (const id of Object.keys(window.___grecaptcha_cfg.clients)) {
            walk(window.___grecaptcha_cfg.clients[id], 0);
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
    if (!token || String(token).length < 40) return false;
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

    runInPage(PAGE_INJECT_FN.toString(), token);

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

  window.__AmijobsInjectRecaptchaToken = injectToken;
  window.__AmijobsClickRecaptcha = clickRecaptcha;
  window.__AmijobsClearRecaptcha = clearToken;
  window.__AmijobsRecaptchaExpired = isRecaptchaExpiredUi;
  window.__AmijobsHasFreshRecaptchaToken = hasFreshToken;

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
    if (!keys.length && /smartapply\.indeed|indeed\.(com|fr)/i.test(location.href)) {
      keys.push(INDEED_SMARTAPPLY_SITEKEY);
    }
    if (!keys.length) return false;

    solving = true;
    lastSolveAt = Date.now();
    // Drop stale token before requesting a new one
    if (force || isRecaptchaExpiredUi() || !hasFreshToken()) clearToken();

    try {
      const pageUrl = hostPageUrl();
      const apiDomain = detectApiDomain(document);
      let lastErr = "";

      // Classic v2 ONLY for Indeed — enterprise burns time then fails with same sitekey
      const attempts = /smartapply\.indeed|indeed\.(com|fr)/i.test(pageUrl)
        ? [{ type: "recaptcha_v2", isEnterprise: false }]
        : [
            { type: "recaptcha_v2", isEnterprise: false },
            { type: "recaptcha_enterprise", isEnterprise: true },
          ];

      for (const key of keys.slice(0, 2)) {
        for (const attempt of attempts) {
          try {
            chrome.runtime
              .sendMessage({
                action: "appendLog",
                message: `2captcha reCAPTCHA ${attempt.type} key=${key.slice(0, 12)}…`,
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
              injectInTab: true,
            });
            if (res?.ok && res.token) {
              injectToken(res.token);
              // Do NOT click the checkbox after inject — that resets/expires the token
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
          .sendMessage({ action: "appendLog", message: `2captcha échec: ${lastErr}`, level: "warn" })
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
