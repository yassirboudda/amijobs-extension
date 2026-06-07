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

function selectedPlatforms() {
  const platforms = [];
  if ($("platformHellowork").checked) platforms.push("hellowork");
  if ($("platformLinkedin").checked) platforms.push("linkedin");
  return platforms;
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
    const hw = state.sessionHellowork;
    const li = state.sessionLinkedin;
    const parts = [];
    if (active.includes("hellowork") && hw) parts.push(`HW ${hw.applied || 0}/${hw.maxJobs || 25}`);
    if (active.includes("linkedin") && li) parts.push(`LI ${li.applied || 0}/${li.maxJobs || 25}`);
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
    const hasLast = !!(state.lastSessionHellowork || state.lastSessionLinkedin);
    $("resumeBtn").disabled = !hasLast;
  }

  const saved = await chrome.storage.local.get(["lastKeywords", "lastLocation", "lastContract", "lastPlatforms"]);
  if (saved.lastKeywords) $("keywords").value = saved.lastKeywords;
  if (saved.lastLocation) $("location").value = saved.lastLocation;
  if (saved.lastContract) $("contract").value = saved.lastContract;
  if (saved.lastPlatforms?.length) {
    $("platformHellowork").checked = saved.lastPlatforms.includes("hellowork");
    $("platformLinkedin").checked = saved.lastPlatforms.includes("linkedin");
  }

  const lines = state.log || [];
  $("log").textContent = lines.slice(-80).join("\n") || t("noLog", uiLang);
  $("log").scrollTop = $("log").scrollHeight;
}

$("startBtn").addEventListener("click", async () => {
  const platforms = selectedPlatforms();
  const keywords = $("keywords").value.trim();
  const location = $("location").value.trim();
  const contract = $("contract").value.trim();
  const maxJobs = parseInt($("maxJobs").value, 10) || 25;

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
    lastLocation: location,
    lastContract: contract,
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
    location,
    contract,
    maxJobs,
  });

  if (!result?.ok) {
    $("status").textContent = t("selectPlatform", uiLang);
    return;
  }

  const openOrder = platforms.includes("hellowork") ? ["hellowork", "linkedin"] : ["linkedin", "hellowork"];
  let first = true;
  for (const p of openOrder) {
    if (!result.urls?.[p]) continue;
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
  const platforms = saved.lastPlatforms?.length ? saved.lastPlatforms : ["hellowork", "linkedin"];
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

refresh();
setInterval(refresh, 2500);
