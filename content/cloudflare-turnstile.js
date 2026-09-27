// AmiJobs — Cloudflare Turnstile content helper (ISOLATED)
// Job boards only. Turnstile is manual: log/wait only, never solve.
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
  if (window.__AmijobsTurnstileBooted) return;
  window.__AmijobsTurnstileBooted = true;

  let lastKickAt = 0;

  function looksLikeChallenge() {
    const title = (document.title || "").toLowerCase();
    const text = (document.body?.innerText || "").slice(0, 800).toLowerCase();
    return (
      /just a moment|un instant|additional verification|security check/.test(title) ||
      /additional verification required|verify you are human|vérifiez que vous êtes humain|checking your browser|just a moment/.test(
        text
      ) ||
      !!document.querySelector(".cf-turnstile, #challenge-stage, iframe[src*='challenges.cloudflare']")
    );
  }

  function kickManualHint(reason) {
    if (!looksLikeChallenge()) return;
    const now = Date.now();
    if (now - lastKickAt < 20000) return;
    lastKickAt = now;
    try {
      chrome.runtime
        .sendMessage({
          action: "appendLog",
          message: "Cloudflare Turnstile: cliquez le widget manuellement — AmiJobs attend",
          level: "warn",
        })
        .catch(() => {});
    } catch (_e) {}
  }

  async function solveTurnstileVia2Captcha(force = false, directParams = null) {
    kickManualHint(force ? "force" : "auto", directParams);
    return false;
  }

  window.addEventListener("message", (ev) => {
    const d = ev?.data;
    if (!d) return;
    if (d.source === "amijobs-cf-hook-status") {
      try {
        chrome.runtime
          .sendMessage({ action: "appendLog", message: `CF hook: ${d.status}`, level: "warn" })
          .catch(() => {});
      } catch (_e) {}
    }
    if (d.source === "amijobs-cf-params" && d.params?.sitekey) {
      window.__AmijobsCfParamsIsolated = d.params;
      kickManualHint("params");
    }
    if (d.source === "amijobs-cf-rejected") {
      lastKickAt = 0;
      window.__AmijobsCfParamsIsolated = null;
      try {
        sessionStorage.removeItem("amijobs_cf_params");
      } catch (_e) {}
      try {
        chrome.runtime
          .sendMessage({
            action: "appendLog",
            message: "CF: token rejeté — attente de NOUVEAUX params (cData one-shot)",
            level: "warn",
          })
          .catch(() => {});
      } catch (_e) {}
    }
  });

  window.__AmijobsClickTurnstile = () => false;
  window.__AmijobsTurnstileLoop = () => Promise.resolve();
  window.__AmijobsSolveTurnstile = solveTurnstileVia2Captcha;
  window.__AmijobsLooksLikeCfChallenge = looksLikeChallenge;

  const boot = () => {
    // Clear stale challenge params when SERP is healthy
    if (!looksLikeChallenge()) {
      try {
        sessionStorage.removeItem("amijobs_cf_params");
        document.documentElement.removeAttribute("data-amijobs-cf-ready");
        chrome.storage.local.set({ amijobsCfPause: null });
      } catch (_e) {}
      return;
    }
    kickManualHint("boot");
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
