// AmiJobs — shared company-website / ATS apply bridge (all job boards)
(function () {
  if (window.AmiJobsCompanySite) return;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isJobBoardUrl(u) {
    return /linkedin\.com|indeed\.(com|fr)|smartapply\.indeed|glassdoor\.(com|fr)|hellowork\.com/i.test(
      String(u || "")
    );
  }

  function hrefOf(el) {
    if (!el) return "";
    const a = el.tagName === "A" ? el : el.closest?.("a");
    const href = (a && a.href) || el.getAttribute?.("href") || el.dataset?.applyUrl || el.dataset?.externalUrl || "";
    return href.startsWith("http") ? href : "";
  }

  async function resolveExternalUrl(clickEl) {
    let url = hrefOf(clickEl);
    if (url && !isJobBoardUrl(url)) return url;

    await chrome.runtime.sendMessage({ action: "watchNextExternalTab", timeoutMs: 15000 }).catch(() => {});
    try {
      if (clickEl?.setAttribute) clickEl.setAttribute("target", "_blank");
    } catch (_e) {}
    try {
      clickEl?.click?.();
    } catch (_e) {}

    for (let i = 0; i < 14; i++) {
      await sleep(900);
      const watched = await chrome.runtime.sendMessage({ action: "getWatchedExternalTab" }).catch(() => null);
      const u = watched?.url || "";
      if (u && u.startsWith("http") && !isJobBoardUrl(u)) return u;
    }

    // LinkedIn/Indeed sometimes leave a redirector URL on the clicked <a>
    url = hrefOf(clickEl);
    if (url && !isJobBoardUrl(url)) return url;
    return url || "";
  }

  /**
   * Open employer career site and run external-apply (CV + reCAPTCHA + submit).
   * @returns {{ ok: boolean, success: boolean, reason?: string, url?: string }}
   */
  async function apply({ url, jobInfo, sourcePlatform, clickEl } = {}) {
    const { autoApplySettings = {} } = await chrome.storage.local.get(["autoApplySettings"]);
    if (autoApplySettings.allowExternalApply === false) {
      return { ok: false, success: false, reason: "external_disabled" };
    }

    let target = String(url || "").trim();
    if ((!target || isJobBoardUrl(target)) && clickEl) {
      target = await resolveExternalUrl(clickEl);
    }
    if (!target || !target.startsWith("http")) {
      return { ok: false, success: false, reason: "no_url" };
    }
    // Allow job-board redirectors (LinkedIn externalApply) — background follows final URL
    try {
      const resp = await chrome.runtime.sendMessage({
        action: "openExternalApply",
        url: target,
        jobInfo: jobInfo || {},
        sourcePlatform: sourcePlatform || "external",
        platform: sourcePlatform || "external",
      });
      return {
        ok: !!(resp?.ok || resp?.success),
        success: !!(resp?.ok || resp?.success),
        reason: resp?.reason || "",
        url: resp?.url || target,
      };
    } catch (e) {
      return { ok: false, success: false, reason: e.message };
    }
  }

  window.AmiJobsCompanySite = {
    apply,
    resolveExternalUrl,
    isJobBoardUrl,
    hrefOf,
  };
})();
