// AmiJobs — Indeed auto-apply content script (phase-based, v1.2.7)
(function () {
  if (window.__AmijobsIndeedLoaded) return;
  window.__AmijobsIndeedLoaded = true;

  const PLATFORM = "indeed";
  const VERSION = "1.4.5";
  const S = () => window.AmiJobsShared;
  let isRunning = false;
  let shouldStop = false;
  let lastIndeedRunAt = 0;

  // Keep SERP intact: Smart Apply opens in its own tab (never navigate the jobs list away)
  try {
    const nativeOpen = window.open.bind(window);
    window.open = function (url, target, features) {
      const href = String(url || "");
      if (/smartapply\.indeed|indeedapply/i.test(href)) {
        const opened = nativeOpen(href, "_blank", features);
        chrome.runtime
          .sendMessage({ action: "enforceOneTabPerPlatform", reason: "indeed smartapply window.open" })
          .catch(() => {});
        return opened;
      }
      if (/indeed\.(com|fr)/i.test(href)) {
        window.location.href = href;
        chrome.runtime
          .sendMessage({ action: "enforceOneTabPerPlatform", reason: "indeed window.open" })
          .catch(() => {});
        return null;
      }
      return nativeOpen(url, target, features);
    };
  } catch (_e) {
    /* ignore */
  }

  function getIndeedHost(session) {
    if (session?.searchUrl) {
      try {
        return new URL(session.searchUrl).origin;
      } catch (_e) {
        /* ignore */
      }
    }
    if (/indeed\.fr/i.test(window.location.hostname)) return "https://fr.indeed.com";
    return "https://www.indeed.com";
  }

  function isSearchPage(url = window.location.href) {
    return /indeed\.(com|fr)\/jobs(\?|$)/.test(url) || /indeed\.(com|fr)\/jobs\//.test(url);
  }

  function isViewJobPage(url = window.location.href) {
    return (
      /indeed\.(com|fr)\/viewjob/.test(url) ||
      /indeed\.(com|fr)\/rc\/clk/.test(url) ||
      /indeed\.(com|fr)\/pagead\/clk/.test(url)
    );
  }

  function isSmartApplyPage(url = window.location.href) {
    // v1.4.0: Ignore service worker iframes — they match smartapply but have no form
    const path = (() => {
      try {
        return new URL(url, location.href).pathname;
      } catch (_e) {
        return url;
      }
    })();
    if (/^\/_\/service_worker/i.test(path) || /^\/_\/scripts\//i.test(path) || /^\/sw_iframe/i.test(path)) {
      return false;
    }
    return (
      /smartapply\.indeed\.com/i.test(url) ||
      /indeed\.(com|fr)\/(?:beta\/)?indeedapply/i.test(url) ||
      /indeed\.(com|fr)\/apply/i.test(url)
    );
  }

  function buildSearchUrl(keywords, location, page = 0, session = null) {
    const host = getIndeedHost(session);
    const p = new URLSearchParams();
    let kw = keywords || "";
    const contracts = session?.contracts || [];
    const wantsFreelance = (contracts || []).some((c) =>
      /freelance|independant|indépendant|contract/i.test(String(c))
    );
    if (wantsFreelance && kw && !/freelance/i.test(kw)) kw = `${kw} freelance`;
    if (wantsFreelance && !kw) kw = "freelance";
    if (kw) p.set("q", kw);
    if (location) p.set("l", location);
    // Candidature simplifiée uniquement (Same as FR UI filter / applicationType=1)
    p.set("applicationType", "1");
    p.set("iafilter", "1");
    p.set("fromage", "14");
    if (wantsFreelance) p.set("sc", "0kf:attr(DSQF7);");
    if (page > 0) p.set("start", String(page * 10));
    return `${host}/jobs?${p.toString()}`;
  }

  function isValidIndeedJobKey(jk) {
    if (!jk || typeof jk !== "string") return false;
    const key = jk.trim();
    if (key.length < 10 || key.length > 64) return false;
    if (/^(jk_)?test/i.test(key)) return false;
    if (!/^[a-z0-9_-]+$/i.test(key)) return false;

    const lower = key.toLowerCase();
    // Reject sequential / demo hex runs (cause "Page introuvable")
    if (/abcdef|fedcba|01234567|89abcdef|abcdef01|deadbeef|cafebabe/i.test(lower)) return false;
    if (
      /^(a1b2c3d4e5f67890|0123456789abcdef|abcdef0123456789|123456789abcdef0|fedcba9876543210|890abcdef0123456)$/i.test(
        lower
      )
    ) {
      return false;
    }
    if (/^(jk_)?0{8,}$/i.test(lower)) return false;
    // Prefer real Indeed keys: 16-char hex with decent entropy
    if (/^[0-9a-f]{16}$/i.test(lower)) {
      const uniq = new Set(lower).size;
      if (uniq < 8) return false;
    }
    return true;
  }

  function extractJobKey(el) {
    if (!el) return null;
    const direct =
      el.getAttribute("data-jk") ||
      el.getAttribute("data-jobkey") ||
      el.closest("[data-jk]")?.getAttribute("data-jk") ||
      el.closest("[data-jobkey]")?.getAttribute("data-jobkey");
    if (direct && isValidIndeedJobKey(direct)) return direct;
    const link =
      el.querySelector?.('a[href*="jk="], a[href*="viewjob"], a[data-jk]') ||
      (el.matches?.('a[href*="jk="]') ? el : null);
    const href = link?.getAttribute?.("href") || el.getAttribute?.("href") || "";
    const m = href.match(/[?&]jk=([^&]+)/) || href.match(/[?&]vjk=([^&]+)/);
    if (m) {
      const jk = decodeURIComponent(m[1]);
      if (isValidIndeedJobKey(jk)) return jk;
    }
    const id = el.getAttribute?.("id") || "";
    const idMatch = id.match(/job_([a-f0-9]+)/i);
    if (idMatch && isValidIndeedJobKey(idMatch[1])) return idMatch[1];
    return null;
  }

  async function getSession() {
    const { sessionIndeed: session = null } = await chrome.storage.local.get(["sessionIndeed"]);
    return session;
  }

  async function setSession(updates) {
    const session = await getSession();
    if (!session) return null;
    const next = { ...session, ...updates, lastRunAt: Date.now() };
    await chrome.storage.local.set({ sessionIndeed: next });
    return next;
  }

  async function endSession(reason) {
    await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: PLATFORM, reason });
    if (reason) S().log(PLATFORM, `Session terminée: ${reason}`, "warn");
  }

  function detectCloudflareChallenge() {
    const text = (document.body?.innerText || "").toLowerCase();
    return (
      text.includes("verify you are human") ||
      text.includes("vérifiez que vous êtes humain") ||
      text.includes("je ne suis pas un robot") ||
      text.includes("i'm not a robot") ||
      text.includes("checking your browser") ||
      text.includes("just a moment") ||
      !!document.querySelector(
        '#challenge-stage, .cf-turnstile, iframe[src*="challenges.cloudflare.com"], #cf-challenge-running'
      )
    );
  }

  async function tryPassCloudflareChallenge() {
    const text = (document.body?.innerText || "").toLowerCase();
    const hasWidget =
      detectCloudflareChallenge() ||
      text.includes("vérifiez que vous êtes humain") ||
      text.includes("verify you are human") ||
      !!S().$('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile');
    if (!hasWidget) return false;

    S().log(PLATFORM, "Challenge Cloudflare détecté — clic sur la case", "warn");

    const clickPoint = (el, xRatio = 0.12) => {
      if (!el) return;
      try {
        el.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (_e) {
        /* ignore */
      }
      const r = el.getBoundingClientRect();
      const x = r.left + Math.max(12, Math.min(r.width * xRatio, r.width - 12));
      const y = r.top + r.height / 2;
      const target = document.elementFromPoint(x, y) || el;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, buttons: 1 };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        try {
          target.dispatchEvent(new MouseEvent(type, opts));
        } catch (_e) {
          /* ignore */
        }
      }
      try {
        el.click();
      } catch (_e) {
        /* ignore */
      }
    };

    // Ask background to inject turnstile script into all frames of this tab
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
    // Retry inject a few times — Turnstile often mounts late
    for (let injectTry = 0; injectTry < 3; injectTry++) {
      await S().sleep(600);
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
    }

    for (let i = 0; i < 12; i++) {
      // Click left side of Turnstile iframe (checkbox area)
      const frames = S().$$(
        'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="Widget"], iframe[title*="Cloudflare"]'
      );
      for (const frame of frames) {
        if (!S().isVisible(frame)) continue;
        clickPoint(frame, 0.1);
        clickPoint(frame, 0.15);
        await S().sleep(400);
      }

      const widget = S().$(".cf-turnstile, #challenge-stage, [data-sitekey]");
      if (widget) clickPoint(widget, 0.1);

      for (const el of S().$$('input[type="checkbox"], [role="checkbox"]')) {
        if (S().isVisible(el)) {
          try {
            await S().humanClick(el);
          } catch (_e) {
            clickPoint(el, 0.5);
          }
        }
      }

      const cta = S().findActionButton([
        /vérifiez que vous êtes humain/i,
        /verify you are human/i,
        /je ne suis pas un robot/i,
        /i'?m not a robot/i,
      ]);
      if (cta) {
        await S().humanClick(cta);
        clickPoint(cta, 0.08);
      }

      await S().sleep(1800);
      const still =
        detectCloudflareChallenge() ||
        (document.body?.innerText || "").toLowerCase().includes("vérifiez que vous êtes humain");
      if (!still && !detectBlockedPage()) {
        S().log(PLATFORM, "Challenge Cloudflare passé", "success");
        return true;
      }
    }
    // Don't kill the session immediately — leave page for manual click if needed
    S().log(PLATFORM, "Challenge Cloudflare toujours présent — nouvelle tentative plus tard", "warn");
    return false;
  }

  function detectBlockedPage() {
    const text = document.body?.innerText?.toLowerCase() || "";
    const title = document.title?.toLowerCase() || "";
    return (
      title.includes("blocked") ||
      text.includes("requête bloquée") ||
      text.includes("request blocked") ||
      text.includes("you have been blocked") ||
      text.includes("vous avez été bloqué") ||
      !!document.querySelector("#captcha-challenge, .cf-challenge, [data-testid='blocked']")
    );
  }

  function detectLoginWall() {
    const text = document.body?.innerText?.toLowerCase() || "";
    // Header "Se connecter" links exist even when logged in — require a real gate
    const hardGate =
      text.includes("connectez-vous pour continuer") ||
      text.includes("sign in to continue") ||
      text.includes("create an account to continue") ||
      text.includes("créez un compte pour continuer") ||
      !!document.querySelector(
        'form[action*="login"] input[type="password"], #login-email-input, input[name="__email"]'
      );
    if (!hardGate) return false;
    // If job cards are visible, we are not on a login wall
    if (collectJobCards().length > 0) return false;
    if (isSearchPage() && S().$("#mosaic-provider-jobcards, .jobsearch-ResultsList, ul#job-results-list")) {
      return false;
    }
    return true;
  }

  function detectNoResultsPage() {
    const text = document.body?.innerText?.toLowerCase() || "";
    return (
      text.includes("aucun emploi ne correspond") ||
      text.includes("aucune offre ne correspond") ||
      text.includes("did not match any jobs") ||
      text.includes("no matching jobs") ||
      text.includes("0 emplois") ||
      !!S().$('[data-testid="zero-results"]') ||
      !!S().$(".jobsearch-NoResult")
    );
  }

  function detectMissingJobPage() {
    const text = (document.body?.innerText || "").toLowerCase();
    const title = (document.title || "").toLowerCase();
    const h1 = (S().$("h1")?.textContent || "").toLowerCase();
    return (
      text.includes("page introuvable") ||
      text.includes("we can’t find this page") ||
      text.includes("we can't find this page") ||
      text.includes("this job has expired") ||
      text.includes("cette offre a expiré") ||
      text.includes("offre n'est plus disponible") ||
      title.includes("page introuvable") ||
      /page introuvable|not found|404/.test(h1)
    );
  }

  function collectJobCards() {
    const selectors = [
      "#mosaic-provider-jobcards li",
      "#mosaic-provider-jobcards .cardOutline",
      ".job_seen_beacon",
      "div.job_seen_beacon",
      "li[data-jk]",
      "div[data-jk]",
      ".tapItem",
      ".resultContent",
      "ul#job-results-list > li",
      ".jobsearch-ResultsList > li",
      '[data-testid="slider_item"]',
      '[data-testid="job-card"]',
      ".mosaic-provider-jobcards li",
      ".jobsearch-SerpJobCard",
      "div.slider_item",
      "a.jcs-JobTitle",
      "h2.jobTitle a",
    ];
    const nodes = new Set();
    for (const sel of selectors) {
      for (const el of S().$$(sel)) {
        const card =
          el.closest("[data-jk], .job_seen_beacon, .cardOutline, li, [data-testid='slider_item']") || el;
        nodes.add(card);
      }
    }
    const out = [];
    const seen = new Set();
    for (const el of nodes) {
      const jk = extractJobKey(el);
      if (!jk || seen.has(jk)) continue;
      const title =
        el.querySelector("h2.jobTitle span, h2.jobTitle a, .jobTitle, [data-testid='job-title'], a.jcs-JobTitle")
          ?.textContent?.trim() || "";
      // Ghost / ad shells often expose fake jk without a real title
      if (!title || title.length < 3) continue;
      if (/page introuvable|not found|job expired/i.test(title)) continue;
      seen.add(jk);
      const company =
        el.querySelector("[data-testid='company-name'], .companyName, .company, span.companyName")
          ?.textContent?.trim() || "";
      // Prefer Easy Apply cards when filter is on; keep others only if no badge info
      const easy = cardLooksLikeEasyApply(el);
      out.push({ element: el, jobId: jk, title, company, easyApply: easy });
    }
    // If any card has Easy Apply badge, drop cards without it
    if (out.some((c) => c.easyApply)) {
      return out.filter((c) => c.easyApply);
    }
    return out;
  }

  async function waitForJobCards(maxWaitMs = 45000) {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < maxWaitMs) {
      attempt++;
      if (detectBlockedPage()) return [];
      if (detectNoResultsPage() && attempt > 3) return [];
      const scrollRoot =
        S().$("#mosaic-provider-jobcards") ||
        S().$(".jobsearch-ResultsList") ||
        S().$("main") ||
        document.scrollingElement;
      if (scrollRoot) {
        scrollRoot.scrollTop = Math.min((scrollRoot.scrollTop || 0) + 500, scrollRoot.scrollHeight || 5000);
      } else {
        window.scrollBy(0, 500);
      }
      await S().sleep(500);
      const cards = collectJobCards();
      if (cards.length > 0) {
        S().log(PLATFORM, `${cards.length} offres détectées (tentative ${attempt})`);
        window.scrollTo(0, 0);
        return cards;
      }
      await S().sleep(1200);
    }
    return collectJobCards();
  }

  function getJobInfoFromPage(jobId) {
    const title =
      S().$('[data-testid="jobsearch-JobInfoHeader-title"]')?.textContent?.trim() ||
      S().$(".jobsearch-JobInfoHeader-title")?.textContent?.trim() ||
      S().$("h1.jobsearch-JobInfoHeader-title")?.textContent?.trim() ||
      S().$("h1")?.textContent?.trim() ||
      "";
    const company =
      S().$('[data-testid="inlineHeader-companyName"]')?.textContent?.trim() ||
      S().$('[data-testid="company-name"]')?.textContent?.trim() ||
      S().$(".jobsearch-InlineCompanyRating-companyHeader a")?.textContent?.trim() ||
      S().$(".jobsearch-CompanyInfoWithoutHeaderImage a")?.textContent?.trim() ||
      "";
    const location =
      S().$('[data-testid="job-location"]')?.textContent?.trim() ||
      S().$(".jobsearch-JobInfoHeader-subtitle")?.textContent?.trim() ||
      "";
    return {
      jobId: jobId || jkFromUrl(),
      title,
      company,
      location,
      url: window.location.href,
    };
  }

  function jkFromUrl() {
    const m =
      window.location.href.match(/[?&]vjk=([^&]+)/) ||
      window.location.href.match(/[?&]jk=([^&]+)/) ||
      window.location.href.match(/indeedApplyableJobId=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : `indeed_${Date.now()}`;
  }

  function findIndeedEasyApplyButton() {
    const roots = [document];
    try {
      for (const frame of document.querySelectorAll("iframe")) {
        try {
          const doc = frame.contentDocument || frame.contentWindow?.document;
          if (doc) roots.push(doc);
        } catch (_e) {}
      }
    } catch (_e) {}

    const selectors = [
      '[data-testid="indeedApplyButton"]',
      "#indeedApplyButton",
      '[data-indeed-apply-button]',
      "button.ia-IndeedApplyButton",
      'button[aria-label*="Postuler sur Indeed" i]',
      'button[aria-label*="Indeed Apply" i]',
      'a[data-indeed-apply-button]',
      "#applyButtonLinkContainer button",
      ".jobsearch-IndeedApplyButton-newDesign",
      'button[id*="indeedApply"]',
      '[data-indeed-apply-status]',
    ];
    for (const root of roots) {
      for (const sel of selectors) {
        const btn = root.querySelector(sel);
        if (btn && S().isVisible(btn) && !isCompanySiteApplyButton(btn) && !isContinueToApplyButton(btn)) {
          return btn;
        }
      }
    }

    for (const root of roots) {
      for (const el of root.querySelectorAll("button, a, [role='button'], div[role='button']")) {
        if (!S().isVisible(el) || isCompanySiteApplyButton(el) || isContinueToApplyButton(el)) continue;
        const text = `${el.innerText || el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.replace(
          /\s+/g,
          " "
        );
        if (/postuler sur indeed|indeed apply|apply with indeed|candidature simplifiée/i.test(text)) {
          return el;
        }
      }
      for (const span of root.querySelectorAll("span, div")) {
        const t = (span.textContent || "").trim();
        if (!/^postuler sur indeed$/i.test(t) && !/^indeed apply$/i.test(t)) continue;
        const clickable = span.closest("button, a, [role='button']") || span.parentElement;
        if (clickable && S().isVisible(clickable) && !isCompanySiteApplyButton(clickable)) return clickable;
      }
    }
    return null;
  }

  function isContinueToApplyButton(btn) {
    if (!btn) return false;
    const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.toLowerCase();
    return /continuer (pour |à )?postuler|continue (to )?apply|apply on company|postuler sur le site/i.test(
      text
    );
  }

  function findContinueToApplyButton() {
    for (const el of S().$$("button, a, [role='button'], span")) {
      const t = (el.textContent || "").trim();
      if (!/continuer (pour |à )?postuler|continue (to )?apply/i.test(t)) continue;
      const clickable = el.closest("button, a, [role='button']") || (el.tagName === "BUTTON" || el.tagName === "A" ? el : el.parentElement);
      if (clickable && S().isVisible(clickable) && !isCompanySiteApplyButton(clickable)) return clickable;
    }
    return S().findActionButtonDeep([
      /continuer pour postuler/i,
      /continuer à postuler/i,
      /continue to apply/i,
      /continue applying/i,
    ]);
  }

  function findApplyButton() {
    // Prefer Indeed Easy Apply — never confuse with "Continuer pour postuler" (external)
    return findIndeedEasyApplyButton();
  }

  function isCompanySiteApplyButton(btn) {
    if (!btn) return false;
    if (isContinueToApplyButton(btn)) return true;
    const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.toLowerCase();
    return /site (de l['’]entreprise|de l['’]employeur)|company (site|website)|sur le site|externe|external apply/i.test(
      text
    );
  }

  async function ensureEasyApplyOnlyFilter() {
    if (/[?&]applicationType=1\b/i.test(window.location.href)) return false;
    if (!/\/jobs\b/i.test(window.location.pathname || "")) return false;
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("applicationType", "1");
      u.searchParams.set("iafilter", "1");
      S().log(PLATFORM, "Filtre candidature simplifiée (applicationType=1)", "warn");
      window.location.href = u.toString();
      return true;
    } catch (_e) {
      return false;
    }
  }

  async function waitForApplyButton(timeoutMs = 14000) {
    // Easy Apply / candidature simplifiée only — ignore "Continuer pour postuler"
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const easy = findIndeedEasyApplyButton();
      if (easy) return easy;
      await S().sleep(400);
    }
    return null;
  }

  function cardLooksLikeEasyApply(cardEl) {
    if (!cardEl) return false;
    const text = `${cardEl.innerText || cardEl.textContent || ""}`.toLowerCase();
    if (/candidature simplifi|indeed apply|postuler facilement|easy apply/i.test(text)) return true;
    if (cardEl.querySelector?.(".iaIcon, .indeed-apply-widget, [class*='indeedApply'], [data-indeed-apply-button]")) {
      return true;
    }
    return false;
  }

  function detectApplySuccess() {
    const path = window.location.pathname || "";
    if (/\/post-apply/i.test(path) || /application-submitted/i.test(path)) return true;
    const body = document.body?.innerText?.toLowerCase() || "";
    return (
      body.includes("application submitted") ||
      body.includes("candidature envoyée") ||
      body.includes("your application has been submitted") ||
      body.includes("vous avez postulé") ||
      body.includes("candidature a été envoyée") ||
      body.includes("we have received your application") ||
      body.includes("nous avons bien reçu") ||
      body.includes("votre candidature a bien été") ||
      !!S().$('[data-testid="apply-success"], .ia-BasePage-heading, [data-testid="post-apply"]')
    );
  }

  async function alreadyApplied(appliedJobs, jobId) {
    if (!jobId) return false;
    return !!(appliedJobs[jobId] || appliedJobs[`ind_${jobId}`]);
  }

  async function shouldSkipCompany(company) {
    return S().shouldSkipCompany(company);
  }

  function smartApplyPath() {
    try {
      return new URL(window.location.href).pathname;
    } catch (_e) {
      return window.location.pathname || "";
    }
  }

  async function fillProfileLocationStep() {
    // Live DOM (headed Chrome + HAR cookies): profile-location page
    const profile = await S().getProfile();
    const city = (profile.location || "").split(",")[0].trim() || "Paris";
    const postal = profile.postalCode || "75001";
    const address = profile.address || profile.street || "1 Rue de Rivoli";
    const map = [
      ['[data-testid="location-fields-postal-code-input"]', "#location-fields-postal-code-input", postal],
      ['[data-testid="location-fields-locality-input"]', "#location-fields-locality-input", city],
      ['[data-testid="location-fields-address-input"]', "#location-fields-address-input", address],
    ];
    for (const [a, b, val] of map) {
      const el = S().$(a) || S().$(b);
      if (el && S().isVisible(el) && !el.value) {
        await S().humanType(el, val);
        await S().sleep(200);
      }
    }
  }

  async function clickResumeIfNeeded() {
    // Live DOM: resume-selection-file-resume-radio-card (+ label/input)
    const label =
      S().$('[data-testid="resume-selection-file-resume-radio-card-label"]') ||
      S().$('[data-testid="resume-selection-file-resume-radio-card"]') ||
      S().$('[data-testid="resume-selection-radio-card-group"] label') ||
      S().$('label[data-testid*="resume"]');
    if (label && S().isVisible(label)) {
      await S().humanClick(label);
      await S().sleep(400);
      // v1.4.0: after selecting existing resume radio, also try uploading CV file
      await uploadCvFallback();
      return true;
    }
    const radio =
      S().$('[data-testid="resume-selection-file-resume-radio-card-input"]') ||
      S().$('input[type="radio"][name="resume-selection"]') ||
      S().$('input[type="radio"][name*="resume"]');
    if (radio) {
      try {
        radio.checked = true;
        radio.dispatchEvent(new Event("input", { bubbles: true }));
        radio.dispatchEvent(new Event("change", { bubbles: true }));
        const wrap = radio.closest('[data-testid*="resume"]') || radio.parentElement;
        if (wrap) await S().humanClick(wrap);
      } catch (_e) {
        /* ignore */
      }
      await S().sleep(400);
      // v1.4.0: also try uploading CV file after radio selection
      await uploadCvFallback();
      return true;
    }

    // v1.4.0: No radio/label — try uploading CV directly to a file input
    return await uploadCvFallback();
  }

  // v1.4.0: Upload CV file to any file input on resume-selection step.
  // File inputs are often display:none (hidden by design) but still
  // accept programmatic file assignment via DataTransfer.
  async function uploadCvFallback() {
    const fileInputs = S().$$(
      'input[type="file"][accept*="pdf"], input[type="file"][accept*="doc"], input[type="file"], [data-testid*="resume-upload"], [data-testid*="file-upload"]'
    );
    for (const input of fileInputs) {
      // File inputs are intentionally hidden — don't use isVisible() here
      const ok = await S().uploadCvToFileInput(input);
      if (ok) {
        S().log(PLATFORM, "CV importé (upload fichier)", "success");
        await S().sleep(800);
        return true;
      }
    }
    return false;
  }

  async function fillRelevantExperienceStep() {
    const profile = await S().getProfile();
    const title = profile.title || jobInfoTitleFallback() || "Développeur";
    const company = profile.company || profile.currentCompany || "Freelance";
    const titleEl = S().$('[data-testid="job-title-input"]') || S().$("#job-title-input");
    const companyEl = S().$('[data-testid="company-name-input"]') || S().$("#company-name-input");
    if (titleEl && S().isVisible(titleEl) && !titleEl.value) await S().humanType(titleEl, title);
    if (companyEl && S().isVisible(companyEl) && !companyEl.value) await S().humanType(companyEl, company);
  }

  function jobInfoTitleFallback() {
    return (
      S().$('[data-testid="ia-JobHeader-headerContainer"]')?.textContent?.trim()?.split("\n")[0] || ""
    );
  }

  function findVisibleContinueOrSubmit() {
    // Prefer Indeed Smart Apply testids observed in live browser
    const testIds = [
      '[data-testid="continue-button"]',
      '[data-testid^="hp-continue-button"]',
      '[data-testid="resume-selection-continue-button"]',
      '[data-testid="submit-application"]',
      '[data-testid="submit-button"]',
      '[data-testid="indeed-apply-submit"]',
      'button[data-testid*="submit"]',
    ];
    for (const sel of testIds) {
      for (const el of S().$$(sel)) {
        if (!S().isVisible(el) || el.disabled) continue;
        const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
        if (/d[ée]poser|soumettre|submit|envoyer/.test(text)) return { el, kind: "submit" };
        return { el, kind: "next" };
      }
    }

    const submitRe = [
      /d[ée]poser\s*(ma|votre)?\s*candidature/i,
      /submit (my )?application/i,
      /soumettre (ma |votre )?candidature/i,
      /envoyer (ma |votre )?candidature/i,
      /send application/i,
      /^soumettre$/i,
      /finalize/i,
      /^d[ée]poser$/i,
    ];
    const nextRe = [
      /^continue$/i,
      /^continuer$/i,
      /^next$/i,
      /^suivant$/i,
      /review( your)?( application)?/i,
      /vérifier/i,
      /examiner/i,
      /enregistrer et continuer/i,
      /save and continue/i,
    ];

    const buttons = S().$$("button, a[role='button'], input[type='submit'], [role='button']");
    // Submit may stay "enabled" while captcha unchecked — still treat as submit
    for (const btn of buttons) {
      if (!S().isVisible(btn)) continue;
      const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
      if (!text || /signaler|fermer|close|exit|options de cv/i.test(text)) continue;
      // Never treat job-page "Continuer pour postuler" as Smart Apply wizard next
      if (/continuer (pour |à )?postuler|continue (to )?apply/i.test(text)) continue;
      if (submitRe.some((p) => p.test(text))) return { el: btn, kind: "submit" };
    }
    for (const btn of buttons) {
      if (!S().isVisible(btn) || btn.disabled || btn.getAttribute("aria-disabled") === "true") continue;
      const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
      if (!text || /signaler|fermer|close|exit|options de cv|passer au contenu/i.test(text)) continue;
      if (/continuer (pour |à )?postuler|continue (to )?apply/i.test(text)) continue;
      if (nextRe.some((p) => p.test(text))) return { el: btn, kind: "next" };
    }

    // Last resort on review: any purple primary with "candidature"
    if (/review/i.test(smartApplyPath())) {
      for (const btn of buttons) {
        if (!S().isVisible(btn)) continue;
        const text = (btn.textContent || "").replace(/\s+/g, " ").trim();
        if (/candidature/i.test(text) && /d[ée]poser|soumettre|envoyer/i.test(text)) {
          return { el: btn, kind: "submit" };
        }
      }
    }
    return null;
  }

  async function answerFromCvOrAi(label, fieldType, el) {
    const profile = await S().getProfile();
    const fromProfile = String(profile.experience || "").match(/(\d+(?:[.,]\d+)?)/);
    const isExp =
      /antiquit|anciennet[ée]|exp[eé]rience|seniority|années?|ans\b|years?\s*(of\s*)?exp|combien d['’]?ann/i.test(
        label
      ) || fieldType === "number";
    if (isExp && fromProfile) {
      return fieldType === "number" || /nombre|combien|ans\b|years?\b/i.test(label)
        ? fromProfile[1]
        : `${fromProfile[1]} ans`;
    }
    try {
      const res = await chrome.runtime.sendMessage({
        action: "generateAnswer",
        question: label,
        fieldType: fieldType || (el?.type === "number" ? "number" : "text"),
        options: [],
        jobInfo: { title: document.title || "", company: "" },
      });
      const ans = String(res?.answer || "").trim();
      if (ans && !/^(oui|yes|we|n\/?a|na|none|null)\.?$/i.test(ans)) return ans;
      if (isExp && fromProfile) return fromProfile[1];
      if (isExp) return "3";
      return ans || "";
    } catch (_e) {
      return isExp ? fromProfile?.[1] || "3" : "";
    }
  }

  async function fillQuestionsStep() {
    const profile = await S().getProfile();

    // Radios: prefer Oui / Yes / first option
    const radioNames = new Set();
    for (const radio of S().$$('input[type="radio"]')) {
      if (!S().isVisible(radio) || !radio.name || radioNames.has(radio.name)) continue;
      radioNames.add(radio.name);
      const group = S().$$(`input[type="radio"][name="${CSS.escape(radio.name)}"]`).filter((r) =>
        S().isVisible(r)
      );
      if (!group.length || group.some((r) => r.checked)) continue;
      const preferred =
        group.find((r) => /oui|yes|true|available|disponible/i.test(r.value || r.id || "")) ||
        group.find((r) => {
          const lab = document.querySelector(`label[for="${r.id}"]`);
          return /oui|yes|disponible/i.test(lab?.textContent || "");
        }) ||
        group[0];
      try {
        preferred.click();
      } catch (_e) {
        preferred.checked = true;
        preferred.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await S().sleep(120);
    }

    // Checkboxes: tick required-looking ones (consent / attestations)
    for (const box of S().$$('input[type="checkbox"]')) {
      if (!S().isVisible(box) || box.checked) continue;
      const lab =
        (box.id && document.querySelector(`label[for="${box.id}"]`)?.textContent) ||
        box.closest("label")?.textContent ||
        box.getAttribute("aria-label") ||
        "";
      if (/obligatoire|required|\*/i.test(lab) || /certif|attest|accept|consent|j['’]ai lu/i.test(lab)) {
        try {
          box.click();
        } catch (_e) {
          box.checked = true;
          box.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await S().sleep(100);
      }
    }

    // Selects: AI when label is experience-like, else first non-empty
    for (const sel of S().$$("select")) {
      if (!S().isVisible(sel) || sel.value) continue;
      const label = (
        (sel.id && document.querySelector(`label[for="${sel.id}"]`)?.textContent) ||
        sel.getAttribute("aria-label") ||
        ""
      ).trim();
      const options = [...sel.options].map((o) => o.text.trim()).filter(Boolean);
      let picked = null;
      if (/antiquit|anciennet|exp[eé]rience|années|seniority/i.test(label)) {
        const ans = await answerFromCvOrAi(label, "select", sel);
        picked = options.find((o) => o.toLowerCase() === String(ans).toLowerCase()) ||
          options.find(
            (o) =>
              o.toLowerCase().includes(String(ans).toLowerCase()) ||
              String(ans).toLowerCase().includes(o.toLowerCase())
          );
      }
      if (!picked) {
        picked = options.find((o) => o && !/select|choisir|—|--/i.test(o));
      }
      if (picked) {
        const opt = [...sel.options].find((o) => o.text.trim() === picked);
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      await S().sleep(100);
    }

    // Text / number / date / textarea — use CV/AI for experience / antiquity
    for (const el of S().$$(
      "textarea, input[type='text'], input[type='number'], input[type='date'], input[type='tel'], input:not([type])"
    )) {
      if (!S().isVisible(el)) continue;
      if (el.value && String(el.value).trim()) continue;
      const label = (
        (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) ||
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.id ||
        ""
      ).toLowerCase();
      const hint = `${label} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();

      if (S().isDateFieldHint?.(hint, el) || el.type === "date" || /date|naissance|birth|dob|jj\/mm|dd\/mm|xx\/xx|disponib|démarrage|début|debut/i.test(hint)) {
        const dateVal = S().formatDateAnswer?.(profile, el, hint) || "01/09/2026";
        if (el.type === "date") {
          S().setNativeValue(el, dateVal);
        } else {
          await S().humanType(el, dateVal);
        }
      } else if (/url|link|http|linkedin|portfolio|github/i.test(label)) {
        await S().humanType(el, profile.linkedin || "https://www.linkedin.com");
      } else if (/rythme|alternance.*(école|ecole|entreprise)|jours?\s*(école|ecole)/i.test(label)) {
        await S().humanType(el, "2 jours école / 3 jours entreprise");
      } else if (
        /antiquit|anciennet[ée]|exp[eé]rience|seniority|année|year|ans\b|poste|previous|précédent/i.test(label) ||
        el.type === "number"
      ) {
        let answer = await answerFromCvOrAi(label || "années d'expérience", el.type === "number" ? "number" : "text", el);
        if (el.type === "number") {
          const num = String(answer).match(/\d+/);
          answer = num ? num[0] : "3";
        }
        if (!answer || /^(oui|yes|we)\.?$/i.test(answer)) {
          const n = String(profile.experience || "").match(/(\d+)/);
          answer = el.type === "number" ? n?.[1] || "3" : n ? `${n[1]} ans` : "3 ans";
        }
        await S().humanType(el, answer);
      } else if (/salaire|salary|prétention|compensation/i.test(label)) {
        await S().humanType(el, profile.salaryExpectation || "45000");
      } else if (/phone|téléphone|tel/i.test(label)) {
        await S().humanType(el, profile.phone || "0612345678");
      } else {
        const ai = await answerFromCvOrAi(label || "question candidature", "text", el);
        await S().humanType(el, ai && !/^(we)\.?$/i.test(ai) ? ai : "Oui");
      }
      await S().sleep(120);
    }
  }

  async function waitAndSolveRecaptcha(maxMs = 90000) {
    const start = Date.now();
    const hasWidget = () =>
      !!document.querySelector(
        'iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey], textarea[name="g-recaptcha-response"]'
      ) || /je ne suis pas un robot|i'?m not a robot/i.test(document.body?.innerText || "");

    if (!hasWidget()) return true;

    const readToken = () =>
      String(
        window.__AmijobsRecaptchaToken ||
          document.querySelector('textarea[name="g-recaptcha-response"]')?.value ||
          ""
      );

    if (readToken().length > 40) {
      // Re-apply MAIN-world patch (Indeed may remount the widget)
      try {
        if (typeof window.__AmijobsInjectRecaptchaToken === "function") {
          window.__AmijobsInjectRecaptchaToken(readToken());
        }
      } catch (_e) {}
      return true;
    }

    S().log(PLATFORM, "reCAPTCHA détecté — résolution 2captcha…", "warn");
    let loggedOk = false;
    while (Date.now() - start < maxMs) {
      if (shouldStop) return false;
      const token = readToken();
      if (token.length > 40) {
        try {
          if (typeof window.__AmijobsInjectRecaptchaToken === "function") {
            window.__AmijobsInjectRecaptchaToken(token);
          }
        } catch (_e) {}
        if (!loggedOk) {
          S().log(PLATFORM, "reCAPTCHA token présent — dépôt candidature", "success");
          loggedOk = true;
        }
        return true;
      }
      try {
        if (typeof window.__AmijobsSolveRecaptcha === "function") {
          const ok = await window.__AmijobsSolveRecaptcha(true);
          if (!ok) S().log(PLATFORM, "2captcha en cours / échec partiel…", "warn");
        } else {
          await chrome.runtime.sendMessage({ action: "solveRecaptchaNow" }).catch(() => {});
        }
        if (typeof window.__AmijobsClickRecaptcha === "function") window.__AmijobsClickRecaptcha();
      } catch (_e) {}
      await S().sleep(4000);
    }
    S().log(PLATFORM, "reCAPTCHA non résolu à temps", "warn");
    return readToken().length > 40;
  }

  async function runApplyWizard(jobInfo, settings) {
    if (!isSmartApplyPage()) {
      S().log(PLATFORM, "Wizard ignoré (pas une page Smart Apply)", "warn");
      return { success: false, reason: "not_smartapply" };
    }
    S().log(PLATFORM, `Assistant Smart Apply — ${smartApplyPath()}`);
    for (let step = 0; step < 60; step++) {
      if (shouldStop) return { success: false, reason: "stopped" };
      if (detectApplySuccess()) return { success: true };

      // reCAPTCHA / Turnstile on Smart Apply
      try {
        if (typeof window.__AmijobsClickRecaptcha === "function") window.__AmijobsClickRecaptcha();
        if (typeof window.__AmijobsSolveRecaptcha === "function") window.__AmijobsSolveRecaptcha();
        if (typeof window.__AmijobsClickTurnstile === "function") window.__AmijobsClickTurnstile();
        if (typeof window.__AmijobsSolveTurnstile === "function") window.__AmijobsSolveTurnstile();
      } catch (_e) {}

      const path = smartApplyPath();
      // Wait for review preview loader (live test: "Préparation de l'aperçu")
      const loader = S().$('[data-testid="loading-indicator"]');
      if (loader && S().isVisible(loader)) {
        await S().sleep(1800);
        continue;
      }

      if (/profile-location/i.test(path)) {
        await fillProfileLocationStep();
      }
      if (/resume-selection/i.test(path)) {
        await clickResumeIfNeeded();
      }
      if (/relevant-experience/i.test(path)) {
        await fillRelevantExperienceStep();
      }
      if (/questions/i.test(path)) {
        await fillQuestionsStep();
      } else {
        await S().fillVisibleFields(jobInfo, PLATFORM);
      }

      // Review step often shows reCAPTCHA before "Déposer ma candidature"
      if (/review/i.test(path)) {
        await waitAndSolveRecaptcha(90000);
      }

      let action = findVisibleContinueOrSubmit();
      // Review: force-find Déposer even if testids differ
      if (!action && /review/i.test(path)) {
        for (const el of S().$$("button, [role='button']")) {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (/d[ée]poser\s*(ma|votre)?\s*candidature/i.test(t) && S().isVisible(el)) {
            action = { el, kind: "submit" };
            break;
          }
        }
      }
      if (!action) {
        if (/review/i.test(path)) {
          await waitAndSolveRecaptcha(20000);
          await S().sleep(1200);
          continue;
        }
        if (/questions/i.test(path)) {
          await fillQuestionsStep();
          await S().sleep(900);
          continue;
        }
        await S().sleep(900);
        if (detectApplySuccess()) return { success: true };
        continue;
      }

      if (action.kind === "submit") {
        const captchaOk = await waitAndSolveRecaptcha(90000);
        if (!captchaOk) {
          S().log(PLATFORM, "Submit bloqué — captcha non résolu", "warn");
          await S().sleep(1500);
          continue;
        }
        // Re-inject token right before click (MAIN world)
        try {
          const tok = window.__AmijobsRecaptchaToken || "";
          if (tok && typeof window.__AmijobsInjectRecaptchaToken === "function") {
            window.__AmijobsInjectRecaptchaToken(tok);
          }
        } catch (_e) {}
        if (settings.autoSubmit !== false) {
          S().log(PLATFORM, `Clic submit: ${(action.el.textContent || "").trim().slice(0, 40)}`);
          // Force-enable if Indeed left it aria-disabled after token inject
          try {
            action.el.disabled = false;
            action.el.removeAttribute("disabled");
            action.el.removeAttribute("aria-disabled");
          } catch (_e) {}
          await S().humanClick(action.el);
          await S().sleep(2800);
          for (let i = 0; i < 16; i++) {
            if (detectApplySuccess()) return { success: true };
            if (/post-apply/i.test(smartApplyPath())) return { success: true };
            // Captcha may reappear after failed submit — clear stale token and retry
            if (
              document.querySelector('iframe[src*="recaptcha"]') &&
              /review/i.test(smartApplyPath())
            ) {
              const still = document.querySelector('textarea[name="g-recaptcha-response"]')?.value || "";
              if (!still || still.length < 40) {
                window.__AmijobsRecaptchaToken = "";
                await waitAndSolveRecaptcha(60000);
              } else if (typeof window.__AmijobsInjectRecaptchaToken === "function") {
                window.__AmijobsInjectRecaptchaToken(still);
              }
              const again = findVisibleContinueOrSubmit();
              if (again?.kind === "submit") {
                await S().humanClick(again.el);
              }
            }
            await S().sleep(700);
          }
          if (/post-apply/i.test(smartApplyPath())) return { success: true };
          // Still on review after clicks → don't fake success
          if (/review/i.test(smartApplyPath())) {
            S().log(PLATFORM, "Submit review sans confirmation — nouvel essai captcha", "warn");
            window.__AmijobsRecaptchaToken = "";
            continue;
          }
          return { success: true, reason: "submitted" };
        }
        return { success: false, reason: "review" };
      }

      if (action.el.disabled || action.el.getAttribute("aria-disabled") === "true") {
        if (/questions/i.test(path)) await fillQuestionsStep();
        if (/review/i.test(path)) await waitAndSolveRecaptcha(20000);
        await S().sleep(800);
        continue;
      }

      await S().humanClick(action.el);
      await S().sleep(
        S().randomDelay(settings.delayBetweenSteps?.min || 500, settings.delayBetweenSteps?.max || 1400)
      );
    }
    return { success: false, reason: "wizard_timeout" };
  }

  async function applyCurrentJob(settings, jobInfo) {
    const info = jobInfo || getJobInfoFromPage();

    if (isSmartApplyPage()) {
      return runApplyWizard(info, settings);
    }

    const btn = await waitForApplyButton();
    if (!btn) {
      // Easy Apply only for now — skip company-site / "Continuer pour postuler"
      if (findContinueToApplyButton()) {
        S().log(PLATFORM, "Offre sans candidature simplifiée — ignorée", "warn");
      }
      return { success: false, reason: "no_indeed_apply" };
    }

    // Safety: never treat Continuer as Smart Apply
    if (isContinueToApplyButton(btn) || isCompanySiteApplyButton(btn)) {
      S().log(PLATFORM, "Bouton externe détecté — skip (Easy Apply only)", "warn");
      return { success: false, reason: "no_indeed_apply" };
    }

    const popupPromise = new Promise((resolve) => {
      const onMsg = (msg) => {
        if (msg?.action === "indeedSmartApplyOpened") {
          chrome.runtime.onMessage.removeListener(onMsg);
          resolve(true);
        }
      };
      chrome.runtime.onMessage.addListener(onMsg);
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(onMsg);
        resolve(false);
      }, 12000);
    });

    await S().humanClick(btn);
    await S().sleep(S().randomDelay(1500, 2800));

    if (isSmartApplyPage()) {
      return runApplyWizard(info, settings);
    }

    // Left Indeed entirely (external ATS) — hand off to company-site apply worker
    if (!/indeed\.(com|fr)|smartapply/i.test(window.location.hostname)) {
      if (settings?.allowExternalApply === false || !window.AmiJobsCompanySite) {
        return { success: false, reason: "external_ats" };
      }
      const externalUrl = window.location.href;
      S().log(PLATFORM, `ATS externe détecté — candidature: ${externalUrl.slice(0, 100)}`);
      const extRes = await Promise.race([
        window.AmiJobsCompanySite.apply({
          url: externalUrl,
          jobInfo: {
            jobId: info.jobId,
            title: info.title,
            company: info.company,
            url: info.url || externalUrl,
          },
          sourcePlatform: "indeed",
        }),
        S().sleep(55000).then(() => ({ ok: false, success: false, reason: "timeout" })),
      ]);
      if (extRes?.ok || extRes?.success) {
        return { success: true, reason: "company_site_applied", url: extRes.url || externalUrl };
      }
      return { success: false, reason: extRes?.reason || "external_ats" };
    }

    const opened = await popupPromise;
    if (opened) {
      return { success: true, reason: "smartapply_tab" };
    }

    // Poll briefly for same-tab Smart Apply navigation
    for (let i = 0; i < 10; i++) {
      if (isSmartApplyPage()) return runApplyWizard(info, settings);
      if (detectApplySuccess()) return { success: true };
      await S().sleep(500);
    }

    // Never run a long empty wizard on the viewjob page
    return { success: false, reason: "no_smartapply_opened" };
  }

  async function handleSearchPage(session, settings) {
    const maxJobs = session.maxJobs || settings.maxJobsPerSession || 25;
    const appliedJobs = (await chrome.runtime.sendMessage({ action: "getState" }))?.appliedJobs || {};

    // Force Easy Apply / candidature simplifiée only
    if (await ensureEasyApplyOnlyFilter()) {
      return;
    }

    // Yield Indeed SERP while Glassdoor owns the single Indeed tab for Smart Apply
    const { sessionGlassdoor = null, glassdoorSmartApply = null } = await chrome.storage.local.get([
      "sessionGlassdoor",
      "glassdoorSmartApply",
    ]);
    const gdAwaiting = !!(sessionGlassdoor?.active && sessionGlassdoor?.awaitingIndeed);
    const gdSmartAge = glassdoorSmartApply ? Date.now() - (glassdoorSmartApply.at || 0) : 999999;
    const gdAwaitAge = gdAwaiting
      ? Date.now() - (sessionGlassdoor.lastRunAt || sessionGlassdoor.startedAt || Date.now())
      : 999999;
    // Stale Glassdoor handoff must not freeze Indeed forever
    if (gdAwaiting && gdAwaitAge > 75000) {
      S().log(PLATFORM, "Libération Pause SERP — handoff Glassdoor expiré", "warn");
      await chrome.storage.local.set({
        sessionGlassdoor: { ...sessionGlassdoor, awaitingIndeed: false, indeedHandoffDone: false },
      });
    } else if (gdAwaiting || gdSmartAge < 90000) {
      // Only pause SERP if a Smart Apply tab actually exists; otherwise Glassdoor
      // awaitingIndeed alone freezes Indeed forever while Glassdoor is stuck looping.
      const tabs = await chrome.runtime.sendMessage({ action: "listIndeedTabs" }).catch(() => null);
      const hasSmart =
        tabs?.hasSmartApply ||
        /smartapply|indeedapply/i.test(location.href);
      if (hasSmart || /smartapply|indeedapply/i.test(location.href)) {
        S().log(PLATFORM, "Pause SERP — Smart Apply Glassdoor en cours sur cet onglet", "warn");
        await S().sleep(4000);
        return;
      }
      // Stale flag without Smart Apply → clear and continue SERP
      if (gdAwaiting && gdAwaitAge > 20000) {
        S().log(PLATFORM, "Libération Pause SERP — awaitingIndeed sans Smart Apply", "warn");
        await chrome.storage.local.set({
          sessionGlassdoor: { ...sessionGlassdoor, awaitingIndeed: false },
        });
      }
    }

    if ((session.applied || 0) >= maxJobs) {
      await endSession("Objectif session atteint");
      return;
    }

    if (detectBlockedPage() || detectCloudflareChallenge()) {
      const ok = await tryPassCloudflareChallenge();
      if (!ok && detectBlockedPage()) {
        await endSession("Indeed a bloqué la requête (anti-bot)");
        return;
      }
    }
    let queue = session.queue || [];
    let qIndex = session.qIndex || 0;

    if (!queue.length) {
      if (detectNoResultsPage()) {
        await endSession("Aucun résultat pour ce lieu/mot-clé");
        return;
      }
      const cards = await waitForJobCards(45000);
      if (!cards.length) {
        const noPages = (session.noApplyPages || 0) + 1;
        await setSession({ noApplyPages: noPages });
        if (noPages >= 3 && detectNoResultsPage()) {
          await endSession("Aucun résultat pour ce lieu/mot-clé");
          return;
        }
        if (noPages >= (settings.maxConsecutiveNoApplyPages || 12)) {
          await endSession("Aucune offre trouvée");
          return;
        }
        const nextPage = (session.currentPage || 0) + 1;
        await setSession({ currentPage: nextPage, queue: [], qIndex: 0 });
        window.location.href = buildSearchUrl(session.keywords, session.location, nextPage, session);
        return;
      }

      queue = cards
        .filter((c) => isValidIndeedJobKey(c.jobId) && c.title && c.title.length >= 3)
        .map((c) => ({
          jobId: c.jobId,
          title: c.title,
          company: c.company,
        }));
      qIndex = 0;
      await setSession({ queue, qIndex: 0, noApplyPages: 0 });
      S().log(PLATFORM, `${queue.length} offres trouvées`);
    }

    // Drop any stale placeholder keys left in a previous queue
    if (queue.length) {
      const cleaned = queue.filter((q) => isValidIndeedJobKey(q.jobId));
      if (cleaned.length !== queue.length) {
        S().log(PLATFORM, `File nettoyée: ${queue.length - cleaned.length} clé(s) invalide(s) retirée(s)`, "warn");
        queue = cleaned;
        qIndex = Math.min(qIndex, queue.length);
        await setSession({ queue, qIndex });
      }
    }
    // If queue empty after clean, rebuild from live SERP
    if (!queue.length && isSearchPage()) {
      const cards = await waitForJobCards(20000);
      queue = cards
        .filter((c) => isValidIndeedJobKey(c.jobId) && c.title && c.title.length >= 3)
        .map((c) => ({ jobId: c.jobId, title: c.title, company: c.company }));
      qIndex = 0;
      await setSession({ queue, qIndex: 0, noApplyPages: 0 });
      S().log(PLATFORM, `${queue.length} offres trouvées (rebuild)`);
    }

    while (qIndex < queue.length) {
      if (shouldStop) {
        await endSession("Arrêt demandé");
        return;
      }

      const current = await getSession();
      if (!current?.active || (current.applied || 0) >= maxJobs) {
        await endSession("Objectif session atteint");
        return;
      }

      const item = queue[qIndex];
      if (!isValidIndeedJobKey(item.jobId)) {
        qIndex++;
        await setSession({ qIndex });
        continue;
      }
      if (await alreadyApplied(appliedJobs, item.jobId)) {
        qIndex++;
        await setSession({ qIndex });
        continue;
      }

      const skipReason = await shouldSkipCompany(item.company);
      if (skipReason) {
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: PLATFORM,
          jobId: item.jobId,
          title: item.title,
          reason:
            skipReason === "blacklist"
              ? `Blacklistée: ${item.company}`
              : `Limite entreprise (${item.company})`,
        });
        qIndex++;
        await setSession({ qIndex });
        continue;
      }

      if (
        window.AmiJobsCompanySite &&
        (await window.AmiJobsCompanySite.shouldSkipFormationOffer(item.title || "", item.company || ""))
      ) {
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: PLATFORM,
          jobId: item.jobId,
          title: item.title,
          reason: "Offre de formation / CFA (filtrée)",
        });
        qIndex++;
        await setSession({ qIndex });
        continue;
      }

      await setSession({
        phase: "viewjob",
        currentJk: item.jobId,
        currentTitle: item.title,
        currentCompany: item.company,
        qIndex: qIndex + 1,
      });

      // Prefer SPA: click the card on the SERP (right panel) then "Postuler sur Indeed"
      // Avoids brittle /viewjob?jk= navigations that 404 on bad/stale keys.
      const liveCard =
        collectJobCards().find((c) => c.jobId === item.jobId) ||
        [...document.querySelectorAll("[data-jk]")].find((el) => el.getAttribute("data-jk") === item.jobId);
      const cardEl = liveCard?.element || liveCard || null;
      if (cardEl && isSearchPage()) {
        const link =
          cardEl.querySelector?.("a.jcs-JobTitle, h2.jobTitle a, h2 a, a[href*='jk='], a[data-jk]") ||
          (cardEl.tagName === "A" ? cardEl : null) ||
          cardEl;
        try {
          link.removeAttribute?.("target");
          link.setAttribute?.("target", "_self");
        } catch (_e) {}
        S().log(PLATFORM, `Ouverture offre SERP: ${item.title || item.jobId}`);
        await S().humanClick(link);
        await S().sleep(S().randomDelay(1600, 2600));
        const fresh = await getSession();
        await handleViewJobPage(fresh || session, settings);
        return;
      }

      const host = getIndeedHost(session);
      window.location.href = `${host}/viewjob?jk=${encodeURIComponent(item.jobId)}`;
      return;
    }

    const nextPage = (session.currentPage || 0) + 1;
    await setSession({ currentPage: nextPage, queue: [], qIndex: 0 });
    window.location.href = buildSearchUrl(session.keywords, session.location, nextPage, session);
  }

  async function handleViewJobPage(session, settings) {
    const jobId = session.currentJk || jkFromUrl();
    await S().sleep(2200);

    if (detectMissingJobPage() || !isValidIndeedJobKey(jobId)) {
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        platform: PLATFORM,
        jobId: jobId || "invalid",
        title: session.currentTitle || "Offre invalide",
        reason: "Offre introuvable / clé invalide",
      });
      await setSession({ phase: "search" });
      window.location.href =
        session.searchUrl ||
        buildSearchUrl(session.keywords, session.location, session.currentPage || 0, session);
      return;
    }

    const jobInfo = getJobInfoFromPage(jobId);
    if (!jobInfo.title) {
      jobInfo.title =
        session.currentTitle || session.queue?.find((q) => q.jobId === jobId)?.title || "";
    }
    if (!jobInfo.company) {
      jobInfo.company =
        session.currentCompany || session.queue?.find((q) => q.jobId === jobId)?.company || "";
    }

    if (detectBlockedPage() || detectCloudflareChallenge()) {
      const ok = await tryPassCloudflareChallenge();
      if (!ok && detectBlockedPage()) {
        await endSession("Indeed a bloqué la requête (anti-bot)");
        return;
      }
    }

    const skipReason = await shouldSkipCompany(jobInfo.company);
    if (skipReason) {
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        platform: PLATFORM,
        jobId: jobInfo.jobId,
        title: jobInfo.title,
        reason:
          skipReason === "blacklist"
            ? `Blacklistée: ${jobInfo.company}`
            : `Limite entreprise (${jobInfo.company})`,
      });
      await setSession({ phase: "search" });
      window.location.href =
        session.searchUrl ||
        buildSearchUrl(session.keywords, session.location, session.currentPage || 0, session);
      return;
    }

    const btn = await waitForApplyButton(18000);
    if (!btn) {
      S().log(PLATFORM, "Bouton Postuler sur Indeed introuvable", "warn");
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        platform: PLATFORM,
        jobId: jobInfo.jobId,
        title: jobInfo.title,
        reason: "Pas de candidature Indeed",
      });
      await setSession({ phase: "search" });
      window.location.href =
        session.searchUrl ||
        buildSearchUrl(session.keywords, session.location, session.currentPage || 0, session);
      return;
    }

    S().log(PLATFORM, `Clic: ${(btn.innerText || btn.textContent || "Postuler").trim().slice(0, 48)}`);
    await setSession({ phase: "apply", currentJk: jobInfo.jobId });
    const result = await applyCurrentJob(settings, jobInfo);

    if (result.reason === "smartapply_tab") {
      // Another tab owns the wizard; wait for completion instead of abandoning early
      S().log(PLATFORM, "Smart Apply ouvert dans un onglet — attente");
      const appliedBefore = (await getSession())?.applied || 0;
      for (let i = 0; i < 55; i++) {
        if (shouldStop) break;
        await S().sleep(1000);
        const fresh = await getSession();
        if (!fresh?.active) return;
        if ((fresh.applied || 0) > appliedBefore) break;
        if (fresh.phase === "search") break;
      }
      await setSession({ phase: "search" });
      window.location.href =
        session.searchUrl ||
        buildSearchUrl(session.keywords, session.location, session.currentPage || 0, session);
      return;
    }

    if (result.reason === "company_site_applied" || (result.success && /company_site/i.test(result.reason || ""))) {
      await chrome.runtime.sendMessage({
        action: "markApplied",
        platform: PLATFORM,
        jobId: jobInfo.jobId,
        title: jobInfo.title,
        company: jobInfo.company,
        url: result.url || jobInfo.url,
      });
      S().log(PLATFORM, `Postulé (site entreprise): ${jobInfo.title}`, "success");
      await setSession({ phase: "search" });
      window.location.href =
        session.searchUrl ||
        buildSearchUrl(session.keywords, session.location, session.currentPage || 0, session);
      return;
    }

    if (
      result.reason === "company_site_apply" ||
      result.reason === "external_ats" ||
      result.reason === "no_smartapply_opened"
    ) {
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        platform: PLATFORM,
        jobId: jobInfo.jobId,
        title: jobInfo.title,
        reason: result.reason === "company_site_apply" ? "Site entreprise (échec/indisponible)" : "Pas de Smart Apply Indeed",
      });
      await setSession({ phase: "search" });
      window.location.href =
        session.searchUrl ||
        buildSearchUrl(session.keywords, session.location, session.currentPage || 0, session);
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
      S().log(PLATFORM, `Postulé: ${jobInfo.title}`, "success");
    } else {
      await chrome.runtime.sendMessage({
        action: "markError",
        platform: PLATFORM,
        jobId: jobInfo.jobId,
        title: jobInfo.title,
        error: result.reason || "error",
      });
    }

    await S().sleep(
      S().randomDelay(settings.delayBetweenJobs?.min || 800, settings.delayBetweenJobs?.max || 1800)
    );
    await setSession({ phase: "search" });
    window.location.href =
      session.searchUrl ||
      buildSearchUrl(session.keywords, session.location, session.currentPage || 0, session);
  }

  async function handleApplyPage(session, settings) {
    const { glassdoorSmartApply = null, sessionGlassdoor = null } = await chrome.storage.local.get([
      "glassdoorSmartApply",
      "sessionGlassdoor",
    ]);
    const fromGlassdoor =
      !!(session?.fromGlassdoor) ||
      !!(glassdoorSmartApply && Date.now() - (glassdoorSmartApply.at || 0) < 180000);

    const jobInfo = getJobInfoFromPage(session.currentJk);
    if (fromGlassdoor && glassdoorSmartApply) {
      // Prefer Glassdoor listing id so the Glassdoor wait loop can match appliedJobs
      jobInfo.jobId =
        glassdoorSmartApply.jobId ||
        sessionGlassdoor?.currentJk ||
        jobInfo.jobId ||
        session.currentJk ||
        jkFromUrl();
      if (!jobInfo.title) jobInfo.title = glassdoorSmartApply.title || session.currentTitle || sessionGlassdoor?.currentTitle || "";
      if (!jobInfo.company)
        jobInfo.company = glassdoorSmartApply.company || session.currentCompany || sessionGlassdoor?.currentCompany || "";
    } else {
      if (!jobInfo.title) jobInfo.title = session.currentTitle || "";
      if (!jobInfo.company) jobInfo.company = session.currentCompany || "";
    }

    const result = await runApplyWizard(jobInfo, settings);

    if (result.success) {
      await chrome.runtime.sendMessage({
        action: "markApplied",
        platform: fromGlassdoor ? "glassdoor" : PLATFORM,
        jobId: jobInfo.jobId || session.currentJk,
        title: jobInfo.title,
        company: jobInfo.company,
        url: jobInfo.url,
      });
      S().log(
        PLATFORM,
        `Postulé${fromGlassdoor ? " (via Glassdoor)" : ""}: ${jobInfo.title || jobInfo.jobId}`,
        "success"
      );
    } else if (!fromGlassdoor) {
      await chrome.runtime.sendMessage({
        action: "markError",
        platform: PLATFORM,
        jobId: jobInfo.jobId || session.currentJk,
        title: jobInfo.title,
        error: result.reason || "error",
      });
    } else {
      // Glassdoor owns the waiter — log only; do not clear awaitingIndeed / mark glassdoor error yet
      S().log(
        PLATFORM,
        `Smart Apply (Glassdoor) en cours / retry: ${result.reason || "error"}`,
        "warn"
      );
      try {
        // One soft retry while Glassdoor is still waiting
        await S().sleep(1500);
        const retry = await runApplyWizard(jobInfo, settings);
        if (retry.success) {
          await chrome.runtime.sendMessage({
            action: "markApplied",
            platform: "glassdoor",
            jobId: jobInfo.jobId || session.currentJk,
            title: jobInfo.title,
            company: jobInfo.company,
            url: jobInfo.url,
          });
          S().log(PLATFORM, `Postulé (via Glassdoor): ${jobInfo.title || jobInfo.jobId}`, "success");
          result.success = true;
        }
      } catch (_e) {
        /* ignore */
      }
    }

    if (fromGlassdoor) {
      // Only release the Glassdoor waiter + close tab on success.
      // On failure, keep awaitingIndeed so Glassdoor does not false-timeout while Smart Apply retries.
      if (result.success) {
        const { sessionGlassdoor: sNow = null } = await chrome.storage.local.get(["sessionGlassdoor"]);
        if (sNow?.active) {
          await chrome.storage.local.set({
            sessionGlassdoor: {
              ...sNow,
              awaitingIndeed: false,
              indeedHandoffDone: true,
              applied: (sNow.applied || 0) + 1,
            },
            glassdoorSmartApply: null,
          });
        } else {
          await chrome.storage.local.set({ glassdoorSmartApply: null });
        }
        await chrome.runtime.sendMessage({
          action: "closeTabAndResumeIndeed",
          searchUrl: "",
          fromGlassdoor: true,
        });
      }
      return;
    }

    await setSession({ phase: "search" });
    // Prefer closing smartapply tab and returning to search on fr.indeed
    if (/smartapply\.indeed\.com/i.test(window.location.href)) {
      await chrome.runtime.sendMessage({
        action: "closeTabAndResumeIndeed",
        searchUrl:
          session.searchUrl ||
          buildSearchUrl(session.keywords, session.location, session.currentPage || 0, session),
      });
      return;
    }
    window.location.href =
      session.searchUrl ||
      buildSearchUrl(session.keywords, session.location, session.currentPage || 0, session);
  }

  async function runAutoApplySession() {
    if (isRunning) return;
    // v1.4.0: Skip service worker iframes — they're not real apply pages
    const winPath = window.location.pathname || "";
    if (/^\/_\/service_worker/i.test(winPath) || /^\/_\/scripts\//i.test(winPath) || /^\/sw_iframe/i.test(winPath)) {
      return;
    }
    const now = Date.now();
    if (now - lastIndeedRunAt < 2500) return;
    lastIndeedRunAt = now;
    isRunning = true;
    try {
      let session = await getSession();
      // Glassdoor handoff can activate Indeed apply without a full session
      if (!session?.active && isSmartApplyPage()) {
        const { sessionGlassdoor } = await chrome.storage.local.get(["sessionGlassdoor"]);
        if (sessionGlassdoor?.active) {
          await chrome.storage.local.set({
            sessionIndeed: {
              active: true,
              platform: PLATFORM,
              applied: sessionGlassdoor.applied || 0,
              skipped: 0,
              errors: 0,
              maxJobs: sessionGlassdoor.maxJobs || 25,
              keywords: sessionGlassdoor.keywords || "",
              location: sessionGlassdoor.location || "",
              phase: "apply",
              currentJk: sessionGlassdoor.currentJk || jkFromUrl(),
              searchUrl: sessionGlassdoor.searchUrl || "",
              fromGlassdoor: true,
            },
          });
          session = await getSession();
        }
      }
      if (!session?.active) return;

      if (detectCloudflareChallenge() || detectBlockedPage()) {
        const ok = await tryPassCloudflareChallenge();
        if (!ok && detectBlockedPage() && !detectCloudflareChallenge()) {
          await endSession("Indeed a bloqué la requête (anti-bot)");
          return;
        }
        if (!ok && detectCloudflareChallenge()) {
          // Keep session alive — wait and retry instead of stopping
          S().log(PLATFORM, "Attente validation Cloudflare (ne pas arrêter la session)", "warn");
          await S().sleep(5000);
          await tryPassCloudflareChallenge();
          if (detectCloudflareChallenge() && !collectJobCards().length && !isSmartApplyPage()) {
            // Still stuck with no jobs — pause briefly then continue trying
            await S().sleep(4000);
          }
        }
      }
      if (detectLoginWall() && !isSmartApplyPage()) {
        // Sometimes Cloudflare/login interstitial looks like a login wall — try challenge first
        if (detectCloudflareChallenge()) {
          await tryPassCloudflareChallenge();
        }
        if (detectLoginWall() && !isSmartApplyPage()) {
          await endSession("Connexion Indeed requise");
          return;
        }
      }
      if (shouldStop) {
        await endSession("Arrêt demandé");
        return;
      }

      const state = await chrome.runtime.sendMessage({ action: "getState" });
      const settings = state?.autoApplySettings || {};
      const url = window.location.href;

      S().log(PLATFORM, `Page: ${new URL(url).pathname} (phase: ${session.phase || "search"})`);

      if (isSmartApplyPage(url) || session.phase === "apply") {
        await handleApplyPage(session, settings);
      } else if (isViewJobPage(url) || session.phase === "viewjob") {
        await handleViewJobPage(session, settings);
      } else if (isSearchPage(url)) {
        await handleSearchPage(session, settings);
      } else {
        S().log(PLATFORM, `Page non gérée: ${url}`, "warn");
        if (session.searchUrl) window.location.href = session.searchUrl;
      }
    } catch (err) {
      S().log(PLATFORM, `Erreur: ${err.message}`, "error");
      await chrome.runtime.sendMessage({
        action: "markError",
        platform: PLATFORM,
        error: err.message,
      });
    } finally {
      isRunning = false;
    }
  }

  async function applySingleJob() {
    if (isRunning) return;
    isRunning = true;
    try {
      const state = await chrome.runtime.sendMessage({ action: "getState" });
      const settings = state?.autoApplySettings || {};
      const jobInfo = getJobInfoFromPage();
      const result = await applyCurrentJob(settings, jobInfo);
      if (result.success) {
        await chrome.runtime.sendMessage({
          action: "markApplied",
          platform: PLATFORM,
          jobId: jobInfo.jobId,
          title: jobInfo.title,
          company: jobInfo.company,
          url: jobInfo.url,
        });
      }
    } finally {
      isRunning = false;
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

  S().log(PLATFORM, `Indeed module v${VERSION} chargé`);
  setTimeout(() => {
    getSession().then((session) => {
      if (session?.active || isSmartApplyPage()) runAutoApplySession();
    });
  }, 1800);
})();
