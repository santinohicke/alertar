// Íconos de línea propios (24 × 24, trazo del color del texto). En el HTML: <i class="ico" data-ico="nube"></i>
const TRAZOS = {
  nube: '<path d="M7 15a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 8a4 4 0 0 1 0 8H7z"/><path d="M8 19l-1 2M12 19l-1 2M16 19l-1 2"/>',
  ola: '<path d="M2 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M2 14c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M2 19c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>',
  barrera: '<rect x="2" y="7" width="20" height="6" rx="1"/><path d="M7 7l-3 6M12 7l-3 6M17 7l-3 6M22 8l-2.5 5M5 13v8M19 13v8"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  servidor: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>',
  candado: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4M12 15v2"/>',
  llave: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L20 3M16 7l3 3M14 9l2 2"/>',
  ojo: '<path d="M2 12s3.5-7 10-7c2 0 3.8.6 5.3 1.6M22 12s-3.5 7-10 7c-2 0-3.8-.6-5.3-1.6"/><path d="M3 3l18 18M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  escudo: '<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  reloj: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  sinwifi: '<path d="M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 10.3 5M5 12.5a10 10 0 0 1 5-2.4M19 12.5a10 10 0 0 0-2-1.5M8.5 16a5 5 0 0 1 7 0M12 20h.01M2 2l20 20"/>',
  gota: '<path d="M12 2.7l5.7 7.1a7 7 0 1 1-11.4 0z"/>',
  semaforo: '<rect x="7" y="2" width="10" height="20" rx="3"/><circle cx="12" cy="7" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="17" r="1.6"/>',
  prohibido: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  radar: '<circle cx="12" cy="12" r="1.5"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4M6 13l3-3 3 2 4-4"/>',
  auto: '<path d="M3 17v-4l2.2-5h13.6L21 13v4"/><path d="M3 13h18"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>',
  capas: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
};

export function ponerIconos(raiz = document) {
  raiz.querySelectorAll("i.ico[data-ico]").forEach(el => {
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${TRAZOS[el.dataset.ico] || ""}</svg>`;
  });
}
