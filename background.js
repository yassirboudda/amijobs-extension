// AmiJobs — Background Service Worker v1.1.0
// Unified orchestration for Hellowork, LinkedIn, Indeed & Glassdoor
// https://amijobs.com
// ============================================================================

const EXT_VERSION = "1.1.0";
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
  delayBetweenJobs: { min: 6000, max: 14000 },
  delayBetweenSteps: { min: 700, max: 1600 },
  autoSubmit: true,
  onlyEasyApply: true,
  maxConsecutiveNoApplyPages: 20,
};

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
      searchUrl: "",
      currentPage: 0,
      noApplyPages: 0,
      ...overrides,
    };
  }
  return {
    ...base,
    keywords: "",
    location: "",
    currentPage: 0,
    noEasyPages: 0,
    ...overrides,
  };
}

function buildHelloworkSearchUrl(keywords, location, contract) {
  const p = new URLSearchParams();
  p.set("k", keywords || "");
  if (location) p.set("l", location);
  if (contract) p.set("c", contract);
  return `https://www.hellowork.com/fr-fr/emploi/recherche.html?${p.toString()}`;
}

function buildLinkedInSearchUrl(keywords, location) {
  const params = new URLSearchParams();
  if (keywords) params.set("keywords", keywords);
  if (location) params.set("location", location);
  params.set("f_AL", "true");
  params.set("f_TPR", "r86400");
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

async function endPlatformSession(platform, reason = "") {
  const key = SESSION_KEYS[platform];
  const lastKey = LAST_SESSION_KEYS[platform];
  const { [key]: session = null, stats = { applied: 0, skipped: 0, errors: 0, lastRun: null } } =
    await chrome.storage.local.get([key, "stats"]);

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
    autoApplySettings: data.autoApplySettings || { ...DEFAULT_SETTINGS },
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
    updates.autoApplySettings = { ...(existing.autoApplySettings || DEFAULT_SETTINGS), ...msg.autoApplySettings };
  }
  if (msg.maxJobsPerSession) {
    updates.autoApplySettings = {
      ...(updates.autoApplySettings || existing.autoApplySettings || DEFAULT_SETTINGS),
      maxJobsPerSession: msg.maxJobsPerSession,
    };
  }

  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  await appendLog("Profil synchronisé depuis l'app web", "success");
  return { ok: true, syncedAt: new Date().toISOString() };
}

async function startMultiSession(msg) {
  const platforms = (msg.platforms || []).filter((p) => SUPPORTED_PLATFORMS.includes(p));
  if (platforms.length === 0) return { ok: false, reason: "no_platform" };

  const maxJobs = msg.maxJobs || 25;
  const keywords = msg.keywords || "";
  const location = msg.location || "";
  const contract = msg.contract || "";

  const amijobsMeta = {
    active: true,
    platforms,
    keywords,
    location,
    contract,
    maxJobs,
    startedAt: new Date().toISOString(),
  };

  const updates = { amijobsMeta, enabled: true };
  const urls = {};

  if (platforms.includes("hellowork")) {
    const searchUrl = msg.helloworkUrl || buildHelloworkSearchUrl(keywords, location, contract);
    urls.hellowork = searchUrl;
    updates.sessionHellowork = emptyPlatformSession("hellowork", {
      searchUrl,
      resumeSearchUrl: searchUrl,
      maxJobs,
    });
  }

  if (platforms.includes("linkedin")) {
    const searchUrl = msg.linkedinUrl || buildLinkedInSearchUrl(keywords, location);
    urls.linkedin = searchUrl;
    updates.sessionLinkedin = emptyPlatformSession("linkedin", {
      keywords,
      location,
      maxJobs,
      searchUrl,
    });
  }

  if (platforms.includes("indeed")) {
    const searchUrl = msg.indeedUrl || buildIndeedSearchUrl(keywords, location);
    urls.indeed = searchUrl;
    updates.sessionIndeed = emptyPlatformSession("indeed", {
      keywords,
      location,
      maxJobs,
      searchUrl,
    });
  }

  if (platforms.includes("glassdoor")) {
    const searchUrl = msg.glassdoorUrl || buildGlassdoorSearchUrl(keywords, location);
    urls.glassdoor = searchUrl;
    updates.sessionGlassdoor = emptyPlatformSession("glassdoor", {
      keywords,
      location,
      maxJobs,
      searchUrl,
    });
  }

  await chrome.storage.local.set(updates);
  await appendLog(
    `Session AmiJobs démarrée (${platforms.join(" + ")}): "${keywords}" @ "${location}"`,
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
        targetUrl = buildLinkedInSearchUrl(resumed.keywords, resumed.location);
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
  if (!existing.autoApplySettings) patch.autoApplySettings = { ...DEFAULT_SETTINGS };
  if (!existing.mistralApiKey) patch.mistralApiKey = DEFAULT_MISTRAL_API_KEY;
  if (!existing.uiSettings) patch.uiSettings = { language: "auto" };
  if (typeof existing.enabled !== "boolean") patch.enabled = true;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  await appendLog(`AmiJobs v${EXT_VERSION} installé — amijobs.com`, "success");
});
