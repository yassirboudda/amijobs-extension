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

  /** LinkedIn offsite/externalApply wrappers are OK — background follows the final ATS URL. */
  function isAllowedJobBoardRedirector(u) {
    return /linkedin\.com\/.+externalApply|linkedin\.com\/.+offsite|linkedin\.com\/jobs\/view\/external/i.test(
      String(u || "")
    );
  }

  function hrefOf(el) {
    if (!el) return "";
    const a = el.tagName === "A" ? el : el.closest?.("a");
    const href = (a && a.href) || el.getAttribute?.("href") || el.dataset?.applyUrl || el.dataset?.externalUrl || "";
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return "";
    try {
      const abs = new URL(href, location.href).href;
      return abs.startsWith("http") ? abs : "";
    } catch (_e) {
      return href.startsWith("http") ? href : "";
    }
  }

  async function resolveExternalUrl(clickEl) {
    let url = hrefOf(clickEl);
    if (url && !isJobBoardUrl(url)) return url;
    if (url && isAllowedJobBoardRedirector(url)) return url;

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
      if (u && isAllowedJobBoardRedirector(u)) return u;
    }

    url = hrefOf(clickEl);
    if (url && !isJobBoardUrl(url)) return url;
    if (url && isAllowedJobBoardRedirector(url)) return url;
    // Never return a same-board URL (HelloWork #postuler, Indeed viewjob, etc.) — that loops tabs
    return "";
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
    if (target && !target.startsWith("http")) {
      try {
        target = new URL(target, location.href).href;
      } catch (_e) {
        target = "";
      }
    }

    // Prefer a known non-board URL without clicking (HelloWork blocks window.open for externals)
    if (target && isJobBoardUrl(target) && !isAllowedJobBoardRedirector(target)) {
      target = "";
    }
    if ((!target || isJobBoardUrl(target)) && clickEl) {
      const direct = hrefOf(clickEl);
      if (direct && !isJobBoardUrl(direct)) target = direct;
      else if (direct && isAllowedJobBoardRedirector(direct)) target = direct;
      else target = await resolveExternalUrl(clickEl);
    }

    if (!target || !target.startsWith("http")) {
      return { ok: false, success: false, reason: "no_url" };
    }
    if (isJobBoardUrl(target) && !isAllowedJobBoardRedirector(target)) {
      return { ok: false, success: false, reason: "job_board_url" };
    }

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
    isAllowedJobBoardRedirector,
    hrefOf,
  };
})();
