// AmiJobs — Background Service Worker v1.1.0
// Unified orchestration for Hellowork, LinkedIn, Indeed & Glassdoor
// https://amijobs.com
// ============================================================================

const EXT_VERSION = "1.2.5";
const MISTRAL_MODEL = "mistral-large-latest";
const MISTRAL_ENDPOINT = "https://api.mistral.ai/v1/chat/completions";
const DEFAULT_MISTRAL_API_KEY = "uwqtlWhrRDIdE0QAHYkIhMFkLTbkDYIb";

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

function buildHelloworkSearchUrl(keywords, location, contracts) {
  const list = asArray(contracts);
  const qs = [];
  qs.push(`k=${encodeURIComponent(keywords || "")}`);
  if (location) qs.push(`l=${encodeURIComponent(location)}`);
  for (const c of list) qs.push(`c=${encodeURIComponent(c)}`);
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

function buildLinkedInSearchUrl(keywords, location, contracts) {
  const params = new URLSearchParams();
  if (keywords) params.set("keywords", keywords);
  if (location) params.set("location", location);
  params.set("f_AL", "true");
  params.set("f_TPR", "r86400");
  const codes = [...new Set(asArray(contracts).map((c) => LINKEDIN_JT[c.toLowerCase()]).filter(Boolean))];
  if (codes.length) params.set("f_JT", codes.join(","));
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

function buildIndeedSearchUrl(keywords, location, page = 0) {
  const p = new URLSearchParams();
  if (keywords) p.set("q", keywords);
  if (location) p.set("l", location);
  if (page > 0) p.set("start", String(page * 10));
  return `https://fr.indeed.com/jobs?${p.toString()}`;
}

function buildGlassdoorSearchUrl(keywords, location) {
  const p = new URLSearchParams();
  if (keywords) p.set("sc.keyword", keywords);
  if (location) p.set("sc.location", location);
  return `https://www.glassdoor.fr/Job/jobs.htm?${p.toString()}`;
}

function buildPlatformSearchUrl(platform, keywords, location, contracts, page = 0) {
  if (platform === "hellowork") return buildHelloworkSearchUrl(keywords, location, contracts);
  if (platform === "linkedin") return buildLinkedInSearchUrl(keywords, location, contracts);
  if (platform === "indeed") return buildIndeedSearchUrl(keywords, location, page);
  if (platform === "glassdoor") return buildGlassdoorSearchUrl(keywords, location);
  return "";
}

const PLATFORM_URL_MATCH = {
  hellowork: ["hellowork.com"],
  linkedin: ["linkedin.com/jobs"],
  indeed: ["indeed.com", "indeed.fr"],
  glassdoor: ["glassdoor.com", "glassdoor.fr"],
};

async function navigatePlatformTab(platform, url) {
  const patterns = PLATFORM_URL_MATCH[platform] || [];
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => t.url && patterns.some((p) => t.url.includes(p)));
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url });
  } else {
    await chrome.tabs.create({ url, active: false });
  }
}

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
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error("[AmiJobs] Mistral error:", err);
    return null;
  }
}

async function generateAnswer(question, fieldType, options, jobInfo, profile, cvText) {
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
  const cvContext = cvText ? `\n\nCV:\n${String(cvText).substring(0, 2000)}` : "";
  const systemPrompt = `Tu aides à remplir un formulaire de candidature pour ${profile.fullName || "le candidat"}.
${profileContext}${cvContext}
Poste: ${jobInfo?.title || "?"} @ ${jobInfo?.company || "?"}
Réponds UNIQUEMENT avec la valeur du champ, sans explication.`;
  let userPrompt = `Question: "${question}"\nType: ${fieldType}`;
  if (options?.length) userPrompt += `\nOptions: ${JSON.stringify(options)}`;
  return askMistral(systemPrompt, userPrompt, 200);
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

async function openPlatformTabs(urls, platforms) {
  let first = true;
  for (const p of SUPPORTED_PLATFORMS) {
    if (!platforms.includes(p) || !urls[p]) continue;
    if (first) {
      await chrome.tabs.create({ url: urls[p], active: true });
      first = false;
    } else {
      await chrome.tabs.create({ url: urls[p], active: false });
    }
  }
}

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
    const searchUrl = msg.linkedinUrl || buildLinkedInSearchUrl(keywords, location, contracts);
    urls.linkedin = searchUrl;
    updates.sessionLinkedin = emptyPlatformSession("linkedin", {
      ...common,
      searchUrl,
    });
  }

  if (platforms.includes("indeed")) {
    const searchUrl = msg.indeedUrl || buildIndeedSearchUrl(keywords, location);
    urls.indeed = searchUrl;
    updates.sessionIndeed = emptyPlatformSession("indeed", {
      ...common,
      searchUrl,
    });
  }

  if (platforms.includes("glassdoor")) {
    const searchUrl = msg.glassdoorUrl || buildGlassdoorSearchUrl(keywords, location);
    urls.glassdoor = searchUrl;
    updates.sessionGlassdoor = emptyPlatformSession("glassdoor", {
      ...common,
      searchUrl,
    });
  }

  await chrome.storage.local.set(updates);
  await appendLog(
    `Session AmiJobs démarrée (${platforms.join(" + ")}): "${keywords}" @ "${locationsOrEmpty.join(", ")}"` +
      (contracts.length ? ` [${contracts.join(", ")}]` : ""),
    "success"
  );

  if (msg.openTabs) await openPlatformTabs(urls, platforms);

  return { ok: true, urls, platforms };
}

function handleMessage(msg, sendResponse) {
  if (msg.action === "ping") {
    sendResponse({ ok: true, version: EXT_VERSION });
    return false;
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
        targetUrl = resumed.searchUrl || buildIndeedSearchUrl(resumed.keywords, resumed.location, resumed.currentPage || 0);
      } else if (platform === "glassdoor") {
        targetUrl = resumed.searchUrl || buildGlassdoorSearchUrl(resumed.keywords, resumed.location);
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

  if (msg.action === "checkBackend") {
    sendResponse({ available: false });
    return false;
  }

  if (msg.action === "addToPipeline" || msg.action === "requestExternalApply") {
    sendResponse({ ok: false, reason: "not_available" });
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

  if (msg.action === "stopAllPlatforms") {
    (async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        const url = tab.url || "";
        if (!tab.id) continue;
        if (url.includes("hellowork.com") || url.includes("linkedin.com/jobs") || url.includes("indeed.com") || url.includes("indeed.fr") || url.includes("glassdoor.com") || url.includes("glassdoor.fr")) {
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  return handleMessage(msg, sendResponse);
});

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get([
    "profile",
    "autoApplySettings",
    "mistralApiKey",
    "uiSettings",
    "enabled",
  ]);
  const patch = {};
  if (!existing.profile) patch.profile = { ...DEFAULT_PROFILE };
  // Always repair settings (clears corrupted giant maxJobs / delays).
  patch.autoApplySettings = sanitizeSettings(existing.autoApplySettings || DEFAULT_SETTINGS);
  if (!existing.mistralApiKey) patch.mistralApiKey = DEFAULT_MISTRAL_API_KEY;
  if (!existing.uiSettings) patch.uiSettings = { language: "auto" };
  if (typeof existing.enabled !== "boolean") patch.enabled = true;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  await appendLog(`AmiJobs v${EXT_VERSION} installé — amijobs.com`, "success");
});
