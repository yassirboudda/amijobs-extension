(function () {
  if (window.__AmijobsHelloworkLoaded) return;
  window.__AmijobsHelloworkLoaded = true;

  // v1.0.26 — Blacklisted companies (profil candidat)
  const VERSION = "1.0.0";
  let isRunning = false;
  let shouldStop = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const jitter = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  function log(message, level = "info") {
    const icon = level === "error" ? "❌" : level === "warn" ? "⚠️" : level === "success" ? "✅" : "ℹ️";
    console.log(`[AmiJobs Hellowork v${VERSION}] ${icon} ${message}`);
    chrome.runtime.sendMessage({ action: "addLog", message: `[Hellowork] ${message}`, level, platform: "hellowork" }).catch(() => {});
  }

  // ── Notification Sound (Web Audio API) ──────────────────────────────────
  function playNotificationSound(type = "success") {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      const gainNode = audioCtx.createGain();
      gainNode.connect(audioCtx.destination);
      gainNode.gain.value = 0.55;

      if (type === "stop") {
        // Double beep for manual stop action.
        [0, 220].forEach((delay, idx) => {
          const osc = audioCtx.createOscillator();
          osc.connect(gainNode);
          osc.type = "sine";
          osc.frequency.value = idx === 0 ? 760 : 560;
          osc.start(audioCtx.currentTime + delay / 1000);
          osc.stop(audioCtx.currentTime + delay / 1000 + 0.18);
        });
        setTimeout(() => audioCtx.close(), 1200);
        return;
      }

      if (type === "error") {
        // Double low beep for errors
        [0, 350].forEach((delay) => {
          const osc = audioCtx.createOscillator();
          osc.connect(gainNode);
          osc.type = "sine";
          osc.frequency.value = 440;
          osc.start(audioCtx.currentTime + delay / 1000);
          osc.stop(audioCtx.currentTime + delay / 1000 + 0.2);
        });
        setTimeout(() => audioCtx.close(), 1500);
      } else {
        // Single beep for success / apply
        const osc = audioCtx.createOscillator();
        osc.connect(gainNode);
        osc.type = "sine";
        osc.frequency.value = 660;
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
        setTimeout(() => audioCtx.close(), 1000);
      }
    } catch (e) {
      console.warn("[AmiJobs Hellowork] Could not play sound:", e.message);
    }
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url, window.location.origin);
      u.hash = "";
      return u.toString();
    } catch (_err) {
      return url;
    }
  }

  function isSearchPage(url = window.location.href) {
    return /\/fr-fr\/emploi\/recherche\.html/i.test(url);
  }

  function isOfferPage(url = window.location.href) {
    return /\/fr-fr\/emplois\/\d+\.html/i.test(url);
  }

  function isMultiApplyPage(url = window.location.href) {
    return /\/fr-fr\/bounce\/multiapply/i.test(url);
  }

  function isCreateAlertPage(url = window.location.href) {
    return /\/fr-fr\/bounce\/createalert/i.test(url);
  }

  function canonicalSearchContext(url) {
    try {
      const u = new URL(url, window.location.origin);
      if (!isSearchPage(u.toString())) return "";
      const params = [];
      for (const [k, v] of u.searchParams.entries()) {
        if (k === "p" || k === "page") continue;
        if (k === "k_autocomplete" || k === "l_autocomplete") continue;
        params.push([k, v]);
      }
      params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
      const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      return `${u.origin}${u.pathname}${qs ? "?" + qs : ""}`;
    } catch (_err) {
      return "";
    }
  }

  function isSameSearchContext(a, b) {
    const ca = canonicalSearchContext(a);
    const cb = canonicalSearchContext(b);
    return !!ca && ca === cb;
  }

  function isSameSearchIntent(a, b) {
    try {
      const ua = new URL(a, window.location.origin);
      const ub = new URL(b, window.location.origin);
      if (!isSearchPage(ua.toString()) || !isSearchPage(ub.toString())) return false;

      const ka = (ua.searchParams.get("k") || "").trim().toLowerCase();
      const kb = (ub.searchParams.get("k") || "").trim().toLowerCase();
      const la = (ua.searchParams.get("l") || "").trim().toLowerCase();
      const lb = (ub.searchParams.get("l") || "").trim().toLowerCase();

      if (ka || kb || la || lb) return ka === kb && la === lb;
      return isSameSearchContext(ua.toString(), ub.toString());
    } catch (_err) {
      return isSameSearchContext(a, b);
    }
  }

  function searchPageNumber(url) {
    try {
      const u = new URL(url, window.location.origin);
      const p = parseInt(u.searchParams.get("p") || u.searchParams.get("page") || "1", 10);
      return Number.isFinite(p) && p > 0 ? p : 1;
    } catch (_err) {
      return 1;
    }
  }

  function searchPageKey(url) {
    try {
      const u = new URL(url, window.location.origin);
      if (!isSearchPage(u.toString())) return canonicalUrlWithoutHash(u.toString());

      const params = [];
      for (const [k, v] of u.searchParams.entries()) {
        if (k === "p" || k === "page") continue;
        if (k === "k_autocomplete" || k === "l_autocomplete") continue;
        params.push([k, v]);
      }
      params.push(["page", String(searchPageNumber(u.toString()))]);
      params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
      const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      return `${u.origin}${u.pathname}${qs ? "?" + qs : ""}`;
    } catch (_err) {
      return canonicalUrlWithoutHash(url);
    }
  }

  function offerIdFromUrl(url = window.location.href) {
    const m1 = url.match(/\/emplois\/(\d+)\.html/i);
    if (m1) return m1[1];
    const m2 = url.match(/[?&]offerId=(\d+)/i);
    if (m2) return m2[1];
    return "";
  }

  async function getSession() {
    const { sessionHellowork: session = null } = await chrome.storage.local.get(["sessionHellowork"]);
    return session;
  }

  async function setSession(updates) {
    const session = await getSession();
    if (!session) return null;
    const next = { ...session, ...updates };
    await chrome.storage.local.set({ sessionHellowork: next });
    return next;
  }

  async function endSession(reason) {
    await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: "hellowork", reason });
    if (reason) log("Session stoppée: " + reason, "warn");
  }

  function textOf(el) {
    return (el?.textContent || "").trim();
  }

  function buttonLabel(el) {
    if (!el) return "";
    if (el.tagName === "INPUT") return (el.value || "").trim();
    return textOf(el);
  }

  function canonicalUrlWithoutHash(url = window.location.href) {
    try {
      const u = new URL(url, window.location.origin);
      u.hash = "";
      return u.toString();
    } catch (_err) {
      return String(url || "");
    }
  }

  function isOfferMainStepForm(form) {
    if (!form) return false;
    return (form.id || "").toLowerCase() === "offer-detail-main-step-form";
  }

  function getVisibleOfferMainStepForm() {
    const form = document.querySelector("#offer-detail-main-step-form");
    if (!form) return null;
    if (form.offsetParent === null) return null;
    return form;
  }

  function isLikelyFormSubmitButton(el) {
    if (!el) return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const form = el.closest("form");
    const formAttr = (el.getAttribute("form") || "").trim();
    const text = buttonLabel(el).toLowerCase();
    if (type === "submit") return true;
    if (formAttr.toLowerCase() === "offer-detail-main-step-form") return true;
    if (!form) return false;
    if (isOfferMainStepForm(form)) return true;
    return /postuler|envoyer|continuer|valider|confirmer|suivant/i.test(text);
  }

  function findFormSubmitButton() {
    let best = null;
    let bestScore = -1;
    const wanted = /postuler|envoyer|continuer|valider|confirmer/i;

    for (const el of Array.from(document.querySelectorAll("form button, form [type='submit'], button[type='submit'], input[type='submit'], button[form], input[type='submit'][form]"))) {
      if (el.offsetParent === null) continue;
      if (el.disabled) continue;

      const text = buttonLabel(el).toLowerCase();
      const form = el.closest("form");
      const formAttr = (el.getAttribute("form") || "").trim();
      const bindsMainStep = formAttr.toLowerCase() === "offer-detail-main-step-form";
      const hasValidatorAttrs =
        el.matches("[data-cy='submitButton']") ||
        el.matches("[data-form-validator-target='button']") ||
        !!el.querySelector("[data-form-validator-target='text']");

      if (!wanted.test(text) && !bindsMainStep && !hasValidatorAttrs) continue;

      let score = 1;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "submit") score += 12;
      if (form) {
        score += 10;
        if (form.querySelector("input[type='email'], input[type='file'], input[name*='FirstName'], input[name*='LastName'], select, textarea")) score += 10;
        if (form.querySelector("[required]")) score += 4;
        if (form.querySelector(".input-subtext-error, .select-error, [aria-invalid='true']")) score += 6;
        if (isOfferMainStepForm(form)) score += 18;
      }
      if (bindsMainStep) score += 22;
      if (hasValidatorAttrs) score += 10;
      if (text.includes("envoyer ma candidature")) score += 8;
      if (text.includes("continuer ma candidature")) score += 10;
      if (text === "postuler") score += 4;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best;
  }

  function findOfferMainStepSubmitButton() {
    const candidates = Array.from(document.querySelectorAll(
      "button[form='offer-detail-main-step-form'], input[type='submit'][form='offer-detail-main-step-form'], #offer-detail-main-step-form button[type='submit'], #offer-detail-main-step-form input[type='submit'], #offer-detail-step-frame [data-cy='submitButton']"
    ));

    let best = null;
    let bestScore = -1;

    for (const el of candidates) {
      if (!el || el.offsetParent === null || el.disabled) continue;

      const text = buttonLabel(el).toLowerCase();
      let score = 1;
      if ((el.getAttribute("type") || "").toLowerCase() === "submit") score += 12;
      if ((el.getAttribute("form") || "").toLowerCase() === "offer-detail-main-step-form") score += 20;
      if (el.matches("[data-cy='submitButton']")) score += 14;
      if (el.matches("[data-form-validator-target='button']")) score += 8;
      if (text.includes("continuer ma candidature")) score += 16;
      if (text.includes("continuer")) score += 10;
      if (text.includes("postuler")) score += 5;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best;
  }

  async function waitForOfferNavigation(beforeUrl, timeoutMs = 9000) {
    const before = canonicalUrlWithoutHash(beforeUrl);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(250);
      if (!isOfferPage(window.location.href)) return true;
      const now = canonicalUrlWithoutHash(window.location.href);
      if (now !== before) return true;
    }
    return false;
  }

  // ── Collect all offer links on a search page ────────────────────────────
  function collectOfferLinks() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/emplois/"]'));
    const links = [];
    const seen = new Set();
    for (const a of anchors) {
      const href = a.getAttribute("href");
      if (!href) continue;
      const abs = normalizeUrl(new URL(href, window.location.origin).toString());
      if (!isOfferPage(abs)) continue;
      const jobId = offerIdFromUrl(abs);
      const dedupeKey = jobId || abs;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const anchorText = textOf(a);
      const card =
        a.closest("article, li, [data-cy], [class*='offer'], [class*='Offer'], [class*='card']") ||
        a.parentElement;
      let company = "";
      if (card) {
        const entLink = card.querySelector('a[href*="/entreprises/"]');
        if (entLink) company = textOf(entLink);
      }
      if (!company) company = extractCompanyFromText(anchorText);
      links.push({
        url: abs,
        jobId,
        title: anchorText.substring(0, 180),
        company,
      });
    }
    return links;
  }

  function sessionSearchReturnUrl(session, currentSearch = window.location.href) {
    const resume = session?.resumeSearchUrl || "";
    const base = session?.searchUrl || "";
    if (isSearchPage(resume)) return normalizeUrl(resume);
    if (isSearchPage(base)) return normalizeUrl(base);
    if (isSearchPage(currentSearch)) return normalizeUrl(currentSearch);
    return "";
  }

  // ── Find next page URL on search results ───────────────────────────────
  function findNextPageUrl(currentSearchUrl) {
    for (const sel of ['a[rel="next"]', 'a[aria-label*="Suivant"]', 'a[aria-label*="Next"]']) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        if (el.offsetParent === null) continue;
        const href = el.getAttribute("href");
        if (!href) continue;
        const candidate = normalizeUrl(new URL(href, window.location.origin).toString());
        if (!isSearchPage(candidate)) continue;
        if (!isSameSearchIntent(currentSearchUrl, candidate)) continue;
        return candidate;
      }
    }

    // Numbered pagination: find page link after currently active one
    const pageLinks = Array.from(document.querySelectorAll('a[href*="p="], a[href*="page="]'))
      .filter((el) => {
        if (el.offsetParent === null) return false;
        const href = el.getAttribute("href");
        if (!href) return false;
        const candidate = normalizeUrl(new URL(href, window.location.origin).toString());
        if (!isSearchPage(candidate)) return false;
        return isSameSearchIntent(currentSearchUrl, candidate);
      });

    for (let i = 0; i < pageLinks.length; i++) {
      const el = pageLinks[i];
      const cls = [
        el.className || "",
        el.getAttribute("aria-current") || "",
        el.parentElement?.className || "",
      ].join(" ");
      if (/active|current|selected|is-active/i.test(cls)) {
        const next = pageLinks[i + 1];
        if (next?.getAttribute("href")) {
          const candidate = normalizeUrl(new URL(next.getAttribute("href"), window.location.origin).toString());
          if (isSearchPage(candidate) && isSameSearchIntent(currentSearchUrl, candidate)) {
            return candidate;
          }
        }
      }
    }

    // Numeric fallback, but bounded by the highest page seen in pagination links.
    try {
      const u = new URL(currentSearchUrl, window.location.origin);
      const current = parseInt(u.searchParams.get("page") || u.searchParams.get("p") || "1", 10);

      const pageNums = [];
      let preferredKey = u.searchParams.has("p") ? "p" : "page";
      for (const link of pageLinks) {
        const href = link.getAttribute("href");
        if (!href) continue;
        const lu = new URL(href, window.location.origin);
        const pRaw = lu.searchParams.get("page");
        const pAlt = lu.searchParams.get("p");
        const p = parseInt(pRaw || pAlt || "", 10);
        if (Number.isFinite(p) && p > 0) pageNums.push(p);
        if (!u.searchParams.has("page") && !u.searchParams.has("p")) {
          if (pAlt) preferredKey = "p";
          else if (pRaw) preferredKey = "page";
        }
      }

      if (pageNums.length === 0) return "";
      const maxPage = Math.max(...pageNums);
      if (!Number.isFinite(current) || current < 1 || current >= maxPage) return "";

      u.searchParams.set(preferredKey, String(current + 1));
      return normalizeUrl(u.toString());
    } catch (_err) {
      return "";
    }
  }

  // Some result pages don't render visible pagination links immediately.
  // Probe the next page via URL parameters, while session guards prevent
  // infinite traversal (`maxConsecutiveNoApplyPages` + visitedSearchUrls).
  function buildFallbackNextPageUrl(currentSearchUrl) {
    try {
      const u = new URL(currentSearchUrl, window.location.origin);
      const hasP = u.searchParams.has("p");
      const hasPage = u.searchParams.has("page");
      const cur = parseInt(u.searchParams.get("p") || u.searchParams.get("page") || "1", 10);
      if (!Number.isFinite(cur) || cur < 1 || cur >= 200) return "";

      const next = String(cur + 1);
      if (hasP && !hasPage) {
        u.searchParams.set("p", next);
      } else if (hasPage && !hasP) {
        u.searchParams.set("page", next);
      } else {
        // Unknown pagination key on this search URL: set both.
        u.searchParams.set("p", next);
        u.searchParams.set("page", next);
      }
      return normalizeUrl(u.toString());
    } catch (_err) {
      return "";
    }
  }

  // ── Blacklist Check ─────────────────────────────────────────────────────
  async function isCompanyBlacklisted(companyName) {
    if (!companyName) return false;
    try {
      const { blacklistedCompanies = [] } = await chrome.storage.local.get(["blacklistedCompanies"]);
      if (blacklistedCompanies.length === 0) return false;
      const companyLower = companyName.toLowerCase().trim();
      for (const blocked of blacklistedCompanies) {
        const blockedLower = blocked.toLowerCase().trim();
        if (!blockedLower) continue;
        if (companyLower.includes(blockedLower) || blockedLower.includes(companyLower)) {
          log(`🚫 Entreprise blacklistée: "${companyName}" (match: "${blocked}")`, "warn");
          return true;
        }
      }
    } catch (err) {
      log(`Erreur vérif blacklist: ${err.message}`, "warn");
    }
    return false;
  }

  // Extract company name from offer card text (search results) or page body
  function isLikelyNonCompanyLine(line) {
    if (!line) return true;
    if (/^(CDI|CDD|Intérim|Stage|Alternance|Freelance|Indépendant|Franchise|Associé|Fonctionnaire|Stage de lycée)/i.test(line)) return true;
    if (/^\d+\s*(offres?|emplois?|résultats?)/i.test(line)) return true;
    if (/^(il y a|there are|voir|see also|en savoir plus)/i.test(line)) return true;
    if (line.length <= 2 || line.length >= 80) return true;
    return false;
  }

  function extractCompanyFromText(text) {
    if (!text) return "";
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const candidates = lines.filter((line) => !isLikelyNonCompanyLine(line));
    // Hellowork cards: title on first line, company on the second.
    if (candidates.length >= 2) return candidates[1];
    if (candidates.length === 1) return candidates[0];
    return "";
  }

  // ── Job info from offer page DOM ───────────────────────────────────────
  function getOfferInfoFromDom() {
    const title =
      textOf(document.querySelector("h1")) ||
      textOf(document.querySelector('[data-testid*="title"]')) ||
      "Offre Hellowork";

    const company =
      textOf(document.querySelector('a[href*="/entreprises/"]')) ||
      textOf(document.querySelector('[class*="company"], [class*="Company"]')) ||
      extractCompanyFromText(document.body?.innerText || "") ||
      (() => {
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content || "";
        const m = ogTitle.match(/(?:Recrutement par|par)\s+(.+?)(?:\s*\||$)/i);
        return m ? m[1].trim() : "";
      })() ||
      (() => {
        const pageTitle = document.title || "";
        const m = pageTitle.match(/(?:Recrutement par|par)\s+(.+?)(?:\s*\||$)/i);
        return m ? m[1].trim() : "";
      })() ||
      (() => {
        const h1 = textOf(document.querySelector("h1"));
        const m = h1.match(/(?:Recrutement par|par)\s+(.+?)$/i);
        return m ? m[1].trim() : "";
      })() ||
      "";

    return { title, company };
  }

  // ── Simulate a human-like click ────────────────────────────────────────
  async function humanClick(el) {
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(jitter(180, 420));
    el.click();
    await sleep(jitter(250, 700));
    return true;
  }

  function findRecruiterSiteButton() {
    const externalTexts = [
      "postuler sur le site du recruteur",
      "sur le site du recruteur",
      "site du recruteur",
    ];
    for (const el of Array.from(document.querySelectorAll("button, a"))) {
      if (el.offsetParent === null) continue;
      const text = textOf(el).toLowerCase();
      if (!text) continue;
      if (externalTexts.some((t) => text.includes(t))) return el;
    }
    return null;
  }

  function findMultiApplySubmitButton() {
    const exactTexts = [
      "envoyer mes candidatures",
      "envoyer ma candidature",
      "je postule",
      "postuler",
    ];
    let best = null;
    let bestScore = -1;
    for (const el of Array.from(document.querySelectorAll("button, a"))) {
      if (el.offsetParent === null) continue;
      if (el.disabled) continue;
      const text = textOf(el).toLowerCase();
      if (!text) continue;
      if (!exactTexts.some((t) => text.includes(t))) continue;

      let score = 1;
      if (text.includes("envoyer mes candidatures")) score += 20;
      if (text.includes("envoyer ma candidature")) score += 14;
      if (el.tagName === "BUTTON") score += 4;
      if ((el.getAttribute("type") || "").toLowerCase() === "submit") score += 5;
      if ((el.getAttribute("data-action") || "").toLowerCase().includes("multi-apply")) score += 10;
      if (el.className && /btn-primary-candidacy/i.test(el.className)) score += 4;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  // ── Form Field Detection and Auto-Filling ──────────────────────────────
  async function getProfileFromBackground() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "getProfile" }, (profile) => {
        resolve(profile || {});
      });
    });
  }

  function isPhoneField(label) {
    return /tel|phone|téléphone|portable|mobile|numéro/i.test(label);
  }

  function isEmailField(label) {
    return /email|mail|courriel/i.test(label);
  }

  function isNameField(label) {
    return /nom|name|prénom|first|last/i.test(label);
  }

  function isCityField(label) {
    return /\bville\b|\bcity\b|commune|localit/i.test(label);
  }

  function isPostalCodeField(label) {
    return /code\s*postal|\bcp\b|postcode|zip|postal\s*code/i.test(label);
  }

  function isBirthDateField(label) {
    return /date\s*de\s*naissance|naissance|birth\s*date|\bdob\b|mm\s*[\/-]\s*jj\s*[\/-]\s*aaaa|mm\s*[\/-]\s*dd\s*[\/-]\s*yyyy|dd\s*[\/-]\s*mm\s*[\/-]\s*yyyy/i.test(label);
  }

  function isSalaryField(label) {
    return /salaire|rémunération|remuneration|prétention|pretention|k\s*€|k\/?an|annuel|€\/an/i.test(label);
  }

  function digitsOnly(value) {
    return String(value || "").replace(/\D+/g, "");
  }

  function extractPostalCode(value) {
    const m = String(value || "").match(/\b\d{5}\b/);
    return m ? m[0] : "";
  }

  function inferPostalCodeFromCity(city) {
    const c = String(city || "").toLowerCase();
    const map = {
      paris: "75000",
      lyon: "69000",
      marseille: "13000",
      lille: "59000",
      bordeaux: "33000",
      toulouse: "31000",
      nantes: "44000",
      rennes: "35000",
      strasbourg: "67000",
      nice: "06000",
      montpellier: "34000",
    };
    for (const [k, v] of Object.entries(map)) {
      if (c.includes(k)) return v;
    }
    return "";
  }

  function getProfileCity(profile) {
    if (profile?.city) return String(profile.city).trim();
    const location = String(profile?.location || "").trim();
    if (!location) return "";
    const primary = location.split(",")[0].trim();
    const city = primary.replace(/\b\d{5}\b/g, "").replace(/\s{2,}/g, " ").trim();
    return city;
  }

  function getProfilePostalCode(profile) {
    const direct = extractPostalCode(profile?.postalCode || "");
    if (direct) return direct;
    const fromLocation = extractPostalCode(profile?.location || "");
    if (fromLocation) return fromLocation;
    return inferPostalCodeFromCity(getProfileCity(profile));
  }

  function normalizeBirthDate(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";

    let m = raw.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
    if (m) return `${m[1]}/${m[2]}/${m[3]}`;

    m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;

    const digits = raw.replace(/\D+/g, "");
    if (/^\d{8}$/.test(digits)) {
      return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
    }

    return "";
  }

  function birthDateToIso(value) {
    const normalized = normalizeBirthDate(value);
    const m = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return "";
    return `${m[3]}-${m[2]}-${m[1]}`;
  }

  function getProfileBirthDate(profile) {
    return normalizeBirthDate(profile?.birthDate || "") || "01/01/2000";
  }

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }

  function isSelectPlaceholderText(text) {
    const t = normalizeText(text);
    if (!t) return true;
    return /choisir|selectionn(er|ez)|veuillez|select an option|please select|^--+$/.test(t);
  }

  function isNoticePeriodQuestion(label) {
    const t = normalizeText(label);
    return /preavis|pre-avis|disponibilite|prise de poste|date de disponibilite|delai de demarrage/.test(t);
  }

  function findNoticePeriodOption(options, availability = "") {
    const avail = normalizeText(availability);
    const optionText = (o) => normalizeText((o.title || o.text || o.value || "").trim());

    const findByPatterns = (patterns) => {
      for (const re of patterns) {
        const match = options.find((o) => re.test(optionText(o)) && !isSelectPlaceholderText(optionText(o)));
        if (match) return match;
      }
      return null;
    };

    const monthMatch = avail.match(/(\d+)\s*mois/);
    if (/immediat|des\s*que\s*possible|tout\s*de\s*suite|sans\s*preavis/.test(avail)) {
      const immediate = findByPatterns([
        /immediat/,
        /sans\s*preavis/,
        /des\s*que\s*possible/,
        /tout\s*de\s*suite/,
        /^0\s*mois?$/,
      ]);
      if (immediate) return immediate;
    } else if (monthMatch) {
      const months = parseInt(monthMatch[1], 10);
      if (Number.isFinite(months)) {
        const byMonth = findByPatterns([
          new RegExp(`\\b${months}\\s*mois?\\b`),
          new RegExp(`\\b${months}\\b`),
        ]);
        if (byMonth) return byMonth;
      }
    }

    const ordered = findByPatterns([
      /immediat/,
      /sans\s*preavis/,
      /des\s*que\s*possible/,
      /tout\s*de\s*suite/,
      /^0\s*mois?$/,
      /moins\s*d.?1\s*mois/,
      /1\s*mois/,
      /2\s*mois/,
      /3\s*mois/,
    ]);
    if (ordered) return ordered;

    return options.find((o) => !isSelectPlaceholderText(optionText(o))) || null;
  }

  function getProfileAge(profile) {
    const normalized = normalizeBirthDate(profile?.birthDate || "");
    const m = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;

    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;

    const now = new Date();
    let age = now.getFullYear() - year;
    const passedBirthday =
      now.getMonth() + 1 > month ||
      (now.getMonth() + 1 === month && now.getDate() >= day);
    if (!passedBirthday) age -= 1;

    if (!Number.isFinite(age) || age < 0 || age > 120) return null;
    return age;
  }

  function isAgeQuestion(label) {
    const t = normalizeText(label);
    return /\bage\b|tranche\s*d'?age|age\s*requis/.test(t);
  }

  function parseAgeRange(optionLabel) {
    const t = normalizeText(optionLabel);
    let m = t.match(/entre\s*(\d{1,2})\s*(?:et|-|a)\s*(\d{1,2})/);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };

    m = t.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})/);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };

    m = t.match(/(?:plus\s*de|superieur\s*a|au[- ]?dessus\s*de)\s*(\d{1,2})/);
    if (m) {
      const n = parseInt(m[1], 10);
      return { min: n + 1, max: 200 };
    }

    m = t.match(/(?:moins\s*de|inferieur\s*a|au[- ]?dessous\s*de)\s*(\d{1,2})/);
    if (m) {
      const n = parseInt(m[1], 10);
      return { min: 0, max: Math.max(n - 1, 0) };
    }

    m = t.match(/(\d{1,2})\s*ans?\s*et\s*plus/);
    if (m) {
      const n = parseInt(m[1], 10);
      return { min: n, max: 200 };
    }

    m = t.match(/(\d{1,2})\s*\+/);
    if (m) {
      const n = parseInt(m[1], 10);
      return { min: n, max: 200 };
    }

    if (/mineur/.test(t)) return { min: 0, max: 17 };
    if (/majeur/.test(t)) return { min: 18, max: 200 };
    return null;
  }

  function findAgeOption(options, age) {
    if (!Number.isFinite(age)) return null;

    const matches = [];
    for (const opt of options) {
      const label = (opt.title || opt.text || opt.value || "").trim();
      const range = parseAgeRange(label);
      if (!range) continue;
      if (age < range.min || age > range.max) continue;
      const width = Math.max(range.max - range.min, 0);
      matches.push({ opt, width, min: range.min });
    }

    if (matches.length === 0) return null;
    matches.sort((a, b) => a.width - b.width || b.min - a.min);
    return matches[0].opt;
  }

  function getProfileSalaryAnnual(profile) {
    const raw = String(profile?.salaryExpectation || "").trim().toLowerCase();
    if (!raw) return null;

    const normalized = raw
      .replace(/\u00a0/g, " ")
      .replace(/,/g, ".")
      .replace(/€|eur|euros?/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Capture "35 000", "35000", "35.5", etc.
    const tokens = normalized.match(/\d{1,3}(?:[ .]\d{3})+|\d+(?:\.\d+)?/g) || [];
    if (tokens.length === 0) return null;

    const hasKUnit = /\bk\b|k\s*\/\s*an|k\s*an/.test(normalized);
    const yearlyHint = /annuel|annuelle|par\s*an|brut\s*\/\s*an|hors\s*variables/.test(normalized);

    let n = parseFloat(tokens[0].replace(/\s+/g, "").replace(/\./g, "."));
    if (!Number.isFinite(n) || n <= 0) return null;

    // Convert common shorthand (35k, 35) to annual gross amount.
    if (hasKUnit && n < 1000) {
      n = n * 1000;
    } else if (n >= 20 && n <= 300) {
      // Typical candidate input style for yearly expectations in kEUR.
      n = n * 1000;
    } else if (yearlyHint && n < 1000) {
      n = n * 1000;
    }

    return Math.round(n);
  }

  function formatSalaryForField(field, profile, fieldHint = "") {
    const annual = getProfileSalaryAnnual(profile) || 35000;
    const asAnnual = String(Math.round(annual));
    const asK = String(Math.max(1, Math.round(annual / 1000)));

    const minLen = field.minLength > 0 ? field.minLength : 0;
    const maxLen = field.maxLength > 0 ? field.maxLength : 0;
    const hint = normalizeText(fieldHint);
    const wantsKUnit = /\bk\s*€?\s*\/?\s*an\b|\bk€\b/.test(hint);

    const wantsAnnual = !wantsKUnit && (
      /brut|annuel|annuelle|par an|hors variables|pretention|salar/.test(hint) ||
      minLen >= 5 ||
      maxLen >= 5
    );

    let candidate = wantsAnnual ? asAnnual : asK;

    if (maxLen > 0 && candidate.length > maxLen) {
      if (candidate === asAnnual && asK.length <= maxLen && (minLen === 0 || asK.length >= minLen)) {
        candidate = asK;
      } else {
        candidate = candidate.slice(0, maxLen);
      }
    }

    if (minLen > 0 && candidate.length < minLen) {
      if (candidate !== asAnnual && asAnnual.length >= minLen && (maxLen === 0 || asAnnual.length <= maxLen)) {
        candidate = asAnnual;
      }
    }

    return candidate;
  }

  function formatBirthDateForField(field, value, fieldHint = "") {
    const normalized = normalizeBirthDate(value) || "01/01/2000";
    const m = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return "01012000";

    const dd = m[1];
    const mm = m[2];
    const yyyy = m[3];
    const wantsMonthFirst = /mm\s*[\/-]\s*(jj|dd)\s*[\/-]\s*(aaaa|yyyy)/i.test(fieldHint);

    if (field.type === "date") {
      return `${yyyy}-${mm}-${dd}`;
    }

    if (field.maxLength > 0 && field.maxLength <= 8) {
      return wantsMonthFirst ? `${mm}${dd}${yyyy}` : `${dd}${mm}${yyyy}`;
    }

    return wantsMonthFirst ? `${mm}/${dd}/${yyyy}` : `${dd}/${mm}/${yyyy}`;
  }

  function getFallbackFirstName(profile) {
    const first = String(profile?.firstName || "").trim();
    if (first) return first;
    const full = String(profile?.fullName || "").trim();
    const fromFull = full.split(/\s+/)[0] || "";
    return fromFull || "John";
  }

  function getFallbackLastName(profile) {
    const last = String(profile?.lastName || "").trim();
    if (last) return last;
    const full = String(profile?.fullName || "").trim();
    const fromFull = full.split(/\s+/).slice(1).join(" ").trim();
    return fromFull || "Doe";
  }

  function inferCityFromSearchUrl(searchUrl) {
    try {
      if (!searchUrl) return "";
      const u = new URL(searchUrl, window.location.origin);
      return (u.searchParams.get("l") || "").trim();
    } catch (_err) {
      return "";
    }
  }

  function getFieldLabel(el) {
    let explicitLabel = "";
    if (el.id) {
      const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      explicitLabel = (byFor?.textContent || "").trim();
    }
    const label = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || "";
    const parent = el.closest(".field, .form-group, [class*='form'], [class*='input'], [data-controller*='input-validity']");
    const labelEl = parent?.querySelector("label, [class*='label']");
    return (explicitLabel || labelEl?.textContent || label || "").toLowerCase().trim();
  }

  function getSelectLabel(el) {
    let explicitLabel = "";
    if (el.id) {
      const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      explicitLabel = (byFor?.textContent || "").trim();
    }
    const label = el.getAttribute("aria-label") || el.name || "";
    const parent = el.closest(".field, .form-group, [class*='form'], [class*='input'], [data-controller*='input-validity']");
    const labelEl = parent?.querySelector("label, [class*='label']");
    return (explicitLabel || labelEl?.textContent || label || "").toLowerCase().trim();
  }

  function listVisibleInvalidFormFields(form) {
    if (!form) return [];
    const names = [];

    const controls = Array.from(form.querySelectorAll("input, select, textarea"));
    for (const field of controls) {
      if (!field || field.disabled || field.offsetParent === null) continue;

      let invalid = false;
      if (field.tagName === "SELECT") {
        const selectedOpt = field.options?.[field.selectedIndex] || null;
        const selectedText = (selectedOpt?.title || selectedOpt?.text || "").trim();
        const hasMeaningfulValue = String(field.value || "").trim() !== "" && !isSelectPlaceholderText(selectedText);
        if (field.required && !hasMeaningfulValue) invalid = true;
      }

      if (!invalid && typeof field.checkValidity === "function" && !field.checkValidity()) {
        invalid = true;
      }
      if (!invalid) continue;

      const label = field.tagName === "SELECT" ? getSelectLabel(field) : getFieldLabel(field);
      names.push((label || field.getAttribute("placeholder") || field.name || field.id || "champ requis").trim());
    }

    return Array.from(new Set(names)).slice(0, 6);
  }

  function setFieldValue(el, value) {
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  // ── Answer required <select> prescreening questions ─────────────────────
  async function answerSelectFields() {
    const profile = await getProfileFromBackground();
    const profileAge = getProfileAge(profile);
    const selects = Array.from(document.querySelectorAll(
      "form select, #offer-detail-step-frame select"
    ));
    let answered = 0;

    for (const sel of selects) {
      if (sel.disabled || sel.offsetParent === null) continue;

      const labelText = getSelectLabel(sel) || "question";

      // Collect non-empty, non-disabled options
      const options = Array.from(sel.options).filter(
        (o) => String(o.value || "").trim() !== "" && !o.disabled
      );
      if (options.length === 0) continue;

      const currentValue = String(sel.value || "").trim();
      const selectedOpt = sel.options?.[sel.selectedIndex] || null;
      const selectedText = (selectedOpt?.title || selectedOpt?.text || "").trim();
      const currentLooksPlaceholder = !currentValue || isSelectPlaceholderText(selectedText);
      let chosenValue = null;
      let forcedByAge = false;

      const normalizedLabel = normalizeText(labelText || "");

      // Use profile birth date to answer age-range questions, even if preselected.
      if (isAgeQuestion(normalizedLabel) && Number.isFinite(profileAge)) {
        const ageOpt = findAgeOption(options, profileAge);
        if (ageOpt?.value) {
          chosenValue = ageOpt.value;
          if (ageOpt.value === currentValue && !currentLooksPlaceholder) {
            continue; // already aligned with profile age
          }
          forcedByAge = true;
        }
      }

      if (!currentLooksPlaceholder && !forcedByAge && !sel.matches(".select-error")) continue;

      // Deterministic choice for notice-period fields.
      if (!chosenValue && isNoticePeriodQuestion(normalizedLabel)) {
        const noticeOpt = findNoticePeriodOption(options, profile?.availability || "");
        if (noticeOpt?.value) chosenValue = noticeOpt.value;
      }

      // Deterministic fallback for civility-like fields.
      if (!chosenValue && /civilit|genre|salutation|titre/i.test(normalizedLabel)) {
        const desiredCivility = String(profile?.civility || "").trim().toLowerCase();
        const matchOption = (regexp) => options.find((o) => regexp.test((o.title || o.text || "").trim().toLowerCase()));

        const monsieurMatch = matchOption(/\bmonsieur\b|\bm\.?\b|\bmr\b|\bhomme\b/);
        const madameMatch = matchOption(/\bmadame\b|\bmme\b|\bmlle\b|\bmrs\b|\bms\b|\bfemme\b/);

        if (/madame|mme|female|femme/.test(desiredCivility)) {
          chosenValue = madameMatch?.value || monsieurMatch?.value || null;
        } else if (/monsieur|mr|male|homme/.test(desiredCivility)) {
          chosenValue = monsieurMatch?.value || madameMatch?.value || null;
        } else {
          chosenValue = monsieurMatch?.value || madameMatch?.value || null;
        }
      }

      // Try Mistral AI
      try {
        if (chosenValue) {
          throw new Error("skip_ai_deterministic");
        }
        const profileForPrompt = {
          ...profile,
          // Limit CV text size to keep prompt lightweight and avoid token overflow
          cvText: (profile?.cvText || "").slice(0, 4000),
        };
        const profileContext = JSON.stringify(profileForPrompt);
        const optionsList = options.map((o) => `"${(o.title || o.text || o.value).trim()}"`).join(", ");
        const answer = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timeout")), 6000);
          chrome.runtime.sendMessage(
            {
              action: "askMistral",
              systemPrompt: `Tu es un candidat qui postule à un emploi. Profil: ${profileContext}. Réponds à la question de présélection en choisissant EXACTEMENT une option parmi celles proposées. Réponds UNIQUEMENT avec le texte exact d'une option, sans explication.`,
              userPrompt: `Question: "${labelText}"\nOptions disponibles: ${optionsList}\n\nRéponds avec le texte exact d'une option.`,
              maxTokens: 10,
            },
            (resp) => {
              clearTimeout(timer);
              resolve(resp?.answer?.trim() || null);
            }
          );
        });

        if (answer) {
          const ans = answer.toLowerCase();
          const match = options.find((o) => {
            const t = (o.title || o.text || o.value).trim().toLowerCase();
            return t === ans || t.includes(ans) || ans.includes(t);
          });
          if (match) chosenValue = match.value;
        }
      } catch (_e) {
        // AI unavailable or timed out — fall through to fallback
      }

      // Fallback: pick first available option
      if (!chosenValue) {
        const yesOpt = options.find((o) => /\boui\b/i.test((o.title || o.text || "").trim()));
        const noOpt = options.find((o) => /\bnon\b/i.test((o.title || o.text || "").trim()));
        if (yesOpt && noOpt) {
          chosenValue = noOpt.value;
        }
      }

      if (!chosenValue) {
        const fallbackOpt = options.find((o) => !isSelectPlaceholderText((o.title || o.text || o.value || "").trim())) || options[0];
        chosenValue = fallbackOpt.value;
        log(
          `⚠️ IA indisponible pour "${labelText}" — réponse par défaut: "${(fallbackOpt.title || fallbackOpt.text || fallbackOpt.value).trim()}"`,
          "warn"
        );
      }

      if (chosenValue === currentValue && !currentLooksPlaceholder && !forcedByAge) {
        continue;
      }

      sel.value = chosenValue;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("blur", { bubbles: true }));

      const chosenOpt = options.find((o) => o.value === chosenValue);
      const ageNote = forcedByAge && Number.isFinite(profileAge) ? ` (âge profil: ${profileAge} ans)` : "";
      log(
        `✅ Présélection "${labelText}" → "${(chosenOpt?.title || chosenOpt?.text || chosenValue).trim()}"${ageNote}`,
        "success"
      );
      answered++;
      await sleep(jitter(300, 600));
    }

    return answered;
  }

  async function detectAndFillForm() {
    const profile = await getProfileFromBackground();
    const session = await getSession();
    const fields = Array.from(document.querySelectorAll("input[type='text'], input[type='email'], input[type='tel'], input[type='number'], input[type='date'], input:not([type]), textarea"));
    const cityValue = getProfileCity(profile) || inferCityFromSearchUrl(session?.searchUrl || "") || "Paris";
    const postalCodeValue = getProfilePostalCode(profile) || inferPostalCodeFromCity(cityValue) || "75000";
    const birthDateValue = getProfileBirthDate(profile);
    const firstNameValue = getFallbackFirstName(profile);
    const lastNameValue = getFallbackLastName(profile);
    const phoneDigits = digitsOnly(profile.phone || "");
    const phoneValue = phoneDigits || "0600000000";
    
    let filled = 0;
    for (const field of fields) {
      if (field.disabled || field.offsetParent === null) continue;
      if (field.value && field.value.trim().length > 0) continue;

      const label = getFieldLabel(field);
      const fieldHint = [
        label,
        field.name || "",
        field.id || "",
        field.getAttribute("placeholder") || "",
      ].join(" ").toLowerCase();
      const isBirthField = isBirthDateField(fieldHint);
      let shouldFill = false;
      let value = null;

      if (isBirthField && birthDateValue) {
        value = birthDateValue;
        shouldFill = true;
      }
      else if (isPhoneField(fieldHint) && phoneValue) {
        value = phoneValue;
        shouldFill = true;
      }
      else if (isEmailField(fieldHint) && profile.email) {
        value = profile.email;
        shouldFill = true;
      }
      else if (isNameField(fieldHint) && /prénom|first/.test(fieldHint) && firstNameValue) {
        value = firstNameValue;
        shouldFill = true;
      }
      else if (isNameField(fieldHint) && /nom|last/.test(fieldHint) && lastNameValue) {
        value = lastNameValue;
        shouldFill = true;
      }
      else if (isCityField(fieldHint) && cityValue) {
        value = cityValue;
        shouldFill = true;
      }
      else if (isPostalCodeField(fieldHint) && postalCodeValue) {
        value = postalCodeValue;
        shouldFill = true;
      }
      else if (isSalaryField(fieldHint)) {
        value = formatSalaryForField(field, profile, fieldHint);
        shouldFill = true;
      }

      // Generic fallback for required text fields when we still have no value.
      if (!shouldFill && field.required) {
        if (isBirthField && birthDateValue) {
          value = birthDateValue;
          shouldFill = true;
        } else {
          const wantsNumeric =
            field.inputMode === "numeric" ||
            /\[0-9\]|\\d|^[0-9+*?()[\]{}|.-]+$/.test(field.pattern || "") ||
            /code postal|zip|postcode|téléphone|phone|mobile|portable|\bcp\b/.test(fieldHint) ||
            isSalaryField(fieldHint);

          if (wantsNumeric) {
            if (isSalaryField(fieldHint)) {
              value = formatSalaryForField(field, profile, fieldHint);
              shouldFill = true;
            }

            const exactLen = field.maxLength > 0 ? field.maxLength : field.minLength;
            if (!shouldFill && exactLen === 5 && postalCodeValue) {
              value = postalCodeValue;
              shouldFill = true;
            } else if (!shouldFill && isPhoneField(fieldHint) && phoneValue) {
              value = phoneValue;
              shouldFill = true;
            } else if (!shouldFill && exactLen === 10 && phoneValue) {
              value = phoneValue;
              shouldFill = true;
            } else if (!shouldFill && postalCodeValue && !isPhoneField(fieldHint)) {
              value = postalCodeValue;
              shouldFill = true;
            }
          } else if (cityValue && !isSalaryField(fieldHint)) {
            value = cityValue;
            shouldFill = true;
          }
        }
      }

      if (shouldFill && value) {
        let finalValue = String(value).trim();
        if (!finalValue) continue;

        if (isBirthField) {
          finalValue = formatBirthDateForField(field, finalValue, fieldHint);
        }

        // Respect common numeric constraints.
        if (!isBirthField && (field.inputMode === "numeric" || /\[0-9\]|\\d/.test(field.pattern || "") || isSalaryField(fieldHint))) {
          finalValue = digitsOnly(finalValue);
        }

        if (field.maxLength > 0 && finalValue.length > field.maxLength) {
          finalValue = finalValue.slice(0, field.maxLength);
        }

        if (field.minLength > 0 && finalValue.length < field.minLength) {
          continue;
        }

        setFieldValue(field, finalValue);
        const fieldName = label || field.getAttribute("placeholder") || field.name || field.id || "champ";
        log(`${fieldName} = ${finalValue}`, "success");
        filled++;
        await sleep(jitter(400, 800));
      }
    }
    return filled;
  }


  async function findMultiApplyButtonWithScroll() {
    for (let i = 0; i < 6; i++) {
      const btn = findMultiApplySubmitButton() || findApplyButton();
      if (btn) return btn;
      window.scrollBy({ top: 700, left: 0, behavior: "smooth" });
      await sleep(jitter(450, 900));
    }
    return findMultiApplySubmitButton() || findApplyButton();
  }

  // ── Find best apply button (scored; can exclude one element) ───────────
  function findApplyButton(opts = {}) {
    const { exclude = null } = opts;
    const wanted = [
      "postuler", "je postule", "candidater",
      "envoyer ma candidature", "envoyer mes candidatures", "postuler maintenant",
      "continuer ma candidature", "continuer", "suivant", "valider", "confirmer",
    ];
    const blocked = [
      "alerte",
      "connexion",
      "se connecter",
      "inscrire",
      "compte",
      "sauvegarder",
      "site du recruteur",
      "sur le site du recruteur",
    ];
    let best = null;
    let bestScore = -1;

    for (const el of Array.from(document.querySelectorAll("button, a, [type='submit']"))) {
      if (exclude && el === exclude) continue;
      if (el.offsetParent === null) continue;
      if (el.disabled) continue;
      const text = textOf(el).toLowerCase();
      const formAttr = (el.getAttribute("form") || "").toLowerCase();
      const bindsMainStep = formAttr === "offer-detail-main-step-form";
      const hasValidatorAttrs =
        el.matches("[data-cy='submitButton']") ||
        el.matches("[data-form-validator-target='button']") ||
        !!el.querySelector("[data-form-validator-target='text']");

      if (!text && !bindsMainStep && !hasValidatorAttrs) continue;
      if (!wanted.some((w) => text.includes(w)) && !bindsMainStep && !hasValidatorAttrs) continue;
      if (blocked.some((b) => text.includes(b))) continue;

      let score = 1;
      if (text === "je postule") score += 12;
      if (text.includes("je postule")) score += 8;
      if (text.includes("postuler maintenant")) score += 7;
      if (text.includes("envoyer ma candidature")) score += 7;
      if (text === "continuer ma candidature") score += 10;
      if (text.includes("continuer ma candidature")) score += 8;
      if ((el.getAttribute("type") || "").toLowerCase() === "submit") score += 6;
      if (el.tagName === "BUTTON") score += 3;
      if ((el.getAttribute("href") || "").includes("postuler")) score += 2;
      if (el.closest("#postuler, [id*='postuler'], [class*='apply'], [class*='Apply']")) score += 5;
      if (bindsMainStep) score += 16;
      if (hasValidatorAttrs) score += 8;
      const form = el.closest("form");
      if (form) {
        score += 8;
        if (form.querySelector("input, select, textarea")) score += 4;
        const buttons = Array.from(form.querySelectorAll("button, [type='submit'], input[type='submit']"));
        if (buttons[buttons.length - 1] === el) score += 3;
      }
      // Detect via data attribute (Hellowork form validator)
      if (el.querySelector("[data-form-validator-target='text']")) score += 6;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  async function trySubmitOfferMainStep(settings) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const form = getVisibleOfferMainStepForm();
      if (!form) return false;

      await detectAndFillForm();
      const selectsFilled = await answerSelectFields();
      if (selectsFilled > 0) {
        await sleep(jitter(400, 800));
      }

      let stepBtn = findOfferMainStepSubmitButton() || findFormSubmitButton();
      if (!stepBtn) {
        await sleep(jitter(500, 900));
        stepBtn = findOfferMainStepSubmitButton() || findFormSubmitButton();
      }

      if (!stepBtn) {
        continue;
      }

      const invalidBeforeSubmit = listVisibleInvalidFormFields(form);
      if (invalidBeforeSubmit.length > 0) {
        log(`⚠️ Étape profil incomplète — champs requis: ${invalidBeforeSubmit.join(", ")}`, "warn");
        await sleep(jitter(400, 800));
        continue;
      }

      const label = buttonLabel(stepBtn).slice(0, 80) || "Continuer ma candidature";
      log(`Étape profil — clic: "${label}" [submit]`);
      const beforeClickUrl = window.location.href;
      await humanClick(stepBtn);
      await setSession({ offerSubmitAttempted: true });

      const navigated = await waitForOfferNavigation(beforeClickUrl, 9000);
      if (navigated) return true;

      await sleep(jitter(settings.delayBetweenSteps?.min ?? 1200, settings.delayBetweenSteps?.max ?? 2200));
      const stillVisibleForm = getVisibleOfferMainStepForm();
      if (!stillVisibleForm) return true;

      const invalidAfterSubmit = listVisibleInvalidFormFields(stillVisibleForm);
      if (invalidAfterSubmit.length > 0) {
        log(`⚠️ Étape profil bloquée — champs invalides: ${invalidAfterSubmit.join(", ")}`, "warn");
      }
    }

    const fallbackForm = getVisibleOfferMainStepForm();
    if (fallbackForm && typeof fallbackForm.requestSubmit === "function") {
      try {
        if (typeof fallbackForm.reportValidity === "function" && !fallbackForm.reportValidity()) {
          const invalidFallback = listVisibleInvalidFormFields(fallbackForm);
          if (invalidFallback.length > 0) {
            log(`⚠️ Étape profil non valide (requestSubmit): ${invalidFallback.join(", ")}`, "warn");
          }
          return false;
        }
        log("Étape profil — requestSubmit() fallback");
        const beforeClickUrl = window.location.href;
        fallbackForm.requestSubmit();
        await setSession({ offerSubmitAttempted: true });
        const navigated = await waitForOfferNavigation(beforeClickUrl, 9000);
        if (navigated) return true;
      } catch (_err) {
        // Ignore and let caller continue generic flow.
      }
    }

    return false;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  PAGE HANDLERS — one dedicated function per Hellowork page type
  //
  //  Flow:  search → offer → /bounce/multiapply → /bounce/createalert → search
  //
  //  Each handler either:
  //    a) Lets the page navigate naturally (script dies, next handler picks up)
  //    b) Explicitly sets window.location.href when we need to steer
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // SEARCH PAGE: pick next unvisited offer from the queue
  async function handleSearchPage(session, settings) {
    const currentSearch = normalizeUrl(window.location.href);
    const configuredNoApplyPages = parseInt(settings.maxConsecutiveNoApplyPages || 20, 10);
    const maxNoApplyPages = Math.max(Number.isFinite(configuredNoApplyPages) ? configuredNoApplyPages : 20, 1);

    // Some Hellowork flows return directly to a search page after submit
    // (without passing through /bounce/createalert). Finalize the previous
    // offer outcome here so stats and persistence stay correct.
    if (session.phase === "offer" && session.currentOfferUrl) {
      const fallbackJobId = offerIdFromUrl(session.currentOfferUrl);
      const fallbackTitle = session.currentJobTitle || ("Offre " + (fallbackJobId || "Hellowork"));
      const fallbackCompany = session.currentJobCompany || "";

      if (session.offerSubmitAttempted) {
        await chrome.runtime.sendMessage({
          action: "markApplied", platform: "hellowork",
          jobId: fallbackJobId,
          title: fallbackTitle,
          company: fallbackCompany,
          url: session.currentOfferUrl,
        });
        log("Candidature soumise (retour recherche sans page de confirmation): " + fallbackTitle, "success");
      } else {
        await chrome.runtime.sendMessage({
          action: "markSkipped", platform: "hellowork",
          jobId: fallbackJobId,
          title: fallbackTitle,
          url: session.currentOfferUrl,
          reason: "Retour recherche sans soumission",
        });
        log("Offre ignorée (retour recherche sans soumission): " + fallbackTitle, "warn");
      }

      session = await setSession({
        phase: "search",
        currentOfferUrl: "",
        offerSubmitAttempted: false,
      });
    }

    if (!session.searchUrl) {
      session = await setSession({ searchUrl: currentSearch, resumeSearchUrl: currentSearch });
    } else if (!session.resumeSearchUrl) {
      session = await setSession({ resumeSearchUrl: currentSearch });
    }

    // Defensive guard: resume/search targets must always stay on search pages.
    const safeSearchUrl = isSearchPage(session.searchUrl || "")
      ? normalizeUrl(session.searchUrl)
      : currentSearch;
    const safeResumeUrl = isSearchPage(session.resumeSearchUrl || "")
      ? normalizeUrl(session.resumeSearchUrl)
      : safeSearchUrl;
    if (safeSearchUrl !== (session.searchUrl || "") || safeResumeUrl !== (session.resumeSearchUrl || "")) {
      session = await setSession({ searchUrl: safeSearchUrl, resumeSearchUrl: safeResumeUrl });
    }

    const preferredSearchUrl = safeResumeUrl || safeSearchUrl || currentSearch;

    // Hellowork may redirect to an unrelated search context. Keep session intent.
    if (preferredSearchUrl && !isSameSearchIntent(preferredSearchUrl, currentSearch)) {
      log("Page de recherche inattendue (redirect Hellowork) — retour session: " + preferredSearchUrl);
      window.location.href = preferredSearchUrl;
      return;
    }

    // Keep scanning current page sequence (p=2, p=3, ...), not always page 1.
    if (session.resumeSearchUrl && searchPageKey(session.resumeSearchUrl) !== searchPageKey(currentSearch)) {
      log("Retour à la page de résultats en cours: " + session.resumeSearchUrl);
      window.location.href = session.resumeSearchUrl;
      return;
    }

    // Load persistent applied/skipped jobs from storage (across all sessions)
    const stored = await chrome.storage.local.get(["appliedJobs", "skippedJobs"]);
    const persistentApplied = stored.appliedJobs || {};
    const persistentSkipped = stored.skippedJobs || {};

    const alreadyDone = Object.keys(persistentApplied).length + Object.keys(persistentSkipped).length;

    while (true) {
      if (shouldStop) return;
      session = await getSession();
      if (!session?.active) return;
      if ((session.applied || 0) >= (session.maxJobs || 25)) {
        await endSession("Objectif session atteint");
        return;
      }

      const visitedOffers = session.visitedOffers || {};
      const externalSiteOffers = session.externalSiteOffers || {};
      const allLinks = collectOfferLinks();
      const queue = allLinks.filter((item) => {
        const key = item.jobId || item.url;
        return (
          !visitedOffers[key] &&
          !externalSiteOffers[key] &&
          !persistentApplied[key] &&
          !persistentSkipped[key]
        );
      });

      log(
        `Page recherche: ${allLinks.length} offres, ${queue.length} nouvelles (${alreadyDone} déjà traitées toutes sessions)`
      );

      if (queue.length === 0) {
        const noNewOfferPages = (session.noNewOfferPages || 0) + 1;

        let nextUrl = findNextPageUrl(currentSearch);
        if (nextUrl && (!isSearchPage(nextUrl) || !isSameSearchIntent(currentSearch, nextUrl))) {
          nextUrl = "";
        }
        const seenSearch = Array.from(new Set((session.visitedSearchUrls || []).map((u) => searchPageKey(u))));
        let usedFallback = false;

        if (!nextUrl) {
          const fallbackNext = buildFallbackNextPageUrl(currentSearch);
          if (fallbackNext) {
            nextUrl = fallbackNext;
            usedFallback = true;
            log("Pagination fallback (lien suivant introuvable): " + fallbackNext, "warn");
          }
        }

        const nextSearchKey = nextUrl ? searchPageKey(nextUrl) : "";

        if (usedFallback && noNewOfferPages > maxNoApplyPages) {
          await endSession(`Fin: ${noNewOfferPages} pages consécutives sans nouvelles offres`);
          return;
        }

        if (!nextUrl || seenSearch.includes(nextSearchKey)) {
          if (noNewOfferPages > maxNoApplyPages) {
            await endSession(`Fin: ${noNewOfferPages} pages consécutives sans nouvelles offres`);
          } else {
            await endSession("Fin: toutes les pages de résultats ont été parcourues");
          }
          return;
        }

        await setSession({
          currentPage: searchPageNumber(nextUrl),
          noNewOfferPages,
          resumeSearchUrl: nextUrl,
          visitedSearchUrls: [...seenSearch, nextSearchKey],
        });
        log(`Page suivante (${noNewOfferPages}/${maxNoApplyPages} sans nouvelles): ${nextUrl}`);
        window.location.href = nextUrl;
        return;
      }

      const target = queue[0];
      const key = target.jobId || target.url;
      const companyForCheck =
        (target.company || "").trim() || extractCompanyFromText(target.title || "");

      if (companyForCheck && (await isCompanyBlacklisted(companyForCheck))) {
        await setSession({
          phase: "search",
          currentOfferUrl: "",
          visitedOffers: { ...visitedOffers, [key]: true },
        });
        await chrome.runtime.sendMessage({
          action: "markSkipped", platform: "hellowork",
          jobId: target.jobId,
          title: target.title || companyForCheck,
          url: target.url,
          reason: `Blacklistée: ${companyForCheck}`,
        });
        log(`🚫 Offre ignorée (blacklist): ${companyForCheck} — ${target.title || target.url}`, "warn");
        await sleep(jitter(400, 900));
        continue;
      }

      const { autoApplySettings = {} } = await chrome.storage.local.get(["autoApplySettings"]);
      const maxPerCo = autoApplySettings.maxApplicationsPerCompany || 0;
      if (maxPerCo > 0 && companyForCheck) {
        const countRes = await chrome.runtime.sendMessage({ action: "companyApplyCount", company: companyForCheck });
        if ((countRes?.count || 0) >= maxPerCo) {
          await setSession({
            phase: "search",
            currentOfferUrl: "",
            visitedOffers: { ...visitedOffers, [key]: true },
          });
          await chrome.runtime.sendMessage({
            action: "markSkipped", platform: "hellowork",
            jobId: target.jobId,
            title: target.title || companyForCheck,
            url: target.url,
            reason: `Limite entreprise (${companyForCheck})`,
          });
          log(`Limite entreprise atteinte: ${companyForCheck}`, "warn");
          await sleep(jitter(400, 900));
          continue;
        }
      }

      await setSession({
        phase: "offer",
        currentOfferUrl: target.url,
        currentJobTitle: target.title || "",
        currentJobCompany: companyForCheck,
        offerSubmitAttempted: false,
        noNewOfferPages: 0,
        resumeSearchUrl: currentSearch,
        visitedOffers: { ...visitedOffers, [key]: true },
      });

      log(`Ouverture offre: ${target.title || target.url}${companyForCheck ? ` @ ${companyForCheck}` : ""}`);
      await sleep(jitter(600, 1400));
      window.location.href = target.url;
      return;
    }
  }

  // OFFER PAGE: click 1st apply button, then 2nd if still on page
  // Hellowork then navigates to /bounce/multiapply — we let it happen.
  async function handleOfferPage(session, settings) {
    const { title, company } = getOfferInfoFromDom();
    const jobId = offerIdFromUrl(window.location.href);
    const offerKey = jobId || normalizeUrl(window.location.href);

    // Save job info so createalert handler can mark it applied correctly
    await setSession({
      currentJobTitle: title,
      currentJobCompany: company,
      currentOfferUrl: window.location.href,
      phase: "offer",
      offerSubmitAttempted: false,
    });
    const companyForBlacklist =
      company.trim() || extractCompanyFromText(document.body?.innerText || title);

    log(
      `Offre: "${title}" (entreprise détectée: "${company || "(non trouvée)"}", Vérification blacklist avec: "${companyForBlacklist || title}")`
    );

    if (companyForBlacklist && (await isCompanyBlacklisted(companyForBlacklist))) {
      const visitedOffers = session.visitedOffers || {};
      await setSession({
        phase: "search",
        currentOfferUrl: "",
        visitedOffers: { ...visitedOffers, [offerKey]: true },
      });
      await chrome.runtime.sendMessage({
        action: "markSkipped", platform: "hellowork",
        jobId,
        title,
        url: window.location.href,
        reason: `Blacklistée: ${company}`,
      });
      const refreshed = await getSession();
      const backUrl = sessionSearchReturnUrl(refreshed, refreshed?.resumeSearchUrl || "");
      if (backUrl) {
        await sleep(jitter(1200, 2200));
        window.location.href = backUrl;
      }
      return;
    }

    // External flow: "Postuler sur le site du recruteur" should be skipped to avoid leaving Hellowork.
    const recruiterBtn = findRecruiterSiteButton();
    if (recruiterBtn) {
      const refreshedBeforeSkip = await getSession();
      const externalSiteOffers = refreshedBeforeSkip?.externalSiteOffers || {};
      await setSession({
        phase: "search",
        currentOfferUrl: "",
        externalSiteOffers: { ...externalSiteOffers, [offerKey]: true },
      });
      await chrome.runtime.sendMessage({
        action: "markSkipped", platform: "hellowork",
        jobId,
        title,
        url: window.location.href,
        reason: "Postuler sur le site du recruteur",
      });
      log("Offre ignorée (site du recruteur): " + title, "warn");
      const refreshed = await getSession();
      const backUrl = sessionSearchReturnUrl(refreshed, refreshed?.resumeSearchUrl || "");
      if (backUrl) {
        await sleep(jitter(1200, 2200));
        window.location.href = backUrl;
      }
      return;
    }

    const firstBtn = findFormSubmitButton() || findApplyButton();
    if (!firstBtn) {
      log("Ignorée (pas de bouton postuler): " + title, "warn");
      await chrome.runtime.sendMessage({ action: "markSkipped", platform: "hellowork", jobId, title, url: window.location.href, reason: "Bouton postuler introuvable" });
      const refreshed = await getSession();
      const backUrl = sessionSearchReturnUrl(refreshed, refreshed?.resumeSearchUrl || "");
      if (backUrl) {
        await setSession({ phase: "search" });
        await sleep(jitter(2000, 4000));
        window.location.href = backUrl;
      }
      return;
    }

    const firstLabel = buttonLabel(firstBtn).slice(0, 80);
    const firstIsSubmit = isLikelyFormSubmitButton(firstBtn);
    log("1er clic postuler: \"" + firstLabel + "\"" + (firstIsSubmit ? " [submit]" : ""));
    const firstClickUrl = window.location.href;
    await humanClick(firstBtn);
    if (firstIsSubmit) {
      await setSession({ offerSubmitAttempted: true });
    }

    if (await waitForOfferNavigation(firstClickUrl, 3000)) {
      return;
    }


    // Fill any forms visible after clicking the first button
    await sleep(jitter(900, 1600));
    await detectAndFillForm();
    await answerSelectFields();

    // Hellowork pre-step: many offers require a dedicated submit bound to
    // #offer-detail-main-step-form before smart-apply fields appear.
    const preStepSubmitted = await trySubmitOfferMainStep(settings);
    if (preStepSubmitted) {
      return;
    }

    // Loop for multi-step forms (Hellowork shows "Continuer ma candidature" buttons)
    let repeatedNonSubmit = 0;
    let lastNonSubmitFingerprint = "";
    const loopExcludeButton = firstIsSubmit ? null : firstBtn;

    for (let step = 0; step < 8; step++) {
      await sleep(jitter(settings.delayBetweenSteps?.min ?? 1200, settings.delayBetweenSteps?.max ?? 2200));
      if (!isOfferPage(window.location.href)) break; // Page navigated away → done

      // Fill ALL form fields (text + selects) BEFORE looking for the submit button
      await detectAndFillForm();
      const selectsFilled = await answerSelectFields();

      // Extra wait if selects were just answered (let Stimulus controller validate)
      if (selectsFilled > 0) await sleep(jitter(500, 900));

      const nextBtn =
        findOfferMainStepSubmitButton() ||
        findFormSubmitButton() ||
        findApplyButton({ exclude: loopExcludeButton });
      if (!nextBtn) break; // No more buttons on this page

      const nextIsSubmit = isLikelyFormSubmitButton(nextBtn);
      const nextLabel = buttonLabel(nextBtn);
      const nextFp = `${nextBtn.tagName}|${(nextBtn.getAttribute("type") || "").toLowerCase()}|${(nextBtn.getAttribute("href") || "").slice(0, 120)}|${nextLabel.toLowerCase()}`;

      if (!nextIsSubmit && nextFp === lastNonSubmitFingerprint) {
        repeatedNonSubmit++;
        if (repeatedNonSubmit >= 2) {
          log(`⚠️ Même CTA non-submit détecté ("${nextLabel.slice(0, 80)}") — arrêt des clics répétitifs`, "warn");
          break;
        }
      } else if (!nextIsSubmit) {
        repeatedNonSubmit = 0;
      }
      if (!nextIsSubmit) {
        lastNonSubmitFingerprint = nextFp;
      }

      log(`Étape ${step + 2} — clic: "${nextLabel.slice(0, 80)}"${nextIsSubmit ? " [submit]" : ""}`);
      const beforeClickUrl = window.location.href;
      await humanClick(nextBtn);
      if (nextIsSubmit) {
        await setSession({ offerSubmitAttempted: true });
      }

      // If submit triggered full navigation or page-path change, stop loop.
      const navigated = await waitForOfferNavigation(beforeClickUrl, nextIsSubmit ? 9000 : 3000);
      if (navigated) return;
    }

    // Safety fallback: avoid staying stuck forever on the same offer page.
    if (isOfferPage(window.location.href)) {
      const refreshed = await getSession();
      const backUrl = sessionSearchReturnUrl(refreshed, refreshed?.resumeSearchUrl || "");
      if (backUrl) {
        log("Retour recherche (aucune navigation détectée après tentative)", "warn");
        await setSession({ phase: "search", currentOfferUrl: "", offerSubmitAttempted: false });
        await sleep(jitter(1200, 2200));
        window.location.href = backUrl;
      }
    }
    // Page navigates to multiapply → script dies → handleMultiApplyPage continues
  }

  // MULTIAPPLY PAGE: click the "Je postule" / "Postuler" button
  // Hellowork then navigates to /bounce/createalert — we let it happen.
  async function handleMultiApplyPage(session, settings) {
    log("Page multiapply — recherche bouton postuler...");
    await sleep(jitter(700, 1300)); // Let page fully render before scanning DOM

    await detectAndFillForm();
    const btn = await findMultiApplyButtonWithScroll();
    if (btn) {
      log("Clic multiapply: \"" + textOf(btn).slice(0, 80) + "\"");
      await humanClick(btn);
      // Page navigates to createalert → script dies → handleCreateAlertPage continues
      return;
    }

    // No button found — wait for auto-redirect, then go back to search
    log("Aucun bouton sur multiapply — attente redirection (4s)", "warn");
    await sleep(4000);

    if (isMultiApplyPage(window.location.href)) {
      // Still here: count as applied and go back to search
      const refreshed = await getSession();
      const jobId = offerIdFromUrl(window.location.href) || offerIdFromUrl(refreshed?.currentOfferUrl || "");
      playNotificationSound("success");
      await chrome.runtime.sendMessage({
        action: "markApplied", platform: "hellowork", jobId,
        title: refreshed?.currentJobTitle || ("Offre " + (jobId || "Hellowork")),
        company: refreshed?.currentJobCompany || "",
        url: refreshed?.currentOfferUrl || window.location.href,
      });
      const backUrl = sessionSearchReturnUrl(refreshed, refreshed?.resumeSearchUrl || "");
      if (backUrl) {
        await setSession({ phase: "search", currentOfferUrl: "" });
        window.location.href = backUrl;
      }
    }
    // Otherwise, page already redirected — next handler will pick up
  }

  // CREATEALERT PAGE: final success — mark applied and go back to session search
  async function handleCreateAlertPage(session, settings) {
    const jobId = offerIdFromUrl(window.location.href) || offerIdFromUrl(session.currentOfferUrl || "");
    const title = session.currentJobTitle || ("Offre " + (jobId || "Hellowork"));
    const company = session.currentJobCompany || "";

    log("Candidature confirmée: " + title, "success");
    playNotificationSound("success");
    await chrome.runtime.sendMessage({
      action: "markApplied", platform: "hellowork", jobId, title, company,
      url: session.currentOfferUrl || window.location.href,
    });

    const refreshed = await getSession();
    if (!refreshed?.active) return;

    if ((refreshed.applied || 0) >= (refreshed.maxJobs || 25)) {
      await endSession("Objectif session atteint");
      return;
    }

    const backUrl = sessionSearchReturnUrl(refreshed, refreshed?.resumeSearchUrl || "");
    if (!backUrl) { await endSession("Pas d'URL de recherche en session"); return; }

    await setSession({ phase: "search", currentOfferUrl: "" });

    const delay = Math.max(settings.delayBetweenJobs?.min ?? 3000, 2000);
    await sleep(delay);

    log("Retour recherche pour prochaine offre: " + backUrl);
    window.location.href = backUrl;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  MAIN SESSION RUNNER — dispatches to per-page handler
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async function runAutoApplySession() {
    if (isRunning) return;
    isRunning = true;
    try {
      const { autoApplySettings = {} } = await chrome.storage.local.get(["autoApplySettings"]);
      const settings = {
        autoSubmit: true,
        delayBetweenJobs: { min: 4000, max: 10000 },
        ...autoApplySettings,
      };

      const session = await getSession();
      if (!session?.active) { isRunning = false; return; }
      if (shouldStop) { await endSession("Arrêt demandé"); isRunning = false; return; }
      if ((session.applied || 0) >= (session.maxJobs || 25)) {
        await endSession("Objectif session atteint"); isRunning = false; return;
      }

      const url = window.location.href;
      log("[v" + VERSION + "] Page: " + new URL(url).pathname);

      if (isSearchPage(url))           await handleSearchPage(session, settings);
      else if (isOfferPage(url))       await handleOfferPage(session, settings);
      else if (isMultiApplyPage(url))  await handleMultiApplyPage(session, settings);
      else if (isCreateAlertPage(url)) await handleCreateAlertPage(session, settings);
      else log("Page non gérée: " + new URL(url).pathname, "warn");

    } catch (err) {
      log("Erreur session: " + err.message, "error");
      playNotificationSound("error");
      await chrome.runtime.sendMessage({ action: "markError", platform: "hellowork", error: err.message });
    } finally {
      isRunning = false;
    }
  }

  // Single-job manual apply from popup
  async function applySingleJob() {
    if (!isOfferPage()) { log("Ouvrir une fiche offre Hellowork d'abord", "warn"); return; }
    const session = (await getSession()) || { active: true, currentOfferUrl: window.location.href, searchUrl: "", maxJobs: 1 };
    const { autoApplySettings = {} } = await chrome.storage.local.get(["autoApplySettings"]);
    await handleOfferPage(session, { autoSubmit: true, ...autoApplySettings });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "startAutoApply") {
      runAutoApplySession().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.action === "stopAutoApply") {
      shouldStop = true;
      playNotificationSound("stop");
      log("Arrêt demandé", "warn");
      sendResponse({ ok: true });
      return;
    }
    if (msg.action === "applySingleJob") { applySingleJob().then(() => sendResponse({ ok: true })); return true; }
    if (msg.action === "getContentStatus") { sendResponse({ isRunning, shouldStop, url: window.location.href }); return; }
  });

  // Auto-resume when page loads during an active session
  setTimeout(() => {
    getSession().then((session) => { if (session?.active) runAutoApplySession(); });
  }, 1000);
})();
