// AmiJobs — early bridge (ISOLATED): MAIN hook params → background orchestrator only
// Restricted to Indeed / Glassdoor mass-apply boards.
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
  if (window.__AmijobsCfBridgeLoaded) return;
  window.__AmijobsCfBridgeLoaded = true;

  let lastSent = "";
  let lastSentAt = 0;

  function readParams() {
    try {
      const raw = sessionStorage.getItem("amijobs_cf_params");
      if (raw) {
        const p = JSON.parse(raw);
        if (p?.sitekey) return p;
      }
    } catch (_e) {}
    try {
      const sitekey = document.documentElement.getAttribute("data-amijobs-cf-sitekey");
      if (sitekey) {
        return {
          sitekey,
          action: document.documentElement.getAttribute("data-amijobs-cf-action") || "",
          data: "",
          pagedata: "",
          pageurl: location.href,
          userAgent: navigator.userAgent || "",
          ray: document.documentElement.getAttribute("data-amijobs-cf-ray") || "",
        };
      }
    } catch (_e) {}
    return null;
  }

  function looksCf() {
    try {
      const title = (document.title || "").toLowerCase();
      const text = (document.body?.innerText || "").slice(0, 500).toLowerCase();
      // Require a real challenge signal — not stale sessionStorage alone
      return (
        /just a moment|un instant|additional verification|security check/.test(title) ||
        /additional verification required|verify you are human|vérifiez que vous êtes humain|checking your browser|just a moment/.test(
          text
        ) ||
        !!window._cf_chl_opt ||
        !!document.querySelector("#challenge-stage, .cf-turnstile, iframe[src*='challenges.cloudflare']")
      );
    } catch (_e) {
      return false;
    }
  }

  function sigOf(p) {
    if (!p?.sitekey) return "";
    return `${p.sitekey}|${p.action || ""}|${p.ray || ""}|${String(p.data || "").slice(0, 40)}`;
  }

  function kick(reason) {
    if (!looksCf()) return;
    const now = Date.now();
    if (now - lastSentAt < 20000) return;
    lastSentAt = now;
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

  window.addEventListener("message", (ev) => {
    const d = ev?.data;
    if (d && d.source === "amijobs-cf-hook-status") {
      try {
        chrome.runtime
          .sendMessage({ action: "appendLog", message: `CF hook: ${d.status}`, level: "warn" })
          .catch(() => {});
      } catch (_e) {}
    }
    if (d && d.source === "amijobs-cf-rejected") {
      lastSent = "";
      lastSentAt = 0;
      return;
    }
    if (d && d.source === "amijobs-cf-params" && d.params?.sitekey) {
      try {
        sessionStorage.setItem("amijobs_cf_params", JSON.stringify(d.params));
      } catch (_e) {}
      kick("postMessage");
    }
  });

  const boot = () => {
    if (!looksCf()) {
      try {
        sessionStorage.removeItem("amijobs_cf_params");
      } catch (_e) {}
      return;
    }
    kick("boot");
  };
  boot();
  // Slow poll only — background owns single-flight
  setInterval(() => {
    if (looksCf()) kick("poll");
  }, 8000);
  document.addEventListener("DOMContentLoaded", () => {
    if (looksCf()) kick("dom");
  });
})();
