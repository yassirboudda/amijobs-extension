// AmiJobs — Indeed auto-apply content script
(function () {
  if (window.__AmijobsIndeedLoaded) return;
  window.__AmijobsIndeedLoaded = true;

  const PLATFORM = "indeed";
  const VERSION = "1.1.0";
  const S = () => window.AmiJobsShared;
  let isRunning = false;
  let shouldStop = false;

  function isSearchPage() {
    return /indeed\.(com|fr)\/jobs/.test(window.location.href);
  }

  function buildSearchUrl(keywords, location, page = 0) {
    const host = window.location.hostname.includes("indeed.fr") ? "https://fr.indeed.com" : "https://www.indeed.com";
    const p = new URLSearchParams();
    if (keywords) p.set("q", keywords);
    if (location) p.set("l", location);
    if (page > 0) p.set("start", String(page * 10));
    return `${host}/jobs?${p.toString()}`;
  }

  function collectJobCards() {
    const selectors = [
      ".job_seen_beacon",
      "div[data-jk]",
      ".tapItem",
      ".resultContent",
      "ul#job-results-list > li",
      ".jobsearch-ResultsList > li",
    ];
    const nodes = new Set();
    for (const sel of selectors) {
      for (const el of S().$$(sel)) nodes.add(el);
    }
    const out = [];
    const seen = new Set();
    for (const el of nodes) {
      const jk = el.getAttribute("data-jk") || el.closest("[data-jk]")?.getAttribute("data-jk");
      if (!jk || seen.has(jk)) continue;
      seen.add(jk);
      out.push({ element: el, jobId: jk });
    }
    return out;
  }

  async function waitForApplyButton(timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const btn = findApplyButton();
      if (btn) return btn;
      await S().sleep(400);
    }
    return null;
  }

  function getJobInfoFromPage(jobId) {
    const title =
      S().$('[data-testid="jobsearch-JobInfoHeader-title"]')?.textContent?.trim() ||
      S().$(".jobsearch-JobInfoHeader-title")?.textContent?.trim() ||
      "";
    const company =
      S().$('[data-testid="inlineHeader-companyName"]')?.textContent?.trim() ||
      S().$(".jobsearch-InlineCompanyRating-companyHeader a")?.textContent?.trim() ||
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
    const m = window.location.href.match(/[?&]vjk=([^&]+)/) || window.location.href.match(/[?&]jk=([^&]+)/);
    return m ? m[1] : `indeed_${Date.now()}`;
  }

  function hasIndeedApply() {
    const btn = findApplyButton();
    return !!btn;
  }

  function findApplyButton() {
    return (
      S().$('[data-testid="indeedApplyButton"]') ||
      S().$("#indeedApplyButton") ||
      S().$('[data-indeed-apply-button]') ||
      S().findActionButton([/indeed apply|postuler sur indeed|candidature simplifiée|postuler|apply now/i])
    );
  }

  function detectApplySuccess() {
    const body = document.body.innerText.toLowerCase();
    return (
      body.includes("application submitted") ||
      body.includes("candidature envoyée") ||
      body.includes("your application has been submitted") ||
      body.includes("vous avez postulé")
    );
  }

  async function clickJobCard(card) {
    const link = card.element.querySelector("a[href*='jk='], a[href*='vjk='], h2.jobTitle a, a.jcs-JobTitle");
    if (link) await S().humanClick(link);
    else await S().humanClick(card.element);
    await S().sleep(S().randomDelay(1200, 2200));
  }

  async function runApplyWizard(jobInfo, settings) {
    for (let step = 0; step < 14; step++) {
      if (shouldStop) return { success: false, reason: "stopped" };
      await S().fillVisibleFields(jobInfo, PLATFORM);
      const submit = S().findActionButton([/submit application|soumettre|envoyer la candidature|send application/i]);
      const next = S().findActionButton([/continue|continuer|next|suivant|review/i]);
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
        await S().sleep(S().randomDelay(settings.delayBetweenSteps?.min || 700, settings.delayBetweenSteps?.max || 1600));
        continue;
      }
      break;
    }
    return { success: false, reason: "wizard_timeout" };
  }

  async function applyCurrentJob(settings) {
    const btn = await waitForApplyButton();
    if (!btn) return { success: false, reason: "no_indeed_apply" };
    await S().humanClick(btn);
    await S().sleep(S().randomDelay(1500, 2500));
    return runApplyWizard(getJobInfoFromPage(), settings);
  }

  function alreadyApplied(appliedJobs, jobId) {
    if (!jobId) return false;
    return !!(appliedJobs[jobId] || appliedJobs[`ind_${jobId}`]);
  }

  async function runAutoApplySession() {
    if (isRunning) return;
    isRunning = true;
    shouldStop = false;
    const { sessionIndeed: session } = await chrome.storage.local.get(["sessionIndeed"]);
    const state = await chrome.runtime.sendMessage({ action: "getState" });
    const settings = state?.autoApplySettings || {};
    const maxJobs = session?.maxJobs || settings.maxJobsPerSession || 25;
    const appliedJobs = state?.appliedJobs || {};

    S().log(PLATFORM, `Session Indeed démarrée (${session?.applied || 0}/${maxJobs})`);

    let cards = collectJobCards();
    if (!cards.length) {
      S().log(PLATFORM, "Aucune offre Indeed trouvée", "error");
      await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: PLATFORM });
      isRunning = false;
      return;
    }

    try {
      for (let i = 0; i < cards.length && !shouldStop; i++) {
        const { sessionIndeed: current } = await chrome.storage.local.get(["sessionIndeed"]);
        if ((current?.applied || 0) >= maxJobs) break;

        const card = cards[i];
        if (alreadyApplied(appliedJobs, card.jobId)) continue;

        await clickJobCard(card);
        const jobInfo = getJobInfoFromPage(card.jobId);
        if (!jobInfo.jobId) jobInfo.jobId = card.jobId;

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

        if (!hasIndeedApply()) {
          const btn = await waitForApplyButton(5000);
          if (!btn) {
            await chrome.runtime.sendMessage({
              action: "markSkipped",
              platform: PLATFORM,
              jobId: jobInfo.jobId,
              title: jobInfo.title,
              reason: "Pas de candidature Indeed",
            });
            continue;
          }
        }

        const result = await applyCurrentJob(settings);
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

        if (i < cards.length - 1) {
          await S().sleep(S().randomDelay(settings.delayBetweenJobs?.min || 6000, settings.delayBetweenJobs?.max || 14000));
        }
      }

      const { sessionIndeed: updated } = await chrome.storage.local.get(["sessionIndeed"]);
      if (!shouldStop && updated?.active && (updated.applied || 0) < maxJobs) {
        const nextPage = (updated.currentPage || 0) + 1;
        await chrome.runtime.sendMessage({
          action: "updateSession",
          platform: PLATFORM,
          updates: { currentPage: nextPage },
        });
        window.location.href = buildSearchUrl(updated.keywords, updated.location, nextPage);
        return;
      }

      if (updated?.active) {
        await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: PLATFORM });
      }
    } catch (err) {
      S().log(PLATFORM, `Erreur: ${err.message}`, "error");
    }

    isRunning = false;
  }

  async function applySingleJob() {
    if (isRunning) return;
    isRunning = true;
    const state = await chrome.runtime.sendMessage({ action: "getState" });
    const result = await applyCurrentJob(state?.autoApplySettings || {});
    if (result.success) {
      const jobInfo = getJobInfoFromPage();
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
    if (!isSearchPage()) return;
    const maxWait = 60000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const { sessionIndeed: session } = await chrome.storage.local.get(["sessionIndeed"]);
      if (session?.active && !isRunning) {
        await S().sleep(2500);
        await runAutoApplySession();
        return;
      }
      if (isRunning) return;
      await S().sleep(3000);
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
  if (isSearchPage()) checkAndResumeSession();
})();
