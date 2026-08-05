// AmiJobs — Glassdoor auto-apply content script (v1.2.7)
// Glassdoor "Easy Apply" often redirects to Indeed Smart Apply (see HAR /jobs/redirects).
(function () {
  if (window.__AmijobsGlassdoorLoaded) return;
  window.__AmijobsGlassdoorLoaded = true;

  const PLATFORM = "glassdoor";
  const VERSION = "1.3.0";
  const S = () => window.AmiJobsShared;
  let isRunning = false;
  let shouldStop = false;
  let lastGlassdoorRunAt = 0;

  function isBlockedPage() {
    const text = document.body?.innerText?.toLowerCase() || "";
    const title = document.title?.toLowerCase() || "";
    return (
      text.includes("aidez-nous à protéger glassdoor") ||
      text.includes("help us protect glassdoor") ||
      text.includes("réservé aux humains") ||
      text.includes("bad gateway") ||
      text.includes("ray id:") ||
      title.includes("bad gateway") ||
      title.includes("un instant") ||
      document.body?.innerHTML?.includes("cf-error") ||
      !!S().$("h1")?.textContent?.match(/502|503|429/i)
    );
  }

  function isSearchPage(url = window.location.href) {
    return /glassdoor\.(com|fr)\/(Job|Emploi|job-listing|Emploi\/)/i.test(url);
  }

  function isJobDetailPage(url = window.location.href) {
    return (
      /jobListing/i.test(url) ||
      /partner\/jobListing/i.test(url) ||
      /Emploi\/.*job/i.test(url) ||
      /Job\/.*jobs/i.test(url)
    );
  }

  function buildSearchUrl(keywords, location) {
    const host = window.location.hostname.includes("glassdoor.fr")
      ? "https://www.glassdoor.fr"
      : "https://www.glassdoor.com";
    const p = new URLSearchParams();
    if (keywords) p.set("sc.keyword", keywords);
    if (location) p.set("locT", "N");
    if (location) p.set("locId", "");
    if (location) p.set("sc.location", location);
    return `${host}/Job/jobs.htm?${p.toString()}`;
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

  function findApplyButton() {
    // Live headed Chrome (HAR cookies): button[data-test="easyApply"] text "Candidature facile"
    // → opens smartapply.indeed.com/beta/indeedapply/applybyapplyablejobid?...
    const selectors = [
      'button[data-test="easyApply"]',
      '[data-test="easyApply"]',
      '[data-test="applyButton"]',
      '[data-test="apply-button"]',
      '[data-test="easy-apply-button"]',
      'button[data-test*="apply" i]',
      'a[data-test*="apply" i]',
      'button[aria-label*="Easy Apply" i]',
      'button[aria-label*="Candidature" i]',
      'button[aria-label*="Postuler" i]',
    ];
    for (const sel of selectors) {
      const el = S().$(sel);
      if (el && S().isVisible(el)) return el;
    }
    return S().findActionButton([
      /candidature facile/i,
      /easy apply/i,
      /candidature simplifiée/i,
      /postuler facilement/i,
      /^postuler$/i,
      /apply now/i,
      /quick apply/i,
    ]);
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
        "a[href*='jobListing'], a[href*='emploi'], a[href*='Job'], a.JobCard_jobTitle, a[data-test='job-link']"
      ) || (card.element.tagName === "A" ? card.element : null);
    if (link) await S().humanClick(link);
    else await S().humanClick(card.element);
    await S().sleep(S().randomDelay(1400, 2400));
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

  async function applyCurrentJob(settings, jobInfo) {
    const info = jobInfo || getJobInfo("current");
    const btn = await waitForApplyButton();
    if (!btn) return { success: false, reason: "no_easy_apply" };

    // Persist context so Indeed Smart Apply tab can resume
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

    // Same-tab redirect to Indeed / partner listing
    if (detectIndeedHandoff()) {
      S().log(PLATFORM, "Redirection Indeed Smart Apply détectée", "success");
      return { success: true, reason: "indeed_handoff" };
    }

    // Wait for popup/new tab handoff signal from background (live test: opens smartapply tab)
    for (let i = 0; i < 20; i++) {
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
      // Only run on-page Glassdoor wizard if a real modal appeared
      const modalNext = S().findActionButton([
        /continue|continuer|next|suivant|submit|soumettre|envoyer/i,
      ]);
      const dialog = S().$('[role="dialog"], .modal, [class*="Modal"]');
      if (modalNext && dialog && S().isVisible(dialog)) {
        return runApplyWizard(info, settings);
      }
      await S().sleep(600);
    }

    // Easy Apply on Glassdoor almost always opens Indeed — do NOT fall into empty wizard_timeout
    S().log(PLATFORM, "Handoff Indeed assumé (pas de wizard Glassdoor)", "warn");
    const { sessionGlassdoor: sAssumed } = await chrome.storage.local.get(["sessionGlassdoor"]);
    if (sAssumed?.active) {
      await chrome.storage.local.set({
        sessionGlassdoor: { ...sAssumed, awaitingIndeed: true },
      });
    }
    return { success: true, reason: "indeed_handoff_assumed" };
  }

  function alreadyApplied(appliedJobs, jobId) {
    return !!(appliedJobs[jobId] || appliedJobs[`gd_${jobId}`]);
  }

  async function runAutoApplySession() {
    if (isRunning) return;
    const now = Date.now();
    if (now - lastGlassdoorRunAt < 15000) {
      S().log(PLATFORM, "Cooldown Glassdoor — skip (anti boucle)", "warn");
      return;
    }
    lastGlassdoorRunAt = now;
    isRunning = true;
    shouldStop = false;

    if (isBlockedPage()) {
      S().log(PLATFORM, "Glassdoor bloque temporairement (protection anti-bot) — pause", "warn");
      await chrome.runtime.sendMessage({
        action: "endPlatformSession",
        platform: PLATFORM,
        reason: "Arrêt: protection Glassdoor (Cloudflare)",
      });
      isRunning = false;
      return;
    }

    const { sessionGlassdoor: session } = await chrome.storage.local.get(["sessionGlassdoor"]);
    if (!session?.active) {
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

        const { sessionGlassdoor: current } = await chrome.storage.local.get(["sessionGlassdoor"]);
        if (!current?.active || (current?.applied || 0) >= maxJobs) break;

        const card = cards[i];
        if (alreadyApplied(appliedJobs, card.jobId)) continue;

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

        const btn = await waitForApplyButton(8000);
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

        const result = await applyCurrentJob(settings, jobInfo);
        if (result.success) {
          const isIndeedHandoff = /indeed/i.test(String(result.reason || ""));
          if (isIndeedHandoff) {
            S().log(PLATFORM, `Handoff Indeed: ${jobInfo.title} — attente Smart Apply`, "success");
            // Wait until background clears awaitingIndeed (Smart Apply closed) or timeout
            for (let w = 0; w < 75; w++) {
              if (shouldStop) break;
              const { sessionGlassdoor: sWait } = await chrome.storage.local.get(["sessionGlassdoor"]);
              if (!sWait?.awaitingIndeed) break;
              await S().sleep(1000);
            }
            // Mark applied after handoff wait (Indeed may also mark — duplicate keys are ok with same job)
            await chrome.runtime.sendMessage({
              action: "markApplied",
              platform: PLATFORM,
              jobId: jobInfo.jobId,
              title: jobInfo.title,
              company: jobInfo.company,
              url: jobInfo.url,
            });
            // Ensure flag cleared for next card
            const { sessionGlassdoor: sClear } = await chrome.storage.local.get(["sessionGlassdoor"]);
            if (sClear?.awaitingIndeed) {
              await chrome.storage.local.set({
                sessionGlassdoor: { ...sClear, awaitingIndeed: false, indeedHandoffDone: false },
              });
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
          }
          appliedThisRun++;
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

        const jobDelay = Math.max(settings.delayBetweenJobs?.min || 500, 8000);
        const jobDelayMax = Math.max(settings.delayBetweenJobs?.max || jobDelay, jobDelay);
        await S().sleep(S().randomDelay(jobDelay, jobDelayMax));
      }

      const { sessionGlassdoor: updated } = await chrome.storage.local.get(["sessionGlassdoor"]);
      if (updated?.active) {
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
    if (isBlockedPage()) return;
    const start = Date.now();
    while (Date.now() - start < 45000) {
      const { sessionGlassdoor: session } = await chrome.storage.local.get(["sessionGlassdoor"]);
      if (session?.active && !isRunning) {
        if (session.lastRunAt && Date.now() - session.lastRunAt < 20000) {
          await S().sleep(4000);
          continue;
        }
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
  if (isSearchPage() || isJobDetailPage()) checkAndResumeSession();
})();
