// AmiJobs — Google reCAPTCHA: click + 2captcha token inject (v1.4.5)
// Token MUST be applied in the page MAIN world (grecaptcha.getResponse), not only isolated DOM.
(function () {
  if (window.__AmijobsRecaptchaLoaded) return;
  window.__AmijobsRecaptchaLoaded = true;

  let solving = false;
  let lastSolveAt = 0;
  let lastInjected = "";
  let lastLoggedToken = "";

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
    const isImage = /[?&]type=image\b/i.test(href);
    const isAnchor = /\/anchor|anchor\?/i.test(href) || /[?&]size=normal\b/i.test(href);
    // Prefer checkbox/anchor keys — image/bframe keys often yield "Workers could not solve"
    push(fromQuery, isImage ? 5 : isAnchor ? 90 : 50);

    for (const el of doc.querySelectorAll("[data-sitekey], .g-recaptcha[data-sitekey], [data-recaptcha-sitekey]")) {
      push(el.getAttribute("data-sitekey") || el.getAttribute("data-recaptcha-sitekey"), 80);
    }
    for (const iframe of doc.querySelectorAll('iframe[src*="recaptcha"]')) {
      const src = iframe.getAttribute("src") || "";
      const m = src.match(/[?&]k=(6L[^&]+)/);
      if (!m) continue;
      const k = decodeURIComponent(m[1]);
      let score = 45;
      if (/[?&]type=image\b|\/bframe/i.test(src)) score = 5;
      else if (/\/enterprise\/.+anchor|\/anchor/i.test(src)) score = 95;
      else if (/\/enterprise\//i.test(src)) score = 70;
      else if (/\/api2\/anchor/i.test(src)) score = 90;
      push(k, score);
    }
    keys.sort((a, b) => b.score - a.score);
    return keys.map((x) => x.key);
  }

  function extractEnterpriseFromDoc(doc = document) {
    const href = doc.location?.href || location.href || "";
    if (/\/enterprise\//i.test(href)) return true;
    for (const iframe of doc.querySelectorAll('iframe[src*="recaptcha"]')) {
      if (/\/enterprise\//i.test(iframe.getAttribute("src") || "")) return true;
    }
    return /smartapply\.indeed|indeed\.(com|fr)|glassdoor\./i.test(href + " " + (document.referrer || ""));
  }

  function hostPageUrl() {
    try {
      if (window.top && window.top !== window) {
        try {
          return window.top.location.href;
        } catch (_e) {
          /* cross-origin */
        }
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

  /** Run code in the page MAIN world so grecaptcha callbacks/getResponse work. */
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
      if (window.grecaptcha) patchApi(window.grecaptcha);

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

      // Nudge React/Indeed listeners
      try {
        document.dispatchEvent(new CustomEvent("amijobs-recaptcha-solved", { detail: { token } }));
      } catch (_e) {}
    } catch (_e) {}
  };

  function injectToken(token) {
    if (!token) return false;
    lastInjected = token;
    window.__AmijobsRecaptchaToken = token;

    // Isolated-world DOM fill (shared DOM)
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

    // MAIN world: patch getResponse + fire callbacks (critical for Indeed Smart Apply)
    runInPage(PAGE_INJECT_FN.toString(), token);

    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: "amijobs-recaptcha", token }, "*");
      }
    } catch (_e) {}

    try {
      document.documentElement.setAttribute("data-amijobs-recaptcha-token", "1");
    } catch (_e) {}
    return true;
  }

  window.__AmijobsInjectRecaptchaToken = injectToken;
  window.__AmijobsClickRecaptcha = clickRecaptcha;

  async function solveVia2Captcha(force = false) {
    if (solving) return false;
    if (!force && Date.now() - lastSolveAt < 25000) return !!lastInjected;

    const keys = collectSiteKeys(document);
    if (!keys.length) {
      const iframe = document.querySelector('iframe[src*="recaptcha"]');
      const m = (iframe?.getAttribute("src") || "").match(/[?&]k=(6L[^&]+)/);
      if (m) keys.push(decodeURIComponent(m[1]));
    }
    if (!keys.length) return false;

    solving = true;
    lastSolveAt = Date.now();
    try {
      const pageUrl = hostPageUrl();
      const isEnterprise = extractEnterpriseFromDoc(document);
      let lastErr = "";
      // Try preferred keys; for each try enterprise then classic v2
      for (const key of keys.slice(0, 2)) {
        const attempts = isEnterprise
          ? [
              { type: "recaptcha_enterprise", isEnterprise: true },
              { type: "recaptcha_v2", isEnterprise: false },
            ]
          : [
              { type: "recaptcha_v2", isEnterprise: false },
              { type: "recaptcha_enterprise", isEnterprise: true },
            ];
        for (const attempt of attempts) {
          try {
            const res = await chrome.runtime.sendMessage({
              action: "solveCaptcha",
              type: attempt.type,
              websiteURL: pageUrl,
              websiteKey: key,
              isEnterprise: attempt.isEnterprise,
              injectInTab: true,
            });
            if (res?.ok && res.token) {
              injectToken(res.token);
              return true;
            }
            lastErr = res?.reason || "no_token";
            // Don't retry other modes if workers explicitly failed this key
            if (/workers could not solve/i.test(String(lastErr))) break;
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
    return false;
  }

  window.__AmijobsSolveRecaptcha = solveVia2Captcha;
  window.__AmijobsHasRecaptchaToken = () => {
    const t =
      window.__AmijobsRecaptchaToken ||
      document.querySelector('textarea[name="g-recaptcha-response"]')?.value ||
      "";
    return String(t).length > 40;
  };

  window.addEventListener("message", (ev) => {
    const d = ev?.data;
    if (d && d.source === "amijobs-recaptcha" && d.token) {
      injectToken(d.token);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "injectRecaptchaToken" && msg.token) {
      injectToken(msg.token);
      sendResponse({ ok: true });
      return;
    }
    if (msg.action === "solveRecaptchaNow") {
      solveVia2Captcha(true).then((ok) => sendResponse({ ok }));
      return true;
    }
  });

  const onRecaptchaHost = /google\.com\/recaptcha|recaptcha\.net/i.test(location.href);
  const onApplyHost = /smartapply\.indeed|indeed\.(com|fr)|glassdoor\./i.test(location.href);

  if (onRecaptchaHost) {
    setTimeout(() => clickRecaptcha(), 600);
    setTimeout(() => clickRecaptcha(), 1600);
    setTimeout(() => {
      solveVia2Captcha(true).catch(() => {});
    }, 2200);
  } else if (onApplyHost) {
    const kick = () => {
      if (document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]')) {
        solveVia2Captcha(false).catch(() => {});
      }
    };
    setTimeout(kick, 1500);
    setTimeout(kick, 5000);
    setTimeout(kick, 12000);
    try {
      const mo = new MutationObserver(() => kick());
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 120000);
    } catch (_e) {}
  }
})();
