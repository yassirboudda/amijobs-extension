// ============================================================================
// LinkedIn AutoApply — Content Script v1.8.0
// Handles DOM interactions: form filling, modal navigation, multi-page session.
// v1.8.0: Fix stuck loop — force-close on error, submit retry limit, error toast
//         detection, detailed dev logging, per-job timeout, skip typeahead on
//         non-typeahead fields (phone/email/etc)
// v1.7.x: Fix date fields, location typeahead selection, required checkboxes,
//         use user location from session/profile, skipBlur for typeahead
// v1.6.0: Fix clickJobCard — use URL currentJobId param (no <a> click/navigation)
// v1.5.0: Typeahead handling, button retry
// v1.4.0: Direct storage reads, blacklist, improved button detection
// ============================================================================
(function () {
  if (window.__AmijobsLinkedinLoaded) return;
  window.__AmijobsLinkedinLoaded = true;

  const VERSION = "1.0.0";
  let isRunning = false;
  let shouldStop = false;
  const sessionStats = { applied: 0, skipped: 0, errors: 0 };

  // ── Helpers ───────────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randomDelay = (min, max) => Math.floor(Math.random() * (max - min)) + min;

  function log(msg, level = "info") {
    const prefix = { error: "❌", warn: "⚠️", success: "✅", info: "ℹ️" }[level] || "ℹ️";
    const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
    console.log(`[AmiJobs LinkedIn ${ts}] ${prefix} ${msg}`);
    chrome.runtime.sendMessage({ action: "addLog", platform: "linkedin", message: `[${ts}] ${msg}`, level }).catch(() => {});
  }

  // ── Dev logging: detailed debug output for diagnosing stuck loops ──────
  function devLog(context, msg, data = {}) {
    const ts = new Date().toISOString().slice(11, 23);
    const dataStr = Object.keys(data).length > 0 ? " | " + JSON.stringify(data) : "";
    console.log(`[DEV ${ts}] [${context}] ${msg}${dataStr}`);
  }

  // ── Notification Sound (Web Audio API) ─────────────────────────────────
  function playNotificationSound(type = "stop") {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const gainNode = audioCtx.createGain();
      gainNode.connect(audioCtx.destination);
      gainNode.gain.value = 0.4;

      if (type === "limit") {
        // Urgent triple beep for daily limit
        [0, 400, 800].forEach((delay) => {
          const osc = audioCtx.createOscillator();
          osc.connect(gainNode);
          osc.type = "square";
          osc.frequency.value = 880;
          osc.start(audioCtx.currentTime + delay / 1000);
          osc.stop(audioCtx.currentTime + delay / 1000 + 0.15);
        });
        setTimeout(() => audioCtx.close(), 2000);
      } else if (type === "error") {
        // Double low beep for errors
        [0, 350].forEach((delay) => {
          const osc = audioCtx.createOscillator();
          osc.connect(gainNode);
          osc.type = "sine";
          osc.frequency.value = 440;
          osc.start(audioCtx.currentTime + delay / 1000);
          osc.stop(audioCtx.currentTime + delay / 1000 + 0.2);
        });
        setTimeout(() => audioCtx.close(), 1500);
      } else {
        // Single beep for session end / stop
        const osc = audioCtx.createOscillator();
        osc.connect(gainNode);
        osc.type = "sine";
        osc.frequency.value = 660;
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
        setTimeout(() => audioCtx.close(), 1000);
      }
    } catch (e) {
      console.warn("[AmiJobs LinkedIn] Could not play sound:", e.message);
    }
  }

  // ── Detect LinkedIn Daily Limit Message ────────────────────────────────
  function detectDailyLimit() {
    const limitTexts = [
      "limitons le nombre d'envois quotidiens",
      "limit the number of applications",
      "daily application limit",
      "enregistrez cette offre d'emploi et postulez demain",
      "save this job and apply tomorrow",
      "empêcher les bots",
    ];
    // Check error banners, alerts, inline feedback
    const candidates = [
      ...$$('[role="alert"]'),
      ...$$('.artdeco-inline-feedback'),
      ...$$('.artdeco-inline-feedback--error'),
      ...$$('.artdeco-toast-item'),
    ];
    for (const el of candidates) {
      const text = el.textContent.toLowerCase();
      for (const limitText of limitTexts) {
        if (text.includes(limitText)) {
          return el.textContent.trim().substring(0, 200);
        }
      }
    }
    // Also check entire page body for the message (broader check)
    const bodyText = document.body.textContent.toLowerCase();
    for (const limitText of limitTexts) {
      if (bodyText.includes(limitText)) {
        return limitText;
      }
    }
    return null;
  }

  // ── DOM Helpers ─────────────────────────────────────────────────────────
  function $(selector, root = document) { return root.querySelector(selector); }
  function $$(selector, root = document) { return [...root.querySelectorAll(selector)]; }

  function waitForElement(selector, timeout = 10000, root = document) {
    return new Promise((resolve, reject) => {
      const el = $(selector, root);
      if (el) return resolve(el);
      const observer = new MutationObserver(() => {
        const el = $(selector, root);
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(root === document ? document.body : root, {
        childList: true, subtree: true,
      });
      setTimeout(() => { observer.disconnect(); reject(new Error(`Timeout: ${selector}`)); }, timeout);
    });
  }

  function findByText(tag, texts, root = document) {
    const elements = $$(tag, root);
    for (const el of elements) {
      const elText = el.textContent.trim().toLowerCase();
      for (const text of texts) {
        if (elText.includes(text.toLowerCase())) return el;
      }
    }
    return null;
  }

  async function humanType(element, text, { skipBlur = false } = {}) {
    element.focus();
    element.dispatchEvent(new Event("focus", { bubbles: true }));
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      element.value = "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      element.textContent = "";
    }
    for (const char of text) {
      if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
        element.value += char;
      } else {
        element.textContent += char;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
      await sleep(randomDelay(10, 40));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    // Skip blur for typeahead fields — blur closes the dropdown before we can select
    if (!skipBlur) {
      element.dispatchEvent(new Event("blur", { bubbles: true }));
    }
  }

  function setNativeValue(element, value) {
    const valueSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element), "value"
    )?.set;
    if (valueSetter) { valueSetter.call(element, value); }
    else { element.value = value; }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function humanClick(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(randomDelay(200, 500));
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2 + randomDelay(-2, 2);
    const y = rect.top + rect.height / 2 + randomDelay(-2, 2);
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
    await sleep(randomDelay(50, 150));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
    await sleep(randomDelay(30, 80));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
    element.click();
  }

  // ── Typeahead / Autocomplete Dropdown Handler ──────────────────────────
  async function handleTypeaheadDropdown(inputElement, retries = 3) {
    // Search scope: modal first, then document
    const modal = inputElement.closest('div[role="dialog"], div.artdeco-modal, div.jobs-easy-apply-modal') || document;

    for (let attempt = 1; attempt <= retries; attempt++) {
      // Re-focus input to ensure dropdown stays open (blur may have closed it)
      inputElement.focus();
      inputElement.dispatchEvent(new Event("focus", { bubbles: true }));

      // Small input event to re-trigger typeahead if dropdown closed
      if (attempt > 1) {
        const currentVal = inputElement.value;
        // Remove last char and re-add to trigger new search
        inputElement.value = currentVal.slice(0, -1);
        inputElement.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(200);
        inputElement.value = currentVal;
        inputElement.dispatchEvent(new Event("input", { bubbles: true }));
        log(`[DEBUG] Typeahead: retry ${attempt}/${retries} — re-triggered input`, "info");
      }

      // Wait for typeahead dropdown to appear (LinkedIn debounces input)
      await sleep(800 + attempt * 400);

      const dropdownSelectors = [
        'div[role="listbox"]',
        'ul[role="listbox"]',
        '.basic-typeahead__triggered-content',
        '[id*="typeahead"][role="listbox"]',
        'div.typeahead-results',
        'ul.typeahead-results',
        '[class*="typeahead"] ul',
        '[class*="typeahead"] div[role="option"]',
      ];

      for (const sel of dropdownSelectors) {
        // Search in modal scope first, then document-wide
        const dropdown = modal.querySelector(sel) || document.querySelector(sel);
        if (dropdown && dropdown.offsetParent !== null) {
          const options = [
            ...dropdown.querySelectorAll('[role="option"]'),
            ...dropdown.querySelectorAll('li.basic-typeahead__selectable'),
            ...dropdown.querySelectorAll('li[id*="typeahead"]'),
            ...dropdown.querySelectorAll('div[id*="typeahead-option"]'),
            ...dropdown.querySelectorAll('li'),
          ];
          // Deduplicate and filter visible
          const seen = new Set();
          const uniqueOptions = options.filter(o => {
            if (seen.has(o) || o.offsetParent === null) return false;
            seen.add(o); return true;
          });

          if (uniqueOptions.length > 0) {
            const first = uniqueOptions[0];
            log(`[DEBUG] Typeahead: ${uniqueOptions.length} option(s) — sélection: "${first.textContent.trim().substring(0, 60)}"`, "info");

            // Method 1: mousedown + click (LinkedIn React listens to mousedown)
            first.scrollIntoView({ block: "nearest" });
            await sleep(100);
            first.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
            await sleep(50);
            first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            await sleep(50);
            first.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
            first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            first.click();
            await sleep(600);

            // Verify dropdown closed (selection successful)
            const stillOpen = modal.querySelector(sel) || document.querySelector(sel);
            if (!stillOpen || stillOpen.offsetParent === null || stillOpen.querySelectorAll('[role="option"]').length === 0) {
              log(`[DEBUG] Typeahead: dropdown closed — selection confirmed`, "info");
              return true;
            }

            // Method 2: try ArrowDown + Enter as backup selection
            log(`[DEBUG] Typeahead: click may not have registered — trying ArrowDown+Enter`, "info");
            inputElement.focus();
            inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true }));
            await sleep(150);
            inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
            inputElement.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
            await sleep(600);
            return true;
          }
        }
      }

      // Last attempt: arrow down + Enter as pure keyboard fallback
      if (attempt === retries) {
        log(`[DEBUG] Typeahead: no dropdown found — ArrowDown+Enter fallback`, "info");
        inputElement.focus();
        inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true }));
        await sleep(300);
        inputElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        inputElement.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        await sleep(600);
        // Final fallback: blur to dismiss, then check
        inputElement.dispatchEvent(new Event("blur", { bubbles: true }));
        return false;
      }
    }
    return false;
  }

  // ── LinkedIn Easy Apply Detection ───────────────────────────────────────
  function findEasyApplyButton() {
    const selectors = [
      'button.jobs-apply-button',
      'button[aria-label*="Easy Apply"]',
      'button[aria-label*="Candidature simplifiée"]',
      'button[aria-label*="Postuler"]',
    ];
    for (const sel of selectors) {
      const btn = $(sel);
      if (btn && btn.offsetParent !== null) {
        log(`[DEBUG] Easy Apply trouvé via selector: ${sel}`, "info");
        return btn;
      }
    }
    const buttons = $$("button");
    for (const btn of buttons) {
      const text = btn.textContent.trim().toLowerCase();
      if ((text.includes("easy apply") || text.includes("candidature simplifiée") ||
           text.includes("postuler") || text.includes("postuler facilement")) &&
          btn.offsetParent !== null && !btn.disabled) {
        log(`[DEBUG] Easy Apply trouvé via texte: "${text}"`, "info");
        return btn;
      }
    }
    const spans = $$("span");
    for (const span of spans) {
      const text = span.textContent.trim().toLowerCase();
      if (text === "candidature simplifiée" || text === "easy apply" || text === "postuler") {
        let parent = span.parentElement;
        while (parent && parent.tagName !== "BUTTON" && parent.tagName !== "A") {
          parent = parent.parentElement;
          if (parent === document.body) return span;
        }
        log(`[DEBUG] Easy Apply trouvé via span/parent`, "info");
        return parent || span;
      }
    }
    log("[DEBUG] Easy Apply bouton NON trouvé", "warn");
    return null;
  }

  // ── External Apply Detection ──────────────────────────────────────────
  function findExternalApplyButton() {
    // Look for "Apply on company website" / "Postuler sur le site" buttons/links
    const applyTexts = [
      "postuler sur le site", "apply on company website", "apply on",
      "postuler", "apply now", "apply", "candidater",
    ];
    // These are typically <a> links or buttons that open external sites
    const candidates = [...$$("a"), ...$$("button")];
    for (const el of candidates) {
      if (el.offsetParent === null || el.disabled) continue;
      const text = el.textContent.trim().toLowerCase();
      // Skip Easy Apply buttons
      if (text.includes("easy apply") || text.includes("candidature simplifiée")) continue;
      for (const applyText of applyTexts) {
        if (text.includes(applyText)) {
          const href = el.getAttribute("href") || "";
          // Must be external link or have external intent
          if (href && !href.includes("linkedin.com")) {
            log(`[DEBUG] External apply trouvé: "${text}" → ${href}`, "info");
            return { element: el, url: href };
          }
          // Sometimes the external URL is encoded in onclick/data attributes
          if (el.dataset.applyUrl || el.dataset.externalUrl) {
            return { element: el, url: el.dataset.applyUrl || el.dataset.externalUrl };
          }
          // Button with no href but with "external" context
          if (el.tagName === "BUTTON" && !text.includes("easy")) {
            return { element: el, url: "" };
          }
        }
      }
    }
    return null;
  }

  function getExternalApplyUrl() {
    // Try to find the external apply URL from the job detail pane
    const externalBtn = findExternalApplyButton();
    if (externalBtn?.url) return externalBtn.url;

    // Check for external apply links in the job card
    const applyLinks = $$('a[href*="externalApply"], a[data-tracking-control-name*="external"]');
    for (const link of applyLinks) {
      const href = link.getAttribute("href");
      if (href && !href.includes("linkedin.com")) return href;
    }

    // Check for links with "postuler" text that point externally
    const allLinks = $$("a");
    for (const link of allLinks) {
      const text = link.textContent.trim().toLowerCase();
      const href = link.getAttribute("href") || "";
      if ((text.includes("postuler") || text.includes("apply")) &&
          href && !href.includes("linkedin.com") && href.startsWith("http")) {
        return href;
      }
    }

    return null;
  }

  async function checkBackendAvailable() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: "checkBackend" });
      return resp?.ok === true;
    } catch {
      return false;
    }
  }

  async function sendToBackendPipeline(jobInfo) {
    try {
      const externalUrl = getExternalApplyUrl();
      const resp = await chrome.runtime.sendMessage({
        action: "addToPipeline",
        jobs: {
          urls: [{
            url: externalUrl || jobInfo.url,
            title: jobInfo.title,
            company: jobInfo.company,
            source: "linkedin",
            is_easy_apply: false,
          }],
        },
      });
      return resp?.ok === true;
    } catch (err) {
      log(`[Backend] Erreur pipeline: ${err.message}`, "error");
      return false;
    }
  }

  async function requestExternalApply(jobInfo) {
    const externalUrl = getExternalApplyUrl();
    if (!externalUrl) {
      log(`[External] Pas d'URL externe trouvée pour: ${jobInfo.title}`, "warn");
      return { success: false, reason: "no_external_url" };
    }

    log(`[External] Candidature externe via backend: ${externalUrl}`, "info");
    try {
      const resp = await chrome.runtime.sendMessage({
        action: "requestExternalApply",
        url: externalUrl,
        answers: {},
        job_id: null,
      });
      if (resp?.ok && resp.data?.success) {
        return { success: true };
      }
      return { success: false, reason: resp?.data?.error || "backend_failed" };
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }

  function isModalOpen() {
    const modalSelectors = [
      'div.jobs-easy-apply-content',
      'div.jobs-easy-apply-modal',
      '#artdeco-modal-outlet div[role="dialog"]',
    ];
    for (const sel of modalSelectors) {
      const modal = $(sel);
      if (modal && modal.offsetParent !== null) return modal;
    }
    const interop = $("#interop-outlet");
    if (interop) {
      const dialog = $('div[role="dialog"]', interop) || $('div[class*="modal"]', interop);
      if (dialog) return dialog;
    }
    return null;
  }

  function getCurrentJobInfo() {
    const info = { title: "", company: "", description: "", jobId: "", url: window.location.href };
    const titleSelectors = [
      'h1.t-24', 'h1.job-title', 'h1.jobs-unified-top-card__job-title',
      'h1 a.ember-view', 'h2.t-24', 'h1',
    ];
    for (const sel of titleSelectors) {
      const el = $(sel);
      if (el?.textContent?.trim()) { info.title = el.textContent.trim(); break; }
    }
    const companySelectors = [
      'a.ember-view.t-black.t-normal span',
      '.jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__company-name a',
      'span.jobs-unified-top-card__company-name',
      'a[href*="/company/"]',
    ];
    for (const sel of companySelectors) {
      const el = $(sel);
      if (el?.textContent?.trim()) { info.company = el.textContent.trim(); break; }
    }
    if (!info.company) {
      const companySpans = $$("span");
      for (const span of companySpans) {
        const parent = span.closest("div");
        if (parent && parent.querySelector('a[href*="/company/"]')) {
          info.company = parent.querySelector('a[href*="/company/"]').textContent.trim();
          break;
        }
      }
    }
    const descSelectors = [
      '.jobs-description__content', '.jobs-description-content__text',
      'div#job-details', 'article div.jobs-description',
    ];
    for (const sel of descSelectors) {
      const el = $(sel);
      if (el?.textContent?.trim()) { info.description = el.textContent.trim().substring(0, 1000); break; }
    }
    const jobIdMatch = window.location.href.match(/currentJobId=(\d+)/);
    if (jobIdMatch) info.jobId = jobIdMatch[1];
    if (!info.jobId) {
      const jobIdMatch2 = window.location.href.match(/\/jobs\/view\/(\d+)/);
      if (jobIdMatch2) info.jobId = jobIdMatch2[1];
    }
    return info;
  }

  // ── Modal Form Handling ─────────────────────────────────────────────────
  function getModalFormFields(modal) {
    const fields = [];
    if (!modal) return fields;

    const inputs = $$('input[type="text"], input[type="tel"], input[type="email"], input[type="number"], input[type="url"], input[type="date"], input:not([type])', modal);
    for (const input of inputs) {
      if (input.offsetParent === null || input.disabled) continue;
      if (input.type === "hidden" || input.type === "radio" || input.type === "checkbox") continue;

      let detectedType = input.type || "text";
      if (detectedType === "text" || detectedType === "number") {
        const container = input.closest("div.fb-dash-form-element, div.artdeco-text-input, div");
        const errorText = container ? (container.textContent || "").toLowerCase() : "";
        const labelText = (findLabelForInput(input, modal) || "").toLowerCase();
        // Check HTML attributes that hint at numeric input
        const inputMin = input.getAttribute("min");
        const inputMax = input.getAttribute("max");
        const inputPattern = input.getAttribute("pattern") || "";
        const hasNumericAttr = inputMin !== null || inputMax !== null || /^\d|\\d/.test(inputPattern);
        if (
          hasNumericAttr ||
          errorText.includes("decimal number") ||
          errorText.includes("nombre décimal") ||
          errorText.includes("nombre entier") ||
          errorText.includes("numéro decimal") ||
          errorText.includes("numeric value") ||
          errorText.includes("enter a number") ||
          errorText.includes("supérieur à") ||
          errorText.includes("greater than") ||
          labelText.includes("salaire") ||
          labelText.includes("salary") ||
          labelText.includes("rémunération") ||
          labelText.includes("prétention") ||
          /ann[ée]e|year/i.test(labelText) ||
          /combien.*ann[ée]e/i.test(labelText) ||
          /combien.*temps/i.test(labelText) ||
          /combien.*mois/i.test(labelText) ||
          /dur[ée]e.*contrat/i.test(labelText) ||
          /nombre d[e']/i.test(labelText) ||
          /how many|how long|\bmonths?\b|\byears?\b/i.test(labelText)
        ) {
          detectedType = "number";
          log(`[DEBUG] Champ "${findLabelForInput(input, modal)}" reclassé comme "number"`, "info");
        }
      }

      fields.push({
        element: input, type: detectedType,
        label: findLabelForInput(input, modal),
        value: input.value,
        required: input.required || input.getAttribute("aria-required") === "true",
      });
    }

    for (const ta of $$("textarea", modal)) {
      if (ta.offsetParent === null || ta.disabled) continue;
      fields.push({ element: ta, type: "textarea", label: findLabelForInput(ta, modal),
        value: ta.value, required: ta.required || ta.getAttribute("aria-required") === "true" });
    }

    for (const sel of $$("select", modal)) {
      if (sel.offsetParent === null || sel.disabled) continue;
      const options = [...sel.options].map(o => o.text).filter(t => t && t !== "--" &&
        !t.toLowerCase().includes("sélectionnez") && !t.toLowerCase().includes("select"));
      fields.push({ element: sel, type: "select", label: findLabelForInput(sel, modal),
        value: sel.value, options, required: sel.required || sel.getAttribute("aria-required") === "true" });
    }

    const radioGroups = {};
    for (const radio of $$('input[type="radio"]', modal)) {
      const name = radio.name;
      if (!radioGroups[name]) radioGroups[name] = { elements: [], labels: [] };
      radioGroups[name].elements.push(radio);
      radioGroups[name].labels.push(findLabelForInput(radio, modal));
    }
    for (const [name, group] of Object.entries(radioGroups)) {
      const firstRadio = group.elements[0];
      const fieldset = firstRadio.closest("fieldset");
      const legend = fieldset ? $("legend", fieldset) : null;
      const groupLabel = legend?.textContent?.trim() || findLabelForInput(firstRadio, modal);
      fields.push({ element: group.elements[0], elements: group.elements, type: "radio",
        label: groupLabel, options: group.labels,
        value: group.elements.find(r => r.checked)?.value || "", required: group.elements[0].required });
    }

    for (const cb of $$('input[type="checkbox"]', modal)) {
      if (cb.offsetParent === null || cb.disabled) continue;
      fields.push({ element: cb, type: "checkbox", label: findLabelForInput(cb, modal),
        value: cb.checked, required: cb.required });
    }

    for (const trigger of $$('button[role="combobox"], button[data-test-text-selectable-option]', modal)) {
      fields.push({ element: trigger, type: "dropdown-button",
        label: findLabelForInput(trigger, modal), value: trigger.textContent.trim(),
        required: trigger.getAttribute("aria-required") === "true" });
    }

    return fields;
  }

  function findLabelForInput(input, root) {
    if (input.id) {
      const label = $(`label[for="${input.id}"]`, root);
      if (label) return label.textContent.trim();
    }
    const parentLabel = input.closest("label");
    if (parentLabel) return parentLabel.textContent.trim();
    if (input.getAttribute("aria-label")) return input.getAttribute("aria-label").trim();
    const labelledBy = input.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent.trim();
    }
    if (input.placeholder) return input.placeholder.trim();
    const prevSibling = input.previousElementSibling;
    if (prevSibling && (prevSibling.tagName === "LABEL" || prevSibling.tagName === "SPAN")) {
      return prevSibling.textContent.trim();
    }
    const container = input.closest("div");
    if (container) {
      const label = $("label, span.t-14, span.t-bold", container);
      if (label && label !== input) return label.textContent.trim();
    }
    return input.name || input.id || "Unknown field";
  }

  // ── Date Detection (for date availability / start date fields) ──────────
  function isDateQuestion(label) {
    return /date|disponib|start\s*date|début|quand.*commencer|when.*start|estimée/i.test(label);
  }

  function getAvailabilityDate() {
    // Return a date ~7 days from now in YYYY-MM-DD and DD/MM/YYYY formats
    const d = new Date();
    d.setDate(d.getDate() + 7);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return { iso: `${yyyy}-${mm}-${dd}`, fr: `${dd}/${mm}/${yyyy}`, short: `${dd}/${mm}/${yyyy}` };
  }

  // ── Phone field detection ──────────────────────────────────────────────────
  function isPhoneField(label) {
    return /phone|téléphone|telephone|mobile|cell|numéro.*tél|tel\b|phone.*number|numero.*telephone/i.test(label);
  }

  // ── Get user phone from profile ──────────────────────────────────────────
  async function getUserPhone() {
    try {
      const data = await chrome.storage.local.get(["profile"]);
      return data.profile?.phone || null;
    } catch {
      return null;
    }
  }

  // ── Location field detection ─────────────────────────────────────────────
  function isLocationField(label) {
    return /location|city|ville|lieu|localisation|adresse|région|region|where/i.test(label);
  }

  // ── Get user location from session search location or profile ────────────
  async function getUserLocation() {
    try {
      const data = await chrome.storage.local.get(["session", "profile"]);
      // Prefer session search location (the city user is job-searching in)
      const sessionLoc = data.session?.location || "";
      const profileLoc = data.profile?.location || "";
      // Use session location first (more specific, e.g. "Paris"), fallback to profile
      const raw = sessionLoc || profileLoc;
      if (!raw) return null;
      // Strip country suffix: "Paris, France" → "Paris", "Lyon, Auvergne-Rhône-Alpes, France" → "Lyon"
      const city = raw.split(",")[0].trim();
      log(`[DEBUG] getUserLocation: session="${sessionLoc}", profile="${profileLoc}" → city="${city}"`, "info");
      return city;
    } catch (err) {
      log(`[DEBUG] getUserLocation error: ${err.message}`, "warn");
      return null;
    }
  }

  // ── Fill a Single Form Field ────────────────────────────────────────────
  async function fillField(field, jobInfo) {
    // ── Phone override: always use profile phone if configured ──
    if ((field.type === "tel" || isPhoneField(field.label)) && field.value) {
      const profilePhone = await getUserPhone();
      if (profilePhone && profilePhone !== field.value) {
        log(`📱 Remplacement du numéro LinkedIn "${field.value}" par le numéro du profil "${profilePhone}"`, "info");
        const el = field.element;
        el.focus();
        setNativeValue(el, profilePhone);
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        log(`OK "${field.label}" = "${profilePhone}" (phone override)`, "success");
        return;
      }
    }

    if (field.value && field.type !== "select" && field.type !== "radio" && field.type !== "checkbox") {
      log(`Champ "${field.label}" déjà rempli: "${String(field.value).substring(0, 50)}"`, "info");
      return;
    }
    if (field.type === "select" && field.value && field.value !== "" && field.element.selectedIndex > 0) {
      log(`Select "${field.label}" déjà sélectionné`, "info");
      return;
    }
    log(`Remplissage: "${field.label}" (${field.type})`);

    try {
      // ── Special handling: date input fields ──
      if (field.element.type === "date" || (field.type === "text" && isDateQuestion(field.label))) {
        const dates = getAvailabilityDate();
        const el = field.element;
        if (el.type === "date") {
          // HTML5 date input: use ISO format
          setNativeValue(el, dates.iso);
          log(`OK "${field.label}" = "${dates.iso}" (date input)`, "success");
        } else {
          // Text field expecting a date: try DD/MM/YYYY
          await humanType(el, dates.fr);
          await sleep(300);
          // If there's a validation error, try ISO format
          const container = el.closest("div");
          const hasError = container && container.querySelector('[class*="error"], [class*="invalid"], [role="alert"]');
          if (hasError) {
            log(`[DEBUG] Date format DD/MM/YYYY rejected, trying YYYY-MM-DD`, "info");
            el.value = "";
            el.dispatchEvent(new Event("input", { bubbles: true }));
            await humanType(el, dates.iso);
          }
          log(`OK "${field.label}" = "${dates.fr}" (date text)`, "success");
        }
        return;
      }

      // ── Special handling: phone fields — use profile phone, bypass AI ──
      if ((field.type === "tel" || isPhoneField(field.label)) && !field.value) {
        const profilePhone = await getUserPhone();
        if (profilePhone) {
          const el = field.element;
          el.focus();
          setNativeValue(el, profilePhone);
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          log(`OK "${field.label}" = "${profilePhone}" (phone from profile)`, "success");
          return;
        }
      }

      // ── Special handling: location/city fields — bypass AI, use session/profile location ──
      if ((field.type === "text" || field.type === "textarea") && isLocationField(field.label)) {
        const userCity = await getUserLocation();
        if (userCity) {
          log(`[DEBUG] Location field "${field.label}" → using user location: "${userCity}"`, "info");
          // skipBlur: true — keep dropdown open for typeahead selection
          await humanType(field.element, userCity, { skipBlur: true });
          const typeaheadOk = await handleTypeaheadDropdown(field.element);
          if (!typeaheadOk) {
            log(`[DEBUG] Location typeahead failed for "${userCity}" — retry with shorter text`, "info");
            field.element.value = "";
            field.element.dispatchEvent(new Event("input", { bubbles: true }));
            await sleep(500);
            const shortQuery = userCity.substring(0, Math.min(userCity.length, 5));
            await humanType(field.element, shortQuery, { skipBlur: true });
            await handleTypeaheadDropdown(field.element, 4);
          }
          // Now blur after typeahead is done
          field.element.dispatchEvent(new Event("blur", { bubbles: true }));
          return;
        }
        // Fallback to AI if no stored location
        log(`[DEBUG] No stored location found, falling back to AI for "${field.label}"`, "info");
      }

      const response = await chrome.runtime.sendMessage({
        action: "generateAnswer", question: field.label,
        fieldType: field.type, options: field.options || [], jobInfo,
      });
      let answer = response?.answer;
      if (!answer) { log(`Pas de réponse pour "${field.label}"`, "warn"); return; }

      if (field.type === "number") {
        const cleaned = answer.replace(/[\s\u00a0€$,]/g, "");
        const numMatch = cleaned.match(/\d+/);
        answer = numMatch ? numMatch[0] : "10";
        log(`[DEBUG] Champ numérique "${field.label}" => ${answer}`, "info");
      }

      // For location/city fields that fell through (no stored location), strip country suffix from AI answer
      if ((field.type === "text" || field.type === "textarea") && isLocationField(field.label)) {
        answer = answer.split(",")[0].trim();
        log(`[DEBUG] Location field AI answer → shortened to: "${answer}"`, "info");
      }

      await sleep(randomDelay(300, 800));

      switch (field.type) {
        case "number": {
          const el = field.element;
          el.focus();
          el.dispatchEvent(new Event("focus", { bubbles: true }));
          setNativeValue(el, answer);
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          break;
        }
        case "text": case "tel": case "email": case "url":
        case "textarea": {
          // Only run typeahead for location-type fields — skip for phone/email/etc
          const needsTypeahead = isLocationField(field.label);
          await humanType(field.element, answer, { skipBlur: needsTypeahead });
          if (needsTypeahead) {
            devLog("fillField", "Running typeahead for location field", { label: field.label });
            const typeaheadOk = await handleTypeaheadDropdown(field.element);
            if (!typeaheadOk) {
              log(`[DEBUG] Location typeahead failed (AI fallback) — retry with shorter text`, "info");
              field.element.value = "";
              field.element.dispatchEvent(new Event("input", { bubbles: true }));
              await sleep(500);
              const shortQuery = answer.substring(0, Math.min(answer.length, 5));
              await humanType(field.element, shortQuery, { skipBlur: true });
              await handleTypeaheadDropdown(field.element, 4);
            }
            field.element.dispatchEvent(new Event("blur", { bubbles: true }));
          }
          break;
        }
        case "select": {
          const options = [...field.element.options];
          let idx = options.findIndex(o => o.text.toLowerCase().trim() === answer.toLowerCase().trim());
          if (idx < 0) idx = options.findIndex(o =>
            o.text.toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes(o.text.toLowerCase()));
          if (idx < 0) idx = Math.min(1, options.length - 1);
          field.element.selectedIndex = idx;
          field.element.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
        case "radio": {
          if (field.elements) {
            let target = null;
            for (let i = 0; i < field.elements.length; i++) {
              const lbl = field.options[i]?.toLowerCase().trim();
              if (lbl === answer.toLowerCase().trim() || lbl?.includes(answer.toLowerCase())) {
                target = field.elements[i]; break;
              }
            }
            if (!target) target = field.elements.find((r, i) => {
              const lbl = field.options[i]?.toLowerCase();
              return lbl?.includes("oui") || lbl?.includes("yes");
            }) || field.elements[0];
            if (target) await humanClick(target);
          }
          break;
        }
        case "checkbox": {
          // v1.7.0: Required checkboxes (terms, proceed, accept) are always checked
          const lbl = (field.label || "").toLowerCase();
          const isRequired = field.required || field.element.required ||
            field.element.getAttribute("aria-required") === "true";
          const isMandatoryContext = /proceed|accept|terms|conditions|agree|certif|confirm|j'accepte|j'atteste|j'autorise|engagement|consent/i.test(lbl);
          const shouldCheck = isRequired || isMandatoryContext || /oui|yes|true|1|accept|j'accepte/i.test(answer);
          if (shouldCheck && !field.element.checked) {
            await humanClick(field.element);
            // Verify it got checked; if not, try direct property set
            if (!field.element.checked) {
              field.element.checked = true;
              field.element.dispatchEvent(new Event("change", { bubbles: true }));
              field.element.dispatchEvent(new Event("input", { bubbles: true }));
              log(`[DEBUG] Checkbox force-checked via property`, "info");
            }
          }
          break;
        }
        case "dropdown-button": {
          await humanClick(field.element);
          await sleep(randomDelay(500, 1000));
          const listbox = $('ul[role="listbox"], div[role="listbox"]');
          if (listbox) {
            const optionEls = $$('li[role="option"], div[role="option"]', listbox);
            const targetOpt = optionEls.find(o =>
              o.textContent.toLowerCase().trim().includes(answer.toLowerCase())) || optionEls[0];
            if (targetOpt) await humanClick(targetOpt);
          }
          break;
        }
      }
      log(`OK "${field.label}" = "${answer}"`, "success");
    } catch (err) {
      log(`Erreur remplissage "${field.label}": ${err.message}`, "error");
    }
  }

  // ── Modal Navigation (IMPROVED v1.4.0: wider button search) ────────────
  function findNextButton(modal) {
    if (!modal) return null;

    const submitTexts = [
      "envoyer la candidature", "submit application",
      "soumettre la candidature", "soumettre",
      "envoyer", "submit",
      "postuler", "apply",
      "vérifier et envoyer", "review and submit",
    ];
    const nextTexts = [
      "suivant", "next",
      "continuer", "continue",
      "réviser", "review",
      "vérifier", "verify",
      "confirmer", "confirm",
      "passer en revue",
    ];

    // Search in modal first, then in parent dialog containers
    const searchRoots = [modal];
    // Also search in wider dialog scope (parent dialog if modal is inner content)
    const parentDialog = modal.closest('div[role="dialog"]');
    if (parentDialog && parentDialog !== modal) {
      searchRoots.push(parentDialog);
    }
    // Also try the artdeco modal outlet
    const artdecoOutlet = document.getElementById("artdeco-modal-outlet");
    if (artdecoOutlet && !searchRoots.includes(artdecoOutlet)) {
      searchRoots.push(artdecoOutlet);
    }

    for (const searchRoot of searchRoots) {
      const allButtons = $$("button", searchRoot);

      if (searchRoot === searchRoots[0]) {
        log(`[DEBUG] findNextButton: ${allButtons.length} boutons dans le modal`, "info");
        const btnTexts = allButtons.map(b => `"${b.textContent.trim().substring(0, 50)}"${b.disabled ? " [disabled]" : ""}`);
        log(`[DEBUG] Boutons: ${btnTexts.join(", ")}`, "info");
      }

      // Check submit buttons first
      for (const btn of allButtons) {
        const text = btn.textContent.trim().toLowerCase();
        if (submitTexts.some(t => text.includes(t)) && !btn.disabled) {
          log(`[DEBUG] Bouton SUBMIT trouvé: "${btn.textContent.trim()}" (root: ${searchRoot === modal ? "modal" : "parent"})`, "info");
          return { button: btn, isSubmit: true };
        }
      }
      // Check next buttons
      for (const btn of allButtons) {
        const text = btn.textContent.trim().toLowerCase();
        if (nextTexts.some(t => text.includes(t)) && !btn.disabled) {
          log(`[DEBUG] Bouton NEXT trouvé: "${btn.textContent.trim()}" (root: ${searchRoot === modal ? "modal" : "parent"})`, "info");
          return { button: btn, isSubmit: false };
        }
      }
      // Check spans inside buttons
      for (const span of $$("span", searchRoot)) {
        const text = span.textContent.trim().toLowerCase();
        if (submitTexts.some(t => text.includes(t))) {
          const btn = span.closest("button, a");
          if (btn && !btn.disabled) {
            log(`[DEBUG] Bouton SUBMIT (span): "${span.textContent.trim()}"`, "info");
            return { button: btn, isSubmit: true };
          }
        }
      }
      for (const span of $$("span", searchRoot)) {
        const text = span.textContent.trim().toLowerCase();
        if (nextTexts.some(t => text.includes(t))) {
          const btn = span.closest("button, a");
          if (btn && !btn.disabled) {
            log(`[DEBUG] Bouton NEXT (span): "${span.textContent.trim()}"`, "info");
            return { button: btn, isSubmit: false };
          }
        }
      }
      // Check aria-label
      for (const btn of allButtons) {
        if (btn.disabled) continue;
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (submitTexts.some(t => aria.includes(t))) {
          log(`[DEBUG] Bouton SUBMIT (aria): "${aria}"`, "info");
          return { button: btn, isSubmit: true };
        }
        if (nextTexts.some(t => aria.includes(t))) {
          log(`[DEBUG] Bouton NEXT (aria): "${aria}"`, "info");
          return { button: btn, isSubmit: false };
        }
      }
    }

    // FALLBACK: look for primary-colored/styled buttons in modal footer
    const footer = $('footer, div[class*="footer"], div[class*="action"]', modal);
    if (footer) {
      const footerBtns = $$("button", footer).filter(b => !b.disabled);
      if (footerBtns.length > 0) {
        const primary = footerBtns[footerBtns.length - 1];
        log(`[DEBUG] Bouton FALLBACK footer: "${primary.textContent.trim()}"`, "info");
        const text = primary.textContent.trim().toLowerCase();
        const isSubmit = submitTexts.some(t => text.includes(t)) ||
                         text.includes("envoyer") || text.includes("submit");
        return { button: primary, isSubmit };
      }
    }

    // LAST RESORT: search ENTIRE document for dialog footer buttons
    const globalDialog = document.querySelector('div[role="dialog"]');
    if (globalDialog) {
      const globalFooter = $('footer, div[class*="footer"]', globalDialog);
      if (globalFooter) {
        const gBtns = $$("button", globalFooter).filter(b => !b.disabled);
        if (gBtns.length > 0) {
          const btn = gBtns[gBtns.length - 1];
          log(`[DEBUG] Bouton GLOBAL FALLBACK: "${btn.textContent.trim()}"`, "info");
          const text = btn.textContent.trim().toLowerCase();
          const isSubmit = submitTexts.some(t => text.includes(t));
          return { button: btn, isSubmit };
        }
      }
    }

    log("[DEBUG] AUCUN bouton Next/Submit trouvé!", "error");
    return null;
  }

  function findDismissButton(modal) {
    if (!modal) return null;
    const selectors = [
      'button[aria-label*="Dismiss"]', 'button[aria-label*="Fermer"]',
      'button[aria-label*="Close"]', 'button[data-test-modal-close-btn]',
      'button.artdeco-modal__dismiss',
    ];
    for (const sel of selectors) {
      const btn = $(sel, modal) || $(sel);
      if (btn) return btn;
    }
    for (const btn of $$("button", modal)) {
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (aria.includes("dismiss") || aria.includes("fermer") || aria.includes("close")) return btn;
      const svg = $("svg", btn);
      if (svg && btn.children.length === 1 && !btn.textContent.trim()) return btn;
    }
    return null;
  }

  function detectModalStatus(modal) {
    if (!modal) return "unknown";
    const text = modal.textContent.toLowerCase();
    if (text.includes("already applied") || text.includes("déjà postulé") || text.includes("candidature déjà envoyée")) return "already_applied";
    if (text.includes("application submitted") || text.includes("candidature envoyée") || text.includes("your application was sent")) return "success";
    // Only match fatal/system errors, NOT form validation messages
    const fatalErrorPatterns = [
      "something went wrong",
      "une erreur est survenue",
      "an error occurred",
      "unexpected error",
      "erreur inattendue",
      "try again later",
      "réessayez plus tard",
    ];
    for (const pattern of fatalErrorPatterns) {
      if (text.includes(pattern)) return "error";
    }
    return "in_progress";
  }

  // ── Dismiss any visible LinkedIn toasts ──────────────────────────────
  function dismissVisibleToasts() {
    const toasts = $$('.artdeco-toast-item');
    for (const toast of toasts) {
      if (toast.offsetParent === null) continue;
      const closeBtn = toast.querySelector('button.artdeco-toast-item__dismiss, button[data-test-artdeco-toast-close-btn], button.artdeco-dismiss');
      if (closeBtn) {
        closeBtn.click();
        devLog("dismissVisibleToasts", "Dismissed toast", { text: toast.textContent.substring(0, 80) });
      }
    }
  }

  // ── Detect LinkedIn error toasts/banners OUTSIDE the modal ──────────────
  function detectPageError() {
    // Only match actual toast containers — NOT alerts, inline feedback, or badges
    const toastSelectors = [
      '.artdeco-toast-item--error',
      'div.artdeco-toast-item',
    ];
    const modal = isModalOpen();
    for (const sel of toastSelectors) {
      for (const el of $$(sel)) {
        // Skip invisible elements
        if (el.offsetParent === null) continue;
        // Skip elements inside the Easy Apply modal
        if (modal && modal.contains(el)) continue;
        const text = el.textContent.toLowerCase();
        if (text.includes("erreur") || text.includes("error") ||
            text.includes("something went wrong") || text.includes("une erreur") ||
            text.includes("impossible") || text.includes("failed") ||
            text.includes("réessayer") || text.includes("try again")) {
          devLog("detectPageError", "Error toast found", { text: text.substring(0, 100) });
          return text.substring(0, 120);
        }
      }
    }
    return null;
  }

  // ── Detect validation errors inside the modal ──────────────────────────
  function detectValidationErrors(modal) {
    if (!modal) return [];
    const errors = [];
    const errorSelectors = [
      '[class*="error"]',
      '[class*="invalid"]',
      '[role="alert"]',
      '.artdeco-inline-feedback--error',
      '.fb-dash-form-element__error-field',
    ];
    for (const sel of errorSelectors) {
      for (const el of $$(sel, modal)) {
        const text = el.textContent.trim();
        if (text && text.length > 2 && text.length < 200) {
          errors.push(text);
        }
      }
    }
    return [...new Set(errors)]; // deduplicate
  }

  // ── Force close the modal and discard dialog ───────────────────────────
  async function forceCloseModal(reason = "unknown") {
    log(`[FORCE-CLOSE] Fermeture forcée du modal — raison: ${reason}`, "warn");
    devLog("forceCloseModal", "Attempting force close", { reason });

    // Try 1: dismiss button inside modal
    let modal = isModalOpen();
    if (modal) {
      const dismissBtn = findDismissButton(modal);
      if (dismissBtn) {
        devLog("forceCloseModal", "Found dismiss button, clicking");
        await humanClick(dismissBtn);
        await sleep(800);
      }
    }

    // Handle the "discard your application?" confirmation dialog
    await handleDiscardDialog();
    await sleep(500);

    // Try 2: if still open, try broader search
    modal = isModalOpen();
    if (modal) {
      devLog("forceCloseModal", "Modal still open after dismiss — trying Escape key");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      await sleep(500);
      await handleDiscardDialog();
      await sleep(500);
    }

    // Try 3: if STILL open, click any close/dismiss/X button anywhere
    modal = isModalOpen();
    if (modal) {
      devLog("forceCloseModal", "Modal STILL open — trying all close buttons");
      const allButtons = $$("button");
      for (const btn of allButtons) {
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        const text = btn.textContent.trim().toLowerCase();
        if (aria.includes("dismiss") || aria.includes("fermer") || aria.includes("close") ||
            text === "×" || text === "x") {
          btn.click();
          await sleep(500);
          await handleDiscardDialog();
          break;
        }
      }
    }

    // Final check
    modal = isModalOpen();
    if (modal) {
      devLog("forceCloseModal", "WARNING: Modal still open after all attempts!");
      log(`[FORCE-CLOSE] Modal toujours ouvert malgré 3 tentatives!`, "error");
    } else {
      devLog("forceCloseModal", "Modal closed successfully");
    }
  }

  async function handleDiscardDialog() {
    await sleep(500);
    const discardBtn = findByText("button", ["discard", "annuler", "ignorer", "supprimer", "oui, annuler"]);
    if (discardBtn) {
      log("[DEBUG] Clic sur bouton discard/annuler", "info");
      await humanClick(discardBtn);
      await sleep(500);
    }
  }

  function stepFieldsHash(fields) {
    return fields.map(f => f.label).sort().join("|");
  }

  // ── Blacklist Check ─────────────────────────────────────────────────────
  async function isCompanyBlacklisted(companyName) {
    if (!companyName) return false;
    try {
      const { blacklistedCompanies = [] } = await chrome.storage.local.get(["blacklistedCompanies"]);
      if (blacklistedCompanies.length === 0) return false;
      const companyLower = companyName.toLowerCase().trim();
      for (const blocked of blacklistedCompanies) {
        const blockedLower = blocked.toLowerCase().trim();
        if (!blockedLower) continue;
        // Partial match: "capgemini" matches "Capgemini Engineering"
        if (companyLower.includes(blockedLower) || blockedLower.includes(companyLower)) {
          log(`🚫 Entreprise blacklistée: "${companyName}" (match: "${blocked}")`, "warn");
          return true;
        }
      }
    } catch (err) {
      log(`[DEBUG] Erreur vérif blacklist: ${err.message}`, "warn");
    }
    return false;
  }

  // ── Main Apply Flow ─────────────────────────────────────────────────────
  async function applyToCurrentJob(settings) {
    const jobInfo = getCurrentJobInfo();
    const applyStartTime = Date.now();
    const JOB_TIMEOUT_MS = 120000; // 2 min max per job application
    const MAX_SUBMIT_RETRIES = 2;
    let submitAttempts = 0;

    log(`Candidature: ${jobInfo.title} @ ${jobInfo.company}`);
    devLog("applyToCurrentJob", "START", { title: jobInfo.title, company: jobInfo.company, jobId: jobInfo.jobId });

    const easyApplyBtn = findEasyApplyButton();
    if (!easyApplyBtn) {
      log("Bouton Easy Apply non trouvé", "warn");
      devLog("applyToCurrentJob", "No Easy Apply button found");
      return { success: false, reason: "no_easy_apply_button" };
    }

    // Dismiss any stale toasts before opening the modal
    dismissVisibleToasts();

    await humanClick(easyApplyBtn);
    await sleep(randomDelay(2000, 3500));

    let modal = isModalOpen();
    // Retry opening modal up to 4 times with increasing delays. After a LinkedIn
    // SPA navigation the right panel can still be rendering, so we re-query the
    // button fresh each time and wait longer between attempts.
    if (!modal) {
      for (let attempt = 1; attempt <= 4 && !modal; attempt++) {
        log(`[RETRY] Modal non ouvert — tentative ${attempt}/4...`, "warn");
        await sleep(1800 * attempt);
        // Re-find the button (may have been re-rendered by LinkedIn SPA)
        const retryBtn = findEasyApplyButton();
        if (retryBtn) {
          retryBtn.scrollIntoView({ behavior: "smooth", block: "center" });
          await sleep(600);
          await humanClick(retryBtn);
          await sleep(randomDelay(2500, 4000));
        }
        modal = isModalOpen();
      }
    }
    if (!modal) {
      log("Modal Easy Apply ne s'ouvre pas après 4 tentatives", "error");
      return { success: false, reason: "modal_not_opened" };
    }

    const maxSteps = 12;
    let step = 0;
    let lastFieldsHash = "";
    let stuckCount = 0;

    while (step < maxSteps && !shouldStop) {
      step++;

      // ── Per-job timeout check ──
      const elapsed = Date.now() - applyStartTime;
      if (elapsed > JOB_TIMEOUT_MS) {
        log(`⏰ Timeout (${Math.round(elapsed / 1000)}s) — abandon et passage au suivant`, "error");
        devLog("applyToCurrentJob", "TIMEOUT", { elapsed, step, submitAttempts });
        await forceCloseModal("timeout");
        return { success: false, reason: "timeout" };
      }

      // ── Check for LinkedIn daily limit ──
      const dailyLimitMsg = detectDailyLimit();
      if (dailyLimitMsg) {
        log(`🚫 LIMITE QUOTIDIENNE DÉTECTÉE: "${dailyLimitMsg}"`, "error");
        devLog("applyToCurrentJob", "DAILY LIMIT DETECTED", { msg: dailyLimitMsg });
        await forceCloseModal("daily_limit");
        playNotificationSound("limit");
        return { success: false, reason: "daily_limit" };
      }

      log(`Étape ${step}/${maxSteps} (${Math.round(elapsed / 1000)}s)...`);
      devLog("applyToCurrentJob", `Step ${step}`, { elapsed, stuckCount, submitAttempts });

      // ── Check for page-level error toasts (outside modal) ──
      const pageError = detectPageError();
      if (pageError) {
        log(`[ERROR-TOAST] Erreur LinkedIn détectée: "${pageError}" — tentative de dismiss...`, "warn");
        devLog("applyToCurrentJob", "Page error toast detected — trying to dismiss", { pageError });
        dismissVisibleToasts();
        await sleep(1500);
        // Re-check after dismissal
        const pageErrorRetry = detectPageError();
        if (pageErrorRetry) {
          log(`[ERROR-TOAST] Erreur persistante après dismiss: "${pageErrorRetry}"`, "error");
          devLog("applyToCurrentJob", "Page error toast persists after dismiss", { pageErrorRetry });
          await forceCloseModal("page_error_toast");
          return { success: false, reason: "linkedin_error_toast" };
        }
        log("[ERROR-TOAST] Toast dismissed — on continue", "info");
      }

      const status = detectModalStatus(modal);
      devLog("applyToCurrentJob", `Modal status: ${status}`, { step });

      if (status === "already_applied") {
        log("Déjà postulé à ce poste", "warn");
        await forceCloseModal("already_applied");
        return { success: false, reason: "already_applied" };
      }
      if (status === "success") {
        log("Candidature envoyée avec succès!", "success");
        const dismissBtn = findDismissButton(modal) || findByText("button", ["fermer", "close", "done", "terminé"], modal);
        if (dismissBtn) { await sleep(500); await humanClick(dismissBtn); }
        return { success: true };
      }
      if (status === "error") {
        log("Erreur détectée dans le modal — abandon", "error");
        devLog("applyToCurrentJob", "Modal error status detected");
        await forceCloseModal("modal_error_status");
        return { success: false, reason: "modal_error" };
      }

      // ── Check validation errors in modal ──
      const validationErrors = detectValidationErrors(modal);
      if (validationErrors.length > 0) {
        devLog("applyToCurrentJob", "Validation errors found", { errors: validationErrors });
        for (const err of validationErrors) {
          log(`[VALIDATION] ${err}`, "warn");
        }
      }

      const fields = getModalFormFields(modal);
      const currentHash = stepFieldsHash(fields);
      log(`${fields.length} champ(s) à l'étape ${step} (hash: ${currentHash.substring(0, 40)})`, "info");

      if (currentHash === lastFieldsHash && currentHash !== "") {
        stuckCount++;
        log(`[STUCK] Même étape détectée ${stuckCount} fois`, "warn");
        devLog("applyToCurrentJob", `Stuck count: ${stuckCount}`, { hash: currentHash.substring(0, 40) });
        if (stuckCount >= 3) {
          log("Bloqué 3x sur même étape — fermeture et passage au suivant", "error");
          devLog("applyToCurrentJob", "STUCK — force closing", { stuckCount, validationErrors });
          await forceCloseModal("stuck_on_step");
          return { success: false, reason: "stuck_on_step" };
        }
        // On retry, try re-filling fields that may have been missed
        if (stuckCount === 2) {
          log("[STUCK] Tentative de re-remplissage des champs...", "info");
        }
      } else {
        stuckCount = 0;
      }
      lastFieldsHash = currentHash;

      for (const field of fields) {
        if (shouldStop) break;
        await fillField(field, jobInfo);
        await sleep(randomDelay(settings.delayBetweenSteps?.min || 1000, settings.delayBetweenSteps?.max || 3000));
      }

      await sleep(randomDelay(1000, 2000));

      // ── Check for validation errors AFTER filling fields ──
      const postFillErrors = detectValidationErrors(modal);
      if (postFillErrors.length > 0) {
        log(`[VALIDATION] ${postFillErrors.length} erreur(s) après remplissage`, "warn");
        devLog("applyToCurrentJob", "Post-fill validation errors", { errors: postFillErrors });

        // ── Auto-fix numeric validation errors ──
        const numericErrorPatterns = /num[ée]ro decimal|decimal number|nombre (d[ée]cimal|entier)|numeric value|enter a number|sup[ée]rieur [àa]|greater than/i;
        const hasNumericError = postFillErrors.some(e => numericErrorPatterns.test(e));
        if (hasNumericError) {
          log("[VALIDATION-FIX] Erreur numérique détectée — tentative de correction", "info");
          const errorContainers = $$('[class*="error"], .artdeco-inline-feedback--error, .fb-dash-form-element__error-field', modal);
          for (const errEl of errorContainers) {
            const errText = errEl.textContent.trim().toLowerCase();
            if (!numericErrorPatterns.test(errText)) continue;
            // Walk up to find the parent form element, then find the input
            const formGroup = errEl.closest("div.fb-dash-form-element, div.artdeco-text-input--container, div.jobs-easy-apply-form-section__grouping, div[class*='form']") || errEl.parentElement;
            if (!formGroup) continue;
            const input = formGroup.querySelector('input[type="text"], input[type="number"], input:not([type]), textarea');
            if (!input) continue;
            const currentVal = input.value || "";
            // Extract first number from the current text value
            const numMatch = currentVal.match(/\d+(\.\d+)?/);
            const numericVal = numMatch ? numMatch[0] : "0";
            log(`[VALIDATION-FIX] "${findLabelForInput(input, modal)}" : "${currentVal}" → "${numericVal}"`, "info");
            input.focus();
            input.dispatchEvent(new Event("focus", { bubbles: true }));
            setNativeValue(input, numericVal);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.dispatchEvent(new Event("blur", { bubbles: true }));
            await sleep(500);
          }
          await sleep(1000);
        }
      }

      let nextAction = findNextButton(modal);

      // Retry once if button not found (may need time after typeahead selection)
      if (!nextAction) {
        log("[DEBUG] Bouton non trouvé — attente et retry...", "info");
        await sleep(2000);
        modal = isModalOpen();
        if (modal) nextAction = findNextButton(modal);
      }

      if (!nextAction) {
        log("Pas de bouton Suivant/Envoyer trouvé", "warn");
        devLog("applyToCurrentJob", "No Next/Submit button found", { step });
        const statusCheck = detectModalStatus(modal);
        if (statusCheck === "success") {
          log("Candidature envoyée!", "success");
          const dismissBtn = findDismissButton(modal);
          if (dismissBtn) await humanClick(dismissBtn);
          return { success: true };
        }
        // Don't loop endlessly looking for buttons — force close
        await forceCloseModal("no_next_button");
        return { success: false, reason: "no_next_button" };
      }

      if (nextAction.isSubmit) {
        submitAttempts++;
        devLog("applyToCurrentJob", `Submit attempt ${submitAttempts}/${MAX_SUBMIT_RETRIES}`, { buttonText: nextAction.button.textContent.trim() });

        if (!settings.autoSubmit) {
          log("Mode review: autoSubmit=false", "warn");
          return { success: false, reason: "manual_submit_required" };
        }

        // ── Submit retry limit — avoid infinite submit loop ──
        if (submitAttempts > MAX_SUBMIT_RETRIES) {
          log(`[SUBMIT] ${MAX_SUBMIT_RETRIES} tentatives d'envoi échouées — abandon`, "error");
          devLog("applyToCurrentJob", "MAX SUBMIT RETRIES REACHED — force closing");
          await forceCloseModal("max_submit_retries");
          return { success: false, reason: "submit_failed_max_retries" };
        }

        log(`Envoi de la candidature (tentative ${submitAttempts}/${MAX_SUBMIT_RETRIES})...`, "info");
        await humanClick(nextAction.button);
        await sleep(randomDelay(2000, 4000));

        // ── Check for page-level error toast after submit ──
        const submitPageError = detectPageError();
        if (submitPageError) {
          log(`[SUBMIT-ERROR] Erreur après envoi: "${submitPageError}" — tentative de dismiss...`, "warn");
          devLog("applyToCurrentJob", "Submit error toast — trying to dismiss", { submitPageError, attempt: submitAttempts });
          dismissVisibleToasts();
          await sleep(1500);
          const submitRetry = detectPageError();
          if (submitRetry) {
            log(`[SUBMIT-ERROR] Erreur persistante: "${submitRetry}"`, "error");
            await forceCloseModal("submit_error_toast");
            return { success: false, reason: "submit_error_toast" };
          }
          log("[SUBMIT-ERROR] Toast dismissed — on continue", "info");
        }

        modal = isModalOpen();
        if (modal) {
          const finalStatus = detectModalStatus(modal);
          devLog("applyToCurrentJob", `Post-submit modal status: ${finalStatus}`, { attempt: submitAttempts });
          if (finalStatus === "success") {
            log("Candidature envoyée avec succès!", "success");
            const dismissBtn = findDismissButton(modal) || findByText("button", ["fermer", "close", "done", "terminé"], modal);
            if (dismissBtn) { await sleep(500); await humanClick(dismissBtn); }
            return { success: true };
          }
          if (finalStatus === "error") {
            log("Erreur après envoi — abandon", "error");
            await forceCloseModal("submit_modal_error");
            return { success: false, reason: "submit_modal_error" };
          }
          log(`[SUBMIT] Modal encore ouvert après tentative ${submitAttempts} — continue`, "warn");
          continue;
        }
        return { success: true };
      }

      log(`Clic sur "${nextAction.button.textContent.trim()}"...`);
      await humanClick(nextAction.button);
      await sleep(randomDelay(1500, 3000));

      modal = isModalOpen();
      if (!modal) {
        log("Modal fermé après clic Suivant", "warn");
        return { success: false, reason: "modal_closed_unexpectedly" };
      }
    }

    if (step >= maxSteps) {
      log("Trop d'étapes (>12) — abandon", "error");
      devLog("applyToCurrentJob", "MAX STEPS REACHED", { step });
      await forceCloseModal("too_many_steps");
      return { success: false, reason: "too_many_steps" };
    }
    return { success: false, reason: "stopped" };
  }

  // ── Job List Scanning ───────────────────────────────────────────────────
  function getJobCards() {
    const cards = [];
    const cardSelectors = [
      "li.jobs-search-results__list-item",
      "li.ember-view.occludable-update",
      'div[data-job-id]',
      'li[data-occludable-job-id]',
      'li.scaffold-layout__list-item',
      '.jobs-search-results-list li',
      '.scaffold-layout__list li.ember-view',
      'ul.scaffold-layout__list-container li',
    ];
    for (const sel of cardSelectors) {
      const els = $$(sel);
      if (els.length > 0) {
        for (const el of els) {
          const jobId = el.getAttribute("data-job-id") ||
            el.getAttribute("data-occludable-job-id") ||
            el.querySelector("a")?.href?.match(/\/jobs\/view\/(\d+)/)?.[1] ||
            el.querySelector('[data-job-id]')?.getAttribute('data-job-id') || "";
          cards.push({ element: el, jobId });
        }
        return cards;
      }
    }
    const listContainer =
      $("ul.jobs-search-results__list") ||
      $("div.jobs-search-results-list") ||
      $(".scaffold-layout__list") ||
      $('[class*="jobs-search-results"]');
    if (listContainer) {
      const items = $$("li", listContainer);
      for (const item of items) {
        const link = $("a", item);
        const match = link?.href?.match(/\/jobs\/view\/(\d+)/);
        cards.push({ element: item, jobId: match?.[1] || "" });
      }
    }
    return cards;
  }

  async function clickJobCard(card) {
    // v1.6.0 CRITICAL: Do NOT click <a> links at all — even synthetic MouseEvent
    // on <a> tags causes real navigation away from the search page.
    // Instead, update the URL's currentJobId param. LinkedIn's SPA watches
    // for URL changes and loads job details in the right split-pane panel.
    log(`[DEBUG] clickJobCard: jobId=${card.jobId}`, "info");

    // Scroll the card into view for visual feedback
    card.element.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(randomDelay(300, 600));

    if (card.jobId) {
      // Method 1 (preferred): Update URL param — LinkedIn SPA loads job in right panel
      const url = new URL(window.location.href);
      url.searchParams.set("currentJobId", card.jobId);
      window.history.replaceState(null, "", url.toString());
      // Trigger popstate so LinkedIn's router picks up the change
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      log(`[DEBUG] URL updated with currentJobId=${card.jobId}`, "info");
      await sleep(randomDelay(2500, 4000));

      // Check if the right panel loaded by looking for job title change
      const rightPanel = $(".jobs-search__job-details, .scaffold-layout__detail, .job-details-module");
      if (rightPanel) {
        log(`[DEBUG] Panneau détail trouvé`, "info");
      }
    }

    // Method 2 (fallback): If URL param didn't work, click the card's container
    // element (NOT the <a> tag) to trigger LinkedIn's delegation handler
    if (!findEasyApplyButton()) {
      log(`[DEBUG] Easy Apply non visible après URL update — click sur carte`, "info");
      const clickTarget = card.element; // the <li>, NOT the <a> inside
      const rect = clickTarget.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
      await sleep(50);
      clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
      clickTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
      await sleep(randomDelay(2000, 3000));
    }

    // Safety: verify we're still on the search page
    if (!window.location.href.includes("/jobs/search") && !window.location.href.includes("/jobs/collection")) {
      log("[DEBUG] Navigation détectée hors recherche — retour arrière", "warn");
      window.history.back();
      await sleep(3000);
    }
  }

  function hasEasyApplyBadge(cardElement) {
    const text = cardElement.textContent.toLowerCase();
    return text.includes("easy apply") || text.includes("candidature simplifiée");
  }

  async function scrollJobList() {
    const listEl = $(".jobs-search-results-list") || $(".scaffold-layout__list") ||
      $('[class*="jobs-search-results"]') || $(".jobs-search-results-list__list");
    if (!listEl) {
      log("[DEBUG] Conteneur liste non trouvé, scroll page entière", "warn");
      for (let i = 0; i < 5; i++) { window.scrollBy(0, 600); await sleep(800); }
      window.scrollTo(0, 0); await sleep(500);
      return;
    }
    for (let i = 0; i < 5; i++) { listEl.scrollTop = listEl.scrollHeight; await sleep(800); }
    listEl.scrollTop = 0; await sleep(500);
  }

  function buildSearchUrl(keywords, location, page = 0, jobTypes = "") {
    const params = new URLSearchParams();
    if (keywords) params.set("keywords", keywords);
    if (location) params.set("location", location);
    params.set("f_AL", "true");
    if (jobTypes) params.set("f_JT", jobTypes);
    if (page > 0) params.set("start", String(page * 25));
    return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
  }

  async function waitForJobCards(maxWaitMs = 30000) {
    const startTime = Date.now();
    let attempt = 0;
    while (Date.now() - startTime < maxWaitMs) {
      attempt++;
      window.scrollBy(0, 300); await sleep(500); window.scrollTo(0, 0);
      const cards = getJobCards();
      if (cards.length > 0) {
        log(`${cards.length} offre(s) détectées après ${attempt} tentative(s) (${Math.round((Date.now() - startTime) / 1000)}s)`);
        return cards;
      }
      log(`[DEBUG] Attente offres... tentative ${attempt}`, "info");
      await sleep(2000);
    }
    log(`Aucune offre trouvée après ${maxWaitMs / 1000}s`, "error");
    return [];
  }

  // ── Auto Apply Session (multi-page) ─────────────────────────────────────
  async function runAutoApplySession() {
    if (isRunning) {
      log("[DEBUG] runAutoApplySession appelé mais isRunning=true — refusé", "warn");
      return;
    }

    isRunning = true;
    shouldStop = false;

    log("[DEBUG] runAutoApplySession START", "info");

    // ═══════════════════════════════════════════════════════════════════
    // CRITICAL FIX v1.4.0: Read session DIRECTLY from storage
    // (no service worker dependency — avoids the active=undefined bug)
    // ═══════════════════════════════════════════════════════════════════
    const { sessionLinkedin: session } = await chrome.storage.local.get(["sessionLinkedin"]);
    const state = await chrome.runtime.sendMessage({ action: "getState" });
    const settings = state.autoApplySettings || {};
    const maxJobs = Math.min(Math.max(session?.maxJobs || settings.maxJobsPerSession || 25, 1), 10000);
    const appliedJobs = state.appliedJobs || {};
    const totalApplied = session?.applied || 0;

    log(`AutoApply démarré — page ${(session?.currentPage || 0) + 1} (${totalApplied}/${maxJobs} postulées)`, "info");

    await scrollJobList();
    let jobCards = await waitForJobCards(30000);
    const easyApplyCandidates = jobCards.filter((c) => hasEasyApplyBadge(c.element)).length;

    if (jobCards.length === 0) {
      log("Aucune offre trouvée — fin de session", "error");
      if (session?.active) {
        await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: "linkedin" });
      }
      playNotificationSound("stop");
      isRunning = false;
      return;
    }

    // ── Check daily limit before starting the loop ──
    const earlyLimitCheck = detectDailyLimit();
    if (earlyLimitCheck) {
      log(`🚫 LIMITE QUOTIDIENNE DÉTECTÉE avant candidatures: "${earlyLimitCheck}"`, "error");
      await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: "linkedin" }).catch(() => {});
      playNotificationSound("limit");
      isRunning = false;
      return;
    }

    try {
      let pageApplied = 0;

      for (let i = 0; i < jobCards.length && !shouldStop; i++) {
        // Check max jobs (read directly from storage for accuracy)
        const { sessionLinkedin: currentSession } = await chrome.storage.local.get(["sessionLinkedin"]);
        if (currentSession && (currentSession.applied || 0) >= maxJobs) {
          log(`Max atteint (${maxJobs}) — fin`, "info");
          break;
        }

        const card = jobCards[i];
        if (card.jobId && appliedJobs[card.jobId]) {
          log(`Ignoré (déjà postulé): job ${card.jobId}`, "info");
          continue;
        }

        if (settings.onlyEasyApply !== false && !hasEasyApplyBadge(card.element)) {
          log(`[DEBUG] Carte ${i + 1}: pas Easy Apply — ignorée`, "info");
          continue;
        }

        // Track if this is an external apply job
        const isEasyApply = hasEasyApplyBadge(card.element);

        log(`Sélection offre ${i + 1}/${jobCards.length}...`);
        await clickJobCard(card);

        // Wait for the right panel to load job details
        await sleep(randomDelay(1500, 2500));
        const jobInfo = getCurrentJobInfo();
        if (!jobInfo.jobId && card.jobId) jobInfo.jobId = card.jobId;

        log(`Offre: ${jobInfo.title || "(sans titre)"} @ ${jobInfo.company || "(inconnu)"}`, "info");

        // Safety check: make sure we're still on search page
        if (!window.location.href.includes("/jobs/search") && !window.location.href.includes("/jobs/collection")) {
          log("[DEBUG] Plus sur la page de recherche — retour", "warn");
          window.history.back();
          await sleep(3000);
          continue;
        }

        // ── Blacklist check ─────────────────────────────────────────
        if (await isCompanyBlacklisted(jobInfo.company)) {
          await chrome.runtime.sendMessage({
            action: "markSkipped", platform: "linkedin", jobId: jobInfo.jobId,
            title: jobInfo.title, reason: `Blacklistée: ${jobInfo.company}`,
          }).catch(() => {});
          continue;
        }

        const maxPerCo = settings.maxApplicationsPerCompany || 0;
        if (maxPerCo > 0 && jobInfo.company) {
          const countRes = await chrome.runtime.sendMessage({ action: "companyApplyCount", company: jobInfo.company }).catch(() => null);
          if ((countRes?.count || 0) >= maxPerCo) {
            await chrome.runtime.sendMessage({
              action: "markSkipped", platform: "linkedin", jobId: jobInfo.jobId,
              title: jobInfo.title, reason: `Limite entreprise (${jobInfo.company})`,
            }).catch(() => {});
            continue;
          }
        }

        // Wait for Easy Apply button with retry (right panel may still be loading)
        let easyApplyBtn = findEasyApplyButton();
        if (!easyApplyBtn) {
          log(`[DEBUG] Easy Apply non visible — attente 3s...`, "info");
          await sleep(3000);
          easyApplyBtn = findEasyApplyButton();
        }
        if (!easyApplyBtn) {
          // ── External Apply path: send to backend pipeline ──────
          if (!isEasyApply && settings.onlyEasyApply === false) {
            const backendOk = await checkBackendAvailable();
            if (backendOk) {
              log(`[External] Ajout au pipeline: ${jobInfo.title} @ ${jobInfo.company}`, "info");
              const pipelineOk = await sendToBackendPipeline(jobInfo);
              if (pipelineOk) {
                log(`[External] Ajouté au pipeline backend ✓`, "success");
                // Try auto-apply if external URL available
                const externalResult = await requestExternalApply(jobInfo);
                if (externalResult.success) {
                  pageApplied++;
                  await chrome.runtime.sendMessage({
                    action: "markApplied", platform: "linkedin", jobId: jobInfo.jobId,
                    title: jobInfo.title, company: jobInfo.company, url: jobInfo.url,
                  }).catch(() => {});
                  log(`[External] Candidature externe envoyée: ${jobInfo.title}`, "success");
                } else {
                  log(`[External] Candidature externe en attente: ${externalResult.reason}`, "warn");
                }
              } else {
                log(`[External] Échec ajout pipeline`, "warn");
              }
            } else {
              log(`[External] Backend non disponible — ignoré: ${jobInfo.title}`, "warn");
              await chrome.runtime.sendMessage({
                action: "markSkipped", platform: "linkedin", jobId: jobInfo.jobId,
                title: jobInfo.title, reason: "Externe (backend indisponible)",
              }).catch(() => {});
            }
          } else {
            log(`Pas de bouton Easy Apply: ${jobInfo.title}`, "info");
            await chrome.runtime.sendMessage({
              action: "markSkipped", platform: "linkedin", jobId: jobInfo.jobId,
              title: jobInfo.title, reason: "Pas de candidature simplifiée",
            }).catch(() => {});
          }
          continue;
        }

        log(`Candidature en cours: ${jobInfo.title}...`);
        const result = await applyToCurrentJob(settings);

        // ── Check for daily limit immediately after apply attempt ──
        if (result.reason === "daily_limit") {
          log("🚫 Limite quotidienne atteinte — arrêt de la session", "error");
          await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: "linkedin" }).catch(() => {});
          playNotificationSound("limit");
          isRunning = false;
          return;
        }

        if (result.success) {
          pageApplied++;
          await chrome.runtime.sendMessage({
            action: "markApplied", platform: "linkedin", jobId: jobInfo.jobId,
            title: jobInfo.title, company: jobInfo.company, url: jobInfo.url,
          }).catch(() => {});
          log(`Postulé (${pageApplied} sur cette page): ${jobInfo.title}`, "success");
        } else if (result.reason === "already_applied") {
          await chrome.runtime.sendMessage({
            action: "markSkipped", platform: "linkedin", jobId: jobInfo.jobId,
            title: jobInfo.title, reason: "Déjà postulé",
          }).catch(() => {});
        } else {
          await chrome.runtime.sendMessage({
            action: "markError", platform: "linkedin", jobId: jobInfo.jobId,
            title: jobInfo.title, error: result.reason,
          }).catch(() => {});
          log(`Échec (${result.reason}): ${jobInfo.title}`, "error");
        }

        if (!shouldStop && i < jobCards.length - 1) {
          const rawDelay = randomDelay(settings.delayBetweenJobs?.min || 8000, settings.delayBetweenJobs?.max || 20000);
          const delay = Math.min(Math.max(rawDelay, 2000), 60000);
          log(`Pause ${Math.round(delay / 1000)}s...`);
          await sleep(delay);

          // Check daily limit during pause
          const limitCheck = detectDailyLimit();
          if (limitCheck) {
            log("🚫 Limite quotidienne détectée pendant la pause — arrêt", "error");
            await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: "linkedin" }).catch(() => {});
            playNotificationSound("limit");
            isRunning = false;
            return;
          }
        }
      }

      // Multi-page: next page
      if (!shouldStop) {
        const { sessionLinkedin: updatedSession } = await chrome.storage.local.get(["sessionLinkedin"]);
        if (updatedSession?.active && (updatedSession.applied || 0) < maxJobs) {
          // Safety guard: avoid endless page-refresh loops when no Easy Apply cards exist.
          if (settings.onlyEasyApply !== false) {
            const maxNoEasyPages = Number(settings.maxNoEasyPages || 3);
            const prevNoEasyPages = Number(updatedSession.noEasyPages || 0);
            const noEasyPages = easyApplyCandidates === 0 ? (prevNoEasyPages + 1) : 0;

            await chrome.runtime.sendMessage({
              action: "updateSession",
              updates: { noEasyPages },
            });

            if (noEasyPages >= maxNoEasyPages) {
              await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: "linkedin" });
              log(`Arrêt sécurité: ${noEasyPages} page(s) sans Easy Apply consécutives`, "warn");
              playNotificationSound("stop");
              isRunning = false;
              return;
            }
          }

          const nextPage = (updatedSession.currentPage || 0) + 1;
          await chrome.runtime.sendMessage({
            action: "updateSession",
            updates: { currentPage: nextPage },
          });
          const nextUrl = buildSearchUrl(updatedSession.keywords, updatedSession.location, nextPage, updatedSession.jobTypes || "");
          log(`Page suivante ${nextPage + 1}: ${nextUrl}`);
          await sleep(randomDelay(3000, 6000));
          window.location.href = nextUrl;
          return;
        } else {
          if (updatedSession?.active) {
            await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: "linkedin" });
            log(`Session terminée — ${updatedSession.applied || 0} candidature(s)`, "success");
            playNotificationSound("stop");
          }
        }
      } else {
        await chrome.runtime.sendMessage({ action: "endPlatformSession", platform: "linkedin" });
        log("Session arrêtée par l'utilisateur", "warn");
        playNotificationSound("stop");
      }
    } catch (err) {
      log(`Erreur session: ${err.message}`, "error");
      console.error("[AmiJobs LinkedIn] Session error:", err);
      playNotificationSound("error");
    }

    isRunning = false;
  }

  // ── Single Job Apply ────────────────────────────────────────────────────
  async function applySingleJob() {
    if (isRunning) { log("Déjà en cours", "warn"); return; }
    isRunning = true;
    shouldStop = false;
    try {
      const state = await chrome.runtime.sendMessage({ action: "getState" });
      const settings = state?.autoApplySettings || {};
      const result = await applyToCurrentJob(settings);
      if (result.success) {
        const jobInfo = getCurrentJobInfo();
        await chrome.runtime.sendMessage({
          action: "markApplied", platform: "linkedin", jobId: jobInfo.jobId,
          title: jobInfo.title, company: jobInfo.company, url: jobInfo.url,
        }).catch(() => {});
        log(`Postulé: ${jobInfo.title}`, "success");
      }
    } catch (err) {
      log(`Erreur: ${err.message}`, "error");
    }
    isRunning = false;
  }

  // ── Auto-resume session — READS DIRECTLY FROM STORAGE ──────────────────
  function isLinkedInSearchUrl(url = window.location.href) {
    return url.includes("/jobs/search") || url.includes("/jobs/collection");
  }

  function sameLinkedInSearchContext(before, after) {
    if (!isLinkedInSearchUrl(after)) return false;
    try {
      const u1 = new URL(before);
      const u2 = new URL(after);
      if (u1.searchParams.get("keywords") && u2.searchParams.get("keywords") && u1.searchParams.get("keywords") !== u2.searchParams.get("keywords")) {
        return false;
      }
      if (u1.searchParams.get("location") && u2.searchParams.get("location") && u1.searchParams.get("location") !== u2.searchParams.get("location")) {
        return false;
      }
      return true;
    } catch {
      return isLinkedInSearchUrl(after);
    }
  }

  async function checkAndResumeSession() {
    const url = window.location.href;
    const isSearchPage = url.includes("/jobs/search") || url.includes("/jobs/collection");

    log(`[DEBUG] checkAndResumeSession: url match=${isSearchPage}, isRunning=${isRunning}`, "info");

    if (!isSearchPage) {
      log("[DEBUG] Pas une page de recherche — pas de session auto", "info");
      return;
    }

    // Poll every 3s for up to 60s to find an active session
    const maxWait = 60000;
    const interval = 3000;
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < maxWait) {
      attempt++;
      try {
        // ═══════════════════════════════════════════════════════════════
        // CRITICAL FIX v1.4.0: Read session DIRECTLY from storage
        // This bypasses the service worker entirely!
        // ═══════════════════════════════════════════════════════════════
        const { sessionLinkedin: session } = await chrome.storage.local.get(["sessionLinkedin"]);
        log(`[DEBUG] Session poll #${attempt}: active=${session?.active}, isRunning=${isRunning}`, "info");

        if (session && session.active && !isRunning) {
          log(`Session active trouvée: "${session.keywords}" page ${(session.currentPage || 0) + 1} — démarrage dans 3s...`, "info");
          const resumeUrl = window.location.href;
          await sleep(3000);
          const { sessionLinkedin: freshSession } = await chrome.storage.local.get(["sessionLinkedin"]);
          if (!freshSession?.active) {
            log("[DEBUG] Session désactivée pendant le délai de reprise — annulation", "info");
            return;
          }
          if (!sameLinkedInSearchContext(resumeUrl, window.location.href)) {
            log("[DEBUG] Navigation hors recherche pendant le délai de reprise — annulation", "info");
            return;
          }
          if (!isRunning) {
            await runAutoApplySession();
          }
          return;
        }

        if (isRunning) {
          log("[DEBUG] Session déjà en cours (isRunning=true) — arrêt polling", "info");
          return;
        }
      } catch (err) {
        log(`[DEBUG] Erreur session poll #${attempt}: ${err.message}`, "warn");
      }

      await sleep(interval);
    }

    log("[DEBUG] Aucune session active trouvée après 60s de polling", "info");
  }

  // ── Message Handler ─────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "startAutoApply") {
      log("[DEBUG] Message startAutoApply reçu de background", "info");
      if (isRunning) {
        log("[DEBUG] Déjà en cours — refusé", "warn");
        sendResponse({ ok: false, reason: "already_running" });
        return;
      }
      runAutoApplySession().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.action === "applySingleJob") {
      applySingleJob().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.action === "stopAutoApply") {
      shouldStop = true;
      log("Arrêt demandé...", "warn");
      sendResponse({ ok: true });
      return;
    }
    if (msg.action === "getContentStatus") {
      sendResponse({ isRunning, sessionStats, url: window.location.href, version: VERSION });
      return;
    }
  });

  // ── Visual Indicator ────────────────────────────────────────────────────
  function addStatusBadge() {
    if (document.getElementById("linkedin-autoapply-badge")) return;
    const badge = document.createElement("div");
    badge.id = "linkedin-autoapply-badge";
    badge.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 99999;
      background: linear-gradient(135deg, #0077b5, #00a0dc);
      color: white; padding: 8px 16px; border-radius: 20px;
      font-size: 12px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      cursor: pointer; user-select: none; transition: all 0.3s;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    `;
    badge.textContent = "\u{1F680} AutoApply v" + VERSION;
    badge.title = "LinkedIn AutoApply actif";
    badge.addEventListener("mouseenter", () => { badge.style.transform = "scale(1.05)"; });
    badge.addEventListener("mouseleave", () => { badge.style.transform = "scale(1)"; });
    document.body.appendChild(badge);
  }

  // ── Init ────────────────────────────────────────────────────────────────
  addStatusBadge();
  log(`LinkedIn AutoApply v${VERSION} chargé sur ${window.location.href}`);

  // Start aggressive session polling (primary resume mechanism)
  checkAndResumeSession();
})();
