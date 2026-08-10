// AmiJobs — Background Service Worker v1.1.0
// Unified orchestration for Hellowork, LinkedIn, Indeed & Glassdoor
// https://amijobs.com
// ============================================================================

const EXT_VERSION = "1.4.2";
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
  // Prefer classic Job/jobs.htm search (live browser: Job/index.htm also lists Easy Apply cards)
  const p = new URLSearchParams();
  const kw = freelanceAwareKeywords(keywords, contracts);
  if (kw) p.set("sc.keyword", kw);
  if (location) p.set("sc.location", location);
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
let tabEnforceLock = false;
const lastPlatformReopenAt = Object.create(null);
const platformReopenCount = Object.create(null);

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
    const wantApply = /smartapply|indeedapply/i.test(String(url || ""));
    const applyTabs = tabs.filter((t) => /smartapply|indeedapply/i.test(t.url || ""));
    const boardTabs = tabs.filter((t) => !/smartapply|indeedapply/i.test(t.url || ""));
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
      if (forceNavigate && url && keep.url !== url) patch.url = url;
      if (Object.keys(patch).length) {
        try {
          await chrome.tabs.update(keep.id, patch);
        } catch (_e) {}
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

      // Indeed exception: allow 1 SERP (/jobs|/viewjob) + 1 Smart Apply at once.
      // Old logic preferred Smart Apply and closed the SERP → "Indeed closes alone".
      if (platform === "indeed") {
        const applyTabs = tabs.filter((t) => /smartapply|indeedapply/i.test(t.url || ""));
        const boardTabs = tabs.filter((t) => !/smartapply|indeedapply/i.test(t.url || ""));
        const keepApply = pickTabToKeep(applyTabs, "smartapply");
        const keepBoard = pickTabToKeep(boardTabs, "/jobs");
        for (const t of applyTabs) {
          if (keepApply && t.id !== keepApply.id) {
            try {
              await chrome.tabs.remove(t.id);
            } catch (_e) {}
          }
        }
        for (const t of boardTabs) {
          if (keepBoard && t.id !== keepBoard.id) {
            try {
              await chrome.tabs.remove(t.id);
            } catch (_e) {}
          }
        }
        if (reason && (applyTabs.length > 1 || boardTabs.length > 1)) {
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
  for (const p of SUPPORTED_PLATFORMS) {
    if (!platforms.includes(p) || !urls[p]) continue;
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
            files: ["content/cloudflare-turnstile.js"],
          })
          .catch(() => {});
        chrome.scripting
          .executeScript({
            target: { tabId, allFrames: true },
            func: () => {
              try {
                if (typeof window.__AmijobsClickTurnstile === "function") window.__AmijobsClickTurnstile();
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

  if (!/smartapply\.indeed\.com/i.test(url) && !/indeed\.(com|fr)\/(?:beta\/)?indeedapply/i.test(url)) {
    return;
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
        },
        glassdoorSmartApply: {
          jobId: job.jobId || sessionGlassdoor.currentJk || "",
          title: job.title || sessionGlassdoor.currentTitle || "",
          company: job.company || sessionGlassdoor.currentCompany || "",
          at: Date.now(),
        },
      });
      watchingIndeedFromGlassdoor = null;

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

async function solveCaptchaWith2Captcha({
  type = "recaptcha_v2",
  websiteURL,
  websiteKey,
  pageAction = "",
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

  let task;
  const t = String(type || "").toLowerCase();
  if (t.includes("turnstile") || t.includes("cloudflare")) {
    task = {
      type: "TurnstileTaskProxyless",
      websiteURL: pageUrl,
      websiteKey: siteKey,
    };
    if (pageAction) task.action = pageAction;
  } else if (isEnterprise || t.includes("enterprise")) {
    task = {
      type: "RecaptchaV2EnterpriseTaskProxyless",
      websiteURL: pageUrl,
      websiteKey: siteKey,
      isInvisible: !!isInvisible,
    };
  } else {
    task = {
      type: "RecaptchaV2TaskProxyless",
      websiteURL: pageUrl,
      websiteKey: siteKey,
      isInvisible: !!isInvisible,
    };
  }

  try {
    const createRes = await fetch(TWOCAPTCHA_CREATE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey, task }),
    });
    const created = await createRes.json();
    if (created?.errorId) {
      await appendLog(
        `2captcha createTask: ${created.errorDescription || created.errorCode || "error"}`,
        "warn"
      );
      return { ok: false, reason: created.errorDescription || "create_failed", errorId: created.errorId };
    }
    const taskId = created?.taskId;
    if (!taskId) return { ok: false, reason: "no_task_id" };

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const pollRes = await fetch(TWOCAPTCHA_RESULT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey, taskId }),
      });
      const polled = await pollRes.json();
      if (polled?.errorId) {
        return { ok: false, reason: polled.errorDescription || "poll_failed", errorId: polled.errorId };
      }
      if (polled?.status === "ready") {
        const token =
          polled?.solution?.gRecaptchaResponse ||
          polled?.solution?.token ||
          polled?.solution?.text ||
          "";
        if (!token) return { ok: false, reason: "empty_token" };
        await appendLog("2captcha: captcha résolu", "success");
        return { ok: true, token, taskId };
      }
    }
    return { ok: false, reason: "timeout" };
  } catch (err) {
    console.error("[AmiJobs] 2captcha error:", err);
    return { ok: false, reason: err?.message || "network_error" };
  }
}

async function generateAnswer(question, fieldType, options, jobInfo, profile, cvText) {
  const q = String(question || "");
  const cv = String(cvText || profile?.cvText || "");
  const loc = String(profile.location || profile.country || "France").toLowerCase();

  // Years of experience / "Antiquité du poste" — derive from CV/profile, never invent "we"
  if (
    /antiquit|anciennet[ée]|exp[eé]rience|seniority|years?\s*(of\s*)?experience|combien d['’]?ann[ée]es|nombre d['’]?ann[ée]es|ans d['’]?exp/i.test(
      q
    )
  ) {
    const fromProfile = String(profile.experience || "").match(/(\d+(?:[.,]\d+)?)/);
    const fromCv =
      cv.match(/(\d+(?:[.,]\d+)?)\s*(?:\+)?\s*(?:ans|ann[ée]es?|years?)\s*(?:d['’]?exp[eé]rience|of\s*experience|exp\.?)/i) ||
      cv.match(/exp[eé]rience[^\n]{0,40}?(\d+(?:[.,]\d+)?)\s*(?:ans|ann[ée]es?|years?)/i) ||
      cv.match(/(\d+(?:[.,]\d+)?)\s*\+\s*(?:ans|years?)/i);
    const years = (fromCv && fromCv[1]) || (fromProfile && fromProfile[1]) || "";
    if (years) {
      const n = years.replace(",", ".");
      if (fieldType === "number" || /nombre|combien|ans\b|years?\b/i.test(q)) return String(parseFloat(n) || n);
      return `${n} ans`;
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
- Base-toi UNIQUEMENT sur le CV et le profil. N'invente rien.
- Pour antiquité / années d'expérience: réponds avec un nombre (ex: 5) ou "X ans" selon le champ.
- Interdit: réponses vides, "we", "oui" seul, "n/a", anglais générique.
- Si l'info manque dans le CV, réponds de façon minimale et factuelle (ex: profil.experience).
- Dates au format JJ/MM/AAAA sauf si le champ exige ISO.`;
  let userPrompt = `Question: "${question}"\nType: ${fieldType}`;
  if (options?.length) userPrompt += `\nOptions: ${JSON.stringify(options)}`;
  const ai = await askMistral(systemPrompt, userPrompt, 200);
  if (!ai) return null;
  let cleaned = ai.trim().replace(/^["'«»]+|["'«»]+$/g, "");
  // Guard against lazy / broken AI answers
  if (/^(oui|yes|we|n\/?a|na|none|null)\.?$/i.test(cleaned) && /rythme|date|combien|salaire|expérience|antiquit|anciennet|niveau|jours|ans/i.test(q)) {
    if (/rythme|alternance/i.test(q)) return "2 jours école / 3 jours entreprise";
    if (/antiquit|anciennet|expérience|ans/i.test(q)) {
      const n = String(profile.experience || "").match(/(\d+)/);
      return n ? n[1] : "3";
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
      // v1.4.0: Don't reopen Glassdoor during Indeed handoff (anti-loop)
      if (platform === "glassdoor" && session.awaitingIndeed) continue;
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
        if (
          platform === "indeed" &&
          !session.fromGlassdoor &&
          /smartapply|indeedapply/i.test(tabUrl) &&
          searchUrl
        ) {
          const now = Date.now();
          const last = lastPlatformReopenAt[platform] || 0;
          if (now - last >= 20000) {
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
chrome.tabs.onCreated.addListener(() => {
  setTimeout(() => enforceOneTabPerPlatform("nouvel onglet").catch(() => {}), 400);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const platform = detectPlatformFromUrl(changeInfo.url || tab?.url || "");
  if (!platform) return;
  setTimeout(() => enforceOneTabPerPlatform("navigation").catch(() => {}), 500);
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

      // v1.4.0: Don't reopen Glassdoor while an Indeed handoff is in progress.
      // During handoff, the Glassdoor tab navigates to Indeed Smart Apply, so
      // listPlatformTabs("glassdoor") returns 0 → the watchdog would reopen
      // Glassdoor → new run → another handoff → open-crash-close loop.
      if (platform === "glassdoor" && session.awaitingIndeed) continue;

      const searchUrl = session.searchUrl || session.resumeSearchUrl || "";
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
    });
  }

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

  // Always open/reuse exactly one tab per selected platform
  await openPlatformTabs(urls, platforms);

  // Kick content scripts (Glassdoor/LinkedIn sometimes miss the first auto-resume)
  setTimeout(() => {
    kickPlatformSessions(platforms).catch(() => {});
  }, 2500);

  return { ok: true, urls, platforms };
}

async function kickPlatformSessions(platforms = []) {
  for (const platform of platforms) {
    try {
      const tabs = await listPlatformTabs(platform);
      for (const tab of tabs.slice(0, 1)) {
        if (!tab?.id) continue;
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
          }
        } catch (_e) {
          /* already injected */
        }
        chrome.tabs.sendMessage(tab.id, { action: "startAutoApply" }).catch(() => {});
      }
    } catch (_e) {
      /* ignore */
    }
  }
}

function handleMessage(msg, sendResponse, sender = null) {
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
          files: ["content/cloudflare-turnstile.js"],
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
            const click = (el) => {
              if (!el) return;
              const r = el.getBoundingClientRect();
              const x = r.left + Math.min(22, Math.max(8, r.width * 0.12));
              const y = r.top + r.height / 2;
              const t = document.elementFromPoint(x, y) || el;
              const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, buttons: 1 };
              for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
                try {
                  t.dispatchEvent(new MouseEvent(type, o));
                } catch (_e) {}
              }
              try {
                el.click();
              } catch (_e) {}
            };
            const nodes = [
              ...document.querySelectorAll(
                'input[type="checkbox"], [role="checkbox"], label.cb-lb, .cb-lb, .cf-turnstile, #challenge-stage, iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]'
              ),
            ];
            nodes.forEach(click);
            return { clicked: nodes.length > 0, href: location.href.slice(0, 120), n: nodes.length };
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

  if (msg.action === "openPlatformTabs") {
    openPlatformTabs(msg.urls || {}, msg.platforms || [])
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg.action === "ensurePlatformTab") {
    ensureSinglePlatformTab(msg.platform, msg.url, {
      active: !!msg.active,
      forceNavigate: msg.forceNavigate !== false,
    })
      .then((tabId) => sendResponse({ ok: true, tabId }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
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
        state.cvText
      );
      sendResponse({ answer });
    })();
    return true;
  }

  if (msg.action === "listIndeedTabs") {
    listPlatformTabs("indeed")
      .then((tabs) => {
        const hasSmartApply = tabs.some((t) => /smartapply|indeedapply/i.test(t.url || ""));
        const hasSerp = tabs.some((t) => /\/jobs|viewjob/i.test(t.url || "") && !/smartapply/i.test(t.url || ""));
        sendResponse({ ok: true, count: tabs.length, hasSmartApply, hasSerp });
      })
      .catch((e) => sendResponse({ ok: false, reason: e.message }));
    return true;
  }

  if (msg.action === "solveCaptcha" || msg.action === "solve2Captcha") {
    (async () => {
      const r = await solveCaptchaWith2Captcha({
        type: msg.type || msg.captchaType || "recaptcha_v2",
        websiteURL: msg.websiteURL || msg.pageUrl || msg.url || "",
        websiteKey: msg.websiteKey || msg.sitekey || msg.siteKey || "",
        pageAction: msg.pageAction || msg.actionName || "",
        isEnterprise: !!msg.isEnterprise || /enterprise/i.test(String(msg.type || "")),
        isInvisible: !!msg.isInvisible,
      });
      // Always push token into the tab that asked (all frames) so host page gets it
      if (r?.ok && r.token && sender?.tab?.id && msg.injectInTab !== false) {
        const tabId = sender.tab.id;
        try {
          await chrome.tabs.sendMessage(tabId, { action: "injectRecaptchaToken", token: r.token });
        } catch (_e) {}
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: (token) => {
              try {
                window.__AmijobsRecaptchaToken = token;
                if (typeof window.__AmijobsInjectRecaptchaToken === "function") {
                  window.__AmijobsInjectRecaptchaToken(token);
                }
                const areas = document.querySelectorAll(
                  'textarea[name="g-recaptcha-response"], #g-recaptcha-response, textarea.g-recaptcha-response'
                );
                for (const area of areas) {
                  area.value = token;
                  area.innerHTML = token;
                  area.dispatchEvent(new Event("input", { bubbles: true }));
                  area.dispatchEvent(new Event("change", { bubbles: true }));
                }
                if (!areas.length) {
                  const ta = document.createElement("textarea");
                  ta.name = "g-recaptcha-response";
                  ta.id = "g-recaptcha-response";
                  ta.style.display = "none";
                  ta.value = token;
                  (document.body || document.documentElement).appendChild(ta);
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
      const { appliedJobs = {}, stats = { applied: 0, skipped: 0, errors: 0, lastRun: null } } =
        await chrome.storage.local.get(["appliedJobs", "stats"]);
      const prefix = jobKeyPrefix(platform);
      const key = prefix + (msg.jobId || `job_${Date.now()}`);
      appliedJobs[key] = {
        platform,
        title: msg.title || "",
        company: msg.company || "",
        url: msg.url || "",
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

  if (msg.action === "watchIndeedApplyFromGlassdoor") {
    watchingIndeedFromGlassdoor = msg.jobInfo || {};
    sendResponse({ ok: true });
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
            indeedHandoffDone: false,
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
        // Glassdoor handoff finished: if Indeed session still needs SERP, go there in this tab;
        // otherwise close only when another Indeed tab already exists.
        const others = (await listPlatformTabs("indeed")).filter((t) => t.id !== tabId);
        if (sessionIndeed?.active && !sessionIndeed.fromGlassdoor && sessionIndeed.searchUrl) {
          try {
            await chrome.tabs.update(tabId, { url: sessionIndeed.searchUrl, active: false });
          } catch (_e) {
            /* ignore */
          }
        } else if (others.length) {
          try {
            await chrome.tabs.remove(tabId);
          } catch (_e) {
            /* ignore */
          }
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
