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

  /** Partner boards AmiJobs does NOT apply on (HelloWork “site partenaire”, etc.). */
  function isUnsupportedExternalUrl(u) {
    try {
      const host = new URL(String(u || ""), "https://example.com").hostname.replace(/^www\./i, "").toLowerCase();
      return (
        host === "free-work.com" ||
        host.endsWith(".free-work.com") ||
        host === "freelance.com" ||
        host.endsWith(".freelance.com") ||
        host === "malt.fr" ||
        host === "malt.com" ||
        host.endsWith(".malt.fr") ||
        host.endsWith(".malt.com") ||
        host === "codeur.com" ||
        host.endsWith(".codeur.com")
      );
    } catch (_e) {
      return /free-work\.com|freelance\.com|(^|\.)malt\.(fr|com)|codeur\.com/i.test(String(u || ""));
    }
  }

  /** LinkedIn offsite/externalApply wrappers are OK — background follows the final ATS URL. */
  function isAllowedJobBoardRedirector(u) {
    return /linkedin\.com\/.+externalApply|linkedin\.com\/.+offsite|linkedin\.com\/jobs\/view\/external/i.test(
      String(u || "")
    );
  }

  /**
   * Schools / CFAs posting “alternance” slots to fill their training catalog —
   * not real employer job offers. Default filter is ON via skipFormationOffers.
   */
  function isFormationOffer(title = "", company = "", text = "") {
    const blob = `${title}\n${company}\n${text}`.toLowerCase();
    const companyOnly = String(company || "").toLowerCase().trim();

    // Known training / CFA brands & patterns (company name is the school, not an employer)
    if (
      /\b(cfa|afpa|greta|aftral|iscod|ionis|ifocop|maestris|sup'?career|nuevo cfa|imc alternance|openclassrooms|simplon|wild code|le wagon)\b/i.test(
        companyOnly
      )
    ) {
      return true;
    }
    if (/\b(centre|organisme) de formation\b/i.test(companyOnly)) return true;
    if (/\bécoles?\b|\becoles?\b|\bcampus\b/i.test(companyOnly) && /formation|alternance|apprentissage/i.test(companyOnly)) {
      return true;
    }
    // "Something Alternance" as company (IMC Alternance, AFTRAL alternance…)
    if (/\balternance\s*$/i.test(companyOnly) || /\balternance\b/.test(companyOnly) && /\b(cfa|groupe|éducation|education)\b/i.test(companyOnly)) {
      return true;
    }

    // Offer copy = recruiting students into a training center
    if (
      /intégrer (notre |le |un )?(cfa|centre de formation|campus|école|ecole)/i.test(blob) ||
      /rejoindre (notre |le )?(centre de formation|cfa|campus)/i.test(blob) ||
      /devenir apprenant|inscription (à |a )?(la )?formation/i.test(blob) ||
      /trouver mon (alternance|école|ecole)|organisme de formation recherche/i.test(blob) ||
      /centre de formation recherche|pour (notre|nos) promotion/i.test(blob) ||
      /rentrée\s+\d{4}.*(formation|cfa|alternance)/i.test(blob)
    ) {
      return true;
    }

    // Title is clearly a training enrollment pitch
    if (
      /inscription formation|candidature (cfa|centre de formation)|apprenant(e)? h\/?f/i.test(String(title || ""))
    ) {
      return true;
    }

    return false;
  }

  async function shouldSkipFormationOffer(title, company, text) {
    const { autoApplySettings = {} } = await chrome.storage.local.get(["autoApplySettings"]);
    if (autoApplySettings.skipFormationOffers === false) return false;
    return isFormationOffer(title, company, text);
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
    if (url && isUnsupportedExternalUrl(url)) return "";
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
      if (u && isUnsupportedExternalUrl(u)) return "";
      if (u && u.startsWith("http") && !isJobBoardUrl(u)) return u;
      if (u && isAllowedJobBoardRedirector(u)) return u;
    }

    url = hrefOf(clickEl);
    if (url && isUnsupportedExternalUrl(url)) return "";
    if (url && !isJobBoardUrl(url)) return url;
    if (url && isAllowedJobBoardRedirector(url)) return url;
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

    if (target && isUnsupportedExternalUrl(target)) {
      return { ok: false, success: false, reason: "unsupported_partner", url: target };
    }

    // Prefer a known non-board URL without clicking (HelloWork blocks window.open for externals)
    if (target && isJobBoardUrl(target) && !isAllowedJobBoardRedirector(target)) {
      target = "";
    }
    if ((!target || isJobBoardUrl(target)) && clickEl) {
      const direct = hrefOf(clickEl);
      if (direct && isUnsupportedExternalUrl(direct)) {
        return { ok: false, success: false, reason: "unsupported_partner", url: direct };
      }
      if (direct && !isJobBoardUrl(direct)) target = direct;
      else if (direct && isAllowedJobBoardRedirector(direct)) target = direct;
      else target = await resolveExternalUrl(clickEl);
    }

    if (!target || !target.startsWith("http")) {
      return { ok: false, success: false, reason: "no_url" };
    }
    if (isUnsupportedExternalUrl(target)) {
      return { ok: false, success: false, reason: "unsupported_partner", url: target };
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
    isUnsupportedExternalUrl,
    isFormationOffer,
    shouldSkipFormationOffer,
    hrefOf,
  };
})();
