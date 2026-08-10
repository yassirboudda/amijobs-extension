// AmiJobs — Google reCAPTCHA: click + 2captcha token inject (v1.4.2)
// Critical: token must be injected on the HOST page (smartapply), not only inside the iframe.
(function () {
  if (window.__AmijobsRecaptchaLoaded) return;
  window.__AmijobsRecaptchaLoaded = true;

  let solving = false;
  let lastSolveAt = 0;
  let lastInjected = "";

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

  function extractSiteKeyFromDoc(doc = document) {
    const params = new URLSearchParams(doc.location?.search || location.search || "");
    const fromQuery = params.get("k") || params.get("sitekey");
    if (fromQuery && /^6L/.test(fromQuery)) return fromQuery;

    const el =
      doc.querySelector("[data-sitekey]") ||
      doc.querySelector(".g-recaptcha[data-sitekey]") ||
      doc.querySelector("[data-recaptcha-sitekey]");
    const sk = el?.getAttribute("data-sitekey");
    if (sk && /^6L/.test(sk)) return sk;

    for (const iframe of doc.querySelectorAll('iframe[src*="recaptcha"]')) {
      const src = iframe.getAttribute("src") || "";
      const m = src.match(/[?&]k=(6L[^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    return "";
  }

  function extractEnterpriseFromDoc(doc = document) {
    const href = doc.location?.href || location.href || "";
    if (/\/enterprise\//i.test(href)) return true;
    for (const iframe of doc.querySelectorAll('iframe[src*="recaptcha"]')) {
      if (/\/enterprise\//i.test(iframe.getAttribute("src") || "")) return true;
    }
    return false;
  }

  function hostPageUrl() {
    // Prefer parent Smart Apply URL (required by 2captcha)
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

  function ensureResponseTextarea(token) {
    let area =
      document.querySelector('textarea[name="g-recaptcha-response"]') ||
      document.querySelector("#g-recaptcha-response") ||
      document.querySelector("textarea.g-recaptcha-response");
    if (!area) {
      area = document.createElement("textarea");
      area.name = "g-recaptcha-response";
      area.id = "g-recaptcha-response";
      area.style.display = "none";
      (document.body || document.documentElement).appendChild(area);
    }
    area.value = token;
    area.innerHTML = token;
    area.dispatchEvent(new Event("input", { bubbles: true }));
    area.dispatchEvent(new Event("change", { bubbles: true }));
    return area;
  }

  function invokeGrecaptchaCallbacks(token) {
    const tryCfg = (cfg) => {
      if (!cfg?.clients) return;
      for (const id of Object.keys(cfg.clients)) {
        try {
          const walk = (obj, depth = 0) => {
            if (!obj || depth > 8) return;
            for (const k of Object.keys(obj)) {
              const v = obj[k];
              if (typeof v === "function" && /callback|promise|resolve/i.test(k)) {
                try {
                  v(token);
                } catch (_e) {}
              } else if (v && typeof v === "object") walk(v, depth + 1);
            }
          };
          walk(cfg.clients[id]);
        } catch (_e) {}
      }
    };
    try {
      tryCfg(window.___grecaptcha_cfg);
    } catch (_e) {}
    try {
      if (window.grecaptcha?.enterprise?.getResponse) {
        /* no-op read */
      }
      if (typeof window.grecaptcha?.enterprise?.execute === "function") {
        /* already have token — fire data-callback attrs */
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
  }

  function injectToken(token) {
    if (!token) return false;
    lastInjected = token;
    window.__AmijobsRecaptchaToken = token;
    ensureResponseTextarea(token);
    for (const area of document.querySelectorAll(
      'textarea[name="g-recaptcha-response"], #g-recaptcha-response, textarea.g-recaptcha-response'
    )) {
      area.value = token;
      area.innerHTML = token;
      area.dispatchEvent(new Event("input", { bubbles: true }));
      area.dispatchEvent(new Event("change", { bubbles: true }));
    }
    invokeGrecaptchaCallbacks(token);
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
    const siteKey = extractSiteKeyFromDoc(document);
    if (!siteKey) {
      // Host page: pull key from iframe src
      const iframe = document.querySelector('iframe[src*="recaptcha"]');
      const src = iframe?.getAttribute("src") || "";
      const m = src.match(/[?&]k=(6L[^&]+)/);
      if (!m) return false;
    }
    const key = extractSiteKeyFromDoc(document) || (() => {
      const iframe = document.querySelector('iframe[src*="recaptcha"]');
      const m = (iframe?.getAttribute("src") || "").match(/[?&]k=(6L[^&]+)/);
      return m ? decodeURIComponent(m[1]) : "";
    })();
    if (!key) return false;

    solving = true;
    lastSolveAt = Date.now();
    try {
      const pageUrl = hostPageUrl();
      const isEnterprise = extractEnterpriseFromDoc(document) || /enterprise/i.test(pageUrl);
      const res = await chrome.runtime.sendMessage({
        action: "solveCaptcha",
        type: isEnterprise ? "recaptcha_enterprise" : "recaptcha_v2",
        websiteURL: pageUrl,
        websiteKey: key,
        isEnterprise,
        injectInTab: true,
      });
      if (res?.ok && res.token) {
        injectToken(res.token);
        // Ask parent via postMessage too (iframe → host)
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ source: "amijobs-recaptcha", token: res.token }, "*");
          }
        } catch (_e) {}
        return true;
      }
    } catch (_e) {
      /* ignore */
    } finally {
      solving = false;
    }
    return false;
  }

  window.__AmijobsSolveRecaptcha = solveVia2Captcha;

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
    // Inside widget iframe: click first, then solve with parent URL
    setTimeout(() => clickRecaptcha(), 600);
    setTimeout(() => clickRecaptcha(), 1600);
    setTimeout(() => {
      solveVia2Captcha(true).catch(() => {});
    }, 2200);
  } else if (onApplyHost) {
    // Host page: solve when widget appears
    const kick = () => {
      if (document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]')) {
        solveVia2Captcha(false).catch(() => {});
      }
    };
    setTimeout(kick, 2000);
    setTimeout(kick, 6000);
    setTimeout(kick, 12000);
    try {
      const mo = new MutationObserver(() => kick());
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 90000);
    } catch (_e) {}
  }
})();
