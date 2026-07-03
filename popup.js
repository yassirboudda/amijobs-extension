const $ = (id) => document.getElementById(id);
let uiLang = "fr";

async function sendBg(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch {
    return null;
  }
}

async function sendContent(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null;
  }
}

function selectedContracts() {
  const ids = ["contractCDI", "contractCDD", "contractAlternance", "contractStage", "contractFreelance"];
  return ids.filter((id) => $(id)?.checked).map((id) => $(id).value);
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

function getLocationsFromInput() {
  const raw = $("locations")?.value || "";
  return raw
    .split(/[\n,;]+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function selectedPlatforms() {
  const platforms = [];
  if ($("platformHellowork")?.checked) platforms.push("hellowork");
  if ($("platformLinkedin")?.checked) platforms.push("linkedin");
  if ($("platformIndeed")?.checked) platforms.push("indeed");
  if ($("platformGlassdoor")?.checked) platforms.push("glassdoor");
  return platforms;
}

const PLATFORM_OPEN_ORDER = ["hellowork", "linkedin", "indeed", "glassdoor"];
const PLATFORM_LABEL = { hellowork: "HW", linkedin: "LI", indeed: "IN", glassdoor: "GD" };
const SESSION_KEY = {
  hellowork: "sessionHellowork",
  linkedin: "sessionLinkedin",
  indeed: "sessionIndeed",
  glassdoor: "sessionGlassdoor",
};

function SUPPORTED_LAST_SESSION(state) {
  return !!(
    state.lastSessionHellowork ||
    state.lastSessionLinkedin ||
    state.lastSessionIndeed ||
    state.lastSessionGlassdoor
  );
}

async function applyI18n() {
  uiLang = await getUiLang();
  document.documentElement.lang = uiLang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    el.textContent = t(key, uiLang);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-ph"), uiLang);
  });
}

async function refresh() {
  await applyI18n();
  const state = await sendBg({ action: "getState" });
  if (!state) return;

  $("applied").textContent = state.stats?.applied || 0;
  $("skipped").textContent = state.stats?.skipped || 0;
  $("errors").textContent = state.stats?.errors || 0;
  $("maxJobs").value = state.autoApplySettings?.maxJobsPerSession || 25;

  const statusEl = $("status");
  const active = state.activePlatforms || [];
  if (active.length > 0) {
    const parts = active.map((p) => {
      const s = state[SESSION_KEY[p]];
      return s ? `${PLATFORM_LABEL[p]} ${s.applied || 0}/${s.maxJobs || 25}` : PLATFORM_LABEL[p];
    });
    statusEl.textContent = `${t("statusActive", uiLang)} — ${parts.join(" · ")}`;
    statusEl.style.background = "#dcfce7";
    statusEl.style.color = "#166534";
    $("stopBtn").disabled = false;
    $("startBtn").disabled = true;
    $("resumeBtn").disabled = true;
  } else {
    statusEl.textContent = t("statusInactive", uiLang);
    statusEl.style.background = "#f1f5f9";
    statusEl.style.color = "#475569";
    $("stopBtn").disabled = true;
    $("startBtn").disabled = false;
    const hasLast = SUPPORTED_LAST_SESSION(state);
    $("resumeBtn").disabled = !hasLast;
  }

  const lines = state.log || [];
  $("log").textContent = lines.slice(-80).join("\n") || t("noLog", uiLang);
  $("log").scrollTop = $("log").scrollHeight;
}

// Restore saved form inputs only ONCE on load. Doing this on every refresh
// (every 2.5s) would re-check platform boxes the user just unchecked.
async function restoreFormInputs() {
  const saved = await chrome.storage.local.get([
    "lastKeywords",
    "lastLocations",
    "lastLocation",
    "lastContracts",
    "lastPlatforms",
  ]);
  if (saved.lastKeywords) $("keywords").value = saved.lastKeywords;
  const locs = saved.lastLocations?.length ? saved.lastLocations : asArray(saved.lastLocation);
  if (locs.length && $("locations")) $("locations").value = locs.join("\n");
  if (saved.lastContracts?.length) {
    const map = { CDI: "contractCDI", CDD: "contractCDD", Alternance: "contractAlternance", Stage: "contractStage", Freelance: "contractFreelance" };
    for (const c of saved.lastContracts) {
      if (map[c] && $(map[c])) $(map[c]).checked = true;
    }
  }
  if (saved.lastPlatforms?.length) {
    $("platformHellowork").checked = saved.lastPlatforms.includes("hellowork");
    $("platformLinkedin").checked = saved.lastPlatforms.includes("linkedin");
    if ($("platformIndeed")) $("platformIndeed").checked = saved.lastPlatforms.includes("indeed");
    if ($("platformGlassdoor")) $("platformGlassdoor").checked = saved.lastPlatforms.includes("glassdoor");
  }
}

$("startBtn").addEventListener("click", async () => {
  const platforms = selectedPlatforms();
  const keywords = $("keywords").value.trim();
  const locations = getLocationsFromInput();
  const contracts = selectedContracts();
  const maxJobs = Math.min(Math.max(parseInt($("maxJobs").value, 10) || 25, 1), 200);

  if (platforms.length === 0) {
    $("status").textContent = t("selectPlatform", uiLang);
    return;
  }
  if (!keywords) {
    $("status").textContent = t("keywordsPh", uiLang);
    return;
  }

  await chrome.storage.local.set({
    lastKeywords: keywords,
    lastLocations: locations,
    lastLocation: locations[0] || "",
    lastContracts: contracts,
    lastPlatforms: platforms,
    autoApplySettings: {
      ...(await chrome.storage.local.get(["autoApplySettings"])).autoApplySettings,
      maxJobsPerSession: maxJobs,
    },
  });

  const result = await sendBg({
    action: "startMultiSession",
    platforms,
    keywords,
    locations,
    location: locations[0] || "",
    contracts,
    maxJobs,
  });

  if (!result?.ok) {
    $("status").textContent = t("selectPlatform", uiLang);
    return;
  }

  let first = true;
  for (const p of PLATFORM_OPEN_ORDER) {
    if (!platforms.includes(p) || !result.urls?.[p]) continue;
    if (first) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.update(tab.id, { url: result.urls[p] });
      else await chrome.tabs.create({ url: result.urls[p] });
      first = false;
    } else {
      await chrome.tabs.create({ url: result.urls[p], active: false });
    }
  }

  window.close();
});

$("stopBtn").addEventListener("click", async () => {
  await sendBg({ action: "stopAllPlatforms" });
  await refresh();
});

$("resumeBtn").addEventListener("click", async () => {
  const saved = await chrome.storage.local.get(["lastPlatforms"]);
  const platforms = saved.lastPlatforms?.length
    ? saved.lastPlatforms
    : ["hellowork", "linkedin", "indeed", "glassdoor"];
  let first = true;
  for (const platform of platforms) {
    const resumed = await sendBg({ action: "resumeLastSession", platform });
    if (!resumed?.ok || !resumed.targetUrl) continue;
    if (first) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.update(tab.id, { url: resumed.targetUrl });
      else await chrome.tabs.create({ url: resumed.targetUrl });
      first = false;
    } else {
      await chrome.tabs.create({ url: resumed.targetUrl, active: false });
    }
  }
  if (!first) window.close();
});

$("singleBtn").addEventListener("click", async () => {
  await sendContent({ action: "applySingleJob" });
});

$("optionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("downloadLog").addEventListener("click", () => sendBg({ action: "downloadDebugLog" }));
$("clearLog").addEventListener("click", async () => {
  await sendBg({ action: "clearLog" });
  await refresh();
});
$("resetStats").addEventListener("click", async () => {
  await sendBg({ action: "resetStats" });
  await refresh();
});

restoreFormInputs();
refresh();
setInterval(refresh, 2500);
