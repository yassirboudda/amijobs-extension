// AmiJobs — Indeed auto-apply content script (phase-based, v1.2.7)
(function () {
  if (window.__AmijobsIndeedLoaded) return;
  window.__AmijobsIndeedLoaded = true;

  const PLATFORM = "indeed";
  const VERSION = "1.4.60";
  const S = () => window.AmiJobsShared;
  let isRunning = false;
  let shouldStop = false;
  let lastIndeedRunAt = 0;

  /** Nested indeed iframes must not run a second wizard (race on Continuer / CV). */
  function isTopAutomationFrame() {
    try {
      return window === window.top;
    } catch (_e) {
      return true;
    }
  }

  // Keep SERP intact: Smart Apply MUST reuse the single apply slot (never spam new tabs)
  try {
    const nativeOpen = window.open.bind(window);
    window.open = function (url, target, features) {
      const href = String(url || "");
      if (/smartapply\.indeed|indeedapply|applybyapplyablejobid/i.test(href)) {
        chrome.runtime
          .sendMessage({
            action: "ensurePlatformTab",
            platform: "indeed",
            url: href,
            active: true,
            forceNavigate: true,
          })
          .then(() =>
            chrome.runtime.sendMessage({
              action: "enforceOneTabPerPlatform",
              reason: "indeed smartapply window.open",
            })
          )
          .catch(() => {});
        return null;
      }
      if (/indeed\.(com|fr)/i.test(href)) {
        // Prefer navigating the current tab for non-apply Indeed URLs on SERP/viewjob
        if (/\/jobs\b|\/viewjob|\/rc\/clk|\/pagead\/clk/i.test(href) || isSearchPage() || isViewJobPage()) {
          window.location.href = href;
        } else {
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

  // Block "Signaler un problème" / privacy opt-out links during automation
  try {
    document.addEventListener(
      "click",
      (e) => {
        const a = e.target?.closest?.("a");
        if (!a || !a.href) return;
        if (/hrtechprivacy\.com|privacy opt out|requests\.hrtechprivacy/i.test(a.href)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
      },
      true
    );
  } catch (_e) {}

  function getIndeedHost(session) {
    if (session?.searchUrl) {
      try {
        return new URL(session.searchUrl).origin;
      } catch (_e) {
        /* ignore */
      }
    }
    if (session?.indeedOrigin) return session.indeedOrigin;
    if (globalThis.AmiJobsGeo?.indeedOriginForLocation && session?.location) {
      return globalThis.AmiJobsGeo.indeedOriginForLocation(session.location);
    }
    try {
      const h = window.location.hostname;
      if (globalThis.AmiJobsGeo?.isIndeedHostname?.(h) || /indeed\./i.test(h)) {
        return window.location.origin;
      }
    } catch (_e) {}
    return "https://www.indeed.com";
  }

  function isSearchPage(url = window.location.href) {
    return /indeed\.(?:com|[a-z]{2})\/jobs(\?|$)/.test(url) || /indeed\.(?:com|[a-z]{2})\/jobs\//.test(url);
  }

  function isViewJobPage(url = window.location.href) {
    return (
      /indeed\.(?:com|[a-z]{2})\/viewjob/.test(url) ||
      /indeed\.(?:com|[a-z]{2})\/rc\/clk/.test(url) ||
      /indeed\.(?:com|[a-z]{2})\/pagead\/clk/.test(url)
    );
  }

  function isIndeedOnboardingPage(url = window.location.href) {
    try {
      const u = new URL(url, location.href);
      return /onboarding\.indeed\.com$/i.test(u.hostname) || /\/onboarding\//i.test(u.pathname);
    } catch (_e) {
      return /onboarding\.indeed\.com/i.test(url);
    }
  }

  function isSmartApplyPage(url = window.location.href) {
    // v1.4.0: Ignore service worker iframes — they match smartapply but have no form
    let parsed = null;
    try {
      parsed = new URL(url, location.href);
    } catch (_e) {
      parsed = null;
    }
    const path = parsed ? parsed.pathname : url;
    if (/^\/_\/service_worker/i.test(path) || /^\/_\/scripts\//i.test(path) || /^\/sw_iframe/i.test(path)) {
      return false;
    }
    // Login walls carry the wizard URL inside ?continue= — matching the raw URL made
    // /auth look like a wizard and burned the full wizard timeout.
    if (isLoginWallPage(url)) return false;
    const host = parsed ? parsed.hostname : "";
    const target = host ? `${host}${path}` : url;
    return (
      /smartapply\.indeed\.com/i.test(target) ||
      /indeed\.(?:com|[a-z]{2})\/(?:beta\/)?indeedapply/i.test(target) ||
      /indeed\.(?:com|[a-z]{2})\/apply/i.test(target) ||
      /preloadresumeapply|applybyapplyablejobid/i.test(target)
    );
  }

  /** secure.indeed.com/auth — Indeed asks to re-login; no wizard will ever mount here. */
  function isLoginWallPage(url = window.location.href) {
    try {
      const u = new URL(url, location.href);
      return /(^|\.)secure\.indeed\.com$/i.test(u.hostname) && /^\/(auth|account)/i.test(u.pathname);
    } catch (_e) {
      return false;
    }
  }

  function buildSearchUrl(keywords, location, page = 0, session = null) {
    const host = getIndeedHost(session);
    const p = new URLSearchParams();
    // Keep SERP extras (radius, fromage, filters) when flipping pages
    try {
      const base = session?.searchUrl || (isSearchPage() ? window.location.href : "");
      if (base) {
        const u = new URL(base);
        u.searchParams.forEach((v, k) => {
          if (/^(start|vjk|advn|adid|ad|from|jk)$/i.test(k)) return;
          p.set(k, v);
        });
      }
    } catch (_e) {}
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
    if (!p.has("fromage")) p.set("fromage", "14");
    if (wantsFreelance) p.set("sc", "0kf:attr(DSQF7);");
    p.delete("start");
    if (page > 0) p.set("start", String(page * 10));
    return `${host}/jobs?${p.toString()}`;
  }

  /** Max SERP pages to walk (10 jobs/page). Bound by session maxJobs, not a tiny hard stop. */
  function maxIndeedSerpPages(session, settings) {
    const maxJobs = Math.max(1, session?.maxJobs || settings?.maxJobsPerSession || 25);
    return Math.min(80, Math.max(15, Math.ceil(maxJobs / 10) + 8));
  }

  function isValidIndeedJobKey(jk) {
    if (!jk || typeof jk !== "string") return false;
    const key = jk.trim();
    if (key.length < 10 || key.length > 64) return false;
    if (/^(jk_)?test/i.test(key)) return false;
    if (!/^[a-z0-9_-]+$/i.test(key)) return false;

    const lower = key.toLowerCase();
    // Reject known demo keys only (substring abcdef was too aggressive on real jk)
    if (
      /^(a1b2c3d4e5f67890|0123456789abcdef|abcdef0123456789|123456789abcdef0|fedcba9876543210|890abcdef0123456|deadbeefdeadbeef|cafebabecafebabe)$/i.test(
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
    // data-jk often lives on the title <a>, while href is /pagead/clk without jk=
    const link =
      el.querySelector?.('a[data-jk], a[href*="jk="], a[href*="viewjob"], a.jcs-JobTitle') ||
      (el.matches?.('a[data-jk], a[href*="jk="], a.jcs-JobTitle') ? el : null);
    const fromLink = link?.getAttribute?.("data-jk") || link?.getAttribute?.("data-jobkey");
    if (fromLink && isValidIndeedJobKey(fromLink)) return fromLink;
    const href = link?.getAttribute?.("href") || el.getAttribute?.("href") || "";
    const m = href.match(/[?&]jk=([^&]+)/) || href.match(/[?&]vjk=([^&]+)/);
    if (m) {
      const jk = decodeURIComponent(m[1]);
      if (isValidIndeedJobKey(jk)) return jk;
    }
    const id = el.getAttribute?.("id") || "";
    const idMatch = id.match(/^(?:job_|sj_)([a-f0-9]+)$/i) || id.match(/job_([a-f0-9]+)/i);
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

  function searchReturnUrl(session) {
    if (!session) return location.href;
    return buildSearchUrl(
      session.keywords,
      session.location,
      session.currentPage || 0,
      session
    );
  }

  /** After N successful applies on this SERP page, flip to next page (mass-apply pagination). */
  async function maybeFlipIndeedPage(session, settings, maxJobs, { navigate = true } = {}) {
    const perPage = settings?.maxJobsPerPage || 0;
    if (!perPage || perPage <= 0) return null;
    const pageApplied = session?.pageApplied || 0;
    const total = session?.applied || 0;
    if (pageApplied < perPage) return null;
    if (total >= maxJobs) return null;
    const nextPage = (session.currentPage || 0) + 1;
    if (nextPage > maxIndeedSerpPages(session, settings)) return null;
    const nextUrl = buildSearchUrl(session.keywords, session.location, nextPage, session);
    S().log(
      PLATFORM,
      `Page suivante Indeed (${nextPage + 1}) — ${pageApplied} postulé(s) sur cette page`,
      "warn"
    );
    await setSession({
      currentPage: nextPage,
      pageApplied: 0,
      queue: [],
      qIndex: 0,
      phase: "search",
      searchUrl: nextUrl,
    });
    if (navigate) window.location.href = nextUrl;
    return nextUrl;
  }

  async function endSession(reason) {
    await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: PLATFORM, reason });
    if (reason) S().log(PLATFORM, `Session terminée: ${reason}`, "warn");
  }

  function detectCloudflareChallenge() {
    const text = (document.body?.innerText || "").toLowerCase();
    const title = (document.title || "").toLowerCase();
    return (
      text.includes("verify you are human") ||
      text.includes("vérifiez que vous êtes humain") ||
      text.includes("additional verification required") ||
      text.includes("je ne suis pas un robot") ||
      text.includes("i'm not a robot") ||
      text.includes("checking your browser") ||
      text.includes("just a moment") ||
      title.includes("just a moment") ||
      title.includes("un instant") ||
      /ray id/i.test(text) ||
      !!document.querySelector(
        '#challenge-stage, .cf-turnstile, iframe[src*="challenges.cloudflare.com"], #cf-challenge-running'
      )
    );
  }

  async function markCloudflarePause(ms = 90000) {
    try {
      await chrome.storage.local.set({
        amijobsCfPause: { at: Date.now(), until: Date.now() + ms, platform: PLATFORM },
      });
    } catch (_e) {}
  }

  async function tryPassCloudflareChallenge() {
    const text = (document.body?.innerText || "").toLowerCase();
    const hasWidget =
      detectCloudflareChallenge() ||
      text.includes("vérifiez que vous êtes humain") ||
      text.includes("verify you are human") ||
      !!S().$('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile');
    if (!hasWidget) return false;

    // Freeze mass-apply / tab thrash while CF is up — spam reload = Ray ID "bruteforce"
    await markCloudflarePause(120000);
    S().log(
      PLATFORM,
      "Challenge Cloudflare — pause calme (pas de refresh). Cliquez la case ou attendez 2captcha.",
      "warn"
    );

    // ONE inject + one soft click + one 2captcha kick — never loop inject/CDP
    if (!window.__AmijobsCfSolveStartedAt || Date.now() - window.__AmijobsCfSolveStartedAt > 60000) {
      window.__AmijobsCfSolveStartedAt = Date.now();
      try {
        await chrome.runtime.sendMessage({ action: "injectTurnstileClicker", calm: true });
      } catch (_e) {}
      try {
        if (typeof window.__AmijobsClickTurnstile === "function") window.__AmijobsClickTurnstile();
        if (typeof window.__AmijobsSolveTurnstile === "function") window.__AmijobsSolveTurnstile(true);
      } catch (_e) {}
    }

    const start = Date.now();
    const maxMs = 120000;
    let lastClickAt = 0;
    while (Date.now() - start < maxMs) {
      if (shouldStop) return false;

      // At most one soft click every 8s — never spam the widget
      if (Date.now() - lastClickAt > 8000) {
        lastClickAt = Date.now();
        try {
          if (typeof window.__AmijobsClickTurnstile === "function") window.__AmijobsClickTurnstile();
        } catch (_e) {}
      }

      await S().sleep(4000);
      const still = detectCloudflareChallenge();
      if (!still && !detectBlockedPage()) {
        S().log(PLATFORM, "Challenge Cloudflare passé", "success");
        try {
          await chrome.storage.local.set({ amijobsCfPause: null });
        } catch (_e) {}
        window.__AmijobsCfSolveStartedAt = 0;
        return true;
      }
      if (collectJobCards().length > 0 || isSmartApplyPage()) {
        S().log(PLATFORM, "Challenge Cloudflare passé (contenu chargé)", "success");
        try {
          await chrome.storage.local.set({ amijobsCfPause: null });
        } catch (_e) {}
        window.__AmijobsCfSolveStartedAt = 0;
        return true;
      }
    }
    S().log(
      PLATFORM,
      "Challenge Cloudflare toujours présent — session en pause (ne pas recharger)",
      "warn"
    );
    await markCloudflarePause(180000);
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
    // Hostname path is authoritative (never trust body copy alone on SERP)
    if (isLoginWallPage()) return true;
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
    // Avoid false positives on normal Indeed chrome — only secure/auth-like pages
    try {
      const host = location.hostname || "";
      if (!/(^|\.)secure\.indeed\.com$/i.test(host) && !/\/(auth|login|account)\b/i.test(location.pathname || "")) {
        return false;
      }
    } catch (_e) {}
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
      text.includes("additional verification required") ||
      text.includes("vérification supplémentaire") ||
      title.includes("page introuvable") ||
      title.includes("additional verification") ||
      /page introuvable|not found|404|additional verification/.test(h1)
    );
  }

  function collectJobCards() {
    const selectors = [
      "#mosaic-provider-jobcards .cardOutline",
      "#mosaic-provider-jobcards [data-testid='slider_item']",
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
      ".jobsearch-SerpJobCard",
      "div.slider_item",
      "a.jcs-JobTitle[data-jk]",
      "h2.jobTitle a[data-jk]",
      "a[data-jk]",
    ];
    const nodes = new Set();
    for (const sel of selectors) {
      for (const el of S().$$(sel)) {
        // Prefer real card shells — bare <li> matches mosaic chrome without data-jk
        const card =
          el.closest(".job_seen_beacon, .cardOutline, [data-testid='slider_item'], [data-testid='job-card'], li[data-jk], div[data-jk]") ||
          (el.matches?.("a[data-jk], a.jcs-JobTitle") ? el : null) ||
          el;
        nodes.add(card);
      }
    }
    const out = [];
    const seen = new Set();
    for (const el of nodes) {
      const jk = extractJobKey(el);
      if (!jk || seen.has(jk)) continue;
      const titleEl =
        (el.matches?.("a.jcs-JobTitle, a[data-jk], h2 a") ? el : null) ||
        el.querySelector?.(
          "h2.jobTitle span, h2.jobTitle a, .jobTitle, [data-testid='job-title'], a.jcs-JobTitle, a[data-jk]"
        );
      const title = (titleEl?.textContent || "").trim();
      // Ghost / ad shells often expose fake jk without a real title
      if (!title || title.length < 3) continue;
      if (/page introuvable|not found|job expired/i.test(title)) continue;
      seen.add(jk);
      const company =
        el.querySelector?.("[data-testid='company-name'], .companyName, .company, span.companyName")
          ?.textContent?.trim() ||
        el.closest?.(".job_seen_beacon, .cardOutline, li, [data-testid='slider_item']")
          ?.querySelector?.("[data-testid='company-name'], .companyName, span.companyName")
          ?.textContent?.trim() ||
        "";
      const shell =
        el.closest?.(".job_seen_beacon, .cardOutline, [data-testid='slider_item'], li") || el;
      const easy = cardLooksLikeEasyApply(shell) || cardLooksLikeEasyApply(el);
      out.push({ element: shell || el, jobId: jk, title, company, easyApply: easy });
    }
    // SERP already filtered with applicationType=1 / iafilter=1 — keep all cards
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("applicationType") === "1" || u.searchParams.get("iafilter") === "1") {
        return out.map((c) => ({ ...c, easyApply: true }));
      }
    } catch (_e) {}
    // If any card has Easy Apply badge, drop cards without it
    if (out.some((c) => c.easyApply)) {
      return out.filter((c) => c.easyApply);
    }
    return out;
  }

  async function waitForJobCards(maxWaitMs = 45000, { minCards = 3 } = {}) {
    const start = Date.now();
    let attempt = 0;
    let best = [];
    let stableCount = 0;
    let lastLen = -1;
    await dismissIndeedPopups().catch(() => {});
    while (Date.now() - start < maxWaitMs) {
      attempt++;
      if (detectBlockedPage()) return best;
      if (detectNoResultsPage() && attempt > 3) return best;
      const scrollRoot =
        S().$("#mosaic-provider-jobcards") ||
        S().$(".jobsearch-ResultsList") ||
        S().$('[class*="JobCard"]')?.closest("ul, div") ||
        S().$("main") ||
        document.scrollingElement;
      if (scrollRoot) {
        scrollRoot.scrollTop = Math.min((scrollRoot.scrollTop || 0) + 700, scrollRoot.scrollHeight || 8000);
      } else {
        window.scrollBy(0, 700);
      }
      await S().sleep(450);
      const cards = collectJobCards();
      if (cards.length > best.length) best = cards;
      if (cards.length === lastLen && cards.length > 0) stableCount++;
      else stableCount = 0;
      lastLen = cards.length;
      // Keep scrolling until a usable SERP batch is loaded
      if (cards.length >= minCards) {
        S().log(PLATFORM, `${cards.length} offres détectées (tentative ${attempt})`);
        window.scrollTo(0, 0);
        return cards;
      }
      // Stable partial page — don't burn the full timeout
      if (cards.length > 0 && (stableCount >= 3 || Date.now() - start > maxWaitMs * 0.55)) {
        S().log(PLATFORM, `${cards.length} offres détectées (partiel, tentative ${attempt})`, "warn");
        window.scrollTo(0, 0);
        return cards;
      }
      await S().sleep(900);
    }
    if (best.length) {
      S().log(PLATFORM, `${best.length} offres détectées (timeout)`, "warn");
    } else {
      S().log(
        PLATFORM,
        `0 offre détectée après ${Math.round(maxWaitMs / 1000)}s (URL=${location.pathname}${location.search.slice(0, 80)})`,
        "warn"
      );
    }
    window.scrollTo(0, 0);
    return best.length ? best : collectJobCards();
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
    // Already-applied jobs often keep a dead Postuler control — never click it
    if (detectAlreadyAppliedUi()) return null;

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
      'button[aria-label*="opens in a new tab" i]',
      'a[aria-label*="Postuler sur Indeed" i]',
      'a[data-indeed-apply-button]',
      "#applyButtonLinkContainer button",
      ".jobsearch-IndeedApplyButton-newDesign",
      'button[id*="indeedApply"]',
      '[data-indeed-apply-status]',
      // Live FR SERP (2026): hashed data-testid + text "Postuler sur Indeed"
      'button[data-testid$="-test"]',
      '[data-testid$="-test"][aria-label*="Postuler" i]',
      '[data-testid$="-test"][aria-label*="Indeed" i]',
    ];
    for (const root of roots) {
      for (const sel of selectors) {
        for (const btn of root.querySelectorAll(sel)) {
          if (!btn || !S().isVisible(btn) || isCompanySiteApplyButton(btn) || isContinueToApplyButton(btn)) {
            continue;
          }
          // Hashed -test ids / generic "opens in a new tab" — require Postuler/Apply wording
          if (sel.includes("-test") || /opens in a new tab/i.test(sel)) {
            const t = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`;
            if (!/postuler|indeed apply|apply with indeed|apply on indeed/i.test(t)) continue;
          }
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
        // Badge / filter label — not an apply CTA
        if (/^\s*candidature simplifi[ée]e\s*$/i.test(text.trim())) continue;
        // Reject huge containers (job cards / panels) that merely contain the word somewhere
        if (text.trim().length > 64) continue;
        if (
          /postuler sur indeed|indeed apply|apply with indeed|postuler facilement|candidature facile/i.test(
            text
          ) ||
          /^\s*postuler\s*$/i.test(text)
        ) {
          return el;
        }
      }
      for (const span of root.querySelectorAll("span, div")) {
        const t = (span.textContent || "").trim();
        // Never match SERP filter chips — only real apply CTAs in the job panel
        if (
          !/^postuler sur indeed$/i.test(t) &&
          !/^indeed apply$/i.test(t) &&
          !/^postuler$/i.test(t) &&
          !/^candidature facile$/i.test(t)
        )
          continue;
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

  function detectApplySuccess() {
    const path = window.location.pathname || "";
    const href = window.location.href || "";
    const title = (document.title || "").toLowerCase();
    // HAR live session: title "Votre candidature a été envoyée | Indeed"
    if (/votre candidature a (été|ete) envoyée|application (has been )?submitted|candidature envoyée/i.test(title)) {
      return true;
    }
    if (/\/post-apply/i.test(path) || /application-submitted/i.test(path) || /\/conversion\/?/i.test(path)) {
      return true;
    }
    if (/\/conversion\//i.test(href)) return true;
    const body = document.body?.innerText?.toLowerCase() || "";
    return (
      body.includes("application submitted") ||
      body.includes("your application has been submitted") ||
      body.includes("vous avez postulé") ||
      body.includes("candidature a été envoyée") ||
      body.includes("votre candidature a été envoyée") ||
      body.includes("we have received your application") ||
      body.includes("nous avons bien reçu") ||
      body.includes("votre candidature a bien été") ||
      !!S().$('[data-testid="apply-success"], .ia-BasePage-heading, [data-testid="post-apply"]')
    );
  }

  /** Smart Apply URL from HAR flow: applybyapplyablejobid / preloadresumeapply. */
  function extractSmartApplyUrlFromDom() {
    const roots = [document];
    try {
      for (const frame of document.querySelectorAll("iframe")) {
        try {
          const doc = frame.contentDocument || frame.contentWindow?.document;
          if (doc) roots.push(doc);
        } catch (_e) {}
      }
    } catch (_e) {}
    for (const root of roots) {
      for (const a of root.querySelectorAll(
        'a[href*="smartapply.indeed.com"], a[href*="applybyapplyablejobid"], a[href*="preloadresumeapply"], a[href*="indeedapply"]'
      )) {
        const href = a.href || a.getAttribute("href") || "";
        if (/smartapply\.indeed\.com|applybyapplyablejobid|preloadresumeapply/i.test(href)) return href;
      }
      for (const el of root.querySelectorAll(
        "[data-indeed-apply-joburl], [data-indeed-apply-continueurl], [data-indeed-apply-url], [data-apply-url]"
      )) {
        const href =
          el.getAttribute("data-indeed-apply-joburl") ||
          el.getAttribute("data-indeed-apply-continueurl") ||
          el.getAttribute("data-indeed-apply-url") ||
          el.getAttribute("data-apply-url") ||
          "";
        if (/smartapply\.indeed\.com|applybyapplyablejobid|preloadresumeapply/i.test(href)) return href;
      }
    }
    try {
      const html = document.documentElement?.innerHTML || "";
      const m =
        html.match(/https:\/\/smartapply\.indeed\.com\/beta\/indeedapply\/applybyapplyablejobid\?[^"'\\\s<]+/i) ||
        html.match(/https:\\\/\\\/smartapply\.indeed\.com\\\/beta\\\/indeedapply\\\/applybyapplyablejobid\?[^"'\\]+/i);
      if (m) return m[0].replace(/\\\//g, "/").replace(/&amp;/g, "&");
    } catch (_e) {}
    return null;
  }

  /** Keep session.currentPage aligned with ?start= on the live SERP (HAR: start=10 → page 2). */
  async function syncSerpPageFromLocation(session) {
    if (!session || !isSearchPage()) return session;
    try {
      const u = new URL(window.location.href);
      const start = parseInt(u.searchParams.get("start") || "0", 10) || 0;
      const page = Math.max(0, Math.floor(start / 10));
      const searchUrl = `${u.origin}${u.pathname}?${u.searchParams.toString()}`;
      if (page !== (session.currentPage || 0) || !session.searchUrl) {
        S().log(PLATFORM, `SERP sync page ${page + 1} (start=${start})`, "warn");
        return await setSession({ currentPage: page, searchUrl, phase: "search" });
      }
      if (session.searchUrl !== searchUrl) {
        return await setSession({ searchUrl });
      }
    } catch (_e) {}
    return session;
  }

  /** Right-hand job pane (or full viewjob) — not the SERP card list. */
  function getIndeedJobPanelRoot() {
    return (
      S().$(
        '#jobsearch-ViewjobPaneWrapper, [data-testid="jobsearch-JobComponent"], .jobsearch-JobComponent, #viewJobSSRRoot, .jobsearch-RightPane, [data-testid="jobsearch-ViewJobButtons-container"], #jobsearch-ViewJobButtons-container'
      ) ||
      (!isSearchPage() ? document.body : null)
    );
  }

  /** Card-level "already applied" badge on the SERP list. */
  function cardAlreadyApplied(cardEl) {
    if (!cardEl) return false;
    if (cardEl.querySelector?.('[data-testid="appliedSnippet"], [data-testid*="appliedSnippet" i]')) {
      return true;
    }
    const t = `${cardEl.innerText || cardEl.textContent || ""}`.toLowerCase();
    return /candidature envoyée|already applied|vous avez déjà postulé|application sent/i.test(t);
  }

  /**
   * Job detail already applied. Live FR UI (2026): data-testid="appliedSnippet"
   * ("Candidature envoyée") while #jobsearch-ViewJobButtons-container may still
   * show a non-working Postuler control — treat snippet as authoritative.
   */
  function detectAlreadyAppliedUi() {
    const panel = getIndeedJobPanelRoot();
    if (panel) {
      if (panel.querySelector?.('[data-testid="appliedSnippet"], [data-testid*="appliedSnippet" i]')) {
        return true;
      }
      if (
        panel.querySelector?.(
          '[data-testid*="already-applied" i], [aria-label*="déjà postulé" i], [aria-label*="already applied" i]'
        )
      ) {
        return true;
      }
      const panelText = (panel.innerText || "").toLowerCase();
      // Snippet text wins even when a dead Postuler button is still in the DOM
      if (
        /candidature envoyée|candidature déjà envoyée|candidature deja envoyee|vous avez déjà postulé|you have already applied|already applied to this job|application sent/i.test(
          panelText
        )
      ) {
        return true;
      }
    }
    if (!isSearchPage()) {
      const t = (document.body?.innerText || "").toLowerCase();
      if (
        t.includes("vous avez déjà postulé") ||
        t.includes("vous avez deja poste") ||
        t.includes("you have already applied") ||
        t.includes("already applied to this job") ||
        t.includes("candidature déjà envoyée") ||
        t.includes("candidature deja envoyee")
      ) {
        return true;
      }
      if (S().$('[data-testid="appliedSnippet"], [data-testid*="appliedSnippet" i]')) return true;
    }
    return false;
  }

  async function waitForApplyButton(timeoutMs = 14000) {
    // Easy Apply / candidature simplifiée only — ignore "Continuer pour postuler"
    const start = Date.now();
    let dismissed = false;
    while (Date.now() - start < timeoutMs) {
      if (!dismissed || Date.now() - start < 2500) {
        dismissed = (await dismissIndeedPopups().catch(() => false)) || dismissed;
      }
      if (detectAlreadyAppliedUi()) return null;
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

  async function alreadyApplied(appliedJobs, jobId) {
    if (!jobId) return false;
    return !!(appliedJobs[jobId] || appliedJobs[`ind_${jobId}`]);
  }

  async function alreadyHandled(jobId) {
    if (!jobId) return false;
    const { appliedJobs = {}, skippedJobs = {}, errorJobs = {} } = await chrome.storage.local.get([
      "appliedJobs",
      "skippedJobs",
      "errorJobs",
    ]);
    const keys = [jobId, `ind_${jobId}`];
    // Do NOT treat seenJobIds as terminal — a failed open / interrupted viewjob must retry
    return keys.some((k) => appliedJobs[k] || skippedJobs[k] || errorJobs[k]);
  }

  async function markSeenJob(jobId) {
    if (!jobId) return;
    const session = await getSession();
    if (!session) return;
    const seenJobIds = { ...(session.seenJobIds || {}), [jobId]: Date.now() };
    await setSession({ seenJobIds });
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
      ['input[name*="postal" i]', null, postal],
      ['input[name*="city" i], input[name*="locality" i]', null, city],
      ['input[name*="address" i], input[autocomplete="street-address"]', null, address],
    ];
    for (const [a, b, val] of map) {
      const el = (a && S().$(a)) || (b && S().$(b));
      if (el && S().isVisible(el) && !(el.value || "").trim()) {
        await S().humanType(el, val);
        await S().sleep(200);
      }
    }
    // Advance if Continuer is already enabled on this step
    const cont =
      S().$('[data-testid="continue-button"]') ||
      [...S().$$("button")].find((b) => /^continuer$/i.test((b.textContent || "").trim()) && isDisplayed(b));
    if (cont && !cont.disabled && cont.getAttribute("aria-disabled") !== "true") {
      await S().humanClick(cont);
      await S().sleep(1200);
    }
  }

  /** Indeed sometimes inserts preferences onboarding mid-apply (onboarding.indeed.com). */
  async function handleIndeedOnboardingPage() {
    S().log(PLATFORM, "Onboarding Indeed — préférences / localisation", "warn");
    const profile = await S().getProfile();
    const city = (profile.location || "").split(",")[0].trim() || "Paris";
    const postal = profile.postalCode || "75001";
    // Fill empty city / postal inputs (page often prefilled)
    for (const el of S().$$('input[type="text"], input:not([type]), input[name*="location" i], input[name*="postal" i], input[name*="city" i]')) {
      if (!S().isVisible(el) || (el.value || "").trim()) continue;
      const hint = `${el.name || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""} ${el.placeholder || ""}`.toLowerCase();
      const val = /postal|zip|code/i.test(hint) ? postal : city;
      await S().humanType(el, val);
      await S().sleep(250);
    }
    const cont =
      S().$('[data-testid="continue-button"], [data-testid*="continue" i]') ||
      [...S().$$("button")].find((b) => {
        if (!isDisplayed(b) || b.disabled || b.getAttribute("aria-disabled") === "true") return false;
        return /^continuer$|^continue$|^suivant$|^next$/i.test((b.textContent || "").trim());
      });
    if (cont) {
      S().log(PLATFORM, "Clic Continuer (onboarding)");
      await S().humanClick(cont);
      await S().sleep(2000);
      return true;
    }
    S().log(PLATFORM, "Onboarding sans Continuer — attente", "warn");
    await S().sleep(1500);
    return false;
  }

  function resumePageText() {
    return (document.body?.innerText || "").replace(/\s+/g, " ");
  }

  /** Indeed CV service down → only file upload works ("Importer un CV"). */
  function needsForcedCvUpload() {
    const t = resumePageText();
    if (
      /Indeed CV est actuellement indisponible|Importer un CV|Types de fichiers acceptés|use an uploaded resume|Sélectionnez un fichier pour continuer|Select a file to continue/i.test(
        t
      )
    ) {
      return true;
    }
    // Upload button visible on resume step
    const uploadBtn = [...S().$$("button, [role='button'], label")].some(
      (b) => S().isVisible(b) && /S[ée]lectionner un fichier|Choose file|Upload (a )?resume/i.test(b.textContent || "")
    );
    return uploadBtn && !!S().$('input[type="file"]');
  }

  function resumeUploadErrorVisible() {
    return /Sélectionnez un fichier pour continuer|Select a file to continue/i.test(resumePageText());
  }

  /** Indeed only advances when the uploaded filename is visible — input.files alone is a false positive. */
  function resumeFileUiAccepted(cvName = "") {
    if (resumeUploadErrorVisible()) {
      window.__AmijobsResumeUploadedAt = 0;
      return false;
    }
    const t = resumePageText();
    const name = String(cvName || window.__AmijobsResumeFileName || "").trim();
    const stem = name.replace(/\.[^.]+$/, "").slice(0, 40);
    if (stem.length >= 5 && t.toLowerCase().includes(stem.toLowerCase())) return true;
    if (name && t.toLowerCase().includes(name.toLowerCase())) return true;

    // Explicit filename chip (not the radio card / help text)
    const chip = [...S().$$("[data-testid], [class*='FileName'], [class*='fileName'], [class*='ia-File'], span, p")].find(
      (el) => {
        if (!S().isVisible(el)) return false;
        const tx = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!/\.(pdf|docx?|rtf|txt)$/i.test(tx) || tx.length > 140) return false;
        if (/Types de fichiers|acceptés|PDF,\s*DOC/i.test(tx)) return false;
        const tid = `${el.getAttribute("data-testid") || ""} ${el.className || ""}`;
        if (/radio|resume-selection-file-resume|card-group/i.test(tid)) return false;
        return true;
      }
    );
    return !!chip;
  }

  function resumeLooksReady() {
    if (resumeUploadErrorVisible()) {
      window.__AmijobsResumeUploadedAt = 0;
      return false;
    }

    // Forced upload path (Indeed CV down): never trust radios or bare input.files
    if (needsForcedCvUpload() || /resume-selection/i.test(smartApplyPath())) {
      if (window.__AmijobsResumeUploadedAt && Date.now() - window.__AmijobsResumeUploadedAt < 120000) {
        return resumeFileUiAccepted(window.__AmijobsResumeFileName || "");
      }
      return resumeFileUiAccepted(window.__AmijobsResumeFileName || "");
    }

    if (window.__AmijobsResumeUploadedAt && Date.now() - window.__AmijobsResumeUploadedAt < 120000) {
      return true;
    }

    for (const input of S().$$('input[type="file"]')) {
      if (input.files && input.files.length > 0) return true;
    }

    if (resumeFileUiAccepted()) return true;

    const checked =
      S().$('input[type="radio"][name*="resume"]:checked') ||
      S().$('[data-testid*="resume"][aria-checked="true"]');
    return !!checked;
  }

  function resumeOptionalWithoutCv() {
    const t = resumePageText();
    return /Postuler sans CV|Apply without (a )?resume|CV est facultatif|resume is optional/i.test(t);
  }

  async function clickResumeIfNeeded() {
    if (resumeLooksReady()) return true;

    // Some Glassdoor→Indeed offers allow continue without a file
    if (resumeOptionalWithoutCv() && !resumeUploadErrorVisible()) {
      const opt =
        S().$('[data-testid*="no-resume"], [data-testid*="without-resume"], [data-testid*="optional-resume"]') ||
        [...S().$$("button, label, [role='button'], [role='radio']")].find((b) =>
          S().isVisible(b) && /Postuler sans CV|Apply without (a )?resume|sans CV/i.test(b.textContent || "")
        );
      if (opt) {
        await S().humanClick(opt);
        await S().sleep(400);
        window.__AmijobsResumeUploadedAt = Date.now();
        window.__AmijobsResumeFileName = window.__AmijobsResumeFileName || "optional-no-cv";
        S().log(PLATFORM, "CV facultatif — Postuler sans CV", "warn");
        return true;
      }
      // Continuer alone is enough when Indeed says CV is optional and no validation error
      if (!needsForcedCvUpload() || /CV est facultatif|resume is optional/i.test(resumePageText())) {
        window.__AmijobsResumeUploadedAt = Date.now();
        window.__AmijobsResumeFileName = "optional-no-cv";
        return true;
      }
    }

    // When Indeed CV is down, skip radios and upload AmiJobs CV immediately
    if (needsForcedCvUpload()) {
      const ok = await uploadCvFallback();
      if (ok) return true;
      const cv = await S().getCvFile();
      if (!cv?.base64) {
        S().log(PLATFORM, "CV fichier manquant (Options → CV) — upload requis", "error");
      } else {
        S().log(PLATFORM, "Échec upload CV sur resume-selection", "warn");
      }
      return false;
    }

    // Live DOM: resume-selection-file-resume-radio-card (+ label/input)
    const label =
      S().$('[data-testid="resume-selection-file-resume-radio-card-label"]') ||
      S().$('[data-testid="resume-selection-file-resume-radio-card"]') ||
      S().$('[data-testid="resume-selection-radio-card-group"] label') ||
      S().$('label[data-testid*="resume"]');
    if (label && S().isVisible(label)) {
      await S().humanClick(label);
      await S().sleep(400);
      if (resumeLooksReady()) return true;
      await uploadCvFallback();
      return resumeLooksReady();
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
      if (resumeLooksReady()) return true;
      await uploadCvFallback();
      return resumeLooksReady();
    }

    return await uploadCvFallback();
  }

  // Upload AmiJobs CV to hidden file inputs (Indeed FR "Sélectionner un fichier").
  // DataTransfer alone is often ignored by React — CDP file-chooser is the reliable path.
  async function uploadCvFallback() {
    // Never burn CDP on preload / contact / questions — file input only exists on resume-selection
    const path = smartApplyPath();
    if (path && !/resume-selection|resume\/|\/resume/i.test(path) && !resumeUploadErrorVisible()) {
      return false;
    }
    const cv = await S().getCvFile();
    if (!cv?.base64) return false;
    window.__AmijobsResumeFileName = cv.name || "cv.pdf";

    // Already accepted for this wizard — never re-download/upload the same CV in a loop
    if (resumeFileUiAccepted(cv.name) && !resumeUploadErrorVisible()) {
      window.__AmijobsResumeUploadedAt = Date.now();
      return true;
    }
    const cdpTries = window.__AmijobsCvCdpTries || 0;
    if (cdpTries >= 2 && resumeFileUiAccepted(cv.name)) {
      S().log(PLATFORM, "CV déjà présent — skip re-upload", "warn");
      return true;
    }

    // Indeed mounts the file input a beat after the resume step renders. Calling CDP
    // before it exists always returned no_file_input and cost ~8s per job.
    const hasFileInput = () => !!S().$('input[type="file"]');
    if (!hasFileInput()) {
      for (let i = 0; i < 8 && !hasFileInput(); i++) await S().sleep(400);
      if (!hasFileInput()) return false;
    }

    const markAccepted = (label) => {
      window.__AmijobsResumeUploadedAt = Date.now();
      window.__AmijobsResumeFileName = cv.name || window.__AmijobsResumeFileName;
      S().log(PLATFORM, label, "success");
      return true;
    };

    // CDP first when Indeed CV is down — DataTransfer leaves a fake checkmark + red error
    if (needsForcedCvUpload() || resumeUploadErrorVisible()) {
      if (cdpTries >= 2) {
        S().log(PLATFORM, "CDP CV déjà tenté 2× — pas de nouvel upload", "warn");
        return resumeFileUiAccepted(cv.name);
      }
      window.__AmijobsCvCdpTries = cdpTries + 1;
      try {
        S().log(PLATFORM, "Upload CV via debugger (CDP)…", "warn");
        const res = await chrome.runtime.sendMessage({ action: "uploadCvViaDebugger" });
        S().log(
          PLATFORM,
          `CDP: ok=${!!res?.ok} accepted=${!!res?.accepted} name=${res?.hasName ? "yes" : "no"} err=${!!res?.stillError} chooser=${!!res?.viaChooser} reason=${res?.reason || "-"}`,
          res?.accepted ? "success" : "warn"
        );
        if (res?.accepted || (res?.ok && !res?.stillError && res?.hasName)) {
          for (let i = 0; i < 10; i++) {
            if (resumeFileUiAccepted(cv.name)) return markAccepted(`CV importé CDP (${res.name || cv.name})`);
            await S().sleep(400);
          }
          if (!resumeUploadErrorVisible() && res?.hasName) {
            return markAccepted(`CV accepté CDP (${res.name || cv.name})`);
          }
        }
      } catch (e) {
        S().log(PLATFORM, `Upload CDP erreur: ${e?.message || e}`, "warn");
      }
    }

    // Prefer real file inputs; some testids wrap a hidden input
    const candidates = [
      ...S().$$('input[type="file"]'),
      ...S().$$('[data-testid*="resume-upload"], [data-testid*="file-upload"], [data-testid*="FileUpload"]'),
    ];
    const seen = new Set();
    for (const node of candidates) {
      const input =
        node.tagName === "INPUT" && (node.getAttribute("type") || "").toLowerCase() === "file"
          ? node
          : node.querySelector?.('input[type="file"]');
      if (!input || seen.has(input)) continue;
      seen.add(input);
      const ok = await S().uploadCvToFileInput(input);
      if (ok) {
        // Indeed renders the filename async — a single short check fell through to CDP
        // and cost ~40s per job even though this upload had actually worked.
        for (let i = 0; i < 12; i++) {
          await S().sleep(400);
          if (resumeFileUiAccepted(cv.name) && !resumeUploadErrorVisible()) {
            return markAccepted(`CV importé (${cv.name || "fichier"})`);
          }
        }
      }
    }

    // Drop onto upload zone (some Indeed UIs listen for drop, not change)
    try {
      const file = await cvToFile(cv);
      if (file) {
        const zones = [
          ...S().$$("[data-testid*='upload'], [class*='Upload'], [class*='upload']"),
          ...[...S().$$("button, [role='button']")].filter((b) =>
            /^S[ée]lectionner un fichier|Choose (a )?file|Upload/i.test((b.textContent || "").replace(/\s+/g, " ").trim())
          ),
        ];
        for (const zone of zones.slice(0, 4)) {
          const dt = new DataTransfer();
          dt.items.add(file);
          for (const type of ["dragenter", "dragover", "drop"]) {
            zone.dispatchEvent(
              new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
            );
          }
          await S().sleep(700);
          if (resumeFileUiAccepted(cv.name) && !resumeUploadErrorVisible()) {
            return markAccepted(`CV déposé (${cv.name || "fichier"})`);
          }
        }
      }
    } catch (_e) {
      /* ignore */
    }

    // Final CDP attempt if not already tried / previous attempt failed UI check
    if (!resumeFileUiAccepted(cv.name) && (window.__AmijobsCvCdpTries || 0) < 2) {
      window.__AmijobsCvCdpTries = (window.__AmijobsCvCdpTries || 0) + 1;
      try {
        S().log(PLATFORM, "Upload CV via debugger (CDP) retry…", "warn");
        const res = await chrome.runtime.sendMessage({ action: "uploadCvViaDebugger" });
        S().log(
          PLATFORM,
          `CDP retry: ok=${!!res?.ok} accepted=${!!res?.accepted} err=${!!res?.stillError} reason=${res?.reason || "-"}`,
          res?.accepted ? "success" : "warn"
        );
        for (let i = 0; i < 12; i++) {
          if (resumeFileUiAccepted(cv.name)) return markAccepted(`CV importé CDP (${res?.name || cv.name})`);
          await S().sleep(450);
        }
      } catch (e) {
        S().log(PLATFORM, `Upload CDP erreur: ${e?.message || e}`, "warn");
      }
    }

    return resumeFileUiAccepted(cv.name);
  }

  async function cvToFile(cv) {
    if (!cv?.base64) return null;
    try {
      const bin = atob(cv.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], cv.name || "cv.pdf", {
        type: cv.mime || "application/pdf",
        lastModified: Date.now(),
      });
    } catch (_e) {
      return null;
    }
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

  function isDisplayed(el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      // Sticky footers can be partially off-screen — allow tiny height
      return rect.width > 2 && rect.height > 2;
    } catch (_e) {
      return false;
    }
  }

  function isSmartApplyChromeOnlyButton(btn) {
    if (!btn) return true;
    const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
    return (
      !text ||
      /^(1 new update|enregistrer et fermer|signaler( un problème)?|retour|back|page d['’]accueil|avis sur les entreprises|estimation de salaire|messages|notifications|mes emplois|entreprises\s*\/|logo indeed|règles de confidentialité|conditions d['’]utilisation)$/i.test(
        text
      ) ||
      /ExitLinkWithModal|midApplyFeedback|gnav-|Logo Indeed/i.test(
        `${btn.getAttribute("data-testid") || ""} ${btn.className || ""} ${btn.getAttribute("aria-label") || ""}`
      )
    );
  }

  /** True when Smart Apply path is mounted but CTAs (Continuer / Déposer) are not yet in DOM. */
  function isSmartApplyShellOnly() {
    const path = String(location.pathname || "");
    if (!/indeedapply|smartapply/i.test(path + location.href)) return false;
    // Disabled Continuer still counts — resume step shows it before CV is accepted
    if (findSubmitButton(true)) return false;
    for (const sel of [
      '[data-testid="continue-button"]',
      '[data-testid^="hp-continue-button"]',
      '[data-testid="resume-selection-continue-button"]',
    ]) {
      for (const el of S().$$(sel)) {
        if (isDisplayed(el)) return false;
      }
    }
    for (const btn of S().$$("button, a[role='button'], [role='button']")) {
      if (!isDisplayed(btn)) continue;
      const text = `${btn.textContent || ""}`.replace(/\s+/g, " ").trim();
      if (/^continuer$/i.test(text) || /^continue$/i.test(text) || /^suivant$/i.test(text)) return false;
    }
    // Resume upload / radio UI counts as real module content
    if (
      document.querySelector(
        'input[type="radio"], input[type="file"], [data-testid*="resume" i], [data-testid*="Resume" i]'
      ) ||
      /Ajoutez un CV|Importer un CV|Upload (a )?resume|Sélectionnez un CV|Add a resume/i.test(
        document.body?.innerText || ""
      )
    ) {
      return false;
    }
    const actionable = [...S().$$("button, a[role='button'], [role='button'], input[type='submit']")].filter(
      (b) => isDisplayed(b) && !isSmartApplyChromeOnlyButton(b)
    );
    return actionable.length === 0;
  }

  function isSmartApplyLoading() {
    // Narrow loaders only — broad "[class*=Spinner]" / aria-busy matched chrome and blocked forever
    const loaders = [
      '[data-testid="loading-indicator"]',
      '[data-testid="ia-loading"]',
      '[class*="LoadingSpinner"]',
      '[class*="loadingSpinner"]',
      '[class*="ia-Loading"]',
      '[role="progressbar"][aria-busy="true"]',
      'svg[aria-label*="chargement" i]',
      'svg[aria-label*="loading" i]',
    ];
    for (const sel of loaders) {
      const el = S().$(sel);
      if (el && isDisplayed(el)) {
        // If Continuer/Déposer already mounted (even disabled), don't stall
        if (findSubmitButton(true)) return false;
        for (const btn of S().$$("button")) {
          if (!isDisplayed(btn)) continue;
          if (/^continuer$|^continue$|déposer|submit/i.test((btn.textContent || "").trim())) return false;
        }
        return true;
      }
    }
    const t = (document.body?.innerText || "").replace(/\s+/g, " ").toLowerCase();
    if (/chargement en cours|préparation de l['’]aperçu|loading\.\.\.|please wait/i.test(t)) {
      if (findSubmitButton(true)) return false;
      for (const btn of S().$$("button")) {
        if (!isDisplayed(btn)) continue;
        if (/^continuer$|^continue$|déposer|submit/i.test((btn.textContent || "").trim())) return false;
      }
      // Real resume module copy means not a blank loader shell
      if (/ajoutez un cv|importer un cv|upload (a )?resume/i.test(t)) return false;
      return true;
    }
    if (isSmartApplyShellOnly()) return true;
    return false;
  }

  function findSubmitButton(includeDisabled = true) {
    const submitRe = [
      /d[ée]poser\s*(ma|votre)?\s*candidature/i,
      /submit (my )?application/i,
      /soumettre (ma |votre )?candidature/i,
      /envoyer (ma |votre )?candidature/i,
      /send application/i,
      /^soumettre$/i,
      /finalize/i,
      /^d[ée]poser$/i,
      /postuler maintenant/i,
      /^apply now$/i,
      /candidater/i,
    ];
    const testIds = [
      '[data-testid="submit-application"]',
      '[data-testid="submit-button"]',
      '[data-testid="indeed-apply-submit"]',
      '[data-testid="ia-submitApplication-footerButton"]',
      '[data-testid*="submitApplication"]',
      '[data-testid*="SubmitApplication"]',
      '[data-testid*="submitApplication-footer"]',
      'button[data-testid*="submit"]',
      'button[type="submit"]',
      'button.ia-continueButton[type="submit"]',
    ];
    // IMPORTANT: do NOT use S().isVisible here — it treats disabled as invisible,
    // and Indeed keeps "Déposer" disabled until the captcha UI flips.
    // Also NEVER treat generic primary/continue classes as submit without text match.
    for (const sel of testIds) {
      for (const el of S().$$(sel)) {
        if (!isDisplayed(el)) continue;
        if (!includeDisabled && (el.disabled || el.getAttribute("aria-disabled") === "true")) continue;
        const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
        if (/enregistrer et fermer|signaler|retour|quitter|1 new update/i.test(text)) continue;
        // Generic type=submit / data-testid*submit can match non-apply chrome — require wording when ambiguous
        if (/type="submit"|data-testid\*="submit"/.test(sel) || sel.includes('[data-testid*="submit"]')) {
          if (text && !submitRe.some((p) => p.test(text)) && !/submit|déposer|soumettre|envoyer|apply/i.test(text)) {
            continue;
          }
        }
        return el;
      }
    }
    // Primary/continue class candidates — TEXT must look like submit
    for (const el of S().$$("button.ia-continueButton, button.ia-Button--primary, button[class*='Primary']")) {
      if (!isDisplayed(el)) continue;
      if (!includeDisabled && (el.disabled || el.getAttribute("aria-disabled") === "true")) continue;
      const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
      if (!text || /enregistrer et fermer|signaler|retour|quitter|continuer|continue|suivant|next/i.test(text)) {
        continue;
      }
      if (submitRe.some((p) => p.test(text))) return el;
    }
    for (const btn of S().$$("button, a[role='button'], input[type='submit'], [role='button']")) {
      if (!isDisplayed(btn)) continue;
      if (!includeDisabled && (btn.disabled || btn.getAttribute("aria-disabled") === "true")) continue;
      const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""} ${btn.value || ""}`
        .replace(/\s+/g, " ")
        .trim();
      if (
        !text ||
        /signaler|fermer|close|exit|options de cv|passer au contenu|enregistrer et fermer|quitter|retour|back|preview|aperçu|1 new update/i.test(
          text
        )
      ) {
        continue;
      }
      if (submitRe.some((p) => p.test(text))) return btn;
    }
    return null;
  }

  function isSubmitButtonReady(btn) {
    if (!btn || !isDisplayed(btn)) return false;
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
    return true;
  }

  function isRecaptchaWidgetReady() {
    const hasWidget =
      !!document.querySelector(
        'iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey], textarea[name="g-recaptcha-response"]'
      ) || /je ne suis pas un robot|i'?m not a robot/i.test(document.body?.innerText || "");
    if (!hasWidget) return true;
    if (typeof window.__AmijobsRecaptchaWidgetReady === "function") {
      try {
        return !!window.__AmijobsRecaptchaWidgetReady();
      } catch (_e) {}
    }
    if (!hasFreshRecaptchaToken()) return false;
    const unchecked = document.querySelector(
      '#recaptcha-anchor[aria-checked="false"], .recaptcha-checkbox[aria-checked="false"], span[role="checkbox"][aria-checked="false"]'
    );
    if (unchecked) {
      try {
        const r = unchecked.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) return false;
      } catch (_e) {
        return false;
      }
    }
    return true;
  }

  async function waitForEnabledSubmitButton(maxMs = 25000) {
    const start = Date.now();
    let lastLog = 0;
    while (Date.now() - start < maxMs) {
      const btn = findSubmitButton(true);
      if (btn && isSubmitButtonReady(btn) && isRecaptchaWidgetReady()) return btn;
      try {
        const tok = window.__AmijobsRecaptchaToken || "";
        if (tok && typeof window.__AmijobsInjectRecaptchaToken === "function") {
          window.__AmijobsInjectRecaptchaToken(tok);
        }
      } catch (_e) {}
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        const btn = findSubmitButton(true);
        const state = btn
          ? `${(btn.textContent || "").trim().slice(0, 24)}${btn.disabled ? "[dis]" : ""}`
          : "aucun";
        S().log(PLATFORM, `Attente Déposer activé… (${state})`, "warn");
      }
      await S().sleep(700);
    }
    return null;
  }

  async function waitForSubmitButton(maxMs = 20000) {
    const start = Date.now();
    let lastLog = 0;
    while (Date.now() - start < maxMs) {
      const btn = findSubmitButton(true);
      if (btn) return btn;
      // Re-inject token — Indeed often mounts Déposer only after callback fires
      try {
        const tok = window.__AmijobsRecaptchaToken || "";
        if (tok && typeof window.__AmijobsInjectRecaptchaToken === "function") {
          window.__AmijobsInjectRecaptchaToken(tok);
        }
        if (typeof window.__AmijobsClickRecaptcha === "function") window.__AmijobsClickRecaptcha();
        else if (typeof window.__AmijobsSolveRecaptcha === "function") {
          /* keep solving path warm */
        }
      } catch (_e) {}
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        const sample = [...S().$$("button")]
          .filter((b) => isDisplayed(b))
          .map((b) => `${(b.textContent || "").trim().slice(0, 24)}${b.disabled ? "[dis]" : ""}`)
          .slice(0, 8)
          .join(" | ");
        S().log(PLATFORM, `Attente bouton Déposer… (${sample || "aucun"})`, "warn");
      }
      await S().sleep(700);
    }
    return null;
  }

  function findVisibleContinueOrSubmit() {
    // Prefer Indeed Smart Apply testids observed in live browser
    const submitEl = findSubmitButton(true);
    if (submitEl) return { el: submitEl, kind: "submit" };

    const testIds = [
      '[data-testid="continue-button"]',
      '[data-testid^="hp-continue-button"]',
      '[data-testid="resume-selection-continue-button"]',
    ];
    for (const sel of testIds) {
      for (const el of S().$$(sel)) {
        if (!S().isVisible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") continue;
        return { el, kind: "next" };
      }
    }

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
    for (const btn of buttons) {
      if (!S().isVisible(btn) || btn.disabled || btn.getAttribute("aria-disabled") === "true") continue;
      const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
      if (
        !text ||
        /signaler|fermer|close|exit|options de cv|passer au contenu|enregistrer et fermer|1 new update|quitter/i.test(
          text
        )
      ) {
        continue;
      }
      if (/continuer (pour |à )?postuler|continue (to )?apply/i.test(text)) continue;
      if (nextRe.some((p) => p.test(text))) return { el: btn, kind: "next" };
    }
    return null;
  }

  function forceEnableClickable(el) {
    if (!el) return;
    try {
      el.disabled = false;
      el.removeAttribute("disabled");
      el.removeAttribute("aria-disabled");
      el.setAttribute("aria-disabled", "false");
      if (el.style) el.style.pointerEvents = "auto";
    } catch (_e) {}
  }

  async function answerFromCvOrAi(label, fieldType, el) {
    const profile = await S().getProfile();
    const fromProfile = String(profile.experience || "").match(/(\d+(?:[.,]\d+)?)/);
    const isExp =
      /antiquit|anciennet[ée]|exp[eé]rience|seniority|années?|ans\b|years?\s*(of\s*)?exp|combien d['’]?ann|de combien/i.test(
        label
      ) || fieldType === "number";
    const forceNumber =
      fieldType === "number" ||
      (S().wantsNumericAnswer && S().wantsNumericAnswer(label, el)) ||
      /nombre|combien|années?|year|ans\b|de combien/i.test(label || "");
    // Credential yes/no from CV text first (before AI invents Oui)
    if (fieldType === "radio" || /avez-vous|dipl[oô]me|certificat|infirmier|titulaire/i.test(label || "")) {
      const yn = S().answerYesNoFromCv?.(label, profile.cvText || "", profile);
      if (yn) return yn;
    }
    if (isExp && fromProfile && Number(fromProfile[1]) > 0) {
      // Never return "1 an" — Indeed FR rejects non-numeric screening answers
      return forceNumber
        ? (S().coerceNumericAnswer ? S().coerceNumericAnswer(fromProfile[1], "3") : fromProfile[1].replace(/\D.*/, ""))
        : fromProfile[1];
    }
    try {
      const res = await chrome.runtime.sendMessage({
        action: "generateAnswer",
        question: label,
        fieldType: forceNumber ? "number" : fieldType || (el?.type === "number" ? "number" : "text"),
        options: [],
        jobInfo: { title: document.title || "", company: "" },
        cvText: profile.cvText || "",
      });
      let ans = String(res?.answer || "").trim();
      if (forceNumber && ans) {
        ans = S().coerceNumericAnswer ? S().coerceNumericAnswer(ans, "3") : (ans.match(/\d+/) || ["3"])[0];
      }
      if (ans && !/^(oui|yes|we|n\/?a|na|none|null)\.?$/i.test(ans)) return ans;
      if (isExp && fromProfile && Number(fromProfile[1]) > 0) {
        return S().coerceNumericAnswer ? S().coerceNumericAnswer(fromProfile[1], "3") : fromProfile[1];
      }
      if (isExp) return "3";
      // Don't default bare Oui on credential questions
      if (/avez-vous|dipl[oô]me|certificat|infirmier/i.test(label || "")) return "Non";
      return ans || "";
    } catch (_e) {
      if (/avez-vous|dipl[oô]me|certificat|infirmier/i.test(label || "")) return "Non";
      return isExp ? "3" : "";
    }
  }

  function isPlaceholderOptionText(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    return /sélectionn|selectionn|select(\s+an)?\s*option|choisir|veuillez|please select|^[-—–·•.\s]+$/i.test(t);
  }

  function selectLooksUnfilled(sel) {
    if (!sel?.options?.length) return true;
    const opt = sel.options[sel.selectedIndex];
    const text = (opt?.label || opt?.text || opt?.textContent || "").trim();
    const val = String(sel.value ?? "").trim();
    if (isPlaceholderOptionText(text)) return true;
    if (!val && sel.selectedIndex <= 0) return true;
    return false;
  }

  function fieldLabelFor(el) {
    if (!el) return "";
    const byFor =
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) || "";
    const wrap = el.closest("label")?.textContent || "";
    const aria = el.getAttribute("aria-label") || "";
    const block = el.closest(
      '[class*="question"], [data-testid*="question"], fieldset, .ia-Questions-item, [class*="Question"]'
    );
    // Prefer the visible question heading (Indeed screening modules)
    const heading =
      block?.querySelector?.("h1, h2, h3, legend, [data-testid*='label'], label")?.textContent || "";
    const named = block?.querySelector?.("label, legend, [id*='label'], span")?.textContent || "";
    const pageH1 = /questions|présélection|prescreen/i.test(document.title || "")
      ? S().$("h1, h2")?.textContent || ""
      : "";
    return (heading || byFor || wrap || aria || named || pageH1 || el.getAttribute("name") || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function questionHasNumericError(el) {
    const scope =
      el?.closest?.('[class*="question"], [data-testid*="question"], fieldset, [class*="FormField"], label') ||
      el?.parentElement;
    const text = `${scope?.innerText || ""} ${el?.validationMessage || ""}`;
    return /nombre valide|nombre entier|aucune décimale|doit être un nombre|numeric value|enter a number|decimal number|num[ée]ro d[ée]cimal/i.test(
      text
    );
  }

  async function fixNumericQuestionErrors() {
    let fixed = 0;
    for (const el of S().$$(
      "input[type='text'], input[type='number'], input[type='tel'], input:not([type]), textarea"
    )) {
      if (!S().isVisible(el)) continue;
      const label = fieldLabelFor(el);
      const badVal = String(el.value || "").trim();
      const needsFix =
        questionHasNumericError(el) ||
        (S().wantsNumericAnswer?.(label, el) && badVal && !/^\d+(\.\d+)?$/.test(badVal)) ||
        (/\d+\s*ans?/i.test(badVal) &&
          /exp[eé]rience|année|year|combien|anciennet|antiquit/i.test(label));
      if (!needsFix) continue;
      const num =
        (S().coerceNumericAnswer && S().coerceNumericAnswer(badVal || (await S().getProfile()).experience || "3")) ||
        (badVal.match(/\d+/) || ["3"])[0];
      S().log(PLATFORM, `Correction nombre: "${badVal}" → "${num}" (${label.slice(0, 40)})`, "warn");
      try {
        el.focus();
        S().setNativeValue(el, "");
        await S().humanType(el, String(num));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        fixed++;
      } catch (_e) {
        S().setNativeValue(el, String(num));
        fixed++;
      }
      await S().sleep(200);
    }
    return fixed;
  }

  function pickSelectOptionText(options, label, profile, preferredAnswer = "") {
    const opts = (options || []).map((o) => String(o || "").trim()).filter(Boolean);
    const real = opts.filter((o) => !isPlaceholderOptionText(o));
    if (!real.length) return opts[0] || "";
    const want = String(preferredAnswer || "").trim();
    const l = String(label || "").toLowerCase();
    const edu = String(profile?.education || want || "").toLowerCase();

    const tryMatch = (candidates) => {
      for (const c of candidates) {
        const hit = real.find((o) => o.toLowerCase() === c) || real.find((o) => o.toLowerCase().includes(c) || c.includes(o.toLowerCase()));
        if (hit) return hit;
      }
      return null;
    };

    if (want) {
      const exact = tryMatch([want.toLowerCase()]);
      if (exact) return exact;
    }

    // Education / diplôme / niveau d'études — prefer Bac+5 / Master
    if (/niveau|[ée]tudes|dipl[oô]me|education|degree|formation|scolaire/i.test(l) || /bac\+|master|licence|dipl[oô]me/i.test(edu)) {
      const prefs = [];
      if (/doctorat|phd/i.test(edu)) prefs.push("doctorat", "phd", "bac+8");
      if (/bac\s*\+?\s*5|master|ingénieur|ingenieur|mba/i.test(edu)) prefs.push("bac +5", "bac+5", "master", "ingénieur", "ingenieur");
      if (/bac\s*\+?\s*4|maîtrise|maitrise/i.test(edu)) prefs.push("bac +4", "bac+4", "maîtrise", "maitrise");
      if (/bac\s*\+?\s*3|licence|bachelor/i.test(edu)) prefs.push("bac +3", "bac+3", "licence", "bachelor");
      if (/bac\s*\+?\s*2|bts|dut|deug/i.test(edu)) prefs.push("bac +2", "bac+2", "bts", "dut");
      if (/bac(?!\s*\+)/i.test(edu)) prefs.push("baccalauréat", "baccalaureat", "bac");
      if (!prefs.length) prefs.push("bac +5", "bac+5", "master", "bac +4", "bac +3", "licence", "bac +2");
      const eduHit = tryMatch(prefs);
      if (eduHit) return eduHit;
      // Prefer highest common degree among options
      const rank = (o) => {
        const t = o.toLowerCase();
        if (/doctorat|phd|bac\s*\+?\s*8/.test(t)) return 80;
        if (/bac\s*\+?\s*5|master|ingénieur|ingenieur|mba/.test(t)) return 50;
        if (/bac\s*\+?\s*4|maîtrise|maitrise/.test(t)) return 40;
        if (/bac\s*\+?\s*3|licence|bachelor/.test(t)) return 30;
        if (/bac\s*\+?\s*2|bts|dut/.test(t)) return 20;
        if (/baccalauréat|baccalaureat|\bbac\b/.test(t)) return 10;
        return 0;
      };
      const ranked = [...real].sort((a, b) => rank(b) - rank(a));
      if (rank(ranked[0]) > 0) return ranked[0];
    }

    if (/antiquit|anciennet|exp[eé]rience|années|seniority|ans\b/i.test(l) && want) {
      const n = want.match(/(\d+)/)?.[1];
      if (n) {
        const hit =
          real.find((o) => new RegExp(`\\b${n}\\b`).test(o)) ||
          real.find((o) => o.includes(n));
        if (hit) return hit;
      }
    }

    return real[0];
  }

  function applyNativeSelectValue(sel, optionText) {
    if (!sel || !optionText) return false;
    const opt = [...sel.options].find((o) => (o.text || o.label || "").trim() === optionText);
    if (!opt) return false;
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
      if (desc?.set) desc.set.call(sel, opt.value);
      else sel.value = opt.value;
    } catch (_e) {
      sel.value = opt.value;
    }
    opt.selected = true;
    sel.selectedIndex = opt.index;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return !selectLooksUnfilled(sel);
  }

  async function fillComboboxTriggers(profile) {
    const triggers = S().$$(
      'button[role="combobox"], [role="combobox"]:not(select), [aria-haspopup="listbox"]'
    );
    for (const trigger of triggers) {
      if (!S().isVisible(trigger)) continue;
      const current = (trigger.textContent || trigger.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      if (current && !isPlaceholderOptionText(current) && trigger.getAttribute("aria-expanded") !== "true") {
        // Already shows a real value
        if (!/sélectionn|select an option|choisir/i.test(current)) continue;
      }
      const label = fieldLabelFor(trigger) || current;
      await S().humanClick(trigger);
      await S().sleep(350);
      let listbox =
        document.querySelector(`[role="listbox"][id="${trigger.getAttribute("aria-controls") || ""}"]`) ||
        document.querySelector('[role="listbox"]');
      for (let wait = 0; wait < 8 && !listbox; wait++) {
        await S().sleep(120);
        listbox = document.querySelector('[role="listbox"]');
      }
      const optionEls = listbox
        ? [...listbox.querySelectorAll('[role="option"], li, [data-value]')]
        : [...document.querySelectorAll('[role="option"]')].filter(S().isVisible);
      const optionTexts = optionEls.map((o) => (o.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
      let preferred = "";
      if (/niveau|[ée]tudes|dipl[oô]me|education|degree/i.test(label)) {
        preferred = profile.education || "Bac+5";
      } else if (/antiquit|anciennet|exp[eé]rience|années|seniority/i.test(label)) {
        preferred = await answerFromCvOrAi(label, "select", trigger);
      } else {
        preferred = (await answerFromCvOrAi(label, "select", trigger)) || "";
      }
      const picked = pickSelectOptionText(optionTexts, label, profile, preferred);
      const target =
        optionEls.find((o) => (o.textContent || "").replace(/\s+/g, " ").trim() === picked) ||
        optionEls.find((o) => !isPlaceholderOptionText((o.textContent || "").trim()));
      if (target) {
        await S().humanClick(target);
        S().log(PLATFORM, `Liste: "${label.slice(0, 48)}" → ${picked}`, "info");
      } else {
        // Escape closed empty list
        try {
          trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        } catch (_e) {}
      }
      await S().sleep(180);
    }
  }

  function hasUnfilledRequiredQuestions() {
    for (const sel of S().$$("select")) {
      if (selectLooksUnfilled(sel)) {
        const req =
          sel.required ||
          sel.getAttribute("aria-required") === "true" ||
          /\*/.test(fieldLabelFor(sel)) ||
          !!sel.closest('[class*="error"], [aria-invalid="true"]') ||
          /sélectionn/i.test(
            sel.closest('[class*="question"], fieldset, .ia-Questions-item')?.textContent || ""
          );
        if (req || selectLooksUnfilled(sel)) return true;
      }
    }
    for (const trigger of S().$$('button[role="combobox"], [role="combobox"]:not(select)')) {
      if (!S().isVisible(trigger)) continue;
      const t = (trigger.textContent || "").replace(/\s+/g, " ").trim();
      if (isPlaceholderOptionText(t) || /sélectionn|select an option/i.test(t)) return true;
    }
    // Visible validation errors (incl. numeric screening)
    const err = [...document.querySelectorAll('[class*="error"], [role="alert"], [aria-invalid="true"]')].some(
      (el) =>
        S().isVisible(el) &&
        /sélectionn|select|obligatoire|required|continuer|nombre valide|nombre entier|aucune décimale|doit être un nombre|numeric/i.test(
          el.textContent || ""
        )
    );
    if (err) return true;
    for (const el of S().$$("input[type='text'], input[type='number'], input:not([type])")) {
      if (!S().isVisible(el)) continue;
      if (questionHasNumericError(el)) return true;
      const v = String(el.value || "").trim();
      if (/\d+\s*ans?/i.test(v) && /exp[eé]rience|année|combien/i.test(fieldLabelFor(el))) return true;
    }
    return false;
  }

  async function fillQuestionsStep() {
    const profile = await S().getProfile();

    // Radios: CV-aware Oui/Non — never invent diplômes (e.g. infirmier)
    const radioNames = new Set();
    const cvText = profile.cvText || "";
    for (const radio of S().$$('input[type="radio"]')) {
      if (!S().isVisible(radio) || !radio.name || radioNames.has(radio.name)) continue;
      radioNames.add(radio.name);
      const group = S().$$(`input[type="radio"][name="${CSS.escape(radio.name)}"]`).filter((r) =>
        S().isVisible(r)
      );
      if (!group.length || group.some((r) => r.checked)) continue;
      const qText =
        fieldLabelFor(radio) ||
        radio.closest('[class*="question"], [data-testid*="question"], fieldset, .ia-Questions-item')
          ?.innerText ||
        "";
      const yn =
        (S().answerYesNoFromCv && S().answerYesNoFromCv(qText, cvText, profile)) ||
        (await answerFromCvOrAi(qText, "radio", radio));
      const wantOui = /^(oui|yes|true|1)$/i.test(String(yn || "").trim());
      const wantNon = /^(non|no|false|0)$/i.test(String(yn || "").trim());
      const labelOf = (r) =>
        `${r.value || ""} ${r.id || ""} ${document.querySelector(`label[for="${r.id}"]`)?.textContent || ""} ${r.closest("label")?.textContent || ""}`;
      let preferred = null;
      if (wantNon) {
        preferred =
          group.find((r) => /non|no|false|0/i.test(labelOf(r))) ||
          group.find((r) => !/oui|yes|true/i.test(labelOf(r)));
      } else if (wantOui) {
        preferred = group.find((r) => /oui|yes|true|1/i.test(labelOf(r)));
      }
      // Soft questions (disponibilité) → Oui; credential unknown → Non
      if (!preferred) {
        const isCred = /dipl[oô]me|certificat|infirmier|permis|habilitation|titulaire|avez-vous/i.test(qText);
        preferred = isCred
          ? group.find((r) => /non|no/i.test(labelOf(r))) || group[group.length - 1]
          : group.find((r) => /oui|yes|disponible/i.test(labelOf(r))) || group[0];
      }
      S().log(
        PLATFORM,
        `Radio: "${String(qText).slice(0, 50)}" → ${wantNon ? "Non" : wantOui ? "Oui" : preferred?.value || "?"}`,
        "info"
      );
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

    // Native <select> — also fill visually-hidden selects (Indeed custom UI often keeps them in DOM)
    for (const sel of S().$$("select")) {
      if (!selectLooksUnfilled(sel)) continue;
      // Skip truly detached / display:none without a sibling combobox UI
      const style = window.getComputedStyle(sel);
      const hiddenHard = style.display === "none" && !sel.closest('[class*="question"], form, [role="form"]');
      if (hiddenHard) continue;
      const label = fieldLabelFor(sel);
      const options = [...sel.options].map((o) => (o.text || o.label || "").trim()).filter(Boolean);
      let preferred = "";
      if (/niveau|[ée]tudes|dipl[oô]me|education|degree|formation/i.test(label)) {
        preferred = profile.education || "Bac+5";
      } else if (/antiquit|anciennet|exp[eé]rience|années|seniority/i.test(label)) {
        preferred = await answerFromCvOrAi(label, "select", sel);
      } else {
        preferred = (await answerFromCvOrAi(label || "question", "select", sel)) || "";
      }
      const picked = pickSelectOptionText(options, label, profile, preferred);
      if (picked && applyNativeSelectValue(sel, picked)) {
        S().log(PLATFORM, `Select: "${label.slice(0, 48)}" → ${picked}`, "info");
      } else if (picked) {
        // Retry via selectedIndex
        const idx = options.findIndex((o) => o === picked);
        if (idx >= 0) {
          sel.selectedIndex = idx;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          S().log(PLATFORM, `Select(idx): "${label.slice(0, 48)}" → ${picked}`, "info");
        }
      }
      await S().sleep(100);
    }

    // Custom listbox / combobox (Indeed Smart Apply design system)
    await fillComboboxTriggers(profile);

    // Text / number / date / textarea — use CV/AI for experience / antiquity
    for (const el of S().$$(
      "textarea, input[type='text'], input[type='number'], input[type='date'], input[type='tel'], input:not([type])"
    )) {
      if (!S().isVisible(el)) continue;
      const curVal = String(el.value || "").trim();
      const labelRaw = fieldLabelFor(el) || el.getAttribute("placeholder") || el.id || "";
      const label = labelRaw.toLowerCase();
      const hint = `${label} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
      const numericQ =
        el.type === "number" ||
        S().wantsNumericAnswer?.(labelRaw, el) ||
        questionHasNumericError(el) ||
        /de combien|combien d['’]?ann|années?\s*d['’]?exp|years?\s*(of\s*)?exp/i.test(label);
      // Re-fill when value is invalid prose like "1 an"
      if (curVal && !(numericQ && (!/^\d+(\.\d+)?$/.test(curVal) || questionHasNumericError(el)))) {
        continue;
      }
      if (numericQ && curVal) {
        S().setNativeValue(el, "");
      }

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
        numericQ ||
        /antiquit|anciennet[ée]|exp[eé]rience|seniority|année|year|ans\b|poste|previous|précédent/i.test(label)
      ) {
        let answer = await answerFromCvOrAi(labelRaw || "années d'expérience", "number", el);
        answer = S().coerceNumericAnswer ? S().coerceNumericAnswer(answer, "3") : (String(answer).match(/\d+/) || ["3"])[0];
        await S().humanType(el, answer);
        S().log(PLATFORM, `Expérience (nombre): ${answer}`, "info");
      } else if (/salaire|salary|prétention|compensation/i.test(label)) {
        const sal = S().coerceNumericAnswer
          ? S().coerceNumericAnswer(profile.salaryExpectation || "45000", "45000")
          : String(profile.salaryExpectation || "45000").replace(/\D/g, "") || "45000";
        await S().humanType(el, sal);
      } else if (/phone|téléphone|tel/i.test(label)) {
        await S().humanType(el, profile.phone || "0612345678");
      } else {
        const ai = await answerFromCvOrAi(labelRaw || "question candidature", "text", el);
        await S().humanType(el, ai && !/^(we)\.?$/i.test(ai) ? ai : "Oui");
      }
      await S().sleep(120);
    }
    await fixNumericQuestionErrors();
  }

  function recaptchaExpiredUi() {
    if (typeof window.__AmijobsRecaptchaExpired === "function") {
      try {
        return !!window.__AmijobsRecaptchaExpired();
      } catch (_e) {}
    }
    const t = document.body?.innerText || "";
    return /test de validation a expir[ée]|validation a expir[ée]|expir[ée].*case|verification expired/i.test(t);
  }

  function hasFreshRecaptchaToken() {
    if (recaptchaExpiredUi()) return false;
    if (typeof window.__AmijobsHasFreshRecaptchaToken === "function") {
      try {
        return !!window.__AmijobsHasFreshRecaptchaToken();
      } catch (_e) {}
    }
    const token = String(
      window.__AmijobsRecaptchaToken ||
        document.querySelector('textarea[name="g-recaptcha-response"]')?.value ||
        ""
    );
    return token.length > 40;
  }

  async function waitAndSolveRecaptcha(maxMs = 240000) {
    const start = Date.now();
    const hasWidget = () =>
      !!document.querySelector(
        'iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey], textarea[name="g-recaptcha-response"]'
      ) || /je ne suis pas un robot|i'?m not a robot|test de validation/i.test(document.body?.innerText || "");

    if (!hasWidget()) return true;

    // Stale / expired token from an earlier wizard step → discard and re-solve
    if (recaptchaExpiredUi() || !hasFreshRecaptchaToken()) {
      try {
        if (typeof window.__AmijobsClearRecaptcha === "function") {
          window.__AmijobsClearRecaptcha(recaptchaExpiredUi() ? "expired_ui" : "stale");
        }
      } catch (_e) {}
    } else {
      // Fresh token already present — re-patch MAIN world and submit ASAP
      try {
        const tok = window.__AmijobsRecaptchaToken || "";
        if (tok && typeof window.__AmijobsInjectRecaptchaToken === "function") {
          window.__AmijobsInjectRecaptchaToken(tok);
        }
      } catch (_e) {}
      if (!window.__AmijobsRecaptchaFreshLogged) {
        window.__AmijobsRecaptchaFreshLogged = true;
        S().log(PLATFORM, "reCAPTCHA token frais — dépôt candidature", "success");
      }
      return true;
    }

    S().log(PLATFORM, "reCAPTCHA détecté — résolution 2captcha (frais)…", "warn");
    let loggedOk = false;
    let tick = 0;
    while (Date.now() - start < maxMs) {
      if (shouldStop) return false;
      if (recaptchaExpiredUi()) {
        try {
          if (typeof window.__AmijobsClearRecaptcha === "function") window.__AmijobsClearRecaptcha("expired_loop");
        } catch (_e) {}
        S().log(PLATFORM, "reCAPTCHA expiré — nouveau solve 2captcha…", "warn");
      }
      if (hasFreshRecaptchaToken()) {
        try {
          const tok = window.__AmijobsRecaptchaToken || "";
          if (tok && typeof window.__AmijobsInjectRecaptchaToken === "function") {
            window.__AmijobsInjectRecaptchaToken(tok);
          }
        } catch (_e) {}
        if (!loggedOk) {
          S().log(PLATFORM, "reCAPTCHA token présent — dépôt candidature", "success");
          loggedOk = true;
        }
        return true;
      }
      // Keep wizard busy + lock fresh during long 2captcha polls (often 2–5 min)
      if (tick % 4 === 0) {
        try {
          await chrome.storage.local.set({
            indeedWizardBusy: {
              at: Date.now(),
              path: smartApplyPath(),
              title: window.__AmijobsCurrentJobTitle || "",
            },
          });
          await chrome.runtime.sendMessage({
            action: "acquireSmartApplyLock",
            owner: "indeed",
            handoff: !!window.__AmijobsWizardIsHandoff,
          });
        } catch (_e) {}
      }
      tick += 1;
      try {
        // Never click the checkbox after/during inject — it resets Indeed's widget to "expiré"
        if (typeof window.__AmijobsSolveRecaptcha === "function") {
          const ok = await window.__AmijobsSolveRecaptcha(true);
          if (!ok) S().log(PLATFORM, "2captcha en cours / échec partiel…", "warn");
        } else {
          await chrome.runtime.sendMessage({ action: "solveRecaptchaNow" }).catch(() => {});
        }
      } catch (_e) {}
      await S().sleep(2500);
    }
    S().log(PLATFORM, "reCAPTCHA non résolu à temps", "warn");
    return hasFreshRecaptchaToken();
  }

  async function runApplyWizard(jobInfo, settings) {
    if (!isTopAutomationFrame()) {
      return { success: false, reason: "iframe_skip" };
    }
    if (isLoginWallPage()) {
      S().log(PLATFORM, "Indeed demande une reconnexion — offre abandonnée", "error");
      await chrome.runtime
        .sendMessage({ action: "indeedLoginWall", url: window.location.href })
        .catch(() => {});
      return { success: false, reason: "login_wall" };
    }
    if (!isSmartApplyPage()) {
      S().log(PLATFORM, "Wizard ignoré (pas une page Smart Apply)", "warn");
      return { success: false, reason: "not_smartapply" };
    }
    S().log(PLATFORM, `Assistant Smart Apply — ${smartApplyPath()}`);
    window.__AmijobsCvCdpTries = 0;
    window.__AmijobsCurrentJobTitle = jobInfo?.title || "";
    try {
      const { sessionIndeed: sOwner = null, sessionGlassdoor: sGd = null } =
        await chrome.storage.local.get(["sessionIndeed", "sessionGlassdoor"]);
      // Dual mode: Indeed's own session stays active, so fromGlassdoor is often false —
      // still treat Glassdoor awaitingIndeed as a handoff for lock heartbeats.
      window.__AmijobsWizardIsHandoff = !!(sOwner?.fromGlassdoor || sGd?.awaitingIndeed);
    } catch (_e) {
      window.__AmijobsWizardIsHandoff = false;
    }
    try {
      await chrome.storage.local.set({
        indeedWizardBusy: { at: Date.now(), path: smartApplyPath(), title: jobInfo?.title || "" },
      });
    } catch (_e) {}
    let resumeContinueClicks = 0;
    let resumeUploadAttempts = 0;
    let incompleteQuestionsTries = 0;
    let reviewCaptchaAttempts = 0;
    const MAX_REVIEW_CAPTCHA = 4;
    try {
    for (let step = 0; step < 80; step++) {
      if (shouldStop) return { success: false, reason: "stopped" };
      if (/hrtechprivacy\.com|privacy opt out|requests\.hrtechprivacy/i.test(location.href)) {
        S().log(PLATFORM, "Redirection privacy Indeed — retour Smart Apply", "warn");
        try {
          history.back();
        } catch (_e) {}
        await S().sleep(1200);
        continue;
      }
      if (detectApplySuccess()) return { success: true };

      // Keep busy flag + Smart Apply lock fresh so Glassdoor doesn't steal mid-wizard
      if (step % 5 === 0) {
        try {
          await chrome.storage.local.set({
            indeedWizardBusy: { at: Date.now(), path: smartApplyPath(), title: jobInfo?.title || "" },
          });
          await chrome.runtime.sendMessage({
            action: "acquireSmartApplyLock",
            owner: "indeed",
            handoff: !!window.__AmijobsWizardIsHandoff,
          });
        } catch (_e) {}
      }

      // reCAPTCHA only on review — don't burn 2captcha on every wizard step
      try {
        if (typeof window.__AmijobsClickTurnstile === "function") window.__AmijobsClickTurnstile();
        if (typeof window.__AmijobsSolveTurnstile === "function") window.__AmijobsSolveTurnstile();
      } catch (_e) {}

      const path = smartApplyPath();
      // Do NOT click / pre-solve reCAPTCHA here — early tokens expire before submit
      // ("Le test de validation a expiré"). waitAndSolveRecaptcha handles it below.
      // Wait for SPA loaders / empty chrome shell (only "Enregistrer et fermer" + "1 new update")
      if (isSmartApplyLoading()) {
        window.__AmijobsShellWait = (window.__AmijobsShellWait || 0) + 1;
        if (window.__AmijobsShellWait % 3 === 1) {
          S().log(
            PLATFORM,
            `Chargement Smart Apply… (${path.split("/").pop() || path}, wait=${window.__AmijobsShellWait})`,
            "warn"
          );
        }
        if (window.__AmijobsShellWait > 45) {
          S().log(PLATFORM, "Smart Apply shell vide trop longtemps — abandon offre", "error");
          return { success: false, reason: "wizard_shell_timeout" };
        }
        await S().sleep(1400);
        continue;
      }
      window.__AmijobsShellWait = 0;
      const loader = S().$('[data-testid="loading-indicator"], [class*="LoadingSpinner"], [aria-busy="true"]');
      if (loader && S().isVisible(loader)) {
        await S().sleep(1800);
        continue;
      }

      if (/profile-location/i.test(path)) {
        await fillProfileLocationStep();
      }
      if (/resume-selection/i.test(path)) {
        const cvMeta = await S().getCvFile();
        if (cvMeta?.name) window.__AmijobsResumeFileName = cvMeta.name;
        const ready = await clickResumeIfNeeded();
        if (!ready || !resumeFileUiAccepted(cvMeta?.name || "")) {
          if (!cvMeta?.base64) {
            S().log(PLATFORM, "Skip — aucun CV fichier dans Options (Indeed CV indisponible)", "error");
            return { success: false, reason: "no_cv_file" };
          }
          resumeUploadAttempts += 1;
          if (resumeUploadAttempts > 10) {
            S().log(PLATFORM, "Upload CV impossible après plusieurs essais — abandon offre", "error");
            return { success: false, reason: "resume_upload_failed" };
          }
          // Don't spam Continuer — Indeed shows "Sélectionnez un fichier pour continuer"
          S().log(PLATFORM, `Attente upload CV (essai ${resumeUploadAttempts}) — pas de Continuer`, "warn");
          await uploadCvFallback();
          await S().sleep(1500);
          continue;
        }
        // Indeed FR continue after picking/uploading resume — only if UI shows filename
        if (resumeUploadErrorVisible() || !resumeFileUiAccepted(cvMeta?.name || "")) {
          S().log(PLATFORM, "CV pas encore accepté par Indeed — skip Continuer", "warn");
          await S().sleep(1000);
          continue;
        }
        const cont =
          S().$('[data-testid="resume-selection-continue-button"]') ||
          S().$('[data-testid="continue-button"]') ||
          [...S().$$("button")].find((b) => /^continuer$/i.test((b.textContent || "").trim()));
        if (cont && S().isVisible(cont) && !cont.disabled) {
          if (resumeContinueClicks >= 6) {
            S().log(PLATFORM, "Resume-selection bloqué après plusieurs Continuer — abandon offre", "error");
            return { success: false, reason: "resume_stuck" };
          }
          resumeContinueClicks += 1;
          const before = smartApplyPath();
          S().log(PLATFORM, `Clic Continuer (CV) #${resumeContinueClicks}`);
          await S().humanClick(cont);
          await S().sleep(2200);
          // If validation error / still on same step, force re-upload next loop
          if (/resume-selection/i.test(smartApplyPath())) {
            if (resumeUploadErrorVisible() || !resumeFileUiAccepted(cvMeta?.name || "")) {
              S().log(PLATFORM, "Toujours sur CV après Continuer — re-upload CDP", "warn");
              window.__AmijobsResumeUploadedAt = 0;
              await uploadCvFallback();
            } else if (smartApplyPath() === before) {
              // Filename visible but step stuck — click Continuer again, do NOT re-download CV
              S().log(PLATFORM, "CV accepté mais étape inchangée — nouvel essai Continuer (sans re-upload)", "warn");
            }
          } else {
            resumeContinueClicks = 0;
            resumeUploadAttempts = 0;
            window.__AmijobsCvCdpTries = 0;
          }
          continue;
        }
      } else {
        resumeContinueClicks = 0;
      }
      if (/relevant-experience/i.test(path)) {
        await fillRelevantExperienceStep();
      }
      if (/questions/i.test(path)) {
        await fillQuestionsStep();
        if (hasUnfilledRequiredQuestions()) {
          incompleteQuestionsTries += 1;
          S().log(PLATFORM, "Questions incomplètes — correction (nombre/select)", "warn");
          await fixNumericQuestionErrors();
          await fillQuestionsStep();
          await S().sleep(700);
          if (hasUnfilledRequiredQuestions()) {
            await fixNumericQuestionErrors();
            await S().sleep(900);
            if (incompleteQuestionsTries >= 8) {
              S().log(
                PLATFORM,
                "Questions bloquées après plusieurs essais — offre ignorée",
                "error"
              );
              return { success: false, reason: "questions_stuck" };
            }
            continue;
          }
        } else {
          incompleteQuestionsTries = 0;
        }
        const qContinue = findVisibleContinueOrSubmit();
        if (qContinue?.kind === "next" && !qContinue.el.disabled) {
          await S().humanClick(qContinue.el);
          await S().sleep(
            S().randomDelay(settings.delayBetweenSteps?.min || 500, settings.delayBetweenSteps?.max || 1400)
          );
          continue;
        }
      } else {
        await S().fillVisibleFields(jobInfo, PLATFORM);
        await fixNumericQuestionErrors();
      }

      // Review / captcha step: solve FRESH then force-submit (button often stays aria-disabled)
      const onReviewLike =
        /review/i.test(path) ||
        (!!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, textarea[name="g-recaptcha-response"]') &&
          !!findSubmitButton(true));
      if (onReviewLike) {
        window.__AmijobsReviewMisses = window.__AmijobsReviewMisses || 0;
        if (reviewCaptchaAttempts >= MAX_REVIEW_CAPTCHA) {
          S().log(PLATFORM, "reCAPTCHA review bloqué — abandon offre", "error");
          return { success: false, reason: "captcha_stuck" };
        }
        for (let captchaTry = 0; captchaTry < 3; captchaTry++) {
          const ok = await waitAndSolveRecaptcha(150000);
          if (!ok) break;
          reviewCaptchaAttempts += 1;
          // Wait for Indeed to enable Déposer — do not force-click a disabled button
          let submitBtn = (await waitForEnabledSubmitButton(22000)) || findSubmitButton(true);
          if (!submitBtn || !isSubmitButtonReady(submitBtn) || !isRecaptchaWidgetReady()) {
            submitBtn = await waitForEnabledSubmitButton(12000);
          }
          if (!submitBtn || settings.autoSubmit === false) {
            if (!submitBtn) {
              window.__AmijobsReviewMisses += 1;
              S().log(
                PLATFORM,
                `Bouton Déposer introuvable (path=${smartApplyPath()}, miss=${window.__AmijobsReviewMisses}) — boutons: ${[
                  ...S().$$("button"),
                ]
                  .filter((b) => isDisplayed(b))
                  .map((b) => {
                    const t = (b.textContent || "").trim().slice(0, 28);
                    return `${t}${b.disabled || b.getAttribute("aria-disabled") === "true" ? "[dis]" : ""}`;
                  })
                  .slice(0, 8)
                  .join(" | ")}`,
                "warn"
              );
              if (window.__AmijobsReviewMisses >= 8) {
                S().log(PLATFORM, "Review sans Déposer après plusieurs essais — abandon offre", "error");
                return { success: false, reason: "submit_button_missing" };
              }
            }
            break;
          }
          window.__AmijobsReviewMisses = 0;
          try {
            const tok = window.__AmijobsRecaptchaToken || "";
            if (tok && typeof window.__AmijobsInjectRecaptchaToken === "function") {
              window.__AmijobsInjectRecaptchaToken(tok);
            }
          } catch (_e) {}
          // Re-check expiry right before click (token can die while waiting)
          if (recaptchaExpiredUi() || !hasFreshRecaptchaToken() || !isRecaptchaWidgetReady()) {
            S().log(PLATFORM, `reCAPTCHA pas prêt avant submit — retry ${captchaTry + 1}/3`, "warn");
            try {
              if (typeof window.__AmijobsClearRecaptcha === "function") window.__AmijobsClearRecaptcha("pre_submit");
            } catch (_e2) {}
            continue;
          }
          S().log(PLATFORM, `Clic submit: ${(submitBtn.textContent || "").trim().slice(0, 40)}`);
          try {
            submitBtn.scrollIntoView({ block: "center", inline: "nearest" });
          } catch (_e) {}
          await S().humanClick(submitBtn);
          try {
            submitBtn.click();
          } catch (_e) {}
          await S().sleep(2000);
          for (let i = 0; i < 12; i++) {
            if (detectApplySuccess() || /post-apply/i.test(smartApplyPath())) return { success: true };
            if (recaptchaExpiredUi()) {
              S().log(PLATFORM, "reCAPTCHA expiré après submit — nouveau token", "warn");
              try {
                if (typeof window.__AmijobsClearRecaptcha === "function") window.__AmijobsClearRecaptcha("post_submit");
              } catch (_e2) {}
              break;
            }
            await S().sleep(700);
          }
          if (detectApplySuccess() || /post-apply/i.test(smartApplyPath())) return { success: true };
          if (!recaptchaExpiredUi() && /review/i.test(smartApplyPath())) {
            // Still on review but not expired — don't loop forever
            break;
          }
        }
      }

      // Never advance resume-selection without a file/radio accepted
      if (/resume-selection/i.test(smartApplyPath()) && !resumeLooksReady()) {
        await clickResumeIfNeeded();
        await S().sleep(900);
        continue;
      }

      let action = findVisibleContinueOrSubmit();
      if (!action && onReviewLike) {
        const sb = findSubmitButton(true);
        if (sb) action = { el: sb, kind: "submit" };
      }
      if (!action) {
        if (onReviewLike) {
          await waitAndSolveRecaptcha(150000);
          const sb = (await waitForEnabledSubmitButton(12000)) || findSubmitButton(true);
          if (sb && isSubmitButtonReady(sb) && hasFreshRecaptchaToken() && isRecaptchaWidgetReady() && settings.autoSubmit !== false) {
            S().log(PLATFORM, `Clic submit (retry): ${(sb.textContent || "").trim().slice(0, 40)}`);
            await S().humanClick(sb);
            try {
              sb.click();
            } catch (_e) {}
            await S().sleep(2000);
            if (detectApplySuccess() || /post-apply/i.test(smartApplyPath())) return { success: true };
          }
          window.__AmijobsReviewMisses = (window.__AmijobsReviewMisses || 0) + 1;
          if (window.__AmijobsReviewMisses >= 8) {
            return { success: false, reason: "submit_button_missing" };
          }
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
        const captchaOk = await waitAndSolveRecaptcha(150000);
        if (!captchaOk) {
          S().log(PLATFORM, "Submit bloqué — captcha non résolu", "warn");
          await S().sleep(1500);
          continue;
        }
        if (recaptchaExpiredUi() || !hasFreshRecaptchaToken()) {
          S().log(PLATFORM, "Submit bloqué — captcha expiré, re-solve…", "warn");
          try {
            if (typeof window.__AmijobsClearRecaptcha === "function") window.__AmijobsClearRecaptcha("submit_gate");
          } catch (_e) {}
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
          if (!isSubmitButtonReady(action.el) || !isRecaptchaWidgetReady()) {
            await S().sleep(1200);
            continue;
          }
          S().log(PLATFORM, `Clic submit: ${(action.el.textContent || "").trim().slice(0, 40)}`);
          await S().humanClick(action.el);
          try {
            action.el.click();
          } catch (_e) {}
          await S().sleep(2800);
          for (let i = 0; i < 16; i++) {
            if (detectApplySuccess()) return { success: true };
            if (/post-apply/i.test(smartApplyPath())) return { success: true };
            // Captcha expired / cleared after failed submit — force fresh 2captcha
            if (
              document.querySelector('iframe[src*="recaptcha"]') &&
              /review/i.test(smartApplyPath()) &&
              (recaptchaExpiredUi() || !hasFreshRecaptchaToken())
            ) {
              try {
                if (typeof window.__AmijobsClearRecaptcha === "function") {
                  window.__AmijobsClearRecaptcha("post_submit_loop");
                }
              } catch (_e) {}
              await waitAndSolveRecaptcha(90000);
              const again = findVisibleContinueOrSubmit();
              if (again?.kind === "submit" && hasFreshRecaptchaToken() && !recaptchaExpiredUi()) {
                try {
                  const tok = window.__AmijobsRecaptchaToken || "";
                  if (tok && typeof window.__AmijobsInjectRecaptchaToken === "function") {
                    window.__AmijobsInjectRecaptchaToken(tok);
                  }
                } catch (_e) {}
                await S().humanClick(again.el);
              }
            }
            await S().sleep(700);
          }
          if (/post-apply/i.test(smartApplyPath())) return { success: true };
          // Still on review after clicks → don't fake success
          if (/review/i.test(smartApplyPath())) {
            reviewCaptchaAttempts += 1;
            if (reviewCaptchaAttempts >= MAX_REVIEW_CAPTCHA) {
              return { success: false, reason: "captcha_stuck" };
            }
            S().log(PLATFORM, "Submit review sans confirmation — nouvel essai captcha", "warn");
            try {
              if (typeof window.__AmijobsClearRecaptcha === "function") window.__AmijobsClearRecaptcha("no_confirm");
            } catch (_e) {}
            continue;
          }
          return { success: true, reason: "submitted" };
        }
        return { success: false, reason: "review" };
      }

      if (action.el.disabled || action.el.getAttribute("aria-disabled") === "true") {
        if (/questions/i.test(path)) await fillQuestionsStep();
        if (onReviewLike || action.kind === "submit") {
          await waitAndSolveRecaptcha(150000);
          if (hasFreshRecaptchaToken() && isRecaptchaWidgetReady() && isSubmitButtonReady(action.el) && action.kind === "submit" && settings.autoSubmit !== false) {
            S().log(PLATFORM, `Clic submit (unlock): ${(action.el.textContent || "").trim().slice(0, 40)}`);
            await S().humanClick(action.el);
            try {
              action.el.click();
            } catch (_e) {}
            await S().sleep(2000);
            if (detectApplySuccess() || /post-apply/i.test(smartApplyPath())) return { success: true };
          }
        }
        await S().sleep(800);
        continue;
      }

      // Never let generic Continuer fire on resume-selection without accepted CV
      if (/resume-selection/i.test(smartApplyPath()) && !resumeFileUiAccepted(window.__AmijobsResumeFileName || "")) {
        await uploadCvFallback();
        await S().sleep(1000);
        continue;
      }

      await S().humanClick(action.el);
      await S().sleep(
        S().randomDelay(settings.delayBetweenSteps?.min || 500, settings.delayBetweenSteps?.max || 1400)
      );
    }
    return { success: false, reason: "wizard_timeout" };
    } finally {
      try {
        await chrome.storage.local.set({ indeedWizardBusy: null });
      } catch (_e) {}
      // Always free Smart Apply mutex — Glassdoor handoffs own the lock as "glassdoor"
      try {
        const handoff = !!window.__AmijobsWizardIsHandoff;
        await chrome.runtime.sendMessage({
          action: "releaseSmartApplyLock",
          owner: handoff ? "glassdoor" : "indeed",
          fair: true,
        });
        if (handoff) {
          await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "indeed" });
        }
      } catch (_e) {}
    }
  }

  async function applyCurrentJob(settings, jobInfo) {
    const info = jobInfo || getJobInfoFromPage();

    if (isSmartApplyPage()) {
      return runApplyWizard(info, settings);
    }

    if (detectAlreadyAppliedUi()) {
      return { success: false, reason: "already_applied_ui" };
    }

    const btn = await waitForApplyButton();
    if (!btn) {
      if (detectAlreadyAppliedUi()) return { success: false, reason: "already_applied_ui" };
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

    const popupState = { opened: false };
    const popupPromise = new Promise((resolve) => {
      const onMsg = (msg) => {
        if (msg?.action === "indeedSmartApplyOpened") {
          chrome.runtime.onMessage.removeListener(onMsg);
          popupState.opened = true;
          resolve(true);
        }
      };
      chrome.runtime.onMessage.addListener(onMsg);
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(onMsg);
        resolve(popupState.opened);
      }, 14000);
    });

    // HAR: Postuler → apply.indeed.com buttonClick → smartapply applybyapplyablejobid
    const preHref =
      btn.getAttribute?.("href") ||
      btn.closest?.("a")?.href ||
      extractSmartApplyUrlFromDom();
    await S().humanClick(btn);
    await S().sleep(S().randomDelay(1200, 2200));

    if (detectAlreadyAppliedUi()) {
      return { success: false, reason: "already_applied_ui" };
    }
    if (detectApplySuccess()) {
      return { success: true };
    }
    if (isSmartApplyPage()) {
      return runApplyWizard(info, settings);
    }

    // Left Indeed entirely (external ATS) — hand off to company-site apply worker
    if (!/indeed\.(com|[a-z]{2})|smartapply/i.test(window.location.hostname)) {
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

    // Poll for same-tab Smart Apply OR popup tab (HAR opens smartapply after ~1–2s)
    for (let i = 0; i < 16; i++) {
      if (isSmartApplyPage()) return runApplyWizard(info, settings);
      if (detectApplySuccess()) return { success: true };
      if (popupState.opened) return { success: true, reason: "smartapply_tab" };
      const tabs = await chrome.runtime.sendMessage({ action: "listIndeedTabs" }).catch(() => null);
      if (tabs?.hasSmartApply || tabs?.hasApplyTab) {
        return { success: true, reason: "smartapply_tab" };
      }
      await S().sleep(500);
    }

    if (popupState.opened || (await popupPromise)) {
      return { success: true, reason: "smartapply_tab" };
    }

    // Fallback: navigate directly to applybyapplyablejobid (from env/DOM — HAR applyUrl)
    const href = preHref || extractSmartApplyUrlFromDom();
    if (href && /smartapply|applybyapplyablejobid|preloadresumeapply|indeedapply/i.test(href)) {
      S().log(PLATFORM, `Ouverture Smart Apply directe: ${href.slice(0, 90)}…`, "warn");
      try {
        await chrome.runtime.sendMessage({ action: "openIndeedSmartApply", url: href });
        return { success: true, reason: "smartapply_tab" };
      } catch (_e) {
        window.location.href = href;
        await S().sleep(2000);
        if (isSmartApplyPage()) return runApplyWizard(info, settings);
      }
    }

    // Never run a long empty wizard on the viewjob page
    return { success: false, reason: "no_smartapply_opened" };
  }

  function indeedAlertModalVisible() {
    for (const el of document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], [class*="Modal"], [class*="modal"], [data-testid*="Modal"]'
    )) {
      try {
        if (!S().isVisible(el)) continue;
        if (
          /Confiez-nous votre recherche|Enregistrer cette alerte|Créez une alerte pour recevoir|Découvrez en premier|create (a )?job alert/i.test(
            el.innerText || ""
          )
        ) {
          return true;
        }
      } catch (_e) {}
    }
    return false;
  }

  async function dismissIndeedPopups() {
    // Job alert / newsletter modals block SERP + Postuler ("Confiez-nous votre recherche")
    if (!indeedAlertModalVisible()) {
      // Still try generic close buttons (cookie / newsletter)
      for (const sel of [
        'button[aria-label="Close"]',
        'button[aria-label="Fermer"]',
        '[data-testid="modal-close-button"]',
        '.icl-Modal-close',
      ]) {
        const btn = S().$(sel);
        if (btn && S().isVisible(btn)) {
          await S().humanClick(btn);
          await S().sleep(300);
          return true;
        }
      }
      return false;
    }

    const findCloseIn = (root) => {
      if (!root) return null;
      const nodes = root.querySelectorAll?.(
        'button, [role="button"], a, [class*="close" i], [class*="Close"], [data-testid*="close" i], [aria-label*="close" i], [aria-label*="fermer" i]'
      );
      for (const b of nodes || []) {
        if (!S().isVisible(b)) continue;
        const t = (b.textContent || "").trim();
        const al = `${b.getAttribute("aria-label") || ""} ${b.getAttribute("data-testid") || ""} ${b.className || ""}`.toLowerCase();
        if (
          t === "×" ||
          t === "✕" ||
          t === "X" ||
          /^x$/i.test(t) ||
          /close|fermer|dismiss|icon-close|modal-close/i.test(al) ||
          (t.length === 0 && /close|fermer/i.test(al))
        ) {
          return b;
        }
      }
      // Indeed alert: first tiny icon button in dialog header is usually X
      const dialogBtns = [...(root.querySelectorAll?.("button") || [])].filter((b) => S().isVisible(b));
      const saveIdx = dialogBtns.findIndex((b) => /Enregistrer cette alerte|Save (this )?alert/i.test(b.textContent || ""));
      if (saveIdx > 0) {
        // Prefer a button that is NOT the save CTA — often the X is first
        const nonSave = dialogBtns.find((b) => !/Enregistrer|Save|modifier|Modify/i.test(b.textContent || ""));
        if (nonSave) return nonSave;
      }
      return dialogBtns.find((b) => ((b.textContent || "").trim().length || 0) <= 1) || null;
    };

    const dialogs = [
      ...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="Modal"], [class*="modal"], [data-testid*="Modal"]'),
    ];
    for (const dialog of dialogs.length ? dialogs : [document.body]) {
      const xBtn = findCloseIn(dialog);
      if (xBtn) {
        try {
          xBtn.click();
        } catch (_e) {
          await S().humanClick(xBtn);
        }
        await S().sleep(600);
        if (!indeedAlertModalVisible()) {
          S().log(PLATFORM, "Alerte emploi Indeed fermée", "warn");
          return true;
        }
      }
    }

    // Escape + click backdrop
    for (let i = 0; i < 3; i++) {
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", keyCode: 27, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
      } catch (_e) {}
      await S().sleep(350);
      if (!indeedAlertModalVisible()) {
        S().log(PLATFORM, "Alerte emploi Indeed fermée (Escape)", "warn");
        return true;
      }
    }

    // Last resort: remove alert modal + backdrop so Postuler is clickable
    for (const el of [
      ...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="Modal"], [class*="modal"]'),
    ]) {
      try {
        if (/Confiez-nous|Enregistrer cette alerte|Créez une alerte/i.test(el.innerText || "")) {
          el.remove();
        }
      } catch (_e) {
        try {
          el.style.setProperty("display", "none", "important");
          el.style.setProperty("pointer-events", "none", "important");
        } catch (_e2) {}
      }
    }
    for (const el of document.querySelectorAll(
      '[class*="overlay" i], [class*="Overlay"], [class*="backdrop" i], [class*="Backdrop"]'
    )) {
      try {
        if (S().isVisible(el)) {
          el.style.setProperty("pointer-events", "none", "important");
          el.style.setProperty("display", "none", "important");
        }
      } catch (_e) {}
    }
    await S().sleep(300);
    if (!indeedAlertModalVisible()) {
      S().log(PLATFORM, "Alerte emploi Indeed forcée (remove)", "warn");
      return true;
    }
    S().log(PLATFORM, "Alerte emploi Indeed toujours visible", "warn");
    return false;
  }

  async function handleSearchPage(session, settings) {
    session = (await syncSerpPageFromLocation(session)) || session;
    const maxJobs = session.maxJobs || settings.maxJobsPerSession || 25;

    await dismissIndeedPopups();

    // Force Easy Apply / candidature simplifiée only
    if (await ensureEasyApplyOnlyFilter()) {
      return;
    }

    // Defer NEW Indeed apply while ANY Smart Apply tab/wizard is open (hard 1-slot rule)
    let deferNewApply = false;
    try {
      const { indeedWizardBusy = null } = await chrome.storage.local.get(["indeedWizardBusy"]);
      const busyAge = indeedWizardBusy?.at ? Date.now() - indeedWizardBusy.at : 999999;
      const tabs = await chrome.runtime.sendMessage({ action: "listIndeedTabs" }).catch(() => null);
      const hasSmart =
        tabs?.hasSmartApply ||
        tabs?.hasApplyTab ||
        /smartapply|indeedapply/i.test(location.href);
      if (busyAge < 180000 && !hasSmart && isSearchPage()) {
        await chrome.storage.local.set({ indeedWizardBusy: null });
      } else if (hasSmart && isSearchPage()) {
        deferNewApply = true;
        try {
          await chrome.runtime.sendMessage({ action: "nudgeIndeedSmartApply" });
          await chrome.runtime.sendMessage({
            action: "enforceOneTabPerPlatform",
            reason: "indeed serp defer",
          });
        } catch (_e) {}
      }
    } catch (_e) {}

    // While Glassdoor owns the live wizard, Indeed browses but does not Postuler
    const {
      sessionGlassdoor = null,
      glassdoorSmartApply = null,
      amijobsSmartApplyPrefer = null,
      amijobsSmartApplyLock = null,
    } = await chrome.storage.local.get([
      "sessionGlassdoor",
      "glassdoorSmartApply",
      "amijobsSmartApplyPrefer",
      "amijobsSmartApplyLock",
    ]);
    // Fairness: after Glassdoor is preferred, don't steal the Smart Apply slot
    const preferGd =
      amijobsSmartApplyPrefer?.owner === "glassdoor" &&
      Date.now() - (amijobsSmartApplyPrefer.at || 0) < 40000 &&
      !!sessionGlassdoor?.active &&
      (sessionGlassdoor.applied || 0) < (sessionGlassdoor.maxJobs || 25);
    const lockHeldByOther =
      amijobsSmartApplyLock?.owner &&
      amijobsSmartApplyLock.owner !== "indeed" &&
      Date.now() - (amijobsSmartApplyLock.at || 0) < 180000;
    if ((preferGd || lockHeldByOther) && isSearchPage()) {
      deferNewApply = true;
    }
    const gdAwaiting = !!(sessionGlassdoor?.active && sessionGlassdoor?.awaitingIndeed);
    const gdSmartAge = glassdoorSmartApply ? Date.now() - (glassdoorSmartApply.at || 0) : 999999;
    const gdAwaitAge = gdAwaiting
      ? Date.now() - (sessionGlassdoor.lastRunAt || Date.parse(sessionGlassdoor.startedAt) || Date.now())
      : 999999;
    if (gdAwaiting && gdAwaitAge > 240000) {
      S().log(PLATFORM, "Libération handoff Glassdoor expiré — reprise file Indeed", "warn");
      await chrome.storage.local.set({
        sessionGlassdoor: { ...sessionGlassdoor, awaitingIndeed: false, indeedHandoffDone: false },
      });
    } else if (gdAwaiting || gdSmartAge < 120000) {
      const tabs = await chrome.runtime.sendMessage({ action: "listIndeedTabs" }).catch(() => null);
      const hasSmart =
        tabs?.hasSmartApply ||
        tabs?.hasApplyTab ||
        /smartapply|indeedapply|\/viewjob|\/rc\/clk/i.test(location.href);
      if (hasSmart || /smartapply|indeedapply/i.test(location.href)) {
        deferNewApply = true;
      }
      // Do NOT clear Glassdoor awaitingIndeed from Indeed — that aborts live handoffs.
      // Glassdoor owns stale cleanup (60s / 240s).
    }

    if (deferNewApply && isSearchPage()) {
      // Keep Indeed visibly busy: drain handled queue items, prepare cards
      let q = session.queue || [];
      let qi = session.qIndex || 0;
      let advanced = 0;
      const live =
        (await chrome.runtime.sendMessage({ action: "getState" }).catch(() => null)) || {};
      const appliedMap = live.appliedJobs || {};
      const skippedMap = live.skippedJobs || {};
      while (qi < q.length && advanced < 8) {
        const it = q[qi];
        const id = it?.jobId;
        if (id && (appliedMap[id] || skippedMap[id] || (await alreadyHandled(id)))) {
          qi += 1;
          advanced += 1;
          continue;
        }
        break;
      }
      if (advanced) await setSession({ qIndex: qi });
      if (!q.length) {
        const cards = await waitForJobCards(8000).catch(() => []);
        if (cards?.length) {
          q = cards
            .filter((c) => isValidIndeedJobKey(c.jobId) && c.title && c.title.length >= 3)
            .map((c) => ({ jobId: c.jobId, title: c.title, company: c.company }));
          await setSession({ queue: q, qIndex: 0 });
          S().log(PLATFORM, `SERP Indeed prêt (${q.length} offres) — Smart Apply partagé en cours`, "warn");
        } else {
          S().log(PLATFORM, "SERP Indeed actif — attente fin Smart Apply (Glassdoor/Indeed)", "warn");
        }
      } else {
        S().log(
          PLATFORM,
          `SERP Indeed actif (${Math.max(0, q.length - qi)} en file) — attente tour Smart Apply`,
          "warn"
        );
      }
      // Yield longer when Glassdoor is preferred / owns the lock — feels more dual
      await S().sleep(preferGd || lockHeldByOther ? 2800 : 900);
      return;
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
    // Always re-read handled jobs (skips must stick across SERP reloads)
    let liveState = (await chrome.runtime.sendMessage({ action: "getState" }).catch(() => null)) || {};
    let appliedJobs = liveState.appliedJobs || {};

    if (!queue.length) {
      if (detectNoResultsPage()) {
        await endSession("Aucun résultat pour ce lieu/mot-clé");
        return;
      }
      const cards = await waitForJobCards(45000);
      if (!cards.length) {
        const emptyRetries = (session.emptyCardRetries || 0) + 1;
        S().log(
          PLATFORM,
          `SERP vide (tentative ${emptyRetries}) — popups / anti-bot / sélecteurs`,
          "warn"
        );
        await dismissIndeedPopups().catch(() => {});
        // Retry same page twice before flipping (avoids silent page burn)
        if (emptyRetries < 3) {
          await setSession({ emptyCardRetries: emptyRetries });
          await S().sleep(2500);
          return;
        }
        const noPages = (session.noApplyPages || 0) + 1;
        await setSession({ noApplyPages: noPages, emptyCardRetries: 0 });
        if (noPages >= 3 && detectNoResultsPage()) {
          await endSession("Aucun résultat pour ce lieu/mot-clé");
          return;
        }
        if (noPages >= (settings.maxConsecutiveNoApplyPages || 12)) {
          await endSession("Aucune offre trouvée");
          return;
        }
        const nextPage = (session.currentPage || 0) + 1;
        S().log(PLATFORM, `Page suivante Indeed (${nextPage + 1}) — SERP vide après retries`, "warn");
        await setSession({ currentPage: nextPage, queue: [], qIndex: 0, pageApplied: 0 });
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
      await setSession({ queue, qIndex: 0, noApplyPages: 0, emptyCardRetries: 0 });
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
      // Cap applies per SERP page then continue on page 2+
      if (await maybeFlipIndeedPage(current, settings, maxJobs)) return;

      const item = queue[qIndex];
      if (!isValidIndeedJobKey(item.jobId)) {
        qIndex++;
        await setSession({ qIndex });
        continue;
      }
      if (await alreadyHandled(item.jobId) || (await alreadyApplied(appliedJobs, item.jobId))) {
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

      // Prefer SPA: click the card on the SERP (right panel) then "Postuler sur Indeed"
      // Avoids brittle /viewjob?jk= navigations that 404 on bad/stale keys.
      const liveCard =
        collectJobCards().find((c) => c.jobId === item.jobId) ||
        [...document.querySelectorAll("[data-jk]")].find((el) => el.getAttribute("data-jk") === item.jobId);
      const cardEl = liveCard?.element || liveCard || null;
      if (cardEl && cardAlreadyApplied(cardEl)) {
        S().log(PLATFORM, `Déjà postulé (carte): ${item.title || item.jobId}`, "warn");
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: PLATFORM,
          jobId: item.jobId,
          title: item.title,
          reason: "already_applied_ui",
        });
        qIndex++;
        await setSession({ qIndex });
        continue;
      }
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
        await setSession({
          phase: "viewjob",
          currentJk: item.jobId,
          currentTitle: item.title,
          currentCompany: item.company,
          qIndex: qIndex + 1,
        });
        await S().humanClick(link);
        await S().sleep(S().randomDelay(1600, 2600));
        await markSeenJob(item.jobId);
        // Panel may show appliedSnippet after open (dead Postuler still in DOM)
        if (detectAlreadyAppliedUi()) {
          S().log(PLATFORM, `Déjà postulé (panneau): ${item.title || item.jobId}`, "warn");
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: PLATFORM,
            jobId: item.jobId,
            title: item.title,
            reason: "already_applied_ui",
          });
          await setSession({ phase: "search" });
          return;
        }
        const fresh = await getSession();
        await handleViewJobPage(fresh || session, settings);
        return;
      }

      // Card not in DOM (virtualized list) — advance queue and try next; recharge later
      S().log(PLATFORM, `Carte absente du DOM: ${item.title || item.jobId} — suivante`, "warn");
      qIndex++;
      await setSession({ qIndex });
      continue;
    }

    // Before flipping pages: if we still need applies on THIS page, reload cards
    const perPage = settings.maxJobsPerPage || 0;
    const pageApplied = (await getSession())?.pageApplied || 0;
    const totalApplied = (await getSession())?.applied || 0;
    const sessNow = await getSession();
    const rechargeAttempts = sessNow?.rechargeAttempts || 0;
    if (perPage > 0 && pageApplied < perPage && totalApplied < maxJobs && rechargeAttempts < 2) {
      await dismissIndeedPopups().catch(() => {});
      const more = await waitForJobCards(22000, { minCards: 10 });
      const seen = (await getSession())?.seenJobIds || {};
      const fresh = more
        .filter((c) => isValidIndeedJobKey(c.jobId) && !seen[c.jobId] && c.easyApply !== false)
        .filter((c) => c.easyApply)
        .map((c) => ({ jobId: c.jobId, title: c.title, company: c.company }));
      // If no easyApply flags at all, keep any unseen
      const fallback = more
        .filter((c) => isValidIndeedJobKey(c.jobId) && !seen[c.jobId])
        .map((c) => ({ jobId: c.jobId, title: c.title, company: c.company }));
      const use = fresh.length ? fresh : fallback;
      if (use.length) {
        S().log(PLATFORM, `Recharge SERP page ${(session.currentPage || 0) + 1}: ${use.length} nouvelles offres`);
        await setSession({ queue: use, qIndex: 0, noApplyPages: 0, rechargeAttempts: rechargeAttempts + 1 });
        return;
      }
    }

    const nextPage = (session.currentPage || 0) + 1;
    if (nextPage > maxIndeedSerpPages(session, settings)) {
      await endSession(totalApplied > 0 ? "Plus d'offres Easy Apply (pages épuisées)" : "Aucune offre Easy Apply");
      return;
    }
    const nextUrl = buildSearchUrl(session.keywords, session.location, nextPage, session);
    S().log(PLATFORM, `Page suivante Indeed (${nextPage + 1}, start=${nextPage * 10}) — file épuisée`, "warn");
    await setSession({
      currentPage: nextPage,
      pageApplied: 0,
      rechargeAttempts: 0,
      queue: [],
      qIndex: 0,
      searchUrl: nextUrl,
      phase: "search",
    });
    window.location.href = nextUrl;
  }

  async function handleViewJobPage(session, settings) {
    const jobId = session.currentJk || jkFromUrl();
    await S().sleep(1200);

    // Fast path: appliedSnippet / "Candidature envoyée" (Postuler may still be visible but dead)
    if (detectAlreadyAppliedUi()) {
      const title =
        session.currentTitle ||
        getJobInfoFromPage(jobId)?.title ||
        "";
      S().log(PLATFORM, `Déjà postulé (UI): ${title || jobId}`, "warn");
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        platform: PLATFORM,
        jobId: jobId || "unknown",
        title,
        reason: "already_applied_ui",
      });
      await setSession({ phase: "search" });
      if (!isSearchPage()) window.location.href = searchReturnUrl(session);
      return;
    }

    await S().sleep(1000);

    if (detectMissingJobPage() || !isValidIndeedJobKey(jobId)) {
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        platform: PLATFORM,
        jobId: jobId || "invalid",
        title: session.currentTitle || "Offre invalide",
        reason: "Offre introuvable / clé invalide",
      });
      await setSession({ phase: "search" });
      window.location.href = searchReturnUrl(session);
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
      window.location.href = searchReturnUrl(session);
      return;
    }

    // Shared mutex with Glassdoor Easy Apply — detect handoff BEFORE skip/return
    // so a failed Postuler on a GD URL doesn't poison Indeed's own SERP queue.
    let gdHandoff = false;
    let gdMeta = null;
    try {
      const { sessionGlassdoor: sGd = null, glassdoorSmartApply = null } = await chrome.storage.local.get([
        "sessionGlassdoor",
        "glassdoorSmartApply",
      ]);
      const smartAge = glassdoorSmartApply?.at ? Date.now() - glassdoorSmartApply.at : 999999;
      gdHandoff = !!(sGd?.active && (sGd.awaitingIndeed || smartAge < 180000));
      gdMeta = glassdoorSmartApply || (gdHandoff ? sGd : null);
    } catch (_e) {}
    if (gdHandoff && gdMeta) {
      if (gdMeta.jobId || gdMeta.currentJk) jobInfo.jobId = gdMeta.jobId || gdMeta.currentJk || jobInfo.jobId;
      if (gdMeta.title || gdMeta.currentTitle)
        jobInfo.title = gdMeta.title || gdMeta.currentTitle || jobInfo.title;
      if (gdMeta.company || gdMeta.currentCompany)
        jobInfo.company = gdMeta.company || gdMeta.currentCompany || jobInfo.company;
    }

    const btn = await waitForApplyButton(gdHandoff ? 22000 : 18000);
    if (!btn) {
      if (gdHandoff) {
        // Fail fast — don't hold GD's lock for 120s on a dead viewjob
        S().log(
          PLATFORM,
          `Handoff Glassdoor: Postuler introuvable (${jobInfo.title || jobId}) — release`,
          "warn"
        );
        try {
          const { sessionGlassdoor: sGd = null } = await chrome.storage.local.get(["sessionGlassdoor"]);
          const skipId = jobInfo.jobId || sGd?.currentJk || jobId;
          const skipTitle = jobInfo.title || sGd?.currentTitle || "";
          if (sGd?.active) {
            await chrome.storage.local.set({
              sessionGlassdoor: { ...sGd, awaitingIndeed: false, indeedHandoffDone: false },
              glassdoorSmartApply: null,
            });
          }
          // Persist skip on Glassdoor so SERP doesn't re-attack the same listing
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: "glassdoor",
            jobId: skipId,
            title: skipTitle,
            reason: "handoff_no_postuler",
          });
          await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "glassdoor" });
          // Close dead viewjob apply slot so next Easy Apply can open cleanly
          try {
            await chrome.runtime.sendMessage({ action: "closeIndeedSmartApplyTabs" });
          } catch (_e2) {}
        } catch (_e) {}
        return;
      }
      if (detectAlreadyAppliedUi()) {
        S().log(PLATFORM, `Déjà postulé (UI): ${jobInfo.title || jobId}`, "warn");
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: PLATFORM,
          jobId: jobInfo.jobId,
          title: jobInfo.title,
          reason: "already_applied_ui",
        });
      } else {
        S().log(PLATFORM, "Bouton Postuler sur Indeed introuvable", "warn");
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: PLATFORM,
          jobId: jobInfo.jobId,
          title: jobInfo.title,
          reason: "Pas de candidature Indeed",
        });
      }
      await setSession({ phase: "search" });
      window.location.href = searchReturnUrl(session);
      return;
    }
    const lock = await chrome.runtime
      .sendMessage({ action: "acquireSmartApplyLock", owner: "indeed", handoff: gdHandoff })
      .catch(() => null);
    if (!lock?.ok) {
      S().log(
        PLATFORM,
        `Smart Apply occupé (${lock?.owner || "glassdoor"}) — pause offre, retry plus tard`,
        "warn"
      );
      await setSession({ phase: "search" });
      await S().sleep(1500);
      // Soft return — avoid full SERP hard navigation when possible
      if (!isSearchPage()) {
        window.location.href = searchReturnUrl(session);
      }
      return;
    }
    if (gdHandoff || lock?.handoff) {
      window.__AmijobsWizardIsHandoff = true;
    }

    S().log(PLATFORM, `Clic: ${(btn.innerText || btn.textContent || "Postuler").trim().slice(0, 48)}`);
    await setSession({ phase: "apply", currentJk: jobInfo.jobId });
    const result = await applyCurrentJob(settings, jobInfo);

    if (result.reason === "smartapply_tab") {
      // Another tab owns the wizard; keep lock while waiting for completion
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
      try {
        await chrome.runtime.sendMessage({
          action: "releaseSmartApplyLock",
          owner: gdHandoff || window.__AmijobsWizardIsHandoff ? "glassdoor" : "indeed",
        });
      } catch (_e) {}
      await setSession({ phase: "search" });
      window.location.href = searchReturnUrl(session);
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
      try {
        await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "indeed", fair: true });
      } catch (_e) {}
      S().log(PLATFORM, `Postulé (site entreprise): ${jobInfo.title}`, "success");
      await setSession({ phase: "search" });
      window.location.href = searchReturnUrl(session);
      return;
    }

    if (
      result.reason === "company_site_apply" ||
      result.reason === "external_ats" ||
      result.reason === "no_smartapply_opened" ||
      result.reason === "no_indeed_apply" ||
      result.reason === "already_applied_ui"
    ) {
      try {
        await chrome.runtime.sendMessage({
          action: "releaseSmartApplyLock",
          owner: gdHandoff || window.__AmijobsWizardIsHandoff ? "glassdoor" : "indeed",
        });
      } catch (_e) {}
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        platform: PLATFORM,
        jobId: jobInfo.jobId,
        title: jobInfo.title,
        reason:
          result.reason === "already_applied_ui"
            ? "already_applied_ui"
            : result.reason === "company_site_apply"
              ? "Site entreprise (échec/indisponible)"
              : "Pas de Smart Apply Indeed",
      });
      await setSession({ phase: "search" });
      window.location.href = searchReturnUrl(session);
      return;
    }

    if (result.success) {
      const creditGd = !!(gdHandoff || window.__AmijobsWizardIsHandoff);
      let creditJobId = jobInfo.jobId;
      let creditTitle = jobInfo.title;
      let creditCompany = jobInfo.company;
      if (creditGd) {
        try {
          const { glassdoorSmartApply = null, sessionGlassdoor: sGd = null } =
            await chrome.storage.local.get(["glassdoorSmartApply", "sessionGlassdoor"]);
          creditJobId = glassdoorSmartApply?.jobId || sGd?.currentJk || creditJobId;
          creditTitle = glassdoorSmartApply?.title || sGd?.currentTitle || creditTitle;
          creditCompany = glassdoorSmartApply?.company || sGd?.currentCompany || creditCompany;
        } catch (_e) {}
      }
      await chrome.runtime.sendMessage({
        action: "markApplied",
        platform: creditGd ? "glassdoor" : PLATFORM,
        jobId: creditJobId,
        title: creditTitle,
        company: creditCompany,
        url: jobInfo.url,
      });
      // markApplied already bumps session.applied — only track per-page count here
      const sNow = await getSession();
      const pageApplied = creditGd ? sNow?.pageApplied || 0 : (sNow?.pageApplied || 0) + 1;
      await setSession({ pageApplied, phase: "search", awaitingSmartApply: false });
      try {
        await chrome.runtime.sendMessage({
          action: "releaseSmartApplyLock",
          owner: creditGd ? "glassdoor" : "indeed",
          fair: true,
        });
      } catch (_e) {}
      S().log(
        PLATFORM,
        creditGd
          ? `Postulé (via Glassdoor): ${creditTitle || creditJobId}`
          : `Postulé: ${jobInfo.title} (page ${(sNow?.currentPage || 0) + 1}, ${pageApplied}/${settings.maxJobsPerPage || "∞"} page)`,
        "success"
      );
    } else {
      if (!(gdHandoff || window.__AmijobsWizardIsHandoff)) {
        await chrome.runtime.sendMessage({
          action: "markError",
          platform: PLATFORM,
          jobId: jobInfo.jobId,
          title: jobInfo.title,
          error: result.reason || "error",
        });
      }
      await setSession({ phase: "search", awaitingSmartApply: false });
      try {
        await chrome.runtime.sendMessage({
          action: "releaseSmartApplyLock",
          owner: gdHandoff || window.__AmijobsWizardIsHandoff ? "glassdoor" : "indeed",
        });
      } catch (_e) {}
    }

    await S().sleep(
      S().randomDelay(settings.delayBetweenJobs?.min || 800, settings.delayBetweenJobs?.max || 1800)
    );
    const after = await getSession();
    const maxJobs = after?.maxJobs || settings.maxJobsPerSession || 25;
    if (result.success && (await maybeFlipIndeedPage(after, settings, maxJobs))) return;
    window.location.href = searchReturnUrl(after || session);
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
      {
        const sBefore = await getSession();
        await chrome.runtime.sendMessage({
          action: "markApplied",
          platform: fromGlassdoor ? "glassdoor" : PLATFORM,
          jobId: jobInfo.jobId || session.currentJk,
          title: jobInfo.title,
          company: jobInfo.company,
          url: jobInfo.url,
          page: fromGlassdoor
            ? (await chrome.storage.local.get(["sessionGlassdoor"])).sessionGlassdoor?.currentPage || 0
            : sBefore?.currentPage || 0,
        });
      }
      try {
        await chrome.storage.local.set({ indeedWizardBusy: null });
      } catch (_e) {}
      if (!fromGlassdoor) {
        const sNow = await getSession();
        const pageApplied = (sNow?.pageApplied || 0) + 1;
        await setSession({ pageApplied, phase: "search", awaitingSmartApply: false });
        try {
          await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "indeed", fair: true });
        } catch (_e) {}
        // Free stale Glassdoor handoff flag so GD can take its fair turn
        try {
          const { sessionGlassdoor: sGd = null } = await chrome.storage.local.get(["sessionGlassdoor"]);
          if (sGd?.active && sGd.awaitingIndeed) {
            await chrome.storage.local.set({
              sessionGlassdoor: { ...sGd, awaitingIndeed: false, indeedHandoffDone: false },
              glassdoorSmartApply: null,
            });
          }
        } catch (_e) {}
        S().log(
          PLATFORM,
          `Postulé: ${jobInfo.title || jobInfo.jobId} (page ${(sNow?.currentPage || 0) + 1}, ${pageApplied}/${settings.maxJobsPerPage || "∞"} page)`,
          "success"
        );
      } else {
        try {
          await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "glassdoor", fair: true });
        } catch (_e) {}
        S().log(
          PLATFORM,
          `Postulé${fromGlassdoor ? " (via Glassdoor)" : ""}: ${jobInfo.title || jobInfo.jobId}`,
          "success"
        );
      }
    } else if (!fromGlassdoor) {
      await chrome.runtime.sendMessage({
        action: "markError",
        platform: PLATFORM,
        jobId: jobInfo.jobId || session.currentJk,
        title: jobInfo.title,
        error: result.reason || "error",
      });
      try {
        await chrome.runtime.sendMessage({ action: "releaseSmartApplyLock", owner: "indeed" });
      } catch (_e) {}
    } else {
      // Soft retry once, then release Glassdoor waiter so mass-apply can skip & continue
      S().log(
        PLATFORM,
        `Smart Apply (Glassdoor) en cours / retry: ${result.reason || "error"}`,
        "warn"
      );
      try {
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
        } else {
          result.reason = retry.reason || result.reason || "wizard_timeout";
        }
      } catch (_e) {
        /* ignore */
      }
    }

    if (fromGlassdoor) {
      const { sessionGlassdoor: sNow = null } = await chrome.storage.local.get(["sessionGlassdoor"]);
      if (result.success) {
        if (sNow?.active) {
          await chrome.storage.local.set({
            sessionGlassdoor: {
              ...sNow,
              awaitingIndeed: false,
              indeedHandoffDone: true,
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
      } else {
        // Release waiter + skip job so Glassdoor can flip to next Easy Apply card
        S().log(
          PLATFORM,
          `Abandon Smart Apply Glassdoor: ${result.reason || "error"} — reprise SERP Glassdoor`,
          "warn"
        );
        if (sNow?.active) {
          await chrome.storage.local.set({
            sessionGlassdoor: {
              ...sNow,
              awaitingIndeed: false,
              indeedHandoffDone: false,
            },
            glassdoorSmartApply: null,
            indeedWizardBusy: null,
          });
        } else {
          await chrome.storage.local.set({ glassdoorSmartApply: null, indeedWizardBusy: null });
        }
        await chrome.runtime.sendMessage({
          action: "markSkipped",
          platform: "glassdoor",
          jobId: jobInfo.jobId || session.currentJk,
          title: jobInfo.title,
          reason: result.reason || "smartapply_failed",
        }).catch(() => {});
        await chrome.runtime.sendMessage({
          action: "closeTabAndResumeIndeed",
          searchUrl: "",
          fromGlassdoor: true,
        }).catch(() => {});
      }
      return;
    }

    const after = await getSession();
    const maxJobs = after?.maxJobs || settings.maxJobsPerSession || 25;
    const flipUrl =
      result.success ? await maybeFlipIndeedPage(after, settings, maxJobs, { navigate: false }) : null;
    await setSession({ phase: "search" });
    const resumeUrl = flipUrl || searchReturnUrl((await getSession()) || after || session);
    // Prefer closing smartapply tab and returning to search on fr.indeed
    if (/smartapply\.indeed\.com/i.test(window.location.href)) {
      await chrome.runtime.sendMessage({
        action: "closeTabAndResumeIndeed",
        searchUrl: resumeUrl,
      });
      return;
    }
    window.location.href = resumeUrl;
  }

  async function runAutoApplySession() {
    if (isRunning) return;
    if (!isTopAutomationFrame()) return;
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
        if (isLoginWallPage() || detectLoginWall()) {
          await chrome.runtime
            .sendMessage({ action: "indeedLoginWall", url: window.location.href })
            .catch(() => {});
          return;
        }
        const { sessionGlassdoor } = await chrome.storage.local.get(["sessionGlassdoor"]);
        if (sessionGlassdoor?.active) {
          const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
          if (amijobsMeta?.indeedLoginRequired) {
            await chrome.runtime
              .sendMessage({ action: "indeedLoginWall", url: window.location.href })
              .catch(() => {});
            return;
          }
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

      // Paused for Indeed login — wait, or auto-resume once auth is gone
      try {
        const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
        if (amijobsMeta?.indeedLoginRequired || session.pausedForLogin) {
          if (isLoginWallPage() || detectLoginWall()) {
            S().log(PLATFORM, "En attente de connexion Indeed…", "warn");
            return;
          }
          if (isSearchPage() || isSmartApplyPage() || isViewJobPage()) {
            await chrome.runtime
              .sendMessage({ action: "indeedLoginResolved", reason: "indeed_page_ok" })
              .catch(() => {});
            session = await getSession();
            if (!session?.active) return;
          } else {
            return;
          }
        }
      } catch (_e) {}

      if (detectCloudflareChallenge() || detectBlockedPage()) {
        const ok = await tryPassCloudflareChallenge();
        if (!ok && detectBlockedPage() && !detectCloudflareChallenge()) {
          await endSession("Indeed a bloqué la requête (anti-bot)");
          return;
        }
        if (!ok && detectCloudflareChallenge()) {
          // STOP — do not re-enter tryPass / navigate / kick. Spamming CF refreshes Ray ID.
          S().log(
            PLATFORM,
            "Cloudflare actif — mass apply en pause. Résolvez la case manuellement, puis rechargez la page une fois.",
            "warn"
          );
          return;
        }
        if (ok) {
          // Fall through to normal routing once cleared
        } else {
          return;
        }
      }
      if (detectLoginWall() && !isSmartApplyPage()) {
        // Sometimes Cloudflare/login interstitial looks like a login wall — try challenge first
        if (detectCloudflareChallenge()) {
          await tryPassCloudflareChallenge();
        }
        if (detectLoginWall() && !isSmartApplyPage()) {
          // Pause + keep auth tab — do not end session / close tab (user must sign in)
          await chrome.runtime
            .sendMessage({
              action: "indeedLoginWall",
              tabId: null,
              url: window.location.href,
              fromGlassdoor: !!session.fromGlassdoor,
            })
            .catch(() => {});
          S().log(
            PLATFORM,
            "Connexion Indeed requise — connectez-vous dans cet onglet; reprise auto ensuite",
            "warn"
          );
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

      // Route by URL first — stale phase=viewjob/apply must not steal /jobs SERP
      if (isIndeedOnboardingPage(url)) {
        await handleIndeedOnboardingPage();
      } else if (isSmartApplyPage(url)) {
        await handleApplyPage(session, settings);
      } else if (isViewJobPage(url)) {
        await handleViewJobPage(session, settings);
      } else if (isSearchPage(url)) {
        if (session.phase === "viewjob" || session.phase === "apply") {
          // SPA stayed on SERP with right panel — finish that job, else reset to search
          const hasPanel =
            !!detectAlreadyAppliedUi() ||
            !!findIndeedEasyApplyButton() ||
            !!S().$(
              '[data-testid="appliedSnippet"], [data-testid="jobsearch-JobInfoHeader-title"], .jobsearch-JobInfoHeader-title, h1.jobsearch-JobInfoHeader-title, #jobsearch-ViewJobButtons-container'
            );
          if (session.phase === "viewjob" && hasPanel && session.currentJk) {
            await handleViewJobPage(session, settings);
          } else {
            await setSession({ phase: "search" });
            await handleSearchPage({ ...session, phase: "search" }, settings);
          }
        } else {
          await handleSearchPage(session, settings);
        }
      } else if (session.phase === "apply" && /indeedapply|smartapply/i.test(url)) {
        await handleApplyPage(session, settings);
      } else {
        // Help/support scraped by Glassdoor, login walls, etc. — never yank apply tab to SERP
        // during a Glassdoor handoff (that aborts the Easy Apply flow).
        let gdAwait = false;
        try {
          const { sessionGlassdoor: sGd = null } = await chrome.storage.local.get(["sessionGlassdoor"]);
          gdAwait = !!(sGd?.active && sGd.awaitingIndeed);
        } catch (_e) {}
        const isHelp =
          /help\.|support\.|\/hc\/|guidelines|articles\//i.test(url) ||
          /accounts\.google|recaptcha|just a moment/i.test(document.title || "");
        S().log(PLATFORM, `Page non gérée: ${url}`, "warn");
        if (gdAwait || isHelp || session.fromGlassdoor) {
          return;
        }
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

  async function checkAndResumeSession() {
    if (!isTopAutomationFrame()) return;
    const start = Date.now();
    while (Date.now() - start < 120000) {
      if (isRunning) return;
      // Never resume-loop into Cloudflare — that reloads Ray IDs
      if (detectCloudflareChallenge()) return;
      try {
        const { amijobsCfPause = null } = await chrome.storage.local.get(["amijobsCfPause"]);
        if (amijobsCfPause?.until && Date.now() < amijobsCfPause.until) return;
      } catch (_e) {}
      const session = await getSession();
      if (!session?.active) return;
      // Don't steal focus from an open Smart Apply wizard
      try {
        const tabs = await chrome.runtime.sendMessage({ action: "listIndeedTabs" }).catch(() => null);
        if (tabs?.hasSmartApply && isSearchPage()) {
          await S().sleep(3000);
          continue;
        }
      } catch (_e) {}
      if (Date.now() - (session.lastRunAt || 0) < 2500) {
        await S().sleep(1500);
        continue;
      }
      await S().sleep(1200);
      if (!isRunning) await runAutoApplySession();
      return;
    }
  }

  S().log(PLATFORM, `Indeed module v${VERSION} chargé`);
  setTimeout(() => {
    getSession().then((session) => {
      if (session?.active || isSmartApplyPage()) runAutoApplySession();
    });
  }, 1800);
  // Early returns (empty SERP retry, Pause SERP) used to stall forever without a resume loop
  setInterval(() => {
    getSession().then((session) => {
      if (session?.active && !isRunning) checkAndResumeSession();
    });
  }, 8000);
})();
