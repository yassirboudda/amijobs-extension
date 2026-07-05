const $ = (id) => document.getElementById(id);
let uiLang = "fr";
// Set as soon as the user edits any form input. Prevents the async
// restoreFormInputs() from clobbering what the user just typed/checked.
let formTouched = false;

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
  // The user may have started typing before this async read resolved.
  if (formTouched) return;
  // Only fill fields that are still empty so a late-resolving read can never
  // clobber text the user already typed.
  if (saved.lastKeywords && !$("keywords").value) $("keywords").value = saved.lastKeywords;
  const locs = saved.lastLocations?.length ? saved.lastLocations : asArray(saved.lastLocation);
  if (locs.length && $("locations") && !$("locations").value) $("locations").value = locs.join("\n");
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
  let locations = getLocationsFromInput();
  const contracts = selectedContracts();
  const state = await sendBg({ action: "getState" });
  const maxJobs = state?.autoApplySettings?.maxJobsPerSession || 25;

  if (platforms.length === 0) {
    $("status").textContent = t("selectPlatform", uiLang);
    return;
  }
  if (!keywords) {
    $("status").textContent = t("keywordsPh", uiLang);
    return;
  }

  if (locations.length) {
    const norm = await sendBg({ action: "normalizeLocations", locations });
    if (norm?.locations?.length) {
      locations = norm.locations;
      if ($("locations")) $("locations").value = locations.join("\n");
    }
  }

  await chrome.storage.local.set({
    lastKeywords: keywords,
    lastLocations: locations,
    lastLocation: locations[0] || "",
    lastContracts: contracts,
    lastPlatforms: platforms,
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
    await chrome.tabs.create({ url: result.urls[p], active: first });
    first = false;
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

const FORM_INPUT_IDS = [
  "keywords",
  "locations",
  "contractCDI",
  "contractCDD",
  "contractAlternance",
  "contractStage",
  "contractFreelance",
  "platformHellowork",
  "platformLinkedin",
  "platformIndeed",
  "platformGlassdoor",
];
for (const id of FORM_INPUT_IDS) {
  const el = $(id);
  if (!el) continue;
  const markTouched = () => {
    formTouched = true;
  };
  el.addEventListener("input", markTouched);
  el.addEventListener("change", markTouched);
}

let locationSuggestTimer = null;

function getCurrentLocationLine(textarea) {
  const pos = textarea.selectionStart ?? textarea.value.length;
  const text = textarea.value;
  const lineStart = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const lineEndRaw = text.indexOf("\n", pos);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  return { lineStart, lineEnd, currentLine: text.slice(lineStart, lineEnd) };
}

function hideLocationSuggestions() {
  const box = $("locationSuggestions");
  if (!box) return;
  box.innerHTML = "";
  box.style.display = "none";
}

function showLocationSuggestions(items) {
  const box = $("locationSuggestions");
  if (!box) return;
  box.innerHTML = "";
  if (!items.length) {
    box.style.display = "none";
    return;
  }
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "loc-suggestion";
    btn.textContent = item;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const ta = $("locations");
      const { lineStart, lineEnd } = getCurrentLocationLine(ta);
      const text = ta.value;
      ta.value = `${text.slice(0, lineStart)}${item}${text.slice(lineEnd)}`;
      formTouched = true;
      hideLocationSuggestions();
    });
    box.appendChild(btn);
  }
  box.style.display = "block";
}

const locationsInput = $("locations");
if (locationsInput) {
  locationsInput.addEventListener("input", () => {
    formTouched = true;
    clearTimeout(locationSuggestTimer);
    locationSuggestTimer = setTimeout(async () => {
      const { currentLine } = getCurrentLocationLine(locationsInput);
      const query = currentLine.trim();
      if (query.length < 2) {
        hideLocationSuggestions();
        return;
      }
      const res = await sendBg({ action: "indeedLocationSuggestions", query });
      showLocationSuggestions(res?.suggestions || []);
    }, 250);
  });
  locationsInput.addEventListener("blur", () => {
    setTimeout(hideLocationSuggestions, 150);
  });
}

restoreFormInputs();
refresh();
setInterval(refresh, 2500);
