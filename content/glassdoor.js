// AmiJobs — Glassdoor auto-apply content script (v1.2.7)
// Glassdoor "Easy Apply" often redirects to Indeed Smart Apply (see HAR /jobs/redirects).
(function () {
  if (window.__AmijobsGlassdoorLoaded) return;
  window.__AmijobsGlassdoorLoaded = true;

  const PLATFORM = "glassdoor";
  const VERSION = "1.4.4";
  const S = () => window.AmiJobsShared;
  let isRunning = false;
  let shouldStop = false;
  let lastGlassdoorRunAt = 0;

  // v1.4.0: Intercept anchor clicks that navigate to Indeed.
  // Glassdoor Easy Apply uses <a href="...indeed..."> not window.open,
  // so the window.open override alone doesn't prevent the Glassdoor tab
  // from navigating to Indeed (which causes the open-crash-close loop).
  try {
    document.addEventListener(
      "click",
      (e) => {
        const a = e.target?.closest?.("a");
        if (!a || !a.href) return;
        const href = String(a.href);
        if (/indeed\.(com|fr)|smartapply\.indeed/i.test(href)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          chrome.runtime
            .sendMessage({
              action: "ensurePlatformTab",
              platform: "indeed",
              url: href,
              active: true,
              forceNavigate: true,
            })
            .catch(() => {});
        }
      },
      true
    );
  } catch (_e) {
    /* ignore */
  }

  // Force Indeed/Smart Apply into the single Indeed tab (never spawn extra windows)
  try {
    const nativeOpen = window.open.bind(window);
    window.open = function (url, target, features) {
      const href = String(url || "");
      if (/indeed\.(com|fr)|smartapply\.indeed/i.test(href)) {
        chrome.runtime
          .sendMessage({
            action: "ensurePlatformTab",
            platform: "indeed",
            url: href,
            active: true,
            forceNavigate: true,
          })
          .catch(() => {});
        return null;
      }
      return nativeOpen(url, target, features);
    };
  } catch (_e) {
    /* ignore */
  }

  function isBlockedPage() {
    const text = document.body?.innerText?.toLowerCase() || "";
    const title = document.title?.toLowerCase() || "";
    const hasCfWidget = !!S().$(
      'iframe[src*="challenges.cloudflare.com"], .cf-turnstile, #challenge-stage, #cf-challenge-running'
    );
    const hardBlock =
      text.includes("aidez-nous à protéger glassdoor") ||
      text.includes("help us protect glassdoor") ||
      text.includes("réservé aux humains") ||
      text.includes("bad gateway") ||
      text.includes("ray id:") ||
      title.includes("bad gateway") ||
      title.includes("un instant") ||
      document.body?.innerHTML?.includes("cf-error") ||
      !!S().$("h1")?.textContent?.match(/502|503|429/i);
    const humanCheck =
      text.includes("vérifiez que vous êtes humain") ||
      text.includes("verify you are human") ||
      text.includes("checking your browser") ||
      text.includes("just a moment");
    // v1.4.0: Only return true for actual blocks or active challenges.
    // Previously `hasCfWidget` alone caused false positives (the widget
    // can be present on a normal page without a block), which triggered
    // the open-crash-close loop.
    return hardBlock || (humanCheck && hasCfWidget);
  }

  async function tryPassCloudflareChallenge() {
    const needsCaptcha = () => {
      const text = (document.body?.innerText || "").toLowerCase();
      return (
        text.includes("vérifiez que vous êtes humain") ||
        text.includes("verify you are human") ||
        text.includes("je ne suis pas un robot") ||
        text.includes("checking your browser") ||
        text.includes("just a moment") ||
        text.includes("un instant…") ||
        text.includes("un instant...")
      );
    };
    if (!needsCaptcha() && !S().$('iframe[src*="challenges.cloudflare.com"], .cf-turnstile')) {
      return false;
    }

    S().log(PLATFORM, "Challenge Cloudflare Glassdoor — clic case", "warn");
    try {
      await chrome.runtime.sendMessage({ action: "injectTurnstileClicker" });
    } catch (_e) {
      /* ignore */
    }
    try {
      if (typeof window.__AmijobsClickTurnstile === "function") window.__AmijobsClickTurnstile();
    } catch (_e) {
      /* ignore */
    }
    for (let i = 0; i < 12; i++) {
      if (i > 0 && i % 3 === 0) {
        try {
          await chrome.runtime.sendMessage({ action: "injectTurnstileClicker" });
        } catch (_e) {
          /* ignore */
        }
      }
      for (const frame of S().$$(
        'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="Widget"], iframe[title*="Cloudflare"]'
      )) {
        if (!S().isVisible(frame)) continue;
        const r = frame.getBoundingClientRect();
        const x = r.left + 22;
        const y = r.top + r.height / 2;
        const t = document.elementFromPoint(x, y) || frame;
        const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, buttons: 1 };
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          try {
            t.dispatchEvent(new MouseEvent(type, opts));
          } catch (_e) {
            /* ignore */
          }
        }
        try {
          frame.click();
        } catch (_e) {
          /* ignore */
        }
      }
      for (const el of S().$$('input[type="checkbox"], [role="checkbox"], label.cb-lb')) {
        if (S().isVisible(el)) {
          try {
            await S().humanClick(el);
          } catch (_e) {
            try {
              el.click();
            } catch (_e2) {
              /* ignore */
            }
          }
        }
      }
      await S().sleep(1500);
      if (!needsCaptcha() && !S().$('iframe[src*="challenges.cloudflare.com"], .cf-turnstile')) {
        S().log(PLATFORM, "Challenge Cloudflare passé", "success");
        return true;
      }
      try {
        await chrome.runtime.sendMessage({ action: "injectTurnstileClicker" });
      } catch (_e) {
        /* ignore */
      }
    }
    return !needsCaptcha();
  }

  function isSearchPage(url = window.location.href) {
    return (
      /glassdoor\.(com|fr)\/Job\/jobs\.htm/i.test(url) ||
      /glassdoor\.(com|fr)\/Emploi\/index\.htm/i.test(url) ||
      /glassdoor\.(com|fr)\/Job\/index\.htm/i.test(url) ||
      /glassdoor\.(com|fr)\/Search\/jobs/i.test(url) ||
      // FR SEO SERP: /Emploi/france-formateur-emplois-SRCH_IL.0,6_KO7,16.htm
      /glassdoor\.(com|fr)\/Emploi\/[^/?]*SRCH_/i.test(url) ||
      /glassdoor\.(com|fr)\/Emploi\/[^/?]*-emplois-/i.test(url) ||
      /glassdoor\.(com|fr)\/Job\/[^/?]*SRCH_/i.test(url)
    );
  }

  function isJobDetailPage(url = window.location.href) {
    // Search listing must NOT count as detail
    if (/\/Job\/jobs\.htm/i.test(url) && !/[?&]jl=/.test(url)) return false;
    if (/SRCH_|-emplois-/i.test(url) && !/[?&]jl=/.test(url)) return false;
    return (
      /jobListing/i.test(url) ||
      /partner\/jobListing/i.test(url) ||
      /job-listing/i.test(url) ||
      (/\/Emploi\/[^/?]+/i.test(url) && !/SRCH_|-emplois-/i.test(url)) ||
      /[?&]jl=\d+/i.test(url)
    );
  }

  function buildSearchUrl(keywords, location, page = 0) {
    const host = window.location.hostname.includes("glassdoor.fr")
      ? "https://www.glassdoor.fr"
      : "https://www.glassdoor.com";
    const p = new URLSearchParams();
    if (keywords) p.set("sc.keyword", keywords);
    if (location) p.set("locT", "N");
    if (location) p.set("locId", "");
    if (location) p.set("sc.location", location);
    p.set("applicationType", "1"); // Candidature facile uniquement
    if (page > 0) p.set("p", String(page + 1)); // Glassdoor pages are 1-based in ?p=
    return `${host}/Job/jobs.htm?${p.toString()}`;
  }

  async function ensureEasyApplyOnlyFilter() {
    if (/[?&]applicationType=1\b/i.test(window.location.href)) return false;
    // Prefer URL param (stable) over clicking the pill
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("applicationType", "1");
      S().log(PLATFORM, "Filtre Candidature facile (applicationType=1)", "warn");
      window.location.href = u.toString();
      return true;
    } catch (_e) {}
    const pill =
      S().$('button[data-test="applicationType"]') ||
      [...S().$$("button")].find((b) => /candidature facile uniquement/i.test(b.textContent || ""));
    if (pill && S().isVisible(pill) && pill.getAttribute("aria-pressed") !== "true") {
      S().log(PLATFORM, "Clic filtre Candidature facile uniquement");
      await S().humanClick(pill);
      await S().sleep(2500);
      return false;
    }
    return false;
  }

  function findNextPageUrl(session) {
    const selectors = [
      'button[data-test="pagination-next"]',
      'a[data-test="pagination-next"]',
      'button[aria-label*="Next" i]',
      'button[aria-label*="Suivant" i]',
      'a[aria-label*="Next" i]',
      'a[aria-label*="Suivant" i]',
      'a[rel="next"]',
      '[class*="Pagination"] button:last-child',
      '[class*="pagination"] a[aria-label*="next" i]',
    ];
    for (const sel of selectors) {
      const el = S().$(sel);
      if (!el || !S().isVisible(el)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const href = el.getAttribute("href");
      if (href && !href.startsWith("#") && !/^javascript:/i.test(href)) {
        try {
          return new URL(href, window.location.origin).toString();
        } catch (_e) {
          /* ignore */
        }
      }
      // Button-only pagination: derive next URL
    }

    // Classic Glassdoor path: ...SRCH_....htm → ...SRCH_...._IP2.htm
    try {
      const u = new URL(window.location.href);
      const path = u.pathname;
      const ip = path.match(/_IP(\d+)\.htm/i);
      const nextNum = ip ? parseInt(ip[1], 10) + 1 : 2;
      let nextPath;
      if (ip) nextPath = path.replace(/_IP\d+\.htm/i, `_IP${nextNum}.htm`);
      else if (/\.htm$/i.test(path)) nextPath = path.replace(/\.htm$/i, `_IP${nextNum}.htm`);
      else nextPath = "";
      if (nextPath) {
        u.pathname = nextPath;
        u.searchParams.set("applicationType", "1");
        return u.toString();
      }
      const page = parseInt(u.searchParams.get("p") || "1", 10);
      u.searchParams.set("p", String(page + 1));
      u.searchParams.set("applicationType", "1");
      return u.toString();
    } catch (_e) {
      /* ignore */
    }

    if (session?.keywords != null) {
      return buildSearchUrl(session.keywords, session.location, (session.currentPage || 0) + 1);
    }
    return "";
  }

  function collectJobCards() {
    const selectors = [
      'li[data-test="jobListing"]',
      '[data-test="jobListing"]',
      '[data-test="job-listing"]',
      ".react-job-listing",
      ".JobsList_jobListItem",
      '[class*="JobsList_jobListItem"]',
      "ul.jobsList li",
      "ul[aria-label*='Jobs'] li",
      "article[data-test='job-card']",
      'li[data-brandviews*="JOBS"]',
      'a[data-test="job-link"]',
      'a[href*="jobListing"]',
      'a[href*="partner/jobListing"]',
    ];
    const nodes = new Set();
    for (const sel of selectors) {
      for (const el of S().$$(sel)) {
        const card =
          el.closest('li, article, [data-test="jobListing"], .react-job-listing') || el;
        nodes.add(card);
      }
    }
    const out = [];
    const seen = new Set();
    for (const el of nodes) {
      const href =
        el.querySelector?.("a[href*='jobListing'], a[href*='emploi'], a[href*='Job'], a[data-test='job-link']")
          ?.href ||
        (el.tagName === "A" ? el.href : "") ||
        "";
      const id =
        el.getAttribute("data-id") ||
        el.getAttribute("data-jobid") ||
        el.getAttribute("data-job-id") ||
        href.match(/jobListingId=(\d+)/)?.[1] ||
        href.match(/jl=(\d+)/)?.[1] ||
        href ||
        el.textContent.slice(0, 40);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const title =
        el.querySelector?.('[data-test="job-title"], a[data-test="job-link"], .JobCard_jobTitle')
          ?.textContent?.trim() || "";
      const company =
        el.querySelector?.('[data-test="employer-name"], .EmployerProfile_employerName')
          ?.textContent?.trim() || "";
      out.push({
        element: el,
        jobId: String(id).slice(0, 64),
        href,
        title,
        company,
      });
    }
    return out;
  }

  async function waitForJobCards(maxWaitMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (isBlockedPage()) return [];
      window.scrollBy(0, 400);
      await S().sleep(500);
      const cards = collectJobCards();
      if (cards.length) {
        window.scrollTo(0, 0);
        return cards;
      }
      await S().sleep(1000);
    }
    return collectJobCards();
  }

  async function waitForApplyButton(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const btn = findApplyButton();
      if (btn) return btn;
      await S().sleep(400);
    }
    return null;
  }

  function getJobInfo(jobId) {
    const title =
      S().$('[data-test="job-title"]')?.textContent?.trim() ||
      S().$(".JobCard_jobTitle")?.textContent?.trim() ||
      S().$("h1")?.textContent?.trim() ||
      "";
    const company =
      S().$('[data-test="employer-name"]')?.textContent?.trim() ||
      S().$(".EmployerProfile_employerName")?.textContent?.trim() ||
      "";
    const location = S().$('[data-test="emp-location"]')?.textContent?.trim() || "";
    return { jobId, title, company, location, url: window.location.href };
  }

  function isCompanySiteApplyButton(btn) {
    if (!btn) return false;
    const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.toLowerCase();
    return /site (de l['’]entreprise|de l['’]employeur)|company (site|website)|sur le site|externe|external apply|employer site|site du recruteur/i.test(
      text
    );
  }

  function findCompanySiteButton() {
    const selectors = [
      'a[data-test*="apply" i]',
      'button[data-test*="apply" i]',
      'a[href*="partner"]',
      'a[href*="external"]',
      'a[target="_blank"]',
    ];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes) {
        if (S().isVisible(el) && isCompanySiteApplyButton(el)) return el;
      }
    }
    return S().findActionButton([
      /site (de l['’]entreprise|de l['’]employeur|du recruteur)/i,
      /company (site|website)/i,
      /postuler sur le site/i,
      /apply on (company|employer)/i,
      /external apply/i,
    ]);
  }

  function findEasyApplyButton() {
    const selectors = [
      'button[data-test="easyApply"]',
      '[data-test="easyApply"]',
      '[data-test="easy-apply-button"]',
      '[data-test="applyButton"]',
      'button[data-test="apply-button"]',
      'button[aria-label*="Easy Apply" i]',
      'button[aria-label*="Candidature facile" i]',
      'button[aria-label*="Candidature simplifiée" i]',
      'button[aria-label*="Postuler" i]',
      'a[data-test="easyApply"]',
      'a[aria-label*="Candidature facile" i]',
      'a[aria-label*="Easy Apply" i]',
    ];
    for (const sel of selectors) {
      const el = S().$(sel);
      if (el && S().isVisible(el) && !isCompanySiteApplyButton(el)) return el;
    }
    // Also scan all visible buttons/links by text (Glassdoor FR often uses plain text CTAs)
    for (const el of S().$$('button, a[role="button"], a')) {
      if (!S().isVisible(el) || isCompanySiteApplyButton(el)) continue;
      const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.trim();
      if (
        /candidature facile|easy apply|candidature simplifiée|postuler facilement|quick apply|^postuler$|postuler sur indeed/i.test(
          text
        )
      ) {
        return el;
      }
    }
    return S().findActionButton([
      /candidature facile/i,
      /easy apply/i,
      /candidature simplifiée/i,
      /postuler facilement/i,
      /quick apply/i,
      /^postuler$/i,
      /postuler sur indeed/i,
    ]);
  }

  function findApplyButton() {
    const easy = findEasyApplyButton();
    if (easy) return easy;
    const selectors = [
      '[data-test="applyButton"]',
      '[data-test="apply-button"]',
      'button[data-test*="apply" i]',
      'a[data-test*="apply" i]',
      'button[aria-label*="Candidature" i]',
      'button[aria-label*="Postuler" i]',
    ];
    for (const sel of selectors) {
      const el = S().$(sel);
      if (el && S().isVisible(el)) return el;
    }
    return S().findActionButton([/^postuler$/i, /apply now/i]);
  }

  async function tryCompanySiteApply(settings, jobInfo, clickEl = null) {
    if (settings?.allowExternalApply === false) {
      return { success: false, reason: "external_disabled" };
    }
    if (!window.AmiJobsCompanySite) {
      return { success: false, reason: "company_site_bridge_missing" };
    }
    const btn = clickEl || findCompanySiteButton();
    if (!btn) return { success: false, reason: "no_company_site" };
    const href = window.AmiJobsCompanySite.hrefOf(btn);
    if (
      !href ||
      window.AmiJobsCompanySite.isJobBoardUrl(href) ||
      window.AmiJobsCompanySite.isUnsupportedExternalUrl(href)
    ) {
      // Never burn 55s resolving empty / job-board / Free-Work links
      return { success: false, reason: "no_url" };
    }
    S().log(PLATFORM, `Site entreprise détecté — candidature externe: ${jobInfo.title || jobInfo.jobId}`);
    const extRes = await Promise.race([
      window.AmiJobsCompanySite.apply({
        url: href,
        clickEl: null,
        jobInfo: {
          jobId: jobInfo.jobId,
          title: jobInfo.title,
          company: jobInfo.company,
          url: jobInfo.url || window.location.href,
        },
        sourcePlatform: "glassdoor",
      }),
      S().sleep(20000).then(() => ({ ok: false, success: false, reason: "timeout" })),
    ]);
    if (extRes?.ok || extRes?.success) {
      return { success: true, reason: "company_site_applied", url: extRes.url };
    }
    return { success: false, reason: extRes?.reason || "company_site_apply" };
  }

  function detectApplySuccess() {
    const t = document.body.innerText.toLowerCase();
    return (
      t.includes("application submitted") ||
      t.includes("candidature envoyée") ||
      t.includes("successfully applied") ||
      t.includes("vous avez postulé")
    );
  }

  function detectIndeedHandoff() {
    return (
      /indeed\.(com|fr)/i.test(window.location.href) ||
      /smartapply\.indeed\.com/i.test(window.location.href) ||
      !!document.querySelector('iframe[src*="indeed"], iframe[src*="smartapply"]')
    );
  }

  async function clickJobCard(card) {
    const link =
      card.element.querySelector?.(
        "a[href*='jobListing'], a[href*='emploi'], a[href*='Job'], a.JobCard_jobTitle, a[data-test='job-link'], a[href*='jl=']"
      ) || (card.element.tagName === "A" ? card.element : null);
    if (link) {
      try {
        // Same-tab only — a target=_blank opens a 2nd Glassdoor tab that the
        // tab-merger kills, restarting the session forever without Easy Apply.
        link.removeAttribute("target");
        link.setAttribute("target", "_self");
      } catch (_e) {}
      await S().humanClick(link);
    } else {
      await S().humanClick(card.element);
    }
    await S().sleep(S().randomDelay(1600, 2800));
  }

  async function runApplyWizard(jobInfo, settings) {
    for (let step = 0; step < 14; step++) {
      if (shouldStop) return { success: false, reason: "stopped" };
      if (detectIndeedHandoff()) {
        return { success: true, reason: "indeed_handoff" };
      }
      await S().fillVisibleFields(jobInfo, PLATFORM);
      const submit = S().findActionButton([
        /submit application/i,
        /soumettre/i,
        /send application/i,
        /envoyer/i,
      ]);
      const next = S().findActionButton([/continue|continuer|next|suivant/i]);
      if (submit) {
        if (settings.autoSubmit !== false) {
          await S().humanClick(submit);
          await S().sleep(2500);
          if (detectApplySuccess() || detectIndeedHandoff()) return { success: true };
          return { success: true, reason: "submitted" };
        }
        return { success: false, reason: "review" };
      }
      if (next) {
        await S().humanClick(next);
        await S().sleep(
          S().randomDelay(settings.delayBetweenSteps?.min || 700, settings.delayBetweenSteps?.max || 1600)
        );
        continue;
      }
      break;
    }
    return { success: false, reason: "wizard_timeout" };
  }

  async function waitForEasyApplyButton(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const btn = findEasyApplyButton();
      if (btn) return btn;
      await S().sleep(400);
    }
    return null;
  }

  async function applyCurrentJob(settings, jobInfo) {
    const info = jobInfo || getJobInfo("current");
    // Prefer Easy Apply (→ Indeed Smart Apply). Company-site only with a real employer URL.
    const btn = await waitForEasyApplyButton(8000);
    if (btn) {
      const { sessionGlassdoor: session } = await chrome.storage.local.get(["sessionGlassdoor"]);
      if (session?.active) {
        await chrome.storage.local.set({
          sessionGlassdoor: {
            ...session,
            currentJk: info.jobId,
            currentTitle: info.title,
            currentCompany: info.company,
            awaitingIndeed: true,
            indeedHandoffDone: false,
            lastRunAt: Date.now(),
          },
        });
      }

      await chrome.runtime.sendMessage({
        action: "watchIndeedApplyFromGlassdoor",
        jobInfo: info,
      });

      await S().humanClick(btn);
      await S().sleep(S().randomDelay(1500, 2500));

      if (detectIndeedHandoff()) {
        S().log(PLATFORM, "Redirection Indeed Smart Apply détectée", "success");
        return { success: true, reason: "indeed_handoff" };
      }

      for (let i = 0; i < 16; i++) {
        if (detectApplySuccess()) return { success: true };
        if (detectIndeedHandoff()) return { success: true, reason: "indeed_handoff" };
        const { sessionGlassdoor: s } = await chrome.storage.local.get(["sessionGlassdoor"]);
        if (s?.indeedHandoffDone) {
          await chrome.storage.local.set({
            sessionGlassdoor: { ...s, indeedHandoffDone: false, awaitingIndeed: true },
          });
          S().log(PLATFORM, "Onglet Indeed Smart Apply ouvert", "success");
          return { success: true, reason: "indeed_tab" };
        }
        const modalNext = S().findActionButton([
          /continue|continuer|next|suivant|submit|soumettre|envoyer/i,
        ]);
        const dialog = S().$('[role="dialog"], .modal, [class*="Modal"]');
        if (modalNext && dialog && S().isVisible(dialog)) {
          return runApplyWizard(info, settings);
        }
        await S().sleep(600);
      }

      S().log(PLATFORM, "Handoff Indeed assumé (pas de wizard Glassdoor)", "warn");
      const { sessionGlassdoor: sAssumed } = await chrome.storage.local.get(["sessionGlassdoor"]);
      if (sAssumed?.active) {
        await chrome.storage.local.set({
          sessionGlassdoor: { ...sAssumed, awaitingIndeed: true },
        });
      }
      return { success: true, reason: "indeed_handoff_assumed" };
    }

    const companyRes = await tryCompanySiteApply(settings, info);
    if (companyRes.success) return companyRes;
    return { success: false, reason: companyRes.reason || "no_easy_apply" };
  }

  function alreadyApplied(appliedJobs, jobId) {
    if (!jobId) return false;
    return !!(
      appliedJobs[jobId] ||
      appliedJobs[`gd_${jobId}`] ||
      appliedJobs[`ind_${jobId}`] ||
      Object.keys(appliedJobs || {}).some((k) => k.endsWith(`_${jobId}`) || k === jobId)
    );
  }

  function titleAlreadyHandled(store, title) {
    const t = String(title || "").trim().toLowerCase();
    if (!t) return false;
    return Object.values(store || {}).some((v) => String(v?.title || "").trim().toLowerCase() === t);
  }

  async function alreadyHandled(jobId, title = "") {
    if (!jobId && !title) return false;
    const { appliedJobs = {}, skippedJobs = {} } = await chrome.storage.local.get([
      "appliedJobs",
      "skippedJobs",
    ]);
    if (jobId && alreadyApplied(appliedJobs, jobId)) return true;
    if (title && (titleAlreadyHandled(appliedJobs, title) || titleAlreadyHandled(skippedJobs, title))) {
      return true;
    }
    if (!jobId) return false;
    const keys = Object.keys(skippedJobs || {});
    return keys.some((k) => k === jobId || k === `gd_${jobId}` || k.endsWith(`_${jobId}`));
  }

  async function runAutoApplySession() {
    if (isRunning) return;
    const now = Date.now();
    if (now - lastGlassdoorRunAt < 5000) {
      S().log(PLATFORM, "Cooldown Glassdoor — skip (anti boucle)", "warn");
      return;
    }
    lastGlassdoorRunAt = now;
    isRunning = true;
    shouldStop = false;

    if (isBlockedPage()) {
      S().log(PLATFORM, "Glassdoor protection / Cloudflare — tentative de clic", "warn");
      const ok = await tryPassCloudflareChallenge();
      if (!ok && isBlockedPage()) {
        // Don't kill the whole session — wait and let resume retry
        S().log(PLATFORM, "Cloudflare non résolu — pause (session conservée)", "warn");
        isRunning = false;
        return;
      }
    }

    const { sessionGlassdoor: session } = await chrome.storage.local.get(["sessionGlassdoor"]);
    if (!session?.active) {
      isRunning = false;
      return;
    }

    // v1.4.0: Don't start a new Glassdoor run while an Indeed handoff is in progress.
    // This was a key cause of the open-crash-close loop: Glassdoor navigates its tab
    // to Indeed, background reopens Glassdoor, new Glassdoor starts → repeat.
    if (session.awaitingIndeed) {
      S().log(PLATFORM, "Handoff Indeed en cours — attente (anti-boucle)", "warn");
      isRunning = false;
      return;
    }

    await chrome.storage.local.set({
      sessionGlassdoor: { ...session, lastRunAt: Date.now() },
    });

    const state = await chrome.runtime.sendMessage({ action: "getState" });
    const settings = state?.autoApplySettings || {};
    const maxJobs = session?.maxJobs || settings.maxJobsPerSession || 25;
    const appliedJobs = state?.appliedJobs || {};

    S().log(PLATFORM, `Session Glassdoor démarrée (${session?.applied || 0}/${maxJobs})`);

    // Always force Easy Apply SERP filter
    if (isSearchPage() || /SRCH_|-emplois-/i.test(location.href)) {
      const navigated = await ensureEasyApplyOnlyFilter();
      if (navigated) {
        isRunning = false;
        return;
      }
    }

    // If a real job panel/detail is already open (jl= / jobListing), apply it first.
    // SEO SERP without jl= is handled via cards below (isJobDetailPage already excludes it).
    const onRealDetail = isJobDetailPage();
    const readyApply =
      onRealDetail &&
      (findEasyApplyButton() || findApplyButton() || findCompanySiteButton());
    if (readyApply) {
      const jobInfo = getJobInfo(
        new URLSearchParams(location.search).get("jl") || `gd_${Date.now()}`
      );
      S().log(PLATFORM, `Offre déjà ouverte — clic apply: ${jobInfo.title || jobInfo.jobId}`);
      const result = await applyCurrentJob(settings, jobInfo);
      if (result.success && /indeed/i.test(String(result.reason || ""))) {
        S().log(PLATFORM, `Handoff Indeed: ${jobInfo.title} — attente Smart Apply`, "success");
        // reuse handoff wait below via returning into loop is complex — mark awaiting and stop this run
        isRunning = false;
        return;
      }
      if (result.success) {
        await chrome.runtime.sendMessage({
          action: "markApplied",
          platform: PLATFORM,
          jobId: jobInfo.jobId,
          title: jobInfo.title,
          company: jobInfo.company,
          url: jobInfo.url,
        });
      } else if (result.reason && result.reason !== "no_easy_apply") {
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: PLATFORM,
          jobId: jobInfo.jobId,
          title: jobInfo.title,
          reason: result.reason,
        });
      }
      // Go back to pure search (drop jl) for next cards
      try {
        const u = new URL(window.location.href);
        if (u.searchParams.has("jl")) {
          u.searchParams.delete("jl");
          window.location.href = u.toString();
          isRunning = false;
          return;
        }
      } catch (_e) {}
    }

    const cards = await waitForJobCards(25000);
    if (!cards.length) {
      S().log(PLATFORM, "Aucune offre Glassdoor trouvée", "error");
      await chrome.runtime.sendMessage({
        action: "endPlatformSession",
        platform: PLATFORM,
        reason: "Aucune offre trouvée",
      });
      isRunning = false;
      return;
    }

    S().log(PLATFORM, `${cards.length} offres Glassdoor détectées`);

    try {
      let appliedThisRun = 0;
      const processedIds = new Set();
      for (let i = 0; i < cards.length && !shouldStop; i++) {
        if (isBlockedPage()) {
          S().log(PLATFORM, "Protection Glassdoor détectée — arrêt session", "warn");
          await chrome.runtime.sendMessage({
            action: "endPlatformSession",
            platform: PLATFORM,
            reason: "Arrêt: protection Glassdoor",
          });
          break;
        }

        const { sessionGlassdoor: current, appliedJobs: liveApplied = {} } = await chrome.storage.local.get([
          "sessionGlassdoor",
          "appliedJobs",
        ]);
        if (!current?.active || (current?.applied || 0) >= maxJobs) break;

        const card = cards[i];
        const titleKey = String(card.title || "").trim().toLowerCase();
        if (processedIds.has(card.jobId) || (titleKey && processedIds.has(`t:${titleKey}`))) continue;
        if (
          alreadyApplied(liveApplied, card.jobId) ||
          alreadyApplied(appliedJobs, card.jobId) ||
          (await alreadyHandled(card.jobId, card.title || titleKey))
        ) {
          processedIds.add(card.jobId);
          if (titleKey) processedIds.add(`t:${titleKey}`);
          continue;
        }
        Object.assign(appliedJobs, liveApplied);
        processedIds.add(card.jobId);
        if (titleKey) processedIds.add(`t:${titleKey}`);

        await clickJobCard(card);
        const jobInfo = {
          ...getJobInfo(card.jobId),
          title: getJobInfo(card.jobId).title || card.title,
          company: getJobInfo(card.jobId).company || card.company,
        };

        if (await S().isCompanyBlacklisted(jobInfo.company)) {
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: PLATFORM,
            jobId: jobInfo.jobId,
            title: jobInfo.title,
            reason: `Blacklistée: ${jobInfo.company}`,
          });
          continue;
        }

        const skipCo = await S().shouldSkipCompany(jobInfo.company);
        if (skipCo === "company_limit") {
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: PLATFORM,
            jobId: jobInfo.jobId,
            title: jobInfo.title,
            reason: `Limite entreprise (${jobInfo.company})`,
          });
          continue;
        }

        if (
          window.AmiJobsCompanySite &&
          (await window.AmiJobsCompanySite.shouldSkipFormationOffer(jobInfo.title || "", jobInfo.company || ""))
        ) {
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: PLATFORM,
            jobId: jobInfo.jobId,
            title: jobInfo.title,
            reason: "Offre de formation / CFA (filtrée)",
          });
          continue;
        }

        const btn = await waitForEasyApplyButton(8000);
        const companyBtn = !btn ? findCompanySiteButton() : null;
        if (!btn && !companyBtn) {
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: PLATFORM,
            jobId: jobInfo.jobId,
            title: jobInfo.title,
            reason: "Pas de candidature simplifiée",
          });
          continue;
        }

        const result = await applyCurrentJob(settings, jobInfo);
        if (result.success) {
          if (/company_site/i.test(String(result.reason || ""))) {
            await chrome.runtime.sendMessage({
              action: "markApplied",
              platform: PLATFORM,
              jobId: jobInfo.jobId,
              title: jobInfo.title,
              company: jobInfo.company,
              url: result.url || jobInfo.url,
            });
            appliedThisRun++;
            S().log(PLATFORM, `Postulé (site entreprise): ${jobInfo.title}`, "success");
            const jobDelayCs = Math.max(settings.delayBetweenJobs?.min || 500, 2500);
            const jobDelayCsMax = Math.max(settings.delayBetweenJobs?.max || jobDelayCs, jobDelayCs);
            await S().sleep(S().randomDelay(jobDelayCs, jobDelayCsMax));
            continue;
          }
          const isIndeedHandoff = /indeed/i.test(String(result.reason || ""));
          if (isIndeedHandoff) {
            S().log(PLATFORM, `Handoff Indeed: ${jobInfo.title} — attente Smart Apply`, "success");
            let handoffDone = false;
            const appliedBefore = current.applied || 0;
            for (let w = 0; w < 90; w++) {
              if (shouldStop) break;
              const { sessionGlassdoor: sWait, appliedJobs: jobsWait = {} } = await chrome.storage.local.get([
                "sessionGlassdoor",
                "appliedJobs",
              ]);
              if (
                alreadyApplied(jobsWait, jobInfo.jobId) ||
                alreadyApplied(jobsWait, sWait?.currentJk)
              ) {
                handoffDone = true;
                break;
              }
              if (sWait && (sWait.applied || 0) > appliedBefore) {
                handoffDone = true;
                break;
              }
              if (sWait && !sWait.awaitingIndeed) {
                // Released by a successful Smart Apply finish
                await S().sleep(800);
                const { appliedJobs: jobs2 = {}, sessionGlassdoor: s2 } = await chrome.storage.local.get([
                  "appliedJobs",
                  "sessionGlassdoor",
                ]);
                handoffDone =
                  alreadyApplied(jobs2, jobInfo.jobId) ||
                  alreadyApplied(jobs2, s2?.currentJk) ||
                  !!s2?.indeedHandoffDone ||
                  (s2 && (s2.applied || 0) > appliedBefore);
                if (handoffDone) break;
                // Not applied yet — keep waiting (another Smart Apply attempt may still be running)
              }
              await S().sleep(1000);
            }
            // Fresh read right before deciding success/timeout (avoid race with markApplied)
            await S().sleep(500);
            const { sessionGlassdoor: sClear, appliedJobs: jobsNow = {} } = await chrome.storage.local.get([
              "sessionGlassdoor",
              "appliedJobs",
            ]);
            const matched =
              alreadyApplied(jobsNow, jobInfo.jobId) ||
              alreadyApplied(jobsNow, sClear?.currentJk) ||
              handoffDone ||
              !!sClear?.indeedHandoffDone ||
              (sClear && (sClear.applied || 0) > appliedBefore);
            if (sClear?.awaitingIndeed && matched) {
              await chrome.storage.local.set({
                sessionGlassdoor: { ...sClear, awaitingIndeed: false, indeedHandoffDone: true },
              });
            } else if (sClear?.awaitingIndeed && !matched) {
              await chrome.storage.local.set({
                sessionGlassdoor: { ...sClear, awaitingIndeed: false, indeedHandoffDone: false },
              });
            }
            if (matched) {
              if (!alreadyApplied(jobsNow, jobInfo.jobId)) {
                await chrome.runtime.sendMessage({
                  action: "markApplied",
                  platform: PLATFORM,
                  jobId: jobInfo.jobId,
                  title: jobInfo.title,
                  company: jobInfo.company,
                  url: jobInfo.url,
                });
              }
              appliedThisRun++;
              S().log(PLATFORM, `Postulé (via Indeed): ${jobInfo.title}`, "success");
            } else {
              await chrome.runtime.sendMessage({
                action: "markSkipped",
                platform: PLATFORM,
                jobId: jobInfo.jobId,
                title: jobInfo.title,
                reason: "indeed_handoff_timeout",
              });
              S().log(PLATFORM, `Smart Apply Indeed non terminé: ${jobInfo.title}`, "warn");
            }
          } else {
            await chrome.runtime.sendMessage({
              action: "markApplied",
              platform: PLATFORM,
              jobId: jobInfo.jobId,
              title: jobInfo.title,
              company: jobInfo.company,
              url: jobInfo.url,
            });
            appliedThisRun++;
            S().log(PLATFORM, `Postulé: ${jobInfo.title}`, "success");
          }
        } else {
          // Persist skip so tab restore cannot re-attack the same job (no_url loop)
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: PLATFORM,
            jobId: jobInfo.jobId,
            title: jobInfo.title,
            reason: result.reason || "error",
          });
          const { sessionGlassdoor: sFail } = await chrome.storage.local.get(["sessionGlassdoor"]);
          if (sFail?.awaitingIndeed) {
            await chrome.storage.local.set({
              sessionGlassdoor: { ...sFail, awaitingIndeed: false },
            });
          }
        }

        const jobDelay = Math.max(settings.delayBetweenJobs?.min || 500, 2500);
        const jobDelayMax = Math.max(settings.delayBetweenJobs?.max || jobDelay, jobDelay);
        await S().sleep(S().randomDelay(jobDelay, jobDelayMax));
      }

      const { sessionGlassdoor: updated } = await chrome.storage.local.get(["sessionGlassdoor"]);
      if (!updated?.active || shouldStop) {
        /* stop */
      } else if ((updated.applied || 0) >= maxJobs) {
        await chrome.runtime.sendMessage({
          action: "endPlatformSession",
          platform: PLATFORM,
          reason: "Objectif session atteint",
        });
      } else {
        // Continue to next results page (finish page 1 → start page 2, etc.)
        const nextUrl = findNextPageUrl(updated);
        const nextPage = (updated.currentPage || 0) + 1;
        if (nextUrl && nextPage <= 8) {
          await chrome.storage.local.set({
            sessionGlassdoor: {
              ...updated,
              currentPage: nextPage,
              lastRunAt: Date.now(),
            },
          });
          S().log(PLATFORM, `Page suivante Glassdoor (${nextPage + 1})`, "info");
          isRunning = false;
          lastGlassdoorRunAt = 0; // allow immediate resume on next page
          window.location.href = nextUrl;
          return;
        }
        await chrome.runtime.sendMessage({
          action: "endPlatformSession",
          platform: PLATFORM,
          reason: appliedThisRun ? "Session terminée" : "Session terminée (0 candidature)",
        });
      }
    } catch (err) {
      S().log(PLATFORM, `Erreur: ${err.message}`, "error");
      await chrome.runtime.sendMessage({
        action: "endPlatformSession",
        platform: PLATFORM,
        reason: "Arrêt: erreur",
      });
    }

    isRunning = false;
  }

  async function applySingleJob() {
    if (isRunning) return;
    isRunning = true;
    const state = await chrome.runtime.sendMessage({ action: "getState" });
    const result = await applyCurrentJob(state?.autoApplySettings || {}, getJobInfo(`gd_${Date.now()}`));
    if (result.success && !String(result.reason || "").includes("indeed")) {
      const jobInfo = getJobInfo(`gd_${Date.now()}`);
      await chrome.runtime.sendMessage({
        action: "markApplied",
        platform: PLATFORM,
        jobId: jobInfo.jobId,
        title: jobInfo.title,
        company: jobInfo.company,
        url: jobInfo.url,
      });
    }
    isRunning = false;
  }

  async function checkAndResumeSession() {
    if (!isSearchPage() && !isJobDetailPage()) return;
    // v1.4.0: Don't resume if tab navigated to Indeed (handoff in progress)
    if (/indeed\.(com|fr)|smartapply\.indeed/i.test(window.location.href)) return;
    if (isBlockedPage()) {
      await tryPassCloudflareChallenge();
      if (isBlockedPage()) return;
    }
    const start = Date.now();
    while (Date.now() - start < 60000) {
      const { sessionGlassdoor: session } = await chrome.storage.local.get(["sessionGlassdoor"]);
      if (session?.active && !session.awaitingIndeed && !isRunning) {
        // Only skip if another run finished very recently on THIS tab cycle
        if (session.lastRunAt && Date.now() - session.lastRunAt < 8000) {
          await S().sleep(2500);
          continue;
        }
        await S().sleep(1500);
        await runAutoApplySession();
        return;
      }
      if (isRunning) return;
      await S().sleep(2000);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "startAutoApply") {
      runAutoApplySession().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.action === "applySingleJob") {
      applySingleJob().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.action === "stopAutoApply") {
      shouldStop = true;
      sendResponse({ ok: true });
      return;
    }
    if (msg.action === "getContentStatus") {
      sendResponse({ isRunning, url: window.location.href, version: VERSION });
      return;
    }
  });

  S().log(PLATFORM, `Glassdoor module v${VERSION} chargé`);
  if (isSearchPage() || isJobDetailPage()) checkAndResumeSession();
  else {
    // SPA / soft-nav: still poll for an active session
    setTimeout(() => checkAndResumeSession().catch(() => {}), 2500);
  }
})();
