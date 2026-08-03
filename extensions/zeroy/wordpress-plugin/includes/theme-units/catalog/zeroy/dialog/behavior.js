document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const owner = target?.closest('[data-zeroy-behavior="dialog"]');
  if (!(owner instanceof Element)) return;
  const surface = owner.querySelector("[data-zeroy-surface]");
  if (!(surface instanceof HTMLDialogElement)) return;
  if (target?.closest("[data-zeroy-trigger]")) surface.showModal();
  if (target?.closest("[data-zeroy-close]")) surface.close();
});
