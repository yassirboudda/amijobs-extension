const $ = (id) => document.getElementById(id);

let pendingCvFile = null; // { name, mime, base64, size, savedAt } waiting to save

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

function updateCvStatus(cvFile) {
  const el = $("cvFileStatus");
  if (!el) return;
  if (cvFile?.name) {
    const kb = Math.round((cvFile.size || 0) / 1024);
    el.textContent = `CV enregistré: ${cvFile.name} (${kb} Ko) — prêt pour les uploads sur sites entreprise.`;
    el.style.color = "#059669";
  } else {
    el.textContent =
      "Aucun fichier. Chrome ne peut pas lire un chemin disque : choisissez le fichier ici, AmiJobs en enregistre une copie localement pour les uploads.";
    el.style.color = "";
  }
}

function readFileAsCv(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    if (file.size > 4.5 * 1024 * 1024) {
      reject(new Error("CV trop volumineux (max ~4,5 Mo)"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
      resolve({
        name: file.name,
        mime: file.type || "application/pdf",
        base64,
        size: file.size,
        savedAt: new Date().toISOString(),
      });
    };
    reader.onerror = () => reject(reader.error || new Error("Lecture CV impossible"));
    reader.readAsDataURL(file);
  });
}

async function applyI18n() {
  const lang = await getUiLang();
  document.documentElement.lang = lang;
  document.title = "AmiJobs — " + t("options", lang);
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const text = t(key, lang);
    if (el.tagName === "OPTION") el.textContent = text;
    else if (!el.querySelector("a")) el.textContent = text;
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-ph"), lang);
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
    "cvFile",
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
  updateCvStatus(data.cvFile || null);

  const blacklist = data.blacklistedCompanies || [];
  $("blacklistedCompanies").value = blacklist.join("\n");
  updateBlacklistCount(blacklist.length);

  $("mistralApiKey").value = data.mistralApiKey || "";
  $("maxJobsPerSession").value = settings.maxJobsPerSession || 25;
  $("maxNoApplyPages").value = settings.maxConsecutiveNoApplyPages || 20;
  $("maxApplicationsPerCompany").value = settings.maxApplicationsPerCompany ?? 0;
  $("delayJobMin").value = settings.delayBetweenJobs?.min || 500;
  $("delayJobMax").value = settings.delayBetweenJobs?.max || 500;
  $("delayStepMin").value = settings.delayBetweenSteps?.min || 100;
  $("delayStepMax").value = settings.delayBetweenSteps?.max || 100;
  $("autoSubmit").checked = settings.autoSubmit !== false;
  $("onlyEasyApply").checked = settings.onlyEasyApply !== false;
  $("allowExternalApply").checked = settings.allowExternalApply !== false;
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

  const onlyEasy = $("onlyEasyApply").checked;
  const allowExternal = $("allowExternalApply").checked;
  const autoApplySettings = {
    maxJobsPerSession: Math.min(Math.max(parseInt($("maxJobsPerSession").value, 10) || 25, 1), 10000),
    delayBetweenJobs: {
      min: parseInt($("delayJobMin").value, 10) || 500,
      max: parseInt($("delayJobMax").value, 10) || 500,
    },
    delayBetweenSteps: {
      min: parseInt($("delayStepMin").value, 10) || 100,
      max: parseInt($("delayStepMax").value, 10) || 100,
    },
    autoSubmit: $("autoSubmit").checked,
    onlyEasyApply: onlyEasy,
    allowExternalApply: allowExternal,
    maxConsecutiveNoApplyPages: Math.min(Math.max(parseInt($("maxNoApplyPages").value, 10) || 20, 1), 50),
    maxApplicationsPerCompany: Math.max(parseInt($("maxApplicationsPerCompany").value, 10) || 0, 0),
  };

  const mistralApiKey = $("mistralApiKey").value.trim();
  const uiSettings = { language: $("uiLanguage").value || "auto" };

  const payload = {
    profile,
    cvText: profile.cvText,
    autoApplySettings,
    blacklistedCompanies,
    uiSettings,
    mistralApiKey: mistralApiKey || undefined,
  };
  if (pendingCvFile) {
    payload.cvFile = pendingCvFile;
    updateCvStatus(pendingCvFile);
  }

  await chrome.storage.local.set(payload);

  $("toast").textContent = t("saved", lang);
  await applyI18n();
  setTimeout(() => {
    $("toast").textContent = "";
  }, 2500);
}

$("saveBtn").addEventListener("click", save);
$("uiLanguage").addEventListener("change", async () => {
  await chrome.storage.local.set({ uiSettings: { language: $("uiLanguage").value } });
  await applyI18n();
});
$("blacklistedCompanies").addEventListener("input", () => {
  updateBlacklistCount(
    $("blacklistedCompanies").value.split("\n").filter((l) => l.trim()).length
  );
});

$("cvFileInput")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    pendingCvFile = await readFileAsCv(file);
    updateCvStatus(pendingCvFile);
    await chrome.storage.local.set({ cvFile: pendingCvFile });
    $("toast").textContent = "CV chargé";
    setTimeout(() => {
      $("toast").textContent = "";
    }, 2000);
  } catch (err) {
    pendingCvFile = null;
    $("toast").textContent = err.message || "Erreur CV";
  }
});

$("cvFileClear")?.addEventListener("click", async () => {
  pendingCvFile = null;
  if ($("cvFileInput")) $("cvFileInput").value = "";
  await chrome.storage.local.remove(["cvFile"]);
  updateCvStatus(null);
});

load();
