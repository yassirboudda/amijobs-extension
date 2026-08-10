// AmiJobs — shared form-fill helpers for job platform content scripts
(function () {
  if (window.AmiJobsShared) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randomDelay = (min, max) => Math.floor(Math.random() * (max - min)) + min;

  function $(selector, root = document) {
    return root.querySelector(selector);
  }
  function $$(selector, root = document) {
    return [...root.querySelectorAll(selector)];
  }

  function setNativeValue(element, value) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function humanClick(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(200 + Math.random() * 300);
    element.click();
  }

  async function humanType(element, text) {
    element.focus();
    setNativeValue(element, "");
    for (const char of String(text)) {
      element.value += char;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(10 + Math.random() * 30);
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getFieldLabel(el) {
    const id = el.id;
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return label.textContent.trim();
    }
    const wrap = el.closest("label");
    if (wrap) return wrap.textContent.trim();
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      "field"
    ).trim();
  }

  function isVisible(el) {
    if (!el || el.disabled || el.readOnly) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  async function getProfile() {
    const { profile = {} } = await chrome.storage.local.get(["profile"]);
    return profile;
  }

  async function profileAnswer(label, profile) {
    const l = label.toLowerCase();
    if (/e-?mail/.test(l)) return profile.email || "";
    if (/phone|téléphone|tel/.test(l)) return profile.phone || "";
    if (/first|prénom/.test(l)) return profile.firstName || (profile.fullName || "").split(" ")[0] || "";
    if (/last|nom/.test(l) && !/company|entreprise/.test(l)) {
      const parts = (profile.fullName || "").split(" ");
      return profile.lastName || parts.slice(1).join(" ") || "";
    }
    if (/full name|nom complet|name/.test(l)) return profile.fullName || "";
    if (/city|ville|location|localisation/.test(l)) return (profile.location || "").split(",")[0].trim();
    if (/postal|zip|code postal/.test(l)) return profile.postalCode || "";
    if (/linkedin/.test(l)) return profile.linkedin || "";
    if (/title|titre|poste/.test(l)) return profile.title || "";
    if (/salary|salaire/.test(l)) return profile.salaryExpectation || "";
    if (/naissance|birth\s*date|\bdob\b/.test(l)) {
      return normalizeBirthDateFr(profile.birthDate || "") || "";
    }
    if (/availability|disponibilit/.test(l) && !/date/.test(l)) return profile.availability || "";
    if (/cover|motivation|lettre|message|why|pourquoi/.test(l)) {
      return profile.coverLetterDefault || "";
    }
    if (/antiquit|anciennet[ée]|exp[eé]rience|seniority|années?\s*d['’]?exp|years?\s*(of\s*)?exp/i.test(l)) {
      const n = String(profile.experience || "").match(/(\d+(?:[.,]\d+)?)/);
      if (n) return /nombre|combien|number|ans\b|years?\b/i.test(l) ? n[1] : `${n[1]} ans`;
    }
    return "";
  }

  function normalizeBirthDateFr(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
    const fr = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (fr) return `${fr[1].padStart(2, "0")}/${fr[2].padStart(2, "0")}/${fr[3]}`;
    return raw;
  }

  function isDateFieldHint(hint, el) {
    if (el?.type === "date") return true;
    const h = String(hint || "").toLowerCase();
    return /date|naissance|birth|\bdob\b|disponib|démarrage|debut|début|start\s*date|jj\s*[\/.-]\s*mm|dd\s*[\/.-]\s*mm|mm\s*[\/.-]\s*dd|xx\s*[\/.-]\s*xx\s*[\/.-]\s*xxxx|aaaa|yyyy/.test(
      h
    );
  }

  function formatDateAnswer(profile, el, hint) {
    const h = String(hint || "").toLowerCase();
    const wantsIso = el?.type === "date" || /yyyy-mm-dd|aaaa-mm-jj/i.test(h);
    let fr = "";
    if (/naissance|birth|\bdob\b/.test(h)) {
      fr = normalizeBirthDateFr(profile?.birthDate || "") || "01/01/2000";
    } else {
      // Availability / start date ~ 14 days ahead (French DD/MM/YYYY)
      const d = new Date();
      d.setDate(d.getDate() + 14);
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const yyyy = String(d.getFullYear());
      fr = `${dd}/${mm}/${yyyy}`;
    }
    if (wantsIso) {
      const m = fr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    }
    return fr;
  }

  async function isCompanyBlacklisted(companyName) {
    if (!companyName) return false;
    const { blacklistedCompanies = [] } = await chrome.storage.local.get(["blacklistedCompanies"]);
    const companyLower = companyName.toLowerCase();
    return blacklistedCompanies.some((blocked) => {
      const b = String(blocked).toLowerCase().trim();
      return b && (companyLower.includes(b) || b.includes(companyLower));
    });
  }

  async function withTimeout(promise, ms, fallback = null) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(fallback), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fillField(field, jobInfo, platform) {
    const el = field.element;
    const label = field.label;
    const profile = await getProfile();
    const direct = await profileAnswer(label, profile);
    const hint = `${label || ""} ${el?.placeholder || ""} ${el?.getAttribute?.("aria-label") || ""}`;

    if (field.type === "checkbox") {
      const mandatory = /accept|terms|agree|consent|certif|confirm/i.test(label);
      if ((mandatory || /yes|oui|true/i.test(direct)) && !el.checked) await humanClick(el);
      return;
    }

    // Date fields MUST be DD/MM/YYYY (or ISO for input[type=date]) — never a sentence
    if (field.type === "date" || isDateFieldHint(hint, el)) {
      const dateVal = formatDateAnswer(profile, el, hint);
      if (el.type === "date") setNativeValue(el, dateVal);
      else await humanType(el, dateVal);
      return;
    }

    if (field.type === "select") {
      const options = [...el.options].map((o) => o.text.trim()).filter(Boolean);
      let answer = direct;
      if (!answer) {
        const res = await withTimeout(
          chrome.runtime.sendMessage({
            action: "generateAnswer",
            question: label,
            fieldType: "select",
            options,
            jobInfo,
          }),
          5000,
          null
        );
        answer = res?.answer || options.find((o) => o && !/select|choisir|—|--/i.test(o)) || options[0] || "";
      }
      let idx = options.findIndex((o) => o.toLowerCase() === String(answer).toLowerCase());
      if (idx < 0) {
        idx = options.findIndex(
          (o) =>
            o.toLowerCase().includes(String(answer).toLowerCase()) ||
            String(answer).toLowerCase().includes(o.toLowerCase())
        );
      }
      if (idx < 0) idx = options.findIndex((o) => o && !/select|choisir|—|--/i.test(o));
      if (idx >= 0) {
        el.selectedIndex = idx;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    if (field.type === "radio") {
      const radios = field.elements || [];
      // Prefer Oui/Yes without waiting on AI
      let target =
        radios.find((r, i) => /yes|oui|true|accept/i.test(field.options[i] || "")) || null;
      if (!target) {
        const res = await withTimeout(
          chrome.runtime.sendMessage({
            action: "generateAnswer",
            question: label,
            fieldType: "radio",
            options: field.options || [],
            jobInfo,
          }),
          4000,
          null
        );
        const answer = (direct || res?.answer || "").toLowerCase();
        target = radios.find((r, i) => (field.options[i] || "").toLowerCase().includes(answer));
      }
      if (!target) target = radios[0];
      if (target) await humanClick(target);
      return;
    }

    let answer = direct;
    if (!answer) {
      const wantsExp =
        field.type === "number" ||
        /antiquit|anciennet[ée]|année|year|exp[eé]rience|experience|seniority|ans\b/i.test(label);
      if (wantsExp) {
        const res = await withTimeout(
          chrome.runtime.sendMessage({
            action: "generateAnswer",
            question: label,
            fieldType: field.type === "number" ? "number" : "text",
            options: [],
            jobInfo,
          }),
          6000,
          null
        );
        answer = res?.answer || "";
        if (!answer || /^(oui|yes|we|n\/?a)\.?$/i.test(String(answer).trim())) {
          const n = String(profile.experience || "").match(/(\d+)/);
          answer = n ? n[1] : "3";
        }
      } else if (/url|link|linkedin/i.test(label)) answer = profile.linkedin || "https://www.linkedin.com";
      else if (/phone|téléphone|tel/i.test(label)) answer = profile.phone || "0612345678";
      else {
        const res = await withTimeout(
          chrome.runtime.sendMessage({
            action: "generateAnswer",
            question: label,
            fieldType: field.type,
            options: [],
            jobInfo,
          }),
          5000,
          null
        );
        answer = res?.answer || "Oui";
        if (/^(we|n\/?a|none|null)\.?$/i.test(String(answer).trim())) answer = "Oui";
        // If AI returned a long sentence but the field looks like a short input, keep it short
        if (el.tagName === "INPUT" && String(answer).length > 40 && !/cover|motivation|message|pourquoi/i.test(label)) {
          answer = "Oui";
        }
        // If AI returned prose for something that looks like a date, force date format
        if (isDateFieldHint(hint, el) || /^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(el.placeholder || "")) {
          answer = formatDateAnswer(profile, el, hint);
        }
      }
    }
    if (field.type === "number") {
      const num = String(answer).match(/\d+/);
      answer = num ? num[0] : "1";
    }
    await humanType(el, answer);
  }

  async function shouldSkipCompany(company) {
    if (!company) return false;
    if (await isCompanyBlacklisted(company)) return "blacklist";
    const { autoApplySettings = {} } = await chrome.storage.local.get(["autoApplySettings"]);
    const max = autoApplySettings.maxApplicationsPerCompany || 0;
    if (max > 0) {
      const res = await chrome.runtime.sendMessage({ action: "companyApplyCount", company });
      if ((res?.count || 0) >= max) return "company_limit";
    }
    return false;
  }

  async function getCvFile() {
    const { cvFile = null } = await chrome.storage.local.get(["cvFile"]);
    return cvFile;
  }

  async function uploadCvToFileInput(input) {
    if (!input) return false;
    const cv = await getCvFile();
    if (!cv?.base64) return false;
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
      return true;
    } catch (_e) {
      return false;
    }
  }

  function collectFields(root = document) {
    const fields = [];
    const roots = [root];
    try {
      for (const frame of document.querySelectorAll("iframe")) {
        try {
          const doc = frame.contentDocument || frame.contentWindow?.document;
          if (doc) roots.push(doc);
        } catch (_e) {
          /* cross-origin iframe */
        }
      }
    } catch (_e) {}
    for (const r of roots) {
      for (const el of $$("input, textarea, select", r)) {
        const type = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
        if (["hidden", "submit", "button", "image", "reset"].includes(type)) continue;
        // v1.4.0: File inputs are often hidden by design but still need upload
        if (type === "file") {
          fields.push({ type: "file", label: getFieldLabel(el), element: el });
          continue;
        }
        if (!isVisible(el)) continue;
        if (type === "radio") {
          const name = el.name;
          if (!name || fields.some((f) => f.type === "radio" && f.name === name)) continue;
          const group = $$(`input[type="radio"][name="${CSS.escape(name)}"]`, r).filter(isVisible);
          fields.push({
            type: "radio",
            name,
            label: getFieldLabel(group[0]),
            elements: group,
            options: group.map((g) => getFieldLabel(g) || g.value),
            element: group[0],
          });
          continue;
        }
        fields.push({
          type: type === "textarea" ? "textarea" : type,
          label: getFieldLabel(el),
          element: el,
        });
      }
    }
    return fields;
  }

  async function fillVisibleFields(jobInfo, platform) {
    const fields = collectFields();
    for (const field of fields) {
      try {
        if (field.type === "file") {
          await uploadCvToFileInput(field.element);
          await sleep(150 + Math.random() * 250);
          continue;
        }
        await fillField(field, jobInfo, platform);
        await sleep(150 + Math.random() * 250);
      } catch (e) {
        console.warn("[AmiJobsShared] fill error", e);
      }
    }
  }

  function findActionButton(patterns, root = document) {
    const buttons = $$("button, a[role='button'], input[type='submit']", root);
    for (const btn of buttons) {
      if (!isVisible(btn) || btn.disabled) continue;
      const text = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.toLowerCase();
      if (patterns.some((p) => p.test(text))) return btn;
    }
    return null;
  }

  function findActionButtonDeep(patterns) {
    const roots = [document];
    try {
      for (const frame of document.querySelectorAll("iframe")) {
        try {
          const doc = frame.contentDocument || frame.contentWindow?.document;
          if (doc) roots.push(doc);
        } catch (_e) {
          /* cross-origin */
        }
      }
    } catch (_e) {}
    for (const root of roots) {
      const btn = findActionButton(patterns, root);
      if (btn) return btn;
    }
    return null;
  }

  window.AmiJobsShared = {
    sleep,
    randomDelay: (min, max) => Math.floor(Math.random() * (max - min)) + min,
    $,
    $$,
    humanClick,
    humanType,
    setNativeValue,
    getFieldLabel,
    isVisible,
    getProfile,
    isCompanyBlacklisted,
    shouldSkipCompany,
    uploadCvToFileInput,
    getCvFile,
    fillVisibleFields,
    collectFields,
    findActionButton,
    findActionButtonDeep,
    isDateFieldHint,
    formatDateAnswer,
    normalizeBirthDateFr,
    log(platform, msg, level = "info") {
      const ts = new Date().toISOString().slice(11, 23);
      console.log(`[AmiJobs ${platform} ${ts}] ${msg}`);
      chrome.runtime
        .sendMessage({ action: "addLog", platform, message: `[${ts}] ${msg}`, level })
        .catch(() => {});
    },
  };
})();
