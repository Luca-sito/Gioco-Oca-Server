"use strict";

window.VideochiamataDue = {
  dimensiona(larghezza, latoNaturale, laterale) {
    document.body.classList.toggle("videochiamata-laterale", laterale);
    const spazioVideo = Math.min(210, Math.max(116, larghezza * 0.18));
    const lato = laterale ? Math.min(latoNaturale, larghezza - 2 * (spazioVideo + 34)) : latoNaturale;
    document.documentElement.style.setProperty("--spazio-video", (larghezza - lato) / 2 - 20 + "px");
    return lato;
  }
};
