// AmiJobs — Cloudflare Turnstile: click + 2captcha (challenge pages need action/cData/chlPageData)
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle?.(el);
    if (s && (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0)) return false;
    return r.width > 0 && r.height > 0;
  }

  function deepQueryAll(root, selector) {
    const out = [];
    const visit = (node) => {
      if (!node) return;
      try {
        if (node.querySelectorAll) out.push(...node.querySelectorAll(selector));
      } catch (_e) {}
      const walk = node.querySelectorAll ? node.querySelectorAll("*") : [];
      for (const el of walk) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root);
    return out;
  }

  function findCheckbox() {
    const selectors = [
      'input[type="checkbox"]',
      '[role="checkbox"]',
      "label.cb-lb",
      ".cb-lb",
      "#challenge-stage input",
      "#challenge-stage [role=checkbox]",
      ".mark",
      "[data-state]",
    ];
    for (const sel of selectors) {
      for (const el of deepQueryAll(document, sel)) {
        if (!isVisible(el)) continue;
        if (el.tagName === "INPUT" && el.type === "hidden") continue;
        if (el.name === "cf-turnstile-response") continue;
        return el;
      }
    }
    const stage = document.querySelector("#challenge-stage, .cf-turnstile");
    if (stage && isVisible(stage)) return stage;
    return null;
  }

  function fireClick(el, clientX, clientY) {
    if (!el) return false;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
    for (const type of [
      "pointerover",
      "mouseover",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ]) {
      try {
        const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, opts));
      } catch (_e) {
        try {
          el.dispatchEvent(new MouseEvent(type, opts));
        } catch (_e2) {}
      }
    }
    try {
      el.click();
    } catch (_e) {}
    return true;
  }

  function clickEl(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch (_e) {}
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(r.left + Math.min(28, r.width * 0.12), r.right - 8));
    const y = r.top + r.height / 2;
    const target = document.elementFromPoint(x, y) || el;
    fireClick(target, x, y);
    if (target !== el) fireClick(el, x, y);
    if (el.tagName === "INPUT" && el.type === "checkbox" && !el.checked) {
      try {
        el.checked = true;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (_e) {}
    }
    return true;
  }

  function clickHostIframes() {
    const frames = [
      ...document.querySelectorAll(
        'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="Widget"], iframe[title*="Cloudflare"], iframe[title*="vérifiez"], iframe[title*="Verify"]'
      ),
    ];
    let n = 0;
    for (const frame of frames) {
      if (!isVisible(frame)) continue;
      const r = frame.getBoundingClientRect();
      fireClick(frame, r.left + 22, r.top + r.height / 2);
      n++;
    }
    return n;
  }

  function looksLikeChallenge() {
    const host = location.hostname || "";
    const text = (document.body?.innerText || "").toLowerCase();
    return (
      /challenges\.cloudflare\.com|turnstile/i.test(host) ||
      !!document.querySelector(".cf-turnstile, #challenge-stage, iframe[src*='challenges.cloudflare']") ||
      /vérifiez que vous êtes humain|verify you are human|checking your browser|just a moment|un instant|confirmez que vous|confirm that you are human/.test(
        text
      )
    );
  }

  function attempt() {
    let clicked = false;
    if (looksLikeChallenge()) {
      const el = findCheckbox();
      if (el) clicked = clickEl(el) || clicked;
      clicked = clickHostIframes() > 0 || clicked;
    } else {
      clicked = clickHostIframes() > 0;
    }
    return clicked;
  }

  async function loop(times = 16, gapMs = 700) {
    for (let i = 0; i < times; i++) {
      try {
        attempt();
      } catch (_e) {}
      await sleep(gapMs);
    }
  }

  function collectSiteKeyDom() {
    const keys = [];
    const push = (k) => {
      if (k && !keys.includes(k)) keys.push(k);
    };
    for (const el of document.querySelectorAll("[data-sitekey], .cf-turnstile[data-sitekey], .g-recaptcha[data-sitekey]")) {
      push(el.getAttribute("data-sitekey"));
    }
    for (const iframe of document.querySelectorAll('iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]')) {
      const src = iframe.getAttribute("src") || "";
      const m = src.match(/[?&](?:sitekey|k)=([^&]+)/i);
      if (m) push(decodeURIComponent(m[1]));
    }
    const attr = document.documentElement.getAttribute("data-amijobs-cf-sitekey");
    if (attr) push(attr);
    return keys;
  }

  function readInterceptedParams() {
    // Prefer params posted from MAIN-world hook
    if (window.__AmijobsCfParamsIsolated) return window.__AmijobsCfParamsIsolated;
    return null;
  }

  window.addEventListener("message", (ev) => {
    const d = ev?.data;
    if (d && d.source === "amijobs-cf-params" && d.params?.sitekey) {
      window.__AmijobsCfParamsIsolated = d.params;
    }
  });

  function deliverTokenToPage(token) {
    if (!token) return;
    for (const input of document.querySelectorAll(
      '[name="cf-turnstile-response"], input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], [name="g-recaptcha-response"]'
    )) {
      try {
        input.value = token;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (_e) {}
    }
    try {
      window.postMessage({ source: "amijobs-cf-token", token }, "*");
    } catch (_e) {}
    try {
      if (window.top && window.top !== window) {
        window.top.postMessage({ source: "amijobs-cf-token", token }, "*");
      }
    } catch (_e) {}
  }

  let solving = false;
  let lastSolveAt = 0;

  async function waitForParams(maxMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const p = readInterceptedParams();
      if (p?.sitekey) return p;
      const keys = collectSiteKeyDom();
      if (keys.length) {
        return {
          sitekey: keys[0],
          action: "",
          data: "",
          pagedata: "",
          userAgent: navigator.userAgent || "",
          pageurl: (() => {
            try {
              return window.top?.location?.href || location.href;
            } catch (_e) {
              return document.referrer || location.href;
            }
          })(),
        };
      }
      await sleep(500);
    }
    return null;
  }

  async function solveTurnstileVia2Captcha(force = false) {
    if (solving) return false;
    if (!force && Date.now() - lastSolveAt < 20000) return false;
    if (!looksLikeChallenge() && !collectSiteKeyDom().length && !readInterceptedParams()) {
      return false;
    }

    solving = true;
    lastSolveAt = Date.now();
    try {
      const params = await waitForParams(30000);
      if (!params?.sitekey) {
        try {
          chrome.runtime
            .sendMessage({
              action: "appendLog",
              message: "Turnstile: sitekey introuvable (hook/DOM)",
              level: "warn",
            })
            .catch(() => {});
        } catch (_e) {}
        return false;
      }

      let pageUrl = params.pageurl || location.href;
      try {
        if (window.top && window.top !== window) pageUrl = window.top.location.href;
      } catch (_e) {
        pageUrl = document.referrer || pageUrl;
      }

      try {
        chrome.runtime
          .sendMessage({
            action: "appendLog",
            message: `2captcha Turnstile… key=${String(params.sitekey).slice(0, 12)}… action=${params.action || "-"}`,
            level: "warn",
          })
          .catch(() => {});
      } catch (_e) {}

      const res = await chrome.runtime.sendMessage({
        action: "solveCaptcha",
        type: "turnstile",
        websiteURL: pageUrl,
        websiteKey: params.sitekey,
        pageAction: params.action || "",
        data: params.data || "",
        pagedata: params.pagedata || "",
        userAgent: params.userAgent || navigator.userAgent || "",
        injectInTab: true,
      });

      if (!res?.ok || !res.token) {
        try {
          chrome.runtime
            .sendMessage({
              action: "appendLog",
              message: `2captcha Turnstile échec: ${res?.reason || "no_token"}`,
              level: "warn",
            })
            .catch(() => {});
        } catch (_e) {}
        return false;
      }

      deliverTokenToPage(res.token);
      // Ask background to also inject via MAIN world executeScript
      try {
        await chrome.runtime.sendMessage({
          action: "injectTurnstileToken",
          token: res.token,
        });
      } catch (_e) {}
      return true;
    } catch (_e) {
      return false;
    } finally {
      solving = false;
    }
  }

  window.__AmijobsClickTurnstile = () => {
    try {
      return attempt();
    } catch (_e) {
      return false;
    }
  };
  window.__AmijobsTurnstileLoop = () => loop();
  window.__AmijobsSolveTurnstile = solveTurnstileVia2Captcha;

  if (!window.__AmijobsTurnstileBooted) {
    window.__AmijobsTurnstileBooted = true;
    const boot = () => {
      loop(12, 600);
      // Prefer 2captcha for managed challenges (clicks alone often fail)
      setTimeout(() => solveTurnstileVia2Captcha(true).catch(() => {}), 1500);
      setTimeout(() => solveTurnstileVia2Captcha(true).catch(() => {}), 8000);
      setTimeout(() => solveTurnstileVia2Captcha(true).catch(() => {}), 20000);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
    try {
      const mo = new MutationObserver(() => {
        try {
          attempt();
        } catch (_e) {}
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 90000);
    } catch (_e) {}
  } else {
    attempt();
    loop(8, 500);
    solveTurnstileVia2Captcha(true).catch(() => {});
  }
})();
