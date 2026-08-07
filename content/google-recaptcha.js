// AmiJobs — Google reCAPTCHA checkbox clicker (v1.3.7)
(function () {
  if (window.__AmijobsRecaptchaLoaded) return;
  window.__AmijobsRecaptchaLoaded = true;

  function clickEl(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      const x = r.left + Math.min(28, Math.max(10, r.width * 0.15));
      const y = r.top + r.height / 2;
      const t = document.elementFromPoint(x, y) || el;
      const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, buttons: 1 };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        try {
          t.dispatchEvent(new MouseEvent(type, o));
        } catch (_e) {}
      }
      try {
        el.click();
      } catch (_e) {}
      return true;
    } catch (_e) {
      return false;
    }
  }

  function clickRecaptcha() {
    let clicked = 0;
    const anchors = [
      ...document.querySelectorAll(
        '#recaptcha-anchor, .recaptcha-checkbox, .recaptcha-checkbox-border, span[role="checkbox"]'
      ),
    ];
    for (const el of anchors) {
      if (clickEl(el)) clicked++;
    }
    // Checkbox inside google.com/recaptcha iframe body
    const cb = document.querySelector(".recaptcha-checkbox-border, #recaptcha-anchor");
    if (cb && clickEl(cb)) clicked++;

    // Parent page: click the iframe itself (often enough for checkbox widget)
    try {
      if (window.top && window.top !== window) {
        /* in iframe — already tried anchors */
      } else {
        for (const frame of document.querySelectorAll(
          'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], iframe[title*="recaptcha" i]'
        )) {
          if (clickEl(frame)) clicked++;
        }
      }
    } catch (_e) {}

    document.documentElement.setAttribute("data-amijobs-recaptcha", String(Date.now()));
    return clicked > 0;
  }

  window.__AmijobsClickRecaptcha = clickRecaptcha;

  // Auto-attempt on recaptcha frames
  if (/google\.com\/recaptcha|recaptcha\.net/i.test(location.href)) {
    const tryClick = () => clickRecaptcha();
    tryClick();
    setTimeout(tryClick, 800);
    setTimeout(tryClick, 2000);
  }
})();
