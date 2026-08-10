// AmiJobs — Cloudflare Turnstile auto-click (runs in challenge iframes + host pages)
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
      } catch (_e) {
        /* ignore */
      }
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
      "label",
    ];
    for (const sel of selectors) {
      for (const el of deepQueryAll(document, sel)) {
        if (!isVisible(el)) continue;
        // Prefer actual checkbox controls over response tokens
        if (el.tagName === "INPUT" && el.type === "hidden") continue;
        if (el.name === "cf-turnstile-response") continue;
        return el;
      }
    }

    // Text node near French/English human-check copy
    const textNodes = [];
    try {
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.textContent || "").trim().toLowerCase();
        if (/vérifiez que vous êtes humain|verify you are human|i'?m not a robot|je ne suis pas un robot/.test(t)) {
          textNodes.push(n.parentElement);
        }
      }
    } catch (_e) {
      /* ignore */
    }
    for (const host of textNodes) {
      const box =
        host?.closest?.("label, .cb-lb, [role=checkbox]") ||
        host?.querySelector?.('input[type="checkbox"], [role=checkbox]') ||
        host?.previousElementSibling ||
        host?.parentElement?.querySelector?.('input[type="checkbox"], [role=checkbox], .mark');
      if (box && isVisible(box)) return box;
    }

    // Fallback: clickable left area of body / challenge stage (checkbox side)
    const stage = document.querySelector("#challenge-stage, .cf-turnstile, body");
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
    const types = [
      "pointerover",
      "mouseover",
      "pointerenter",
      "mouseenter",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ];
    for (const type of types) {
      try {
        const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, opts));
      } catch (_e) {
        try {
          el.dispatchEvent(new MouseEvent(type, opts));
        } catch (_e2) {
          /* ignore */
        }
      }
    }
    try {
      el.click();
    } catch (_e) {
      /* ignore */
    }
    return true;
  }

  function clickEl(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch (_e) {
      /* ignore */
    }
    const r = el.getBoundingClientRect();
    // Prefer left side (~checkbox) for the Turnstile widget
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
      } catch (_e) {
        /* ignore */
      }
    }

    const label = el.closest?.("label") || document.querySelector("label.cb-lb");
    if (label && label !== el) {
      const lr = label.getBoundingClientRect();
      fireClick(label, lr.left + 20, lr.top + lr.height / 2);
    }
    return true;
  }

  function clickHostIframes() {
    // On Indeed/Glassdoor parent pages: poke Turnstile iframes at checkbox coords
    const frames = [
      ...document.querySelectorAll(
        'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="Widget"], iframe[title*="Cloudflare"], iframe[title*="vérifiez"], iframe[title*="Verify"]'
      ),
    ];
    let n = 0;
    for (const frame of frames) {
      if (!isVisible(frame)) continue;
      const r = frame.getBoundingClientRect();
      const x = r.left + 22;
      const y = r.top + r.height / 2;
      fireClick(frame, x, y);
      const under = document.elementFromPoint(x, y);
      if (under && under !== frame) fireClick(under, x, y);
      n++;
    }
    return n;
  }

  function attempt() {
    const host = location.hostname || "";
    const text = (document.body?.innerText || "").toLowerCase();
    const looksLikeChallenge =
      /challenges\.cloudflare\.com|turnstile/i.test(host) ||
      !!document.querySelector(".cf-turnstile, #challenge-stage, iframe[src*='challenges.cloudflare']") ||
      /vérifiez que vous êtes humain|verify you are human|je ne suis pas un robot|checking your browser|just a moment|un instant/.test(
        text
      );

    let clicked = false;
    if (looksLikeChallenge) {
      const el = findCheckbox();
      if (el) {
        console.log("[AmiJobs Turnstile] click challenge control", el.tagName, el.className);
        clicked = clickEl(el) || clicked;
      }
      clicked = clickHostIframes() > 0 || clicked;
    } else {
      clicked = clickHostIframes() > 0;
    }
    try {
      document.documentElement.setAttribute("data-amijobs-turnstile", clicked ? "clicked" : "ready");
    } catch (_e) {
      /* ignore */
    }
    return clicked;
  }

  async function loop(times = 24, gapMs = 700) {
    for (let i = 0; i < times; i++) {
      try {
        attempt();
      } catch (_e) {
        /* ignore */
      }
      await sleep(gapMs);
    }
  }

  async function solveTurnstileVia2Captcha() {
    if (window.__AmijobsTurnstileSolving) return false;
    const widget =
      document.querySelector(".cf-turnstile[data-sitekey], [data-sitekey].cf-turnstile, div[data-sitekey]") ||
      document.querySelector("[data-sitekey]");
    const siteKey =
      widget?.getAttribute?.("data-sitekey") ||
      (() => {
        const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
        const src = iframe?.src || "";
        const m = src.match(/[?&](?:sitekey|k)=([^&]+)/i);
        return m ? decodeURIComponent(m[1]) : "";
      })();
    if (!siteKey) return false;
    window.__AmijobsTurnstileSolving = true;
    try {
      let pageUrl = location.href;
      try {
        if (window.top && window.top !== window) pageUrl = window.top.location.href;
      } catch (_e) {
        pageUrl = document.referrer || pageUrl;
      }
      const res = await chrome.runtime.sendMessage({
        action: "solveCaptcha",
        type: "turnstile",
        websiteURL: pageUrl,
        websiteKey: siteKey,
      });
      if (!res?.ok || !res.token) return false;
      const token = res.token;
      for (const input of document.querySelectorAll(
        '[name="cf-turnstile-response"], input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
      )) {
        input.value = token;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      try {
        if (typeof window.turnstile !== "undefined" && widget) {
          /* best-effort callback via data-callback */
          const cbName = widget.getAttribute("data-callback");
          if (cbName && typeof window[cbName] === "function") window[cbName](token);
        }
      } catch (_e) {}
      return true;
    } catch (_e) {
      return false;
    } finally {
      window.__AmijobsTurnstileSolving = false;
    }
  }

  // Always expose re-trigger (injectTurnstileClicker must be able to re-fire)
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
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => loop());
    } else {
      loop();
    }
    setTimeout(() => {
      solveTurnstileVia2Captcha().catch(() => {});
    }, 3500);
    try {
      const mo = new MutationObserver(() => {
        try {
          attempt();
        } catch (_e) {
          /* ignore */
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 60000);
    } catch (_e) {
      /* ignore */
    }
  } else {
    // Re-injected by background: click immediately + short burst
    attempt();
    loop(8, 500);
    solveTurnstileVia2Captcha().catch(() => {});
  }
})();
