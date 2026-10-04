const $ = (id) => document.getElementById(id);
let uiLang = "fr";
// Set as soon as the user edits any form input. Prevents the async
// restoreFormInputs() from clobbering what the user just typed/checked.
let formTouched = false;
let loginBannerManualHide = false;
/** Keeps the pre-start login banner visible across refresh() polls. */
let stickyLoginBanner = null;

try {
  const ver = chrome.runtime.getManifest()?.version || "1.6.4";
  const el = $("extVersion");
  if (el) el.textContent = `v${ver}`;
} catch (_e) {}

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
const PLATFORM_FULL = {
  hellowork: "Hellowork",
  linkedin: "LinkedIn",
  indeed: "Indeed",
  glassdoor: "Glassdoor",
};
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

function hideLoginBanner() {
  stickyLoginBanner = null;
  const banner = $("loginBanner");
  if (banner) banner.classList.remove("visible");
}

function showLoginBanner(items, { midSession = false, sticky = true } = {}) {
  const banner = $("loginBanner");
  const list = $("loginBannerList");
  const hint = $("loginBannerHint");
  if (!banner || !list || !items?.length) return;

  loginBannerManualHide = false;
  if (sticky) stickyLoginBanner = { items, midSession: !!midSession };
  if (hint) {
    hint.textContent = t(midSession ? "loginRequiredMidHint" : "loginRequiredSoftHint", uiLang);
  }
  list.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "login-banner-row";
    const name = document.createElement("span");
    name.textContent = PLATFORM_FULL[item.platform] || item.platform;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = t("openLogin", uiLang);
    btn.addEventListener("click", async () => {
      await sendBg({
        action: "openPlatformLogin",
        platform: item.platform,
        url: item.loginUrl || "",
        location: getLocationsFromInput()[0] || "",
      });
    });
    row.appendChild(name);
    row.appendChild(btn);
    list.appendChild(row);
  }
  banner.classList.add("visible");
}

function updateStartSelfCheck({ activeSession = false } = {}) {
  const el = $("startReady");
  if (!el) return;
  const platforms = selectedPlatforms();
  const keywords = ($("keywords")?.value || "").trim();
  const n = platforms.length;
  const labels = platforms.map((p) => PLATFORM_LABEL[p] || p).join(" · ") || "—";
  const windowsNote = n >= 2 ? t("selfCheckWindows", uiLang).replace("{n}", String(n)) : t("selfCheckSingleTab", uiLang);

  if (activeSession) {
    el.textContent = t("selfCheckRunning", uiLang);
    el.className = "self-check ok";
    return;
  }

  const ready = n > 0 && !!keywords;
  if (!n) {
    el.textContent = t("selfCheckNoPlatform", uiLang);
    el.className = "self-check warn";
    return;
  }
  if (!keywords) {
    el.textContent = `${t("selfCheckNeedKeywords", uiLang)} · ${n} ${t("selfCheckBoards", uiLang)} (${labels})`;
    el.className = "self-check warn";
    return;
  }
  el.textContent = ready
    ? `${t("selfCheckReady", uiLang)} · ${n} ${t("selfCheckBoards", uiLang)} (${labels}) · ${windowsNote}`
    : t("selfCheckNotReady", uiLang);
  el.className = ready ? "self-check ok" : "self-check warn";
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
  if (!state) {
    updateStartSelfCheck();
    return;
  }

  $("applied").textContent = state.stats?.applied || 0;
  $("skipped").textContent = state.stats?.skipped || 0;
  $("errors").textContent = state.stats?.errors || 0;

  const statusEl = $("status");
  const active = state.activePlatforms || [];
  const loginRequired = state.loginRequired || [];

  if (loginRequired.length && !loginBannerManualHide) {
    showLoginBanner(loginRequired, { midSession: true });
  } else if (stickyLoginBanner?.items?.length && !loginBannerManualHide) {
    showLoginBanner(stickyLoginBanner.items, {
      midSession: !!stickyLoginBanner.midSession,
      sticky: true,
    });
  } else if (!loginRequired.length && !stickyLoginBanner) {
    hideLoginBanner();
  }

  if (active.length > 0) {
    const parts = active.map((p) => {
      const s = state[SESSION_KEY[p]];
      return s ? `${PLATFORM_LABEL[p]} ${s.applied || 0}/${s.maxJobs || 25}` : PLATFORM_LABEL[p];
    });
    if (loginRequired.length) {
      const names = loginRequired.map((i) => PLATFORM_FULL[i.platform] || i.platform).join(", ");
      statusEl.textContent = `${t("loginRequiredTitle", uiLang)}: ${names}`;
      statusEl.style.background = "rgba(180, 120, 70, 0.14)";
      statusEl.style.color = "#7a4a28";
    } else {
      statusEl.textContent = `${t("statusActive", uiLang)} · ${parts.join(" · ")}`;
      statusEl.style.background = "rgba(61, 122, 122, 0.14)";
      statusEl.style.color = "#2a5555";
    }
    $("stopBtn").disabled = false;
    $("startBtn").disabled = true;
    $("resumeBtn").disabled = true;
    updateStartSelfCheck({ activeSession: true });
  } else {
    statusEl.textContent = t("statusInactive", uiLang);
    statusEl.style.background = "rgba(232, 238, 244, 0.85)";
    statusEl.style.color = "#243447";
    $("stopBtn").disabled = true;
    $("startBtn").disabled = false;
    const hasLast = SUPPORTED_LAST_SESSION(state);
    $("resumeBtn").disabled = !hasLast;
    updateStartSelfCheck();
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
  updateStartSelfCheck();
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
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
    updateStartSelfCheck();
    return;
  }
  if (!keywords) {
    $("status").textContent = t("keywordsPh", uiLang);
    updateStartSelfCheck();
    return;
  }

  $("startBtn").disabled = true;
  $("status").textContent =
    platforms.length >= 2
      ? t("startingWindows", uiLang).replace("{n}", String(platforms.length))
      : t("startingSession", uiLang);
  $("status").style.background = "rgba(58, 110, 165, 0.14)";
  $("status").style.color = "#2f5b8a";

  if (locations.length) {
    const norm = await sendBg({ action: "normalizeLocations", locations });
    if (norm?.locations?.length) {
      locations = norm.locations;
      if ($("locations")) $("locations").value = locations.join("\n");
    }
  }

  // Soft login probe: never abort Start. Windows must open even if probe is slow/wrong.
  const boardsNeedingLogin = platforms.filter((p) => p === "linkedin" || p === "indeed" || p === "glassdoor");
  if (boardsNeedingLogin.length) {
    $("status").textContent = t("checkingLogin", uiLang);
    const loginCheck = await withTimeout(
      sendBg({
        action: "checkPlatformLogins",
        platforms: boardsNeedingLogin,
        location: locations[0] || "",
      }),
      4500,
      { ok: true, needsLogin: [], timedOut: true }
    );
    const needs = loginCheck?.needsLogin || [];
    if (needs.length) {
      showLoginBanner(needs, { midSession: false });
      const names = needs.map((i) => PLATFORM_FULL[i.platform] || i.platform).join(", ");
      $("status").textContent = `${t("loginSoftContinue", uiLang)}: ${names}`;
      $("status").style.background = "rgba(180, 120, 70, 0.14)";
      $("status").style.color = "#7a4a28";
    } else {
      hideLoginBanner();
    }
  }

  await chrome.storage.local.set({
    lastKeywords: keywords,
    lastLocations: locations,
    lastLocation: locations[0] || "",
    lastContracts: contracts,
    lastPlatforms: platforms,
  });

  $("status").textContent =
    platforms.length >= 2
      ? t("startingWindows", uiLang).replace("{n}", String(platforms.length))
      : t("startingSession", uiLang);

  let result = null;
  try {
    result = await sendBg({
      action: "startMultiSession",
      platforms,
      keywords,
      locations,
      location: locations[0] || "",
      contracts,
      maxJobs,
    });
  } catch (_e) {
    result = null;
  }

  if (!result?.ok) {
    $("status").textContent = t("startFailed", uiLang);
    $("status").style.background = "rgba(180, 120, 70, 0.14)";
    $("status").style.color = "#7a4a28";
    $("startBtn").disabled = false;
    updateStartSelfCheck();
    return;
  }

  const opened = result.open?.openedWindows ?? result.open?.openedTabs;
  if (platforms.length >= 2 && typeof opened === "number" && opened < platforms.length) {
    $("status").textContent = t("startPartialWindows", uiLang)
      .replace("{ok}", String(opened))
      .replace("{n}", String(platforms.length));
  }

  // Tabs/windows are opened by background (exactly 1 per platform)
  window.close();
});

$("stopBtn").addEventListener("click", async () => {
  await sendBg({ action: "stopAllPlatforms" });
  await refresh();
});

$("resumeBtn").addEventListener("click", async () => {
  $("resumeBtn").disabled = true;
  $("status").textContent = t("resumingSession", uiLang);
  $("status").style.background = "rgba(58, 110, 165, 0.14)";
  $("status").style.color = "#2f5b8a";

  const saved = await chrome.storage.local.get(["lastPlatforms"]);
  const platforms = (saved.lastPlatforms?.length
    ? saved.lastPlatforms
    : PLATFORM_OPEN_ORDER
  ).filter((p) => PLATFORM_OPEN_ORDER.includes(p));

  const urls = {};
  for (const platform of platforms) {
    const resumed = await sendBg({ action: "resumeLastSession", platform });
    if (!resumed?.ok || !resumed.targetUrl) continue;
    urls[platform] = resumed.targetUrl;
  }
  const opened = PLATFORM_OPEN_ORDER.filter((p) => urls[p]);
  if (!opened.length) {
    $("status").textContent = t("resumeFailed", uiLang);
    $("resumeBtn").disabled = false;
    return;
  }
  await sendBg({ action: "openPlatformTabs", urls, platforms: opened, kick: true });
  window.close();
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

const dismissBtn = $("loginBannerDismiss");
if (dismissBtn) {
  dismissBtn.addEventListener("click", () => {
    loginBannerManualHide = true;
    hideLoginBanner();
  });
}

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
    updateStartSelfCheck();
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
      updateStartSelfCheck();
    });
    box.appendChild(btn);
  }
  box.style.display = "block";
}

const locationsInput = $("locations");
if (locationsInput) {
  locationsInput.addEventListener("input", () => {
    formTouched = true;
    updateStartSelfCheck();
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
