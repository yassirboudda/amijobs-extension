// AmiJobs — Glassdoor auto-apply content script
(function () {
  if (window.__AmijobsGlassdoorLoaded) return;
  window.__AmijobsGlassdoorLoaded = true;

  const PLATFORM = "glassdoor";
  const VERSION = "1.1.0";
  const S = () => window.AmiJobsShared;
  let isRunning = false;
  let shouldStop = false;

  function isSearchPage() {
    return /glassdoor\.(com|fr)\/(Job|Emploi)/i.test(window.location.href);
  }

  function buildSearchUrl(keywords, location) {
    const host = window.location.hostname.includes("glassdoor.fr")
      ? "https://www.glassdoor.fr"
      : "https://www.glassdoor.com";
    const p = new URLSearchParams();
    if (keywords) p.set("sc.keyword", keywords);
    if (location) p.set("sc.location", location);
    return `${host}/Job/jobs.htm?${p.toString()}`;
  }

  function collectJobCards() {
    const selectors = [
      'li[data-test="jobListing"]',
      '[data-test="job-listing"]',
      ".react-job-listing",
      ".JobsList_jobListItem",
      "ul.jobsList li",
      "article[data-test='job-card']",
    ];
    const nodes = new Set();
    for (const sel of selectors) {
      for (const el of S().$$(sel)) nodes.add(el);
    }
    const out = [];
    const seen = new Set();
    for (const el of nodes) {
      const id =
        el.getAttribute("data-id") ||
        el.getAttribute("data-jobid") ||
        el.querySelector("a[href*='jobListing']")?.href ||
        el.querySelector("a[href*='emploi']")?.href ||
        el.querySelector("a")?.href ||
        el.textContent.slice(0, 40);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ element: el, jobId: btoa(unescape(encodeURIComponent(id))).slice(0, 24) });
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

  function findApplyButton() {
    return (
      S().$('[data-test="applyButton"]') ||
      S().$('[data-test="apply-button"]') ||
      S().findActionButton([/easy apply|postuler|apply now|quick apply/i])
    );
  }

  function detectApplySuccess() {
    const t = document.body.innerText.toLowerCase();
    return t.includes("application submitted") || t.includes("candidature envoyée") || t.includes("successfully applied");
  }

  async function clickJobCard(card) {
    const link = card.element.querySelector("a[href*='job'], a[href*='emploi'], a.JobCard_jobTitle");
    if (link) await S().humanClick(link);
    else await S().humanClick(card.element);
    await S().sleep(S().randomDelay(1200, 2200));
  }

  async function runApplyWizard(jobInfo, settings) {
    for (let step = 0; step < 14; step++) {
      if (shouldStop) return { success: false, reason: "stopped" };
      await S().fillVisibleFields(jobInfo, PLATFORM);
      const submit = S().findActionButton([/submit application|soumettre|send application|envoyer/i]);
      const next = S().findActionButton([/continue|continuer|next|suivant/i]);
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
    if (!btn) return { success: false, reason: "no_easy_apply" };
    await S().humanClick(btn);
    await S().sleep(S().randomDelay(1500, 2500));
    return runApplyWizard(getJobInfo("current"), settings);
  }

  function alreadyApplied(appliedJobs, jobId) {
    return !!(appliedJobs[jobId] || appliedJobs[`gd_${jobId}`]);
  }

  async function runAutoApplySession() {
    if (isRunning) return;
    isRunning = true;
    shouldStop = false;
    const { sessionGlassdoor: session } = await chrome.storage.local.get(["sessionGlassdoor"]);
    const state = await chrome.runtime.sendMessage({ action: "getState" });
    const settings = state?.autoApplySettings || {};
    const maxJobs = session?.maxJobs || settings.maxJobsPerSession || 25;
    const appliedJobs = state?.appliedJobs || {};

    S().log(PLATFORM, `Session Glassdoor démarrée (${session?.applied || 0}/${maxJobs})`);

    const cards = collectJobCards();
    if (!cards.length) {
      S().log(PLATFORM, "Aucune offre Glassdoor trouvée", "error");
      await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: PLATFORM });
      isRunning = false;
      return;
    }

    try {
      for (let i = 0; i < cards.length && !shouldStop; i++) {
        const { sessionGlassdoor: current } = await chrome.storage.local.get(["sessionGlassdoor"]);
        if ((current?.applied || 0) >= maxJobs) break;

        const card = cards[i];
        if (alreadyApplied(appliedJobs, card.jobId)) continue;

        await clickJobCard(card);
        const jobInfo = getJobInfo(card.jobId);

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

        const btn = await waitForApplyButton(5000);
        if (!btn) {
          await chrome.runtime.sendMessage({
            action: "markSkipped",
            platform: PLATFORM,
            jobId: jobInfo.jobId,
            title: jobInfo.title,
            reason: "Pas de candidature simplifiée",
          });
          continue;
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

      const { sessionGlassdoor: updated } = await chrome.storage.local.get(["sessionGlassdoor"]);
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
    if (!isSearchPage()) return;
    const start = Date.now();
    while (Date.now() - start < 60000) {
      const { sessionGlassdoor: session } = await chrome.storage.local.get(["sessionGlassdoor"]);
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

  S().log(PLATFORM, `Glassdoor module v${VERSION} chargé`);
  if (isSearchPage()) checkAndResumeSession();
})();
