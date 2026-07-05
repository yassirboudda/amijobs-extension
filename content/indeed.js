// AmiJobs — Indeed auto-apply content script (phase-based, v1.2.6)
(function () {
  if (window.__AmijobsIndeedLoaded) return;
  window.__AmijobsIndeedLoaded = true;

  const PLATFORM = "indeed";
  const VERSION = "1.2.6";
  const S = () => window.AmiJobsShared;
  let isRunning = false;
  let shouldStop = false;

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
    return /indeed\.(com|fr)\/jobs/.test(url);
  }

  function isViewJobPage(url = window.location.href) {
    return /indeed\.(com|fr)\/viewjob/.test(url) || /indeed\.(com|fr)\/rc\/clk/.test(url);
  }

  function isSmartApplyPage(url = window.location.href) {
    return /indeed\.(com|fr)\/apply/.test(url) || /smartapply\.indeed\.com/.test(url);
  }

  function buildSearchUrl(keywords, location, page = 0, session = null) {
    const host = getIndeedHost(session);
    const p = new URLSearchParams();
    if (keywords) p.set("q", keywords);
    if (location) p.set("l", location);
    p.set("iafilter", "1");
    if (page > 0) p.set("start", String(page * 10));
    return `${host}/jobs?${p.toString()}`;
  }

  function extractJobKey(el) {
    if (!el) return null;
    const direct = el.getAttribute("data-jk") || el.closest("[data-jk]")?.getAttribute("data-jk");
    if (direct) return direct;
    const link = el.querySelector?.('a[href*="jk="], a[href*="viewjob"]') || (el.matches?.('a[href*="jk="]') ? el : null);
    const href = link?.getAttribute?.("href") || el.getAttribute?.("href") || "";
    const m = href.match(/[?&]jk=([^&]+)/) || href.match(/[?&]vjk=([^&]+)/);
    if (m) return m[1];
    const id = el.getAttribute?.("id") || "";
    const idMatch = id.match(/job_([a-f0-9]+)/i);
    if (idMatch) return idMatch[1];
    return null;
  }

  async function waitForJobCards(maxWaitMs = 30000) {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < maxWaitMs) {
      attempt++;
      window.scrollBy(0, 400);
      await S().sleep(400);
      window.scrollTo(0, 0);
      const cards = collectJobCards();
      if (cards.length > 0) {
        S().log(PLATFORM, `${cards.length} offres détectées (tentative ${attempt})`);
        return cards;
      }
      await S().sleep(1500);
    }
    return collectJobCards();
  }

  async function getSession() {
    const { sessionIndeed: session = null } = await chrome.storage.local.get(["sessionIndeed"]);
    return session;
  }

  async function setSession(updates) {
    const session = await getSession();
    if (!session) return null;
    const next = { ...session, ...updates };
    await chrome.storage.local.set({ sessionIndeed: next });
    return next;
  }

  async function endSession(reason) {
    await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: PLATFORM, reason });
    if (reason) S().log(PLATFORM, `Session terminée: ${reason}`, "warn");
  }

  function detectLoginWall() {
    const text = document.body?.innerText?.toLowerCase() || "";
    return (
      text.includes("connectez-vous pour continuer") ||
      text.includes("sign in to continue") ||
      !!document.querySelector('a[href*="/account/login"], button[data-tn-element="login"]')
    );
  }

  function detectNoResultsPage() {
    const text = document.body?.innerText?.toLowerCase() || "";
    return (
      text.includes("aucun emploi ne correspond") ||
      text.includes("aucune offre ne correspond") ||
      text.includes("no matching jobs") ||
      text.includes("0 emplois") ||
      text.includes("0 jobs") ||
      !!S().$('[data-testid="zero-results"]') ||
      !!S().$(".jobsearch-NoResult")
    );
  }

  function collectJobCards() {
    const selectors = [
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
    ];
    const nodes = new Set();
    for (const sel of selectors) {
      for (const el of S().$$(sel)) nodes.add(el);
    }
    const out = [];
    const seen = new Set();
    for (const el of nodes) {
      const jk = extractJobKey(el);
      if (!jk || seen.has(jk)) continue;
      seen.add(jk);
      const title =
        el.querySelector("h2.jobTitle span, h2.jobTitle a, .jobTitle, [data-testid='job-title']")?.textContent?.trim() ||
        "";
      const company =
        el.querySelector("[data-testid='company-name'], .companyName, .company")?.textContent?.trim() || "";
      out.push({ element: el, jobId: jk, title, company });
    }
    return out;
  }

  function getJobInfoFromPage(jobId) {
    const title =
      S().$('[data-testid="jobsearch-JobInfoHeader-title"]')?.textContent?.trim() ||
      S().$(".jobsearch-JobInfoHeader-title")?.textContent?.trim() ||
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
      window.location.href.match(/[?&]jk=([^&]+)/);
    return m ? m[1] : `indeed_${Date.now()}`;
  }

  function findApplyButton() {
    const roots = [document];
    try {
      for (const frame of document.querySelectorAll("iframe")) {
        try {
          const doc = frame.contentDocument || frame.contentWindow?.document;
          if (doc) roots.push(doc);
        } catch (_e) {
          /* cross-origin */
        }
      }
    } catch (_e) {}

    for (const root of roots) {
      const btn =
        root.querySelector('[data-testid="indeedApplyButton"]') ||
        root.querySelector("#indeedApplyButton") ||
        root.querySelector('[data-indeed-apply-button]') ||
        root.querySelector("button.ia-IndeedApplyButton") ||
        root.querySelector('button[aria-label*="Postuler sur Indeed" i]') ||
        root.querySelector('button[aria-label*="Indeed Apply" i]');
      if (btn && S().isVisible(btn)) return btn;
    }

    return (
      S().findActionButtonDeep([
        /postuler sur indeed/i,
        /indeed apply/i,
        /candidature simplifiée/i,
        /postuler maintenant/i,
        /^postuler$/i,
        /apply now/i,
        /continuer à postuler/i,
      ]) || null
    );
  }

  async function waitForApplyButton(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const btn = findApplyButton();
      if (btn) return btn;
      await S().sleep(500);
    }
    return null;
  }

  function detectApplySuccess() {
    const body = document.body.innerText.toLowerCase();
    return (
      body.includes("application submitted") ||
      body.includes("candidature envoyée") ||
      body.includes("your application has been submitted") ||
      body.includes("vous avez postulé") ||
      body.includes("candidature a été envoyée")
    );
  }

  async function alreadyApplied(appliedJobs, jobId) {
    if (!jobId) return false;
    return !!(appliedJobs[jobId] || appliedJobs[`ind_${jobId}`]);
  }

  async function shouldSkipCompany(company, settings) {
    const skip = await S().shouldSkipCompany(company);
    return skip;
  }

  async function runApplyWizard(jobInfo, settings) {
    for (let step = 0; step < 20; step++) {
      if (shouldStop) return { success: false, reason: "stopped" };
      await S().fillVisibleFields(jobInfo, PLATFORM);
      const submit = S().findActionButtonDeep([
        /submit application/i,
        /soumettre la candidature/i,
        /envoyer la candidature/i,
        /send application/i,
        /soumettre/i,
        /envoyer/i,
      ]);
      const next = S().findActionButtonDeep([
        /continue/i,
        /continuer/i,
        /next/i,
        /suivant/i,
        /review/i,
        /vérifier/i,
        /valider/i,
      ]);
      if (submit) {
        if (settings.autoSubmit !== false) {
          await S().humanClick(submit);
          await S().sleep(2500);
          if (detectApplySuccess()) return { success: true };
          return { success: true, reason: "submitted" };
        }
        return { success: false, reason: "review" };
      }
      if (next) {
        await S().humanClick(next);
        await S().sleep(S().randomDelay(settings.delayBetweenSteps?.min || 100, settings.delayBetweenSteps?.max || 500));
        continue;
      }
      await S().sleep(600);
    }
    return { success: false, reason: "wizard_timeout" };
  }

  async function applyCurrentJob(settings, jobInfo) {
    const info = jobInfo || getJobInfoFromPage();
    const btn = await waitForApplyButton();
    if (!btn) return { success: false, reason: "no_indeed_apply" };
    await S().humanClick(btn);
    await S().sleep(S().randomDelay(2000, 3500));

    if (isSmartApplyPage()) {
      return runApplyWizard(info, settings);
    }

    for (let i = 0; i < 12; i++) {
      if (isSmartApplyPage()) return runApplyWizard(info, settings);
      await S().sleep(500);
    }
    return runApplyWizard(info, settings);
  }

  async function handleSearchPage(session, settings) {
    const maxJobs = session.maxJobs || settings.maxJobsPerSession || 25;
    const appliedJobs = (await chrome.runtime.sendMessage({ action: "getState" }))?.appliedJobs || {};

    if ((session.applied || 0) >= maxJobs) {
      await endSession("Objectif session atteint");
      return;
    }

    let queue = session.queue || [];
    let qIndex = session.qIndex || 0;

    if (!queue.length) {
      if (detectNoResultsPage()) {
        await endSession("Aucun résultat pour ce lieu/mot-clé");
        return;
      }
      const cards = await waitForJobCards(30000);
      if (!cards.length) {
        const noPages = (session.noApplyPages || 0) + 1;
        await setSession({ noApplyPages: noPages });
        if (noPages >= 3 && detectNoResultsPage()) {
          await endSession("Aucun résultat pour ce lieu/mot-clé");
          return;
        }
        if (noPages >= (settings.maxConsecutiveNoApplyPages || 20)) {
          await endSession("Aucune offre trouvée");
          return;
        }
        const nextPage = (session.currentPage || 0) + 1;
        await setSession({ currentPage: nextPage, queue: [], qIndex: 0 });
        window.location.href = buildSearchUrl(session.keywords, session.location, nextPage, session);
        return;
      }

      queue = cards.map((c) => ({
        jobId: c.jobId,
        title: c.title,
        company: c.company,
      }));
      qIndex = 0;
      await setSession({ queue, qIndex: 0, noApplyPages: 0 });
      S().log(PLATFORM, `${queue.length} offres trouvées`);
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
      if (await alreadyApplied(appliedJobs, item.jobId)) {
        qIndex++;
        await setSession({ qIndex });
        continue;
      }

      const skipReason = await shouldSkipCompany(item.company, settings);
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

      await setSession({
        phase: "viewjob",
        currentJk: item.jobId,
        qIndex: qIndex + 1,
      });

      const host = getIndeedHost(session);
      window.location.href = `${host}/viewjob?jk=${item.jobId}`;
      return;
    }

    const nextPage = (session.currentPage || 0) + 1;
    await setSession({ currentPage: nextPage, queue: [], qIndex: 0 });
    window.location.href = buildSearchUrl(session.keywords, session.location, nextPage, session);
  }

  async function handleViewJobPage(session, settings) {
    const jobId = session.currentJk || jkFromUrl();
    await S().sleep(2000);
    const jobInfo = getJobInfoFromPage(jobId);
    if (!jobInfo.title) jobInfo.title = session.queue?.find((q) => q.jobId === jobId)?.title || "";

    const skipReason = await shouldSkipCompany(jobInfo.company, settings);
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
      window.location.href = session.searchUrl || buildSearchUrl(session.keywords, session.location, session.currentPage || 0, session);
      return;
    }

    const btn = await waitForApplyButton(12000);
    if (!btn) {
      await chrome.runtime.sendMessage({
        action: "markSkipped",
        platform: PLATFORM,
        jobId: jobInfo.jobId,
        title: jobInfo.title,
        reason: "Pas de candidature Indeed",
      });
      await setSession({ phase: "search" });
      window.location.href = session.searchUrl || buildSearchUrl(session.keywords, session.location, session.currentPage || 0, session);
      return;
    }

    await setSession({ phase: "apply" });
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

    await S().sleep(S().randomDelay(settings.delayBetweenJobs?.min || 500, settings.delayBetweenJobs?.max || 500));
    await setSession({ phase: "search" });
    window.location.href = session.searchUrl || buildSearchUrl(session.keywords, session.location, session.currentPage || 0, session);
  }

  async function handleApplyPage(session, settings) {
    const jobInfo = getJobInfoFromPage(session.currentJk);
    const result = await runApplyWizard(jobInfo, settings);

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

    await setSession({ phase: "search" });
    window.location.href = session.searchUrl || buildSearchUrl(session.keywords, session.location, session.currentPage || 0, session);
  }

  let lastIndeedRunAt = 0;

  async function runAutoApplySession() {
    if (isRunning) return;
    const now = Date.now();
    if (now - lastIndeedRunAt < 3000) return;
    lastIndeedRunAt = now;
    isRunning = true;
    try {
      const session = await getSession();
      if (!session?.active) return;
      if (detectLoginWall()) {
        await endSession("Connexion Indeed requise");
        return;
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
        if (session.searchUrl) {
          window.location.href = session.searchUrl;
        }
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
      if (session?.active) runAutoApplySession();
    });
  }, 1500);
})();
