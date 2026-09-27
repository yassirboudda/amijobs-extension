// AmiJobs — Cloudflare challenge overlay (MAIN world)
// Turnstile is MANUAL: do NOT patch turnstile.render (that hid the widget for the solver).
(function () {
  function isMassApplyJobBoard() {
    try {
      const h = String(location.hostname || "").toLowerCase();
      if (/(^|\.)indeed\.com$/.test(h) || h === "smartapply.indeed.com") return true;
      if (/(^|\.)glassdoor\./.test(h)) return true;
      return false;
    } catch (_e) {
      return false;
    }
  }
  if (!isMassApplyJobBoard()) return;
  if (window.__AmijobsCfHookInstalled) return;
  window.__AmijobsCfHookInstalled = true;

  function stillChallengePage() {
    try {
      const title = (document.title || "").toLowerCase();
      const text = (document.body && document.body.innerText || "").slice(0, 600).toLowerCase();
      return (
        /just a moment|un instant|additional verification|security check/.test(title) ||
        /additional verification required|verify you are human|vérifiez que vous êtes humain|checking your browser|just a moment/.test(
          text
        ) ||
        !!document.querySelector("#challenge-stage, .cf-turnstile, iframe[src*='challenges.cloudflare']")
      );
    } catch (_e) {
      return false;
    }
  }

  function setOverlay(text) {
    try {
      let el = document.getElementById("amijobs-cf-overlay");
      if (!text) {
        if (el) el.remove();
        return;
      }
      if (!el) {
        el = document.createElement("div");
        el.id = "amijobs-cf-overlay";
        el.setAttribute(
          "style",
          "position:fixed;z-index:2147483647;left:12px;bottom:12px;max-width:460px;padding:12px 14px;" +
            "background:#111;color:#fff;font:13px/1.4 system-ui,sans-serif;border-radius:10px;" +
            "box-shadow:0 8px 28px rgba(0,0,0,.45);border:1px solid #333;"
        );
        (document.documentElement || document.body).appendChild(el);
      }
      el.textContent = text;
    } catch (_e) {}
  }

  function tick() {
    if (stillChallengePage() || window._cf_chl_opt) {
      setOverlay(
        "AmiJobs: Cloudflare Turnstile — cliquez le widget vous-même. AmiJobs attend, puis reprend. reCAPTCHA reste auto."
      );
    } else {
      setOverlay("");
    }
  }

  tick();
  const iv = setInterval(tick, 1500);
  setTimeout(() => clearInterval(iv), 12 * 60 * 1000);
})();
