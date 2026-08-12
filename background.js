// AmiJobs — Background Service Worker v1.1.0
// Unified orchestration for Hellowork, LinkedIn, Indeed & Glassdoor
// https://amijobs.com
// ============================================================================

const EXT_VERSION = "1.4.45";
let lastGlassdoorSerpRestoreAt = 0;
const MISTRAL_MODEL = "mistral-large-latest";
const MISTRAL_ENDPOINT = "https://api.mistral.ai/v1/chat/completions";
const DEFAULT_MISTRAL_API_KEY = "uwqtlWhrRDIdE0QAHYkIhMFkLTbkDYIb";
const TWOCAPTCHA_CREATE = "https://api.2captcha.com/createTask";
const TWOCAPTCHA_RESULT = "https://api.2captcha.com/getTaskResult";

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

async function fetchIndeedLocationSuggestions(query, country = "FR", language = "fr") {
  const q = String(query || "").trim();
  if (!q) return [];
  try {
    const params = new URLSearchParams({
      country,
      language,
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
  // Contract / freelance-oriented results on fr.indeed
  const list = asArray(contracts).map((c) => String(c).toLowerCase());
  if (list.some((c) => /freelance|independant|indépendant|contract/i.test(c))) {
    p.set("sc", "0kf:attr(DSQF7);");
  }
  if (page > 0) p.set("start", String(page * 10));
  return `https://fr.indeed.com/jobs?${p.toString()}`;
}

function buildGlassdoorSearchUrl(keywords, location, contracts = []) {
  // Prefer classic Job/jobs.htm + Easy Apply filter (applicationType=1)
  const p = new URLSearchParams();
  const kw = freelanceAwareKeywords(keywords, contracts);
  if (kw) p.set("sc.keyword", kw);
  if (location) p.set("sc.location", location);
  p.set("applicationType", "1");
  return `https://www.glassdoor.fr/Job/jobs.htm?${p.toString()}`;
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
  glassdoor: ["glassdoor.com", "glassdoor.fr"],
};

let watchingIndeedFromGlassdoor = null;
let lastSmartApplyKick = 0;
let lastIndeedLoginWallAt = 0;
/** Armed while Glassdoor clicks Easy Apply without a scrapable Indeed href. */
let indeedHandoffCapture = null;
let tabEnforceLock = false;
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
 * Glassdoor→Indeed landed on login. Clear handoff, close auth tab, block further
 * Indeed handoffs for this run so we don't endSession→kickGlassdoor→auth forever.
 */
async function handleIndeedLoginWall(tabId, url = "") {
  const now = Date.now();
  if (now - lastIndeedLoginWallAt < 8000) return { ok: true, deduped: true };
  lastIndeedLoginWallAt = now;

  const data = await chrome.storage.local.get([
    "sessionIndeed",
    "sessionGlassdoor",
    "amijobsMeta",
    "indeedWizardBusy",
  ]);
  const sessionIndeed = data.sessionIndeed || null;
  const sessionGlassdoor = data.sessionGlassdoor || null;
  const meta = data.amijobsMeta || {};

  await chrome.storage.local.set({
    amijobsMeta: { ...meta, indeedLoginRequired: true, indeedLoginAt: new Date().toISOString() },
    indeedWizardBusy: null,
    glassdoorSmartApply: null,
  });

  try {
    await releaseSmartApplyLock("indeed");
  } catch (_e) {}

  // Always clear Glassdoor handoff wait — auth will never complete the wizard
  if (sessionGlassdoor?.active) {
    await chrome.storage.local.set({
      sessionGlassdoor: {
        ...sessionGlassdoor,
        awaitingIndeed: false,
        indeedHandoffDone: false,
        lastRunAt: Date.now(),
        runLockAt: 0,
      },
    });
  }

  const wasHandoff = !!(sessionIndeed?.fromGlassdoor || sessionGlassdoor?.awaitingIndeed);
  if (sessionIndeed?.active && sessionIndeed.fromGlassdoor) {
    await chrome.storage.local.set({
      sessionIndeed: { ...sessionIndeed, active: false, phase: "done", endedAt: new Date().toISOString() },
      lastSessionIndeed: { ...sessionIndeed, active: false, endedAt: new Date().toISOString() },
    });
  }

  await appendLog(
    wasHandoff
      ? "Connexion Indeed requise — handoff Glassdoor abandonné (pas de boucle)"
      : "Connexion Indeed requise — handoffs Indeed bloqués pour cette session",
    "warn",
    "indeed"
  );

  if (tabId != null) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (_e) {}
  }

  // Native Indeed mass-apply cannot continue without login
  if (sessionIndeed?.active && !sessionIndeed.fromGlassdoor) {
    await endPlatformSession("indeed", "Connexion Indeed requise");
  } else if (sessionGlassdoor?.active) {
    // Resume Glassdoor SERP without re-opening Indeed auth tabs
    setTimeout(() => {
      kickPlatformSessions(["glassdoor"]).catch(() => {});
    }, 1200);
  }

  return { ok: true, blocked: true };
}

function detectPlatformFromUrl(url = "") {
  const raw = String(url || "");
  if (!raw || raw.startsWith("chrome") || raw.startsWith("about:")) return null;
  try {
    const host = new URL(raw).hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "hellowork.com" || host.endsWith(".hellowork.com")) return "hellowork";
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
    if (host === "smartapply.indeed.com" || host === "indeed.com" || host === "indeed.fr" || host.endsWith(".indeed.com"))
      return "indeed";
    if (host === "glassdoor.com" || host === "glassdoor.fr" || host.endsWith(".glassdoor.com")) return "glassdoor";
  } catch (_e) {
    // Fallback for incomplete URLs
    if (/^https?:\/\/([^/]*\.)?hellowork\.com(\/|$)/i.test(raw)) return "hellowork";
    if (/^https?:\/\/([^/]*\.)?linkedin\.com(\/|$)/i.test(raw)) return "linkedin";
    if (/^https?:\/\/([^/]*\.)?(smartapply\.)?indeed\.(com|fr)(\/|$)/i.test(raw)) return "indeed";
    if (/^https?:\/\/([^/]*\.)?glassdoor\.(com|fr)(\/|$)/i.test(raw)) return "glassdoor";
  }
  return null;
}

function tabMatchesPlatform(tab, platform) {
  return detectPlatformFromUrl(tab?.url || "") === platform;
}

async function listPlatformTabs(platform) {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => t.id && tabMatchesPlatform(t, platform));
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
 * Indeed exception: SERP and Smart Apply may coexist — never navigate Apply→SERP or close the other. */
async function ensureSinglePlatformTab(platform, url, { active = false, forceNavigate = true } = {}) {
  // Indeed: keep board + apply as separate slots
  if (platform === "indeed") {
    const tabs = await listPlatformTabs("indeed");
    // Glassdoor Easy Apply often lands on viewjob / rc/clk — treat as APPLY slot so we
    // never force-navigate the SERP tab (that causes "Onglets indeed fusionnés").
    const wantApply = /smartapply|indeedapply|applybyapplyablejobid|\/viewjob|\/pagead\/clk|\/rc\/clk|\/apply\b/i.test(
      String(url || "")
    );
    const isApplyTab = (t) =>
      /smartapply|indeedapply|applybyapplyablejobid|\/viewjob|\/pagead\/clk|\/rc\/clk/i.test(t.url || "");
    const applyTabs = tabs.filter((t) => isApplyTab(t));
    const boardTabs = tabs.filter((t) => !isApplyTab(t));
    const pool = wantApply ? applyTabs : boardTabs;
    const otherPool = wantApply ? boardTabs : applyTabs;

    // Cap duplicates inside the target pool only — never touch the other pool
    const keep = pickTabToKeep(pool, url) || pool[0] || null;
    for (const t of pool) {
      if (keep && t.id === keep.id) continue;
      try {
        await chrome.tabs.remove(t.id);
      } catch (_e) {}
    }
    // Cap other pool to 1 as well (without navigating it)
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
          const created = await chrome.tabs.create({ url, active: !!active });
          return created?.id || keep.id;
        } catch (_e) {
          return keep.id;
        }
      }
      return keep.id;
    }

    if (!url) return null;
    try {
      const created = await chrome.tabs.create({ url, active: !!active });
      return created?.id || null;
    } catch (_e) {
      return null;
    }
  }

  const tabs = await listPlatformTabs(platform);
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
    if (forceNavigate && url && keep.url !== url) patch.url = url;
    if (Object.keys(patch).length) {
      try {
        await chrome.tabs.update(keep.id, patch);
      } catch (_e) {
        /* ignore */
      }
    }
    return keep.id;
  }

  if (!url) return null;
  try {
    const created = await chrome.tabs.create({ url, active: !!active });
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

      // Indeed exception: allow 1 SERP + 1 Apply (smartapply / indeedapply / viewjob handoff)
      if (platform === "indeed") {
        const isApplyTab = (t) =>
          /smartapply|indeedapply|applybyapplyablejobid|\/viewjob|\/pagead\/clk|\/rc\/clk/i.test(
            t.url || ""
          );
        const applyTabs = tabs.filter((t) => isApplyTab(t));
        const boardTabs = tabs.filter((t) => !isApplyTab(t));
        const keepApply = pickTabToKeep(applyTabs, "smartapply");
        const keepBoard = pickTabToKeep(boardTabs, "/jobs");
        // During an active wizard, do not close apply tabs (SPA URL changes look like dupes)
        const { indeedWizardBusy = null } = await chrome.storage.local.get(["indeedWizardBusy"]);
        const wizardHot = indeedWizardBusy?.at && Date.now() - indeedWizardBusy.at < 180000;
        if (!wizardHot) {
          for (const t of applyTabs) {
            if (keepApply && t.id !== keepApply.id) {
              try {
                await chrome.tabs.remove(t.id);
              } catch (_e) {}
            }
          }
        }
        for (const t of boardTabs) {
          if (keepBoard && t.id !== keepBoard.id) {
            try {
              await chrome.tabs.remove(t.id);
            } catch (_e) {}
          }
        }
        if (reason && !wizardHot && (applyTabs.length > 1 || boardTabs.length > 1)) {
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

async function openPlatformTabs(urls, platforms) {
  let first = true;
  // Honor caller order (Glassdoor before Indeed for parallel startup)
  const ordered = Array.isArray(platforms) && platforms.length
    ? platforms.filter((p) => SUPPORTED_PLATFORMS.includes(p))
    : SUPPORTED_PLATFORMS;
  for (const p of ordered) {
    if (!urls[p]) continue;
    await ensureSinglePlatformTab(p, urls[p], { active: first, forceNavigate: true });
    first = false;
  }
  await enforceOneTabPerPlatform("démarrage session");
}

async function navigatePlatformTab(platform, url) {
  return ensureSinglePlatformTab(platform, url, { active: false, forceNavigate: true });
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

async function injectExternalApplyScripts(tabId) {
  try {
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

/** Trusted mouse click via CDP (needed for Cloudflare Turnstile checkbox). */
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

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url || "";
  if (!url || (changeInfo.status === "loading" && !changeInfo.url)) return;

  // Proactively inject Turnstile clicker on Indeed/Glassdoor when a session is active
  if (
    changeInfo.status === "complete" &&
    /(indeed\.com|indeed\.fr|glassdoor\.(com|fr)|challenges\.cloudflare\.com)/i.test(url)
  ) {
    try {
      const { sessionIndeed, sessionGlassdoor } = await chrome.storage.local.get([
        "sessionIndeed",
        "sessionGlassdoor",
      ]);
      if (sessionIndeed?.active || sessionGlassdoor?.active) {
        chrome.scripting
          .executeScript({
            target: { tabId, allFrames: true },
            files: ["content/turnstile-hook.js", "content/cloudflare-turnstile.js"],
          })
          .catch(() => {});
        chrome.scripting
          .executeScript({
            target: { tabId, allFrames: true },
            func: () => {
              try {
                if (typeof window.__AmijobsClickTurnstile === "function") window.__AmijobsClickTurnstile();
                if (typeof window.__AmijobsSolveTurnstile === "function") window.__AmijobsSolveTurnstile(true);
              } catch (_e) {}
            },
          })
          .catch(() => {});
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
      await chrome.storage.local.set({
        sessionGlassdoor: {
          ...sessionGlassdoor,
          indeedHandoffDone: true,
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
            indeedHandoffDone: true,
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

async function getTwoCaptchaApiKey() {
  try {
    const { twoCaptchaApiKey } = await chrome.storage.local.get(["twoCaptchaApiKey"]);
    if (twoCaptchaApiKey) return String(twoCaptchaApiKey).trim();
  } catch (_e) {}
  // Optional local-only file (gitignored) — never ship a real key in the public zip
  try {
    const res = await fetch(chrome.runtime.getURL("secrets.local.json"));
    if (res.ok) {
      const data = await res.json();
      const k = String(data?.twoCaptchaApiKey || "").trim();
      if (k) {
        await chrome.storage.local.set({ twoCaptchaApiKey: k });
        return k;
      }
    }
  } catch (_e) {}
  return "";
}

/** Serialize Indeed Smart Apply across Indeed mass-apply + Glassdoor Easy Apply.
 *  TTL must outlast slow 2captcha (workers fail + recreate can take 3–6 min).
 *  Fairness: after release, prefer the other board so applies interleave. */
const SMART_APPLY_LOCK_TTL_MS = 420000;
// After A finishes, give B ~45s to start its next Smart Apply (SERP→click→wizard)
const SMART_APPLY_FAIR_MS = 45000;

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
  return !!data[key]?.active;
}

async function acquireSmartApplyLock(owner, ttlMs = SMART_APPLY_LOCK_TTL_MS, handoff = false) {
  if (!owner) return { ok: false, reason: "no_owner" };
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
      setTimeout(() => {
        kickPlatformSessions([prefer]).catch(() => {});
        if (prefer === "indeed") {
          // Also poke any open apply tab
          listPlatformTabs("indeed")
            .then((tabs) => {
              for (const t of tabs.slice(0, 2)) {
                if (t?.id) chrome.tabs.sendMessage(t.id, { action: "startAutoApply" }).catch(() => {});
              }
            })
            .catch(() => {});
        }
      }, 400);
    }
    return { ok: true };
  }
  return { ok: false, owner: amijobsSmartApplyLock.owner };
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

  // Deduplicate parallel identical solves (many frames used to spam 2captcha)
  const dedupeKey = `${String(type).toLowerCase()}|${siteKey}|${pageUrl}|${!!isEnterprise}|${pageAction}|${data}`;
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
      type: "RecaptchaV2EnterpriseTaskProxyless",
      websiteURL: pageUrl,
      websiteKey: siteKey,
      isInvisible: !!isInvisible,
    };
    if (apiDomain) task.apiDomain = apiDomain.replace(/^https?:\/\//, "");
  } else {
    task = {
      type: "RecaptchaV2TaskProxyless",
      websiteURL: pageUrl,
      websiteKey: siteKey,
      isInvisible: !!isInvisible,
    };
    if (apiDomain) task.apiDomain = apiDomain.replace(/^https?:\/\//, "");
  }

  try {
    const deadline = Date.now() + 150000;
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
        // Fresh task often succeeds after "Workers could not solve"
        if (
          recreates < 2 &&
          /workers could not solve|unsolvable|ERROR_CAPTCHA_UNSOLVABLE/i.test(reason)
        ) {
          recreates += 1;
          await appendLog(`2captcha recreateTask ${recreates}/2…`, "warn");
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
        await appendLog(`2captcha: captcha résolu (${task.type})`, "success");
        return {
          ok: true,
          token,
          taskId,
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
- Base-toi UNIQUEMENT sur le CV texte et le profil. N'invente AUCUNE compétence, diplôme ou certification absente du CV.
- Questions oui/non sur diplôme/certificat/permis: réponds "Non" si le CV ne le mentionne pas explicitement.
- Pour antiquité / années d'expérience: réponds avec un nombre entier uniquement (ex: 5).
- Interdit: inventer "Oui", "we", "n/a", anglais générique.
- Si l'info manque dans le CV, préfère "Non" (credentials) ou une valeur minimale factuelle.
- Dates au format JJ/MM/AAAA sauf si le champ exige ISO.`;
  let userPrompt = `Question: "${question}"\nType: ${fieldType}`;
  if (options?.length) userPrompt += `\nOptions: ${JSON.stringify(options)}`;
  if (!cv) userPrompt += `\n(ATTENTION: aucun texte CV fourni — ne pas inventer de diplômes)`;
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
}

const HARD_STOP_REASON = /arr[êe]t|demand|objectif|atteint|manuel|\bstop\b|limite/i;

async function endPlatformSession(platform, reason = "") {
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
      const advanced = resetSessionForLocation(platform, session, nextLoc, nextIndex, nextUrl);
      await chrome.storage.local.set({ [key]: advanced });
      await appendLog(`Zone suivante: ${nextLoc}`, "info", platform);
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
    amijobsMeta: data.amijobsMeta || null,
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

// Hard cap: never more than 1 tab per job board
function isIndeedHandoffApplyUrl(url = "") {
  if (isIndeedLoginWallUrl(url)) return false;
  try {
    const u = new URL(String(url || ""), "https://indeed.com");
    const hostPath = `${u.hostname}${u.pathname}`;
    if (!/indeed\.(com|fr)|smartapply\.indeed/i.test(hostPath)) return false;
    if (/help\.|support\.|\/hc\/|guidelines|articles\/|job-seeker/i.test(hostPath)) return false;
    // Host+path only — never match smartapply inside ?continue=
    return /smartapply|indeedapply|\/viewjob|\/rc\/clk|\/pagead\/clk|applybyapplyablejobid/i.test(hostPath);
  } catch (_e) {
    const s = String(url || "").split(/[?#]/)[0];
    if (!/indeed\.(com|fr)|smartapply\.indeed/i.test(s)) return false;
    if (/help\.|support\.|\/hc\/|guidelines|articles\/|job-seeker/i.test(s)) return false;
    return /smartapply|indeedapply|\/viewjob|\/rc\/clk|\/pagead\/clk|applybyapplyablejobid/i.test(s);
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
  setTimeout(() => enforceOneTabPerPlatform("nouvel onglet").catch(() => {}), 1200);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  if (indeedHandoffCapture && Date.now() <= (indeedHandoffCapture.until || 0)) {
    noteIndeedHandoffCapture(tabId, changeInfo.url).catch(() => {});
  }
  const platform = detectPlatformFromUrl(changeInfo.url || tab?.url || "");
  if (!platform) return;
  setTimeout(() => enforceOneTabPerPlatform("navigation").catch(() => {}), 1500);
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
    });
  }

  if (platforms.includes("indeed")) {
    const searchUrl = msg.indeedUrl || buildIndeedSearchUrl(keywords, location, 0, contracts);
    urls.indeed = searchUrl;
    updates.sessionIndeed = emptyPlatformSession("indeed", {
      ...common,
      searchUrl,
    });
  }

  if (platforms.includes("glassdoor")) {
    const searchUrl = msg.glassdoorUrl || buildGlassdoorSearchUrl(keywords, location, contracts);
    urls.glassdoor = searchUrl;
    updates.sessionGlassdoor = emptyPlatformSession("glassdoor", {
      ...common,
      searchUrl,
      deferredUntilIndeedDone: false,
    });
  }

  // Shared Smart Apply mutex — both SERPs run together; wizard turns alternate after each apply.
  // Do NOT prefer Glassdoor at start (that starved Indeed and looked like "only Glassdoor").
  updates.amijobsSmartApplyLock = null;
  updates.amijobsSmartApplyPrefer = null;

  await chrome.storage.local.set(updates);
  // Reset reopen storm counters for this run
  for (const p of platforms) {
    platformReopenCount[p] = 0;
    lastPlatformReopenAt[p] = 0;
  }
  await appendLog(
    `Session AmiJobs démarrée (${platforms.join(" + ")}): "${keywords}" @ "${locationsOrEmpty.join(", ")}"` +
      (contracts.length ? ` [${contracts.join(", ")}]` : ""),
    "success"
  );
  if (platforms.includes("indeed") && platforms.includes("glassdoor")) {
    await appendLog(
      "Mode parallèle Indeed+Glassdoor — les 2 SERP actifs, Smart Apply en alternance",
      "info"
    );
  }

  // Open both boards; kick Indeed + Glassdoor together (no first-board starvation)
  const openOrder = [...platforms];
  await openPlatformTabs(urls, openOrder);

  setTimeout(() => {
    // First kick must force-inject — tabs are fresh and may not have content scripts yet
    kickPlatformSessions(openOrder, { forceInject: true }).catch(() => {});
  }, 2000);

  return { ok: true, urls, platforms };
}

async function kickPlatformSessions(platforms = [], { forceInject = false } = {}) {
  for (const platform of platforms) {
    try {
      const tabs = await listPlatformTabs(platform);
      for (const tab of tabs.slice(0, 1)) {
        if (!tab?.id) continue;
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
            if (platform === "glassdoor") {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: false },
                files: ["content/shared-autofill.js", "content/glassdoor.js"],
              });
            } else if (platform === "linkedin") {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: false },
                files: ["content/linkedin.js"],
              });
            } else if (platform === "indeed") {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: false },
                files: ["content/shared-autofill.js", "content/indeed.js"],
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
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ["content/turnstile-hook.js", "content/cloudflare-turnstile.js"],
        });
        // Force re-click even if the content script was already loaded
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => {
            try {
              if (typeof window.__AmijobsClickTurnstile === "function") {
                return { clicked: !!window.__AmijobsClickTurnstile(), href: location.href.slice(0, 120) };
              }
            } catch (_e) {
              /* ignore */
            }
            return { clicked: false, href: location.href.slice(0, 120) };
          },
        });
        // Also kick 2captcha solve in all frames
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => {
            try {
              if (typeof window.__AmijobsSolveTurnstile === "function") {
                window.__AmijobsSolveTurnstile(true);
                return true;
              }
            } catch (_e) {}
            return false;
          },
        });
        // Trusted CDP click — synthetic events are often ignored by Turnstile
        const trusted = await clickTurnstileWithDebugger(tabId);
        sendResponse({
          ok: true,
          frames: (results || []).map((r) => r?.result).filter(Boolean),
          trusted,
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg.action === "injectTurnstileToken") {
    (async () => {
      const tabId = msg.tabId || sender?.tab?.id;
      const token = msg.token || "";
      if (!tabId || !token) {
        sendResponse({ ok: false, reason: "missing" });
        return;
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: "MAIN",
          func: (tok) => {
            try {
              window.postMessage({ source: "amijobs-cf-token", token: tok }, "*");
              for (const input of document.querySelectorAll(
                '[name="cf-turnstile-response"], input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], [name="g-recaptcha-response"]'
              )) {
                input.value = tok;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
              }
              if (typeof window.__AmijobsCfCallback === "function") window.__AmijobsCfCallback(tok);
              if (typeof window.cfCallback === "function") window.cfCallback(tok);
              if (typeof window.tsCallback === "function") window.tsCallback(tok);
            } catch (_e) {}
          },
          args: [token],
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, reason: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "openPlatformTabs") {
    openPlatformTabs(msg.urls || {}, msg.platforms || [])
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
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
      if (msg.platform === "indeed") {
        const { amijobsMeta } = await chrome.storage.local.get(["amijobsMeta"]);
        if (amijobsMeta?.indeedLoginRequired) {
          sendResponse({ ok: false, reason: "indeed_login_required" });
          return;
        }
      }
      try {
        const tabId = await ensureSinglePlatformTab(msg.platform, msg.url, {
          active: !!msg.active,
          forceNavigate: msg.forceNavigate !== false,
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
    fetchIndeedLocationSuggestions(msg.query || "", msg.country || "FR", msg.language || "fr").then((suggestions) =>
      sendResponse({ ok: true, suggestions })
    );
    return true;
  }

  if (msg.action === "normalizeLocations") {
    normalizeLocations(asArray(msg.locations)).then((locations) => sendResponse({ ok: true, locations }));
    return true;
  }

  if (msg.action === "startMultiSession" || msg.action === "startSession") {
    startMultiSession(msg).then(sendResponse);
    return true;
  }

  if (msg.action === "endPlatformSession") {
    endPlatformSession(msg.platform, msg.reason || "").then(() => sendResponse({ ok: true }));
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
      const resumed = { ...last, active: true, endedAt: undefined };
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
        targetUrl = buildLinkedInSearchUrl(resumed.keywords, resumed.location, resumed.contracts);
      }
      await chrome.storage.local.set({
        [activeKey]: resumed,
        amijobsMeta: {
          ...(data.amijobsMeta || {}),
          active: true,
          platforms: [platform],
        },
        enabled: true,
      });
      await appendLog(`Session ${platform} reprise`, "success", platform);
      sendResponse({ ok: true, targetUrl, platform });
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
        const hasSmartApply = tabs.some((t) =>
          /smartapply|indeedapply|applybyapplyablejobid/i.test(t.url || "")
        );
        // Glassdoor Easy Apply often lands on viewjob / rc/clk before smartapply
        // Do NOT count SERP /jobs?vjk= — Indeed always has a panel open while browsing
        const hasApplyTab = tabs.some((t) =>
          /smartapply|indeedapply|applybyapplyablejobid|\/viewjob|\/pagead\/clk|\/rc\/clk|\/apply\b/i.test(
            t.url || ""
          )
        );
        const hasSerp = tabs.some(
          (t) => /\/jobs\b/i.test(t.url || "") && !/smartapply|indeedapply|\/viewjob|\/rc\/clk/i.test(t.url || "")
        );
        sendResponse({ ok: true, count: tabs.length, hasSmartApply, hasApplyTab, hasSerp });
      })
      .catch((e) => sendResponse({ ok: false, reason: e.message }));
    return true;
  }

  if (msg.action === "nudgeIndeedSmartApply") {
    (async () => {
      try {
        const tabs = await listPlatformTabs("indeed");
        const apply = tabs.find((t) =>
          /smartapply|indeedapply|applybyapplyablejobid|\/viewjob|\/pagead\/clk|\/rc\/clk/i.test(t.url || "")
        );
        if (apply?.id) {
          await chrome.tabs.update(apply.id, { active: true }).catch(() => {});
          await chrome.tabs.sendMessage(apply.id, { action: "startAutoApply" }).catch(() => {});
        }
        sendResponse({ ok: true, nudged: !!apply?.id });
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

  if (msg.action === "closeIndeedSmartApplyTabs") {
    (async () => {
      try {
        const tabs = await listPlatformTabs("indeed");
        const applyTabs = tabs.filter((t) => /smartapply|indeedapply/i.test(t.url || ""));
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
      const r = await solveCaptchaWith2Captcha({
        type: msg.type || msg.captchaType || "recaptcha_v2",
        websiteURL: msg.websiteURL || msg.pageUrl || msg.url || "",
        websiteKey: msg.websiteKey || msg.sitekey || msg.siteKey || "",
        pageAction: msg.pageAction || msg.actionName || "",
        data: msg.data || msg.cData || "",
        pagedata: msg.pagedata || msg.chlPageData || msg.pageData || "",
        userAgent: msg.userAgent || "",
        apiDomain: msg.apiDomain || "",
        isEnterprise: !!msg.isEnterprise || /enterprise/i.test(String(msg.type || "")),
        isInvisible: !!msg.isInvisible,
      });
      // Always push token into the tab that asked (all frames) so host page gets it
      if (r?.ok && r.token && sender?.tab?.id && msg.injectInTab !== false) {
        const tabId = sender.tab.id;
        try {
          await chrome.tabs.sendMessage(tabId, { action: "injectRecaptchaToken", token: r.token });
        } catch (_e) {}
        // MAIN world: Indeed reads grecaptcha.getResponse(), not only the textarea
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: "MAIN",
            func: (token) => {
              try {
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
                const walk = (obj, depth) => {
                  if (!obj || depth > 10) return;
                  try {
                    for (const k of Object.keys(obj)) {
                      const v = obj[k];
                      if (typeof v === "function" && /callback|promise|resolve|success/i.test(String(k))) {
                        try {
                          v(token);
                        } catch (_e) {}
                      } else if (v && typeof v === "object") walk(v, depth + 1);
                    }
                  } catch (_e) {}
                };
                try {
                  if (window.___grecaptcha_cfg?.clients) {
                    for (const id of Object.keys(window.___grecaptcha_cfg.clients)) {
                      walk(window.___grecaptcha_cfg.clients[id], 0);
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
    handleIndeedLoginWall(msg.tabId ?? null, msg.url || "")
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.action === "watchIndeedApplyFromGlassdoor") {
    watchingIndeedFromGlassdoor = msg.jobInfo || {};
    sendResponse({ ok: true });
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
          url.includes("linkedin.com/jobs") ||
          url.includes("indeed.com") ||
          url.includes("indeed.fr") ||
          url.includes("smartapply.indeed.com") ||
          url.includes("glassdoor.com") ||
          url.includes("glassdoor.fr")
        ) {
          chrome.tabs.sendMessage(tab.id, { action: "stopAutoApply" }).catch(() => {});
        }
      }
      const platforms = await getActivePlatforms();
      for (const p of platforms) await endPlatformSession(p, "Arrêt demandé");
      sendResponse({ ok: true });
    })();
    return true;
  }

  sendResponse({ ok: false, message: "unknown_action" });
  return false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  return handleMessage(msg, sendResponse, sender);
});

// Seed local 2captcha key from secrets.local.json on every SW wake (local installs only)
getTwoCaptchaApiKey().catch(() => {});

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get([
    "profile",
    "autoApplySettings",
    "mistralApiKey",
    "uiSettings",
    "enabled",
    "twoCaptchaApiKey",
  ]);
  const patch = {};
  if (!existing.profile) patch.profile = { ...DEFAULT_PROFILE };
  // Always repair settings (clears corrupted giant maxJobs / delays).
  patch.autoApplySettings = sanitizeSettings(existing.autoApplySettings || DEFAULT_SETTINGS);
  if (!existing.mistralApiKey) patch.mistralApiKey = DEFAULT_MISTRAL_API_KEY;
  if (!existing.uiSettings) patch.uiSettings = { language: "auto" };
  if (typeof existing.enabled !== "boolean") patch.enabled = true;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  // Local-only: seed 2captcha from secrets.local.json if present (gitignored)
  try {
    await getTwoCaptchaApiKey();
  } catch (_e) {}
  await appendLog(`AmiJobs v${EXT_VERSION} installé — amijobs.com`, "success");
});
