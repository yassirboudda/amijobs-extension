// AmiJobs — intercept Cloudflare turnstile.render BEFORE the widget loads (MAIN world bridge)
// Must run at document_start on Indeed / Glassdoor / challenges.cloudflare.com
(function () {
  if (window.__AmijobsTurnstileHookLoaded) return;
  window.__AmijobsTurnstileHookLoaded = true;

  const HOOK_SRC = function () {
    if (window.__AmijobsCfHookInstalled) return;
    window.__AmijobsCfHookInstalled = true;
    window.__AmijobsCfParams = null;
    window.__AmijobsCfCallback = null;

    const publish = (params) => {
      try {
        window.__AmijobsCfParams = params;
        window.dispatchEvent(new CustomEvent("amijobs-cf-params", { detail: params }));
        window.postMessage({ source: "amijobs-cf-params", params }, "*");
        document.documentElement.setAttribute("data-amijobs-cf-ready", "1");
        document.documentElement.setAttribute("data-amijobs-cf-sitekey", params.sitekey || "");
      } catch (_e) {}
    };

    const install = () => {
      if (!window.turnstile || typeof window.turnstile.render !== "function") return false;
      if (window.turnstile.__amijobsPatched) return true;
      const original = window.turnstile.render.bind(window.turnstile);
      window.turnstile.render = function (container, options) {
        try {
          const opts = options || {};
          const params = {
            sitekey: opts.sitekey || "",
            action: opts.action || "",
            data: opts.cData || opts.data || "",
            pagedata: opts.chlPageData || opts.pagedata || "",
            userAgent: navigator.userAgent || "",
            pageurl: location.href,
          };
          if (typeof opts.callback === "function") {
            window.__AmijobsCfCallback = opts.callback;
          }
          publish(params);
        } catch (_e) {}
        try {
          return original(container, options);
        } catch (_e2) {
          // Still return a fake widget id so page continues
          return "amijobs-cf";
        }
      };
      window.turnstile.__amijobsPatched = true;
      return true;
    };

    const iv = setInterval(() => {
      if (install()) clearInterval(iv);
    }, 20);
    setTimeout(() => clearInterval(iv), 120000);

    window.addEventListener("message", (ev) => {
      const d = ev?.data;
      if (!d || d.source !== "amijobs-cf-token" || !d.token) return;
      try {
        const inputs = document.querySelectorAll(
          '[name="cf-turnstile-response"], input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], [name="g-recaptcha-response"]'
        );
        for (const input of inputs) {
          input.value = d.token;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (typeof window.__AmijobsCfCallback === "function") {
          window.__AmijobsCfCallback(d.token);
        }
        // Common Cloudflare challenge completion hooks
        if (typeof window.cfCallback === "function") window.cfCallback(d.token);
        if (typeof window.tsCallback === "function") window.tsCallback(d.token);
        window.dispatchEvent(new CustomEvent("amijobs-cf-solved", { detail: { token: d.token } }));
      } catch (_e) {}
    });
  };

  function inject() {
    try {
      const s = document.createElement("script");
      s.textContent = `(${HOOK_SRC})();`;
      const root = document.documentElement || document.head || document.documentElement;
      if (!root) return false;
      root.appendChild(s);
      s.remove();
      return true;
    } catch (_e) {
      return false;
    }
  }

  if (!inject()) {
    const mo = new MutationObserver(() => {
      if (inject()) mo.disconnect();
    });
    mo.observe(document, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 15000);
  }
})();
