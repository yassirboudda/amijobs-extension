// AmiJobs — Google reCAPTCHA: click checkbox + optional 2captcha token inject
(function () {
  if (window.__AmijobsRecaptchaLoaded) return;
  window.__AmijobsRecaptchaLoaded = true;

  let solving = false;
  let lastSolveAt = 0;

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
    const anchors = [
      ...document.querySelectorAll(
        '#recaptcha-anchor, .recaptcha-checkbox, .recaptcha-checkbox-border, span[role="checkbox"]'
      ),
    ];
    for (const el of anchors) {
      if (clickEl(el)) clicked++;
    }
    const cb = document.querySelector(".recaptcha-checkbox-border, #recaptcha-anchor");
    if (cb && clickEl(cb)) clicked++;

    try {
      if (!(window.top && window.top !== window)) {
        for (const frame of document.querySelectorAll(
          'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], iframe[title*="recaptcha" i]'
        )) {
          if (clickEl(frame)) clicked++;
        }
      }
    } catch (_e) {}

    document.documentElement.setAttribute("data-amijobs-recaptcha", String(Date.now()));
    return clicked > 0;
  }

  function extractSiteKey() {
    const params = new URLSearchParams(location.search || "");
    const fromQuery = params.get("k") || params.get("sitekey");
    if (fromQuery) return fromQuery;
    const el =
      document.querySelector("[data-sitekey]") ||
      document.querySelector(".g-recaptcha[data-sitekey]") ||
      document.querySelector("[data-recaptcha-sitekey]");
    if (el?.getAttribute("data-sitekey")) return el.getAttribute("data-sitekey");
    const iframe = document.querySelector('iframe[src*="recaptcha"]');
    const src = iframe?.getAttribute("src") || "";
    const m = src.match(/[?&]k=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function injectToken(token) {
    if (!token) return false;
    const areas = [
      ...document.querySelectorAll(
        'textarea[name="g-recaptcha-response"], #g-recaptcha-response, textarea.g-recaptcha-response'
      ),
    ];
    for (const area of areas) {
      area.value = token;
      area.innerHTML = token;
      area.dispatchEvent(new Event("input", { bubbles: true }));
      area.dispatchEvent(new Event("change", { bubbles: true }));
    }
    try {
      if (typeof window.___grecaptcha_cfg !== "undefined") {
        const clients = window.___grecaptcha_cfg.clients || {};
        for (const id of Object.keys(clients)) {
          try {
            const client = clients[id];
            const walk = (obj, depth = 0) => {
              if (!obj || depth > 6) return;
              for (const k of Object.keys(obj)) {
                const v = obj[k];
                if (typeof v === "function" && /callback/i.test(k)) {
                  try {
                    v(token);
                  } catch (_e) {}
                } else if (v && typeof v === "object") walk(v, depth + 1);
              }
            };
            walk(client);
          } catch (_e) {}
        }
      }
    } catch (_e) {}
    return areas.length > 0;
  }

  async function solveVia2Captcha() {
    if (solving) return false;
    if (Date.now() - lastSolveAt < 45000) return false;
    const siteKey = extractSiteKey();
    if (!siteKey) return false;
    solving = true;
    lastSolveAt = Date.now();
    try {
      let pageUrl = location.href;
      try {
        if (window.top && window.top !== window) pageUrl = window.top.location.href;
      } catch (_e) {
        pageUrl = document.referrer || pageUrl;
      }
      const isEnterprise = /enterprise/i.test(location.href + siteKey);
      const res = await chrome.runtime.sendMessage({
        action: "solveCaptcha",
        type: isEnterprise ? "recaptcha_enterprise" : "recaptcha_v2",
        websiteURL: pageUrl,
        websiteKey: siteKey,
        isEnterprise,
      });
      if (res?.ok && res.token) {
        injectToken(res.token);
        return true;
      }
    } catch (_e) {
      /* ignore */
    } finally {
      solving = false;
    }
    return false;
  }

  window.__AmijobsClickRecaptcha = clickRecaptcha;
  window.__AmijobsSolveRecaptcha = solveVia2Captcha;

  if (/google\.com\/recaptcha|recaptcha\.net/i.test(location.href)) {
    const tryClick = () => clickRecaptcha();
    tryClick();
    setTimeout(tryClick, 800);
    setTimeout(tryClick, 2000);
    setTimeout(() => {
      solveVia2Captcha().catch(() => {});
    }, 2500);
  } else {
    // Host page with widget: try 2captcha after a short delay if checkbox did not clear
    setTimeout(() => {
      if (document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]')) {
        solveVia2Captcha().catch(() => {});
      }
    }, 4000);
  }
})();
