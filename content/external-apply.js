// AmiJobs — Generic company-website / ATS auto-apply (v1.4.0)
// Runs on external career sites opened from LinkedIn (or other boards).
(function () {
  if (window.__AmijobsExternalApplyLoaded) return;
  // Never run the apply orchestrator inside reCAPTCHA / blank frames
  const href = String(location.href || "");
  if (/google\.com\/recaptcha|recaptcha\.net|about:blank/i.test(href)) return;
  const isAtsFrame =
    /welcomekit\.co|greenhouse\.io|lever\.co|workable\.com|ashbyhq\.com|bamboohr|jobvite|smartrecruiters|recruitee|personio|teamtailor/i.test(
      location.hostname || ""
    );
  if (window.top !== window && !isAtsFrame) return;

  window.__AmijobsExternalApplyLoaded = true;

  const PLATFORM = "external";
  const VERSION = "1.4.0";
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
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function fieldHint(el) {
    const idLabel = el.id
      ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent || ""
      : "";
    return [
      idLabel,
      el.getAttribute("aria-label") || "",
      el.getAttribute("placeholder") || "",
      el.name || "",
      el.id || "",
      el.closest("label")?.textContent || "",
      el.closest(".field, .form-group, [class*='form'], [class*='Field'], .input")?.querySelector(
        "label"
      )?.textContent || "",
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

  function findEmbeddedAtsUrl() {
    for (const frame of document.querySelectorAll("iframe")) {
      const src = frame.src || "";
      if (
        /welcomekit\.co|greenhouse\.io|lever\.co|workable\.com|ashbyhq\.com|bamboohr\.com|jobvite\.com|smartrecruiters\.com|recruitee\.com|personio\.|teamtailor\.com/i.test(
          src
        )
      ) {
        return src;
      }
    }
    return "";
  }

  async function openApplySurface() {
    // Station F / many ATS: click APPLY NOW to reveal modal/iframe
    const patterns = [
      /apply now|postuler|je postule|candidater|postuler maintenant|apply for this job|soumettre/i,
    ];
    const blocked = /login|connexion|annuler|cancel|see other|autres offres/i;
    for (const el of document.querySelectorAll("a, button")) {
      if (!isVisible(el)) continue;
      const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.trim();
      if (!text || blocked.test(text)) continue;
      if (!patterns.some((p) => p.test(text))) continue;
      if (/btn-job-apply|job-apply|apply/i.test(el.className || "") || patterns[0].test(text)) {
        log(`Clic ouverture formulaire: "${text.slice(0, 40)}"`);
        try {
          el.click();
        } catch (_e) {}
        await sleep(1800);
        break;
      }
    }

    const ats = findEmbeddedAtsUrl();
    if (ats && !location.href.includes(ats.slice(0, 40))) {
      log(`ATS iframe détecté — navigation: ${ats.slice(0, 100)}`);
      // Navigate top page to the real form (iframe fill is flaky cross-origin)
      window.location.href = ats;
      return "navigating";
    }
    return "ready";
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
      else if (/first\s*name|firstname|prénom|prenom/i.test(hint))
        value = profile.firstName || profile.fullName?.split(" ")[0] || "";
      else if (/last\s*name|lastname|nom de famille|family/i.test(hint) || (/lastname|last_name|\[lastname\]/i.test(hint)))
        value = profile.lastName || profile.fullName?.split(" ").slice(1).join(" ") || "";
      else if (/subtitle|current position|poste|title|titre/i.test(hint))
        value = profile.title || "Freelance";
      else if (/full\s*name|nom complet/i.test(hint)) value = profile.fullName || "";
      else if (/téléphone|telephone|phone|mobile|portable/i.test(hint) || type === "tel")
        value = profile.phone || "";
      else if (/zip|postal|code postal/i.test(hint)) value = profile.postalCode || "75001";
      else if (/city|ville/i.test(hint)) value = profile.city || profile.location?.split(",")[0] || "Paris";
      else if (/street|adresse|address/i.test(hint)) value = profile.location || "Paris";
      else if (/linkedin/i.test(hint)) value = profile.linkedin || "";
      else if (/cover|lettre|motivation|message|comment|pourquoi|about/i.test(hint) || el.tagName === "TEXTAREA")
        value =
          profile.coverLetterDefault ||
          `Bonjour,\n\nJe suis ${profile.fullName || "intéressé(e)"}, disponible en freelance, et motivé(e) par cette opportunité.\n\nCordialement,\n${profile.fullName || ""}`;
      else if (el.tagName === "SELECT") {
        const opts = [...el.options];
        const fr =
          opts.find((o) => /france|fr\b/i.test(`${o.text} ${o.value}`)) ||
          opts.find((o) => o.value && !/select|choisir|choose|--|country/i.test(o.text));
        if (fr) {
          el.value = fr.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          filled++;
        }
        continue;
      }

      if (value) {
        setNativeValue(el, value);
        filled++;
        await sleep(jitter(80, 200));
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
        await sleep(150);
      }
    }
    return n;
  }

  async function clickRecaptcha() {
    try {
      if (typeof window.__AmijobsClickRecaptcha === "function") window.__AmijobsClickRecaptcha();
    } catch (_e) {}
    try {
      await chrome.runtime.sendMessage({ action: "clickRecaptcha" });
    } catch (_e) {}
    for (const frame of document.querySelectorAll('iframe[src*="recaptcha"]')) {
      try {
        const r = frame.getBoundingClientRect();
        const o = {
          bubbles: true,
          cancelable: true,
          clientX: r.left + 28,
          clientY: r.top + r.height / 2,
          view: window,
          buttons: 1,
        };
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          frame.dispatchEvent(new MouseEvent(type, o));
        }
        frame.click();
      } catch (_e) {}
    }
    await sleep(1500);
  }

  function findSubmit() {
    const patterns = [
      /envoyer|submit|postuler|apply|candidater|send application|je postule|envoyer ma candidature|submit application|apply now|apply ›|apply >/i,
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
      if (/postuler|apply|envoyer ma candidature|submit/i.test(text)) score += 5;
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
    const u = location.href.toLowerCase();
    if (/welcomekit\.co\/candidates(\?|$)/i.test(u) && !/\/candidates\/new/i.test(u)) return true;
    return /merci|thank you|candidature envoyée|application (submitted|received|sent)|nous avons bien reçu|successfully submitted|application sent|your application has been|candidature a bien été/i.test(
      t
    );
  }

  function hasFormFields() {
    return [...document.querySelectorAll("input, textarea, select")].some(
      (el) => isVisible(el) && !["hidden", "submit", "button"].includes((el.type || "").toLowerCase())
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

      await sleep(jitter(600, 1100));
      const openState = await openApplySurface();
      if (openState === "navigating") {
        // Page will reload into ATS; sessionExternalApply.active keeps auto-start
        running = false;
        return { ok: false, reason: "navigating_to_ats" };
      }

      // Wait for form fields (WelcomeKit etc.)
      for (let w = 0; w < 15 && !hasFormFields(); w++) {
        await openApplySurface();
        await sleep(800);
      }

      for (let step = 0; step < 8; step++) {
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
        await sleep(jitter(2000, 3500));

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
      // If we filled fields + clicked apply, treat as soft success when autoSubmit pages don't confirm
      const softOk = maybeOk || (document.querySelector('input[type="file"]')?.files?.length > 0);
      await chrome.runtime.sendMessage({
        action: "externalApplyResult",
        ok: !!maybeOk,
        reason: maybeOk ? "success_page" : softOk ? "filled_submitted_unconfirmed" : "timeout_or_incomplete",
        jobInfo,
        url: location.href,
      });
      running = false;
      return { ok: !!maybeOk, reason: maybeOk ? "success_page" : "timeout_or_incomplete" };
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

  (async () => {
    const { sessionExternalApply = null } = await chrome.storage.local.get(["sessionExternalApply"]);
    if (!sessionExternalApply?.active || sessionExternalApply?.done) return;
    if (/linkedin\.com|indeed\.|glassdoor\.|hellowork\.com/i.test(location.href)) return;
    await sleep(1500);
    await runExternalApply(sessionExternalApply.jobInfo || {});
  })();
})();
