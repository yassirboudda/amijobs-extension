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
    const { profile = {}, cvText = "" } = await chrome.storage.local.get(["profile", "cvText"]);
    // Prefer Options top-level cvText (source of truth), then profile.cvText
    return { ...profile, cvText: cvText || profile.cvText || "" };
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
    // Niveau d'études only — NOT "avez-vous un diplôme d'infirmier ?"
    if (
      (/niveau|[ée]tudes|education|degree|formation/.test(l) ||
        (/dipl[oô]me/.test(l) && /niveau|quel|bac|master|licence/.test(l))) &&
      !/avez-vous|êtes-vous|etes-vous|poss[eè]dez|disposez|titulaire/.test(l)
    ) {
      return profile.education || "Bac+5";
    }
    if (/naissance|birth\s*date|\bdob\b/.test(l)) {
      return normalizeBirthDateFr(profile.birthDate || "") || "";
    }
    if (/availability|disponibilit/.test(l) && !/date/.test(l)) return profile.availability || "";
    if (/cover|motivation|lettre|message|why|pourquoi/.test(l)) {
      return profile.coverLetterDefault || "";
    }
    if (/antiquit|anciennet[ée]|exp[eé]rience|seniority|années?\s*d['’]?exp|years?\s*(of\s*)?exp|combien d['’]?ann/i.test(l)) {
      const n = String(profile.experience || "").match(/(\d+(?:[.,]\d+)?)/);
      if (!n) return "";
      // Indeed/Glassdoor screening often rejects "1 an" — always prefer bare digits for year/count Qs
      if (
        /nombre|combien|number|ans\b|years?\b|années?|year|numeric|entier|décimal|decimal/i.test(l) ||
        /de combien/i.test(l)
      ) {
        return n[1].replace(",", ".");
      }
      return n[1];
    }
    return "";
  }

  function wantsNumericAnswer(label, el) {
    const l = `${label || ""} ${el?.placeholder || ""} ${el?.getAttribute?.("aria-label") || ""}`.toLowerCase();
    if (el?.type === "number") return true;
    if (/^(numeric|decimal|number)$/i.test(el?.inputMode || el?.getAttribute?.("inputmode") || "")) return true;
    if (el?.getAttribute?.("aria-invalid") === "true") {
      const err = el.closest('[class*="question"], fieldset, [class*="FormField"], label')?.innerText || "";
      if (/nombre valide|nombre entier|aucune décimale|numeric|decimal|enter a number|doit être un nombre/i.test(err)) {
        return true;
      }
    }
    return /nombre|combien|numeric|entier|décimal|decimal|années?\s*d['’]?exp|years?\s*(of\s*)?exp|de combien d['’]?ann/i.test(
      l
    );
  }

  function coerceNumericAnswer(answer, fallback = "3") {
    const m = String(answer || "").replace(",", ".").match(/(\d+(?:\.\d+)?)/);
    if (!m) return fallback;
    // Indeed: "aucune décimale" → integer only; treat 0 as missing (bad profile parse)
    const n = Math.round(parseFloat(m[1]));
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return String(n);
  }

  /** Yes/No from CV text — never invent credentials (infirmier, permis, etc.). */
  function answerYesNoFromCv(question, cvText, profile = {}) {
    const q = String(question || "").toLowerCase();
    const cv = `${cvText || profile.cvText || ""} ${profile.education || ""} ${profile.title || ""} ${profile.stack || ""}`.toLowerCase();
    if (!q) return null;
    const isYn =
      /avez-vous|êtes-vous|etes-vous|poss[eè]dez|disposez|titulaire|dipl[oô]m[eé]|certificat|habilitation|permis|licence pro|qualification|accréditation|registered|licensed|do you (have|hold)|are you/i.test(
        q
      );
    if (!isYn) return null;

    // Soft availability / consent → yes is fine
    if (/disponib|mobile|télétravail|teletravail|permis de travail|right to work|autoris[eé].*travailler|consent|accepte/i.test(q)) {
      return "Oui";
    }

    // Extract credential keywords from the question
    const creds = [];
    const push = (s) => {
      const t = String(s || "").toLowerCase().trim();
      if (t.length >= 4) creds.push(t);
    };
    const mDip = q.match(/dipl[oô]me[^?]{0,40}?d['’]?\s*([a-zàâäéèêëïîôùûüç][\wàâäéèêëïîôùûüç\s-]{2,40})/i);
    if (mDip) push(mDip[1]);
    const mInf = q.match(/\b(infirmier(?:e|ère)?|aide[\s-]?soignant(?:e)?|m[eé]decin|pharmacien(?:ne)?|kin[eé]|sage[\s-]?femme|formateur(?:trice)?|comptable|expert[\s-]?comptable|avocat|notaire|architect)\b/i);
    if (mInf) push(mInf[1]);
    const mPerm = q.match(/\b(permis\s*[a-z0-9]+|caces|habilitation\s*[a-z0-9]+|toeic|toefl|ielts|pmp|aws|azure)\b/i);
    if (mPerm) push(mPerm[1]);
    // Fallback: significant tokens after diplôme/certificat
    for (const tok of q.split(/[^a-zàâäéèêëïîôùûüç0-9+]+/i)) {
      if (
        tok.length >= 5 &&
        !/avez|etes|êtes|vous|diplome|diplôme|certificat|obtenir|requis|niveau|etudes|études|formation|annee|année|experience|expérience/.test(
          tok
        )
      ) {
        push(tok);
      }
    }

    if (!cv.trim()) {
      // No CV text → safe default Non for credential questions
      return "Non";
    }
    // Ignore negated mentions ("pas de diplôme infirmier", "sans permis…")
    const mentions = (blob, needle) => {
      const norm = (s) =>
        String(s || "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");
      const hay = norm(blob);
      const n = norm(needle);
      if (!n || n.length < 4) return false;
      let from = 0;
      while (from < hay.length) {
        const idx = hay.indexOf(n, from);
        if (idx < 0) return false;
        const before = hay.slice(Math.max(0, idx - 48), idx);
        if (
          /(pas\s+(de\s+|d['’])?|sans\s+|aucun(?:e)?\s+|without\s+|not\s+a\s+|no\s+)/.test(before) &&
          /(pas|sans|aucun|without|not|no)\s/.test(before.slice(-24))
        ) {
          from = idx + n.length;
          continue;
        }
        return true;
      }
      return false;
    };
    const hit = creds.some((c) => mentions(cv, c));
    return hit ? "Oui" : "Non";
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
      const isPlaceholder = (t) =>
        !t || /sélectionn|selectionn|select(\s+an)?\s*option|choisir|veuillez|please select|^[-—–\s]*$/i.test(t);
      const selectedText = (el.options[el.selectedIndex]?.text || "").trim();
      // Skip only when a real (non-placeholder) option is already chosen
      if (el.value && !isPlaceholder(selectedText) && el.selectedIndex > 0) return;
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
        answer = res?.answer || options.find((o) => o && !isPlaceholder(o)) || options[0] || "";
      }
      let idx = options.findIndex((o) => o.toLowerCase() === String(answer).toLowerCase());
      if (idx < 0) {
        idx = options.findIndex(
          (o) =>
            o.toLowerCase().includes(String(answer).toLowerCase()) ||
            String(answer).toLowerCase().includes(o.toLowerCase())
        );
      }
      if (idx < 0) idx = options.findIndex((o) => o && !isPlaceholder(o));
      if (idx >= 0) {
        el.selectedIndex = idx;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    if (field.type === "radio") {
      const radios = field.elements || [];
      const ynCv = answerYesNoFromCv(label, profile.cvText || "", profile);
      let answer = (ynCv || direct || "").toLowerCase();
      if (!answer) {
        const res = await withTimeout(
          chrome.runtime.sendMessage({
            action: "generateAnswer",
            question: label,
            fieldType: "radio",
            options: field.options || [],
            jobInfo,
            cvText: profile.cvText || "",
          }),
          4000,
          null
        );
        answer = String(res?.answer || "").toLowerCase();
      }
      const wantNon = /^(non|no|false|0)\.?$/.test(answer) ||
        (/dipl[oô]me|certificat|infirmier|permis|habilitation|titulaire|avez-vous/i.test(label) &&
          !/^(oui|yes)/.test(answer));
      let target = wantNon
        ? radios.find((r, i) => /non|no|false|0/i.test(field.options[i] || ""))
        : radios.find((r, i) => /oui|yes|true|1/i.test(field.options[i] || ""));
      if (!target && answer) {
        target = radios.find((r, i) => (field.options[i] || "").toLowerCase().includes(answer));
      }
      // Credential unknown → Non; soft questions → Oui
      if (!target) {
        const isCred = /dipl[oô]me|certificat|infirmier|permis|habilitation|titulaire|avez-vous/i.test(label);
        target = isCred
          ? radios.find((r, i) => /non|no/i.test(field.options[i] || "")) || radios[radios.length - 1]
          : radios.find((r, i) => /oui|yes/i.test(field.options[i] || "")) || radios[0];
      }
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
            cvText: profile.cvText || "",
          }),
          6000,
          null
        );
        answer = res?.answer || "";
        if (!answer || /^(oui|yes|we|n\/?a)\.?$/i.test(String(answer).trim())) {
          const n = String(profile.experience || "").match(/(\d+)/);
          answer = n && Number(n[1]) > 0 ? n[1] : "3";
        }
        answer = coerceNumericAnswer(answer, "3");
      } else if (/url|link|linkedin/i.test(label)) answer = profile.linkedin || "https://www.linkedin.com";
      else if (/phone|téléphone|tel/i.test(label)) answer = profile.phone || "0612345678";
      else {
        const ynCv = answerYesNoFromCv(label, profile.cvText || "", profile);
        const res = await withTimeout(
          chrome.runtime.sendMessage({
            action: "generateAnswer",
            question: label,
            fieldType: field.type,
            options: [],
            jobInfo,
            cvText: profile.cvText || "",
          }),
          5000,
          null
        );
        answer = ynCv || res?.answer || "";
        if (/^(we|n\/?a|none|null)\.?$/i.test(String(answer).trim())) answer = "";
        if (!answer) {
          answer = /dipl[oô]me|certificat|infirmier|avez-vous/i.test(label) ? "Non" : "Oui";
        }
        // If AI returned a long sentence but the field looks like a short input, keep it short
        if (el.tagName === "INPUT" && String(answer).length > 40 && !/cover|motivation|message|pourquoi/i.test(label)) {
          answer = /dipl[oô]me|certificat|infirmier|avez-vous/i.test(label) ? "Non" : "Oui";
        }
        // If AI returned prose for something that looks like a date, force date format
        if (isDateFieldHint(hint, el) || /^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(el.placeholder || "")) {
          answer = formatDateAnswer(profile, el, hint);
        }
      }
    }
    if (field.type === "number" || wantsNumericAnswer(label, el)) {
      answer = coerceNumericAnswer(answer, "3");
    }
    // Overwrite invalid "1 an" / prose already in the field
    const cur = String(el.value || "").trim();
    if (wantsNumericAnswer(label, el) && cur && !/^\d+(\.\d+)?$/.test(cur)) {
      setNativeValue(el, "");
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
    let el = input;
    if (!el) return false;
    if (el.tagName !== "INPUT" || (el.getAttribute("type") || "").toLowerCase() !== "file") {
      el = el.querySelector?.('input[type="file"]') || null;
    }
    if (!el) return false;
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
      // React/Indeed often ignore plain `input.files = …` — set via native setter
      try {
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
        if (desc?.set) desc.set.call(el, dt.files);
        else el.files = dt.files;
      } catch (_e) {
        try {
          Object.defineProperty(el, "files", { configurable: true, value: dt.files });
        } catch (_e2) {
          el.files = dt.files;
        }
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      try {
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      } catch (_e) {}
      return !!(el.files && el.files.length > 0);
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
    wantsNumericAnswer,
    coerceNumericAnswer,
    answerYesNoFromCv,
    log(platform, msg, level = "info") {
      const ts = new Date().toISOString().slice(11, 23);
      console.log(`[AmiJobs ${platform} ${ts}] ${msg}`);
      chrome.runtime
        .sendMessage({ action: "addLog", platform, message: `[${ts}] ${msg}`, level })
        .catch(() => {});
    },
  };
})();
