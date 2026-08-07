// AmiJobs — Generic company-website / ATS auto-apply (v1.3.5)
// Runs on external career sites opened from LinkedIn (or other boards).
(function () {
  if (window.__AmijobsExternalApplyLoaded) return;
  window.__AmijobsExternalApplyLoaded = true;

  const PLATFORM = "external";
  const VERSION = "1.3.5";
  let running = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

  function log(msg, level = "info") {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[AmiJobs external ${ts}] ${msg}`);
    chrome.runtime
      .sendMessage({ action: "addLog", platform: PLATFORM, message: `[${ts}] ${msg}`, level })
      .catch(() => {});
  }

  function isVisible(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function fieldHint(el) {
    const id = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent || "" : "";
    return [
      id,
      el.getAttribute("aria-label") || "",
      el.getAttribute("placeholder") || "",
      el.name || "",
      el.id || "",
      el.closest("label")?.textContent || "",
      el.closest(".field, .form-group, [class*='form'], [class*='Field']")?.querySelector("label")
        ?.textContent || "",
    ]
      .join(" ")
      .toLowerCase();
  }

  async function getCvFile() {
    const { cvFile = null } = await chrome.storage.local.get(["cvFile"]);
    return cvFile;
  }

  async function getProfile() {
    const { profile = {}, cvText = "" } = await chrome.storage.local.get(["profile", "cvText"]);
    return { ...profile, cvText: profile.cvText || cvText };
  }

  async function uploadCv(input) {
    const cv = await getCvFile();
    if (!cv?.base64 || !input) return false;
    try {
      const bin = atob(cv.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], cv.name || "cv.pdf", {
        type: cv.mime || "application/pdf",
        lastModified: Date.now(),
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      log(`CV uploadé: ${file.name}`, "success");
      return true;
    } catch (e) {
      log(`Échec upload CV: ${e.message}`, "error");
      return false;
    }
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function fillTextFields(profile) {
    const fields = [...document.querySelectorAll("input, textarea, select")].filter(isVisible);
    let filled = 0;
    for (const el of fields) {
      const type = (el.getAttribute("type") || el.tagName).toLowerCase();
      if (["hidden", "submit", "button", "image", "reset", "checkbox", "radio"].includes(type)) continue;
      if (type === "file") {
        if (await uploadCv(el)) filled++;
        continue;
      }
      if (el.value && String(el.value).trim()) continue;

      const hint = fieldHint(el);
      let value = "";
      if (/email|mail|courriel/i.test(hint) || type === "email") value = profile.email || "";
      else if (/prénom|first\s*name|firstname/i.test(hint)) value = profile.firstName || profile.fullName?.split(" ")[0] || "";
      else if (/nom|last\s*name|lastname|family/i.test(hint) && !/prénom|first/i.test(hint))
        value = profile.lastName || profile.fullName?.split(" ").slice(1).join(" ") || "";
      else if (/full\s*name|nom complet|name/i.test(hint)) value = profile.fullName || "";
      else if (/téléphone|telephone|phone|mobile|portable/i.test(hint) || type === "tel")
        value = profile.phone || "";
      else if (/ville|city|localisation|location|adresse|address/i.test(hint))
        value = profile.location || profile.city || "Paris";
      else if (/code\s*postal|zip|postal/i.test(hint)) value = profile.postalCode || "75001";
      else if (/linkedin/i.test(hint)) value = profile.linkedin || "";
      else if (/linkedin|github|portfolio|website|url|site/i.test(hint) && type === "url")
        value = profile.linkedin || "";
      else if (/lettre|cover|message|motivation|comment|about|pourquoi/i.test(hint) || el.tagName === "TEXTAREA")
        value =
          profile.coverLetterDefault ||
          `Bonjour,\n\nJe suis ${profile.fullName || "intéressé(e)"} et disponible en freelance. Mon profil correspond à votre besoin.\n\nCordialement,\n${profile.fullName || ""}`;
      else if (el.tagName === "SELECT") {
        const opts = [...el.options].filter((o) => o.value && !/select|choisir|choose|--/i.test(o.text));
        if (opts.length) {
          el.value = opts[0].value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          filled++;
        }
        continue;
      }

      if (value) {
        setNativeValue(el, value);
        filled++;
        await sleep(jitter(120, 280));
      }
    }
    return filled;
  }

  async function checkConsents() {
    let n = 0;
    for (const el of document.querySelectorAll('input[type="checkbox"]')) {
      if (!isVisible(el) || el.checked) continue;
      const hint = fieldHint(el);
      if (/cgu|cgv|privacy|politique|accepte|consent|gdpr|rgpd|terms|condition/i.test(hint) || el.required) {
        el.click();
        n++;
        await sleep(200);
      }
    }
    return n;
  }

  async function clickRecaptcha() {
    try {
      if (typeof window.__AmijobsClickRecaptcha === "function") {
        window.__AmijobsClickRecaptcha();
      }
    } catch (_e) {}
    try {
      await chrome.runtime.sendMessage({ action: "clickRecaptcha" });
    } catch (_e) {}
    for (const frame of document.querySelectorAll('iframe[src*="recaptcha"]')) {
      try {
        frame.click();
        const r = frame.getBoundingClientRect();
        const ev = (type) =>
          frame.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: r.left + 28,
              clientY: r.top + r.height / 2,
              view: window,
              buttons: 1,
            })
          );
        for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) ev(t);
      } catch (_e) {}
    }
    await sleep(1200);
  }

  function findSubmit() {
    const patterns = [
      /envoyer|submit|postuler|apply|candidater|send application|je postule|envoyer ma candidature|submit application|apply now|envoyer le formulaire/i,
    ];
    const blocked = /annuler|cancel|retour|back|login|connexion|sauvegarder|save draft/i;
    let best = null;
    let bestScore = -1;
    for (const el of document.querySelectorAll("button, input[type='submit'], a[role='button']")) {
      if (!isVisible(el) || el.disabled) continue;
      const text = `${el.textContent || ""} ${el.value || ""} ${el.getAttribute("aria-label") || ""}`.trim();
      if (!text || blocked.test(text)) continue;
      if (!patterns.some((p) => p.test(text))) continue;
      let score = 1;
      if (/postuler|apply now|envoyer ma candidature|submit application/i.test(text)) score += 5;
      if (el.tagName === "BUTTON" || el.type === "submit") score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function successDetected() {
    const t = (document.body?.innerText || "").toLowerCase();
    return /merci|thank you|candidature envoyée|application (submitted|received|sent)|nous avons bien reçu|successfully submitted/i.test(
      t
    );
  }

  async function runExternalApply(jobInfo = {}) {
    if (running) return { ok: false, reason: "already_running" };
    running = true;
    log(`External apply v${VERSION} — ${location.href.slice(0, 120)}`);
    try {
      const profile = await getProfile();
      const cv = await getCvFile();
      if (!cv?.base64) log("Aucun fichier CV configuré — upload fichier impossible", "warn");

      await sleep(jitter(800, 1400));
      for (let step = 0; step < 6; step++) {
        if (successDetected()) {
          log("Succès détecté sur la page", "success");
          await chrome.runtime.sendMessage({
            action: "externalApplyResult",
            ok: true,
            reason: "success_page",
            jobInfo,
            url: location.href,
          });
          running = false;
          return { ok: true };
        }

        const filled = await fillTextFields(profile);
        await checkConsents();
        await clickRecaptcha();
        log(`Étape ${step + 1}: ${filled} champs remplis`);

        const btn = findSubmit();
        if (!btn) {
          await sleep(1000);
          continue;
        }
        const label = (btn.textContent || btn.value || "submit").trim().slice(0, 60);
        log(`Clic submit: "${label}"`);
        btn.click();
        await sleep(jitter(1800, 3200));

        if (successDetected()) {
          await chrome.runtime.sendMessage({
            action: "externalApplyResult",
            ok: true,
            reason: "submitted",
            jobInfo,
            url: location.href,
          });
          running = false;
          return { ok: true };
        }
      }

      const maybeOk = successDetected();
      await chrome.runtime.sendMessage({
        action: "externalApplyResult",
        ok: maybeOk,
        reason: maybeOk ? "success_page" : "timeout_or_incomplete",
        jobInfo,
        url: location.href,
      });
      running = false;
      return { ok: maybeOk, reason: maybeOk ? "success_page" : "timeout_or_incomplete" };
    } catch (e) {
      log(`Erreur: ${e.message}`, "error");
      await chrome.runtime.sendMessage({
        action: "externalApplyResult",
        ok: false,
        reason: e.message,
        jobInfo,
        url: location.href,
      });
      running = false;
      return { ok: false, reason: e.message };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.action === "startExternalApply") {
      runExternalApply(msg.jobInfo || {}).then((r) => sendResponse(r));
      return true;
    }
    if (msg.action === "pingExternal") {
      sendResponse({ ok: true, version: VERSION, url: location.href });
      return false;
    }
  });

  // Auto-start when session flag is set for this tab's URL
  (async () => {
    const { sessionExternalApply = null } = await chrome.storage.local.get(["sessionExternalApply"]);
    if (!sessionExternalApply?.active) return;
    const target = sessionExternalApply.url || "";
    if (target && location.href.startsWith(target.split("?")[0].slice(0, 60))) {
      await sleep(1500);
      await runExternalApply(sessionExternalApply.jobInfo || {});
    } else if (sessionExternalApply.active && !/linkedin\.com|indeed\.|glassdoor\.|hellowork\.com/i.test(location.href)) {
      await sleep(2000);
      await runExternalApply(sessionExternalApply.jobInfo || {});
    }
  })();
})();
