// AmiJobs — Background Service Worker v1.1.0
// Unified orchestration for Hellowork, LinkedIn, Indeed & Glassdoor
// https://amijobs.com
// ============================================================================

importScripts("content/geo-boards.js");
importScripts("content/question-pref.js");

const EXT_VERSION = "1.6.3";
let lastGlassdoorSerpRestoreAt = 0;
const MISTRAL_MODEL = "mistral-large-latest";
const MISTRAL_ENDPOINT = "https://api.mistral.ai/v1/chat/completions";
const DEFAULT_MISTRAL_API_KEY = "uwqtlWhrRDIdE0QAHYkIhMFkLTbkDYIb";
const TWOCAPTCHA_CREATE = "https://api.2captcha.com/createTask";
const TWOCAPTCHA_RESULT = "https://api.2captcha.com/getTaskResult";
const CAPSOLVER_CREATE = "https://api.capsolver.com/createTask";
const CAPSOLVER_RESULT = "https://api.capsolver.com/getTaskResult";

/** AmiJobs exit API (Cloudflare-proxied). Solver keys live on the server. */
const AMIJOBS_EXIT_BASE = "https://exit.amijobs.com";
const AMIJOBS_EXIT_GATE = "NrQC9FiH9eZ3o8XDlonW8jtfvMk1fl46";

let __exitSession = null; // { sessionId, proxy, ws, deviceId }
let __exitWs = null;
let __exitPingTimer = null;

const DEFAULT_PROFILE = {
  fullName: "",
  civility: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  linkedin: "",
  location: "",
  postalCode: "",
  birthDate: "",
  title: "",
  experience: "",
  stack: "",
  education: "",
  languages: "",
  availability: "",
  salaryExpectation: "",
  coverLetterDefault: "",
  cvText: "",
};

const DEFAULT_SETTINGS = {
  maxJobsPerSession: 25,
  // 0 = no per-page cap. Set to 2 to apply 2 jobs on page 1 then flip to page 2, etc.
  maxJobsPerPage: 0,
  delayBetweenJobs: { min: 500, max: 500 },
  delayBetweenSteps: { min: 100, max: 100 },
  autoSubmit: true,
  onlyEasyApply: true,
  allowExternalApply: true,
  skipFormationOffers: true,
  maxConsecutiveNoApplyPages: 20,
  maxApplicationsPerCompany: 0,
};

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// Guard against corrupted storage (e.g. maxJobs = 25000000000000, giant delays
// that froze LinkedIn with multi-million-second pauses).
function sanitizeSettings(settings = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  s.maxJobsPerSession = clampInt(s.maxJobsPerSession, 1, 10000, 25);
  s.maxJobsPerPage = clampInt(s.maxJobsPerPage, 0, 50, 0);
  s.maxConsecutiveNoApplyPages = clampInt(s.maxConsecutiveNoApplyPages, 1, 50, 20);
  s.maxApplicationsPerCompany = clampInt(s.maxApplicationsPerCompany, 0, 100, 0);
  const dj = s.delayBetweenJobs || {};
  s.delayBetweenJobs = {
    min: clampInt(dj.min, 100, 120000, 500),
    max: clampInt(dj.max, 100, 120000, 500),
  };
  if (s.delayBetweenJobs.max < s.delayBetweenJobs.min) s.delayBetweenJobs.max = s.delayBetweenJobs.min;
  const ds = s.delayBetweenSteps || {};
  s.delayBetweenSteps = {
    min: clampInt(ds.min, 50, 20000, 100),
    max: clampInt(ds.max, 50, 20000, 100),
  };
  if (s.delayBetweenSteps.max < s.delayBetweenSteps.min) s.delayBetweenSteps.max = s.delayBetweenSteps.min;
  s.autoSubmit = s.autoSubmit !== false;
  s.onlyEasyApply = s.onlyEasyApply !== false;
  s.allowExternalApply = s.allowExternalApply !== false;
  s.skipFormationOffers = s.skipFormationOffers !== false;
  return s;
}

function boardsForQuery(query, fallbackCc = "fr") {
  const geo = globalThis.AmiJobsGeo;
  if (geo?.boardsForLocation) return geo.boardsForLocation(query, fallbackCc);
  return {
    country: fallbackCc,
    indeedOrigin: "https://fr.indeed.com",
    glassdoorOrigin: "https://www.glassdoor.fr",
    suggestCountry: String(fallbackCc || "FR").toUpperCase(),
    suggestLanguage: "fr",
  };
}

async function fetchIndeedLocationSuggestions(query, country = null, language = null) {
  const q = String(query || "").trim();
  if (!q) return [];
  const boards = boardsForQuery(q);
  const cc = country || boards.suggestCountry || "FR";
  const lang = language || boards.suggestLanguage || "en";
  try {
    const params = new URLSearchParams({
      country: cc,
      language: lang,
      count: "10",
      formatted: "1",
      query: q,
      useEachWord: "false",
    });
    const res = await fetch(`https://autocomplete.indeed.com/api/v0/suggestions/location?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map((item) => item?.suggestion).filter(Boolean);
  } catch {
    return [];
  }
}

async function resolveIndeedLocation(query) {
  const raw = String(query || "").trim();
  if (!raw) return raw;
  const suggestions = await fetchIndeedLocationSuggestions(raw);
  if (!suggestions.length) return raw;
  const exact = suggestions.find((s) => s.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  const contains = suggestions.find((s) => s.toLowerCase().includes(raw.toLowerCase()) || raw.toLowerCase().includes(s.toLowerCase()));
  return contains || suggestions[0];
}

async function normalizeLocations(locations) {
  const out = [];
  for (const loc of locations) {
    const normalized = await resolveIndeedLocation(loc);
    if (normalized && normalized !== loc) {
      await appendLog(`Lieu normalisé: "${loc}" → "${normalized}"`, "info");
    }
    out.push(normalized || loc);
  }
  return out;
}

const SESSION_KEYS = {
  hellowork: "sessionHellowork",
  linkedin: "sessionLinkedin",
  indeed: "sessionIndeed",
  glassdoor: "sessionGlassdoor",
};

const LAST_SESSION_KEYS = {
  hellowork: "lastSessionHellowork",
  linkedin: "lastSessionLinkedin",
  indeed: "lastSessionIndeed",
  glassdoor: "lastSessionGlassdoor",
};

const SUPPORTED_PLATFORMS = ["hellowork", "linkedin", "indeed", "glassdoor"];

function jobKeyPrefix(platform) {
  if (platform === "linkedin") return "li_";
  if (platform === "indeed") return "ind_";
  if (platform === "glassdoor") return "gd_";
  return "hw_";
}

function emptyPlatformSession(platform, overrides = {}) {
  const base = {
    active: true,
    platform,
    applied: 0,
    skipped: 0,
    errors: 0,
    maxJobs: 25,
    startedAt: new Date().toISOString(),
  };
  if (platform === "hellowork") {
    return {
      ...base,
      keywords: "",
      location: "",
      locations: [],
      locationIndex: 0,
      contracts: [],
      searchUrl: "",
      resumeSearchUrl: "",
      currentOfferUrl: "",
      currentJobTitle: "",
      currentJobCompany: "",
      phase: "search",
      visitedOffers: {},
      externalSiteOffers: {},
      visitedSearchUrls: [],
      noNewOfferPages: 0,
      currentPage: 0,
      ...overrides,
    };
  }
  if (platform === "indeed" || platform === "glassdoor") {
    return {
      ...base,
      keywords: "",
      location: "",
      locations: [],
      locationIndex: 0,
      contracts: [],
      searchUrl: "",
      currentPage: 0,
      pageApplied: 0,
      noApplyPages: 0,
      phase: "search",
      queue: [],
      qIndex: 0,
      currentJk: "",
      ...overrides,
    };
  }
  return {
    ...base,
    keywords: "",
    location: "",
    locations: [],
    locationIndex: 0,
    contracts: [],
    currentPage: 0,
    noEasyPages: 0,
    ...overrides,
  };
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

function freelanceAwareKeywords(keywords, contracts) {
  const kw = String(keywords || "").trim();
  const list = asArray(contracts).map((c) => String(c).toLowerCase());
  const wantsFreelance = list.some((c) => /freelance|independant|indépendant|contract/i.test(c));
  if (!wantsFreelance) return kw;
  if (/freelance/i.test(kw)) return kw;
  return kw ? `${kw} freelance` : "freelance";
}

function buildHelloworkSearchUrl(keywords, location, contracts) {
  const list = asArray(contracts);
  const qs = [];
  qs.push(`k=${encodeURIComponent(freelanceAwareKeywords(keywords, contracts) || "")}`);
  if (location) qs.push(`l=${encodeURIComponent(location)}`);
  for (const c of list) {
    const v = String(c);
    // HelloWork expects coded contract params; keep raw + common aliases
    if (/freelance/i.test(v)) qs.push(`c=${encodeURIComponent("Freelance")}`);
    else qs.push(`c=${encodeURIComponent(v)}`);
  }
  return `https://www.hellowork.com/fr-fr/emploi/recherche.html?${qs.join("&")}`;
}

const LINKEDIN_JT = {
  cdi: "F",
  "temps plein": "F",
  fulltime: "F",
  cdd: "C",
  contract: "C",
  freelance: "C",
  alternance: "C",
  apprentissage: "C",
  stage: "I",
  internship: "I",
};

function buildLinkedInSearchUrl(keywords, location, contracts, opts = {}) {
  const params = new URLSearchParams();
  const kw = freelanceAwareKeywords(keywords, contracts);
  if (kw) params.set("keywords", kw);
  if (location) params.set("location", location);
  // Easy Apply SERP filter only when company-website apply is disabled
  const allowExternal = opts.allowExternalApply === true;
  const onlyEasy = opts.onlyEasyApply !== false;
  if (onlyEasy && !allowExternal) {
    params.set("f_AL", "true");
  }
  params.set("f_TPR", "r86400");
  const codes = [...new Set(asArray(contracts).map((c) => LINKEDIN_JT[c.toLowerCase()]).filter(Boolean))];
  if (codes.length) params.set("f_JT", codes.join(","));
  const page = Number(opts.page || opts.currentPage || 0) || 0;
  if (page > 0) params.set("start", String(page * 25));
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

function buildIndeedSearchUrl(keywords, location, page = 0, contracts = []) {
  const p = new URLSearchParams();
  const kw = freelanceAwareKeywords(keywords, contracts);
  if (kw) p.set("q", kw);
  if (location) p.set("l", location);
  // Easy Apply / candidature simplifiée only
  p.set("applicationType", "1");
  p.set("iafilter", "1");
  const list = asArray(contracts).map((c) => String(c).toLowerCase());
  if (list.some((c) => /freelance|independant|indépendant|contract/i.test(c))) {
    p.set("sc", "0kf:attr(DSQF7);");
  }
  if (page > 0) p.set("start", String(page * 10));
  if (!p.has("radius")) p.set("radius", "25");
  const origin = boardsForQuery(location).indeedOrigin;
  return `${origin}/jobs?${p.toString()}`;
}

function buildGlassdoorSearchUrl(keywords, location, contracts = []) {
  // Prefer classic Job/jobs.htm + Easy Apply filter (applicationType=1)
  const p = new URLSearchParams();
  const kw = freelanceAwareKeywords(keywords, contracts);
  if (kw) p.set("sc.keyword", kw);
  if (location) p.set("sc.location", location);
  p.set("applicationType", "1");
  const origin = boardsForQuery(location).glassdoorOrigin;
  return `${origin}/Job/jobs.htm?${p.toString()}`;
}

function buildPlatformSearchUrl(platform, keywords, location, contracts, page = 0, opts = {}) {
  if (platform === "hellowork") return buildHelloworkSearchUrl(keywords, location, contracts);
  if (platform === "linkedin") return buildLinkedInSearchUrl(keywords, location, contracts, opts);
  if (platform === "indeed") return buildIndeedSearchUrl(keywords, location, page, contracts);
  if (platform === "glassdoor") return buildGlassdoorSearchUrl(keywords, location, contracts);
  return "";
}

const PLATFORM_URL_MATCH = {
  hellowork: ["hellowork.com"],
  linkedin: ["linkedin.com"],
  indeed: ["indeed.com", "indeed.fr", "smartapply.indeed.com"],
  glassdoor: ["glassdoor."],
};

let watchingIndeedFromGlassdoor = null;
let lastSmartApplyKick = 0;
let lastIndeedLoginWallAt = 0;
/** Armed while Glassdoor clicks Easy Apply without a scrapable Indeed href. */
let indeedHandoffCapture = null;
let tabEnforceLock = false;
/** platform -> chrome window id (multi-board: one window each when count>=2). */
const platformWindowIds = Object.create(null);
/** platform -> primary SERP/board tab id (persisted for stop/resume). */
const platformTabIds = Object.create(null);
const lastPlatformReopenAt = Object.create(null);
const platformReopenCount = Object.create(null);

/** secure.indeed.com/auth — must not match as Smart Apply via ?continue=… */
function isIndeedLoginWallUrl(url = "") {
  try {
    const u = new URL(String(url || ""), "https://indeed.com");
    return /(^|\.)secure\.indeed\.com$/i.test(u.hostname) && /^\/(auth|account)/i.test(u.pathname);
  } catch (_e) {
    const s = String(url || "").split(/[?#]/)[0];
    return /secure\.indeed\.com\/(auth|account)/i.test(s);
  }
}

/** True Smart Apply host/path only — never match smartapply inside ?continue=. */
function isIndeedSmartApplyUrl(url = "") {
  if (isIndeedLoginWallUrl(url)) return false;
  try {
    const u = new URL(String(url || ""), "https://indeed.com");
    const host = u.hostname.toLowerCase();
    const path = u.pathname || "";
    if (host === "smartapply.indeed.com" || host.endsWith(".smartapply.indeed.com")) return true;
    if (/(^|\.)indeed\.(com|fr)$/i.test(host) && /\/(?:beta\/)?indeedapply(?:\/|$)/i.test(path)) return true;
    if (/(^|\.)indeed\.(com|fr)$/i.test(host) && /\/apply(?:\/|$)/i.test(path)) return true;
    return false;
  } catch (_e) {
    const s = String(url || "").split(/[?#]/)[0];
    return (
      /smartapply\.indeed\.com/i.test(s) ||
      /indeed\.(com|fr)\/(?:beta\/)?indeedapply/i.test(s) ||
      /indeed\.(com|fr)\/apply(?:\/|$)/i.test(s)
    );
  }
}

/**
 * Indeed asked for login mid-session.
 * Pause dual-mode, KEEP the auth tab so the user can sign in, then auto-resume.
 * Never close the auth tab / end sessions in a loop — that caused the Connexion thrash.
 */
async function handleIndeedLoginWall(tabId, url = "") {
  const now = Date.now();
  const data = await chrome.storage.local.get([
    "sessionIndeed",
    "sessionGlassdoor",
    "amijobsMeta",
    "indeedWizardBusy",
  ]);
  const sessionIndeed = data.sessionIndeed || null;
  const sessionGlassdoor = data.sessionGlassdoor || null;
  const meta = data.amijobsMeta || {};
  const alreadyPaused = !!meta.indeedLoginRequired;

  // Dedup noisy repeats, but always refresh pause flags
  if (now - lastIndeedLoginWallAt < 5000 && alreadyPaused) {
    if (tabId != null) {
      try {
        await chrome.tabs.update(tabId, { active: true });
      } catch (_e) {}
    }
    return { ok: true, deduped: true, paused: true };
  }
  lastIndeedLoginWallAt = now;

  watchingIndeedFromGlassdoor = null;
  indeedHandoffCapture = null;

  await chrome.storage.local.set({
    amijobsMeta: {
      ...meta,
      indeedLoginRequired: true,
      indeedLoginAt: meta.indeedLoginAt || new Date().toISOString(),
      indeedLoginTabId: tabId != null ? tabId : meta.indeedLoginTabId || null,
    },
    indeedWizardBusy: null,
    glassdoorSmartApply: null,
  });

  try {
    await releaseSmartApplyLock("indeed");
  } catch (_e) {}
  try {
    await releaseSmartApplyLock("glassdoor");
  } catch (_e) {}

  // Clear in-flight Glassdoor→Indeed handoff (auth cannot finish the wizard)
  if (sessionGlassdoor?.active) {
    await chrome.storage.local.set({
      sessionGlassdoor: {
        ...sessionGlassdoor,
        awaitingIndeed: false,
        indeedHandoffDone: false,
        awaitingIndeedLogin: true,
        lastRunAt: Date.now(),
        runLockAt: 0,
      },
    });
  }

  // Drop ephemeral Glassdoor-owned Indeed session; keep native Indeed paused
  if (sessionIndeed?.active && sessionIndeed.fromGlassdoor) {
    await chrome.storage.local.set({
      sessionIndeed: {
        ...sessionIndeed,
        active: false,
        phase: "done",
        endedAt: new Date().toISOString(),
      },
      lastSessionIndeed: {
        ...sessionIndeed,
        active: false,
        endedAt: new Date().toISOString(),
      },
    });
  } else if (sessionIndeed?.active && !sessionIndeed.fromGlassdoor) {
    await chrome.storage.local.set({
      sessionIndeed: {
        ...sessionIndeed,
        pausedForLogin: true,
        phase: sessionIndeed.phase === "apply" ? "search" : sessionIndeed.phase,
        lastRunAt: Date.now(),
      },
    });
  }

  if (!alreadyPaused) {
    await appendLog(
      "Connexion Indeed requise — connectez-vous dans l'onglet Indeed; reprise auto après connexion",
      "warn",
      "indeed"
    );
  }

  // Keep auth tab open and focused so the user can actually log in
  if (tabId != null) {
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch (_e) {}
  }

  return { ok: true, blocked: true, paused: true };
}

/** Clear login pause and resume Indeed + Glassdoor after the user signs in. */
async function clearIndeedLoginGate(reason = "login_ok") {
  const data = await chrome.storage.local.get([
    "sessionIndeed",
    "sessionGlassdoor",
    "amijobsMeta",
  ]);
  const meta = data.amijobsMeta || {};
  if (!meta.indeedLoginRequired && !data.sessionIndeed?.pausedForLogin && !data.sessionGlassdoor?.awaitingIndeedLogin) {
    return { ok: true, cleared: false };
  }

  const nextMeta = { ...meta };
  delete nextMeta.indeedLoginRequired;
  delete nextMeta.indeedLoginAt;
  delete nextMeta.indeedLoginTabId;

  const updates = { amijobsMeta: nextMeta };
  if (data.sessionIndeed?.active) {
    updates.sessionIndeed = {
      ...data.sessionIndeed,
      pausedForLogin: false,
      lastRunAt: 0,
      runLockAt: 0,
    };
  }
  if (data.sessionGlassdoor?.active) {
    updates.sessionGlassdoor = {
      ...data.sessionGlassdoor,
      awaitingIndeedLogin: false,
      awaitingIndeed: false,
      indeedHandoffDone: false,
      lastRunAt: 0,
      runLockAt: 0,
    };
  }
  await chrome.storage.local.set(updates);
  await appendLog(`Indeed reconnecté (${reason}) — reprise Indeed + Glassdoor`, "success", "indeed");

  setTimeout(() => {
    const platforms = [];
    if (updates.sessionIndeed?.active || data.sessionIndeed?.active) platforms.push("indeed");
    if (updates.sessionGlassdoor?.active || data.sessionGlassdoor?.active) platforms.push("glassdoor");
    if (platforms.length) kickPlatformSessions(platforms).catch(() => {});
  }, 800);

  return { ok: true, cleared: true };
}

function urlLooksIndeedLoggedIn(url = "") {
  if (!url || isIndeedLoginWallUrl(url)) return false;
  try {
    const u = new URL(String(url), "https://indeed.com");
    const host = u.hostname.toLowerCase();
    const path = u.pathname || "";
    if (host === "smartapply.indeed.com" || host.endsWith(".smartapply.indeed.com")) return true;
    const geo = globalThis.AmiJobsGeo;
    if (geo?.isIndeedHostname ? !geo.isIndeedHostname(host) : !/(^|\.)indeed\.(com|[a-z]{2})$/i.test(host)) {
      return false;
    }
    // Jobs SERP / viewjob / apply after auth redirect
    return /\/jobs\b|\/viewjob|\/(?:beta\/)?indeedapply|\/apply\b|\/pagead\/clk|\/rc\/clk/i.test(path);
  } catch (_e) {
    const s = String(url).split(/[?#]/)[0];
    return /smartapply\.indeed\.com|indeed\.(com|[a-z]{2})\/(?:jobs|viewjob|indeedapply|apply)/i.test(s);
  }
}

function platformLoginUrl(platform, location = "") {
  if (platform === "linkedin") return "https://www.linkedin.com/login";
  if (platform === "indeed") return "https://secure.indeed.com/auth";
  if (platform === "glassdoor") {
    const origin = boardsForQuery(location).glassdoorOrigin || "https://www.glassdoor.com";
    return `${origin}/profile/login_input.htm`;
  }
  return "";
}

function platformProbeUrl(platform, location = "") {
  if (platform === "linkedin") return "https://www.linkedin.com/feed/";
  const boards = boardsForQuery(location);
  // Prefer SERP-like URLs so heuristics / CHECK_LOGIN can see job UI, not bare home.
  if (platform === "indeed") return `${boards.indeedOrigin || "https://fr.indeed.com"}/jobs`;
  if (platform === "glassdoor") {
    const origin = boards.glassdoorOrigin || "https://www.glassdoor.fr";
    return `${origin}/Job/jobs.htm`;
  }
  return "";
}

function urlHeuristicLoggedIn(platform, url = "") {
  const u = String(url || "");
  if (!u || u.startsWith("chrome") || u === "about:blank") return null;
  if (platform === "linkedin") {
    if (/\/(login|authwall|checkpoint|uas\/login)/i.test(u)) return false;
    if (/\/(feed|jobs)\//i.test(u)) return true;
    return null;
  }
  if (platform === "indeed") {
    if (isIndeedLoginWallUrl(u)) return false;
    if (urlLooksIndeedLoggedIn(u)) return true;
    // Bare indeed host /jobs landing without auth host → uncertain, not logged-out
    try {
      const parsed = new URL(u);
      if (/(^|\.)indeed\.(com|[a-z]{2})$/i.test(parsed.hostname) && !/(^|\.)secure\.|^account\./i.test(parsed.hostname)) {
        return null;
      }
    } catch (_e) {}
    return null;
  }
  if (platform === "glassdoor") {
    if (/\/profile\/login|\/join\//i.test(u)) return false;
    if (/\/Job\/|job-listing|\/member\//i.test(u)) return true;
    return null;
  }
  return null;
}

/** Hard evidence only — soft/unknown must not block Start (false positives killed multi-window). */
function isClearLoggedOutReason(reason = "") {
  return /^(login_wall|login_wall_url|auth_url|login_url|login_form|login_path|account_host|url_heuristic_auth|checkpoint)$/i.test(
    String(reason || "")
  );
}

async function waitForTabComplete(tabId, timeoutMs = 18000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete" && tab.url && !String(tab.url).startsWith("chrome")) {
        await new Promise((r) => setTimeout(r, 700));
        return tab;
      }
    } catch (_e) {
      return null;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch (_e) {
    return null;
  }
}

async function injectPlatformContent(tabId, platform) {
  if (!tabId) return;
  try {
    if (platform === "glassdoor") {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: [
          "content/geo-boards.js",
          "content/question-pref.js",
          "content/shared-autofill.js",
          "content/company-site.js",
          "content/glassdoor.js",
          "content/cloudflare-turnstile.js",
          "content/google-recaptcha.js",
        ],
      });
    } else if (platform === "linkedin") {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: ["content/company-site.js", "content/linkedin.js"],
      });
    } else if (platform === "indeed") {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: [
          "content/geo-boards.js",
          "content/question-pref.js",
          "content/shared-autofill.js",
          "content/company-site.js",
          "content/indeed.js",
          "content/cloudflare-turnstile.js",
          "content/google-recaptcha.js",
        ],
      });
    }
  } catch (_e) {
    /* already injected or restricted page */
  }
}

async function askTabLogin(tabId, platform) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { action: "CHECK_LOGIN" });
    if (r && typeof r.loggedIn === "boolean") return r;
  } catch (_e) {}
  await injectPlatformContent(tabId, platform);
  await new Promise((r) => setTimeout(r, 500));
  try {
    const r = await chrome.tabs.sendMessage(tabId, { action: "CHECK_LOGIN" });
    if (r && typeof r.loggedIn === "boolean") return r;
  } catch (_e) {}
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (typeof window.__AmijobsCheckLogin === "function" ? window.__AmijobsCheckLogin() : null),
    });
    const result = injected?.[0]?.result;
    if (result && typeof result.loggedIn === "boolean") return result;
  } catch (_e) {}
  return null;
}

/**
 * Pre-start login probe for LinkedIn / Indeed / Glassdoor.
 * HelloWork is skipped (unchanged behavior).
 * Fail-open on uncertain probes so Start still opens one window per platform.
 */
async function checkPlatformLogins(platforms = [], location = "") {
  const needCheck = (platforms || []).filter((p) => p === "linkedin" || p === "indeed" || p === "glassdoor");
  const results = {};
  const needsLogin = [];

  async function probeOne(platform) {
    const loginUrl = platformLoginUrl(platform, location);
    const probeUrl = platformProbeUrl(platform, location);
    let tabId = null;
    let created = false;
    try {
      const existing = await listPlatformTabs(platform);
      if (existing[0]?.id) {
        tabId = existing[0].id;
      } else if (probeUrl) {
        const tab = await chrome.tabs.create({ url: probeUrl, active: false });
        tabId = tab?.id || null;
        created = !!tabId;
        if (tabId) await waitForTabComplete(tabId, 12000);
      }

      let verdict = tabId ? await askTabLogin(tabId, platform) : null;
      if (!verdict) {
        const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
        const heur = urlHeuristicLoggedIn(platform, tab?.url || "");
        verdict = {
          // Uncertain (null) → optimistic allow; only hard auth URL blocks
          loggedIn: heur !== false,
          reason: heur === true ? "url_heuristic_ok" : heur === false ? "url_heuristic_auth" : "probe_failed",
          platform,
          loginUrl,
          uncertain: heur == null,
        };
      }
      if (!verdict.loginUrl) verdict.loginUrl = loginUrl;
      verdict.platform = platform;
      results[platform] = verdict;

      if (verdict.loggedIn) return;

      const reason = verdict.reason || "logged_out";
      // Soft signals (signin_cta, unknown, guest_nav, …) used to false-block Start.
      if (!isClearLoggedOutReason(reason) && reason !== "url_heuristic_auth") {
        await appendLog(
          `Login ${platform}: signal flou (${reason}) — démarrage autorisé (fail-open)`,
          "warn",
          platform
        );
        verdict.uncertain = true;
        verdict.loggedIn = true;
        results[platform] = verdict;
        return;
      }

      needsLogin.push({
        platform,
        loginUrl: verdict.loginUrl || loginUrl,
        reason,
      });
    } catch (e) {
      // Probe errors must not abort multi-window start
      results[platform] = {
        loggedIn: true,
        reason: "error_fail_open",
        platform,
        loginUrl,
        uncertain: true,
        error: String(e?.message || e),
      };
      await appendLog(
        `Login ${platform}: erreur probe — démarrage autorisé (${String(e?.message || e)})`,
        "warn",
        platform
      );
    } finally {
      if (created && tabId) {
        try {
          await chrome.tabs.remove(tabId);
        } catch (_e) {}
      }
    }
  }

  // Parallel probes — sequential 3×18s waits starved SW / delayed windows
  await Promise.all(needCheck.map((p) => probeOne(p)));

  for (const p of platforms || []) {
    if (p === "hellowork") {
      results.hellowork = { loggedIn: true, reason: "skipped", platform: "hellowork" };
    }
  }

  return { ok: true, results, needsLogin };
}

/** Mid-session login gate for LinkedIn / Glassdoor (Indeed uses handleIndeedLoginWall). */
async function handlePlatformLoginRequired(platform, { url = "", reason = "", loginUrl = "" } = {}) {
  if (platform === "indeed") {
    return handleIndeedLoginWall(null, url);
  }
  if (platform !== "linkedin" && platform !== "glassdoor") {
    return { ok: false, reason: "unsupported_platform" };
  }
  const key = SESSION_KEYS[platform];
  const data = await chrome.storage.local.get(["amijobsMeta", key]);
  const meta = data.amijobsMeta || {};
  const session = data[key];
  const flagKey = `${platform}LoginRequired`;
  const already = !!meta[flagKey];
  await chrome.storage.local.set({
    amijobsMeta: {
      ...meta,
      [flagKey]: true,
      [`${platform}LoginAt`]: meta[`${platform}LoginAt`] || new Date().toISOString(),
      [`${platform}LoginUrl`]: loginUrl || platformLoginUrl(platform),
      [`${platform}LoginReason`]: reason || "",
    },
  });
  if (session?.active) {
    await chrome.storage.local.set({
      [key]: {
        ...session,
        pausedForLogin: true,
        lastRunAt: Date.now(),
        runLockAt: 0,
      },
    });
  }
  if (!already) {
    const label = platform === "linkedin" ? "LinkedIn" : "Glassdoor";
    await appendLog(
      `Connexion ${label} requise — connectez-vous dans l'onglet puis relancez (Login required)`,
      "warn",
      platform
    );
  }
  return { ok: true, paused: true };
}

function collectLoginRequiredFromState(amijobsMeta = {}, sessions = {}) {
  const items = [];
  if (amijobsMeta?.indeedLoginRequired || sessions.sessionIndeed?.pausedForLogin) {
    items.push({
      platform: "indeed",
      loginUrl: platformLoginUrl("indeed"),
      reason: "mid_session",
      midSession: true,
    });
  }
  if (amijobsMeta?.linkedinLoginRequired || sessions.sessionLinkedin?.pausedForLogin) {
    items.push({
      platform: "linkedin",
      loginUrl: amijobsMeta.linkedinLoginUrl || platformLoginUrl("linkedin"),
      reason: amijobsMeta.linkedinLoginReason || "mid_session",
      midSession: true,
    });
  }
  if (amijobsMeta?.glassdoorLoginRequired || sessions.sessionGlassdoor?.pausedForLogin) {
    items.push({
      platform: "glassdoor",
      loginUrl: amijobsMeta.glassdoorLoginUrl || platformLoginUrl("glassdoor"),
      reason: amijobsMeta.glassdoorLoginReason || "mid_session",
      midSession: true,
    });
  }
  return items;
}

function detectPlatformFromUrl(url = "") {
  const raw = String(url || "");
  if (!raw || raw.startsWith("chrome") || raw.startsWith("about:")) return null;
  const geo = globalThis.AmiJobsGeo;
  try {
    const host = new URL(raw).hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "hellowork.com" || host.endsWith(".hellowork.com")) return "hellowork";
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
    if (geo?.isIndeedHostname?.(host) || host === "smartapply.indeed.com" || host.endsWith(".indeed.com") || /^indeed\.[a-z]{2}$/i.test(host))
      return "indeed";
    if (geo?.isGlassdoorHostname?.(host) || host.startsWith("glassdoor.")) return "glassdoor";
  } catch (_e) {
    // Fallback for incomplete URLs
    if (/^https?:\/\/([^/]*\.)?hellowork\.com(\/|$)/i.test(raw)) return "hellowork";
    if (/^https?:\/\/([^/]*\.)?linkedin\.com(\/|$)/i.test(raw)) return "linkedin";
    if (/^https?:\/\/([^/]*\.)?(smartapply\.)?indeed\.(com|[a-z]{2})(\/|$)/i.test(raw)) return "indeed";
    if (/^https?:\/\/([^/]*\.)?glassdoor\./i.test(raw)) return "glassdoor";
  }
  return null;
}

function tabMatchesPlatform(tab, platform) {
  return detectPlatformFromUrl(tab?.url || "") === platform;
}

async function listPlatformTabs(platform, windowId = null) {
  const tabs = await chrome.tabs.query(windowId != null ? { windowId } : {});
  return tabs.filter((t) => t.id && tabMatchesPlatform(t, platform));
}

async function isParallelSmartApplyEnabled() {
  // HARD OFF: "Smart Apply simultanés" spawned dozens of Loading/smartapply tabs and
  // crashed Chromium. Dual mode keeps both SERPs; only ONE Smart Apply wizard at a time.
  return false;
}

async function getPlatformWindowId(platform) {
  if (platformWindowIds[platform]) {
    try {
      await chrome.windows.get(platformWindowIds[platform]);
      return platformWindowIds[platform];
    } catch (_e) {
      delete platformWindowIds[platform];
    }
  }
  try {
    const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
    const id = amijobsMeta?.platformWindowIds?.[platform];
    if (id != null) {
      try {
        await chrome.windows.get(id);
        platformWindowIds[platform] = id;
        return id;
      } catch (_e) {}
    }
  } catch (_e) {}
  return null;
}

async function persistPlatformWindowIds() {
  try {
    const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
    if (!amijobsMeta) return;
    await chrome.storage.local.set({
      amijobsMeta: {
        ...amijobsMeta,
        platformWindowIds: { ...platformWindowIds },
        platformTabIds: { ...platformTabIds },
      },
    });
  } catch (_e) {}
}

function rememberPlatformTab(platform, tabId) {
  if (!platform || tabId == null) return;
  platformTabIds[platform] = tabId;
}

async function clearPlatformWindowMemory(platforms = null) {
  const list = Array.isArray(platforms) && platforms.length ? platforms : SUPPORTED_PLATFORMS;
  for (const p of list) {
    delete platformWindowIds[p];
    delete platformTabIds[p];
  }
  try {
    const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
    if (!amijobsMeta) return;
    const nextWin = { ...(amijobsMeta.platformWindowIds || {}) };
    const nextTab = { ...(amijobsMeta.platformTabIds || {}) };
    for (const p of list) {
      delete nextWin[p];
      delete nextTab[p];
    }
    await chrome.storage.local.set({
      amijobsMeta: { ...amijobsMeta, platformWindowIds: nextWin, platformTabIds: nextTab },
    });
  } catch (_e) {}
}

function pickTabToKeep(tabs, preferredUrl = "") {
  if (!tabs.length) return null;
  const pref = String(preferredUrl || "");
  if (/smartapply|indeedapply/i.test(pref)) {
    const sa = tabs.find((t) => /smartapply|indeedapply/i.test(t.url || ""));
    if (sa) return sa;
  }
  // If an apply wizard is open, keep THAT tab (never kill Smart Apply to keep SERP)
  const applying = tabs.find((t) => /smartapply\.indeed\.com|indeedapply|\/easy-apply|EasyApplyModal/i.test(t.url || ""));
  if (applying) return applying;

  const active = tabs.find((t) => t.active);
  if (active) return active;
  // Prefer existing search SERP over a blank/new tab
  const serp = tabs.find((t) =>
    /\/jobs|Job\/jobs|hellowork\.com\/fr-fr\/emplois|linkedin\.com\/jobs/i.test(t.url || "")
  );
  if (serp) return serp;
  return tabs[0];
}

/** HARD RULE: at most one browser tab per job board. Never create a second.
 * Indeed exception: SERP + ONE Smart Apply may coexist — never navigate Apply→SERP. */
async function ensureSinglePlatformTab(platform, url, { active = false, forceNavigate = true, windowId = null } = {}) {
  const targetWindowId =
    windowId != null ? windowId : (await getPlatformWindowId(platform)) || null;

  // Indeed: keep board + apply as separate slots
  if (platform === "indeed") {
    const tabs = await listPlatformTabs("indeed");
    // Glassdoor Easy Apply often lands on viewjob / rc/clk — treat as APPLY slot so we
    // never force-navigate the SERP tab (that causes "Onglets indeed fusionnés").
    const wantApply = /smartapply|indeedapply|applybyapplyablejobid|\/viewjob|\/pagead\/clk|\/rc\/clk|\/apply\b/i.test(
      String(url || "")
    );
    const isApplyTab = (t) => {
      const raw = String(t.url || "");
      if (!raw || raw === "about:blank" || raw.startsWith("chrome://")) {
        // Pending Smart Apply tabs often show as Loading… / about:blank briefly
        return !!t.pendingUrl && /smartapply|indeedapply|applybyapplyablejobid/i.test(t.pendingUrl);
      }
      if (isIndeedLoginWallUrl(raw)) return false;
      try {
        const u = new URL(raw, "https://indeed.com");
        return /smartapply|indeedapply|applybyapplyablejobid|\/viewjob|\/pagead\/clk|\/rc\/clk/i.test(
          `${u.hostname}${u.pathname}`
        );
      } catch (_e) {
        return /smartapply|indeedapply|applybyapplyablejobid|\/viewjob|\/pagead\/clk|\/rc\/clk/i.test(
          raw.split(/[?#]/)[0]
        );
      }
    };
    const applyTabs = tabs.filter((t) => isApplyTab(t));
    const boardTabs = tabs.filter((t) => !isApplyTab(t) && !isIndeedLoginWallUrl(t.url || ""));
    const pool = wantApply ? applyTabs : boardTabs;
    const otherPool = wantApply ? boardTabs : applyTabs;

    // Cap to ONE tab in the target pool — close every duplicate (including Loading…)
    let keep = pickTabToKeep(pool, url) || pool[0] || null;
    if (keep) {
      for (const t of pool) {
        if (t.id === keep.id) continue;
        try {
          await chrome.tabs.remove(t.id);
        } catch (_e) {}
      }
    }
    // Cap other pool (board) to 1 as well (without navigating it)
    if (otherPool.length > 1) {
      const keepOther = pickTabToKeep(otherPool, wantApply ? "/jobs" : "smartapply") || otherPool[0];
      for (const t of otherPool) {
        if (keepOther && t.id === keepOther.id) continue;
        try {
          await chrome.tabs.remove(t.id);
        } catch (_e) {}
      }
    }

    if (keep?.id) {
      const patch = {};
      if (active) patch.active = true;
      // Never navigate while Cloudflare challenge is showing — reload = new Ray ID thrash
      if (tabLooksLikeCloudflareChallenge(keep) || (await isCloudflarePauseActive())) {
        if (active) {
          try {
            await chrome.tabs.update(keep.id, { active: true });
          } catch (_e) {}
        }
        if (!wantApply) rememberPlatformTab(platform, keep.id);
        return keep.id;
      }
      // Never turn a SERP board tab into an apply URL
      if (forceNavigate && url && keep.url !== url) {
        const keepIsBoard = !isApplyTab(keep);
        if (!(wantApply && keepIsBoard)) patch.url = url;
      }
      if (Object.keys(patch).length) {
        try {
          await chrome.tabs.update(keep.id, patch);
        } catch (_e) {}
      }
      // Need apply tab but only had board → create apply tab
      if (wantApply && !isApplyTab(keep) && url) {
        try {
          const created = await chrome.tabs.create({
            url,
            active: !!active,
            ...(targetWindowId != null ? { windowId: targetWindowId } : {}),
          });
          if (!wantApply && keep.id) rememberPlatformTab(platform, keep.id);
          return created?.id || keep.id;
        } catch (_e) {
          rememberPlatformTab(platform, keep.id);
          return keep.id;
        }
      }
      if (!wantApply) rememberPlatformTab(platform, keep.id);
      return keep.id;
    }

    if (!url) return null;
    try {
      const created = await chrome.tabs.create({
        url,
        active: !!active,
        ...(targetWindowId != null ? { windowId: targetWindowId } : {}),
      });
      if (created?.id != null && !wantApply) rememberPlatformTab(platform, created.id);
      return created?.id || null;
    } catch (_e) {
      return null;
    }
  }

  const tabs = await listPlatformTabs(platform, targetWindowId);
  const keep = pickTabToKeep(tabs, url);
  const extras = tabs.filter((t) => keep && t.id !== keep.id);

  // Close duplicates first (cap to avoid runaway remove storms)
  for (const t of extras.slice(0, 12)) {
    try {
      await chrome.tabs.remove(t.id);
    } catch (_e) {
      /* ignore */
    }
  }

  if (keep?.id) {
    const patch = {};
    if (active) patch.active = true;
    if (tabLooksLikeCloudflareChallenge(keep) || (await isCloudflarePauseActive())) {
      if (active) {
        try {
          await chrome.tabs.update(keep.id, { active: true });
        } catch (_e) {}
      }
      rememberPlatformTab(platform, keep.id);
      return keep.id;
    }
    if (forceNavigate && url && keep.url !== url) patch.url = url;
    if (Object.keys(patch).length) {
      try {
        await chrome.tabs.update(keep.id, patch);
      } catch (_e) {
        /* ignore */
      }
    }
    rememberPlatformTab(platform, keep.id);
    return keep.id;
  }

  if (!url) return null;
  try {
    const created = await chrome.tabs.create({
      url,
      active: !!active,
      ...(targetWindowId != null ? { windowId: targetWindowId } : {}),
    });
    if (created?.id != null) rememberPlatformTab(platform, created.id);
    return created?.id || null;
  } catch (_e) {
    return null;
  }
}

async function enforceOneTabPerPlatform(reason = "") {
  if (tabEnforceLock) return;
  tabEnforceLock = true;
  try {
    for (const platform of SUPPORTED_PLATFORMS) {
      const tabs = await listPlatformTabs(platform);
      if (tabs.length <= 1) continue;

      // Indeed: 1 SERP + 1 Apply max (+ keep login wall while user signs in)
      if (platform === "indeed") {
        const maxApply = 1;
        const isLoginTab = (t) => isIndeedLoginWallUrl(t.url || "");
        const isApplyTab = (t) => {
          const raw = String(t.url || "");
          if (!raw || raw === "about:blank" || raw.startsWith("chrome://")) {
            return !!t.pendingUrl && /smartapply|indeedapply|applybyapplyablejobid/i.test(t.pendingUrl);
          }
          if (isLoginTab(t)) return false;
          try {
            const u = new URL(raw, "https://indeed.com");
            const hostPath = `${u.hostname}${u.pathname}`;
            return /smartapply|indeedapply|applybyapplyablejobid|\/viewjob|\/pagead\/clk|\/rc\/clk/i.test(hostPath);
          } catch (_e) {
            const s = raw.split(/[?#]/)[0];
            return /smartapply|indeedapply|applybyapplyablejobid|\/viewjob|\/pagead\/clk|\/rc\/clk/i.test(s);
          }
        };
        const loginTabs = tabs.filter((t) => isLoginTab(t));
        const applyTabs = tabs.filter((t) => isApplyTab(t));
        const boardTabs = tabs.filter((t) => !isApplyTab(t) && !isLoginTab(t));
        const keepBoard = pickTabToKeep(boardTabs, "/jobs");
        const keepLogin = pickTabToKeep(loginTabs, "/auth") || loginTabs[0] || null;
        const sortedApply = [...applyTabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        const keepApply = sortedApply[0] || null;
        const { amijobsMeta = null } = await chrome.storage.local.get(["amijobsMeta"]);
        const loginPause = !!amijobsMeta?.indeedLoginRequired;
        // ALWAYS cull extra apply tabs — wizardHot must not protect tab storms
        for (const t of applyTabs) {
          if (loginPause || (keepApply && t.id === keepApply.id)) continue;
          try {
            await chrome.tabs.remove(t.id);
          } catch (_e) {}
        }
        for (const t of boardTabs) {
          if (keepBoard && t.id !== keepBoard.id) {
            try {
              await chrome.tabs.remove(t.id);
            } catch (_e) {}
          }
        }
        for (const t of loginTabs) {
          if (keepLogin && t.id !== keepLogin.id) {
            try {
              await chrome.tabs.remove(t.id);
            } catch (_e) {}
          }
        }
        if (reason && (applyTabs.length > maxApply || boardTabs.length > 1)) {
          await appendLog(`Onglets indeed fusionnés (SERP+Apply) — ${reason}`, "warn", platform);
        }
        continue;
      }

      // Glassdoor: keep job-detail + search briefly — closing the detail tab kills Easy Apply mid-click
      if (platform === "glassdoor") {
        const detailTabs = tabs.filter((t) =>
          /jobListing|job-listing|jl=|partner\/jobListing|\/Emploi\//i.test(t.url || "")
        );
        const searchTabs = tabs.filter(
          (t) =>
            !/jobListing|job-listing|jl=|partner\/jobListing|\/Emploi\//i.test(t.url || "") &&
            /glassdoor\.(com|fr)/i.test(t.url || "")
        );
        const keepDetail = pickTabToKeep(detailTabs) || detailTabs[0] || null;
        const keepSearch = pickTabToKeep(searchTabs, "/Job/jobs") || searchTabs[0] || null;
        // Prefer keeping detail when both exist (apply in progress)
        if (keepDetail && keepSearch) {
          for (const t of detailTabs) {
            if (t.id !== keepDetail.id) {
              try {
                await chrome.tabs.remove(t.id);
              } catch (_e) {}
            }
          }
          for (const t of searchTabs) {
            if (t.id !== keepSearch.id) {
              try {
                await chrome.tabs.remove(t.id);
              } catch (_e) {}
            }
          }
          if (reason && (detailTabs.length > 1 || searchTabs.length > 1)) {
            await appendLog(`Onglets glassdoor fusionnés (SERP+détail) — ${reason}`, "warn", platform);
          }
          continue;
        }
      }

      const keep = pickTabToKeep(tabs);
      for (const t of tabs) {
        if (!keep || t.id === keep.id) continue;
        try {
          await chrome.tabs.remove(t.id);
        } catch (_e) {
          /* ignore */
        }
      }
      if (reason) {
        await appendLog(`Onglets ${platform} fusionnés (max 1) — ${reason}`, "warn", platform);
      }
    }
  } finally {
    tabEnforceLock = false;
  }
}

async function openPlatformWindowWithRetry(platform, url, { focused = false, left = 40, top = 40 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const win = await chrome.windows.create({
        url,
        type: "normal",
        focused: !!focused,
        width: 1180,
        height: 900,
        left,
        top,
      });
      if (win?.id != null) {
        platformWindowIds[platform] = win.id;
        const tabId = win.tabs?.[0]?.id;
        if (tabId != null) rememberPlatformTab(platform, tabId);
        await persistPlatformWindowIds();
        await appendLog(
          `Fenêtre ${platform}: créée id=${win.id} tab=${tabId ?? "?"} (tentative ${attempt})`,
          "success",
          platform
        );
        return { ok: true, windowId: win.id, tabId: tabId ?? null, attempt };
      }
      lastErr = new Error("windows.create_no_id");
    } catch (e) {
      lastErr = e;
      await appendLog(
        `Fenêtre ${platform}: windows.create échec tentative ${attempt} (${String(e?.message || e)})`,
        "warn",
        platform
      );
      if (attempt < 2) await new Promise((r) => setTimeout(r, 280));
    }
  }
  return { ok: false, error: lastErr };
}

async function openPlatformTabs(urls, platforms) {
  const ordered = Array.isArray(platforms) && platforms.length
    ? platforms.filter((p) => SUPPORTED_PLATFORMS.includes(p) && urls[p])
    : SUPPORTED_PLATFORMS.filter((p) => urls[p]);

  await appendLog(
    `Ouverture multi-board: ${ordered.length} plateforme(s) sélectionnée(s) → ${ordered.join(", ") || "(aucune)"}`,
    "info"
  );

  // 2+ boards → one Chrome window each (must stay reliable even if Exit/login fail later)
  const useWindows = ordered.length >= 2;
  let first = true;
  let left = 40;
  let openedWindows = 0;
  let openedTabs = 0;
  const results = [];

  for (const p of ordered) {
    if (!urls[p]) {
      results.push({ platform: p, mode: "skip", reason: "no_url" });
      continue;
    }
    if (useWindows) {
      const created = await openPlatformWindowWithRetry(p, urls[p], {
        focused: first,
        left,
        top: 40,
      });
      if (created.ok) {
        openedWindows += 1;
        if (created.tabId != null) openedTabs += 1;
        results.push({ platform: p, mode: "window", windowId: created.windowId, tabId: created.tabId });
      } else {
        await appendLog(
          `Fenêtre ${p}: échec définitif — fallback onglet (${String(created.error?.message || created.error || "unknown")})`,
          "warn",
          p
        );
        try {
          const tabId = await ensureSinglePlatformTab(p, urls[p], { active: first, forceNavigate: true });
          if (tabId != null) {
            rememberPlatformTab(p, tabId);
            openedTabs += 1;
            await persistPlatformWindowIds();
          }
          results.push({ platform: p, mode: "tab_fallback", tabId: tabId ?? null });
        } catch (e2) {
          await appendLog(
            `Onglet ${p}: fallback aussi en échec (${String(e2?.message || e2)})`,
            "error",
            p
          );
          results.push({ platform: p, mode: "failed", error: String(e2?.message || e2) });
        }
      }
      left += 72;
      // Pause so Chrome does not coalesce / drop rapid window.create calls
      await new Promise((r) => setTimeout(r, first ? 220 : 320));
    } else {
      try {
        const tabId = await ensureSinglePlatformTab(p, urls[p], { active: first, forceNavigate: true });
        if (tabId != null) {
          rememberPlatformTab(p, tabId);
          openedTabs += 1;
          await persistPlatformWindowIds();
        }
        results.push({ platform: p, mode: "tab", tabId: tabId ?? null });
        await appendLog(`Onglet ${p}: ouvert tab=${tabId ?? "?"}`, "info", p);
      } catch (e) {
        await appendLog(`Onglet ${p}: échec (${String(e?.message || e)})`, "error", p);
        results.push({ platform: p, mode: "failed", error: String(e?.message || e) });
      }
    }
    first = false;
  }

  await persistPlatformWindowIds();
  if (useWindows) {
    await appendLog(
      `Fenêtres ouvertes: ${openedWindows}/${ordered.length} · onglets suivis: ${openedTabs} (${ordered.join(", ")})`,
      openedWindows === ordered.length ? "success" : "warn"
    );
  } else {
    await appendLog(
      `Onglets ouverts: ${openedTabs}/${ordered.length} (${ordered.join(", ")})`,
      openedTabs === ordered.length ? "success" : "warn"
    );
  }

  try {
    await enforceOneTabPerPlatform("démarrage session");
  } catch (e) {
    await appendLog(`enforceOneTabPerPlatform: ${String(e?.message || e)}`, "warn");
  }

  return { ok: openedWindows + openedTabs > 0 || ordered.length === 0, useWindows, openedWindows, openedTabs, ordered, results };
}

async function navigatePlatformTab(platform, url) {
  const windowId = await getPlatformWindowId(platform);
  return ensureSinglePlatformTab(platform, url, {
    active: false,
    forceNavigate: true,
    windowId,
  });
}

let externalApplyTabId = null;
let pendingExternalTabWatch = null;

chrome.tabs.onCreated.addListener((tab) => {
  if (!pendingExternalTabWatch) return;
  if (Date.now() - (pendingExternalTabWatch.at || 0) > (pendingExternalTabWatch.timeoutMs || 12000)) {
    pendingExternalTabWatch = null;
    return;
  }
  const url = tab.pendingUrl || tab.url || "";
  if (url && !url.startsWith("chrome") && !/linkedin\.com/i.test(url)) {
    pendingExternalTabWatch.url = url;
    pendingExternalTabWatch.tabId = tab.id;
    externalApplyTabId = tab.id;
  } else if (tab.id) {
    // URL may fill in later
    pendingExternalTabWatch.tabId = tab.id;
    externalApplyTabId = tab.id;
    const watchId = tab.id;
    const check = (id, info, t) => {
      if (id !== watchId || !info.url) return;
      if (!/linkedin\.com/i.test(info.url) && !info.url.startsWith("chrome")) {
        if (pendingExternalTabWatch) {
          pendingExternalTabWatch.url = info.url;
          pendingExternalTabWatch.tabId = id;
        }
        chrome.tabs.onUpdated.removeListener(check);
      }
    };
    chrome.tabs.onUpdated.addListener(check);
    setTimeout(() => chrome.tabs.onUpdated.removeListener(check), 15000);
  }
});

function isMassApplyJobBoardUrl(url) {
  try {
    const u = new URL(String(url || ""), "https://example.com");
    const h = (u.hostname || "").toLowerCase();
    if (/(^|\.)indeed\.com$/.test(h) || h === "smartapply.indeed.com") return true;
    if (/(^|\.)glassdoor\./.test(h)) return true;
    return false;
  } catch (_e) {
    return false;
  }
}

async function injectExternalApplyScripts(tabId) {
  try {
    // Company career sites need optional host access (not granted by default)
    if (chrome.permissions?.request) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.url && !isMassApplyJobBoardUrl(tab.url) && !/linkedin\.com|hellowork\.com/i.test(tab.url)) {
          await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] });
        }
      } catch (_e) {}
    }
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content/shared-autofill.js", "content/google-recaptcha.js", "content/external-apply.js"],
    });
  } catch (_e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: ["content/shared-autofill.js", "content/google-recaptcha.js", "content/external-apply.js"],
      });
    } catch (_e2) {}
  }
}

async function openExternalApply(msg = {}) {
  let url = String(msg.url || "").trim();
  const jobInfo = msg.jobInfo || {};

  // Prefer a tab captured from LinkedIn window.open / target=_blank
  if (pendingExternalTabWatch?.tabId) {
    try {
      const t = await chrome.tabs.get(pendingExternalTabWatch.tabId);
      externalApplyTabId = t.id;
      if (!url && (pendingExternalTabWatch.url || t.url) && !/linkedin\.com/i.test(pendingExternalTabWatch.url || t.url || "")) {
        url = pendingExternalTabWatch.url || t.url;
      }
    } catch (_e) {}
  }

  if (!url) {
    return { ok: false, success: false, reason: "no_url" };
  }

  // Never open job-board pages as "company site" — causes HelloWork #postuler open/close loops
  const isBoard =
    /hellowork\.com|indeed\.(com|fr)|smartapply\.indeed|glassdoor\.(com|fr)/i.test(url) ||
    (/linkedin\.com/i.test(url) && !/externalApply|offsite|\/jobs\/view\/external/i.test(url));
  if (isBoard) {
    await appendLog(`Refus site entreprise (URL job board): ${url.slice(0, 100)}`, "warn", "external");
    return { ok: false, success: false, reason: "job_board_url", url };
  }

  // Free-Work / Malt / etc. are partner boards, not employer ATS — never open them
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    if (
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
    ) {
      await appendLog(`Refus partenaire non supporté: ${host}`, "warn", "external");
      return { ok: false, success: false, reason: "unsupported_partner", url };
    }
  } catch (_e) {}

  await chrome.storage.local.set({
    sessionExternalApply: {
      active: true,
      done: false,
      ok: false,
      url,
      jobInfo,
      sourcePlatform: msg.sourcePlatform || msg.platform || "linkedin",
      startedAt: Date.now(),
    },
  });
  await appendLog(`Ouverture site entreprise: ${jobInfo.title || url.slice(0, 80)}`, "info", "external");

  let tabId = externalApplyTabId;
  try {
    if (tabId) await chrome.tabs.get(tabId);
  } catch (_e) {
    tabId = null;
  }

  if (tabId) {
    const cur = await chrome.tabs.get(tabId).catch(() => null);
    const curUrl = cur?.url || "";
    if (!curUrl.includes(url.slice(0, 40)) && !/linkedin\.com/i.test(url)) {
      await chrome.tabs.update(tabId, { url, active: false });
    }
  } else {
    // Close stale Free-Work / Google-login leftovers from previous attempts
    try {
      const all = await chrome.tabs.query({});
      for (const t of all) {
        const u = t.url || "";
        if (
          /free-work\.com|accounts\.google\.com|welcomekit\.co|greenhouse\.io|lever\.co/i.test(u) &&
          !detectPlatformFromUrl(u)
        ) {
          await chrome.tabs.remove(t.id).catch(() => {});
        }
      }
    } catch (_e) {}
    const created = await chrome.tabs.create({ url, active: false });
    tabId = created?.id || null;
    externalApplyTabId = tabId;
  }
  if (!tabId) return { ok: false, success: false, reason: "tab_create_failed" };

  const waitLoad = () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve("timeout");
      }, 25000);
      function listener(id, info) {
        if (id === tabId && info.status === "complete") {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve("complete");
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  await waitLoad();

  // Follow LinkedIn redirect wrappers to the real ATS URL
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url && !/linkedin\.com/i.test(tab.url)) {
      url = tab.url;
      await chrome.storage.local.set({
        sessionExternalApply: {
          ...(await chrome.storage.local.get(["sessionExternalApply"])).sessionExternalApply,
          url,
        },
      });
    }
  } catch (_e) {}

  await injectExternalApplyScripts(tabId);
  await new Promise((r) => setTimeout(r, 1200));

  try {
    const kick = await chrome.tabs.sendMessage(tabId, { action: "startExternalApply", jobInfo });
    if (kick?.reason === "navigating_to_ats") {
      await appendLog("Navigation vers formulaire ATS…", "info", "external");
    }
  } catch (_e) {
    await injectExternalApplyScripts(tabId);
    try {
      await chrome.tabs.sendMessage(tabId, { action: "startExternalApply", jobInfo });
    } catch (e2) {
      await appendLog(`Injection site entreprise échouée: ${e2.message}`, "error", "external");
    }
  }

  // Poll for result — fail fast on login walls; keep ~75s for real ATS (WelcomeKit)
  const deadline = Date.now() + 75000;
  let lastInjectUrl = "";
  while (Date.now() < deadline) {
    const { sessionExternalApply = null } = await chrome.storage.local.get(["sessionExternalApply"]);
    if (sessionExternalApply?.done) {
      pendingExternalTabWatch = null;
      return {
        ok: !!sessionExternalApply.ok,
        success: !!sessionExternalApply.ok,
        reason: sessionExternalApply.reason || "",
        url: sessionExternalApply.url || url,
      };
    }
    try {
      const t = await chrome.tabs.get(tabId);
      const cur = t?.url || "";
      if (/accounts\.google\.com|\/signin|\/login|auth0\.com|okta\.com|microsoftonline\.com/i.test(cur)) {
        await chrome.storage.local.set({
          sessionExternalApply: {
            ...(sessionExternalApply || {}),
            active: false,
            done: true,
            ok: false,
            reason: "login_wall",
            url: cur,
            finishedAt: Date.now(),
          },
        });
        await appendLog(`Site entreprise: login requis — skip (${cur.slice(0, 80)})`, "warn", "external");
        pendingExternalTabWatch = null;
        return { ok: false, success: false, reason: "login_wall", url: cur };
      }
      if (
        t?.status === "complete" &&
        cur &&
        cur !== lastInjectUrl &&
        !/google\.com\/recaptcha|about:blank/i.test(cur)
      ) {
        lastInjectUrl = cur;
        await injectExternalApplyScripts(tabId);
        if (/welcomekit|greenhouse|lever|workable|ashby/i.test(cur)) {
          chrome.tabs.sendMessage(tabId, { action: "startExternalApply", jobInfo }).catch(() => {});
        }
        // WelcomeKit post-submit page
        if (/welcomekit\.co\/candidates(\?|$)/i.test(cur) && !/\/candidates\/new/i.test(cur)) {
          await chrome.storage.local.set({
            sessionExternalApply: {
              ...(sessionExternalApply || {}),
              active: false,
              done: true,
              ok: true,
              reason: "welcomekit_submitted",
              url: cur,
              finishedAt: Date.now(),
            },
          });
          await appendLog("Site entreprise: OK — WelcomeKit soumis", "success", "external");
          continue;
        }
      }
    } catch (_e) {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  await chrome.storage.local.set({
    sessionExternalApply: {
      active: false,
      done: true,
      ok: false,
      reason: "timeout",
      url,
      jobInfo,
    },
  });
  pendingExternalTabWatch = null;
  return { ok: false, success: false, reason: "timeout", url };
}

/** Write stored CV to disk then attach via CDP DOM.setFileInputFiles (React ignores DataTransfer). */
async function materializeCvFileToDisk() {
  const { cvFile = null } = await chrome.storage.local.get(["cvFile"]);
  if (!cvFile?.base64) return { ok: false, reason: "no_cv_file" };
  const safeName = String(cvFile.name || "cv.pdf")
    .replace(/[^\w.\- ()]+/g, "_")
    .slice(0, 80);
  const filename = `AmiJobsTemp/${Date.now()}_${safeName || "cv.pdf"}`;
  const mime = cvFile.mime || "application/pdf";
  const url = `data:${mime};base64,${cvFile.base64}`;

  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, conflictAction: "overwrite", saveAs: false },
      (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      }
    );
  });

  for (let i = 0; i < 50; i++) {
    const items = await chrome.downloads.search({ id: downloadId });
    const item = items?.[0];
    if (item?.state === "complete" && item.filename) {
      return { ok: true, path: item.filename, name: safeName };
    }
    if (item?.state === "interrupted") {
      return { ok: false, reason: item.error || "download_interrupted" };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { ok: false, reason: "download_timeout" };
}

async function uploadCvViaDebugger(tabId) {
  if (!tabId || !chrome.debugger) return { ok: false, reason: "no_debugger" };
  const disk = await materializeCvFileToDisk();
  if (!disk.ok) return disk;

  const target = { tabId };
  let attachedHere = false;
  let interceptOn = false;
  const onEvent = (source, method, params) => {
    if (source.tabId !== tabId) return;
    if (method === "Page.fileChooserOpened") {
      uploadCvViaDebugger._chooser = params || {};
    }
  };

  const fileName = disk.name || "cv.pdf";
  const nameStem = String(fileName).replace(/\.[^.]+$/, "").slice(0, 40);

  try {
    try {
      await chrome.debugger.attach(target, "1.3");
      attachedHere = true;
    } catch (_e) {
      // already attached is fine
    }

    try {
      await chrome.debugger.sendCommand(target, "DOM.enable");
      await chrome.debugger.sendCommand(target, "Page.enable");
    } catch (_e) {
      /* ignore */
    }

    chrome.debugger.onEvent.addListener(onEvent);
    uploadCvViaDebugger._chooser = null;

    try {
      await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", { enabled: true });
      interceptOn = true;
    } catch (e) {
      return { ok: false, reason: `intercept_fail:${e?.message || e}` };
    }

    // Wait for resume UI / file input (Smart Apply mounts slowly after applybyapplyablejobid)
    let clickOk = false;
    let noUploadUiStreak = 0;
    for (let wait = 0; wait < 40 && !clickOk; wait++) {
      const clicked = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const exactRe = /^(S[ée]lectionner un fichier|Choose (a )?file|Upload (a )?resume|Browse( files)?)$/i;
          const nodes = [
            ...document.querySelectorAll(
              'button, label, [role="button"], [data-testid*="upload"], [data-testid*="file"], input[type="file"]'
            ),
          ];
          const byExact = nodes.find((b) => b.tagName !== "INPUT" && exactRe.test(norm(b.textContent)));
          if (byExact) {
            byExact.click();
            return { ok: true, how: "exact-button", text: norm(byExact.textContent).slice(0, 40) };
          }
          const byTestId = nodes.find((b) =>
            /upload|file-input|fileInput|select-file/i.test(b.getAttribute("data-testid") || "")
          );
          if (byTestId) {
            byTestId.click();
            return { ok: true, how: "testid" };
          }
          const input = document.querySelector('input[type="file"]');
          if (input) {
            input.click();
            return { ok: true, how: "input" };
          }
          return { ok: false, hasResumeText: /Importer un CV|resume|Sélectionner/i.test(document.body?.innerText || "") };
        },
      });
      clickOk = (clicked || []).some((r) => r?.result?.ok);
      if (clickOk) break;
      // No upload affordance at all — bail out instead of burning the full 16s wait
      noUploadUiStreak = (clicked || []).some((r) => r?.result?.hasResumeText)
        ? 0
        : noUploadUiStreak + 1;
      if (noUploadUiStreak >= 8) {
        return { ok: false, reason: "no_file_input", disk: disk.path, clickOk: false };
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    // Wait for file chooser event (primary path — React listens to real chooser)
    let chooser = null;
    for (let i = 0; i < 15; i++) {
      chooser = uploadCvViaDebugger._chooser;
      if (chooser) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const nodeRefs = [];
    if (chooser?.backendNodeId) nodeRefs.push({ backendNodeId: chooser.backendNodeId });
    else if (chooser?.nodeId) nodeRefs.push({ nodeId: chooser.nodeId });

    // Always also attach to every file input (Indeed sometimes ignores the chooser node alone)
    try {
      const search = await chrome.debugger.sendCommand(target, "DOM.performSearch", {
        query: 'input[type="file"]',
        includeUserAgentShadowDOM: true,
      });
      const total = search?.resultCount || 0;
      if (total > 0) {
        const { nodeIds } = await chrome.debugger.sendCommand(target, "DOM.getSearchResults", {
          searchId: search.searchId,
          fromIndex: 0,
          toIndex: Math.min(total, 8),
        });
        for (const id of nodeIds || []) {
          if (id) nodeRefs.push({ nodeId: id });
        }
      }
      try {
        await chrome.debugger.sendCommand(target, "DOM.discardSearchResults", { searchId: search.searchId });
      } catch (_e) {
        /* ignore */
      }
    } catch (_e) {
      /* ignore */
    }

    if (!nodeRefs.length) {
      return { ok: false, reason: "no_file_input", disk: disk.path, clickOk };
    }

    for (const nodeRef of nodeRefs) {
      try {
        await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", {
          ...nodeRef,
          files: [disk.path],
        });
      } catch (_e) {
        /* try next node */
      }
    }

    // Nudge React controlled inputs after CDP attach
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        for (const el of document.querySelectorAll('input[type="file"]')) {
          try {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } catch (_e) {
            /* ignore */
          }
        }
      },
    });

    // Indeed uploads async — wait until validation error clears + filename appears
    let last = { withFiles: [], err: true, hasName: false, inputCount: 0 };
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const verify = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (stem, fullName) => {
          const inputs = [...document.querySelectorAll('input[type="file"]')];
          const withFiles = inputs
            .filter((inp) => inp.files && inp.files.length > 0)
            .map((inp) => inp.files[0].name);
          const body = (document.body?.innerText || "").replace(/\s+/g, " ");
          const err = /Sélectionnez un fichier pour continuer|Select a file to continue/i.test(body);
          const low = body.toLowerCase();
          // Require CV name in UI — "PDF, DOCX" help text must NOT count as uploaded
          const hasName =
            (!!stem && stem.length >= 5 && low.includes(String(stem).toLowerCase())) ||
            (!!fullName && low.includes(String(fullName).toLowerCase()));
          return { withFiles, err, hasName, inputCount: inputs.length, bodySample: body.slice(0, 220) };
        },
        args: [nameStem, fileName],
      });
      last =
        (verify || []).find((r) => (r?.result?.inputCount || 0) > 0)?.result ||
        verify?.[0]?.result ||
        last;
      if (!last.err && last.hasName) break;
    }

    // Only accept when Indeed dropped the validation error AND shows our filename
    const accepted = !last.err && !!last.hasName;

    return {
      ok: accepted,
      path: disk.path,
      name: disk.name,
      files: last.withFiles || [],
      stillError: !!last.err,
      hasName: !!last.hasName,
      viaChooser: !!chooser,
      clickOk,
      accepted,
      reason: accepted ? "ui_accepted" : last.err ? "still_validation_error" : "no_filename_ui",
    };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), path: disk.path };
  } finally {
    try {
      chrome.debugger.onEvent.removeListener(onEvent);
    } catch (_e) {
      /* ignore */
    }
    if (interceptOn) {
      try {
        await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", { enabled: false });
      } catch (_e) {
        /* ignore */
      }
    }
    if (attachedHere) {
      try {
        await chrome.debugger.detach(target);
      } catch (_e) {
        /* ignore */
      }
    }
  }
}

/** Probe whether chrome.debugger can attach (fails if DevTools/MCP already debugging). */
async function probeDebuggerAvailable(tabId) {
  if (!tabId || !chrome.debugger) return false;
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
    try {
      await chrome.debugger.detach(target);
    } catch (_e) {}
    return true;
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (/already attached|Another debugger/i.test(msg)) return false;
    // Some Chromium builds report differently when busy
    if (/Cannot access|Debugger is already|detached/i.test(msg)) return false;
    return false;
  }
}

async function getTabUserAgent(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => navigator.userAgent || "",
    });
    return String(r?.[0]?.result || "").trim();
  } catch (_e) {
    return "";
  }
}

/**
 * Inject Turnstile token. Prefer matching browser UA (no CDP).
 * Only override UA when required AND debugger is free. On debugger_busy, still inject
 * the existing token (never start a second solve — cData/pagedata are one-shot).
 */
async function injectCloudflareTurnstileToken(tabId, token, solverUa = "", { requireUaMatch = false } = {}) {
  if (!tabId || !token) return { ok: false, reason: "missing" };
  const wantUa = String(solverUa || "").trim();
  let currentUa = "";
  try {
    currentUa = await getTabUserAgent(tabId);
  } catch (_e) {}
  const needUaOverride = !!(wantUa && currentUa && wantUa !== currentUa);
  const target = { tabId };
  let attached = false;
  let uaApplied = false;

  if (needUaOverride && chrome.debugger) {
    try {
      await chrome.debugger.attach(target, "1.3");
      attached = true;
      await chrome.debugger.sendCommand(target, "Network.enable", {});
      await chrome.debugger.sendCommand(target, "Network.setUserAgentOverride", {
        userAgent: wantUa,
      });
      uaApplied = true;
      await appendLog("CF inject: UA override ON (held through callback)", "warn");
    } catch (e) {
      await appendLog(
        `CF inject: debugger busy (${String(e?.message || e).slice(0, 80)}) — injecting without UA override`,
        "warn"
      );
      if (requireUaMatch) return { ok: false, reason: "debugger_busy", needUa: true };
      // Fall through: inject token anyway (better than burning params on a 2nd solve)
    }
  } else if (wantUa && wantUa === currentUa) {
    await appendLog("CF inject: solver UA matches browser", "warn");
  }

  try {
    const applied = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: (tok) => {
        try {
          window.__AmijobsLastCfToken = tok;
          window.postMessage({ source: "amijobs-cf-token", token: tok }, "*");
          for (const input of document.querySelectorAll(
            '[name="cf-turnstile-response"], input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], [name="g-recaptcha-response"]'
          )) {
            input.value = tok;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          if (typeof window.__AmijobsCfApplyToken === "function") {
            return !!window.__AmijobsCfApplyToken(tok);
          }
          if (typeof window.__AmijobsCfCallback === "function") window.__AmijobsCfCallback(tok);
          if (typeof window.tsCallback === "function") window.tsCallback(tok);
          if (typeof window.cfCallback === "function") window.cfCallback(tok);
          return true;
        } catch (_e) {
          return false;
        }
      },
      args: [token],
    });
    const anyApplied = (applied || []).some((r) => r?.result);
    if (attached && uaApplied) {
      await new Promise((r) => setTimeout(r, 3500));
    }
    return { ok: true, uaApplied, applied: anyApplied };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch (_e) {}
    }
  }
}

function cfParamsFingerprint(p) {
  if (!p?.sitekey) return "";
  return `${p.sitekey}|${p.action || ""}|${p.ray || ""}|${String(p.data || "").slice(0, 48)}|${String(p.pagedata || "").slice(0, 48)}`;
}

/** Background BBQ orchestrator: Turnstile is manual — do not spend solver credits. */
async function orchestrateCloudflareTurnstileSolve(tabId, seedParams = null) {
  if (!tabId) return { ok: false, reason: "no_tab" };
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isMassApplyJobBoardUrl(tab?.url || "")) {
      return { ok: false, reason: "not_jobboard" };
    }
  } catch (_e) {
    return { ok: false, reason: "no_tab" };
  }
  if (!globalThis.__amijobsCfManualLogged) globalThis.__amijobsCfManualLogged = {};
  if (!globalThis.__amijobsCfManualLogged[tabId]) {
    globalThis.__amijobsCfManualLogged[tabId] = Date.now();
    await appendLog(
      "Cloudflare Turnstile: mode manuel (cliquez le widget). reCAPTCHA: solveurs AmiJobs (exit.amijobs.com).",
      "warn"
    );
  }
  return { ok: false, reason: "manual_turnstile" };
}

async function clickTurnstileWithDebugger(tabId) {
  if (!tabId || !chrome.debugger) return { ok: false, reason: "no_debugger" };
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
  } catch (_e) {
    // Already attached or unavailable
    try {
      await chrome.debugger.attach(target, "1.3");
      attached = true;
    } catch (e2) {
      return { ok: false, reason: String(e2?.message || e2) };
    }
  }

  try {
    // Bring tab forward so coordinates map to the visible viewport
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch (_e) {
      /* ignore */
    }

    const boxes = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const out = [];
        const pushBox = (el, label) => {
          if (!el) return;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) return;
          out.push({
            label,
            x: r.left + Math.min(28, Math.max(12, r.width * 0.1)),
            y: r.top + r.height / 2,
            w: r.width,
            h: r.height,
            href: location.href.slice(0, 100),
          });
        };
        const host = location.hostname || "";
        if (/challenges\.cloudflare\.com|turnstile/i.test(host)) {
          pushBox(document.querySelector('input[type="checkbox"], [role="checkbox"], label.cb-lb, .cb-lb, body'), "frame");
        }
        for (const f of document.querySelectorAll(
          'iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"], iframe[title*="Widget"], iframe[title*="Cloudflare"], .cf-turnstile, #challenge-stage'
        )) {
          pushBox(f, "host-iframe");
        }
        const text = (document.body?.innerText || "").toLowerCase();
        if (/vérifiez que vous êtes humain|verify you are human/.test(text)) {
          pushBox(document.querySelector(".cf-turnstile, #challenge-stage, body"), "host-text");
        }
        return out;
      },
    });

    const points = [];
    for (const r of boxes || []) {
      for (const b of r?.result || []) points.push(b);
    }
    if (!points.length) return { ok: false, reason: "no_points" };

    const dispatch = async (x, y) => {
      const base = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...base,
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...base,
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...base,
      });
    };

    for (const p of points.slice(0, 6)) {
      await dispatch(p.x, p.y);
      await new Promise((r) => setTimeout(r, 250));
      // Also try slightly left (checkbox)
      await dispatch(Math.max(8, p.x - 10), p.y);
      await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: true, points: points.length };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch (_e) {
        /* ignore */
      }
    }
  }
}

// Inject Turnstile hook ASAP on navigation (before page scripts when possible)
try {
  chrome.webNavigation.onCommitted.addListener((details) => {
    try {
      if (details.frameId !== 0) return;
      const url = String(details.url || "");
      // CF hook only on mass-apply job boards — never CapSolver / random sites
      if (!isMassApplyJobBoardUrl(url)) return;
      chrome.scripting
        .executeScript({
          target: { tabId: details.tabId, frameIds: [0] },
          world: "MAIN",
          injectImmediately: true,
          files: ["content/turnstile-hook.js"],
        })
        .catch(() => {});
      chrome.scripting
        .executeScript({
          target: { tabId: details.tabId, frameIds: [0] },
          injectImmediately: true,
          files: ["content/cf-bridge.js"],
        })
        .catch(() => {});
    } catch (_e) {}
  });
} catch (_e) {}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url || "";
  if (!url && !changeInfo.title && changeInfo.status !== "complete") return;

  // Indeed "Signaler un problème" opens hrtechprivacy.com — close immediately during sessions
  if (/hrtechprivacy\.com|requests\.hrtechprivacy/i.test(url)) {
    try {
      const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
      if (amijobsMeta?.active) {
        await chrome.tabs.remove(tabId);
        await appendLog("Onglet privacy Indeed fermé", "warn");
      }
    } catch (_e) {}
    return;
  }

  // Cloudflare Turnstile is manual. Log once when a challenge tab is seen.
  // Do NOT inject CF hooks on healthy SERPs.
  const cfTab = { title: changeInfo.title || tab?.title || "", url: url || tab?.url || "" };
  if (
    (changeInfo.status === "complete" || changeInfo.title) &&
    isMassApplyJobBoardUrl(cfTab.url || url || "")
  ) {
    try {
      if (tabLooksLikeCloudflareChallenge(cfTab) || tabLooksLikeCloudflareChallenge(tab)) {
        const now = Date.now();
        if (!globalThis.__amijobsCfTabInjectAt) globalThis.__amijobsCfTabInjectAt = {};
        const last = globalThis.__amijobsCfTabInjectAt[tabId] || 0;
        if (now - last >= 20000) {
          globalThis.__amijobsCfTabInjectAt[tabId] = now;
          orchestrateCloudflareTurnstileSolve(tabId).catch(() => {});
        }
        return;
      }
      // Healthy SERP: clear any leftover CF pause so mass-apply can run
      if (changeInfo.status === "complete") {
        try {
          const { amijobsCfPause = null } = await chrome.storage.local.get(["amijobsCfPause"]);
          if (amijobsCfPause?.until) {
            await chrome.storage.local.set({ amijobsCfPause: null });
            await appendLog("CF pause cleared — SERP OK (pas de challenge)", "info");
          }
        } catch (_e) {}
      }
    } catch (_e) {
      /* ignore */
    }
  }

  // v1.4.0: Skip service worker iframes — they match the Smart Apply URL pattern
  // but have no apply form, causing wizard_timeout.
  try {
    const checkPath = (() => {
      try {
        return new URL(url, location.href).pathname;
      } catch (_e) {
        return url;
      }
    })();
    if (/^\/_\/service_worker/i.test(checkPath) || /^\/_\/scripts\//i.test(checkPath) || /^\/sw_iframe/i.test(checkPath)) {
      return;
    }
  } catch (_e) {
    /* ignore */
  }

  // Login wall: ?continue=…smartapply… used to look like Smart Apply and restart Indeed forever
  if (isIndeedLoginWallUrl(url)) {
    await handleIndeedLoginWall(tabId, url);
    return;
  }

  // User finished signing in — leave auth for jobs/smartapply
  try {
    const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
    if (amijobsMeta?.indeedLoginRequired && urlLooksIndeedLoggedIn(url)) {
      await clearIndeedLoginGate("navigated_after_auth");
    }
  } catch (_e) {}

  const isSmartApplyUrl = isIndeedSmartApplyUrl(url);
  const isHandoffLandingUrl = (() => {
    try {
      const u = new URL(url);
      const hostPath = `${u.hostname}${u.pathname}`;
      if (!/indeed\.(com|fr)/i.test(hostPath) || /smartapply/i.test(u.hostname)) return false;
      if (/\/(?:viewjob|pagead\/clk|rc\/clk)/i.test(u.pathname)) return true;
      if (/\/jobs\b/i.test(u.pathname) && /[?&](?:jk|vjk|fromjk)=/i.test(u.search)) return true;
      return false;
    } catch (_e) {
      const s = String(url).split(/[?#]/)[0];
      return (
        /indeed\.(com|fr)\/(?:viewjob|pagead\/clk|rc\/clk)/i.test(s) ||
        (/indeed\.(com|fr)\/jobs\b/i.test(s) && /[?&](?:jk|vjk|fromjk)=/i.test(url))
      );
    }
  })();

  try {
    const { sessionIndeed, sessionGlassdoor, amijobsMeta } = await chrome.storage.local.get([
      "sessionIndeed",
      "sessionGlassdoor",
      "amijobsMeta",
    ]);

    if (amijobsMeta?.indeedLoginRequired && (isSmartApplyUrl || isHandoffLandingUrl)) {
      // User must log in manually — don't keep spawning apply tabs
      return;
    }

    const glassdoorOwnsTab = !!(
      watchingIndeedFromGlassdoor ||
      (sessionGlassdoor?.active && sessionGlassdoor?.awaitingIndeed)
    );

    // Glassdoor Easy Apply often lands on viewjob / jobs?vjk= before Smart Apply —
    // still kick Indeed so it can click Postuler under Glassdoor's lock.
    if (!isSmartApplyUrl) {
      if (glassdoorOwnsTab && isHandoffLandingUrl) {
        const nowLanding = Date.now();
        if (nowLanding - lastSmartApplyKick < 2500) return;
        lastSmartApplyKick = nowLanding;
        setTimeout(() => {
          chrome.tabs
            .sendMessage(tabId, { action: "startAutoApply", fromGlassdoor: true, handoffViewjob: true })
            .catch(() => {});
        }, 900);
      }
      return;
    }
  } catch (_e) {
    if (!isSmartApplyUrl) return;
  }

  // Debounce duplicate kicks (many Smart Apply URL changes per wizard)
  const now = Date.now();
  if (now - lastSmartApplyKick < 3500) return;
  lastSmartApplyKick = now;

  try {
    const { sessionIndeed, sessionGlassdoor } = await chrome.storage.local.get([
      "sessionIndeed",
      "sessionGlassdoor",
    ]);

    const glassdoorOwnsTab = !!(
      watchingIndeedFromGlassdoor ||
      (sessionGlassdoor?.active && sessionGlassdoor?.awaitingIndeed)
    );
    const indeedOwnsSession = !!(sessionIndeed?.active && !sessionIndeed.fromGlassdoor);

    // Glassdoor Easy Apply opened this Smart Apply tab (may run alongside Indeed)
    if (glassdoorOwnsTab && sessionGlassdoor?.active) {
      const { amijobsMeta: metaGate = null } = await chrome.storage.local.get(["amijobsMeta"]);
      if (metaGate?.indeedLoginRequired) {
        await handleIndeedLoginWall(tabId, url);
        return;
      }
      const job = watchingIndeedFromGlassdoor || {
        jobId: sessionGlassdoor.currentJk,
        title: sessionGlassdoor.currentTitle,
        company: sessionGlassdoor.currentCompany,
      };
      // Tab/wizard opened is NOT an applied success — keep awaitingIndeed until
      // Indeed marks applied or fails (indeedHandoffDone stays false until then).
      await chrome.storage.local.set({
        sessionGlassdoor: {
          ...sessionGlassdoor,
          indeedTabOpened: true,
          indeedHandoffDone: false,
          awaitingIndeed: true,
          lastRunAt: Date.now(),
        },
        glassdoorSmartApply: {
          jobId: job.jobId || sessionGlassdoor.currentJk || "",
          title: job.title || sessionGlassdoor.currentTitle || "",
          company: job.company || sessionGlassdoor.currentCompany || "",
          at: Date.now(),
        },
      });
      watchingIndeedFromGlassdoor = null;

      // Keep Glassdoor SERP visible — Easy Apply often navigates the GD tab to Indeed
      try {
        const gdTabs = await listPlatformTabs("glassdoor");
        const resume = sessionGlassdoor.searchUrl || sessionGlassdoor.resumeSearchUrl || "";
        if (gdTabs.length === 0 && resume) {
          await ensureSinglePlatformTab("glassdoor", resume, {
            active: false,
            forceNavigate: true,
          });
        }
      } catch (_e) {}

      // If Indeed is NOT also running its own session, create a lightweight apply session
      if (!indeedOwnsSession) {
        await chrome.storage.local.set({
          sessionIndeed: {
            active: true,
            platform: "indeed",
            applied: sessionGlassdoor.applied || 0,
            skipped: 0,
            errors: 0,
            maxJobs: sessionGlassdoor.maxJobs || 25,
            keywords: sessionGlassdoor.keywords || "",
            location: sessionGlassdoor.location || "",
            phase: "apply",
            currentJk: job.jobId || sessionGlassdoor.currentJk || "",
            currentTitle: job.title || sessionGlassdoor.currentTitle || "",
            currentCompany: job.company || sessionGlassdoor.currentCompany || "",
            searchUrl: sessionGlassdoor.searchUrl || "",
            fromGlassdoor: true,
            startedAt: new Date().toISOString(),
          },
        });
      }

      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { action: "startAutoApply", fromGlassdoor: true }).catch(() => {});
      }, 1200);
      // Don't also treat this as Indeed's own apply (would steal Indeed SERP phase)
      if (!indeedOwnsSession) return;
      return;
    }

    // Existing Indeed session owns Smart Apply — never overwrite its queue
    if (indeedOwnsSession) {
      await chrome.storage.local.set({
        sessionIndeed: {
          ...sessionIndeed,
          phase: "apply",
          lastRunAt: Date.now(),
        },
      });
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { action: "startAutoApply" }).catch(() => {});
      }, 1200);
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (!t.id || t.id === tabId) continue;
        if (/indeed\.(com|fr)/i.test(t.url || "") && !/smartapply/i.test(t.url || "")) {
          chrome.tabs.sendMessage(t.id, { action: "indeedSmartApplyOpened" }).catch(() => {});
        }
      }
      return;
    }

    // Glassdoor-only leftover fromGlassdoor session
    if (sessionGlassdoor?.active || sessionIndeed?.fromGlassdoor) {
      const job = watchingIndeedFromGlassdoor || {};
      const base = sessionIndeed?.fromGlassdoor ? sessionIndeed : null;
      await chrome.storage.local.set({
        sessionIndeed: {
          active: true,
          platform: "indeed",
          applied: base?.applied || sessionGlassdoor?.applied || 0,
          skipped: base?.skipped || 0,
          errors: base?.errors || 0,
          maxJobs: base?.maxJobs || sessionGlassdoor?.maxJobs || 25,
          keywords: base?.keywords || sessionGlassdoor?.keywords || "",
          location: base?.location || sessionGlassdoor?.location || "",
          phase: "apply",
          currentJk: job.jobId || sessionGlassdoor?.currentJk || base?.currentJk || "",
          currentTitle: job.title || sessionGlassdoor?.currentTitle || base?.currentTitle || "",
          currentCompany: job.company || sessionGlassdoor?.currentCompany || base?.currentCompany || "",
          searchUrl: base?.searchUrl || sessionGlassdoor?.searchUrl || "",
          fromGlassdoor: true,
          startedAt: base?.startedAt || new Date().toISOString(),
        },
      });
      if (sessionGlassdoor?.active) {
        await chrome.storage.local.set({
          sessionGlassdoor: {
            ...sessionGlassdoor,
            indeedTabOpened: true,
            indeedHandoffDone: false,
            awaitingIndeed: true,
          },
        });
      }
      watchingIndeedFromGlassdoor = null;
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { action: "startAutoApply", fromGlassdoor: true }).catch(() => {});
      }, 1200);
    }
  } catch (_e) {
    /* ignore */
  }
});

function resetSessionForLocation(platform, session, nextLocation, nextIndex, nextUrl) {
  const next = {
    ...session,
    location: nextLocation,
    locationIndex: nextIndex,
    currentPage: 0,
    searchUrl: nextUrl,
  };
  if (platform === "hellowork") {
    next.phase = "search";
    next.resumeSearchUrl = nextUrl;
    next.currentOfferUrl = "";
    next.currentJobTitle = "";
    next.currentJobCompany = "";
    next.visitedOffers = {};
    next.externalSiteOffers = {};
    next.visitedSearchUrls = [];
    next.noNewOfferPages = 0;
  }
  if (platform === "indeed") {
    next.phase = "search";
    next.queue = [];
    next.qIndex = 0;
    next.currentJk = "";
    next.noApplyPages = 0;
  }
  if (platform === "glassdoor") {
    next.noApplyPages = 0;
  }
  return next;
}

async function companyApplyCount(company) {
  if (!company) return 0;
  const { appliedJobs = {} } = await chrome.storage.local.get(["appliedJobs"]);
  const target = String(company).toLowerCase().trim();
  if (!target) return 0;
  let count = 0;
  for (const key of Object.keys(appliedJobs)) {
    const c = String(appliedJobs[key]?.company || "").toLowerCase().trim();
    if (c && (c === target || c.includes(target) || target.includes(c))) count++;
  }
  return count;
}

async function getMistralApiKey() {
  const { mistralApiKey } = await chrome.storage.local.get(["mistralApiKey"]);
  return mistralApiKey || DEFAULT_MISTRAL_API_KEY;
}

async function askMistral(systemPrompt, userPrompt, maxTokens = 300) {
  const apiKey = await getMistralApiKey();
  if (!apiKey) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(MISTRAL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.4,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error("[AmiJobs] Mistral error:", err);
    return null;
  }
}

async function loadSecretsLocalFile() {
  try {
    const res = await fetch(chrome.runtime.getURL("secrets.local.json"));
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) {
    return null;
  }
}

async function getTwoCaptchaApiKey() {
  try {
    const { twoCaptchaApiKey } = await chrome.storage.local.get(["twoCaptchaApiKey"]);
    if (twoCaptchaApiKey) return String(twoCaptchaApiKey).trim();
  } catch (_e) {}
  // Optional local-only file (gitignored) — never ship a real key in the public zip
  try {
    const data = await loadSecretsLocalFile();
    const k = String(data?.twoCaptchaApiKey || "").trim();
    if (k) {
      await chrome.storage.local.set({ twoCaptchaApiKey: k });
      return k;
    }
  } catch (_e) {}
  return "";
}

async function getCapSolverApiKey() {
  try {
    const { capSolverApiKey } = await chrome.storage.local.get(["capSolverApiKey"]);
    if (capSolverApiKey) return String(capSolverApiKey).trim();
  } catch (_e) {}
  try {
    const data = await loadSecretsLocalFile();
    const k = String(data?.capSolverApiKey || "").trim();
    if (k) {
      await chrome.storage.local.set({ capSolverApiKey: k });
      return k;
    }
  } catch (_e) {}
  return "";
}

/**
 * Parse user proxy string into CapSolver + 2captcha shapes.
 * Accepts: http://user:pass@host:port | socks5://… | host:port:user:pass | host:port
 */
function parseCaptchaProxy(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    // URL form: http://user:pass@host:port
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      const u = new URL(s);
      const proto = (u.protocol.replace(":", "") || "http").toLowerCase();
      const proxyType = proto === "socks5" || proto === "socks4" ? proto : "http";
      const host = u.hostname;
      const port = Number(u.port || (proxyType.startsWith("socks") ? 1080 : 8080));
      if (!host || !port) return null;
      const user = decodeURIComponent(u.username || "");
      const pass = decodeURIComponent(u.password || "");
      const capParts = [proxyType === "http" ? "http" : proxyType, host, String(port)];
      if (user) {
        capParts.push(user);
        capParts.push(pass);
      }
      return {
        proxyType,
        proxyAddress: host,
        proxyPort: port,
        proxyLogin: user || undefined,
        proxyPassword: pass || undefined,
        capSolverProxy: capParts.join(":"),
      };
    }
    // colon form: type:host:port:user:pass OR host:port:user:pass OR host:port
    const parts = s.split(":");
    let proxyType = "http";
    let host;
    let port;
    let user = "";
    let pass = "";
    if (/^(https?|socks4|socks5)$/i.test(parts[0]) && parts.length >= 3) {
      proxyType = parts[0].toLowerCase() === "https" ? "http" : parts[0].toLowerCase();
      host = parts[1];
      port = Number(parts[2]);
      user = parts[3] || "";
      pass = parts.slice(4).join(":") || "";
    } else if (parts.length >= 2) {
      host = parts[0];
      port = Number(parts[1]);
      user = parts[2] || "";
      pass = parts.slice(3).join(":") || "";
    } else {
      return null;
    }
    if (!host || !Number.isFinite(port) || port <= 0) return null;
    const capParts = [proxyType, host, String(port)];
    if (user) {
      capParts.push(user);
      capParts.push(pass);
    }
    return {
      proxyType,
      proxyAddress: host,
      proxyPort: port,
      proxyLogin: user || undefined,
      proxyPassword: pass || undefined,
      capSolverProxy: capParts.join(":"),
    };
  } catch (_e) {
    return null;
  }
}

async function getCaptchaProxy() {
  try {
    const { captchaProxy } = await chrome.storage.local.get(["captchaProxy"]);
    const parsed = parseCaptchaProxy(captchaProxy);
    if (parsed) return parsed;
  } catch (_e) {}
  try {
    const data = await loadSecretsLocalFile();
    const parsed = parseCaptchaProxy(data?.captchaProxy || data?.proxy || "");
    if (parsed) {
      await chrome.storage.local.set({ captchaProxy: String(data.captchaProxy || data.proxy).trim() });
      return parsed;
    }
  } catch (_e) {}
  return null;
}

/** Seed both captcha keys from secrets.local.json when present. */
async function seedCaptchaApiKeysFromSecrets() {
  const data = await loadSecretsLocalFile();
  if (!data) return;
  const patch = {};
  try {
    const existing = await chrome.storage.local.get(["twoCaptchaApiKey", "capSolverApiKey"]);
    const two = String(data?.twoCaptchaApiKey || "").trim();
    const cap = String(data?.capSolverApiKey || "").trim();
    if (two && !existing.twoCaptchaApiKey) patch.twoCaptchaApiKey = two;
    if (cap && !existing.capSolverApiKey) patch.capSolverApiKey = cap;
  } catch (_e) {}
  if (Object.keys(patch).length) {
    try {
      await chrome.storage.local.set(patch);
    } catch (_e) {}
  }
}

/** Serialize Indeed Smart Apply across Indeed mass-apply + Glassdoor Easy Apply.
 *  TTL must outlast slow 2captcha (workers fail + recreate can take 3–6 min).
 *  Fairness: after release, prefer the other board so applies interleave. */
const SMART_APPLY_LOCK_TTL_MS = 420000;
// After A finishes, give B a short window to claim the next Smart Apply.
// Keep this short so Glassdoor is not starved while Indeed holds fairness.
const SMART_APPLY_FAIR_MS = 14000;

async function peekSmartApplyLock(ttlMs = SMART_APPLY_LOCK_TTL_MS) {
  const { amijobsSmartApplyLock = null } = await chrome.storage.local.get(["amijobsSmartApplyLock"]);
  if (!amijobsSmartApplyLock?.owner) return { ok: true, owner: null, age: 0 };
  const age = Date.now() - (amijobsSmartApplyLock.at || 0);
  if (age > ttlMs) {
    await chrome.storage.local.set({ amijobsSmartApplyLock: null });
    return { ok: true, owner: null, age };
  }
  return { ok: false, owner: amijobsSmartApplyLock.owner, age };
}

async function preferredBoardStillActive(preferOwner) {
  if (!preferOwner) return false;
  const key = preferOwner === "indeed" ? "sessionIndeed" : preferOwner === "glassdoor" ? "sessionGlassdoor" : null;
  if (!key) return false;
  const data = await chrome.storage.local.get([key]);
  const sess = data[key];
  if (!sess?.active) return false;
  const maxJobs = sess.maxJobs || 25;
  // Don't soft-lock the other board if preferred board already hit its quota
  if ((sess.applied || 0) >= maxJobs) return false;
  return true;
}

async function acquireSmartApplyLock(owner, ttlMs = SMART_APPLY_LOCK_TTL_MS, handoff = false) {
  if (!owner) return { ok: false, reason: "no_owner" };

  // Dual Indeed+Glassdoor: both may run a Smart Apply wizard at once (separate windows/tabs).
  // The old exclusive mutex made Glassdoor idle with "Smart Apply occupé" the whole Indeed wizard.
  if (await isParallelSmartApplyEnabled()) {
    const now = Date.now();
    const { amijobsSmartApplyOwners = {} } = await chrome.storage.local.get(["amijobsSmartApplyOwners"]);
    const owners = { ...(amijobsSmartApplyOwners || {}), [owner]: now };
    await chrome.storage.local.set({
      amijobsSmartApplyOwners: owners,
      amijobsSmartApplyLock: { owner, at: now, parallel: true },
    });
    return { ok: true, owner, parallel: true };
  }

  const data = await chrome.storage.local.get([
    "amijobsSmartApplyLock",
    "amijobsSmartApplyPrefer",
    "indeedWizardBusy",
  ]);
  let amijobsSmartApplyLock = data.amijobsSmartApplyLock || null;
  const amijobsSmartApplyPrefer = data.amijobsSmartApplyPrefer || null;
  const indeedWizardBusy = data.indeedWizardBusy || null;
  const now = Date.now();
  let age = amijobsSmartApplyLock?.at ? now - amijobsSmartApplyLock.at : 999999;
  // Stale lock: held without an active wizard for >100s (Postuler miss / crashed tab)
  const wizardAge = indeedWizardBusy?.at ? now - indeedWizardBusy.at : 999999;
  if (amijobsSmartApplyLock?.owner && age > 100000 && wizardAge > 100000) {
    await chrome.storage.local.set({ amijobsSmartApplyLock: null });
    amijobsSmartApplyLock = null;
    age = 999999;
  }
  const heldByOther =
    amijobsSmartApplyLock?.owner &&
    amijobsSmartApplyLock.owner !== owner &&
    age < ttlMs;
  // The Indeed wizard spawned by a Glassdoor Easy Apply runs under Glassdoor's lock;
  // its heartbeats must refresh the TTL instead of being rejected during long captchas.
  if (heldByOther && handoff && owner === "indeed" && amijobsSmartApplyLock.owner === "glassdoor") {
    await chrome.storage.local.set({ amijobsSmartApplyLock: { owner: "glassdoor", at: now } });
    return { ok: true, owner: "glassdoor", handoff: true };
  }
  if (heldByOther) {
    return { ok: false, owner: amijobsSmartApplyLock.owner, age };
  }
  // Fair turn-taking: after A finishes, B gets first shot for ~60s while B's session is alive
  const preferAge = amijobsSmartApplyPrefer?.at ? now - amijobsSmartApplyPrefer.at : 999999;
  if (
    amijobsSmartApplyPrefer?.owner &&
    amijobsSmartApplyPrefer.owner !== owner &&
    preferAge < SMART_APPLY_FAIR_MS &&
    (await preferredBoardStillActive(amijobsSmartApplyPrefer.owner))
  ) {
    return {
      ok: false,
      owner: amijobsSmartApplyPrefer.owner,
      reason: "fairness",
      age: preferAge,
    };
  }
  await chrome.storage.local.set({
    amijobsSmartApplyLock: { owner, at: now },
    amijobsSmartApplyPrefer: null,
  });
  return { ok: true, owner };
}

async function releaseSmartApplyLock(owner, { fair = false } = {}) {
  if (!owner) return { ok: true };
  if (await isParallelSmartApplyEnabled()) {
    const { amijobsSmartApplyOwners = {} } = await chrome.storage.local.get(["amijobsSmartApplyOwners"]);
    const owners = { ...(amijobsSmartApplyOwners || {}) };
    delete owners[owner];
    await chrome.storage.local.set({
      amijobsSmartApplyOwners: owners,
      amijobsSmartApplyLock: Object.keys(owners).length
        ? { owner: Object.keys(owners)[0], at: Date.now(), parallel: true }
        : null,
      amijobsSmartApplyPrefer: null,
    });
    return { ok: true, parallel: true };
  }
  const { amijobsSmartApplyLock = null } = await chrome.storage.local.get(["amijobsSmartApplyLock"]);
  if (!amijobsSmartApplyLock?.owner || amijobsSmartApplyLock.owner === owner) {
    const other =
      owner === "indeed" ? "glassdoor" : owner === "glassdoor" ? "indeed" : null;
    const updates = { amijobsSmartApplyLock: null };
    // Only alternate boards after a real Smart Apply finish — failed handoffs must not
    // soft-lock the other board for SMART_APPLY_FAIR_MS (looked like Indeed monopoly).
    if (fair && other && (await preferredBoardStillActive(other))) {
      updates.amijobsSmartApplyPrefer = { owner: other, at: Date.now() };
    } else {
      updates.amijobsSmartApplyPrefer = null;
    }
    await chrome.storage.local.set(updates);
    // Immediately nudge the preferred board so fairness isn't wasted
    if (updates.amijobsSmartApplyPrefer?.owner) {
      const prefer = updates.amijobsSmartApplyPrefer.owner;
      const poke = () => {
        kickPlatformSessions([prefer]).catch(() => {});
        listPlatformTabs(prefer)
          .then((tabs) => {
            for (const t of tabs.slice(0, 3)) {
              if (t?.id) chrome.tabs.sendMessage(t.id, { action: "startAutoApply" }).catch(() => {});
            }
          })
          .catch(() => {});
      };
      setTimeout(poke, 350);
      setTimeout(poke, 1800); // second poke — Glassdoor often still dismissing modals
    }
    return { ok: true };
  }
  return { ok: false, owner: amijobsSmartApplyLock.owner };
}

async function solveTurnstileWithCapSolver({
  websiteURL,
  websiteKey,
  pageAction = "",
  data = "",
  pagedata = "",
  userAgent = "",
} = {}) {
  const clientKey = await getCapSolverApiKey();
  if (!clientKey) return { ok: false, reason: "missing_capsolver_key" };
  const pageUrl = String(websiteURL || "").trim();
  const siteKey = String(websiteKey || "").trim();
  if (!pageUrl || !siteKey) return { ok: false, reason: "missing_sitekey_or_url" };

  const metadata = {};
  if (pageAction) metadata.action = String(pageAction);
  if (data) metadata.cdata = String(data);
  // Forward pagedata when present (managed CF); CapSolver may ignore unknown keys
  if (pagedata) metadata.pagedata = String(pagedata);

  const task = {
    type: "AntiTurnstileTaskProxyLess",
    websiteURL: pageUrl,
    websiteKey: siteKey,
  };
  if (Object.keys(metadata).length) task.metadata = metadata;

  try {
    await appendLog(
      `CapSolver Turnstile… key=${siteKey.slice(0, 14)}… action=${pageAction || "-"} cdata=${data ? "yes" : "no"} pagedata=${pagedata ? "yes" : "no"}`,
      "warn"
    );
    const createRes = await fetch(CAPSOLVER_CREATE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey, task }),
    });
    const created = await createRes.json();
    if (created?.errorId) {
      return {
        ok: false,
        reason: created.errorDescription || created.errorCode || "create_failed",
        errorId: created.errorId,
      };
    }
    const taskId = created?.taskId;
    if (!taskId) return { ok: false, reason: "no_task_id" };

    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1200));
      const pollRes = await fetch(CAPSOLVER_RESULT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey, taskId }),
      });
      const polled = await pollRes.json();
      if (polled?.errorId) {
        return {
          ok: false,
          reason: polled.errorDescription || polled.errorCode || "poll_failed",
          errorId: polled.errorId,
        };
      }
      if (polled?.status === "ready") {
        const token =
          polled?.solution?.token ||
          polled?.solution?.gRecaptchaResponse ||
          polled?.solution?.text ||
          "";
        if (!token) return { ok: false, reason: "empty_token" };
        await appendLog("CapSolver: Turnstile résolu", "success");
        return {
          ok: true,
          token,
          taskId,
          provider: "capsolver",
          userAgent: polled?.solution?.userAgent || userAgent || "",
        };
      }
      if (polled?.status === "failed") {
        return { ok: false, reason: polled.errorDescription || "failed" };
      }
    }
    return { ok: false, reason: "timeout" };
  } catch (err) {
    console.error("[AmiJobs] CapSolver error:", err);
    return { ok: false, reason: err?.message || "network_error" };
  }
}

function isCaptchaBalanceError(reason) {
  return /ERROR_ZERO_BALANCE|zero.?balance|insufficient.?funds|ERROR_KEY_DOES_NOT_EXIST|missing_.*_key|ERROR_WRONG_USER_KEY|ERROR_USER_DOES_NOT_EXIST|ERROR_BALANCE|ERROR_EMPTY_KEY/i.test(
    String(reason || "")
  );
}

/**
 * Real Google reCAPTCHA v2 tokens are usually long (~1–3k) and often start with 03A / 0cA.
 * CapSolver ProxyLess has returned ~522-char "HF…" junk that Indeed rejects as
 * CAPTCHA_VALIDATION_FAILED — reject that pattern hard.
 */
function isPlausibleGoogleRecaptchaToken(token) {
  const t = String(token || "").trim();
  if (!t || t.length < 200) return false;
  // Observed CapSolver junk (HAR 2026-08-20): always HF… and exactly ~522 chars
  if (/^HF[A-Za-z0-9_-]+$/.test(t) && t.length < 1000) return false;
  if (/^(03A|0cA|03a)/i.test(t) && t.length >= 400) return true;
  if (t.length >= 1000 && /^[A-Za-z0-9_-]+$/.test(t)) return true;
  return false;
}

async function solveRecaptchaWithCapSolver({
  websiteURL,
  websiteKey,
  isEnterprise = false,
  isInvisible = false,
  apiDomain = "",
  userAgent = "",
  enterprisePayload = null,
  recaptchaDataSValue = "",
  useProxy = true,
} = {}) {
  const clientKey = await getCapSolverApiKey();
  if (!clientKey) return { ok: false, reason: "missing_capsolver_key" };
  const pageUrl = String(websiteURL || "").trim();
  const siteKey = String(websiteKey || "").trim();
  if (!pageUrl || !siteKey) return { ok: false, reason: "missing_sitekey_or_url" };

  const proxy = useProxy ? await getCaptchaProxy() : null;
  let taskType;
  if (isEnterprise) {
    taskType = proxy ? "ReCaptchaV2EnterpriseTask" : "ReCaptchaV2EnterpriseTaskProxyLess";
  } else {
    taskType = proxy ? "ReCaptchaV2Task" : "ReCaptchaV2TaskProxyLess";
  }

  const task = {
    type: taskType,
    websiteURL: pageUrl,
    websiteKey: siteKey,
  };
  if (isInvisible) task.isInvisible = true;
  if (apiDomain) task.apiDomain = String(apiDomain).replace(/^https?:\/\//, "");
  if (userAgent) task.userAgent = String(userAgent);
  if (proxy?.capSolverProxy) task.proxy = proxy.capSolverProxy;
  const sVal =
    (enterprisePayload && typeof enterprisePayload === "object" && enterprisePayload.s) ||
    recaptchaDataSValue ||
    "";
  if (sVal) {
    if (isEnterprise) task.enterprisePayload = { s: String(sVal) };
    else task.recaptchaDataSValue = String(sVal);
  }

  try {
    await appendLog(
      `CapSolver reCAPTCHA ${task.type} key=${siteKey.slice(0, 14)}… api=${task.apiDomain || "-"} proxy=${proxy ? "yes" : "no"} s=${sVal ? "yes" : "no"}`,
      "warn"
    );
    const createRes = await fetch(CAPSOLVER_CREATE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey, task }),
    });
    const created = await createRes.json();
    if (created?.errorId) {
      return {
        ok: false,
        reason: created.errorDescription || created.errorCode || "create_failed",
        errorId: created.errorId,
      };
    }
    const taskId = created?.taskId;
    if (!taskId) return { ok: false, reason: "no_task_id" };

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      const pollRes = await fetch(CAPSOLVER_RESULT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey, taskId }),
      });
      const polled = await pollRes.json();
      if (polled?.errorId) {
        return {
          ok: false,
          reason: polled.errorDescription || polled.errorCode || "poll_failed",
          errorId: polled.errorId,
        };
      }
      if (polled?.status === "ready") {
        const token =
          polled?.solution?.gRecaptchaResponse ||
          polled?.solution?.token ||
          polled?.solution?.text ||
          "";
        if (!token) return { ok: false, reason: "empty_token" };
        if (!isPlausibleGoogleRecaptchaToken(token)) {
          await appendLog(
            `CapSolver: token invalide (len=${String(token).length}, prefix=${String(token).slice(0, 6)}…) — rejeté`,
            "warn"
          );
          return { ok: false, reason: "implausible_token", tokenPreview: String(token).slice(0, 12) };
        }
        await appendLog(`CapSolver: reCAPTCHA token OK (len=${token.length}, proxy=${proxy ? "yes" : "no"})`, "success");
        return { ok: true, token, provider: "capsolver", taskId, usedProxy: !!proxy };
      }
    }
    return { ok: false, reason: "timeout" };
  } catch (err) {
    console.error("[AmiJobs] CapSolver reCAPTCHA error:", err);
    return { ok: false, reason: err?.message || "network_error" };
  }
}

async function solveRecaptchaWithProviderFallback(opts = {}) {
  const twoKey = await getTwoCaptchaApiKey();
  const capKey = await getCapSolverApiKey();
  const proxy = await getCaptchaProxy();
  const order = [];

  // Indeed Enterprise: proxy tasks first (IP match). ProxyLess last — often returns junk.
  if (proxy) {
    if (capKey) order.push({ p: "capsolver", useProxy: true });
    if (twoKey) order.push({ p: "2captcha", useProxy: true });
  }
  if (capKey) order.push({ p: "capsolver", useProxy: false });
  if (twoKey) order.push({ p: "2captcha", useProxy: false });

  // Dedupe identical provider+proxy flags
  const seen = new Set();
  const uniq = [];
  for (const step of order) {
    const k = `${step.p}|${step.useProxy}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(step);
  }

  if (!uniq.length) return { ok: false, reason: "missing_solver_keys" };

  if (!proxy && /smartapply\.indeed|indeed\./i.test(String(opts.websiteURL || ""))) {
    await appendLog(
      "reCAPTCHA Indeed sans proxy — ProxyLess souvent rejeté. Ajoutez un proxy résidentiel dans Options.",
      "warn"
    );
  }

  let last = { ok: false, reason: "no_provider" };
  for (let i = 0; i < uniq.length; i++) {
    const step = uniq[i];
    const stepOpts = { ...opts, useProxy: step.useProxy };
    if (step.p === "2captcha") {
      last = await solveCaptchaWith2Captcha(stepOpts);
      if (last?.ok) return { ...last, provider: "2captcha" };
    } else {
      last = await solveRecaptchaWithCapSolver(stepOpts);
      if (last?.ok) return last;
    }
    const next = uniq[i + 1];
    if (next) {
      const why = last?.reason || "?";
      const bal = isCaptchaBalanceError(why) ? " (plus de solde)" : "";
      await appendLog(
        `reCAPTCHA ${step.p}${step.useProxy ? "+proxy" : ""} échec (${why})${bal} → fallback ${next.p}${next.useProxy ? "+proxy" : ""}`,
        "warn"
      );
    }
  }
  return last;
}

/**
 * Captcha router:
 * - Cloudflare Turnstile → manual (user clicks widget)
 * - reCAPTCHA → AmiJobs exit API (server CapSolver/2captcha + user-IP exit when ready)
 * - Falls back to local keys / manual for Indeed if server fails
 */
async function solveCaptchaRouted(opts = {}) {
  const t = String(opts.type || opts.captchaType || "").toLowerCase();
  const isTurnstile = t.includes("turnstile") || t.includes("cloudflare");
  if (isTurnstile) {
    return { ok: false, reason: "manual_turnstile" };
  }

  const page = String(opts.websiteURL || opts.pageUrl || opts.url || "");
  const onIndeed = /smartapply\.indeed|indeed\.(com|[a-z]{2})/i.test(page);

  // Prefer AmiJobs cloud solvers (keys on server). User-IP exit when WS is up.
  const remote = await solveCaptchaViaExitApi(opts);
  if (remote?.ok && remote.token) {
    return remote;
  }

  if (onIndeed) {
    await appendLog(
      `reCAPTCHA Indeed: solveur cloud indisponible (${remote?.reason || "fail"}) — cochez la case dans le navigateur (même IP).`,
      "warn"
    );
    return { ok: false, reason: "manual_indeed_recaptcha", remote };
  }
  return solveRecaptchaWithProviderFallback(opts);
}

async function getOrCreateDeviceId() {
  const { amijobsDeviceId } = await chrome.storage.local.get(["amijobsDeviceId"]);
  if (amijobsDeviceId) return String(amijobsDeviceId);
  const id = `ext_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  await chrome.storage.local.set({ amijobsDeviceId: id });
  return id;
}

function stopExitSessionLocal() {
  if (__exitPingTimer) {
    clearInterval(__exitPingTimer);
    __exitPingTimer = null;
  }
  try {
    __exitWs?.close?.();
  } catch (_e) {}
  __exitWs = null;
}

async function stopExitSession() {
  const sid = __exitSession?.sessionId;
  stopExitSessionLocal();
  if (sid) {
    try {
      await fetch(`${AMIJOBS_EXIT_BASE}/v1/session/${encodeURIComponent(sid)}`, {
        method: "DELETE",
        headers: { "X-AmiJobs-Gate": AMIJOBS_EXIT_GATE },
      });
    } catch (_e) {}
  }
  __exitSession = null;
}

async function ensureExitSession() {
  if (__exitSession?.sessionId && __exitWs && __exitWs.readyState <= 1) {
    return __exitSession;
  }
  stopExitSessionLocal();
  const deviceId = await getOrCreateDeviceId();
  // Hard timeout — unbounded fetch used to block openPlatformTabs on Start
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const abortTimer = controller ? setTimeout(() => controller.abort(), 6000) : null;
  let res;
  try {
    res = await fetch(`${AMIJOBS_EXIT_BASE}/v1/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AmiJobs-Gate": AMIJOBS_EXIT_GATE,
      },
      body: JSON.stringify({ deviceId }),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }
  if (!res) throw new Error("exit_session_timeout");
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok || !data.sessionId) {
    throw new Error(data?.reason || `exit_session_http_${res.status}`);
  }
  __exitSession = {
    sessionId: data.sessionId,
    proxy: data.proxy || null,
    deviceId,
    wsUrl: data.wsUrl,
  };
  await connectExitWs(__exitSession);
  await appendLog(
    `Exit AmiJobs connecté (session ${String(data.sessionId).slice(0, 8)}…) — CapSolver via IP utilisateur si tunnel OK`,
    "success"
  );
  return __exitSession;
}

function connectExitWs(session) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(session);
    };
    try {
      const u = new URL(session.wsUrl || `${AMIJOBS_EXIT_BASE.replace(/^http/, "ws")}/v1/exit`);
      u.searchParams.set("sessionId", session.sessionId);
      u.searchParams.set("gate", AMIJOBS_EXIT_GATE);
      const ws = new WebSocket(u.toString());
      __exitWs = ws;
      ws.addEventListener("open", () => {
        try {
          // MV3 cannot open raw TCP for CapSolver CONNECT — announce capability
          ws.send(JSON.stringify({ t: "caps", tcpCapable: false, fetchCapable: true }));
        } catch (_e) {}
        if (__exitPingTimer) clearInterval(__exitPingTimer);
        __exitPingTimer = setInterval(() => {
          try {
            if (ws.readyState === 1) ws.send(JSON.stringify({ t: "ping" }));
          } catch (_e) {}
        }, 25000);
        done();
      });
      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data || ""));
        } catch (_e) {
          return;
        }
        handleExitWsMessage(ws, msg).catch(() => {});
      });
      ws.addEventListener("close", () => {
        if (__exitWs === ws) __exitWs = null;
      });
      ws.addEventListener("error", () => done());
      setTimeout(done, 8000);
    } catch (_e) {
      done();
    }
  });
}

async function handleExitWsMessage(ws, msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.t === "open") {
    // CapSolver HTTPS needs raw TCP CONNECT. Chrome MV3 has no sockets API.
    try {
      ws.send(JSON.stringify({ t: "error", id: msg.id, error: "tcp_unsupported_mv3" }));
    } catch (_e) {}
    return;
  }
  if (msg.t === "fetch") {
    try {
      const headers = msg.headers || {};
      const init = { method: msg.method || "GET", headers, redirect: "follow" };
      if (msg.bodyB64) {
        init.body = Uint8Array.from(atob(msg.bodyB64), (c) => c.charCodeAt(0));
      }
      const r = await fetch(msg.url, init);
      const buf = new Uint8Array(await r.arrayBuffer());
      let bodyB64 = "";
      {
        let s = "";
        const chunk = 0x8000;
        for (let i = 0; i < buf.length; i += chunk) {
          s += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
        }
        bodyB64 = btoa(s);
      }
      const rh = {};
      r.headers.forEach((v, k) => {
        rh[k] = v;
      });
      ws.send(
        JSON.stringify({
          t: "fetchResult",
          id: msg.id,
          ok: true,
          status: r.status,
          statusText: r.statusText,
          headers: rh,
          bodyB64,
        })
      );
    } catch (e) {
      try {
        ws.send(JSON.stringify({ t: "error", id: msg.id, error: String(e?.message || e) }));
      } catch (_e) {}
    }
    return;
  }
  if (msg.t === "close" || msg.t === "data") {
    // TCP streams unsupported — ignore
  }
}

async function solveCaptchaViaExitApi(opts = {}) {
  try {
    await ensureExitSession();
  } catch (e) {
    return { ok: false, reason: "exit_session_failed", error: String(e?.message || e) };
  }
  const sessionId = __exitSession?.sessionId;
  if (!sessionId) return { ok: false, reason: "no_exit_session" };

  const websiteURL = opts.websiteURL || opts.pageUrl || opts.url || "";
  const websiteKey = opts.websiteKey || opts.siteKey || "";
  if (!websiteURL || !websiteKey) return { ok: false, reason: "missing_url_or_key" };

  // Only ask CapSolver to use user-exit proxy when we can actually tunnel CONNECT (we can't on MV3).
  // preferProxy still true enables RESIDENTIAL_PROXY on server if configured.
  const preferProxy = true;

  try {
    const res = await fetch(`${AMIJOBS_EXIT_BASE}/v1/solve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AmiJobs-Gate": AMIJOBS_EXIT_GATE,
      },
      body: JSON.stringify({
        sessionId,
        websiteURL,
        websiteKey,
        isEnterprise: !!opts.isEnterprise || /enterprise/i.test(String(opts.type || "")),
        apiDomain: opts.apiDomain || "",
        userAgent: opts.userAgent || navigator.userAgent || "",
        enterprisePayload: opts.enterprisePayload || null,
        recaptchaDataSValue: opts.recaptchaDataSValue || "",
        preferProxy,
        provider: "auto",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data?.ok && data.token) {
      await appendLog(
        `reCAPTCHA OK via exit (${data.provider}, ${data.proxyMode}, len=${String(data.token).length})`,
        "success"
      );
      return { ok: true, token: data.token, provider: data.provider, proxyMode: data.proxyMode };
    }
    return {
      ok: false,
      reason: data?.reason || data?.error || `exit_solve_${res.status}`,
      proxyMode: data?.proxyMode,
    };
  } catch (e) {
    return { ok: false, reason: "exit_solve_exception", error: String(e?.message || e) };
  }
}

async function solveCaptchaWith2Captcha({
  type = "recaptcha_v2",
  websiteURL,
  websiteKey,
  pageAction = "",
  data = "",
  pagedata = "",
  userAgent = "",
  apiDomain = "",
  isEnterprise = false,
  isInvisible = false,
  enterprisePayload = null,
  recaptchaDataSValue = "",
  useProxy = true,
} = {}) {
  const clientKey = await getTwoCaptchaApiKey();
  if (!clientKey) {
    return { ok: false, reason: "missing_2captcha_key" };
  }
  const pageUrl = String(websiteURL || "").trim();
  const siteKey = String(websiteKey || "").trim();
  if (!pageUrl || !siteKey) {
    return { ok: false, reason: "missing_sitekey_or_url" };
  }

  const proxy = useProxy ? await getCaptchaProxy() : null;

  // Deduplicate parallel identical solves (many frames used to spam 2captcha)
  const dedupeKey = `${String(type).toLowerCase()}|${siteKey}|${pageUrl}|${!!isEnterprise}|${!!proxy}|${pageAction}|${data}`;
  if (!globalThis.__amijobsCaptchaInflight) globalThis.__amijobsCaptchaInflight = new Map();
  const inflight = globalThis.__amijobsCaptchaInflight;
  if (inflight.has(dedupeKey)) {
    try {
      return await inflight.get(dedupeKey);
    } catch (_e) {
      /* fall through */
    }
  }

  const run = (async () => {
  let task;
  const t = String(type || "").toLowerCase();
  const sVal =
    (enterprisePayload && typeof enterprisePayload === "object" && enterprisePayload.s) ||
    recaptchaDataSValue ||
    "";
  if (t.includes("turnstile") || t.includes("cloudflare")) {
    task = {
      type: "TurnstileTaskProxyless",
      websiteURL: pageUrl,
      websiteKey: siteKey,
    };
    // Cloudflare Challenge pages REQUIRE these extras when available
    if (pageAction) task.action = pageAction;
    if (data) task.data = data;
    if (pagedata) task.pagedata = pagedata;
    if (userAgent) task.userAgent = userAgent;
  } else if (isEnterprise || t.includes("enterprise")) {
    task = {
      type: proxy ? "RecaptchaV2EnterpriseTask" : "RecaptchaV2EnterpriseTaskProxyless",
      websiteURL: pageUrl,
      websiteKey: siteKey,
      isInvisible: !!isInvisible,
    };
    if (apiDomain) task.apiDomain = apiDomain.replace(/^https?:\/\//, "");
    if (userAgent) task.userAgent = userAgent;
    if (sVal) task.enterprisePayload = { s: String(sVal) };
    if (proxy) {
      task.proxyType = proxy.proxyType;
      task.proxyAddress = proxy.proxyAddress;
      task.proxyPort = proxy.proxyPort;
      if (proxy.proxyLogin) task.proxyLogin = proxy.proxyLogin;
      if (proxy.proxyPassword) task.proxyPassword = proxy.proxyPassword;
    }
  } else {
    task = {
      type: proxy ? "RecaptchaV2Task" : "RecaptchaV2TaskProxyless",
      websiteURL: pageUrl,
      websiteKey: siteKey,
      isInvisible: !!isInvisible,
    };
    if (apiDomain) task.apiDomain = apiDomain.replace(/^https?:\/\//, "");
    if (userAgent) task.userAgent = userAgent;
    if (sVal) task.recaptchaDataSValue = String(sVal);
    if (proxy) {
      task.proxyType = proxy.proxyType;
      task.proxyAddress = proxy.proxyAddress;
      task.proxyPort = proxy.proxyPort;
      if (proxy.proxyLogin) task.proxyLogin = proxy.proxyLogin;
      if (proxy.proxyPassword) task.proxyPassword = proxy.proxyPassword;
    }
  }

  try {
    await appendLog(
      `2captcha ${task.type} key=${siteKey.slice(0, 12)}… proxy=${proxy ? "yes" : "no"}`,
      "warn"
    );
    const deadline = Date.now() + 180000;
    let taskId = null;
    let recreates = 0;
    const createTask = async () => {
      const createRes = await fetch(TWOCAPTCHA_CREATE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey, task }),
      });
      const created = await createRes.json();
      if (created?.errorId) {
        return {
          ok: false,
          reason: created.errorDescription || "create_failed",
          errorId: created.errorId,
        };
      }
      if (!created?.taskId) return { ok: false, reason: "no_task_id" };
      return { ok: true, taskId: created.taskId };
    };

    const created0 = await createTask();
    if (!created0.ok) {
      await appendLog(`2captcha createTask: ${created0.reason}`, "warn");
      return created0;
    }
    taskId = created0.taskId;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollRes = await fetch(TWOCAPTCHA_RESULT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey, taskId }),
      });
      const polled = await pollRes.json();
      if (polled?.errorId) {
        const reason = polled.errorDescription || "poll_failed";
        await appendLog(`2captcha poll: ${reason}`, "warn");
        // Fresh task rarely helps after "Workers could not solve" — fall through to CapSolver faster
        if (
          recreates < 1 &&
          /workers could not solve|unsolvable|ERROR_CAPTCHA_UNSOLVABLE/i.test(reason)
        ) {
          recreates += 1;
          await appendLog(`2captcha recreateTask ${recreates}/1…`, "warn");
          const again = await createTask();
          if (again.ok) {
            taskId = again.taskId;
            continue;
          }
        }
        try {
          inflight.delete(dedupeKey);
        } catch (_e) {}
        return { ok: false, reason, errorId: polled.errorId };
      }
      if (polled?.status === "ready") {
        const token =
          polled?.solution?.gRecaptchaResponse ||
          polled?.solution?.token ||
          polled?.solution?.text ||
          "";
        if (!token) return { ok: false, reason: "empty_token" };
        if (!isPlausibleGoogleRecaptchaToken(token)) {
          await appendLog(
            `2captcha: token invalide (len=${String(token).length}, prefix=${String(token).slice(0, 6)}…) — rejeté`,
            "warn"
          );
          return { ok: false, reason: "implausible_token" };
        }
        await appendLog(`2captcha: captcha OK (${task.type}, len=${token.length}, proxy=${proxy ? "yes" : "no"})`, "success");
        return {
          ok: true,
          token,
          taskId,
          usedProxy: !!proxy,
          userAgent: polled?.solution?.userAgent || userAgent || "",
        };
      }
    }
    return { ok: false, reason: "timeout" };
  } catch (err) {
    console.error("[AmiJobs] 2captcha error:", err);
    return { ok: false, reason: err?.message || "network_error" };
  }
  })();

  inflight.set(dedupeKey, run);
  try {
    return await run;
  } finally {
    inflight.delete(dedupeKey);
  }
}

function answerYesNoCredential(question, cv, profile = {}) {
  const q = String(question || "").toLowerCase();
  const blob = `${cv || ""} ${profile.education || ""} ${profile.title || ""} ${profile.stack || ""}`.toLowerCase();
  const country =
    self.AmiJobsQuestionPref?.extractCountry?.(q) || (/france|french|francais/.test(q) ? "france" : "");
  if (
    country &&
    /live|living|reside|resid|habit|based|located|leaving|stay|vivre|work|travail|travailler|autoris|right to work|visa|eligible|allowed to/.test(
      q
    )
  ) {
    const locBlob = `${blob} ${profile.location || ""} ${profile.country || ""}`.toLowerCase();
    const countryHints = {
      france: /france|paris|île-de-france|ile-de-france|lyon|marseille|lille|toulouse|nantes|bordeaux|\bidf\b/,
      germany: /allemagne|germany|berlin|munich|deutschland/,
      belgium: /belgique|belgium|bruxelles|brussels/,
      switzerland: /suisse|switzerland|geneve|geneva|zurich/,
      uk: /united kingdom|royaume-uni|london|england/,
      eu: /europe|ue\b|eu\b|européen/,
    };
    if ((countryHints[country] || new RegExp(country, "i")).test(locBlob)) return "Oui";
  }
  const isYn =
    /avez-vous|êtes-vous|etes-vous|poss[eè]dez|disposez|titulaire|do you (have|hold)|are you (a |an )?/i.test(q) ||
    (/dipl[oô]me|certificat|habilitation|permis|licence|qualification/.test(q) &&
      /avez|êtes|etes|poss|dispos|titulaire|\?/.test(q));
  if (!isYn) return null;
  if (/disponib|mobile|télétravail|teletravail|permis de travail|right to work|autoris[eé].*travailler|consent|accepte/i.test(q)) {
    return "Oui";
  }
  const needles = [];
  const add = (s) => {
    const t = String(s || "").toLowerCase().trim();
    if (t.length >= 4) needles.push(t);
  };
  const m = q.match(
    /\b(infirmier(?:e|ère)?|aide[\s-]?soignant(?:e)?|m[eé]decin|pharmacien(?:ne)?|kin[eé]|sage[\s-]?femme|formateur(?:trice)?|comptable|expert[\s-]?comptable|avocat|notaire|architect(?:e)?|ing[eé]nieur)\b/i
  );
  if (m) add(m[1]);
  const m2 = q.match(/dipl[oô]me[^a-zàâäéèêëïîôùûüç]{0,20}(?:d['’]|de|en)\s*([a-zàâäéèêëïîôùûüç][\wàâäéèêëïîôùûüç\s-]{2,40})/i);
  if (m2) add(m2[1].split(/\s+/).slice(0, 3).join(" "));
  const m3 = q.match(/\b(permis\s*[a-z0-9]+|caces|habilitation\s*[a-z0-9]+|toeic|toefl|ielts)\b/i);
  if (m3) add(m3[1]);
  if (!needles.length) {
    for (const tok of q.split(/[^a-zàâäéèêëïîôùûüç0-9+]+/i)) {
      if (
        tok.length >= 5 &&
        !/avez|etes|êtes|vous|diplome|diplôme|certificat|requis|niveau|etudes|études|formation|annee|année|experience|expérience|obtenir/.test(tok)
      ) {
        add(tok);
      }
    }
  }
  if (!blob.trim()) return "Non";
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const mentions = (hayRaw, needle) => {
    const hay = norm(hayRaw);
    const n = norm(needle);
    if (!n || n.length < 4) return false;
    let from = 0;
    while (from < hay.length) {
      const idx = hay.indexOf(n, from);
      if (idx < 0) return false;
      const before = hay.slice(Math.max(0, idx - 48), idx);
      // "pas de diplôme infirmier" / "sans permis B" must not count as possession
      if (/(pas\s+(de\s+|d['’])?|sans\s+|aucun(?:e)?\s+|without\s+|not\s+a\s+|no\s+)/.test(before)) {
        from = idx + n.length;
        continue;
      }
      return true;
    }
    return false;
  };
  const hit = needles.some((n) => mentions(blob, n));
  return hit ? "Oui" : "Non";
}

async function generateAnswer(question, fieldType, options, jobInfo, profile, cvText) {
  const q = String(question || "");
  const cv = String(cvText || profile?.cvText || "");
  const loc = String(profile.location || profile.country || "France").toLowerCase();
  const Q = self.AmiJobsQuestionPref;
  try {
    const { questionPreferences = [] } = await chrome.storage.local.get(["questionPreferences"]);
    const pref = Q?.findMatchingPreference?.(questionPreferences, q);
    if (pref?.answer) {
      if (options?.length) {
        const want = String(pref.answer);
        const hit =
          options.find((o) => String(o).toLowerCase() === want.toLowerCase()) ||
          options.find(
            (o) =>
              String(o).toLowerCase().includes(want.toLowerCase()) ||
              want.toLowerCase().includes(String(o).toLowerCase())
          );
        if (hit) return hit;
        if (/^(oui|yes)$/i.test(want)) {
          const y = options.find((o) => /oui|yes/i.test(String(o)));
          if (y) return y;
        }
        if (/^(non|no)$/i.test(want)) {
          const n = options.find((o) => /non|no/i.test(String(o)));
          if (n) return n;
        }
      }
      return pref.answer;
    }
  } catch (_e) {}

  // Credential / diplôme yes-no BEFORE education fallback (was answering Bac+5 / Oui blindly)
  const yn = answerYesNoCredential(q, cv, profile || {});
  if (yn && (fieldType === "radio" || fieldType === "select" || /oui|non|yes|no/i.test(String(options || "")) || !options?.length)) {
    if (options?.length) {
      const want = yn.toLowerCase() === "oui" ? /oui|yes|true|1/i : /non|no|false|0/i;
      const hit = options.find((o) => want.test(String(o)));
      if (hit) return hit;
    }
    return yn;
  }

  // Years of experience / "Antiquité du poste" — derive from CV/profile, never invent "we"
  if (
    /antiquit|anciennet[ée]|exp[eé]rience|seniority|years?\s*(of\s*)?experience|combien d['’]?ann[ée]es|nombre d['’]?ann[ée]es|ans d['’]?exp/i.test(
      q
    ) &&
    !/avez-vous|dipl[oô]me d/i.test(q)
  ) {
    const fromProfile = String(profile.experience || "").match(/(\d+(?:[.,]\d+)?)/);
    const fromCv =
      cv.match(/(\d+(?:[.,]\d+)?)\s*(?:\+)?\s*(?:ans|ann[ée]es?|years?)\s*(?:d['’]?exp[eé]rience|of\s*experience|exp\.?)/i) ||
      cv.match(/exp[eé]rience[^\n]{0,40}?(\d+(?:[.,]\d+)?)\s*(?:ans|ann[ée]es?|years?)/i) ||
      cv.match(/(\d+(?:[.,]\d+)?)\s*\+\s*(?:ans|years?)/i);
    const years = (fromCv && fromCv[1]) || (fromProfile && fromProfile[1]) || "";
    if (years) {
      const n = years.replace(",", ".");
      const rounded = Math.round(parseFloat(n));
      // Never send 0 / NaN — Indeed rejects invalid numeric screening
      const safe = Number.isFinite(rounded) && rounded > 0 ? rounded : 3;
      return String(safe);
    }
    if (fieldType === "number" || /nombre|combien|années?|year|ans\b|de combien/i.test(q)) {
      return "3";
    }
  }

  // Education / niveau d'études — NOT for "avez-vous un diplôme d'X ?"
  if (
    /niveau|[ée]tudes|education|degree|formation\s*(initiale|scolaire)?/i.test(q) ||
    (/dipl[oô]me/i.test(q) && /niveau|quel| Bac|master|licence/i.test(q))
  ) {
    if (!/avez-vous|êtes-vous|etes-vous|poss[eè]dez|disposez|titulaire/i.test(q)) {
      const edu = String(profile.education || "").trim();
      if (edu) return edu;
      if (options?.length) {
        const real = options.filter(
          (o) => o && !/sélectionn|select(\s+an)?\s*option|choisir|veuillez|^[-—–\s]*$/i.test(String(o))
        );
        const prefer =
          real.find((o) => /bac\s*\+?\s*5|master|ingénieur|ingenieur/i.test(o)) ||
          real.find((o) => /bac\s*\+?\s*4|maîtrise|maitrise/i.test(o)) ||
          real.find((o) => /bac\s*\+?\s*3|licence|bachelor/i.test(o)) ||
          real[0];
        if (prefer) return prefer;
      }
      return "Bac+5";
    }
  }

  // Structured fallbacks BEFORE calling Mistral — avoid off-topic "Oui"
  if (/rythme|alternance.*(école|ecole|entreprise)|jours?\s*(école|ecole|entreprise)|school\s*\/\s*company/i.test(q)) {
    const fromCv =
      cv.match(/(\d\s*j(?:ours?)?\s*(?:école|ecole|en\s*centre)[^\n,]{0,40}\d\s*j(?:ours?)?\s*(?:entreprise|en\s*entreprise))/i) ||
      cv.match(/(\d\s*\/\s*\d[^\n]{0,30}(alternance|école|ecole|entreprise))/i);
    if (fromCv) return fromCv[1].trim();
    if (/france|paris|lyon|marseille|île-de-france|ile-de-france|bordeaux|lille|toulouse/i.test(loc + " " + cv)) {
      return "2 jours école / 3 jours entreprise";
    }
    return "2 jours école / 3 jours entreprise";
  }
  if (/date|xx\s*\/\s*xx|jj\s*\/\s*mm|naissance|disponibilit/i.test(q) && fieldType !== "textarea") {
    if (/naissance|birth|dob/i.test(q) && profile.birthDate) {
      const raw = String(profile.birthDate);
      const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
      return raw;
    }
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  }

  const contextParts = [];
  if (profile.fullName) contextParts.push(`Nom: ${profile.fullName}`);
  if (profile.email) contextParts.push(`Email: ${profile.email}`);
  if (profile.phone) contextParts.push(`Téléphone: ${profile.phone}`);
  if (profile.location) contextParts.push(`Localisation: ${profile.location}`);
  if (profile.title) contextParts.push(`Titre: ${profile.title}`);
  if (profile.experience) contextParts.push(`Expérience: ${profile.experience}`);
  if (profile.stack) contextParts.push(`Compétences: ${profile.stack}`);
  if (profile.languages) contextParts.push(`Langues: ${profile.languages}`);
  const profileContext = contextParts.join("\n");
  const cvContext = cv ? `\n\nCV (texte intégral — source de vérité):\n${cv.substring(0, 6000)}` : "";
  const systemPrompt = `Tu aides à remplir un formulaire de candidature pour ${profile.fullName || "le candidat"}.
${profileContext}${cvContext}
Poste: ${jobInfo?.title || "?"} @ ${jobInfo?.company || "?"}

RÈGLES STRICTES:
- Réponds UNIQUEMENT avec la valeur du champ, sans explication ni phrase.
- Base-toi UNIQUEMENT sur le CV texte, le profil, et les préférences de questions de l'utilisateur.
- Questions oui/non sur diplôme/certificat/permis: réponds "Non" si le CV ne le mentionne pas explicitement.
- Questions résidence / droit de travailler dans le pays du profil: réponds "Oui" si le CV ou la localisation le confirment.
- Pour antiquité / années d'expérience: réponds avec un nombre entier uniquement (ex: 5).
- Interdit: inventer "Oui", "we", "n/a", anglais générique.
- Si l'info manque dans le CV, préfère "Non" (credentials) ou une valeur minimale factuelle.
- Dates au format JJ/MM/AAAA sauf si le champ exige ISO.`;
  let userPrompt = `Question: "${question}"\nType: ${fieldType}`;
  if (options?.length) userPrompt += `\nOptions: ${JSON.stringify(options)}`;
  if (!cv) userPrompt += `\n(ATTENTION: aucun texte CV fourni — ne pas inventer de diplômes)`;
  try {
    const { questionPreferences = [] } = await chrome.storage.local.get(["questionPreferences"]);
    if (questionPreferences?.length) {
      const lines = questionPreferences
        .slice(0, 40)
        .map((p) => `- ${p.question} → ${p.answer}`)
        .join("\n");
      userPrompt += `\n\nPréférences questions (corrections manuelles de l'utilisateur):\n${lines}`;
    }
  } catch (_e) {}
  const ai = await askMistral(systemPrompt, userPrompt, 200);
  if (!ai) {
    // No AI — safe credential default
    const fallbackYn = answerYesNoCredential(q, cv, profile || {});
    return fallbackYn || null;
  }
  let cleaned = ai.trim().replace(/^["'«»]+|["'«»]+$/g, "");
  // Guard: never keep invented Oui on credential questions
  const credYn = answerYesNoCredential(q, cv, profile || {});
  if (credYn && /^(oui|yes)\.?$/i.test(cleaned) && credYn === "Non") {
    return options?.length ? options.find((o) => /non|no/i.test(String(o))) || "Non" : "Non";
  }
  if (/^(oui|yes|we|n\/?a|na|none|null)\.?$/i.test(cleaned) && /rythme|date|combien|salaire|expérience|antiquit|anciennet|niveau|jours|ans/i.test(q)) {
    if (/rythme|alternance/i.test(q)) return "2 jours école / 3 jours entreprise";
    if (/antiquit|anciennet|expérience|ans/i.test(q)) {
      const n = String(profile.experience || "").match(/(\d+)/);
      return n && Number(n[1]) > 0 ? n[1] : "3";
    }
  }
  return cleaned;
}

async function appendLog(message, level = "info", platform = "") {
  const { log = [] } = await chrome.storage.local.get(["log"]);
  const ts = new Date().toLocaleTimeString("fr-FR", { hour12: false });
  const icon = level === "error" ? "❌" : level === "warn" ? "⚠️" : level === "success" ? "✅" : "ℹ️";
  const prefix = platform ? `[${platform}] ` : "";
  log.push(`[${ts}] ${icon} ${prefix}${message}`);
  if (log.length > 1000) log.splice(0, log.length - 1000);
  await chrome.storage.local.set({ log });
}

async function getPlatformSession(platform) {
  const key = SESSION_KEYS[platform];
  const data = await chrome.storage.local.get([key]);
  return data[key] || null;
}

async function setPlatformSession(platform, session) {
  const key = SESSION_KEYS[platform];
  await chrome.storage.local.set({ [key]: session });
}

async function isAnySessionActive() {
  for (const platform of SUPPORTED_PLATFORMS) {
    if ((await getPlatformSession(platform))?.active) return true;
  }
  return false;
}

async function getActivePlatforms() {
  const active = [];
  for (const platform of SUPPORTED_PLATFORMS) {
    if ((await getPlatformSession(platform))?.active) active.push(platform);
  }
  return active;
}

async function openAmiJobsPopup() {
  try {
    if (chrome.action?.openPopup) {
      await chrome.action.openPopup();
      return true;
    }
  } catch (_e) {}
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL("popup.html"),
      type: "popup",
      width: 420,
      height: 620,
      focused: true,
    });
    return true;
  } catch (_e2) {
    return false;
  }
}

async function finalizeMetaSession() {
  const { amijobsMeta = null, stats = { applied: 0, skipped: 0, errors: 0, lastRun: null } } =
    await chrome.storage.local.get(["amijobsMeta", "stats"]);
  if (amijobsMeta?.active) {
    stats.lastRun = new Date().toISOString();
    await chrome.storage.local.set({
      amijobsMeta: { ...amijobsMeta, active: false, endedAt: new Date().toISOString() },
      stats,
      enabled: false,
    });
  }
  await stopExitSession().catch(() => {});
}

const HARD_STOP_REASON = /arr[êe]t|demand|objectif|atteint|manuel|\bstop\b|limite/i;

async function endPlatformSession(platform, reason = "", options = {}) {
  const key = SESSION_KEYS[platform];
  const lastKey = LAST_SESSION_KEYS[platform];
  const { [key]: session = null, stats = { applied: 0, skipped: 0, errors: 0, lastRun: null } } =
    await chrome.storage.local.get([key, "stats"]);

  // Multi-location: if the current location is exhausted (not a hard stop),
  // move on to the next geographic zone instead of ending the session.
  if (session?.active && !HARD_STOP_REASON.test(reason || "")) {
    const locations = Array.isArray(session.locations) ? session.locations : [];
    const nextIndex = (session.locationIndex || 0) + 1;
    if (nextIndex < locations.length) {
      const nextLoc = locations[nextIndex];
      const nextUrl = buildPlatformSearchUrl(platform, session.keywords, nextLoc, session.contracts);
      const boards = boardsForQuery(nextLoc);
      const advanced = resetSessionForLocation(platform, session, nextLoc, nextIndex, nextUrl);
      advanced.countryCode = boards.country;
      if (platform === "indeed") advanced.indeedOrigin = boards.indeedOrigin;
      if (platform === "glassdoor") advanced.glassdoorOrigin = boards.glassdoorOrigin;
      await chrome.storage.local.set({ [key]: advanced });
      await appendLog(
        `Zone suivante: ${nextLoc} → ${String(boards.country || "").toUpperCase()} (${platform === "indeed" ? boards.indeedOrigin : boards.glassdoorOrigin})`,
        "info",
        platform
      );
      await navigatePlatformTab(platform, nextUrl);
      return;
    }
  }

  if (session?.active) {
    stats.applied = (stats.applied || 0) + (session.applied || 0);
    stats.skipped = (stats.skipped || 0) + (session.skipped || 0);
    stats.errors = (stats.errors || 0) + (session.errors || 0);
    stats.lastRun = new Date().toISOString();
    await chrome.storage.local.set({
      [key]: null,
      [lastKey]: { ...session, active: false, endedAt: new Date().toISOString() },
      stats,
    });
    await appendLog(
      reason ? `Session ${platform} terminée: ${reason}` : `Session ${platform} terminée`,
      "info",
      platform
    );
  }

  // Free shared Smart Apply lock when Indeed/Glassdoor session ends
  if (platform === "indeed" || platform === "glassdoor") {
    try {
      await releaseSmartApplyLock(platform);
    } catch (_e) {}
    try {
      await chrome.storage.local.set({ indeedWizardBusy: null, glassdoorSmartApply: null });
    } catch (_e) {}
  }

  // When Indeed finishes its quota, Glassdoor must keep going — clear stale handoff
  // flags and re-kick the Glassdoor SERP (it often stalls waiting on a dead wizard).
  if (platform === "indeed") {
    try {
      const { sessionGlassdoor = null } = await chrome.storage.local.get(["sessionGlassdoor"]);
      if (sessionGlassdoor?.active) {
        if (sessionGlassdoor.awaitingIndeed) {
          await chrome.storage.local.set({
            sessionGlassdoor: {
              ...sessionGlassdoor,
              awaitingIndeed: false,
              indeedHandoffDone: false,
              lastRunAt: 0,
              runLockAt: 0,
            },
            glassdoorSmartApply: null,
          });
        }
        await appendLog("Indeed terminé — reprise Glassdoor", "info", "glassdoor");
        setTimeout(() => {
          kickPlatformSessions(["glassdoor"]).catch(() => {});
        }, 1500);
      }
    } catch (_e) {}
  }

  const stillActive = await isAnySessionActive();
  if (!stillActive) {
    await finalizeMetaSession();
    await appendLog("Toutes les sessions AmiJobs sont terminées", "success");
    if (options.openPopup) {
      setTimeout(() => {
        openAmiJobsPopup().catch(() => {});
      }, 280);
    }
  }
}

async function getState() {
  const data = await chrome.storage.local.get([
    "enabled",
    "stats",
    "log",
    "sessionHellowork",
    "sessionLinkedin",
    "sessionIndeed",
    "sessionGlassdoor",
    "lastSessionHellowork",
    "lastSessionLinkedin",
    "lastSessionIndeed",
    "lastSessionGlassdoor",
    "amijobsMeta",
    "profile",
    "autoApplySettings",
    "appliedJobs",
    "skippedJobs",
    "mistralApiKey",
    "blacklistedCompanies",
    "uiSettings",
    "cvText",
  ]);

  const sessionHellowork = data.sessionHellowork || null;
  const sessionLinkedin = data.sessionLinkedin || null;
  const sessionIndeed = data.sessionIndeed || null;
  const sessionGlassdoor = data.sessionGlassdoor || null;
  const activePlatforms = [];
  if (sessionHellowork?.active) activePlatforms.push("hellowork");
  if (sessionLinkedin?.active) activePlatforms.push("linkedin");
  if (sessionIndeed?.active) activePlatforms.push("indeed");
  if (sessionGlassdoor?.active) activePlatforms.push("glassdoor");

  const rawSettings = data.autoApplySettings || { ...DEFAULT_SETTINGS };
  const autoApplySettings = sanitizeSettings(rawSettings);
  // Persist the repaired settings once if the stored value was corrupted.
  if (JSON.stringify(rawSettings) !== JSON.stringify(autoApplySettings)) {
    await chrome.storage.local.set({ autoApplySettings });
  }

  const amijobsMeta = data.amijobsMeta || null;
  const loginRequired = collectLoginRequiredFromState(amijobsMeta || {}, {
    sessionLinkedin,
    sessionIndeed,
    sessionGlassdoor,
  });

  return {
    enabled: data.enabled !== false,
    stats: data.stats || { applied: 0, skipped: 0, errors: 0, lastRun: null },
    log: data.log || [],
    sessionHellowork,
    sessionLinkedin,
    sessionIndeed,
    sessionGlassdoor,
    lastSessionHellowork: data.lastSessionHellowork || null,
    lastSessionLinkedin: data.lastSessionLinkedin || null,
    lastSessionIndeed: data.lastSessionIndeed || null,
    lastSessionGlassdoor: data.lastSessionGlassdoor || null,
    amijobsMeta,
    loginRequired,
    activePlatforms,
    sessionActive: activePlatforms.length > 0,
    profile: data.profile || { ...DEFAULT_PROFILE },
    cvText: data.cvText || data.profile?.cvText || "",
    autoApplySettings,
    appliedJobs: data.appliedJobs || {},
    skippedJobs: data.skippedJobs || {},
    mistralApiKey: data.mistralApiKey || DEFAULT_MISTRAL_API_KEY,
    blacklistedCompanies: data.blacklistedCompanies || [],
    uiSettings: data.uiSettings || { language: "auto" },
  };
}

async function updatePlatformSessionFromMessage(platform, mutator) {
  const session = await getPlatformSession(platform);
  if (!session) return null;
  mutator(session);
  await setPlatformSession(platform, session);
  return session;
}

async function ensureActiveSessionTabs() {
  try {
    const data = await chrome.storage.local.get([
      "amijobsMeta",
      "sessionHellowork",
      "sessionLinkedin",
      "sessionIndeed",
      "sessionGlassdoor",
    ]);
    if (!data.amijobsMeta?.active) return;
    const checks = [
      ["hellowork", data.sessionHellowork],
      ["linkedin", data.sessionLinkedin],
      ["indeed", data.sessionIndeed],
      ["glassdoor", data.sessionGlassdoor],
    ];
    for (const [platform, session] of checks) {
      if (!session?.active) continue;
      if (platform === "indeed" && session.fromGlassdoor) continue;
      // Keep Glassdoor SERP alive during Smart Apply handoff (tab often becomes Indeed)
      if (platform === "glassdoor" && session.awaitingIndeed) {
        const searchUrl = session.searchUrl || session.resumeSearchUrl || "";
        const existing = await listPlatformTabs("glassdoor");
        if (existing.length === 0 && searchUrl) {
          try {
            await ensureSinglePlatformTab("glassdoor", searchUrl, {
              active: false,
              forceNavigate: true,
            });
          } catch (_e) {}
        }
        continue;
      }
      const searchUrl = session.searchUrl || session.resumeSearchUrl || "";
      if (!searchUrl) continue;
      const existing = await listPlatformTabs(platform);
      if (existing.length > 1) {
        await enforceOneTabPerPlatform("watchdog");
        continue;
      }
      if (existing.length === 1) {
        const tabUrl = existing[0].url || "";
        // Indeed: if only Smart Apply is open, restore SERP in a second tab (do not navigate Apply)
        // Skip while session is mid-apply — restoring SERP caused dual-tab thrash + wizard_timeout.
        if (
          platform === "indeed" &&
          !session.fromGlassdoor &&
          /smartapply|indeedapply/i.test(tabUrl) &&
          searchUrl &&
          session.phase !== "apply" &&
          session.phase !== "viewjob"
        ) {
          const now = Date.now();
          const last = lastPlatformReopenAt[platform] || 0;
          if (now - last >= 45000) {
            lastPlatformReopenAt[platform] = now;
            await ensureSinglePlatformTab(platform, searchUrl, { active: false, forceNavigate: true });
            await appendLog("SERP Indeed restaurée (Smart Apply conservé)", "warn", platform);
          }
        }
        // LinkedIn often lands on /feed after auth — nudge back to jobs search.
        if (platform === "linkedin") {
          if (!/\/jobs/i.test(tabUrl) && !/checkpoint|login|authwall|uas\//i.test(tabUrl)) {
            const now = Date.now();
            const last = lastPlatformReopenAt[platform] || 0;
            if (now - last >= 20000) {
              lastPlatformReopenAt[platform] = now;
              await ensureSinglePlatformTab(platform, searchUrl, { active: false, forceNavigate: true });
              await appendLog("Onglet LinkedIn ramené vers la recherche", "warn", platform);
            }
          }
        }
        // HelloWork hijacked by Free-Work / Google OAuth in the same tab
        if (platform === "hellowork") {
          if (/accounts\.google\.com|free-work\.com|\/signin|\/login/i.test(tabUrl)) {
            const now = Date.now();
            const last = lastPlatformReopenAt[platform] || 0;
            if (now - last >= 12000) {
              lastPlatformReopenAt[platform] = now;
              await chrome.storage.local.set({
                sessionHellowork: {
                  ...session,
                  phase: "search",
                  currentOfferUrl: "",
                },
              });
              // Close orphan Google/Free-Work tabs left behind
              try {
                const all = await chrome.tabs.query({});
                for (const t of all) {
                  const u = t.url || "";
                  if (/accounts\.google\.com|free-work\.com/i.test(u) && t.id !== existing[0].id) {
                    await chrome.tabs.remove(t.id).catch(() => {});
                  }
                }
              } catch (_e) {}
              await ensureSinglePlatformTab(platform, searchUrl, { active: false, forceNavigate: true });
              await appendLog("Onglet HelloWork ramené (login partenaire)", "warn", platform);
            }
          }
        }
        continue;
      }
      const now = Date.now();
      const last = lastPlatformReopenAt[platform] || 0;
      const debounceMs = platform === "linkedin" ? 10000 : 15000;
      if (now - last < debounceMs) continue;
      // Soft-reset reopen budget every ~3 minutes so a transient close can recover
      if (now - last > 180000) platformReopenCount[platform] = 0;
      const maxReopens = platform === "linkedin" ? 8 : 5;
      const count = platformReopenCount[platform] || 0;
      if (count >= maxReopens) continue;
      lastPlatformReopenAt[platform] = now;
      platformReopenCount[platform] = count + 1;
      if (platform === "hellowork") {
        try {
          const all = await chrome.tabs.query({});
          for (const t of all) {
            const u = t.url || "";
            if (/accounts\.google\.com|free-work\.com/i.test(u)) {
              await chrome.tabs.remove(t.id).catch(() => {});
            }
          }
        } catch (_e) {}
        await chrome.storage.local.set({
          sessionHellowork: { ...session, phase: "search", currentOfferUrl: "" },
        });
      }
      await ensureSinglePlatformTab(platform, searchUrl, { active: false, forceNavigate: true });
      await appendLog(`Onglet ${platform} restauré (manquant)`, "warn", platform);
    }
  } catch (_e) {
    /* ignore */
  }
}

// Restore missing platform tabs while a session is active (e.g. LinkedIn auth redirect)
setInterval(() => {
  ensureActiveSessionTabs().catch(() => {});
}, 12000);

// Auto-resume after the user finishes Indeed login (SPA may skip a clean onUpdated)
setInterval(() => {
  (async () => {
    const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
    if (!amijobsMeta?.indeedLoginRequired) return;
    const tabs = await listPlatformTabs("indeed");
    const resumed = tabs.find((t) => urlLooksIndeedLoggedIn(t.url || ""));
    if (resumed) {
      await clearIndeedLoginGate("poll_after_auth");
      return;
    }
    // Keep auth tab focused occasionally so the user notices
    const auth = tabs.find((t) => isIndeedLoginWallUrl(t.url || ""));
    if (auth?.id && amijobsMeta.indeedLoginTabId == null) {
      await chrome.storage.local.set({
        amijobsMeta: { ...amijobsMeta, indeedLoginTabId: auth.id },
      });
    }
  })().catch(() => {});
}, 8000);

// Hard cap: never more than 1 tab per job board
function isIndeedHandoffApplyUrl(url = "") {
  if (isIndeedLoginWallUrl(url)) return false;
  try {
    const u = new URL(String(url || ""), "https://indeed.com");
    const hostPath = `${u.hostname}${u.pathname}`;
    if (!/indeed\.(com|fr)|smartapply\.indeed/i.test(hostPath)) return false;
    if (/help\.|support\.|\/hc\/|guidelines|articles\/|job-seeker/i.test(hostPath)) return false;
    // Host+path only — never match smartapply inside ?continue=
    return /smartapply|indeedapply|\/viewjob|\/rc\/clk|\/pagead\/clk|applybyapplyablejobid|onboarding\.indeed/i.test(hostPath);
  } catch (_e) {
    const s = String(url || "").split(/[?#]/)[0];
    if (!/indeed\.(com|fr)|smartapply\.indeed|onboarding\.indeed/i.test(s)) return false;
    if (/help\.|support\.|\/hc\/|guidelines|articles\/|job-seeker/i.test(s)) return false;
    return /smartapply|indeedapply|\/viewjob|\/rc\/clk|\/pagead\/clk|applybyapplyablejobid|onboarding/i.test(s);
  }
}

async function noteIndeedHandoffCapture(tabId, url) {
  const cap = indeedHandoffCapture;
  if (!cap || Date.now() > (cap.until || 0)) return false;
  if (!isIndeedHandoffApplyUrl(url)) return false;
  if (cap.url && /smartapply|indeedapply/i.test(cap.url) && !/smartapply|indeedapply/i.test(url)) {
    return true; // already have a better URL
  }
  indeedHandoffCapture = { ...cap, url, tabId: tabId || cap.tabId || null };
  // Claim into Indeed apply slot so Glassdoor SERP stays put
  try {
    await ensureSinglePlatformTab("indeed", url, { active: true, forceNavigate: true });
  } catch (_e) {}
  return true;
}

chrome.tabs.onCreated.addListener((tab) => {
  const pending = tab?.pendingUrl || tab?.url || "";
  if (indeedHandoffCapture && Date.now() <= (indeedHandoffCapture.until || 0) && pending) {
    noteIndeedHandoffCapture(tab.id, pending).catch(() => {});
  }
  // Cull immediately — Loading… Smart Apply tabs pile up in <1s if we wait
  if (/smartapply|indeedapply|applybyapplyablejobid|indeed\.(com|fr)|glassdoor\./i.test(pending)) {
    enforceOneTabPerPlatform("nouvel onglet").catch(() => {});
  }
  setTimeout(() => enforceOneTabPerPlatform("nouvel onglet").catch(() => {}), 400);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || changeInfo.pendingUrl || tab?.url || "";
  if (indeedHandoffCapture && url && Date.now() <= (indeedHandoffCapture.until || 0)) {
    noteIndeedHandoffCapture(tabId, url).catch(() => {});
  }
  if (!url) return;
  const platform = detectPlatformFromUrl(url) || (/smartapply|indeedapply/i.test(url) ? "indeed" : null);
  if (!platform) return;
  enforceOneTabPerPlatform("navigation").catch(() => {});
});

let reopeningPlatformTab = false;
chrome.tabs.onRemoved.addListener(async () => {
  if (reopeningPlatformTab || tabEnforceLock) return;
  try {
    const data = await chrome.storage.local.get([
      "amijobsMeta",
      "sessionHellowork",
      "sessionLinkedin",
      "sessionIndeed",
      "sessionGlassdoor",
    ]);
    if (!data.amijobsMeta?.active) return;

    const checks = [
      ["hellowork", data.sessionHellowork],
      ["linkedin", data.sessionLinkedin],
      ["indeed", data.sessionIndeed],
      ["glassdoor", data.sessionGlassdoor],
    ];

    for (const [platform, session] of checks) {
      if (!session?.active) continue;
      if (platform === "indeed" && session.fromGlassdoor) continue;

      const searchUrl = session.searchUrl || session.resumeSearchUrl || "";

      // During Glassdoor→Indeed handoff the Glassdoor tab often navigates to Smart Apply
      // and disappears from listPlatformTabs("glassdoor"). Always restore the SERP tab so
      // the user still sees Glassdoor running (avoids "crash" / only-Indeed look).
      if (platform === "glassdoor" && session.awaitingIndeed) {
        const gdTabs = await listPlatformTabs("glassdoor");
        if (gdTabs.length === 0 && searchUrl) {
          const now = Date.now();
          if (now - lastGlassdoorSerpRestoreAt < 15000) continue;
          const last = lastPlatformReopenAt.glassdoor || 0;
          if (now - last > 8000) {
            lastPlatformReopenAt.glassdoor = now;
            lastGlassdoorSerpRestoreAt = now;
            try {
              await ensureSinglePlatformTab("glassdoor", searchUrl, {
                active: false,
                forceNavigate: true,
              });
              await appendLog(
                "SERP Glassdoor restauré pendant Smart Apply (évite onglet disparu)",
                "info",
                "glassdoor"
              );
            } catch (_e) {}
          }
        }
        continue;
      }

      if (!searchUrl) continue;

      // Count ANY platform tab (including Smart Apply) — do not reopen while applying
      const existing = await listPlatformTabs(platform);
      if (existing.length > 0) {
        if (existing.length > 1) await enforceOneTabPerPlatform("après fermeture");
        continue;
      }

      const now = Date.now();
      const last = lastPlatformReopenAt[platform] || 0;
      const debounceMs = platform === "linkedin" ? 10000 : 20000;
      if (now - last < debounceMs) continue; // hard debounce
      if (now - last > 180000) platformReopenCount[platform] = 0;
      const maxReopens = platform === "linkedin" ? 8 : 3;
      const count = platformReopenCount[platform] || 0;
      if (count >= maxReopens) {
        await appendLog(
          `Réouverture ${platform} bloquée (max ${maxReopens}) — évite crash PC`,
          "warn",
          platform
        );
        continue;
      }

      reopeningPlatformTab = true;
      lastPlatformReopenAt[platform] = now;
      platformReopenCount[platform] = count + 1;
      try {
        await ensureSinglePlatformTab(platform, searchUrl, { active: false, forceNavigate: true });
        await appendLog(`Onglet ${platform} rouvert (fermé pendant la session)`, "warn", platform);
      } finally {
        reopeningPlatformTab = false;
      }
    }
  } catch (_e) {
    reopeningPlatformTab = false;
  }
});

function profileFromAppPayload(msg) {
  const p = msg.profile || {};
  return {
    fullName: p.fullName || "",
    email: p.email || "",
    phone: p.phone || "",
    linkedin: p.linkedin || "",
    location: p.location || "",
    postalCode: p.postalCode || "",
    title: p.title || "",
    experience: p.experience || "",
    stack: p.stack || "",
    languages: p.languages || "",
    availability: p.availability || "",
    salaryExpectation: p.salaryExpectation || p.salary || "",
    cvText: msg.cvText || p.cvText || "",
  };
}

async function syncFromApp(msg) {
  const existing = await chrome.storage.local.get([
    "profile",
    "autoApplySettings",
    "mistralApiKey",
    "blacklistedCompanies",
    "cvText",
  ]);
  const updates = {};

  if (msg.profile || msg.cvText !== undefined) {
    updates.profile = { ...(existing.profile || DEFAULT_PROFILE), ...profileFromAppPayload(msg) };
  }
  if (msg.cvText !== undefined) updates.cvText = msg.cvText;
  if (Array.isArray(msg.blacklistedCompanies)) {
    updates.blacklistedCompanies = msg.blacklistedCompanies;
  }
  if (msg.mistralApiKey) updates.mistralApiKey = msg.mistralApiKey;
  if (msg.autoApplySettings) {
    updates.autoApplySettings = sanitizeSettings({ ...(existing.autoApplySettings || DEFAULT_SETTINGS), ...msg.autoApplySettings });
  }
  if (msg.maxJobsPerSession) {
    updates.autoApplySettings = sanitizeSettings({
      ...(updates.autoApplySettings || existing.autoApplySettings || DEFAULT_SETTINGS),
      maxJobsPerSession: msg.maxJobsPerSession,
    });
  }

  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  await appendLog("Profil synchronisé depuis l'app web", "success");
  return { ok: true, syncedAt: new Date().toISOString() };
}

async function startMultiSession(msg) {
  const platforms = (msg.platforms || []).filter((p) => SUPPORTED_PLATFORMS.includes(p));
  if (platforms.length === 0) return { ok: false, reason: "no_platform" };

  const stored = await chrome.storage.local.get(["autoApplySettings"]);
  const settings = sanitizeSettings(stored.autoApplySettings || DEFAULT_SETTINGS);
  const maxJobs = clampInt(msg.maxJobs ?? settings.maxJobsPerSession, 1, 10000, 25);
  const keywords = msg.keywords || "";
  // Backward compatible: accept either a single location/contract or arrays.
  let locations = asArray(msg.locations).length ? asArray(msg.locations) : asArray(msg.location);
  if (locations.length) locations = await normalizeLocations(locations);
  const contracts = asArray(msg.contracts).length ? asArray(msg.contracts) : asArray(msg.contract);
  const location = locations[0] || "";
  const locationsOrEmpty = locations.length ? locations : [""];

  const parallelDual = platforms.includes("indeed") && platforms.includes("glassdoor");
  const amijobsMeta = {
    active: true,
    platforms,
    keywords,
    location,
    locations: locationsOrEmpty,
    contracts,
    maxJobs,
    startedAt: new Date().toISOString(),
    indeedLoginRequired: false,
    linkedinLoginRequired: false,
    glassdoorLoginRequired: false,
    parallelSmartApply: parallelDual,
    platformWindowIds: {},
    platformTabIds: {},
  };

  const updates = { amijobsMeta, enabled: true };
  const urls = {};
  const common = { keywords, location, locations: locationsOrEmpty, locationIndex: 0, contracts, maxJobs };

  if (platforms.includes("hellowork")) {
    const searchUrl = msg.helloworkUrl || buildHelloworkSearchUrl(keywords, location, contracts);
    urls.hellowork = searchUrl;
    updates.sessionHellowork = emptyPlatformSession("hellowork", {
      ...common,
      searchUrl,
      resumeSearchUrl: searchUrl,
    });
  }

  if (platforms.includes("linkedin")) {
    const searchUrl =
      msg.linkedinUrl ||
      buildLinkedInSearchUrl(keywords, location, contracts, {
        onlyEasyApply: settings.onlyEasyApply,
        allowExternalApply: settings.allowExternalApply,
        skipFormationOffers: settings.skipFormationOffers,
      });
    urls.linkedin = searchUrl;
    updates.sessionLinkedin = emptyPlatformSession("linkedin", {
      ...common,
      searchUrl,
      onlyEasyApply: settings.onlyEasyApply !== false,
      allowExternalApply: settings.allowExternalApply === true,
    });
  }

  if (platforms.includes("indeed")) {
    const boards = boardsForQuery(location);
    const searchUrl = msg.indeedUrl || buildIndeedSearchUrl(keywords, location, 0, contracts);
    urls.indeed = searchUrl;
    updates.sessionIndeed = emptyPlatformSession("indeed", {
      ...common,
      searchUrl,
      countryCode: boards.country,
      indeedOrigin: boards.indeedOrigin,
    });
  }

  if (platforms.includes("glassdoor")) {
    const boards = boardsForQuery(location);
    const searchUrl = msg.glassdoorUrl || buildGlassdoorSearchUrl(keywords, location, contracts);
    urls.glassdoor = searchUrl;
    updates.sessionGlassdoor = emptyPlatformSession("glassdoor", {
      ...common,
      searchUrl,
      countryCode: boards.country,
      glassdoorOrigin: boards.glassdoorOrigin,
      deferredUntilIndeedDone: false,
    });
  }

  // Shared Smart Apply state — dual mode runs wizards in parallel (separate windows)
  updates.amijobsSmartApplyLock = null;
  updates.amijobsSmartApplyPrefer = null;
  updates.amijobsSmartApplyOwners = {};

  await chrome.storage.local.set(updates);
  // Reset reopen storm counters + window memory for this run
  for (const p of platforms) {
    platformReopenCount[p] = 0;
    lastPlatformReopenAt[p] = 0;
    delete platformWindowIds[p];
    delete platformTabIds[p];
  }

  await appendLog(
    `Session AmiJobs démarrée (${platforms.join(" + ")}): "${keywords}" @ "${locationsOrEmpty.join(", ")}"` +
      (contracts.length ? ` [${contracts.join(", ")}]` : ""),
    "success"
  );
  await appendLog(
    `Start multi: platforms=${platforms.join(",")} count=${platforms.length} → ${platforms.length >= 2 ? "1 fenêtre / board" : "onglet unique"}`,
    "info"
  );
  if (platforms.includes("indeed") || platforms.includes("glassdoor")) {
    const boards = boardsForQuery(location);
    await appendLog(
      `Boards ${String(boards.country || "").toUpperCase()}: Indeed ${boards.indeedOrigin} · Glassdoor ${boards.glassdoorOrigin}`,
      "info"
    );
  }
  if (parallelDual) {
    await appendLog(
      "Mode parallèle Indeed+Glassdoor — les 2 SERP actifs, Smart Apply en alternance (1 seul)",
      "info"
    );
  }

  // Open windows FIRST — login soft-checks / Exit tunnel / captcha must never block this
  const openOrder = [...platforms];
  let openResult = null;
  try {
    openResult = await openPlatformTabs(urls, openOrder);
  } catch (e) {
    await appendLog(
      `openPlatformTabs erreur non fatale: ${String(e?.message || e)} — retry best-effort`,
      "error"
    );
    try {
      openResult = await openPlatformTabs(urls, openOrder);
    } catch (e2) {
      await appendLog(`openPlatformTabs retry échoué: ${String(e2?.message || e2)}`, "error");
      openResult = { ok: false, error: String(e2?.message || e2) };
    }
  }

  // Exit session is best-effort AFTER tabs/windows are visible
  ensureExitSession().catch(async (e) => {
    await appendLog(`Exit AmiJobs: connexion différée (${String(e?.message || e)})`, "warn");
  });

  setTimeout(() => {
    // First kick must force-inject — tabs are fresh and may not have content scripts yet
    kickPlatformSessions(openOrder, { forceInject: true }).catch(() => {});
  }, 2000);

  return {
    ok: true,
    urls,
    platforms,
    open: openResult,
    windowsExpected: platforms.length >= 2 ? platforms.length : 0,
  };
}

async function isCloudflarePauseActive() {
  try {
    const { amijobsCfPause = null } = await chrome.storage.local.get(["amijobsCfPause"]);
    if (!amijobsCfPause?.until) return false;
    if (Date.now() < amijobsCfPause.until) return true;
    await chrome.storage.local.set({ amijobsCfPause: null });
  } catch (_e) {}
  return false;
}

function tabLooksLikeCloudflareChallenge(tab) {
  const title = String(tab?.title || "").toLowerCase();
  const url = String(tab?.url || "");
  return (
    /just a moment|un instant|additional verification|cloudflare/i.test(title) ||
    /cdn-cgi\/challenge|challenges\.cloudflare/i.test(url)
  );
}

async function kickPlatformSessions(platforms = [], { forceInject = false } = {}) {
  if (await isCloudflarePauseActive()) {
    return; // Never kick / re-inject while CF challenge is up (Ray ID thrash)
  }
  for (const platform of platforms) {
    try {
      const tabs = await listPlatformTabs(platform);
      for (const tab of tabs.slice(0, 1)) {
        if (!tab?.id) continue;
        if (tabLooksLikeCloudflareChallenge(tab)) continue;
        let pingOk = false;
        if (!forceInject) {
          try {
            const st = await chrome.tabs.sendMessage(tab.id, { action: "getContentStatus" });
            pingOk = !!st;
          } catch (_e) {
            pingOk = false;
          }
        }
        if (forceInject || !pingOk) {
          try {
            // Keep force-inject file lists aligned with manifest content_scripts
            if (platform === "glassdoor") {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: false },
                files: [
                  "content/geo-boards.js",
                  "content/question-pref.js",
                  "content/shared-autofill.js",
                  "content/company-site.js",
                  "content/glassdoor.js",
                  "content/cloudflare-turnstile.js",
                  "content/google-recaptcha.js",
                ],
              });
            } else if (platform === "linkedin") {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: false },
                files: ["content/company-site.js", "content/linkedin.js"],
              });
            } else if (platform === "indeed") {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: false },
                files: [
                  "content/geo-boards.js",
                  "content/question-pref.js",
                  "content/shared-autofill.js",
                  "content/company-site.js",
                  "content/indeed.js",
                  "content/cloudflare-turnstile.js",
                  "content/google-recaptcha.js",
                ],
              });
            }
          } catch (_e) {
            /* already injected */
          }
        }
        // Small delay after inject so listeners register before startAutoApply
        if (forceInject || !pingOk) await new Promise((r) => setTimeout(r, 400));
        chrome.tabs.sendMessage(tab.id, { action: "startAutoApply" }).catch(() => {});
      }
    } catch (_e) {
      /* ignore */
    }
  }
}

function handleMessage(msg, sendResponse, sender = null) {
  if (msg.action === "uploadCvViaDebugger") {
    (async () => {
      const tabId = msg.tabId || sender?.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, reason: "no_tab" });
        return;
      }
      const r = await uploadCvViaDebugger(tabId);
      sendResponse(r);
    })();
    return true;
  }

  if (msg.action === "ping") {
    sendResponse({ ok: true, version: EXT_VERSION });
    return false;
  }

  if (msg.action === "injectTurnstileClicker") {
    (async () => {
      // Prefer explicit tabId (e.g. from options) over sender.tab (which is the options page itself)
      const tabId = msg.tabId || sender?.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, reason: "no_tab" });
        return;
      }
      // BBQ path: full background orchestrator (Verify click → 2captcha → callback)
      const r = await orchestrateCloudflareTurnstileSolve(tabId, msg.params || null);
      sendResponse(r);
    })();
    return true;
  }

  if (msg.action === "orchestrateCloudflareTurnstile") {
    (async () => {
      const tabId = msg.tabId || sender?.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, reason: "no_tab" });
        return;
      }
      const r = await orchestrateCloudflareTurnstileSolve(tabId, msg.params || null);
      sendResponse(r);
    })();
    return true;
  }

  if (msg.action === "injectTurnstileToken") {
    (async () => {
      const tabId = msg.tabId || sender?.tab?.id;
      const token = msg.token || "";
      const ua = String(msg.userAgent || "").trim();
      if (!tabId || !token) {
        sendResponse({ ok: false, reason: "missing" });
        return;
      }
      try {
        const r = await injectCloudflareTurnstileToken(tabId, token, ua);
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, reason: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "openPlatformTabs") {
    (async () => {
      try {
        const open = await openPlatformTabs(msg.urls || {}, msg.platforms || []);
        const plats = open?.ordered || msg.platforms || [];
        if (msg.kick !== false && plats.length) {
          setTimeout(() => {
            kickPlatformSessions(plats, { forceInject: true }).catch(() => {});
          }, 1800);
        }
        sendResponse({ ok: true, open });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg.action === "ensurePlatformTab") {
    (async () => {
      const url = String(msg.url || "");
      // Never park help/support articles in the Indeed apply slot
      if (
        msg.platform === "indeed" &&
        url &&
        /help\.|support\.|\/hc\/|guidelines|articles\/|job-seeker/i.test(url)
      ) {
        sendResponse({ ok: false, reason: "indeed_help_url_blocked" });
        return;
      }
      if (msg.platform === "indeed" && url && isIndeedLoginWallUrl(url)) {
        await handleIndeedLoginWall(null, url);
        sendResponse({ ok: false, reason: "indeed_login_wall" });
        return;
      }
      if (msg.platform === "indeed" && url && !isIndeedLoginWallUrl(url)) {
        const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
        if (amijobsMeta?.indeedLoginRequired) {
          // Do not open more apply tabs until the user finishes signing in
          sendResponse({ ok: false, reason: "indeed_login_required" });
          return;
        }
      }
      try {
        // Glassdoor Easy Apply → open Smart Apply in the Glassdoor window (not Indeed's)
        let windowId = msg.windowId != null ? msg.windowId : null;
        if (windowId == null && msg.windowOwner) {
          windowId = await getPlatformWindowId(msg.windowOwner);
        }
        if (windowId == null && msg.platform === "indeed" && msg.fromGlassdoor) {
          windowId = await getPlatformWindowId("glassdoor");
        }
        const tabId = await ensureSinglePlatformTab(msg.platform, msg.url, {
          active: !!msg.active,
          forceNavigate: msg.forceNavigate !== false,
          windowId,
        });
        sendResponse({ ok: true, tabId });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg.action === "enforceOneTabPerPlatform") {
    enforceOneTabPerPlatform(msg.reason || "request")
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg.action === "syncFromApp") {
    syncFromApp(msg).then(sendResponse);
    return true;
  }

  if (msg.action === "getState") {
    getState().then(sendResponse);
    return true;
  }

  if (msg.action === "indeedLocationSuggestions") {
    const q = msg.query || "";
    const boards = boardsForQuery(q);
    fetchIndeedLocationSuggestions(q, msg.country || boards.suggestCountry, msg.language || boards.suggestLanguage).then(
      (suggestions) => sendResponse({ ok: true, suggestions, boards })
    );
    return true;
  }

  if (msg.action === "normalizeLocations") {
    normalizeLocations(asArray(msg.locations)).then((locations) => sendResponse({ ok: true, locations }));
    return true;
  }

  if (msg.action === "checkPlatformLogins") {
    checkPlatformLogins(msg.platforms || [], msg.location || "")
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, needsLogin: [], results: {}, error: String(e?.message || e) }));
    return true;
  }

  if (msg.action === "openPlatformLogin") {
    (async () => {
      const platform = msg.platform;
      const url = msg.url || platformLoginUrl(platform, msg.location || "");
      if (!url) {
        sendResponse({ ok: false, reason: "no_url" });
        return;
      }
      try {
        await chrome.tabs.create({ url, active: true });
        sendResponse({ ok: true, url });
      } catch (e) {
        sendResponse({ ok: false, reason: String(e?.message || e) });
      }
    })();
    return true;
  }

  if (msg.action === "platformLoginRequired") {
    handlePlatformLoginRequired(msg.platform, {
      url: msg.url || "",
      reason: msg.reason || "",
      loginUrl: msg.loginUrl || "",
    })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg.action === "startMultiSession" || msg.action === "startSession") {
    startMultiSession(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, reason: String(e?.message || e) }));
    return true;
  }

  if (msg.action === "endPlatformSession") {
    endPlatformSession(msg.platform, msg.reason || "", { openPopup: !!msg.openPopup }).then(() =>
      sendResponse({ ok: true })
    );
    return true;
  }

  if (msg.action === "endSession") {
    (async () => {
      const platforms = await getActivePlatforms();
      for (const p of platforms) await endPlatformSession(p, msg.reason || "Arrêt manuel");
      if (platforms.length === 0) await finalizeMetaSession();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "updateSession") {
    (async () => {
      const platform = msg.platform || "linkedin";
      const key = SESSION_KEYS[platform];
      const { [key]: session = null } = await chrome.storage.local.get([key]);
      if (session) {
        Object.assign(session, msg.updates || {});
        await chrome.storage.local.set({ [key]: session });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "resumeLastSession") {
    (async () => {
      const platform = msg.platform;
      if (!platform || !LAST_SESSION_KEYS[platform]) {
        sendResponse({ ok: false, reason: "invalid_platform" });
        return;
      }
      const lastKey = LAST_SESSION_KEYS[platform];
      const activeKey = SESSION_KEYS[platform];
      const data = await chrome.storage.local.get([lastKey, activeKey, "amijobsMeta"]);
      if (data[activeKey]?.active) {
        sendResponse({ ok: false, reason: "session_already_active" });
        return;
      }
      const last = data[lastKey];
      if (!last) {
        sendResponse({ ok: false, reason: "no_last_session" });
        return;
      }
      const { autoApplySettings = {} } = await chrome.storage.local.get(["autoApplySettings"]);
      const settings = sanitizeSettings(autoApplySettings || DEFAULT_SETTINGS);
      const resumed = {
        ...last,
        active: true,
        endedAt: undefined,
        // Restore Easy Apply flags so pagination/resume keep f_AL=true
        onlyEasyApply:
          last.onlyEasyApply !== undefined ? last.onlyEasyApply !== false : settings.onlyEasyApply !== false,
        allowExternalApply:
          last.allowExternalApply !== undefined
            ? last.allowExternalApply === true
            : settings.allowExternalApply === true,
      };
      let targetUrl = "";
      if (platform === "hellowork") {
        targetUrl =
          resumed.phase === "offer" && resumed.currentOfferUrl
            ? resumed.currentOfferUrl
            : resumed.resumeSearchUrl || resumed.searchUrl;
      } else if (platform === "indeed") {
        targetUrl = resumed.searchUrl || buildIndeedSearchUrl(resumed.keywords, resumed.location, resumed.currentPage || 0, resumed.contracts);
      } else if (platform === "glassdoor") {
        targetUrl = resumed.searchUrl || buildGlassdoorSearchUrl(resumed.keywords, resumed.location, resumed.contracts);
      } else {
        // LinkedIn: prefer stored searchUrl (page + f_AL), else rebuild with flags + page
        targetUrl =
          resumed.searchUrl ||
          buildLinkedInSearchUrl(resumed.keywords, resumed.location, resumed.contracts, {
            onlyEasyApply: resumed.onlyEasyApply,
            allowExternalApply: resumed.allowExternalApply,
            page: resumed.currentPage || 0,
            currentPage: resumed.currentPage || 0,
          });
        resumed.searchUrl = targetUrl;
        resumed.currentPage = resumed.currentPage || 0;
      }

      // Persist this board first, then union ALL currently-active boards (multi-resume)
      await chrome.storage.local.set({ [activeKey]: resumed, enabled: true });
      const sessionSnap = await chrome.storage.local.get([
        "amijobsMeta",
        "sessionHellowork",
        "sessionLinkedin",
        "sessionIndeed",
        "sessionGlassdoor",
      ]);
      const activePlatforms = SUPPORTED_PLATFORMS.filter((p) => sessionSnap[SESSION_KEYS[p]]?.active);
      await chrome.storage.local.set({
        amijobsMeta: {
          ...(sessionSnap.amijobsMeta || data.amijobsMeta || {}),
          active: true,
          platforms: activePlatforms.length ? activePlatforms : [platform],
        },
      });
      await appendLog(
        `Session ${platform} reprise (actives: ${(activePlatforms.length ? activePlatforms : [platform]).join(", ")})`,
        "success",
        platform
      );
      sendResponse({ ok: true, targetUrl, platform, platforms: activePlatforms });
    })();
    return true;
  }

  if (msg.action === "getProfile") {
    (async () => {
      const { profile = DEFAULT_PROFILE, cvText = "" } = await chrome.storage.local.get(["profile", "cvText"]);
      sendResponse({ ...profile, cvText: cvText || profile.cvText || "" });
    })();
    return true;
  }

  if (msg.action === "askMistral") {
    askMistral(msg.systemPrompt || "", msg.userPrompt || "", msg.maxTokens || 300).then((answer) =>
      sendResponse({ answer })
    );
    return true;
  }

  if (msg.action === "recordQuestionPreference") {
    (async () => {
      const Q = self.AmiJobsQuestionPref;
      const question = String(msg.question || "").trim();
      const answer = String(msg.answer || "").trim();
      if (!Q || !question || !answer) {
        sendResponse({ ok: false, reason: "invalid" });
        return;
      }
      const { questionPreferences = [] } = await chrome.storage.local.get(["questionPreferences"]);
      const r = Q.upsertQuestionPreference(questionPreferences, question, answer);
      if (r.changed) {
        await chrome.storage.local.set({ questionPreferences: r.prefs });
        await appendLog(
          `Question preference ${r.updated ? "mise à jour" : "ajoutée"}: «${question.slice(0, 80)}» → ${answer}`,
          "info"
        );
      }
      sendResponse({ ok: true, changed: !!r.changed, updated: !!r.updated, skipped: r.skipped || "" });
    })();
    return true;
  }

  if (msg.action === "generateAnswer") {
    (async () => {
      const state = await getState();
      const answer = await generateAnswer(
        msg.question,
        msg.fieldType,
        msg.options,
        msg.jobInfo,
        state.profile,
        msg.cvText || state.cvText || state.profile?.cvText || ""
      );
      sendResponse({ answer });
    })();
    return true;
  }

  if (msg.action === "listIndeedTabs") {
    listPlatformTabs("indeed")
      .then((tabs) => {
        const applyTabs = tabs.filter((t) =>
          /smartapply|indeedapply|applybyapplyablejobid|\/viewjob|\/pagead\/clk|\/rc\/clk|\/apply\b|onboarding\.indeed/i.test(
            t.url || ""
          )
        );
        const hasSmartApply = tabs.some((t) =>
          /smartapply|indeedapply|applybyapplyablejobid|onboarding\.indeed/i.test(t.url || "")
        );
        const hasApplyTab = applyTabs.length > 0;
        const hasSerp = tabs.some(
          (t) => /\/jobs\b/i.test(t.url || "") && !/smartapply|indeedapply|\/viewjob|\/rc\/clk/i.test(t.url || "")
        );
        sendResponse({
          ok: true,
          count: tabs.length,
          applyCount: applyTabs.length,
          hasSmartApply,
          hasApplyTab,
          hasSerp,
        });
      })
      .catch((e) => sendResponse({ ok: false, reason: e.message }));
    return true;
  }

  if (msg.action === "nudgeIndeedSmartApply") {
    (async () => {
      try {
        const tabs = await listPlatformTabs("indeed");
        const applies = tabs.filter((t) =>
          /smartapply|indeedapply|applybyapplyablejobid|\/viewjob|\/pagead\/clk|\/rc\/clk|onboarding\.indeed/i.test(t.url || "")
        );
        for (const apply of applies.slice(0, 2)) {
          if (!apply?.id) continue;
          await chrome.tabs.sendMessage(apply.id, { action: "startAutoApply" }).catch(() => {});
        }
        sendResponse({ ok: true, nudged: applies.length > 0, count: applies.length });
      } catch (e) {
        sendResponse({ ok: false, reason: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "peekSmartApplyLock") {
    peekSmartApplyLock(msg.ttlMs || SMART_APPLY_LOCK_TTL_MS)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, reason: e.message }));
    return true;
  }
  if (msg.action === "acquireSmartApplyLock") {
    acquireSmartApplyLock(msg.owner || "", msg.ttlMs || SMART_APPLY_LOCK_TTL_MS, !!msg.handoff)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, reason: e.message }));
    return true;
  }
  if (msg.action === "releaseSmartApplyLock") {
    releaseSmartApplyLock(msg.owner || "", { fair: !!msg.fair })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, reason: e.message }));
    return true;
  }

  if (msg.action === "openIndeedSmartApply") {
    (async () => {
      try {
        const url = String(msg.url || "").trim();
        if (!url || !/smartapply\.indeed\.com|applybyapplyablejobid|preloadresumeapply|indeedapply/i.test(url)) {
          sendResponse({ ok: false, reason: "bad_url" });
          return;
        }
        const winId = platformWindowIds.indeed || undefined;
        const tab = await chrome.tabs.create({
          url,
          active: true,
          windowId: winId,
        });
        // Notify SERP tabs that Smart Apply opened (same signal as auto-detect)
        try {
          const tabs = await listPlatformTabs("indeed");
          for (const t of tabs) {
            if (t?.id && t.id !== tab.id && /\/jobs\b/i.test(t.url || "")) {
              chrome.tabs.sendMessage(t.id, { action: "indeedSmartApplyOpened" }).catch(() => {});
            }
          }
        } catch (_e) {}
        sendResponse({ ok: true, tabId: tab.id });
      } catch (e) {
        sendResponse({ ok: false, reason: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "closeIndeedSmartApplyTabs") {
    (async () => {
      try {
        const tabs = await listPlatformTabs("indeed");
        const applyTabs = tabs.filter((t) =>
          /smartapply|indeedapply|applybyapplyablejobid|\/viewjob|\/rc\/clk|\/pagead\/clk|onboarding\.indeed/i.test(t.url || "")
        );
        for (const t of applyTabs) {
          if (t?.id) await chrome.tabs.remove(t.id).catch(() => {});
        }
        await chrome.storage.local.set({ indeedWizardBusy: null, glassdoorSmartApply: null });
        sendResponse({ ok: true, closed: applyTabs.length });
      } catch (e) {
        sendResponse({ ok: false, reason: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "solveCaptcha" || msg.action === "solve2Captcha") {
    (async () => {
      const browserUa = String(msg.userAgent || "").trim();
      const pageUrl = msg.websiteURL || msg.pageUrl || msg.url || "";
      let apiDomain = msg.apiDomain || "";
      if (!apiDomain && /smartapply\.indeed|indeed\.(com|[a-z]{2})/i.test(pageUrl)) {
        apiDomain = "www.recaptcha.net";
      }
      let r = await solveCaptchaRouted({
        type: msg.type || msg.captchaType || "recaptcha_v2",
        websiteURL: pageUrl,
        websiteKey: msg.websiteKey || msg.sitekey || msg.siteKey || "",
        pageAction: msg.pageAction || msg.actionName || "",
        data: msg.data || msg.cData || "",
        pagedata: msg.pagedata || msg.chlPageData || msg.pageData || "",
        userAgent: browserUa,
        apiDomain,
        isEnterprise: !!msg.isEnterprise || /enterprise/i.test(String(msg.type || "")),
        isInvisible: !!msg.isInvisible,
        enterprisePayload: msg.enterprisePayload || null,
        recaptchaDataSValue: msg.recaptchaDataSValue || "",
        preferCapSolver: !!msg.preferCapSolver,
      });
      // Never inject CapSolver junk (HF… ~500 chars) even if a provider mis-flags ok
      if (r?.ok && r.token && !isPlausibleGoogleRecaptchaToken(r.token)) {
        await appendLog(
          `solveCaptcha: token invraisemblable rejeté (len=${String(r.token).length})`,
          "warn"
        );
        r = { ok: false, reason: "implausible_token" };
      }
      // Always push token into the tab that asked (all frames) so host page gets it
      if (r?.ok && r.token && sender?.tab?.id && msg.injectInTab !== false) {
        const tabId = sender.tab.id;
        const isTurnstile = /turnstile|cloudflare/i.test(String(msg.type || msg.captchaType || ""));
        if (isTurnstile) {
          await appendLog("solveCaptcha: Turnstile ignoré (mode manuel — cliquez le widget)", "warn");
        } else {
        try {
          await chrome.tabs.sendMessage(tabId, { action: "injectRecaptchaToken", token: r.token });
        } catch (_e) {}
        // MAIN world: Indeed reads grecaptcha.getResponse() + visible client callback
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: "MAIN",
            func: (token) => {
              try {
                const visibleKey = "6Ldn8QwpAAAAAAYahgoiLgJ0lHSu9PRHngswlkls";
                const invisibleKey = "6Lcr30spAAAAANOd2aQVyfNwAwHyAW6WsatMvrqU";
                window.__AmijobsRecaptchaToken = token;
                const fill = () => {
                  let area =
                    document.querySelector('textarea[name="g-recaptcha-response"]') ||
                    document.querySelector("#g-recaptcha-response");
                  if (!area) {
                    area = document.createElement("textarea");
                    area.name = "g-recaptcha-response";
                    area.id = "g-recaptcha-response";
                    area.style.cssText = "display:none !important";
                    (document.body || document.documentElement).appendChild(area);
                  }
                  area.value = token;
                  area.innerHTML = token;
                };
                fill();
                for (const area of document.querySelectorAll(
                  'textarea[name="g-recaptcha-response"], #g-recaptcha-response, textarea.g-recaptcha-response'
                )) {
                  area.value = token;
                  area.innerHTML = token;
                }
                const patch = (api) => {
                  if (!api) return;
                  try {
                    api.getResponse = function () {
                      return token;
                    };
                  } catch (_e) {}
                  try {
                    if (api.enterprise) {
                      api.enterprise.getResponse = function () {
                        return token;
                      };
                    }
                  } catch (_e) {}
                };
                patch(window.grecaptcha);
                // Only visible widget success callback — never invisible promise-callback
                const shouldInvoke = (key) => {
                  const k = String(key || "");
                  if (/expired|error|timeout|reset|cancel|close/i.test(k)) return false;
                  return /^(callback|success-callback|successCallback)$/i.test(k);
                };
                const tryCall = (fn) => {
                  if (typeof fn !== "function") return;
                  try {
                    fn(token);
                  } catch (_e) {}
                };
                const findSitekeys = (obj, depth, out) => {
                  if (!obj || depth > 8) return;
                  try {
                    if (typeof obj === "string" && /^6L[A-Za-z0-9_-]{20,}/.test(obj)) out.push(obj);
                    else if (typeof obj === "object") {
                      for (const k of Object.keys(obj)) {
                        const v = obj[k];
                        if (typeof v === "string" && /sitekey|siteKey|^k$/i.test(k) && /^6L/.test(v)) out.push(v);
                        else if (v && typeof v === "object") findSitekeys(v, depth + 1, out);
                      }
                    }
                  } catch (_e) {}
                };
                const clientKind = (client) => {
                  const keys = [];
                  findSitekeys(client, 0, keys);
                  if (keys.some((k) => k === visibleKey || k.indexOf("6Ldn8Qwp") === 0)) return "visible";
                  if (keys.some((k) => k === invisibleKey || k.indexOf("6Lcr30sp") === 0)) return "invisible";
                  return "unknown";
                };
                const walkSuccess = (obj, depth) => {
                  if (!obj || depth > 10) return;
                  try {
                    for (const k of Object.keys(obj)) {
                      const v = obj[k];
                      if (typeof v === "function" && shouldInvoke(k)) tryCall(v);
                      else if (v && typeof v === "object") walkSuccess(v, depth + 1);
                    }
                  } catch (_e) {}
                };
                try {
                  if (window.___grecaptcha_cfg?.clients) {
                    const ids = Object.keys(window.___grecaptcha_cfg.clients);
                    const ranked = ids
                      .map((id) => {
                        const client = window.___grecaptcha_cfg.clients[id];
                        const kind = clientKind(client);
                        let score = 0;
                        if (kind === "visible") score = 100;
                        else if (kind === "invisible") score = -50;
                        else if (String(id) === "0") score = 40;
                        else if (Number(id) >= 100000) score = -40;
                        return { id, client, kind, score };
                      })
                      .sort((a, b) => b.score - a.score);
                    for (const row of ranked) {
                      if (row.kind === "invisible" || row.score < 0) continue;
                      try {
                        const gg = row.client?.G?.G;
                        if (gg) tryCall(gg.callback);
                      } catch (_e) {}
                      walkSuccess(row.client, 0);
                      if (row.kind === "visible" || row.score >= 40) break;
                    }
                  }
                } catch (_e) {}
                for (const el of document.querySelectorAll("[data-callback]")) {
                  const name = el.getAttribute("data-callback");
                  if (name && typeof window[name] === "function") {
                    try {
                      window[name](token);
                    } catch (_e) {}
                  }
                }
              } catch (_e) {}
            },
            args: [r.token],
          });
        } catch (_e) {}
        // Also refresh isolated-world helpers
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: "ISOLATED",
            func: (token) => {
              try {
                window.__AmijobsRecaptchaToken = token;
                if (typeof window.__AmijobsInjectRecaptchaToken === "function") {
                  window.__AmijobsInjectRecaptchaToken(token);
                }
              } catch (_e) {}
            },
            args: [r.token],
          });
        } catch (_e) {}
        }
      }
      sendResponse(r);
    })().catch((e) => sendResponse({ ok: false, reason: e.message }));
    return true;
  }

  if (msg.action === "checkBackend") {
    // External apply is handled in-extension (no remote backend)
    sendResponse({ available: true, ok: true, mode: "in_extension" });
    return false;
  }

  if (msg.action === "addToPipeline") {
    sendResponse({ ok: true, queued: true });
    return false;
  }

  if (msg.action === "requestExternalApply" || msg.action === "openExternalApply") {
    openExternalApply(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, success: false, reason: e.message }));
    return true;
  }

  if (msg.action === "externalApplyResult") {
    (async () => {
      const { sessionExternalApply = null } = await chrome.storage.local.get(["sessionExternalApply"]);
      if (sessionExternalApply?.active) {
        await chrome.storage.local.set({
          sessionExternalApply: {
            ...sessionExternalApply,
            active: false,
            done: true,
            ok: !!msg.ok,
            reason: msg.reason || "",
            finishedAt: Date.now(),
          },
        });
      }
      await appendLog(
        `Site entreprise: ${msg.ok ? "OK" : "échec"} — ${msg.reason || ""}`,
        msg.ok ? "success" : "warn",
        "external"
      );
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "clickRecaptcha") {
    (async () => {
      const tabId = msg.tabId || sender?.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false });
        return;
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ["content/google-recaptcha.js"],
        });
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => {
            try {
              return typeof window.__AmijobsClickRecaptcha === "function"
                ? !!window.__AmijobsClickRecaptcha()
                : false;
            } catch (_e) {
              return false;
            }
          },
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, reason: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "watchNextExternalTab") {
    const timeoutMs = msg.timeoutMs || 12000;
    pendingExternalTabWatch = {
      at: Date.now(),
      timeoutMs,
      url: "",
      tabId: null,
    };
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === "getWatchedExternalTab") {
    sendResponse({
      ok: true,
      url: pendingExternalTabWatch?.url || "",
      tabId: pendingExternalTabWatch?.tabId || null,
    });
    return false;
  }

  if (msg.action === "companyApplyCount") {
    companyApplyCount(msg.company).then((count) => sendResponse({ count }));
    return true;
  }

  if (msg.action === "markApplied") {
    (async () => {
      const platform = msg.platform || "hellowork";
      const keyName =
        platform === "indeed"
          ? "sessionIndeed"
          : platform === "glassdoor"
            ? "sessionGlassdoor"
            : platform === "linkedin"
              ? "sessionLinkedin"
              : "sessionHellowork";
      const data = await chrome.storage.local.get([keyName, "appliedJobs", "stats"]);
      const session = data[keyName];
      const maxJobs = session?.maxJobs || 25;
      // Refuse to count past session quota (stops dual-handoff double-fire)
      if (session?.active && (session.applied || 0) >= maxJobs) {
        await appendLog(
          `Quota atteint — ignore markApplied: ${msg.title || ""}`,
          "warn",
          platform
        );
        sendResponse({ ok: false, reason: "max_jobs" });
        return;
      }
      const { appliedJobs = {}, stats = { applied: 0, skipped: 0, errors: 0, lastRun: null } } = data;
      const prefix = jobKeyPrefix(platform);
      const key = prefix + (msg.jobId || `job_${Date.now()}`);
      if (appliedJobs[key]) {
        sendResponse({ ok: true, duplicate: true });
        return;
      }
      appliedJobs[key] = {
        platform,
        title: msg.title || "",
        company: msg.company || "",
        url: msg.url || "",
        page: Number.isFinite(msg.page) ? msg.page : undefined,
        ts: new Date().toISOString(),
      };
      stats.applied = (stats.applied || 0) + 1;
      stats.lastRun = new Date().toISOString();
      await updatePlatformSessionFromMessage(platform, (s) => {
        s.applied = (s.applied || 0) + 1;
      });
      await chrome.storage.local.set({ appliedJobs, stats });
      await appendLog(`Candidature envoyée: ${msg.title || key}`, "success", platform);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "markSkipped") {
    (async () => {
      const platform = msg.platform || "hellowork";
      const { skippedJobs = {}, stats = { applied: 0, skipped: 0, errors: 0, lastRun: null } } =
        await chrome.storage.local.get(["skippedJobs", "stats"]);
      const prefix = jobKeyPrefix(platform);
      const key = prefix + (msg.jobId || `skip_${Date.now()}`);
      skippedJobs[key] = {
        platform,
        title: msg.title || "",
        reason: msg.reason || "",
        url: msg.url || "",
        ts: new Date().toISOString(),
      };
      stats.skipped = (stats.skipped || 0) + 1;
      await updatePlatformSessionFromMessage(platform, (s) => {
        s.skipped = (s.skipped || 0) + 1;
      });
      await chrome.storage.local.set({ skippedJobs, stats });
      await appendLog(`Ignorée: ${msg.title} (${msg.reason})`, "warn", platform);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "markError") {
    (async () => {
      const platform = msg.platform || "hellowork";
      const { stats = { applied: 0, skipped: 0, errors: 0, lastRun: null } } =
        await chrome.storage.local.get(["stats"]);
      stats.errors = (stats.errors || 0) + 1;
      await updatePlatformSessionFromMessage(platform, (s) => {
        s.errors = (s.errors || 0) + 1;
      });
      await chrome.storage.local.set({ stats });
      await appendLog(`Erreur: ${msg.error}`, "error", platform);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "addLog") {
    appendLog(msg.message, msg.level, msg.platform || "").then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "clearLog") {
    chrome.storage.local.set({ log: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.action === "resetStats") {
    (async () => {
      await chrome.storage.local.set({
        stats: { applied: 0, skipped: 0, errors: 0, lastRun: null },
        appliedJobs: {},
        skippedJobs: {},
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "downloadDebugLog") {
    (async () => {
      const { log = [] } = await chrome.storage.local.get(["log"]);
      const content = `=== AmiJobs Debug Log ===\nVersion: ${EXT_VERSION}\nWebsite: https://amijobs.com\nGenerated: ${new Date().toISOString()}\n\n${log.join("\n")}\n`;
      const dataUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(content);
      chrome.downloads.download(
        { url: dataUrl, filename: "amijobs-debug.log", saveAs: false, conflictAction: "overwrite" },
        () => sendResponse({ ok: true })
      );
    })();
    return true;
  }

  if (msg.action === "indeedLoginWall") {
    const tabId = msg.tabId ?? sender?.tab?.id ?? null;
    handleIndeedLoginWall(tabId, msg.url || sender?.tab?.url || "")
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.action === "indeedLoginResolved") {
    clearIndeedLoginGate(msg.reason || "content_resolved")
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.action === "watchIndeedApplyFromGlassdoor") {
    watchingIndeedFromGlassdoor = msg.jobInfo || {};
    (async () => {
      try {
        const job = msg.jobInfo || {};
        const { sessionGlassdoor = null } = await chrome.storage.local.get(["sessionGlassdoor"]);
        await chrome.storage.local.set({
          glassdoorSmartApply: {
            jobId: job.jobId || sessionGlassdoor?.currentJk || "",
            title: job.title || sessionGlassdoor?.currentTitle || "",
            company: job.company || sessionGlassdoor?.currentCompany || "",
            at: Date.now(),
          },
        });
      } catch (_e) {}
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "armIndeedHandoffCapture") {
    const ms = Math.max(3000, Math.min(30000, Number(msg.ms) || 12000));
    indeedHandoffCapture = { at: Date.now(), until: Date.now() + ms, url: "", tabId: null };
    sendResponse({ ok: true, until: indeedHandoffCapture.until });
    return true;
  }

  if (msg.action === "peekIndeedHandoffCapture") {
    const cap = indeedHandoffCapture;
    if (!cap || Date.now() > (cap.until || 0)) {
      sendResponse({ ok: false, url: "", expired: true });
      return true;
    }
    sendResponse({ ok: !!cap.url, url: cap.url || "", tabId: cap.tabId || null });
    return true;
  }

  if (msg.action === "restoreGlassdoorSerp") {
    (async () => {
      try {
        const now = Date.now();
        if (now - lastGlassdoorSerpRestoreAt < 15000) {
          sendResponse({ ok: true, throttled: true });
          return;
        }
        const { sessionGlassdoor } = await chrome.storage.local.get(["sessionGlassdoor"]);
        const url =
          msg.searchUrl ||
          sessionGlassdoor?.searchUrl ||
          sessionGlassdoor?.resumeSearchUrl ||
          "";
        if (!sessionGlassdoor?.active || !url) {
          sendResponse({ ok: false, reason: "no_session" });
          return;
        }
        const gdTabs = await listPlatformTabs("glassdoor");
        if (gdTabs.length === 0) {
          lastGlassdoorSerpRestoreAt = now;
          await ensureSinglePlatformTab("glassdoor", url, {
            active: false,
            forceNavigate: true,
          });
          await appendLog("SERP Glassdoor restauré après handoff Indeed", "info", "glassdoor");
        }
        sendResponse({ ok: true, restored: gdTabs.length === 0 });
      } catch (e) {
        sendResponse({ ok: false, reason: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "closeTabAndResumeIndeed") {
    (async () => {
      const tabId = sender?.tab?.id;
      const searchUrl = msg.searchUrl || "";
      const fromGlassdoor = !!msg.fromGlassdoor;
      const { sessionGlassdoor, sessionIndeed } = await chrome.storage.local.get([
        "sessionGlassdoor",
        "sessionIndeed",
      ]);
      if (sessionGlassdoor?.active) {
        await chrome.storage.local.set({
          sessionGlassdoor: {
            ...sessionGlassdoor,
            awaitingIndeed: false,
            // Keep handoffDone so Glassdoor wait loop can match success before clearing
            indeedHandoffDone: fromGlassdoor ? !!sessionGlassdoor.indeedHandoffDone : false,
          },
          glassdoorSmartApply: null,
        });
      }
      // Glassdoor-only apply sessions should not keep an Indeed SERP loop alive
      if ((fromGlassdoor || sessionIndeed?.fromGlassdoor) && sessionIndeed?.active && sessionIndeed.fromGlassdoor) {
        await chrome.storage.local.set({
          sessionIndeed: { ...sessionIndeed, active: false, phase: "done", lastRunAt: Date.now() },
        });
      }

      const resumeUrl =
        searchUrl ||
        (!fromGlassdoor && !sessionIndeed?.fromGlassdoor ? sessionIndeed?.searchUrl || "" : "");

      // Reuse the SAME Indeed tab — never open a second one
      if (resumeUrl && tabId) {
        try {
          await chrome.tabs.update(tabId, { url: resumeUrl, active: true });
        } catch (_e) {
          await ensureSinglePlatformTab("indeed", resumeUrl, { active: true, forceNavigate: true });
        }
      } else if (resumeUrl) {
        await ensureSinglePlatformTab("indeed", resumeUrl, { active: true, forceNavigate: true });
      } else if (tabId && fromGlassdoor) {
        // Glassdoor handoff finished: never leave a zombie Smart Apply tab — it blocks
        // Glassdoor resume (hasSmartApply) and causes false "assumed handoff" waits.
        if (sessionIndeed?.active && !sessionIndeed.fromGlassdoor && sessionIndeed.searchUrl) {
          try {
            await chrome.tabs.update(tabId, { url: sessionIndeed.searchUrl, active: false });
          } catch (_e) {
            try {
              await chrome.tabs.remove(tabId);
            } catch (_e2) {
              /* ignore */
            }
          }
        } else {
          try {
            await chrome.tabs.remove(tabId);
          } catch (_e) {
            /* ignore */
          }
        }
      }

      // Sweep any leftover Indeed apply tabs after Glassdoor handoff
      if (fromGlassdoor) {
        try {
          const leftovers = (await listPlatformTabs("indeed")).filter((t) =>
            /smartapply|indeedapply/i.test(t.url || "")
          );
          for (const t of leftovers) {
            try {
              await chrome.tabs.remove(t.id);
            } catch (_e) {
              /* ignore */
            }
          }
        } catch (_e) {
          /* ignore */
        }
      }

      await enforceOneTabPerPlatform("après smart apply");
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.action === "stopAllPlatforms") {
    (async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        const url = tab.url || "";
        if (!tab.id) continue;
        if (
          url.includes("hellowork.com") ||
          url.includes("linkedin.com") ||
          /indeed\./i.test(url) ||
          url.includes("smartapply.indeed.com") ||
          /glassdoor\./i.test(url)
        ) {
          chrome.tabs.sendMessage(tab.id, { action: "stopAutoApply" }).catch(() => {});
        }
      }
      // Also ping remembered platform tabs (URL may still be about:blank / loading)
      for (const p of SUPPORTED_PLATFORMS) {
        const tid = platformTabIds[p];
        if (tid != null) {
          chrome.tabs.sendMessage(tid, { action: "stopAutoApply" }).catch(() => {});
        }
      }
      const platforms = await getActivePlatforms();
      for (const p of platforms) await endPlatformSession(p, "Arrêt demandé");
      await clearPlatformWindowMemory();
      await stopExitSession().catch(() => {});
      await appendLog("Arrêt multi-plateformes demandé (toutes sessions)", "warn");
      sendResponse({ ok: true, stopped: platforms });
    })();
    return true;
  }

  sendResponse({ ok: false, message: "unknown_action" });
  return false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  return handleMessage(msg, sendResponse, sender);
});

// Seed captcha keys from secrets.local.json on every SW wake (local installs only)
seedCaptchaApiKeysFromSecrets().catch(() => {});
getTwoCaptchaApiKey().catch(() => {});
getCapSolverApiKey().catch(() => {});

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get([
    "profile",
    "autoApplySettings",
    "mistralApiKey",
    "uiSettings",
    "enabled",
    "twoCaptchaApiKey",
    "capSolverApiKey",
  ]);
  const patch = {};
  if (!existing.profile) patch.profile = { ...DEFAULT_PROFILE };
  // Always repair settings (clears corrupted giant maxJobs / delays).
  patch.autoApplySettings = sanitizeSettings(existing.autoApplySettings || DEFAULT_SETTINGS);
  if (!existing.mistralApiKey) patch.mistralApiKey = DEFAULT_MISTRAL_API_KEY;
  if (!existing.uiSettings) patch.uiSettings = { language: "auto" };
  if (typeof existing.enabled !== "boolean") patch.enabled = true;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  // Local-only: seed captcha keys from secrets.local.json if present (gitignored)
  try {
    await seedCaptchaApiKeysFromSecrets();
    await getTwoCaptchaApiKey();
    await getCapSolverApiKey();
  } catch (_e) {}
  await appendLog(`AmiJobs v${EXT_VERSION} installé — amijobs.com`, "success");
});
