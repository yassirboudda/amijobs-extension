// AmiJobs — Glassdoor auto-apply content script (v1.2.7)
// Glassdoor "Easy Apply" often redirects to Indeed Smart Apply (see HAR /jobs/redirects).
(function () {
  if (window.__AmijobsGlassdoorLoaded) return;
  window.__AmijobsGlassdoorLoaded = true;

  const PLATFORM = "glassdoor";
  const VERSION = "1.4.48";
  const S = () => window.AmiJobsShared;
  let isRunning = false;
  let shouldStop = false;
  let lastGlassdoorRunAt = 0;

  /** Real apply landings only — never help/support "En savoir plus" links. */
  function isIndeedApplyUrl(url) {
    const raw = String(url || "");
    try {
      const u = new URL(raw, location.href);
      if (/(^|\.)secure\.indeed\.com$/i.test(u.hostname) && /^\/(auth|account)/i.test(u.pathname)) {
        return false;
      }
      const hostPath = `${u.hostname}${u.pathname}`;
      if (!/indeed\.(com|fr)|smartapply\.indeed/i.test(hostPath)) return false;
      if (/help\.|support\.|\/hc\/|guidelines|articles\/|job-seeker/i.test(hostPath)) return false;
      return /smartapply|indeedapply|\/viewjob|\/rc\/clk|\/pagead\/clk|applybyapplyablejobid/i.test(hostPath);
    } catch (_e) {
      const u = raw.split(/[?#]/)[0];
      if (!/indeed\.(com|fr)|smartapply\.indeed/i.test(u)) return false;
      if (/help\.|support\.|\/hc\/|guidelines|articles\/|job-seeker/i.test(u)) return false;
      if (/secure\.indeed\.com\/(auth|account)/i.test(u)) return false;
      return /smartapply|indeedapply|\/viewjob|\/rc\/clk|\/pagead\/clk|applybyapplyablejobid/i.test(u);
    }
  }

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
        if (!/indeed\.(com|fr)|smartapply\.indeed/i.test(href)) return;
        // Always keep Glassdoor SERP from navigating away on Indeed links
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        // Only open real apply URLs in the Indeed slot (help/support = ignore)
        if (!isIndeedApplyUrl(href)) return;
        chrome.runtime
          .sendMessage({
            action: "ensurePlatformTab",
            platform: "indeed",
            url: href,
            active: true,
            forceNavigate: true,
          })
          .catch(() => {});
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
        if (isIndeedApplyUrl(href)) {
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

    S().log(PLATFORM, "Challenge Cloudflare Glassdoor — 2captcha Turnstile + clic", "warn");
    try {
      await chrome.runtime.sendMessage({ action: "injectTurnstileClicker" });
    } catch (_e) {
      /* ignore */
    }
    try {
      if (typeof window.__AmijobsClickTurnstile === "function") window.__AmijobsClickTurnstile();
      if (typeof window.__AmijobsSolveTurnstile === "function") window.__AmijobsSolveTurnstile(true);
    } catch (_e) {
      /* ignore */
    }
    const start = Date.now();
    while (Date.now() - start < 130000) {
      if (shouldStop) return false;
      if ((Date.now() - start) % 20000 < 2000) {
        try {
          await chrome.runtime.sendMessage({ action: "injectTurnstileClicker" });
        } catch (_e) {}
        try {
          if (typeof window.__AmijobsSolveTurnstile === "function") window.__AmijobsSolveTurnstile(true);
        } catch (_e) {}
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
      await S().sleep(2500);
      if (!needsCaptcha() && !S().$('iframe[src*="challenges.cloudflare.com"], .cf-turnstile')) {
        S().log(PLATFORM, "Challenge Cloudflare passé", "success");
        return true;
      }
      if (collectJobCards().length > 0) {
        S().log(PLATFORM, "Challenge Cloudflare passé (offres chargées)", "success");
        return true;
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
    // Glassdoor SPA often strips ?applicationType=1 after redirect → avoid infinite reload loop
    try {
      if (sessionStorage.getItem("amijobs_gd_easy_filter") === "1") return false;
    } catch (_e) {}
    const pill =
      S().$('button[data-test="applicationType"]') ||
      [...S().$$("button")].find((b) => /candidature facile uniquement/i.test(b.textContent || ""));
    if (pill && S().isVisible(pill) && pill.getAttribute("aria-pressed") === "true") {
      try {
        sessionStorage.setItem("amijobs_gd_easy_filter", "1");
      } catch (_e) {}
      return false;
    }
    // Prefer clicking the pill (no full navigation) when available
    if (pill && S().isVisible(pill) && pill.getAttribute("aria-pressed") !== "true") {
      S().log(PLATFORM, "Clic filtre Candidature facile uniquement");
      try {
        sessionStorage.setItem("amijobs_gd_easy_filter", "1");
      } catch (_e) {}
      await S().humanClick(pill);
      await S().sleep(2500);
      return false;
    }
    // One hard navigation max per tab session
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("applicationType", "1");
      sessionStorage.setItem("amijobs_gd_easy_filter", "1");
      S().log(PLATFORM, "Filtre Candidature facile (applicationType=1)", "warn");
      window.location.href = u.toString();
      return true;
    } catch (_e) {}
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
        el.querySelector?.(
          '[data-test="job-title"], a[data-test="job-link"], [class*="JobCard_jobTitle"], .JobCard_jobTitle'
        )?.textContent?.trim() || "";
      if (!title || isJunkJobTitle(title)) continue;
      const company =
        el.querySelector?.(
          '[data-test="employer-name"], [class*="EmployerProfile_employerName"], .EmployerProfile_employerName'
        )?.textContent?.trim() || "";
      // Prefer numeric jl ids over raw href keys
      const jl =
        href.match(/[?&]jl=(\d+)/)?.[1] ||
        el.getAttribute("data-id") ||
        el.getAttribute("data-jobid") ||
        id;
      if (!/^\d{6,}$/.test(String(jl))) continue;
      out.push({
        element: el,
        jobId: String(jl).slice(0, 64),
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
    // Prefer SERP job-details panel CTAs (card badges also say "Candidature facile").
    const panel =
      S().$(
        '[data-test="job-details"], [data-test="JobDetails"], #JobDetails, .JobDetails, [class*="JobDetails"], [class*="jobDetails"], [data-test="jd-container"]'
      ) || null;
    const roots = panel ? [panel, document] : [document];

    const score = (el) => {
      if (!el || !S().isVisible(el) || isCompanySiteApplyButton(el)) return -1;
      if (el.getAttribute?.("data-test") === "applicationType") return -1;
      // Glassdoor often renders Easy Apply as disabled until the panel finishes loading
      if (el.disabled || el.getAttribute?.("disabled") != null || el.getAttribute?.("aria-disabled") === "true") {
        return -1;
      }
      const href = el.getAttribute?.("href") || el.closest?.("a")?.getAttribute?.("href") || "";
      const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
      if (text.length > 64) return -1;
      let s = 0;
      if (el.getAttribute?.("data-test") === "easyApply") s += 5;
      if (/indeed|smartapply/i.test(href)) s += 8;
      if (/candidature facile|easy apply|candidature simplifiée|postuler sur indeed/i.test(text)) s += 4;
      if (/^postuler$/i.test(text)) s += 3;
      if (panel && panel.contains(el)) s += 6;
      return s;
    };

    let best = null;
    let bestScore = 0;
    for (const root of roots) {
      const nodes = root.querySelectorAll?.(
        'button[data-test="easyApply"], [data-test="easyApply"], [data-test="easy-apply-button"], [data-test="applyButton"], button[data-test="apply-button"], a[data-test="easyApply"], button, a[role="button"], a'
      );
      for (const el of nodes || []) {
        const s = score(el);
        if (s > bestScore) {
          bestScore = s;
          best = el;
        }
      }
      if (bestScore >= 10) break; // panel + indeed href / strong match
    }
    return bestScore >= 4 ? best : null;
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

  function detectAlreadyAppliedUi() {
    const t = (document.body?.innerText || "").toLowerCase();
    return (
      t.includes("vous avez déjà postulé") ||
      t.includes("vous avez deja poste") ||
      t.includes("you have already applied") ||
      t.includes("already applied to this job") ||
      t.includes("déjà candidaté") ||
      t.includes("deja candidate") ||
      !!S().$(
        '[data-test*="already-applied" i], [aria-label*="déjà postulé" i], [aria-label*="already applied" i]'
      )
    );
  }

  function detectGlassdoorDailyLimit() {
    const t = (document.body?.innerText || "").replace(/\s+/g, " ");
    return /limite de candidatures quotidienne|daily (application|apply) limit|reached your .*limit/i.test(t);
  }

  function detectIndeedHandoff() {
    return (
      /indeed\.(com|fr)/i.test(window.location.href) ||
      /smartapply\.indeed\.com/i.test(window.location.href) ||
      !!document.querySelector('iframe[src*="indeed"], iframe[src*="smartapply"]')
    );
  }

  function extractIndeedApplyUrl(btn) {
    const candidates = [];
    const push = (raw) => {
      if (!raw || raw === "#") return;
      try {
        const abs = new URL(String(raw).replace(/&amp;/g, "&"), window.location.href).toString();
        if (isIndeedApplyUrl(abs)) candidates.push(abs);
      } catch (_e) {}
    };
    const a =
      (btn && btn.closest && btn.closest("a[href]")) ||
      (btn && btn.tagName === "A" ? btn : null);
    push(a?.getAttribute?.("href") || a?.href || "");
    // Glassdoor Easy Apply often stores the Indeed target on data-* attrs
    for (const el of [btn, a, btn?.parentElement].filter(Boolean)) {
      for (const attr of el.getAttributeNames?.() || []) {
        if (!/href|url|link|indeed|apply|job/i.test(attr)) continue;
        push(el.getAttribute(attr));
      }
    }
    const near = btn?.closest?.("div, section, li, article") || btn?.parentElement || document;
    for (const link of near.querySelectorAll?.('a[href*="indeed"], a[href*="smartapply"]') || []) {
      const href = link.getAttribute("href") || link.href || "";
      // Skip help/support even before isIndeedApplyUrl (noise in panel HTML)
      if (/help\.|support\.|\/hc\//i.test(href)) continue;
      push(href);
    }
    // Prefer attributes/outerHTML of the button — avoid whole panel HTML (help links)
    const html = `${btn?.outerHTML || ""} ${btn?.parentElement?.outerHTML || ""}`;
    for (const m of html.matchAll(/https?:\/\/[^"'\\\s<>]*indeed\.[^"'\\\s<>]+/gi)) {
      if (/help\.|support\.|\/hc\//i.test(m[0])) continue;
      push(m[0]);
    }
    // Prefer Smart Apply URLs, then viewjob/clk
    candidates.sort((x, y) => {
      const score = (u) =>
        (/smartapply|indeedapply/i.test(u) ? 30 : 0) +
        (/\/viewjob|\/rc\/clk|\/pagead\/clk/i.test(u) ? 20 : 0) +
        (/[?&](?:jk|vjk)=/i.test(u) ? 10 : 0);
      return score(y) - score(x);
    });
    return candidates[0] || "";
  }

  /** Open Glassdoor Easy Apply → Indeed Smart Apply without destroying the Glassdoor SERP tab. */
  async function openEasyApplyInIndeedTab(btn) {
    try {
      const abs = extractIndeedApplyUrl(btn);
      if (abs) {
        await chrome.runtime.sendMessage({
          action: "ensurePlatformTab",
          platform: "indeed",
          url: abs,
          active: true,
          forceNavigate: true,
          fromGlassdoor: true,
          windowOwner: "glassdoor",
        });
        S().log(
          PLATFORM,
          `Easy Apply ouvert dans l'onglet Indeed (${abs.slice(0, 80)})`,
          "success"
        );
        try {
          await chrome.runtime.sendMessage({ action: "nudgeIndeedSmartApply" });
        } catch (_e) {}
        return true;
      }

      // No safe href — click CTA and let background capture the Indeed apply tab
      await chrome.runtime.sendMessage({ action: "armIndeedHandoffCapture", ms: 12000 }).catch(() => {});
      await S().humanClick(btn);
      await S().sleep(1800);
      for (let i = 0; i < 10; i++) {
        const cap = await chrome.runtime
          .sendMessage({ action: "peekIndeedHandoffCapture" })
          .catch(() => null);
        if (cap?.url && isIndeedApplyUrl(cap.url)) {
          S().log(PLATFORM, "Easy Apply capturé (nouvel onglet Indeed)", "success");
          try {
            await chrome.runtime.sendMessage({ action: "nudgeIndeedSmartApply" });
          } catch (_e) {}
          return true;
        }
        await S().sleep(500);
      }
      return false;
    } catch (_e) {
      return false;
    }
  }

  async function clickJobCard(card) {
    const el = card.element;
    // CRITICAL: do NOT follow /job-listing/ title links — that full-page navigation
    // destroys the SERP side panel where Easy Apply (data-test=easyApply) lives.
    try {
      el.querySelectorAll?.("a").forEach((a) => {
        a.removeAttribute("target");
        const href = a.getAttribute("href") || "";
        if (/job-listing|jobListing|partner\/jobListing/i.test(href)) {
          a.addEventListener(
            "click",
            (e) => {
              try {
                e.preventDefault();
                e.stopPropagation();
              } catch (_e) {}
            },
            true
          );
        }
      });
    } catch (_e) {}
    // Click card shell — Glassdoor opens the right-hand job panel on SERP
    await S().humanClick(el);
    await S().sleep(S().randomDelay(1800, 2800));
    // Wait briefly for Easy Apply CTA to appear in the panel
    for (let w = 0; w < 8; w++) {
      if (findEasyApplyButton()) break;
      await S().sleep(350);
    }
    if (/job-listing|jobListing/i.test(location.pathname || "")) {
      S().log(PLATFORM, "Navigation job-listing détectée — retour SERP (Easy Apply panel)", "warn");
      try {
        history.back();
        await S().sleep(1200);
      } catch (_e) {}
    }
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

  /** In parallel dual mode the lock always succeeds — both boards apply at once. */
  async function waitForSmartApplyLock(maxMs = 6000) {
    const start = Date.now();
    let logged = false;
    for (;;) {
      if (shouldStop) return { ok: false, owner: "stopped" };
      const lock = await chrome.runtime
        .sendMessage({ action: "acquireSmartApplyLock", owner: "glassdoor" })
        .catch(() => null);
      if (lock?.ok) return lock;
      if (Date.now() - start > maxMs) return lock || { ok: false };
      if (!logged) {
        S().log(
          PLATFORM,
          `Smart Apply occupé (${lock?.owner || lock?.reason || "mutex"}) — SERP continue`,
          "warn"
        );
        logged = true;
      }
      await S().sleep(1200);
    }
  }

  async function dismissGlassdoorPopups() {
    const body = (document.body?.innerText || "").replace(/\s+/g, " ");
    const alertModal =
      /Confiez-nous votre recherche|Enregistrer cette alerte|Créez une alerte|create (a )?job alert|alerte emploi/i.test(
        body
      );
    const closeSelectors = [
      'button[aria-label="Close"]',
      'button[aria-label="Fermer"]',
      'button[aria-label*="fermer" i]',
      'button[aria-label*="close" i]',
      '[aria-label="Close"]',
      '[data-test="modal-close"]',
      '[class*="Modal"] button[aria-label*="close" i]',
      '[role="dialog"] button[aria-label*="close" i]',
      '[role="dialog"] button[aria-label*="fermer" i]',
    ];
    for (const sel of closeSelectors) {
      const btn = S().$(sel);
      if (btn && S().isVisible(btn)) {
        await S().humanClick(btn);
        S().log(PLATFORM, "Popup Glassdoor fermée", "warn");
        await S().sleep(500);
        return true;
      }
    }
    if (alertModal) {
      const dialog = S().$('[role="dialog"], [class*="Modal"], [class*="modal"]');
      const scope = dialog || document;
      const xBtn = [...scope.querySelectorAll("button, [role='button']")].find((b) => {
        if (!S().isVisible(b)) return false;
        const t = (b.textContent || "").trim();
        const al = (b.getAttribute("aria-label") || "").toLowerCase();
        return t === "×" || t === "✕" || t === "X" || /close|fermer|dismiss/i.test(al) || /^x$/i.test(t);
      });
      if (xBtn) {
        await S().humanClick(xBtn);
        S().log(PLATFORM, "Alerte emploi Glassdoor fermée", "warn");
        await S().sleep(500);
        return true;
      }
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      } catch (_e) {}
      for (const el of document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="Modal"]')) {
        try {
          if (/Confiez-nous|Enregistrer cette alerte|Créez une alerte/i.test(el.innerText || "")) el.remove();
        } catch (_e) {}
      }
      await S().sleep(400);
      return true;
    }
    return false;
  }

  async function waitForEasyApplyButton(timeoutMs = 12000) {
    const start = Date.now();
    let dismissed = false;
    while (Date.now() - start < timeoutMs) {
      if (!dismissed || Date.now() - start < 2500) {
        dismissed = (await dismissGlassdoorPopups().catch(() => false)) || dismissed;
      }
      const btn = findEasyApplyButton();
      if (btn) return btn;
      // Visible but disabled Easy Apply — keep waiting for enable
      const disabledEa = S().$(
        '[data-test="easyApply"][disabled], button[data-test="easyApply"]:disabled, [data-test="easyApply"][aria-disabled="true"]'
      );
      if (disabledEa && S().isVisible(disabledEa) && Date.now() - start > timeoutMs - 500) {
        S().log(PLATFORM, "Candidature facile désactivée (panel) — offre ignorée", "warn");
        return null;
      }
      await S().sleep(400);
    }
    return null;
  }

  async function applyCurrentJob(settings, jobInfo) {
    const info = jobInfo || getJobInfo("current");
    const { sessionGlassdoor: sGate = null } = await chrome.storage.local.get(["sessionGlassdoor"]);
    const maxJobs = sGate?.maxJobs || settings?.maxJobsPerSession || 25;
    if ((sGate?.applied || 0) >= maxJobs) {
      return { success: false, reason: "max_jobs" };
    }
    // Never start a 2nd Easy Apply while a Smart Apply handoff is in flight
    if (sGate?.awaitingIndeed) {
      S().log(PLATFORM, "Handoff Indeed déjà en cours — pas de 2e Easy Apply", "warn");
      return { success: false, reason: "smartapply_busy" };
    }
    try {
      const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
      if (amijobsMeta?.indeedLoginRequired || sGate?.awaitingIndeedLogin) {
        S().log(
          PLATFORM,
          "En attente connexion Indeed — Easy Apply en pause (pas d'abandon d'offres)",
          "warn"
        );
        return { success: false, reason: "indeed_login_wait" };
      }
    } catch (_e) {}
    if (detectGlassdoorDailyLimit()) {
      S().log(PLATFORM, "Limite quotidienne Glassdoor atteinte — stop Easy Apply", "error");
      return { success: false, reason: "gd_daily_limit" };
    }
    if (detectAlreadyAppliedUi()) {
      S().log(PLATFORM, `Déjà postulé (UI): ${info.title || info.jobId}`, "warn");
      return { success: false, reason: "already_applied" };
    }
    // Prefer Easy Apply (→ Indeed Smart Apply). Skip company-site for mass Easy Apply sessions.
    const btn = await waitForEasyApplyButton(8000);
    if (btn) {
      // Shared mutex with Indeed mass-apply — one Smart Apply wizard at a time.
      // Wait in place: bouncing back to the SERP re-ran the whole session cycle
      // (module reload + navigation) every few seconds without making progress.
      const lock = await waitForSmartApplyLock(6000);
      if (!lock?.ok) {
        S().log(
          PLATFORM,
          `Smart Apply occupé (${lock?.owner || lock?.reason || "indeed"}) — offre reportée, suite SERP`,
          "warn"
        );
        return { success: false, reason: "smartapply_busy" };
      }

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

      // Prefer opening Smart Apply in the Indeed tab so Glassdoor SERP stays up
      // (same-tab redirect looks like a Glassdoor "crash").
      const openedElsewhere = await openEasyApplyInIndeedTab(btn);
      if (!openedElsewhere) {
        await S().humanClick(btn);
      }
      await S().sleep(S().randomDelay(1500, 2500));

      if (openedElsewhere) {
        // Nudge Indeed to click Postuler under our lock (viewjob landing)
        try {
          await chrome.runtime.sendMessage({ action: "nudgeIndeedSmartApply" });
        } catch (_e) {}
        S().log(PLATFORM, "Handoff Indeed (onglet séparé) — attente Smart Apply", "success");
        return { success: true, reason: "indeed_tab" };
      }

      // If this tab navigated to Indeed, ask background to restore Glassdoor SERP
      if (detectIndeedHandoff()) {
        try {
          const { sessionGlassdoor: sNav } = await chrome.storage.local.get(["sessionGlassdoor"]);
          await chrome.runtime.sendMessage({
            action: "restoreGlassdoorSerp",
            searchUrl: sNav?.searchUrl || "",
          });
        } catch (_e) {}
        S().log(PLATFORM, "Redirection Indeed Smart Apply détectée", "success");
        return { success: true, reason: "indeed_handoff" };
      }

      if (detectAlreadyAppliedUi()) {
        const { sessionGlassdoor: sSkip } = await chrome.storage.local.get(["sessionGlassdoor"]);
        if (sSkip?.active) {
          await chrome.storage.local.set({
            sessionGlassdoor: { ...sSkip, awaitingIndeed: false, indeedHandoffDone: false },
            glassdoorSmartApply: null,
          });
        }
        try {
          await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "glassdoor" });
        } catch (_e) {}
        S().log(PLATFORM, `Déjà postulé après clic: ${info.title || info.jobId}`, "warn");
        return { success: false, reason: "already_applied" };
      }

      if (detectIndeedHandoff()) {
        S().log(PLATFORM, "Redirection Indeed Smart Apply détectée", "success");
        return { success: true, reason: "indeed_handoff" };
      }

      for (let i = 0; i < 16; i++) {
        if (detectAlreadyAppliedUi()) {
          const { sessionGlassdoor: sSkip } = await chrome.storage.local.get(["sessionGlassdoor"]);
          if (sSkip?.active) {
            await chrome.storage.local.set({
              sessionGlassdoor: { ...sSkip, awaitingIndeed: false, indeedHandoffDone: false },
              glassdoorSmartApply: null,
            });
          }
          return { success: false, reason: "already_applied" };
        }
        if (detectApplySuccess()) return { success: true };
        if (detectIndeedHandoff()) return { success: true, reason: "indeed_handoff" };
        const { sessionGlassdoor: s } = await chrome.storage.local.get(["sessionGlassdoor"]);
        if (s?.indeedHandoffDone) {
          // Tab opened (or apply already finished) — keep awaitingIndeed as background set it
          await chrome.storage.local.set({
            sessionGlassdoor: { ...s, awaitingIndeed: true, lastRunAt: Date.now() },
          });
          S().log(PLATFORM, "Onglet Indeed Smart Apply ouvert", "success");
          return { success: true, reason: "indeed_tab" };
        }
        // Confirm a real Smart Apply tab exists before treating as handoff
        const tabs = await chrome.runtime.sendMessage({ action: "listIndeedTabs" }).catch(() => null);
        if (tabs?.hasSmartApply) {
          const base = s || (await chrome.storage.local.get(["sessionGlassdoor"])).sessionGlassdoor;
          if (base?.active) {
            await chrome.storage.local.set({
              sessionGlassdoor: { ...base, awaitingIndeed: true, lastRunAt: Date.now() },
            });
          }
          S().log(PLATFORM, "Onglet Indeed Smart Apply ouvert (tabs)", "success");
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

      // Do NOT assume handoff — that parked mass-apply for minutes on already-applied / no-op clicks
      S().log(PLATFORM, "Pas de handoff Indeed confirmé — offre ignorée", "warn");
      const { sessionGlassdoor: sAssumed } = await chrome.storage.local.get(["sessionGlassdoor"]);
      if (sAssumed?.active) {
        await chrome.storage.local.set({
          sessionGlassdoor: { ...sAssumed, awaitingIndeed: false, indeedHandoffDone: false },
          glassdoorSmartApply: null,
        });
      }
      return { success: false, reason: "no_indeed_handoff" };
    }

    // Easy Apply filter sessions: do not fall through to company-site
    S().log(PLATFORM, "Pas de Candidature facile — offre ignorée", "warn");
    return { success: false, reason: "no_easy_apply" };
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

  function isJunkJobTitle(title) {
    const t = String(title || "").trim().toLowerCase();
    if (!t || t.length < 3) return true;
    return (
      /partie en vacances|job .+ gone on vacation|no longer available|n'est plus disponible|n’est plus disponible|offre introuvable|this job has expired|cette offre a expiré|cette offre a expire/i.test(
        t
      )
    );
  }

  function titleAlreadyHandled(store, title) {
    const t = String(title || "").trim().toLowerCase();
    if (!t || isJunkJobTitle(t) || t.length < 12) return false;
    return Object.values(store || {}).some((v) => {
      const vt = String(v?.title || "").trim().toLowerCase();
      if (!vt || isJunkJobTitle(vt) || vt.length < 12) return false;
      return vt === t;
    });
  }

  async function alreadyHandled(jobId, title = "") {
    if (!jobId && !title) return false;
    const { appliedJobs = {}, skippedJobs = {} } = await chrome.storage.local.get([
      "appliedJobs",
      "skippedJobs",
    ]);
    if (jobId && alreadyApplied(appliedJobs, jobId)) return true;
    const keys = Object.keys(skippedJobs || {});
    if (jobId && keys.some((k) => k === jobId || k === `gd_${jobId}` || k.endsWith(`_${jobId}`))) {
      return true;
    }
    // Long titles: match applied OR skipped (prevents re-attacking same panel every resume)
    if (title && String(title).trim().length >= 20) {
      if (titleAlreadyHandled(appliedJobs, title) || titleAlreadyHandled(skippedJobs, title)) {
        return true;
      }
    }
    return false;
  }

  async function goToCleanSearch(session) {
    // Prefer buildSearchUrl (keeps applicationType=1) — stale searchUrl often loops the filter
    let target =
      buildSearchUrl(session?.keywords || "", session?.location || "", session?.currentPage || 0) ||
      (session?.searchUrl && String(session.searchUrl).replace(/[?&]jl=\d+/g, "").replace(/&&+/g, "&"));
    if (!target) return false;
    try {
      const u = new URL(target, location.origin);
      u.searchParams.set("applicationType", "1");
      u.searchParams.delete("jl");
      target = u.toString();
    } catch (_e) {}

    // Soft path first — hard reload is the main "not smooth" / module-spam cause
    try {
      const cur = new URL(location.href);
      const onSerp =
        isSearchPage() ||
        /SRCH_|-emplois-|Job\/jobs/i.test(cur.pathname) ||
        (/\/Emploi\//i.test(cur.pathname) && /sc\.keyword|applicationType|jl=/i.test(cur.search));
      if (onSerp) {
        let changed = false;
        if (cur.searchParams.has("jl")) {
          cur.searchParams.delete("jl");
          changed = true;
        }
        if (!/applicationType=1/i.test(cur.search)) {
          cur.searchParams.set("applicationType", "1");
          changed = true;
        }
        if (changed) {
          history.replaceState({}, "", cur.toString());
          const closeBtn =
            S().$('button[aria-label*="Close" i], button[aria-label*="Fermer" i], [data-test="close-job"]') ||
            [...S().$$("button")].find((b) => /^×$|^x$/i.test((b.textContent || "").trim()));
          if (closeBtn && S().isVisible(closeBtn)) {
            try {
              await S().humanClick(closeBtn);
            } catch (_e) {}
          }
          await S().sleep(500);
        }
        // Stay on SERP without reload — card loop / resume will continue
        return changed;
      }
    } catch (_e) {}

    // Full job-listing pages need one throttled return to SERP (not every resume)
    if (/job-listing|jobListing|partner\/jobListing/i.test(location.pathname || "")) {
      const now = Date.now();
      if (window.__AmijobsGdLastHardNav && now - window.__AmijobsGdLastHardNav < 25000) {
        return false;
      }
      window.__AmijobsGdLastHardNav = now;
      const serp =
        (session?.searchUrl && /SRCH_|-emplois-|Job\/jobs|applicationType/i.test(session.searchUrl) && session.searchUrl) ||
        target;
      window.location.href = serp;
      return true;
    }

    // Hard navigate only when we left Glassdoor entirely (Indeed handoff tab)
    try {
      if (!/glassdoor\.(com|fr)/i.test(location.hostname)) {
        window.location.href = target;
        return true;
      }
    } catch (_e) {}
    // Still on Glassdoor — never hard-reload SERP for jl= cleanup (module spam).
    // Card loop / resume continues on the current listing page.
    return false;
  }

  async function clearJobListingFromUrl(session = null) {
    try {
      const { sessionGlassdoor: s } = await chrome.storage.local.get(["sessionGlassdoor"]);
      return goToCleanSearch(session || s);
    } catch (_e) {
      return goToCleanSearch(session);
    }
  }

  async function waitIndeedHandoffResult(jobInfo, settings, current) {
    S().log(PLATFORM, `Handoff Indeed: ${jobInfo.title} — attente Smart Apply`, "success");
    let handoffDone = false;
    const targetJk = String(jobInfo.jobId || current?.currentJk || "");
    // 2captcha can be slow, but don't monopolize the lock for 8 minutes
    const softLimit = 120;
    const hardLimit = 240;
    for (let w = 0; w < hardLimit; w++) {
      if (shouldStop) break;
      const {
        sessionGlassdoor: sWait,
        appliedJobs: jobsWait = {},
        indeedWizardBusy = null,
      } = await chrome.storage.local.get(["sessionGlassdoor", "appliedJobs", "indeedWizardBusy"]);
      // Match THIS job only — never treat another listing's markApplied as success
      if (targetJk && alreadyApplied(jobsWait, targetJk)) {
        handoffDone = true;
        break;
      }
      if (
        sWait &&
        !sWait.awaitingIndeed &&
        sWait.indeedHandoffDone &&
        (!sWait.currentJk || !targetJk || String(sWait.currentJk) === targetJk)
      ) {
        handoffDone = true;
        break;
      }
      if (sWait && !sWait.awaitingIndeed && !sWait.indeedHandoffDone) {
        // Released without success for this job
        break;
      }
      // Heartbeat only while wizard looks alive — don't renew lock after failure
      const busyAge = indeedWizardBusy?.at ? Date.now() - indeedWizardBusy.at : 999999;
      const wizardAlive = busyAge < 90000;
      if (w % 15 === 0 && wizardAlive) {
        try {
          await chrome.runtime.sendMessage({ action: "acquireSmartApplyLock", owner: "glassdoor" });
        } catch (_e) {}
      }
      if (w >= softLimit && !wizardAlive) {
        S().log(PLATFORM, `Handoff timeout soft (${w}s, wizard inactif): ${jobInfo.title}`, "warn");
        break;
      }
      await S().sleep(1000);
    }
    await S().sleep(500);
    const { sessionGlassdoor: sClear, appliedJobs: jobsNow = {} } = await chrome.storage.local.get([
      "sessionGlassdoor",
      "appliedJobs",
    ]);
    const matched =
      (targetJk && alreadyApplied(jobsNow, targetJk)) ||
      (!!sClear?.indeedHandoffDone &&
        (!sClear.currentJk || !targetJk || String(sClear.currentJk) === targetJk) &&
        handoffDone) ||
      handoffDone;
    if (sClear?.awaitingIndeed) {
      await chrome.storage.local.set({
        sessionGlassdoor: {
          ...sClear,
          awaitingIndeed: false,
          indeedHandoffDone: matched,
        },
        glassdoorSmartApply: null,
      });
    }
    if (matched) {
      const { sessionGlassdoor: sQuota } = await chrome.storage.local.get(["sessionGlassdoor"]);
      const maxJobs = sQuota?.maxJobs || settings?.maxJobsPerSession || 25;
      if ((sQuota?.applied || 0) >= maxJobs) {
        // Already at quota — don't double-count
        try {
          await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "glassdoor" });
        } catch (_e) {}
        return true;
      }
      if (!alreadyApplied(jobsNow, jobInfo.jobId)) {
        await chrome.runtime.sendMessage({
          action: "markApplied",
          platform: PLATFORM,
          jobId: jobInfo.jobId,
          title: jobInfo.title,
          company: jobInfo.company,
          url: jobInfo.url,
          page: current?.currentPage || 0,
        });
      }
      const { sessionGlassdoor: sPage } = await chrome.storage.local.get(["sessionGlassdoor"]);
      if (sPage?.active) {
        const pageApplied = (sPage.pageApplied || 0) + 1;
        await chrome.storage.local.set({
          sessionGlassdoor: { ...sPage, pageApplied, awaitingIndeed: false },
          glassdoorSmartApply: null,
          indeedWizardBusy: null,
        });
        S().log(
          PLATFORM,
          `Postulé (via Indeed): ${jobInfo.title} (page ${(sPage.currentPage || 0) + 1}, ${pageApplied}/${settings.maxJobsPerPage || "∞"} page)`,
          "success"
        );
      } else {
        S().log(PLATFORM, `Postulé (via Indeed): ${jobInfo.title}`, "success");
      }
      // Close leftover Smart Apply so page flip / next Easy Apply isn't blocked
      try {
        await chrome.runtime.sendMessage({ action: "closeIndeedSmartApplyTabs" });
      } catch (_e) {}
      try {
        await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "glassdoor", fair: true });
      } catch (_e) {}
      return true;
    }
    await chrome.runtime.sendMessage({
      action: "markSkipped",
      platform: PLATFORM,
      jobId: jobInfo.jobId,
      title: jobInfo.title,
      reason: "indeed_handoff_timeout",
    });
    try {
      await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "glassdoor" });
    } catch (_e) {}
    // Indeed may have taken over the lock during handoff wizard
    try {
      await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "indeed" });
    } catch (_e) {}
    S().log(PLATFORM, `Smart Apply Indeed non terminé: ${jobInfo.title}`, "warn");
    return false;
  }

  async function clearGlassdoorRunLock() {
    try {
      const { sessionGlassdoor: s } = await chrome.storage.local.get(["sessionGlassdoor"]);
      if (s?.active && s.runLockAt) {
        await chrome.storage.local.set({ sessionGlassdoor: { ...s, runLockAt: 0 } });
      }
    } catch (_e) {}
  }

  async function runAutoApplySession() {
    if (isRunning) return;
    const now = Date.now();
    if (now - lastGlassdoorRunAt < 2500) {
      return; // silent debounce — avoid log spam
    }
    // Cross-reload lock: short only (was 8s and blocked parallel progress)
    try {
      const { sessionGlassdoor: lockSess } = await chrome.storage.local.get(["sessionGlassdoor"]);
      if (lockSess?.active && lockSess.runLockAt && now - lockSess.runLockAt < 2500) {
        return;
      }
      if (lockSess?.active) {
        await chrome.storage.local.set({
          sessionGlassdoor: { ...lockSess, runLockAt: now },
        });
      }
    } catch (_e) {}
    lastGlassdoorRunAt = now;
    isRunning = true;
    shouldStop = false;

    if (isBlockedPage()) {
      S().log(PLATFORM, "Glassdoor protection / Cloudflare — tentative de clic", "warn");
      const ok = await tryPassCloudflareChallenge();
      if (!ok && isBlockedPage()) {
        S().log(PLATFORM, "Cloudflare non résolu — pause (session conservée)", "warn");
        isRunning = false;
        await clearGlassdoorRunLock();
        return;
      }
    }

    let { sessionGlassdoor: session } = await chrome.storage.local.get(["sessionGlassdoor"]);
    if (!session?.active) {
      isRunning = false;
      await clearGlassdoorRunLock();
      return;
    }

    try {
      const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
      if (amijobsMeta?.indeedLoginRequired || session.awaitingIndeedLogin) {
        S().log(
          PLATFORM,
          "Pause Glassdoor — connectez-vous sur l'onglet Indeed (reprise auto)",
          "warn"
        );
        isRunning = false;
        await clearGlassdoorRunLock();
        await S().sleep(10000);
        return;
      }
    } catch (_e) {}

    // Only wait when THIS Glassdoor session handed off to Smart Apply
    if (session.awaitingIndeed) {
      const age = Date.now() - (session.lastRunAt || Date.parse(session.startedAt) || Date.now());
      const tabs = await chrome.runtime.sendMessage({ action: "listIndeedTabs" }).catch(() => null);
      const hasHandoffTab = !!(tabs?.hasSmartApply || tabs?.hasApplyTab);
      const { appliedJobs: jobsNow = {} } = await chrome.storage.local.get(["appliedJobs"]);
      const jk = String(session.currentJk || "");
      // Job already marked applied — don't park the SERP forever
      if (jk && alreadyApplied(jobsNow, jk)) {
        S().log(PLATFORM, "Handoff déjà postulé — reprise SERP Glassdoor", "success");
        session = { ...session, awaitingIndeed: false, indeedHandoffDone: true };
        await chrome.storage.local.set({
          sessionGlassdoor: session,
          glassdoorSmartApply: null,
        });
        try {
          await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "glassdoor" });
        } catch (_e) {}
      } else if (!hasHandoffTab && age > 60000) {
        S().log(PLATFORM, "Handoff Indeed stale — reprise", "warn");
        session = { ...session, awaitingIndeed: false, indeedHandoffDone: false };
        await chrome.storage.local.set({
          sessionGlassdoor: session,
          glassdoorSmartApply: null,
          indeedWizardBusy: null,
        });
        try {
          await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "glassdoor" });
        } catch (_e) {}
      } else if (hasHandoffTab && age > 240000) {
        S().log(PLATFORM, "Handoff Indeed bloqué >240s — skip offre et reprise", "warn");
        const stuckJk = session.currentJk;
        const stuckTitle = session.currentTitle;
        session = { ...session, awaitingIndeed: false, indeedHandoffDone: false };
        await chrome.storage.local.set({
          sessionGlassdoor: session,
          glassdoorSmartApply: null,
          indeedWizardBusy: null,
        });
        try {
          await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "glassdoor" });
        } catch (_e) {}
        if (stuckJk || stuckTitle) {
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: PLATFORM,
            jobId: stuckJk || `gd_stuck_${Date.now()}`,
            title: stuckTitle || "",
            reason: "indeed_handoff_stuck",
          }).catch(() => {});
        }
      } else if (hasHandoffTab || age < 60000) {
        // Own handoff in flight — do not start another Glassdoor apply
        isRunning = false;
        await clearGlassdoorRunLock();
        return;
      }
    }

    // Clear legacy full-queue flag
    if (session.deferredUntilIndeedDone) {
      session = { ...session, deferredUntilIndeedDone: false };
      await chrome.storage.local.set({ sessionGlassdoor: session });
    }

    // Do NOT pause the whole Glassdoor SERP when Indeed holds Smart Apply.
    // Easy Apply itself acquires the lock; browsing/cards continue in parallel.

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

    // Full /job-listing/ pages usually lose Easy Apply — bounce back to SERP panel flow
    if (/job-listing|jobListing/i.test(location.pathname || "")) {
      S().log(PLATFORM, "Page job-listing sans panel — retour SERP", "warn");
      const { sessionGlassdoor: sBack } = await chrome.storage.local.get(["sessionGlassdoor"]);
      const serp =
        sBack?.searchUrl ||
        buildSearchUrl(sBack?.keywords || "", sBack?.location || "", sBack?.currentPage || 0);
      if (serp && !/job-listing/i.test(serp)) {
        window.location.href = serp;
        isRunning = false;
        return;
      }
      try {
        history.back();
      } catch (_e) {}
      isRunning = false;
      return;
    }

    // If a real job panel/detail is already open (jl= / jobListing), handle it once then drop jl=.
    // Never re-attack the same open listing across resume cycles (HelloWork-style progress).
    const onRealDetail = isJobDetailPage();
    const readyApply =
      onRealDetail &&
      (findEasyApplyButton() || findApplyButton() || findCompanySiteButton() || detectAlreadyAppliedUi());
    if (readyApply || onRealDetail) {
      const jlOpen = new URLSearchParams(location.search).get("jl");
      const jobInfo = getJobInfo(jlOpen || "gd_open");
      if (!jlOpen && jobInfo.title) {
        // Stable skip key when SPA panel has no jl= (prevents infinite Ignorée loops)
        jobInfo.jobId = `gd_t_${String(jobInfo.title)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .slice(0, 48)}`;
      }
      if (isJunkJobTitle(jobInfo.title) || detectAlreadyAppliedUi()) {
        S().log(PLATFORM, `Offre ouverte invalide/expirée — retour SERP: ${jobInfo.title || jobInfo.jobId}`, "warn");
        if (jobInfo.jobId) {
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: PLATFORM,
            jobId: jobInfo.jobId,
            title: jobInfo.title || "offre_expiree",
            reason: "Offre expirée / indisponible",
          }).catch(() => {});
        }
        // Soft clear (replaceState) must not abort the run — only hard nav needs restart
        if (await clearJobListingFromUrl(session)) {
          if (!isSearchPage() && !/SRCH_|-emplois-|Job\/jobs/i.test(location.pathname)) {
            isRunning = false;
            return;
          }
        }
      } else if (await alreadyHandled(jobInfo.jobId, jobInfo.title)) {
        S().log(PLATFORM, `Offre ouverte déjà traitée — retour SERP: ${jobInfo.title || jobInfo.jobId}`, "warn");
        // Dismiss panel + continue card loop (soft clear alone re-opens the same SPA panel)
        await clearJobListingFromUrl(session);
        try {
          const closeBtn =
            S().$('button[aria-label*="Close" i], button[aria-label*="Fermer" i], [data-test="close-job"]') ||
            [...S().$$("button")].find((b) => /^×$|^x$/i.test((b.textContent || "").trim()));
          if (closeBtn && S().isVisible(closeBtn)) await S().humanClick(closeBtn);
        } catch (_e) {}
        await chrome.storage.local.set({
          sessionGlassdoor: {
            ...session,
            lastDismissedJk: jobInfo.jobId || "",
            lastRunAt: Date.now(),
          },
        });
        await S().sleep(400);
      } else if (findEasyApplyButton()) {
        S().log(PLATFORM, `Offre déjà ouverte — clic apply: ${jobInfo.title || jobInfo.jobId}`);
        const result = await applyCurrentJob(settings, jobInfo);
        if (result.success && /indeed/i.test(String(result.reason || ""))) {
          await waitIndeedHandoffResult(jobInfo, settings, session);
        } else if (result.success) {
          await chrome.runtime.sendMessage({
            action: "markApplied",
            platform: PLATFORM,
            jobId: jobInfo.jobId,
            title: jobInfo.title,
            company: jobInfo.company,
            url: jobInfo.url,
            page: session?.currentPage || 0,
          });
          const { sessionGlassdoor: sPage } = await chrome.storage.local.get(["sessionGlassdoor"]);
          if (sPage?.active) {
            await chrome.storage.local.set({
              sessionGlassdoor: { ...sPage, pageApplied: (sPage.pageApplied || 0) + 1 },
            });
          }
        } else if (result.reason === "smartapply_busy") {
          // Indeed owns Smart Apply / fairness slot — leave listing, keep SERP moving
          S().log(PLATFORM, `Smart Apply occupé — offre gardée pour plus tard: ${jobInfo.title}`, "warn");
          await clearJobListingFromUrl(session);
          // Fall through to SERP card loop (do not abort run after soft clear)
        } else if (result.reason === "indeed_login_wait") {
          S().log(PLATFORM, "Pause Glassdoor — connectez-vous sur Indeed puis reprise auto", "warn");
          await S().sleep(10000);
          return;
        } else if (result.reason) {
          // Including no_easy_apply — must markSkipped or the same jl= reopens forever
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: PLATFORM,
            jobId: jobInfo.jobId,
            title: jobInfo.title,
            reason: result.reason,
          });
          await clearJobListingFromUrl(session);
        } else {
          await clearJobListingFromUrl(session);
        }
      } else if (onRealDetail) {
        // Detail open but no Easy Apply — skip and return to SERP
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: PLATFORM,
          jobId: jobInfo.jobId,
          title: jobInfo.title,
          reason: "Pas de candidature simplifiée",
        });
        await clearJobListingFromUrl(session);
      }
    }

    S().log(PLATFORM, `SERP Glassdoor: ${String(location.href).slice(0, 140)}`);
    let cards = await waitForJobCards(18000);
    if (!cards.length) {
      // After jl= strip / SPA filter, SERP can be briefly empty — retry before ending
      for (let retry = 0; retry < 2 && !cards.length; retry++) {
        S().log(PLATFORM, `SERP vide — recharge (${retry + 1}/2)`, "warn");
        await S().sleep(2000);
        cards = await waitForJobCards(12000);
      }
    }
    if (!cards.length) {
      const nextPage = (session.currentPage || 0) + 1;
      const nextUrl =
        buildSearchUrl(session.keywords || "", session.location || "", nextPage) ||
        findNextPageUrl(session);
      if (nextUrl && nextPage <= 8 && (session.applied || 0) < maxJobs) {
        S().log(PLATFORM, `SERP vide — page suivante Glassdoor (${nextPage + 1})`, "warn");
        await chrome.storage.local.set({
          sessionGlassdoor: {
            ...session,
            currentPage: nextPage,
            pageApplied: 0,
            searchUrl: nextUrl,
            awaitingIndeed: false,
            indeedHandoffDone: false,
            runLockAt: 0,
            lastRunAt: 0,
          },
          glassdoorSmartApply: null,
          indeedWizardBusy: null,
        });
        isRunning = false;
        lastGlassdoorRunAt = 0;
        window.location.href = nextUrl;
        return;
      }
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
        const perPage = settings.maxJobsPerPage || 0;
        if (perPage > 0 && (current.pageApplied || 0) >= perPage && (current.applied || 0) < maxJobs) {
          S().log(
            PLATFORM,
            `Cap page atteint (${current.pageApplied}/${perPage}) — page suivante`,
            "warn"
          );
          break;
        }

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
            if (await waitIndeedHandoffResult(jobInfo, settings, current)) {
              appliedThisRun++;
            }
            // Hard stop if quota reached mid-loop (prevents 3rd apply when max=2)
            const { sessionGlassdoor: sAfter } = await chrome.storage.local.get(["sessionGlassdoor"]);
            if ((sAfter?.applied || 0) >= maxJobs) break;
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
        } else if (result.reason === "smartapply_busy") {
          // Keep job deferred — do not thrash the same card every 1.5s
          S().log(PLATFORM, "Smart Apply occupé (Indeed) — autre offre Glassdoor", "warn");
          await S().sleep(2500);
          continue;
        } else if (result.reason === "indeed_login_wait") {
          S().log(PLATFORM, "Pause — connexion Indeed requise (offres conservées)", "warn");
          await S().sleep(12000);
          return;
        } else if (result.reason === "gd_daily_limit") {
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: PLATFORM,
            jobId: jobInfo.jobId,
            title: jobInfo.title,
            reason: "gd_daily_limit",
          });
          try {
            await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "glassdoor" });
          } catch (_e) {}
          await chrome.runtime.sendMessage({
            action: "endPlatformSession",
            platform: PLATFORM,
            reason: "Limite quotidienne Glassdoor",
          });
          return;
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
          try {
            await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "glassdoor" });
          } catch (_e) {}
        }

        const jobDelay = Math.max(settings.delayBetweenJobs?.min || 400, 900);
        const jobDelayMax = Math.max(settings.delayBetweenJobs?.max || jobDelay, jobDelay + 600);
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
        // Continue to next results page — prefer buildSearchUrl (stable) over fragile pagination DOM
        const nextPage = (updated.currentPage || 0) + 1;
        const nextUrl =
          buildSearchUrl(updated.keywords || "", updated.location || "", nextPage) ||
          findNextPageUrl(updated);
        if (nextUrl && nextPage <= 8) {
          await chrome.storage.local.set({
            sessionGlassdoor: {
              ...updated,
              currentPage: nextPage,
              pageApplied: 0,
              searchUrl: nextUrl,
              awaitingIndeed: false,
              indeedHandoffDone: false,
              runLockAt: 0,
              lastRunAt: 0,
            },
            glassdoorSmartApply: null,
            indeedWizardBusy: null,
          });
          S().log(PLATFORM, `Page suivante Glassdoor (${nextPage + 1}) → ${nextUrl.slice(0, 120)}`, "info");
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
    await clearGlassdoorRunLock();
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
    while (Date.now() - start < 90000) {
      let { sessionGlassdoor: session } = await chrome.storage.local.get(["sessionGlassdoor"]);
      // Stale Indeed handoff after tab fusion / apply done — unblock mass apply
      if (session?.active && session.awaitingIndeed) {
        const age = Date.now() - (session.lastRunAt || Date.parse(session.startedAt) || Date.now());
        const tabs = await chrome.runtime.sendMessage({ action: "listIndeedTabs" }).catch(() => null);
        const hasSmart = !!(tabs?.hasSmartApply || tabs?.hasApplyTab);
        const { appliedJobs: jobsNow = {} } = await chrome.storage.local.get(["appliedJobs"]);
        const jk = String(session.currentJk || "");
        if (jk && alreadyApplied(jobsNow, jk)) {
          S().log(PLATFORM, "Libération awaitingIndeed (déjà postulé) — reprise", "success");
          session = { ...session, awaitingIndeed: false, indeedHandoffDone: true, lastRunAt: 0 };
          await chrome.storage.local.set({ sessionGlassdoor: session, glassdoorSmartApply: null });
        } else if (!hasSmart && age > 60000) {
          S().log(PLATFORM, "Libération awaitingIndeed (handoff stale) — reprise mass apply", "warn");
          session = { ...session, awaitingIndeed: false, indeedHandoffDone: false, lastRunAt: 0 };
          await chrome.storage.local.set({ sessionGlassdoor: session, glassdoorSmartApply: null });
        } else if (hasSmart && age > 240000) {
          S().log(PLATFORM, "Libération awaitingIndeed (Smart Apply stuck) — reprise mass apply", "warn");
          const stuckJk = session.currentJk;
          const stuckTitle = session.currentTitle;
          session = { ...session, awaitingIndeed: false, indeedHandoffDone: false, lastRunAt: 0 };
          await chrome.storage.local.set({ sessionGlassdoor: session, glassdoorSmartApply: null });
          if (stuckJk || stuckTitle) {
            await chrome.runtime.sendMessage({
              action: "markSkipped",
              platform: PLATFORM,
              jobId: stuckJk || `gd_stuck_${Date.now()}`,
              title: stuckTitle || "",
              reason: "indeed_handoff_stuck",
            }).catch(() => {});
          }
        } else if (hasSmart) {
          await S().sleep(3000);
          continue;
        }
      }
      if (session?.active && !session.awaitingIndeed && !isRunning) {
        // Only skip if another run finished very recently on THIS tab cycle
        const lastMs = Number(session.lastRunAt) || 0;
        if (lastMs && Date.now() - lastMs < 4000) {
          await S().sleep(1500);
          continue;
        }
        await S().sleep(800);
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
  // HelloWork-style: early returns / tab reloads must not stall the session forever
  setInterval(() => {
    chrome.storage.local.get(["sessionGlassdoor"]).then(({ sessionGlassdoor: session }) => {
      if (session?.active && !isRunning) checkAndResumeSession().catch(() => {});
    });
  }, 8000);
})();
