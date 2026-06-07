const $ = (id) => document.getElementById(id);

function updateBlacklistCount(count) {
  const badge = $("blacklistCount");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }
}

async function applyI18n() {
  const lang = await getUiLang();
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const text = t(key, lang);
    if (el.tagName === "OPTION") el.textContent = text;
    else if (!el.querySelector("a")) el.textContent = text;
  });
}

async function load() {
  await applyI18n();
  const data = await chrome.storage.local.get([
    "profile",
    "autoApplySettings",
    "mistralApiKey",
    "blacklistedCompanies",
    "uiSettings",
    "cvText",
  ]);
  const profile = data.profile || {};
  const settings = data.autoApplySettings || {};

  $("uiLanguage").value = data.uiSettings?.language || "auto";
  $("fullName").value = profile.fullName || "";
  $("civility").value = profile.civility || "";
  $("email").value = profile.email || "";
  $("phone").value = profile.phone || "";
  $("linkedin").value = profile.linkedin || "";
  $("location").value = profile.location || "";
  $("postalCode").value = profile.postalCode || "";
  $("birthDate").value = profile.birthDate || "";
  $("title").value = profile.title || "";
  $("experience").value = profile.experience || "";
  $("stack").value = profile.stack || "";
  $("education").value = profile.education || "";
  $("languages").value = profile.languages || "";
  $("availability").value = profile.availability || "";
  $("salaryExpectation").value = profile.salaryExpectation || "";
  $("cvText").value = profile.cvText || data.cvText || "";

  const blacklist = data.blacklistedCompanies || [];
  $("blacklistedCompanies").value = blacklist.join("\n");
  updateBlacklistCount(blacklist.length);

  $("mistralApiKey").value = data.mistralApiKey || "";
  $("maxJobsPerSession").value = settings.maxJobsPerSession || 25;
  $("maxNoApplyPages").value = settings.maxConsecutiveNoApplyPages || 20;
  $("delayJobMin").value = settings.delayBetweenJobs?.min || 6000;
  $("delayJobMax").value = settings.delayBetweenJobs?.max || 14000;
  $("delayStepMin").value = settings.delayBetweenSteps?.min || 700;
  $("delayStepMax").value = settings.delayBetweenSteps?.max || 1600;
  $("autoSubmit").checked = settings.autoSubmit !== false;
  $("onlyEasyApply").checked = settings.onlyEasyApply !== false;
}

async function save() {
  const lang = await getUiLang();
  const fullName = $("fullName").value.trim();
  const profile = {
    fullName,
    civility: $("civility").value.trim().toLowerCase(),
    firstName: fullName.split(" ")[0] || "",
    lastName: fullName.split(" ").slice(1).join(" ") || "",
    email: $("email").value.trim(),
    phone: $("phone").value.trim(),
    linkedin: $("linkedin").value.trim(),
    location: $("location").value.trim(),
    postalCode: $("postalCode").value.trim(),
    birthDate: $("birthDate").value.trim(),
    title: $("title").value.trim(),
    experience: $("experience").value.trim(),
    stack: $("stack").value.trim(),
    education: $("education").value.trim(),
    languages: $("languages").value.trim(),
    availability: $("availability").value.trim(),
    salaryExpectation: $("salaryExpectation").value.trim(),
    cvText: $("cvText").value.trim(),
  };

  const blacklistedCompanies = $("blacklistedCompanies").value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  updateBlacklistCount(blacklistedCompanies.length);

  const autoApplySettings = {
    maxJobsPerSession: parseInt($("maxJobsPerSession").value, 10) || 25,
    delayBetweenJobs: {
      min: parseInt($("delayJobMin").value, 10) || 6000,
      max: parseInt($("delayJobMax").value, 10) || 14000,
    },
    delayBetweenSteps: {
      min: parseInt($("delayStepMin").value, 10) || 700,
      max: parseInt($("delayStepMax").value, 10) || 1600,
    },
    autoSubmit: $("autoSubmit").checked,
    onlyEasyApply: $("onlyEasyApply").checked,
    maxConsecutiveNoApplyPages: Math.min(Math.max(parseInt($("maxNoApplyPages").value, 10) || 20, 1), 50),
  };

  const mistralApiKey = $("mistralApiKey").value.trim();
  const uiSettings = { language: $("uiLanguage").value || "auto" };

  await chrome.storage.local.set({
    profile,
    cvText: profile.cvText,
    autoApplySettings,
    blacklistedCompanies,
    uiSettings,
    mistralApiKey: mistralApiKey || undefined,
  });

  $("toast").textContent = t("saved", lang);
  await applyI18n();
  setTimeout(() => { $("toast").textContent = ""; }, 2500);
}

$("saveBtn").addEventListener("click", save);
$("uiLanguage").addEventListener("change", async () => {
  await chrome.storage.local.set({ uiSettings: { language: $("uiLanguage").value } });
  await applyI18n();
});
$("blacklistedCompanies").addEventListener("input", () => {
  updateBlacklistCount($("blacklistedCompanies").value.split("\n").filter((l) => l.trim()).length);
});

load();
