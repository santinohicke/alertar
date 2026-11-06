"use strict";

const $ = id => document.getElementById(id);

let activeView = "monitor";
let currentTunnel = "tunel-01";
let tunnelsList = [];
let monitorAbortController = null;
let running = false, timer, lastSuccess = 0, freshUntil = 0;
let historyPage = 1, historyLimit = 25, historyTotal = 0, historyLoading = false, historyEvents = [];
let exportLoading = false;
let statsLoading = false, statsRange = "24h";

/* Horas siempre en formato de 24 h. */
const H23 = { hourCycle: "h23" };

const fmtDate = v => v ? new Date(v).toLocaleString("es-AR", H23) : "Hora desconocida";

const validDate = v => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const eventDate = e =>
  validDate(e.medido_en) ||
  validDate(e.recibido_en);

const num1 = v =>
  Number(v).toLocaleString("es-AR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });

const pct = (n, d) =>
  d ? `${num1(n / d * 100)} %` : "0,0 %";


function height(e, n) {
  if (!e[`sensor${n}_valido`]) {
    return "Sensor inválido";
  }

  const v =
    Number(e[`obstruccion_carril${n}_cm`]);

  return Number.isFinite(v)
    ? `${num1(v)} cm`
    : "—";
}


function water(e) {
  return e.agua_activa
    ? "Crítica"
    : e.agua_pendiente
      ? "En confirmación"
      : "No detectada";
}


function cell(v) {
  const td =
    document.createElement("td");

  td.textContent =
    v ?? "—";

  return td;
}


function duration(v) {
  if (
    v === null ||
    !Number.isFinite(v)
  ) {
    return "—";
  }

  if (v < 1) {
    return `${Math.round(v * 1000)} ms`;
  }

  if (v < 60) {
    return `${num1(v)} s`;
  }

  if (v < 3600) {
    return `${Math.floor(v / 60)} min ${Math.round(v % 60)} s`;
  }

  return `${Math.floor(v / 3600)} h ${Math.floor((v % 3600) / 60)} min`;
}


function ageText(v) {
  const d =
    v instanceof Date
      ? v
      : validDate(v);

  if (!d) {
    return "Hora desconocida";
  }

  const s =
    Math.max(
      0,
      (Date.now() - d.getTime()) / 1000
    );

  if (s < 60) {
    return `Hace ${Math.round(s)} s`;
  }

  if (s < 3600) {
    return `Hace ${Math.floor(s / 60)} min`;
  }

  if (s < 86400) {
    return `Hace ${Math.floor(s / 3600)} h`;
  }

  return `Hace ${Math.floor(s / 86400)} días`;
}


function rangeMs(r) {
  return ({
    "1h": 3600000,
    "6h": 21600000,
    "24h": 86400000,
    "7d": 604800000
  })[r] ?? null;
}


function rangeText(r) {
  return ({
    "1h": "Última hora",
    "6h": "Últimas 6 horas",
    "24h": "Últimas 24 horas",
    "7d": "Últimos 7 días",
    all: "Todo el historial"
  })[r];
}


/* =========================================================
   PRESENTACIÓN: severidad, utilidades de DOM
   ========================================================= */

const POLL_MS = 5000;
const SVG_NS = "http://www.w3.org/2000/svg";

/* Severidad según tabla_logica.md: verde habilitado, amarillo precaución, rojo cierre. */
const CODE_INFO = {
  "OK-001": ["ok", "Situación normal"],
  "INF-001": ["ok", "Ocupación transitoria"],
  "ERR-001": ["crit", "Agua a cota crítica"],
  "ERR-002": ["warn", "Verificando agua"],
  "ERR-003": ["warn", "Falla de sensor ultrasónico"],
  "ERR-004": ["warn", "Obstrucción en ambos carriles"],
  "ERR-005": ["crit", "Ambos carriles bloqueados"],
  "ERR-006": ["warn", "Carril bloqueado (altura alta)"],
  "ERR-007": ["warn", "Obstrucción en un carril"]
};
const SIGNAL = {
  ok: "Paso habilitado",
  warn: "Precaución",
  crit: "Paso cerrado",
  unknown: "Sin confirmar"
};
const SEV_RANK = { unknown: 0, ok: 1, warn: 2, crit: 3 };

const sevOf = code => (CODE_INFO[code] || ["unknown"])[0];
const codeName = code => (CODE_INFO[code] || [null, "Código no documentado"])[1];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function svgEl(tag, attrs, cls) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  if (cls) n.setAttribute("class", cls);
  return n;
}

function chip(code) {
  const c = el("span", "chip", code || "—");
  c.dataset.sev = sevOf(code);
  c.title = codeName(code);
  return c;
}

/* Reinicia una animación CSS de una sola vez. */
function replay(node, cls) {
  if (!node) return;
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

function td(text, cls) {
  const c = el("td", cls, text ?? "—");
  return c;
}

function emptyRow(text, span) {
  const tr = el("tr", "empty");
  const c = td(text);
  c.colSpan = span;
  tr.append(c);
  return tr;
}

const fmtTime = v => {
  const d = validDate(v);
  if (!d) return "Hora desconocida";
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString("es-AR", H23)
    : d.toLocaleString("es-AR", { hourCycle: "h23", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

const sleep = ms => new Promise(r => setTimeout(r, ms));


/* =========================================================
   MONITOREO
   ========================================================= */

let lastSeq = null;        // última secuencia mostrada del paso actual
let lastCodeSev = null;    // severidad del último código vigente
let monitorTunnel = null;  // paso al que corresponden lastSeq / lastCodeSev
const siteSev = new Map(); // severidad conocida por paso (para la barra lateral)

function setStatus(sev, signal, vigencia) {
  const box = $("estado");
  box.dataset.sev = sev;
  document.querySelector(".readouts").toggleAttribute("data-stale", sev === "unknown");
  $("senal").textContent = signal;
  if (vigencia !== undefined) $("vigencia").textContent = vigencia;
  const t = tunnelsList.find(x => x.paso_id === currentTunnel);
  const name = t ? t.nombre : currentTunnel;
  document.title = sev === "warn" || sev === "crit"
    ? `${SIGNAL[sev]} · ${name} · AlertAR`
    : `${name} · Monitoreo · AlertAR`;
  siteSev.set(currentTunnel, sev);
  paintSiteDots();
}

/* Sin vigencia confirmada: se conserva el último dato pero no se colorea. */
function setStale(message) {
  freshUntil = 0;
  setStatus("unknown", SIGNAL.unknown, message);
}

function setLive(state, text) {
  const live = $("live");
  live.dataset.state = state;
  $("live-text").textContent = text;
  if (state === "ok") replay(live, "beat");
}

function setReadout(id, text, unit) {
  const node = $(id);
  const prev = node.dataset.v;
  const next = `${text}|${unit || ""}`;
  node.replaceChildren(document.createTextNode(text));
  if (unit) node.append(el("span", "unit", unit));
  if (prev !== undefined && prev !== next) replay(node, "flash");
  node.dataset.v = next;
}

function setLane(n, e) {
  const card = $(`readout-c${n}`);
  const gauge = $(`gauge${n}`);
  if (!e) {
    setReadout(`carril${n}`, "—");
    $(`valido${n}`).textContent = "Sin medición";
    gauge.style.transform = "scaleX(0)";
    delete card.dataset.sev;
    return;
  }
  if (!e[`sensor${n}_valido`]) {
    setReadout(`carril${n}`, "Inválido");
    $(`valido${n}`).textContent = "Sin lectura válida";
    gauge.style.transform = "scaleX(0)";
    card.dataset.sev = "warn";
    return;
  }
  const v = Number(e[`obstruccion_carril${n}_cm`]);
  if (!Number.isFinite(v)) {
    setReadout(`carril${n}`, "—");
    $(`valido${n}`).textContent = "Sin dato";
    gauge.style.transform = "scaleX(0)";
    delete card.dataset.sev;
    return;
  }
  setReadout(`carril${n}`, num1(v), "cm");
  $(`valido${n}`).textContent = v <= 5
    ? "Libre"
    : v > 100 ? "Obstrucción alta" : "Obstruido";
  gauge.style.transform = `scaleX(${Math.min(v / 250, 1)})`;
  gauge.dataset.level = v <= 5 ? "ok" : "warn";
  delete card.dataset.sev;
}

function setWater(e) {
  const card = $("readout-agua");
  const steps = $("agua-steps");
  if (!e) {
    setReadout("agua", "—");
    delete steps.dataset.level;
    delete card.dataset.sev;
    return;
  }
  const level = e.agua_activa ? 2 : e.agua_pendiente ? 1 : 0;
  setReadout("agua", water(e));
  steps.dataset.level = String(level);
  if (level === 2) card.dataset.sev = "crit";
  else if (level === 1) card.dataset.sev = "warn";
  else delete card.dataset.sev;
}

function renderMonitorEvents(eventsList, animateNew) {
  const evs = eventsList || [];
  if (!evs.length) {
    $("eventos").replaceChildren(emptyRow("Sin registros todavía", 6));
    return;
  }
  const rows = evs.map(item => {
    const tr = el("tr");
    const st = el("td");
    st.append(chip(item.codigo));
    const h1 = height(item, 1), h2 = height(item, 2);
    tr.append(
      td(fmtTime(item.medido_en), "t"),
      st,
      td(item.diagnostico, "diag"),
      td(h1, item.sensor1_valido ? "r" : "r bad"),
      td(h2, item.sensor2_valido ? "r" : "r bad"),
      td(String(item.secuencia), "r muted")
    );
    if (animateNew && lastSeq !== null && Number(item.secuencia) > lastSeq) tr.classList.add("is-new");
    return tr;
  });
  $("eventos").replaceChildren(...rows);
}

function renderMonitor(data) {
  const state = data.estado || {};
  const e = state.ultimo_estado_conocido;
  const sameTunnel = monitorTunnel === currentTunnel;
  monitorTunnel = currentTunnel;

  if (!e) {
    setStatus("unknown", "Sin datos", "La API está disponible; esperando al ESP32.");
    $("diagnostico").textContent = "Sin mediciones todavía";
    $("codigo").replaceChildren(document.createTextNode("—"));
    $("medido-en").textContent = "—";
    $("secuencia-actual").textContent = "—";
    setLane(1, null);
    setLane(2, null);
    setWater(null);
    renderMonitorEvents(data.eventos, false);
    lastSeq = null;
    lastCodeSev = null;
    return;
  }

  const fresh =
    state.comunicacion === "recepcion_reciente" &&
    state.actualidad_medicion === "reciente";

  freshUntil = fresh
    ? Date.now() + Math.max(0, 30 - Math.max(state.antiguedad_medicion_s, state.antiguedad_recepcion_s)) * 1000
    : 0;

  const codeSev = sevOf(e.codigo);
  const seq = Number(e.secuencia);
  const isNew = sameTunnel && lastSeq !== null && seq > lastSeq;
  const escalated = sameTunnel && fresh && lastCodeSev !== null &&
    (codeSev === "warn" || codeSev === "crit") &&
    SEV_RANK[codeSev] > SEV_RANK[lastCodeSev];

  const actualidad = {
    reciente: "medición reciente",
    desactualizada: "medición desactualizada",
    desconocida: "hora de medición desconocida"
  }[state.actualidad_medicion] || state.actualidad_medicion;
  const comunicacion = state.comunicacion === "recepcion_reciente" ? "recepción reciente" : "sin comunicación";

  if (fresh) {
    const age = Math.max(0, Math.round(state.antiguedad_recepcion_s || 0));
    setStatus(codeSev, SIGNAL[codeSev], `Medición vigente · recibida hace ${age} s`);
  } else {
    const edad = validDate(e.medido_en) ? ` (${ageText(e.medido_en).toLowerCase()})` : "";
    setStatus("unknown", SIGNAL.unknown, `Vigencia no confirmada · ${actualidad}${edad} · ${comunicacion}`);
  }

  const diag = $("diagnostico");
  if (diag.textContent !== e.diagnostico) diag.textContent = e.diagnostico;
  $("codigo").replaceChildren(chip(e.codigo));
  $("medido-en").textContent = fmtTime(e.medido_en);
  $("secuencia-actual").textContent = Number.isFinite(seq) ? seq.toLocaleString("es-AR") : "—";

  setLane(1, e);
  setLane(2, e);
  setWater(e);

  renderMonitorEvents(data.eventos, sameTunnel);

  if (escalated) replay($("estado"), "escalate");
  else if (isNew) replay($("estado"), "tick");

  lastSeq = Number.isFinite(seq) ? seq : lastSeq;
  if (fresh) lastCodeSev = codeSev;
}


async function refresh() {
  clearTimeout(timer);

  if (running || document.hidden || activeView !== "monitor") {
    return;
  }

  running = true;
  $("actualizar").disabled = true;
  $("actualizar").classList.add("is-busy");

  monitorAbortController = new AbortController();
  const reqTunnel = currentTunnel;
  const timeout = setTimeout(() => {
    if (monitorAbortController) monitorAbortController.abort();
  }, 8000);

  let delay = POLL_MS;

  try {
    const r = await fetch("/api/panel/" + encodeURIComponent(reqTunnel), {
      cache: "no-store",
      signal: monitorAbortController.signal
    });

    if (r.status === 401) {
      location.assign("/login");
      return;
    }
    if (r.status === 429 || r.status === 503) {
      delay = 30000;
    }
    if (!r.ok) {
      throw new Error("API no disponible");
    }

    const data = await r.json();
    if (reqTunnel !== currentTunnel) {
      return;
    }

    renderMonitor(data);
    lastSuccess = Date.now();
    const now = new Date().toLocaleTimeString("es-AR", H23);
    $("conexion").textContent = `Última consulta ${now}`;
    setLive("ok", `En vivo · ${new Date().toLocaleTimeString("es-AR", H23)}`);

  } catch (e) {
    if (e.name === "AbortError" && reqTunnel !== currentTunnel) {
      return;
    }
    console.error(e);
    setStale("Sin conexión con la API. Los valores mostrados son históricos.");
    $("conexion").textContent = "No se pudo actualizar. Reintentando sin acumular solicitudes…";
    setLive("error", "Sin conexión");

  } finally {
    clearTimeout(timeout);
    running = false;
    $("actualizar").disabled = false;
    $("actualizar").classList.remove("is-busy");

    if (!document.hidden && activeView === "monitor") {
      timer = setTimeout(refresh, delay);
    }
  }
}


/* =========================================================
   HISTORIAL
   ========================================================= */

/* El servidor limita las lecturas (429 + Retry-After). Se reintenta
   respetando la espera indicada en lugar de abortar la carga. */
async function fetchHistoryBatch(limit, offset) {
  const p = new URLSearchParams({ limite: String(limit), offset: String(offset) });

  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`/api/pasos/${encodeURIComponent(currentTunnel)}/historial?${p}`, { cache: "no-store" });

    if (r.status === 401) {
      location.assign("/login");
      throw new Error("Sesión finalizada");
    }
    if (r.status === 429 && attempt < 6) {
      const wait = Number(r.headers.get("Retry-After"));
      await sleep((Number.isFinite(wait) && wait > 0 ? wait : 2) * 1000);
      continue;
    }
    if (!r.ok) {
      throw new Error("No se pudo cargar el historial");
    }
    return r.json();
  }
}


async function fetchAllHistory(progress) {
  const rows = [];
  let offset = 0;
  let total = null;

  for (let i = 0; total === null || offset < total; i++) {
    // Las primeras solicitudes usan la ráfaga permitida; después se espacian
    // a ~3 por segundo para no agotar el límite compartido con el monitoreo.
    if (i >= 6) await sleep(320);

    const data = await fetchHistoryBatch(200, offset);
    if (total === null) total = Number(data.total) || 0;

    const events = Array.isArray(data.eventos) ? data.eventos : [];
    rows.push(...events);
    offset += events.length;

    if (progress) progress(rows.length, total);
    if (!events.length || events.length < 200) break;
  }
  return rows;
}


function renderHistory(events) {
  const tbody = $("historial-eventos");

  if (!events.length) {
    tbody.replaceChildren(emptyRow("Sin registros", 9));
    return;
  }

  const frag = document.createDocumentFragment();

  for (const item of events) {
    const tr = el("tr");
    const st = el("td");
    st.append(chip(item.codigo));

    const detailCell = el("td", "r");
    const btn = el("button", "link-btn", "JSON");
    btn.type = "button";
    btn.setAttribute("aria-expanded", "false");
    detailCell.append(btn);

    const h1 = height(item, 1), h2 = height(item, 2);
    tr.append(
      td(fmtDate(item.medido_en), "t"),
      td(fmtDate(item.recibido_en), "t"),
      st,
      td(item.diagnostico, "diag"),
      td(water(item), item.agua_activa ? "bad" : item.agua_pendiente ? "bad" : undefined),
      td(h1, item.sensor1_valido ? "r" : "r bad"),
      td(h2, item.sensor2_valido ? "r" : "r bad"),
      td(item.secuencia, "r muted"),
      detailCell
    );

    const detailRow = el("tr", "detail-row");
    detailRow.hidden = true;
    const cellJson = el("td");
    cellJson.colSpan = 9;
    const box = el("div", "json-container");
    box.append(el("pre", null, JSON.stringify(item, null, 2)));
    cellJson.append(box);
    detailRow.append(cellJson);

    btn.addEventListener("click", () => {
      detailRow.hidden = !detailRow.hidden;
      btn.textContent = detailRow.hidden ? "JSON" : "Ocultar";
      btn.setAttribute("aria-expanded", detailRow.hidden ? "false" : "true");
    });

    frag.append(tr, detailRow);
  }

  tbody.replaceChildren(frag);
}


function updatePagination() {
  const pages = Math.max(1, Math.ceil(historyTotal / historyLimit));
  historyPage = Math.min(Math.max(historyPage, 1), pages);

  $("pagina-info").textContent = historyTotal
    ? `Página ${historyPage} de ${pages.toLocaleString("es-AR")}`
    : "Página 1 de 1";
  $("pagina-numero").value = historyPage;
  $("pagina-numero").max = pages;

  $("pagina-primera").disabled = historyLoading || historyPage <= 1;
  $("pagina-anterior").disabled = historyLoading || historyPage <= 1;
  $("pagina-siguiente").disabled = historyLoading || historyPage >= pages;
  $("pagina-ultima").disabled = historyLoading || historyPage >= pages;

  if (!historyTotal) {
    $("historial-rango").textContent = "0 registros";
    return;
  }
  const first = (historyPage - 1) * historyLimit + 1;
  const last = Math.min(historyPage * historyLimit, historyTotal);
  $("historial-rango").textContent =
    `Mostrando ${first.toLocaleString("es-AR")}–${last.toLocaleString("es-AR")} de ${historyTotal.toLocaleString("es-AR")} registros`;
}


async function loadHistory() {
  if (historyLoading) {
    return;
  }
  historyLoading = true;
  $("historial-actualizar").disabled = true;
  $("historial-actualizar").classList.add("is-busy");
  updatePagination();
  $("historial-estado").textContent = "Cargando…";

  try {
    const data = await fetchHistoryBatch(historyLimit, (historyPage - 1) * historyLimit);
    historyTotal = Number(data.total) || 0;
    historyEvents = Array.isArray(data.eventos) ? data.eventos : [];

    const pages = Math.max(1, Math.ceil(historyTotal / historyLimit));
    if (historyPage > pages && historyTotal > 0) {
      historyPage = pages;
      historyLoading = false;
      return loadHistory();
    }

    renderHistory(historyEvents);
    $("historial-total").textContent = historyTotal.toLocaleString("es-AR");
    $("historial-estado").textContent = `Actualizado ${new Date().toLocaleTimeString("es-AR", H23)}`;

  } catch (e) {
    console.error(e);
    $("historial-estado").textContent = "No se pudo cargar el historial";

  } finally {
    historyLoading = false;
    $("historial-actualizar").disabled = false;
    $("historial-actualizar").classList.remove("is-busy");
    updatePagination();
  }
}


/* =========================================================
   EXPORTACIÓN
   ========================================================= */

function csvEscape(v) {
  if (
    v === null ||
    v === undefined
  ) {
    return "";
  }


  let s =
    typeof v === "object"
      ? JSON.stringify(v)
      : String(v);


  if (/[",\n\r]/.test(s)) {
    s =
      `"${s.replaceAll('"', '""')}"`;
  }


  return s;
}


function csvFromRows(rows) {
  if (!rows.length) {
    return "";
  }


  const preferred = [
    "evento_id",
    "dispositivo_id",
    "paso_id",
    "secuencia",
    "recibido_en",
    "medido_en",
    "codigo",
    "diagnostico",
    "agua_activa",
    "agua_pendiente",
    "obstruccion_carril1_cm",
    "obstruccion_carril2_cm",
    "sensor1_valido",
    "sensor2_valido",
    "uptime_ms",
    "arranque_id",
    "version"
  ];


  const set =
    new Set(
      rows.flatMap(
        r => Object.keys(r)
      )
    );


  const keys = [];


  for (const k of preferred) {
    if (set.delete(k)) {
      keys.push(k);
    }
  }


  keys.push(
    ...[...set].sort()
  );


  return [
    keys
      .map(csvEscape)
      .join(","),

    ...rows.map(
      r =>
        keys
          .map(
            k => csvEscape(r[k])
          )
          .join(",")
    )
  ].join("\r\n");
}


function downloadFile(
  name,
  content,
  type
) {
  const url =
    URL.createObjectURL(
      new Blob(
        [content],
        {type}
      )
    );


  const a =
    document.createElement("a");


  a.href = url;
  a.download = name;


  document.body.append(a);

  a.click();

  a.remove();


  setTimeout(
    () =>
      URL.revokeObjectURL(url),
    1000
  );
}


async function exportHistory() {
  if (exportLoading) {
    return;
  }


  exportLoading = true;


  $("exportar").disabled =
    true;

  $("export-formato").disabled =
    true;

  $("export-cantidad").disabled =
    true;


  try {
    const sel =
      $("export-cantidad").value;


    let rows;


    if (sel === "pagina") {
      rows =
        [...historyEvents];

    } else if (
      sel === "todos"
    ) {
      rows =
        await fetchAllHistory(
          (n, t) => {
            $("export-estado").textContent =
              `Cargando ${n.toLocaleString("es-AR")} de ${t.toLocaleString("es-AR")} registros…`;
          }
        );

    } else {
      const data =
        await fetchHistoryBatch(
          Number(sel),
          0
        );


      rows =
        Array.isArray(data.eventos)
          ? data.eventos
          : [];
    }


    if (!rows.length) {
      $("export-estado").textContent =
        "No hay registros para exportar";

      return;
    }


    const now =
      new Date();


    const d =
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;


    if (
      $("export-formato").value === "json"
    ) {
      downloadFile(
        `alertar_eventos_${d}.json`,
        JSON.stringify(
          rows,
          null,
          2
        ),
        "application/json;charset=utf-8"
      );

    } else {
      downloadFile(
        `alertar_eventos_${d}.csv`,
        "\uFEFF" +
        csvFromRows(rows),
        "text/csv;charset=utf-8"
      );
    }


    $("export-estado").textContent =
      `${rows.length.toLocaleString("es-AR")} registros exportados`;

  } catch (e) {
    console.error(e);

    $("export-estado").textContent =
      "No se pudo completar la exportación";

  } finally {
    exportLoading = false;

    $("exportar").disabled =
      false;

    $("export-formato").disabled =
      false;

    $("export-cantidad").disabled =
      false;
  }
}


/* =========================================================
   ESTADÍSTICAS
   ========================================================= */

function renderCodeBars(codes, total) {
  const c = $("stats-codigos");

  if (!total) {
    c.replaceChildren(el("p", "chart-empty", "Sin datos en este rango"));
    return;
  }

  const entries = [...codes.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  // Barra apilada: proporción de tiempo de cada código, agrupada por severidad.
  const stack = el("div", "code-stack");
  const stackOrder = [...entries].sort((a, b) => SEV_RANK[sevOf(a[0])] - SEV_RANK[sevOf(b[0])] || b[1] - a[1]);
  const parts = stackOrder.map(([code, v]) => {
    const s = el("span");
    s.dataset.sev = sevOf(code);
    s.title = `${code} · ${pct(v, total)}`;
    s.style.flexGrow = "0";
    s.style.flexBasis = "0";
    stack.append(s);
    return [s, v];
  });

  const rows = el("div", "code-rows");
  const fills = entries.map(([code, v]) => {
    const row = el("div", "code-row");
    const label = el("div", "code-label");
    const bar = el("div", "code-bar");
    const fill = el("i");
    fill.dataset.sev = sevOf(code);
    bar.append(fill);
    label.append(el("span", "code-name", codeName(code)), bar);
    row.append(chip(code), label, el("span", "code-time", duration(v)), el("span", "code-pct", pct(v, total)));
    rows.append(row);
    return [fill, v];
  });

  c.replaceChildren(stack, rows);

  // Las barras crecen desde cero en el cuadro siguiente.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    parts.forEach(([s, v]) => { s.style.flexGrow = String(v); });
    fills.forEach(([f, v]) => { f.style.transform = `scaleX(${Math.max(v / total, 0.006)})`; });
  }));
}


function activityLabel(ts, ms) {
  const d = new Date(ts);
  if (ms <= 3600000) {
    return d.toLocaleTimeString("es-AR", { hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  }
  if (ms < 86400000) {
    return d.toLocaleString("es-AR", { hourCycle: "h23", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });
}


function chartWidth(box) {
  return Math.max(320, Math.round(box.clientWidth || 960));
}

function emptyChart(box, text) {
  box.replaceChildren(el("p", "chart-empty", text));
}

/* Escala "redonda" para ejes: 1, 2, 5 × 10^n. */
function niceStep(max, ticks) {
  const raw = max / Math.max(1, ticks);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

function renderActivity(agg, animate) {
  const box = $("stats-actividad");
  const act = agg.actividad;
  if (!act || !act.bloques.length) {
    $("actividad-resolucion").textContent = "—";
    $("stats-actividad-detalle").textContent = "";
    emptyChart(box, "Sin datos en este rango");
    return;
  }
  const ms = act.bloque_ms;
  $("actividad-resolucion").textContent = act.nombre;
  const start = act.inicio, end = act.fin;
  const pts = act.bloques.map((b, i) => [start + i * ms, { n: b[0], ok: b[1], warn: b[2], crit: b[3], unknown: b[4] }]);
  const segs = agg.estado.map(([t0, t1, sev]) => ({ t0, t1, sev }));

  const W = chartWidth(box);
  const L = 40, R = 8;
  const RIB_Y = 4, RIB_H = 14;
  const T = RIB_Y + RIB_H + 18;
  const PH = 150;
  const H = T + PH + 26;
  const pw = W - L - R;
  const bw = pw / pts.length;
  const x = t => L + (t - start) / (end - start) * pw;

  const maxN = Math.max(1, ...pts.map(p => p[1].n));
  const step = niceStep(maxN, 3);
  const top = Math.ceil(maxN / step) * step;
  const y = v => T + PH - v / top * PH;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Estado del paso y eventos por intervalo" });

  // Cinta de estado
  const ribbon = svgEl("g", {}, animate ? "ribbon" : "");
  ribbon.append(svgEl("rect", { x: L, y: RIB_Y, width: pw, height: RIB_H, rx: 2 }, "ribbon-bg"));
  for (const s of segs) {
    const a = Math.max(s.t0, start), b = Math.min(s.t1, end);
    if (b <= a) continue;
    const x0 = x(a);
    ribbon.append(svgEl("rect", { x: x0, y: RIB_Y, width: Math.max(x(b) - x0, 0.8), height: RIB_H }, `ribbon-${s.sev}`));
  }
  svg.append(ribbon);
  const rl = svgEl("text", { x: L - 6, y: RIB_Y + RIB_H - 3, "text-anchor": "end" }, "axis-text");
  rl.textContent = "Estado";
  svg.append(rl);

  // Ejes y grilla
  for (let v = 0; v <= top; v += step) {
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v) }, v === 0 ? "base-line" : "grid-line"));
    const lab = svgEl("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, "axis-text");
    lab.textContent = v.toLocaleString("es-AR");
    svg.append(lab);
  }

  const band = svgEl("rect", { x: 0, y: RIB_Y - 2, width: 0, height: T + PH - RIB_Y + 2, visibility: "hidden" }, "hover-band");
  svg.append(band);

  // Barras
  const bars = svgEl("g", {}, animate ? "bars" : "");
  const gap = bw > 6 ? Math.min(4, bw * 0.25) : 1;
  const barEls = pts.map(([, b], i) => {
    const h = b.n / top * PH;
    const r = svgEl("rect", {
      x: L + i * bw + gap / 2, y: T + PH - h,
      width: Math.max(1, bw - gap), height: Math.max(b.n ? 1.5 : 0, h), rx: bw > 8 ? 2 : 0
    }, "bar");
    bars.append(r);
    return r;
  });
  svg.append(bars);

  // Etiquetas de tiempo (sin rotar; las que entran)
  const every = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(pw / 96))));
  pts.forEach(([ts], i) => {
    if (i % every) return;
    const lab = svgEl("text", { x: L + i * bw + bw / 2, y: H - 6, "text-anchor": "middle" }, "axis-text");
    lab.textContent = activityLabel(ts, ms);
    svg.append(lab);
  });

  // Interacción: un área por bloque
  const readout = $("stats-actividad-detalle");
  const defaultText = "";
  let hot = null;
  const show = i => {
    const [ts, b] = pts[i];
    if (hot) hot.classList.remove("hot");
    hot = barEls[i];
    hot.classList.add("hot");
    band.setAttribute("x", L + i * bw);
    band.setAttribute("width", bw);
    band.setAttribute("visibility", "visible");
    const covered = b.ok + b.warn + b.crit + b.unknown;
    const parts = [["ok", "habilitado"], ["warn", "precaución"], ["crit", "cerrado"]]
      .filter(([k]) => b[k] > 0)
      .map(([k, name]) => `${name} ${pct(b[k], covered)}`);
    const range = `${activityLabel(ts, ms)} – ${activityLabel(ts + ms, ms)}`;
    readout.textContent = `${range} · ${b.n.toLocaleString("es-AR")} eventos` +
      (parts.length ? ` · ${parts.join(" · ")}` : " · sin datos de estado");
  };
  const hide = () => {
    if (hot) hot.classList.remove("hot");
    hot = null;
    band.setAttribute("visibility", "hidden");
    readout.textContent = defaultText;
  };
  pts.forEach((_, i) => {
    const hit = svgEl("rect", { x: L + i * bw, y: 0, width: bw, height: T + PH, tabindex: "0" }, "hit");
    hit.addEventListener("mouseenter", () => show(i));
    hit.addEventListener("focus", () => show(i));
    hit.addEventListener("click", () => show(i));
    svg.append(hit);
  });
  svg.addEventListener("mouseleave", hide);

  box.replaceChildren(svg);
  readout.textContent = defaultText;
}


function renderObstruction(agg, animate) {
  const box = $("stats-obstruccion");
  const readout = $("stats-obstruccion-detalle");
  const defaultText = "";
  readout.textContent = defaultText;

  const pts = (agg.obstruccion.puntos || []).map(([t, c1, c2, tEnd]) => ({ t, c1, c2, tEnd }));
  if (pts.length < 2) {
    emptyChart(box, agg.total ? "Sin mediciones válidas en este rango" : "Sin datos en este rango");
    return;
  }

  const W = chartWidth(box);
  const L = 56, R = 12, T = 12, PH = 200;
  const H = T + PH + 26;
  const pw = W - L - R;

  const minT = pts[0].t;
  const maxT = pts[pts.length - 1].t;
  const span = Math.max(1, maxT - minT);
  // El servidor ya redujo la serie tomando el máximo de cada bloque.
  const bucketMs = agg.obstruccion.bloque_ms || span / pts.length;

  const maxV = Math.max(0, ...pts.flatMap(p => [p.c1, p.c2].filter(v => v !== null)));
  const ceiling = Math.max(120, maxV * 1.08);
  const step = niceStep(ceiling, 4);
  const top = Math.ceil(ceiling / step) * step;

  const x = t => L + (t - minT) / span * pw;
  const y = v => T + PH - v / top * PH;
  const breakGap = Math.max(bucketMs * 3, 60000);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Obstrucción por carril" });

  for (let v = 0; v <= top; v += step) {
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v) }, v === 0 ? "base-line" : "grid-line"));
    const lab = svgEl("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, "axis-text");
    lab.textContent = v + step > top ? `${v.toLocaleString("es-AR")} cm` : v.toLocaleString("es-AR");
    svg.append(lab);
  }

  // Referencias de la tabla lógica
  [[100, "100 cm · obstrucción alta"], [5, "5 cm · libre"]].forEach(([v, label]) => {
    if (v > top) return;
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v) }, "ref-line"));
    if (y(0) - y(v) < 16) return; // la etiqueta no entra sobre el eje
    const t = svgEl("text", { x: W - R - 4, y: y(v) - 5, "text-anchor": "end" }, "ref-text");
    t.textContent = label;
    svg.append(t);
  });

  const series = field => {
    let line = "", area = "", open = false, first = null, prev = null;
    const close = () => {
      if (open && first !== null) area += ` L ${x(prev.t)} ${y(0)} L ${x(first.t)} ${y(0)} Z`;
      open = false; first = null;
    };
    for (const p of pts) {
      const v = p[field];
      if (v === null || (prev && p.t - prev.t > breakGap)) close();
      if (v === null) { prev = p; continue; }
      if (!open) {
        line += ` M ${x(p.t).toFixed(1)} ${y(v).toFixed(1)}`;
        area += ` M ${x(p.t).toFixed(1)} ${y(v).toFixed(1)}`;
        open = true; first = p;
      } else {
        line += ` L ${x(p.t).toFixed(1)} ${y(v).toFixed(1)}`;
        area += ` L ${x(p.t).toFixed(1)} ${y(v).toFixed(1)}`;
      }
      prev = p;
    }
    close();
    return { line: line.trim(), area: area.trim() };
  };

  const lines = [];
  for (const [field, cls] of [["c2", "c2"], ["c1", "c1"]]) {
    const s = series(field);
    if (!s.line) continue;
    svg.append(svgEl("path", { d: s.area }, `area-${cls}`));
    const path = svgEl("path", { d: s.line }, `line line-${cls}`);
    svg.append(path);
    lines.push(path);
  }

  [0, .25, .5, .75, 1].forEach(r => {
    const ts = minT + span * r;
    const lab = svgEl("text", { x: L + pw * r, y: H - 6, "text-anchor": r === 0 ? "start" : r === 1 ? "end" : "middle" }, "axis-text");
    lab.textContent = new Date(ts).toLocaleString("es-AR", { hourCycle: "h23", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    svg.append(lab);
  });

  // Cursor
  const cross = svgEl("line", { x1: 0, x2: 0, y1: T, y2: T + PH, visibility: "hidden" }, "crosshair");
  const d1 = svgEl("circle", { r: 4, cx: 0, cy: 0, visibility: "hidden" }, "dot-c1");
  const d2 = svgEl("circle", { r: 4, cx: 0, cy: 0, visibility: "hidden" }, "dot-c2");
  svg.append(cross, d2, d1);

  const hit = svgEl("rect", { x: L, y: T, width: pw, height: PH }, "hit");
  svg.append(hit);

  const nearest = t => {
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t < t) lo = mid; else hi = mid;
    }
    return Math.abs(pts[lo].t - t) <= Math.abs(pts[hi].t - t) ? pts[lo] : pts[hi];
  };
  const cm = v => v === null ? "sin lectura" : `${num1(v)} cm`;
  hit.addEventListener("mousemove", ev => {
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (W / rect.width);
    const p = nearest(minT + (px - L) / pw * span);
    const cx = x(p.t);
    cross.setAttribute("x1", cx);
    cross.setAttribute("x2", cx);
    cross.setAttribute("visibility", "visible");
    for (const [dot, v] of [[d1, p.c1], [d2, p.c2]]) {
      if (v === null) { dot.setAttribute("visibility", "hidden"); continue; }
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", y(v));
      dot.setAttribute("visibility", "visible");
    }
    readout.textContent = `${new Date(p.t).toLocaleString("es-AR", H23)} · Carril 1: ${cm(p.c1)} · Carril 2: ${cm(p.c2)}` +
      (p.tEnd > p.t ? " · máximo del intervalo" : "");
  });
  hit.addEventListener("mouseleave", () => {
    [cross, d1, d2].forEach(n => n.setAttribute("visibility", "hidden"));
    readout.textContent = defaultText;
  });

  box.replaceChildren(svg);

  if (animate) {
    for (const path of lines) {
      const len = Math.ceil(path.getTotalLength());
      path.style.setProperty("--len", String(len));
      path.classList.add("draw");
    }
  }
}


/* ---------- KPI animados ---------- */

const kpiFrames = new Map();

/* Números y porcentajes cuentan desde el valor anterior; el resto cambia con un fundido. */
function setKpi(id, value, format) {
  const node = $(id);
  if (typeof value === "number" && Number.isFinite(value)) {
    const from = Number(node.dataset.v);
    node.dataset.v = String(value);
    cancelAnimationFrame(kpiFrames.get(id));
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!Number.isFinite(from) || from === value || reduce) {
      node.textContent = format(value);
      if (!Number.isFinite(from)) replay(node, "swap");
      return;
    }
    const t0 = performance.now();
    const dur = 450;
    const tick = now => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - (1 - k) ** 3;
      node.textContent = format(from + (value - from) * e);
      if (k < 1) kpiFrames.set(id, requestAnimationFrame(tick));
      else node.textContent = format(value);
    };
    kpiFrames.set(id, requestAnimationFrame(tick));
    return;
  }
  const text = String(value);
  delete node.dataset.v;
  if (node.textContent !== text) {
    node.textContent = text;
    replay(node, "swap");
  }
}

const fmtInt = v => Math.round(v).toLocaleString("es-AR");
const fmtPct = v => `${num1(v)} %`;
const cmOrDash = v => v === null ? "—" : `${num1(v)} cm`;

function setProgress(n, total) {
  const bar = $("stats-progress");
  if (n === null) {
    bar.hidden = true;
    $("stats-progress-bar").style.transform = "scaleX(0)";
    return;
  }
  bar.hidden = false;
  $("stats-progress-bar").style.transform = `scaleX(${total ? Math.min(1, n / total) : 0.05})`;
}

let statsAgg = null;          // último resumen dibujado
let statsAnimateNext = false; // la entrada de los gráficos se ve solo al cargar un paso nuevo
let statsPedido = 0;
const statsCache = new Map(); // "paso|rango" -> { agg, t }
const STATS_CACHE_MS = 60000;

function drawCharts(agg, animate) {
  if (!agg) return;
  renderActivity(agg, animate);
  renderObstruction(agg, animate);
}

function pintarEstadisticas(agg) {
  statsAgg = agg;
  document.querySelectorAll(".range-button").forEach(b =>
    b.classList.toggle("active", b.dataset.range === statsRange)
  );
  $("stats-range-label").textContent = rangeText(statsRange);

  const m = agg.monitoreado_s;
  setKpi("stat-total", agg.total, fmtInt);
  setKpi("stat-base", agg.total_base, fmtInt);
  setKpi("stat-arranques", agg.arranques, fmtInt);
  setKpi("stat-normal", m ? agg.normal_s / m * 100 : 0, fmtPct);
  setKpi("stat-agua", duration(agg.agua_s));
  setKpi("stat-monitoreado", duration(m));
  const ultima = validDate(agg.ultima_recepcion);
  setKpi("stat-ultima", ultima ? ultima.toLocaleString("es-AR", H23) : "—");
  $("stat-ultima-edad").textContent = ultima ? ageText(ultima) : "Sin datos en el rango";

  setKpi("stat-sensor1", m ? agg.valido1_s / m * 100 : 0, fmtPct);
  setKpi("stat-sensor2", m ? agg.valido2_s / m * 100 : 0, fmtPct);
  setKpi("stat-c1-prom", cmOrDash(agg.carril1.promedio));
  setKpi("stat-c1-max", cmOrDash(agg.carril1.maximo));
  setKpi("stat-c2-prom", cmOrDash(agg.carril2.promedio));
  setKpi("stat-c2-max", cmOrDash(agg.carril2.maximo));
  setKpi("stat-delay-prom", duration(agg.demora.promedio));
  setKpi("stat-delay-max", duration(agg.demora.maximo));
  setKpi("stat-gaps", agg.saltos, fmtInt);
  setKpi("stat-sin-fecha", agg.sin_fecha, fmtInt);

  renderCodeBars(new Map(agg.codigos), m);
  drawCharts(agg, statsAnimateNext);
  if (!statsAnimateNext) {
    replay($("stats-actividad"), "fade");
    replay($("stats-obstruccion"), "fade");
  }
  statsAnimateNext = false;

  const hora = new Date(agg.hasta).toLocaleTimeString("es-AR", { hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  $("stats-estado").textContent = `Actualizado ${hora}`;
}

/* Muestra el rango elegido (los botones de rango llaman a esta función). */
function renderStats() {
  loadStats();
}

async function loadStats(force = false) {
  const paso = currentTunnel, rango = statsRange;
  const clave = `${paso}|${rango}`;
  const guardado = statsCache.get(clave);
  if (guardado && !force && Date.now() - guardado.t < STATS_CACHE_MS) {
    if (!statsAgg || statsAgg.paso_id !== paso) statsAnimateNext = true;
    pintarEstadisticas(guardado.agg);
    return;
  }

  const pedido = ++statsPedido;
  statsLoading = true;
  $("stats-actualizar").disabled = true;
  $("stats-actualizar").classList.add("is-busy");
  $("stats-body").classList.add("updating");
  $("stats-estado").textContent = "Cargando…";
  setProgress(0.35, 1);

  try {
    const url = `/api/pasos/${encodeURIComponent(paso)}/estadisticas?rango=${encodeURIComponent(rango)}`;
    let r;
    for (let intento = 0; ; intento++) {
      r = await fetch(url, { cache: "no-store" });
      if (r.status !== 429 || intento >= 4) break;
      const espera = Number(r.headers.get("Retry-After"));
      await sleep((Number.isFinite(espera) && espera > 0 ? espera : 2) * 1000);
    }
    if (r.status === 401) {
      location.assign("/login");
      return;
    }
    if (!r.ok) throw new Error("No se pudieron calcular las estadísticas");
    const agg = await r.json();
    statsCache.set(clave, { agg, t: Date.now() });
    if (pedido !== statsPedido || paso !== currentTunnel || rango !== statsRange) return;
    setProgress(1, 1);
    if (!statsAgg || statsAgg.paso_id !== paso) statsAnimateNext = true;
    $("stats-body").classList.remove("updating");
    pintarEstadisticas(agg);

  } catch (e) {
    console.error(e);
    if (pedido === statsPedido) $("stats-estado").textContent = "No se pudieron calcular las estadísticas";

  } finally {
    if (pedido === statsPedido) {
      statsLoading = false;
      $("stats-actualizar").disabled = false;
      $("stats-actualizar").classList.remove("is-busy");
      $("stats-body").classList.remove("updating");
      setTimeout(() => setProgress(null), 250);
    }
  }
}


/* =========================================================
   NAVEGACIÓN
   ========================================================= */

const VIEW_TITLES = { historial: "Historial", estadisticas: "Estadísticas", mapa: "Mapa" };

function switchView(view) {
  if (!["monitor", "historial", "estadisticas", "mapa"].includes(view)) {
    return;
  }
  activeView = view;

  const pane = $(`vista-${view}`);
  if (pane.hidden) replay(pane, "entering");
  if (view !== "monitor") {
    const t = tunnelsList.find(x => x.paso_id === currentTunnel);
    document.title = `${t ? t.nombre : currentTunnel} · ${VIEW_TITLES[view]} · AlertAR`;
  }

  for (const v of ["monitor", "historial", "estadisticas", "mapa"]) {
    $(`vista-${v}`).hidden = v !== view;
  }

  document.querySelectorAll(".tab").forEach(b => {
    const active = b.dataset.view === view;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });

  clearTimeout(timer);
  clearTimeout(mapTimer);

  if (view === "monitor") {
    refresh();
  } else if (view === "historial") {
    loadHistory();
  } else if (view === "estadisticas") {
    loadStats();
  } else {
    refreshMapa();
  }
}


/*
 * Dejamos switchView expuesto también para poder
 * probarlo fácilmente desde la consola del navegador.
 */
window.switchView =
  switchView;


/* =========================================================
   EVENTOS UI
   ========================================================= */

$("actualizar")
  .addEventListener(
    "click",
    refresh
  );


$("historial-actualizar")
  .addEventListener(
    "click",
    loadHistory
  );


$("exportar")
  .addEventListener(
    "click",
    exportHistory
  );


$("stats-actualizar")
  .addEventListener(
    "click",
    () =>
      loadStats(true)
  );


$("historial-limite")
  .addEventListener(
    "change",
    () => {
      historyLimit =
        Number(
          $("historial-limite").value
        );

      historyPage = 1;

      loadHistory();
    }
  );


$("pagina-primera")
  .addEventListener(
    "click",
    () => {
      historyPage = 1;
      loadHistory();
    }
  );


$("pagina-anterior")
  .addEventListener(
    "click",
    () => {
      if (
        historyPage > 1
      ) {
        historyPage--;

        loadHistory();
      }
    }
  );


$("pagina-siguiente")
  .addEventListener(
    "click",
    () => {
      const pages =
        Math.max(
          1,
          Math.ceil(
            historyTotal /
            historyLimit
          )
        );


      if (
        historyPage <
        pages
      ) {
        historyPage++;

        loadHistory();
      }
    }
  );


$("pagina-ultima")
  .addEventListener(
    "click",
    () => {
      historyPage =
        Math.max(
          1,
          Math.ceil(
            historyTotal /
            historyLimit
          )
        );

      loadHistory();
    }
  );


$("pagina-ir")
  .addEventListener(
    "click",
    () => {
      const pages =
        Math.max(
          1,
          Math.ceil(
            historyTotal /
            historyLimit
          )
        );


      let n =
        Math.floor(
          Number(
            $("pagina-numero").value
          ) || 1
        );


      historyPage =
        Math.min(
          Math.max(
            n,
            1
          ),
          pages
        );


      loadHistory();
    }
  );


$("pagina-numero")
  .addEventListener(
    "keydown",
    e => {
      if (
        e.key === "Enter"
      ) {
        $("pagina-ir").click();
      }
    }
  );


document
  .querySelectorAll(
    ".range-button"
  )
  .forEach(
    b =>
      b.addEventListener(
        "click",
        () => {
          statsRange =
            b.dataset.range;

          renderStats();
        }
      )
  );


document
  .querySelectorAll(".tab")
  .forEach(
    b =>
      b.addEventListener(
        "click",
        () =>
          switchView(
            b.dataset.view
          )
      )
  );


document.addEventListener("visibilitychange", () => {
  clearTimeout(timer);
  if (!document.hidden && activeView === "monitor") {
    if (Date.now() - lastSuccess > 30000) {
      setStale("Verificando vigencia de los datos…");
    }
    refresh();
  }
  if (!document.hidden && activeView === "mapa") {
    refreshMapa();
  }
});


setInterval(() => {
  if (freshUntil && Date.now() >= freshUntil) {
    setStale("Medición desactualizada. Esperando información reciente.");
  }
}, 1000);


/* Los gráficos se dibujan al ancho real para que el texto no se achique. */
let resizeTimer = null;
let lastChartWidth = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (activeView === "mapa" && mapaVista) mapaVista.refit();
    const w = $("stats-actividad").clientWidth;
    if (activeView === "estadisticas" && statsAgg && Math.abs(w - lastChartWidth) > 8) {
      lastChartWidth = w;
      drawCharts(statsAgg, false);
    }
  }, 150);
});


/* =========================================================
   GESTIÓN MULTI-TÚNEL
   ========================================================= */

async function cargarTuneles() {
  try {
    const res = await fetch("/api/tuneles");
    if (res.status === 401) {
      location.assign("/login");
      return;
    }
    if (!res.ok) throw new Error("Error cargando túneles");
    const data = await res.json();
    tunnelsList = data.tuneles || [];

    if (!tunnelsList.some(t => t.paso_id === currentTunnel) && tunnelsList.length > 0) {
      currentTunnel = tunnelsList[0].paso_id;
    }
    aplicarEstados(tunnelsList);

    renderTunelesPills();
    actualizarHeaderTunel();
  } catch (err) {
    console.error("Error al obtener túneles:", err);
  }
}

function actualizarHeaderTunel() {
  const tunel = tunnelsList.find(t => t.paso_id === currentTunnel);
  if (tunel) {
    $("header-tunnel-name").textContent = tunel.nombre;
    const partes = [tunel.ubicacion, tunel.dispositivo_id.toUpperCase(), tunel.paso_id].filter(Boolean);
    $("header-tunnel-subtitle").textContent = partes.join(" · ");
  }
  const mapa = $("header-tunnel-map");
  const conCoords = tunel && tunel.latitud !== null && tunel.longitud !== null &&
    tunel.latitud !== undefined && tunel.longitud !== undefined;
  mapa.hidden = !conCoords;
  if (conCoords) {
    mapa.href = `https://www.openstreetmap.org/?mlat=${tunel.latitud}&mlon=${tunel.longitud}#map=17/${tunel.latitud}/${tunel.longitud}`;
  }
  renderDispositivo();
  renderBorrado();
}

/* Datos del dispositivo al pie de Monitoreo. */
function renderDispositivo() {
  const t = tunnelsList.find(x => x.paso_id === currentTunnel);
  $("disp-paso").textContent = t ? t.paso_id : "—";
  $("disp-id").textContent = t ? t.dispositivo_id : "—";
  $("disp-coords").textContent = hasCoords(t)
    ? `${Number(t.latitud).toFixed(6)}, ${Number(t.longitud).toFixed(6)}`
    : "Sin coordenadas";
  $("disp-url").textContent = `${location.origin}/api/eventos`;
}

function paintSiteDots() {
  document.querySelectorAll("#tuneles-pills .site").forEach(btn => {
    const dot = btn.querySelector(".site-dot");
    const sev = siteSev.get(btn.dataset.paso);
    if (sev) dot.dataset.sev = sev;
    else delete dot.dataset.sev;
  });
}

/* Estado de todos los pasos con un solo pedido: /api/tuneles ya trae el último
   código y la última recepción de cada uno. Se considera vigente si llegó un
   evento en los últimos 60 s, el mismo umbral que usa la API (STALE_SECONDS). */
const SITE_FRESH_S = 60;

function estadoDesdeListado(t) {
  if (!t.ultima_recepcion || !t.ultimo_codigo || t.ultimo_codigo === "SIN_DATOS") {
    return { sev: "unknown", estado: "Sin mediciones", medido: null };
  }
  const age = (Date.now() - new Date(t.ultima_recepcion).getTime()) / 1000;
  const fresh = Number.isFinite(age) && age <= SITE_FRESH_S;
  const sev = fresh ? sevOf(t.ultimo_codigo) : "unknown";
  return { sev, estado: fresh ? SIGNAL[sev] : "Sin confirmar", medido: t.ultima_recepcion };
}

function aplicarEstados(list) {
  for (const t of list) {
    const st = estadoDesdeListado(t);
    mapStates.set(t.paso_id, st);
    // El paso abierto en Monitoreo ya tiene un estado más preciso (consulta cada 5 s).
    const enVivo = t.paso_id === currentTunnel && activeView === "monitor" && Date.now() - lastSuccess < 15000;
    if (!enVivo) siteSev.set(t.paso_id, st.sev);
  }
}

async function refreshSites() {
  try {
    const r = await fetch("/api/tuneles", { cache: "no-store" });
    if (r.status === 401) { location.assign("/login"); return false; }
    if (!r.ok) return false;
    const list = (await r.json()).tuneles || [];
    const cambio = list.length !== tunnelsList.length ||
      list.some((t, i) => !tunnelsList[i] || t.paso_id !== tunnelsList[i].paso_id || t.nombre !== tunnelsList[i].nombre ||
        t.ubicacion !== tunnelsList[i].ubicacion);
    tunnelsList = list;
    aplicarEstados(list);
    if (cambio) renderTunelesPills();
    else paintSiteDots();
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

setInterval(() => {
  if (!document.hidden && activeView !== "mapa") refreshSites();
}, 10000);

function renderTunelesPills() {
  const container = $("tuneles-pills");
  container.replaceChildren(...tunnelsList.map(t => {
    const btn = el("button", "site" + (t.paso_id === currentTunnel ? " active" : ""));
    btn.type = "button";
    btn.dataset.paso = t.paso_id;
    btn.setAttribute("aria-pressed", t.paso_id === currentTunnel ? "true" : "false");
    btn.title = t.ubicacion ? `${t.nombre} · ${t.ubicacion}` : t.nombre;
    btn.append(
      el("span", "site-dot"),
      el("span", "site-name", t.nombre),
      el("span", "site-meta", t.ubicacion || `${t.paso_id} · ${t.dispositivo_id}`)
    );
    btn.addEventListener("click", () => {
      if (t.paso_id !== currentTunnel) cambiarTunel(t.paso_id);
    });
    return btn;
  }));
  $("tuneles-count").textContent = tunnelsList.length ? String(tunnelsList.length) : "";
  paintSiteDots();
}

function cambiarTunel(pasoId) {
  currentTunnel = pasoId;

  // Cancelar peticiones previas en vuelo
  if (monitorAbortController) {
    monitorAbortController.abort();
    monitorAbortController = null;
  }
  running = false;
  clearTimeout(timer);

  historyEvents = [];
  historyPage = 1;
  historyTotal = 0;
  lastSeq = null;
  lastCodeSev = null;
  monitorTunnel = null;

  renderTunelesPills();
  actualizarHeaderTunel();

  const tunel = tunnelsList.find(t => t.paso_id === currentTunnel);
  const nombreTunel = tunel ? tunel.nombre : pasoId;

  if (activeView === "monitor") {
    // Limpiar estado inmediatamente para evitar visualización previa
    setStale("Cargando estado en vivo…");
    $("diagnostico").textContent = `Consultando ${nombreTunel}…`;
    $("codigo").replaceChildren(document.createTextNode("…"));
    $("medido-en").textContent = "—";
    $("secuencia-actual").textContent = "—";
    setLane(1, null);
    setLane(2, null);
    setWater(null);
    $("valido1").textContent = "Consultando";
    $("valido2").textContent = "Consultando";
    $("eventos").replaceChildren(emptyRow("Consultando…", 6));
    refresh();
  } else if (activeView === "historial") {
    loadHistory();
  } else if (activeView === "estadisticas") {
    loadStats();
  }
}

/* =========================================================
   MAPA ESQUEMÁTICO DE CABA (demostración)
   Dibujado localmente en SVG: no usa servicios de mapas externos.
   El contorno es aproximado y alcanza para ubicar los pasos.
   ========================================================= */

const CABA = {
  // Límite aproximado: costa del Río de la Plata (N→S), Riachuelo (E→O), Av. General Paz (S→N).
  coast: [
    [-34.5345, -58.4620], [-34.5410, -58.4440], [-34.5520, -58.4280], [-34.5560, -58.4140],
    [-34.5700, -58.3950], [-34.5800, -58.3800], [-34.5880, -58.3650], [-34.5960, -58.3600],
    [-34.6050, -58.3480], [-34.6150, -58.3360], [-34.6280, -58.3420], [-34.6360, -58.3550]
  ],
  riachuelo: [
    [-34.6420, -58.3650], [-34.6480, -58.3800], [-34.6550, -58.3950], [-34.6590, -58.4100],
    [-34.6680, -58.4200], [-34.6800, -58.4350], [-34.6950, -58.4500], [-34.7050, -58.4620]
  ],
  generalPaz: [
    [-34.6950, -58.4800], [-34.6800, -58.5000], [-34.6620, -58.5150], [-34.6480, -58.5300],
    [-34.6300, -58.5310], [-34.6150, -58.5270], [-34.6000, -58.5200], [-34.5880, -58.5100],
    [-34.5750, -58.5000], [-34.5620, -58.4900], [-34.5480, -58.4780]
  ],
  barrios: [
    ["Núñez", -34.5450, -58.4600], ["Belgrano", -34.5620, -58.4560], ["Villa Urquiza", -34.5740, -58.4870],
    ["Palermo", -34.5790, -58.4260], ["Recoleta", -34.5880, -58.3970], ["Villa Devoto", -34.6010, -58.5130],
    ["Centro", -34.6040, -58.3810], ["Caballito", -34.6190, -58.4410], ["Flores", -34.6290, -58.4630],
    ["Boedo", -34.6300, -58.4170], ["San Telmo", -34.6210, -58.3720], ["Mataderos", -34.6590, -58.5030],
    ["Barracas", -34.6450, -58.3830], ["Villa Lugano", -34.6760, -58.4730], ["Parque Patricios", -34.6380, -58.4000]
  ],
  // Vías del ferrocarril (los pasos bajos están debajo de ellas).
  rail: [
    ["Mitre", [[-34.5913, -58.3745], [-34.5850, -58.3880], [-34.5760, -58.4040], [-34.5680, -58.4230], [-34.5640, -58.4400], [-34.5620, -58.4560], [-34.5530, -58.4610], [-34.5440, -58.4640], [-34.5330, -58.4720]], 7],
    ["San Martín", [[-34.5913, -58.3745], [-34.5870, -58.3950], [-34.5800, -58.4200], [-34.5810, -58.4380], [-34.5880, -58.4560], [-34.5975, -58.4700], [-34.6015, -58.4880], [-34.6040, -58.5120], [-34.6060, -58.5250]], 6],
    ["Urquiza", [[-34.5870, -58.4550], [-34.5800, -58.4700], [-34.5740, -58.4860], [-34.5680, -58.5010], [-34.5640, -58.5080]], 3],
    ["Sarmiento", [[-34.6090, -58.4060], [-34.6150, -58.4250], [-34.6185, -58.4380], [-34.6250, -58.4550], [-34.6285, -58.4700], [-34.6290, -58.4850], [-34.6370, -58.5030], [-34.6420, -58.5280], [-34.6450, -58.5330]], 6],
    ["Roca", [[-34.6275, -58.3810], [-34.6360, -58.3805], [-34.6440, -58.3800], [-34.6530, -58.3790]]],
    ["Belgrano Sur", [[-34.6460, -58.3990], [-34.6500, -58.4200], [-34.6560, -58.4420], [-34.6620, -58.4660], [-34.6700, -58.4880], [-34.6790, -58.5050]]]
  ],
  // Avenidas: [nombre, principal, puntos]
  avenidas: [
    ["Av. Rivadavia", true, [[-34.6085, -58.3720], [-34.6095, -58.3920], [-34.6095, -58.4050], [-34.6150, -58.4250], [-34.6195, -58.4400], [-34.6280, -58.4640], [-34.6310, -58.4800], [-34.6360, -58.5050], [-34.6400, -58.5290]], 7],
    ["Av. 9 de Julio", true, [[-34.5900, -58.3845], [-34.6037, -58.3816], [-34.6180, -58.3810], [-34.6260, -58.3805]]],
    ["Av. del Libertador", true, [[-34.5900, -58.3800], [-34.5850, -58.3900], [-34.5780, -58.4080], [-34.5700, -58.4180], [-34.5600, -58.4370], [-34.5500, -58.4500], [-34.5400, -58.4630]], 5],
    ["Av. Santa Fe / Cabildo", true, [[-34.5960, -58.3770], [-34.5950, -58.3970], [-34.5880, -58.4100], [-34.5810, -58.4210], [-34.5760, -58.4330], [-34.5680, -58.4440], [-34.5620, -58.4560], [-34.5530, -58.4660], [-34.5450, -58.4780]], 7],
    ["Av. Corrientes", true, [[-34.6030, -58.3700], [-34.6040, -58.3816], [-34.6040, -58.4060], [-34.6000, -58.4300], [-34.5930, -58.4430], [-34.5870, -58.4540]], 3],
    ["Av. Juan B. Justo", true, [[-34.5800, -58.4260], [-34.5890, -58.4380], [-34.5960, -58.4440], [-34.6060, -58.4640], [-34.6150, -58.4800], [-34.6300, -58.5050], [-34.6420, -58.5250]], 5],
    ["AU 25 de Mayo", true, [[-34.6220, -58.3815], [-34.6230, -58.3950], [-34.6260, -58.4100], [-34.6330, -58.4300], [-34.6400, -58.4450], [-34.6480, -58.4800], [-34.6550, -58.5150]]],
    ["Av. Paseo Colón", false, [[-34.5960, -58.3720], [-34.6030, -58.3700], [-34.6110, -58.3690], [-34.6250, -58.3680], [-34.6330, -58.3640]]],
    ["Av. Córdoba", false, [[-34.5990, -58.3760], [-34.5980, -58.4070], [-34.5900, -58.4300], [-34.5860, -58.4400], [-34.5830, -58.4500]]],
    ["Av. San Martín", false, [[-34.6060, -58.4410], [-34.6000, -58.4600], [-34.5960, -58.4800], [-34.5920, -58.5000], [-34.5890, -58.5150]]],
    ["Av. Directorio", false, [[-34.6290, -58.4300], [-34.6360, -58.4500], [-34.6430, -58.4700], [-34.6500, -58.4900], [-34.6560, -58.5050]]],
    ["AU Dellepiane", false, [[-34.6440, -58.4400], [-34.6550, -58.4580], [-34.6650, -58.4750], [-34.6820, -58.5000]]],
    ["Av. Triunvirato", false, [[-34.5870, -58.4540], [-34.5780, -58.4700], [-34.5690, -58.4850], [-34.5620, -58.4920]]],
    ["Av. Caseros", false, [[-34.6300, -58.3780], [-34.6340, -58.3950], [-34.6380, -58.4100], [-34.6400, -58.4250]]],
    ["Av. Gaona", false, [[-34.6110, -58.4400], [-34.6140, -58.4600], [-34.6170, -58.4850], [-34.6190, -58.5050]]],
    ["Av. Costanera", false, [[-34.5370, -58.4560], [-34.5500, -58.4320], [-34.5620, -58.4100], [-34.5760, -58.3930]]]
  ],
  parques: [
    ["Bosques de Palermo", [[-34.5640, -58.4120], [-34.5700, -58.4050], [-34.5780, -58.4150], [-34.5760, -58.4230], [-34.5690, -58.4250], [-34.5630, -58.4190]]],
    ["Reserva Ecológica", [[-34.6040, -58.3540], [-34.6100, -58.3450], [-34.6200, -58.3420], [-34.6235, -58.3500], [-34.6150, -58.3575]]],
    ["Parque Centenario", "circle", -34.6066, -58.4357, 0.0022],
    ["Parque Avellaneda", "circle", -34.6450, -58.4800, 0.0030],
    ["Parque de la Ciudad", "circle", -34.6690, -58.4530, 0.0045],
    ["Parque Chacabuco", "circle", -34.6340, -58.4400, 0.0018]
  ],
  lugares: [
    ["Obelisco", -34.6037, -58.3816], ["Plaza de Mayo", -34.6083, -58.3712], ["Congreso", -34.6097, -58.3926],
    ["Retiro", -34.5913, -58.3745], ["Constitución", -34.6275, -58.3810], ["Once", -34.6090, -58.4060],
    ["Aeroparque", -34.5592, -58.4156], ["Puerto Madero", -34.6110, -58.3625], ["Chacarita", -34.5880, -58.4550],
    ["Liniers", -34.6420, -58.5280], ["Estadio Monumental", -34.5453, -58.4498], ["La Bombonera", -34.6356, -58.3647],
    ["Ciudad Universitaria", -34.5420, -58.4430], ["Plaza Italia", -34.5810, -58.4210], ["Autódromo", -34.6950, -58.4600]
  ],
  bounds: { latMin: -34.712, latMax: -34.522, lonMin: -58.540, lonMax: -58.326 }
};

let mapInstances = 0;
const MAP_S = 5000;                                  // unidades SVG por grado
const MAP_KX = Math.cos(34.615 * Math.PI / 180);     // corrección de longitud a esta latitud
const MAP_W = (CABA.bounds.lonMax - CABA.bounds.lonMin) * MAP_KX * MAP_S;
const MAP_H = (CABA.bounds.latMax - CABA.bounds.latMin) * MAP_S;

const mapProject = (lat, lon) => [
  (lon - CABA.bounds.lonMin) * MAP_KX * MAP_S,
  (CABA.bounds.latMax - lat) * MAP_S
];
const mapUnproject = (x, y) => [
  CABA.bounds.latMax - y / MAP_S,
  CABA.bounds.lonMin + x / (MAP_KX * MAP_S)
];
const hasCoords = t => t && Number.isFinite(Number(t.latitud)) && Number.isFinite(Number(t.longitud)) &&
  t.latitud !== null && t.longitud !== null;

function polyPoints(list) {
  return list.map(([lat, lon]) => mapProject(lat, lon).map(v => v.toFixed(1)).join(",")).join(" ");
}

/* Crea un mapa navegable dentro de `host`. Devuelve funciones para marcadores y selección. */
function createCabaMap(host, options = {}) {
  const svg = svgEl("svg", { "aria-label": "Mapa esquemático de la Ciudad de Buenos Aires", role: "img" }, "map-svg");
  const base = svgEl("g");
  const labels = svgEl("g", {}, "map-labels");
  const markers = svgEl("g", {}, "map-markers");
  const pinLayer = svgEl("g");

  // Río: desde la costa hacia el borde este del lienzo.
  // La costa sigue fuera de la ciudad: hacia el noroeste (Vicente López) y el sudeste (Dock Sud).
  const [nx, ny] = mapProject(-34.505, -58.495);
  const [sx, sy] = mapProject(-34.662, -58.300);
  const river = [`${nx.toFixed(1)},${(ny - 2000).toFixed(1)}`, `${MAP_W + 2000},${(ny - 2000).toFixed(1)}`,
    `${MAP_W + 2000},${(sy + 400).toFixed(1)}`, `${sx.toFixed(1)},${sy.toFixed(1)}`]
    .concat(polyPoints([...CABA.coast].reverse()).split(" "))
    .concat(`${nx.toFixed(1)},${ny.toFixed(1)}`);
  base.append(svgEl("rect", { x: -2000, y: -2000, width: MAP_W + 4000, height: MAP_H + 4000 }, "map-land-out"));
  base.append(svgEl("polygon", { points: river.join(" ") }, "map-water"));
  base.append(svgEl("polygon", { points: polyPoints([...CABA.coast, ...CABA.riachuelo, ...CABA.generalPaz]) }, "map-city"));
  // Detalle urbano recortado al límite de la ciudad.
  const clipId = `caba-clip-${++mapInstances}`;
  const defs = svgEl("defs");
  const clip = svgEl("clipPath", { id: clipId });
  clip.append(svgEl("polygon", { points: polyPoints([...CABA.coast, ...CABA.riachuelo, ...CABA.generalPaz]) }));
  defs.append(clip);
  const urban = svgEl("g", { "clip-path": `url(#${clipId})` });
  for (const p of CABA.parques) {
    if (p[1] === "circle") {
      const [x, y] = mapProject(p[2], p[3]);
      urban.append(svgEl("circle", { cx: x, cy: y, r: p[4] * MAP_S }, "map-park"));
    } else {
      urban.append(svgEl("polygon", { points: polyPoints(p[1]) }, "map-park"));
    }
  }
  // Pista de Aeroparque y dársenas de Puerto Madero.
  urban.append(svgEl("polyline", { points: polyPoints([[-34.5510, -58.4220], [-34.5680, -58.4090]]) }, "map-runway"));
  urban.append(svgEl("polyline", { points: polyPoints([[-34.5985, -58.3672], [-34.6215, -58.3640]]) }, "map-dock"));
  for (const [, major, pts] of CABA.avenidas.filter(a => !a[1])) urban.append(svgEl("polyline", { points: polyPoints(pts) }, "map-av"));
  for (const [, , pts] of CABA.avenidas.filter(a => a[1])) urban.append(svgEl("polyline", { points: polyPoints(pts) }, "map-av major"));
  for (const [, pts] of CABA.rail) {
    urban.append(svgEl("polyline", { points: polyPoints(pts) }, "map-rail-base"));
    urban.append(svgEl("polyline", { points: polyPoints(pts) }, "map-rail"));
  }
  base.append(defs, urban);
  base.append(svgEl("polyline", { points: polyPoints([CABA.coast[CABA.coast.length - 1], ...CABA.riachuelo]) }, "map-riachuelo"));

  const scaled = []; // elementos que mantienen tamaño en pantalla
  const place = (g, x, y) => { g.dataset.x = x; g.dataset.y = y; scaled.push(g); };

  for (const [name, lat, lon] of CABA.barrios) {
    const [x, y] = mapProject(lat, lon);
    const g = svgEl("g");
    const t = svgEl("text", { x: 0, y: 4, "text-anchor": "middle" }, "map-barrio");
    t.textContent = name;
    g.append(t);
    place(g, x, y);
    labels.append(g);
  }
  [["Río de la Plata", -34.585, -58.352, "map-water-label"], ["Riachuelo", -34.672, -58.418, "map-water-label small"]].forEach(([name, lat, lon, cls]) => {
    const [x, y] = mapProject(lat, lon);
    const g = svgEl("g");
    const t = svgEl("text", { x: 0, y: 0, "text-anchor": "middle" }, cls);
    t.textContent = name;
    g.append(t);
    place(g, x, y);
    labels.append(g);
  });

  const places = svgEl("g", {}, "map-places");
  for (const [name, lat, lon] of CABA.lugares) {
    const [x, y] = mapProject(lat, lon);
    const g = svgEl("g");
    g.append(svgEl("circle", { r: 2.2 }, "map-place-dot"));
    const t = svgEl("text", { x: 5, y: 3.5 }, "map-place");
    t.textContent = name;
    g.append(t);
    place(g, x, y);
    places.append(g);
  }

  // Nombre de avenidas y líneas, alineado con el tramo más largo de cada una.
  const along = (pts, name, cls, seg) => {
    let best = null;
    for (let i = 1; i < pts.length; i++) {
      if (seg !== undefined && i !== seg) continue;
      const [x1, y1] = mapProject(...pts[i - 1]);
      const [x2, y2] = mapProject(...pts[i]);
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (!best || len > best.len) best = { len, x: (x1 + x2) / 2, y: (y1 + y2) / 2, a: Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI };
    }
    let a = best.a;
    if (a > 90) a -= 180;
    if (a < -90) a += 180;
    const g = svgEl("g");
    const t = svgEl("text", { x: 0, y: -3, "text-anchor": "middle", transform: `rotate(${a.toFixed(1)})` }, cls);
    t.textContent = name;
    g.append(t);
    place(g, best.x, best.y);
    places.append(g);
  };
  CABA.avenidas.forEach(([name, major, pts, seg]) => along(pts, name, major ? "map-av-label major" : "map-av-label", seg));
  CABA.rail.forEach(([name, pts, seg]) => along(pts, `FC ${name}`, "map-rail-label", seg));

  svg.append(base, labels, places, markers, pinLayer);

  const controls = el("div", "map-controls");
  const mkBtn = (label, title, fn, path) => {
    const b = el("button", "btn btn-icon map-btn");
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    const ic = svgEl("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" }, "icon");
    ic.append(svgEl("path", { d: path }));
    b.append(ic);
    b.addEventListener("click", ev => { ev.stopPropagation(); fn(); });
    return b;
  };
  controls.append(
    mkBtn("+", "Acercar", () => zoomBy(0.6), "M8 3v10M3 8h10"),
    mkBtn("−", "Alejar", () => zoomBy(1 / 0.6), "M3 8h10"),
    mkBtn("⟲", "Ver toda la ciudad", () => fit(), "M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3")
  );
  host.replaceChildren(svg, controls);

  // ---------- Vista (viewBox) ----------
  let view = { x: 0, y: 0, w: MAP_W, h: MAP_H };
  let fitW = MAP_W;
  const size = () => [Math.max(1, svg.clientWidth || host.clientWidth || 600), Math.max(1, svg.clientHeight || host.clientHeight || 400)];

  function apply() {
    const [cw, ch] = size();
    view.h = view.w * ch / cw;
    // No dejar que la ciudad salga del encuadre.
    const cx = Math.min(Math.max(view.x + view.w / 2, 0), MAP_W);
    const cy = Math.min(Math.max(view.y + view.h / 2, 0), MAP_H);
    view.x = cx - view.w / 2;
    view.y = cy - view.h / 2;
    svg.setAttribute("viewBox", `${view.x.toFixed(2)} ${view.y.toFixed(2)} ${view.w.toFixed(2)} ${view.h.toFixed(2)}`);
    const k = view.w / cw;
    for (const g of scaled) g.setAttribute("transform", `translate(${g.dataset.x} ${g.dataset.y}) scale(${k})`);
    labels.classList.toggle("dense", view.w > fitW * 0.75 && cw < 520);
    // Nivel de detalle según el acercamiento: 0 vista general, 1 media, 2 cerca.
    const z = fitW / view.w;
    svg.dataset.z = z >= 2.6 ? "2" : z >= 1.45 ? "1" : "0";
    svg.dataset.small = cw < 520 ? "1" : "0";
  }

  function fit() {
    const [cw, ch] = size();
    const pad = 1.06;
    if (MAP_H / MAP_W > ch / cw) {
      view.h = MAP_H * pad;
      view.w = view.h * cw / ch;
    } else {
      view.w = MAP_W * pad;
      view.h = view.w * ch / cw;
    }
    view.x = MAP_W / 2 - view.w / 2;
    view.y = MAP_H / 2 - view.h / 2;
    fitW = view.w;
    apply();
  }

  function zoomBy(f, cx, cy) {
    const nw = Math.min(fitW, Math.max(fitW / 12, view.w * f));
    const real = nw / view.w;
    const px = cx ?? view.x + view.w / 2;
    const py = cy ?? view.y + view.h / 2;
    view.x = px - (px - view.x) * real;
    view.y = py - (py - view.y) * real;
    view.w = nw;
    apply();
  }

  const toSvg = ev => {
    const r = svg.getBoundingClientRect();
    return [view.x + (ev.clientX - r.left) / r.width * view.w, view.y + (ev.clientY - r.top) / r.height * view.h];
  };

  svg.addEventListener("wheel", ev => {
    ev.preventDefault();
    const [x, y] = toSvg(ev);
    zoomBy(ev.deltaY > 0 ? 1.15 : 1 / 1.15, x, y);
  }, { passive: false });

  let drag = null;
  svg.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    drag = { sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y, moved: false, target: ev.target };
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener("pointermove", ev => {
    if (!drag) return;
    const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    svg.classList.add("dragging");
    const r = svg.getBoundingClientRect();
    view.x = drag.vx - dx / r.width * view.w;
    view.y = drag.vy - dy / r.height * view.h;
    apply();
  });
  const end = ev => {
    if (!drag) return;
    const wasDrag = drag.moved;
    const start = drag.target;
    drag = null;
    svg.classList.remove("dragging");
    if (wasDrag) return;
    const target = start && start.closest && start.closest("[data-paso]");
    if (target && options.onMarker) { options.onMarker(target.dataset.paso); return; }
    if (options.onPick) {
      const [x, y] = toSvg(ev);
      options.onPick(...mapUnproject(x, y));
    }
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", () => { drag = null; svg.classList.remove("dragging"); });

  if (options.onPick) svg.classList.add("pickable");

  // ---------- Marcadores ----------
  function setMarkers(list) {
    for (let i = scaled.length - 1; i >= 0; i--) if (scaled[i].dataset.marker) scaled.splice(i, 1);
    markers.replaceChildren(...list.filter(hasCoords).map(m => {
      const [x, y] = mapProject(Number(m.latitud), Number(m.longitud));
      const g = svgEl("g", {}, "map-marker" + (m.selected ? " selected" : "") + (m.muted ? " muted" : ""));
      g.dataset.marker = "1";
      g.dataset.sev = m.sev || "unknown";
      if (!m.muted) {
        g.dataset.paso = m.paso_id;
        g.setAttribute("tabindex", "0");
        g.setAttribute("role", "button");
        g.setAttribute("aria-label", `${m.nombre}: ${m.estado || "sin datos"}`);
        g.addEventListener("keydown", ev => {
          if ((ev.key === "Enter" || ev.key === " ") && options.onMarker) { ev.preventDefault(); options.onMarker(m.paso_id); }
        });
      }
      if (m.sev === "crit" && !m.muted) g.append(svgEl("circle", { r: 9 }, "map-pulse"));
      if (m.selected) g.append(svgEl("circle", { r: 12 }, "map-ring"));
      g.append(svgEl("circle", { r: m.muted ? 4.5 : 7 }, "map-dot"));
      if (!m.muted) {
        const label = svgEl("text", { x: 13, y: 4 }, "map-label");
        label.textContent = m.nombre;
        g.append(label);
        const title = svgEl("title");
        title.textContent = `${m.nombre} · ${m.estado || "sin datos"}`;
        g.append(title);
      }
      place(g, x, y);
      return g;
    }));
    apply();
  }

  function setPin(lat, lon) {
    for (let i = scaled.length - 1; i >= 0; i--) if (scaled[i].dataset.pin) scaled.splice(i, 1);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { pinLayer.replaceChildren(); return; }
    const [x, y] = mapProject(lat, lon);
    const g = svgEl("g", {}, "map-pin");
    g.dataset.pin = "1";
    g.append(svgEl("path", { d: "M0 0 C-2 -6 -9 -9 -9 -16 A9 9 0 1 1 9 -16 C9 -9 2 -6 0 0 Z" }), svgEl("circle", { cx: 0, cy: -16, r: 3.2 }, "map-pin-hole"));
    place(g, x, y);
    pinLayer.replaceChildren(g);
    apply();
  }

  requestAnimationFrame(fit);
  return { setMarkers, setPin, fit, refit: fit };
}


/* ---------- Pestaña Mapa ---------- */

let mapaVista = null;
let mapTimer = null;
let mapRun = 0;
const mapStates = new Map(); // paso_id -> { sev, estado, codigo, diagnostico, medido }

function irAPaso(pasoId) {
  switchView("monitor");
  if (pasoId !== currentTunnel) cambiarTunel(pasoId);
}

function renderMapa() {
  if (!mapaVista) {
    mapaVista = createCabaMap($("mapa-caba"), { onMarker: irAPaso });
  }
  const list = tunnelsList.map(t => {
    const s = mapStates.get(t.paso_id);
    return { ...t, sev: s ? s.sev : "unknown", estado: s ? s.estado : "Consultando…", selected: t.paso_id === currentTunnel };
  });
  mapaVista.setMarkers(list);

  const rows = list.map(t => {
    const s = mapStates.get(t.paso_id);
    const b = el("button", "map-row" + (t.paso_id === currentTunnel ? " active" : ""));
    b.type = "button";
    const dot = el("span", "site-dot");
    dot.dataset.sev = t.sev;
    const info = el("span", "map-row-info");
    info.append(el("span", "map-row-name", t.nombre), el("span", "map-row-meta", t.ubicacion || t.paso_id));
    const st = el("span", "map-row-state", t.estado);
    st.dataset.sev = t.sev;
    const when = el("span", "map-row-when", s && s.medido ? ageText(s.medido) : hasCoords(t) ? "" : "Sin ubicación");
    b.append(dot, info, st, when);
    b.addEventListener("click", () => irAPaso(t.paso_id));
    return b;
  });
  $("mapa-lista").replaceChildren(...rows);
  const sin = list.filter(t => !hasCoords(t)).length;
  $("mapa-sin-ubicacion").textContent = sin
    ? `${sin} ${sin === 1 ? "paso" : "pasos"} sin ubicación`
    : "";
}

async function refreshMapa() {
  clearTimeout(mapTimer);
  if (activeView !== "mapa" || document.hidden) return;
  const run = ++mapRun;
  renderMapa();
  const ok = await refreshSites();
  if (run !== mapRun || activeView !== "mapa") return;
  renderMapa();
  if (ok) $("mapa-estado").textContent = `Actualizado ${new Date().toLocaleTimeString("es-AR", H23)}`;
  mapTimer = setTimeout(refreshMapa, 10000);
}


/* ---------- Selector de ubicación en el alta de un paso ---------- */

let mapaSelector = null;

function marcarUbicacion(lat, lon, desdeMapa) {
  if (desdeMapa) {
    $("nuevo-tunel-latitud").value = lat.toFixed(6);
    $("nuevo-tunel-longitud").value = lon.toFixed(6);
  }
  if (mapaSelector) mapaSelector.setPin(lat, lon);
  $("nuevo-tunel-coords").textContent = Number.isFinite(lat) && Number.isFinite(lon)
    ? `Ubicación marcada: ${lat.toFixed(5)}, ${lon.toFixed(5)}`
    : "Hacé click en el mapa para marcar dónde está el paso.";
  $("nuevo-tunel-coords").classList.toggle("set", Number.isFinite(lat) && Number.isFinite(lon));
}

function prepararSelectorMapa() {
  if (!mapaSelector) {
    mapaSelector = createCabaMap($("nuevo-tunel-mapa"), { onPick: (lat, lon) => marcarUbicacion(lat, lon, true) });
  } else {
    mapaSelector.refit();
  }
  mapaSelector.setMarkers(tunnelsList.map(t => ({ ...t, muted: true })));
  marcarUbicacion(NaN, NaN, false);
}

function coordsEscritas() {
  const lat = parseFloat($("nuevo-tunel-latitud").value);
  const lon = parseFloat($("nuevo-tunel-longitud").value);
  marcarUbicacion(lat, lon, false);
}


/* Borrar un paso: su clave, sus lecturas y sus reservas de secuencia (DELETE /api/tuneles/<paso>).
   tunel-01 es el paso base que la API vuelve a crear al iniciar, por eso no se borra. */
function renderBorrado() {
  const t = tunnelsList.find(x => x.paso_id === currentTunnel);
  const base = t && t.paso_id === "tunel-01";
  $("disp-borrar").disabled = !t || base;
  $("disp-borrar-nota").textContent = base
    ? "El paso base (tunel-01) no se puede borrar"
    : "Elimina el paso, su clave y todas sus lecturas";
}

function abrirBorrado() {
  const t = tunnelsList.find(x => x.paso_id === currentTunnel);
  if (!t || t.paso_id === "tunel-01") return;
  const n = Number(t.total_eventos) || 0;
  $("borrar-titulo").textContent = `¿Borrar ${t.nombre}?`;
  const texto = $("borrar-texto");
  texto.replaceChildren(
    document.createTextNode("Se eliminan el paso "),
    el("strong", null, t.paso_id),
    document.createTextNode(`, la clave de ${t.dispositivo_id} y ${n.toLocaleString("es-AR")} ${n === 1 ? "lectura" : "lecturas"}. No se puede deshacer.`)
  );
  $("borrar-error").hidden = true;
  $("borrar-confirmar").disabled = false;
  $("modal-borrar").dataset.paso = t.paso_id;
  $("modal-borrar").showModal();
  $("borrar-cancelar").focus();
}

async function confirmarBorrado() {
  const modal = $("modal-borrar");
  const paso = modal.dataset.paso;
  $("borrar-confirmar").disabled = true;
  try {
    const r = await fetch(`/api/tuneles/${encodeURIComponent(paso)}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken() }
    });
    if (r.status === 401) { location.assign("/login"); return; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detalle || data.error || "No se pudo borrar el paso");
    modal.close();
    for (const k of [...statsCache.keys()]) if (k.startsWith(`${paso}|`)) statsCache.delete(k);
    mapStates.delete(paso);
    siteSev.delete(paso);
    await cargarTuneles();
    if (tunnelsList.length) cambiarTunel(tunnelsList[0].paso_id);
  } catch (e) {
    console.error(e);
    $("borrar-error").textContent = e.message;
    $("borrar-error").hidden = false;
    $("borrar-confirmar").disabled = false;
  }
}

/* Modal y creación de túneles */
function abrirModalNuevoTunel() {
  const modal = $("modal-nuevo-tunel");
  if (!modal) return;

  $("form-crear-tunel").reset();
  $("modal-nuevo-tunel-cuerpo").style.display = "block";
  $("modal-nuevo-tunel-resultado").style.display = "none";
  const errEl = $("modal-nuevo-tunel-error");
  if (errEl) {
    errEl.textContent = "";
    errEl.style.display = "none";
  }

  if (typeof modal.showModal === "function") {
    modal.showModal();
  } else {
    modal.setAttribute("open", "");
  }
  prepararSelectorMapa();
  $("nuevo-tunel-nombre").focus();
}

function cerrarModalNuevoTunel() {
  const modal = $("modal-nuevo-tunel");
  if (!modal) return;
  if (typeof modal.close === "function") {
    modal.close();
  } else {
    modal.removeAttribute("open");
  }
}

function csrfToken() {
  const campo = document.querySelector('input[name="csrf"]');
  return campo ? campo.value : "";
}

async function crearNuevoTunel(nombre, pasoId, dispId, ubicacion, latitud, longitud) {
  const errEl = $("modal-nuevo-tunel-error");
  if (errEl) {
    errEl.textContent = "";
    errEl.style.display = "none";
  }
  const submitBtn = $("btn-submit-crear-tunel");
  if (submitBtn) submitBtn.disabled = true;

  try {
    const res = await fetch("/api/tuneles", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
      body: JSON.stringify({
        nombre: nombre, paso_id: pasoId, dispositivo_id: dispId,
        ubicacion: ubicacion,
        latitud: latitud === "" ? null : latitud,
        longitud: longitud === "" ? null : longitud
      })
    });
    const data = await res.json();
    if (!res.ok) {
      if (errEl) {
        errEl.textContent = data.detalle || data.error || "Error al crear el túnel";
        errEl.style.display = "block";
      }
      return;
    }

    // Éxito: mostrar la clave generada
    $("modal-nuevo-tunel-cuerpo").style.display = "none";
    $("nuevo-tunel-key-val").textContent = data.api_key;
    $("modal-nuevo-tunel-resultado").style.display = "block";

    const finBtn = $("btn-finalizar-crear-tunel");
    finBtn.onclick = async () => {
      cerrarModalNuevoTunel();
      await cargarTuneles();
      cambiarTunel(data.paso_id);
    };

    await cargarTuneles();

  } catch (err) {
    if (errEl) {
      errEl.textContent = "Error de red al crear el túnel.";
      errEl.style.display = "block";
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function initMultiTunelListeners() {
  $("disp-borrar").addEventListener("click", abrirBorrado);
  $("borrar-cancelar").addEventListener("click", () => $("modal-borrar").close());
  $("borrar-confirmar").addEventListener("click", confirmarBorrado);
  $("btn-nuevo-tunel-top").addEventListener("click", abrirModalNuevoTunel);
  $("btn-cerrar-modal-tunel").addEventListener("click", cerrarModalNuevoTunel);
  $("btn-cancelar-modal-tunel").addEventListener("click", cerrarModalNuevoTunel);

  $("form-crear-tunel").addEventListener("submit", e => {
    e.preventDefault();
    crearNuevoTunel(
      $("nuevo-tunel-nombre").value,
      $("nuevo-tunel-paso-id").value,
      $("nuevo-tunel-dispositivo-id").value,
      $("nuevo-tunel-ubicacion").value,
      $("nuevo-tunel-latitud").value,
      $("nuevo-tunel-longitud").value
    );
  });

  $("nuevo-tunel-latitud").addEventListener("input", coordsEscritas);
  $("nuevo-tunel-longitud").addEventListener("input", coordsEscritas);

  // Sugerencia automática de identificadores
  const inputNombre = $("nuevo-tunel-nombre");
  inputNombre.addEventListener("input", () => {
    const slug = inputNombre.value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const num = slug.replace(/[^0-9]/g, "");
    $("nuevo-tunel-paso-id").placeholder = slug || "tunel-03";
    $("nuevo-tunel-dispositivo-id").placeholder = num ? `esp32-${num}` : "esp32-03";
  });

  const btnCopiarKey = $("btn-copiar-nueva-key");
  btnCopiarKey.addEventListener("click", () => {
    const keyVal = $("nuevo-tunel-key-val").textContent;
    if (!keyVal) return;
    navigator.clipboard.writeText(keyVal).then(() => {
      btnCopiarKey.textContent = "¡Copiada!";
      setTimeout(() => { btnCopiarKey.textContent = "Copiar"; }, 2000);
    });
  });
}

initMultiTunelListeners();
cargarTuneles().then(() => refresh());
