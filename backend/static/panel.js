"use strict";

const $ = id => document.getElementById(id);

let activeView = "monitor";
let currentTunnel = "tunel-01";
let tunnelsList = [];
let monitorAbortController = null;
let running = false, timer, lastSuccess = 0, freshUntil = 0;
let historyPage = 1, historyLimit = 25, historyTotal = 0, historyLoading = false, historyEvents = [];
let exportLoading = false;
let statsLoading = false, statsEvents = null, statsRange = "24h";

const fmtDate = v => v ? new Date(v).toLocaleString("es-AR") : "Hora desconocida";

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
    ? `${v.toFixed(1)} cm`
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
    "1h": "Última hora.",
    "6h": "Últimas 6 horas.",
    "24h": "Últimas 24 horas.",
    "7d": "Últimos 7 días.",
    all: "Todo el historial disponible."
  })[r];
}


/* =========================================================
   MONITOREO
   ========================================================= */

function renderMonitorEvents(eventsList) {
  const evs = eventsList || [];
  if (evs.length) {
    const rows = evs.map(item => {
      const tr = document.createElement("tr");
      [
        fmtDate(item.medido_en),
        item.codigo,
        item.diagnostico,
        height(item, 1),
        height(item, 2),
        String(item.secuencia)
      ].forEach(v => tr.append(cell(v)));
      return tr;
    });
    $("eventos").replaceChildren(...rows);
  } else {
    const tr = document.createElement("tr");
    const td = cell("Sin registros todavía.");
    td.colSpan = 6;
    tr.append(td);
    $("eventos").replaceChildren(tr);
  }
}

function renderMonitor(data) {
  const state =
    data.estado || {};

  const e =
    state.ultimo_estado_conocido;


  if (!e) {
    $("diagnostico").textContent =
      "Sin mediciones todavía";

    $("vigencia").textContent =
      "La API está disponible; esperando al ESP32.";

    $("estado").className =
      "card estado neutral";

    $("codigo").textContent =
      "SIN DATOS";

    $("carril1").textContent = "—";
    $("valido1").textContent = "Sin medición";
    $("carril2").textContent = "—";
    $("valido2").textContent = "Sin medición";
    $("agua").textContent = "—";
    renderMonitorEvents(data.eventos);
    return;
  }


  const fresh =
    state.comunicacion === "recepcion_reciente" &&
    state.actualidad_medicion === "reciente";


  freshUntil =
    fresh
      ? Date.now() +
        Math.max(
          0,
          30 -
          Math.max(
            state.antiguedad_medicion_s,
            state.antiguedad_recepcion_s
          )
        ) * 1000
      : 0;


  $("estado").className =
    `card estado ${
      fresh
        ? (
          e.codigo === "OK-001"
            ? "ok"
            : "alerta"
        )
        : "neutral"
    }`;


  $("diagnostico").textContent =
    e.diagnostico;

  $("codigo").textContent =
    e.codigo;


  $("vigencia").textContent =
    fresh
      ? `Medición reciente · ${fmtDate(e.medido_en)}`
      : `Vigencia no confirmada · ${state.actualidad_medicion} · ${state.comunicacion.replaceAll("_", " ")}`;


  for (const n of [1, 2]) {
    $(`carril${n}`).textContent =
      height(e, n);

    $(`valido${n}`).textContent =
      e[`sensor${n}_valido`]
        ? "Altura de obstrucción"
        : "Revisar sensor; no asumir carril libre";
  }


  $("agua").textContent =
    water(e);


  renderMonitorEvents(data.eventos);
}


async function refresh() {
  clearTimeout(timer);

  if (
    running ||
    document.hidden ||
    activeView !== "monitor"
  ) {
    return;
  }

  running = true;

  $("actualizar").disabled =
    true;

  monitorAbortController =
    new AbortController();
  const reqTunnel =
    currentTunnel;

  const timeout =
    setTimeout(
      () => {
        if (monitorAbortController) monitorAbortController.abort();
      },
      8000
    );

  let delay =
    15000;

  try {
    const r =
      await fetch(
        "/api/panel/" + encodeURIComponent(reqTunnel),
        {
          cache: "no-store",
          signal: monitorAbortController.signal
        }
      );

    if (r.status === 401) {
      location.assign("/login");
      return;
    }

    if (
      r.status === 429 ||
      r.status === 503
    ) {
      delay = 30000;
    }

    if (!r.ok) {
      throw new Error(
        "API no disponible"
      );
    }

    const data =
      await r.json();

    if (reqTunnel !== currentTunnel) {
      return;
    }

    renderMonitor(data);

    lastSuccess =
      Date.now();

    $("conexion").textContent =
      `Consulta completada: ${
        new Date()
          .toLocaleTimeString("es-AR")
      }`;

  } catch (e) {
    if (e.name === "AbortError" && reqTunnel !== currentTunnel) {
      return;
    }
    console.error(e);

    freshUntil = 0;

    $("estado").className =
      "card estado neutral";

    $("vigencia").textContent =
      "Sin conexión con la API. Los valores mostrados son históricos.";

    $("conexion").textContent =
      "No se pudo actualizar. Reintentando sin acumular solicitudes…";

  } finally {
    clearTimeout(timeout);

    running = false;

    $("actualizar").disabled =
      false;

    if (
      !document.hidden &&
      activeView === "monitor"
    ) {
      timer =
        setTimeout(
          refresh,
          delay
        );
    }
  }
}


/* =========================================================
   HISTORIAL
   ========================================================= */

async function fetchHistoryBatch(
  limit,
  offset
) {
  const p =
    new URLSearchParams({
      limite: String(limit),
      offset: String(offset)
    });


  const r =
    await fetch(
      `/api/pasos/${encodeURIComponent(currentTunnel)}/historial?${p}`,
      {
        cache: "no-store"
      }
    );


  if (r.status === 401) {
    location.assign("/login");

    throw new Error(
      "Sesión finalizada"
    );
  }


  if (!r.ok) {
    throw new Error(
      "No se pudo cargar el historial"
    );
  }


  return r.json();
}


async function fetchAllHistory(progress) {
  const rows = [];

  let offset = 0;
  let total = null;


  while (
    total === null ||
    offset < total
  ) {
    const data =
      await fetchHistoryBatch(
        200,
        offset
      );


    if (total === null) {
      total =
        Number(data.total) || 0;
    }


    const events =
      Array.isArray(data.eventos)
        ? data.eventos
        : [];


    rows.push(...events);

    offset +=
      events.length;


    if (progress) {
      progress(
        rows.length,
        total
      );
    }


    if (
      !events.length ||
      events.length < 200
    ) {
      break;
    }
  }


  return rows;
}


function renderHistory(events) {
  const tbody =
    $("historial-eventos");


  if (!events.length) {
    const tr =
      document.createElement("tr");

    const td =
      cell(
        "No hay registros almacenados."
      );

    td.colSpan = 9;

    tr.append(td);

    tbody.replaceChildren(tr);

    return;
  }


  const frag =
    document.createDocumentFragment();


  for (const item of events) {
    const tr =
      document.createElement("tr");

    const detailCell =
      document.createElement("td");

    const btn =
      document.createElement("button");


    btn.type =
      "button";

    btn.className =
      "secondary detail-button";

    btn.textContent =
      "Ver JSON";


    detailCell.append(btn);


    tr.append(
      detailCell,
      cell(fmtDate(item.medido_en)),
      cell(fmtDate(item.recibido_en)),
      cell(item.codigo),
      cell(item.diagnostico),
      cell(water(item)),
      cell(height(item, 1)),
      cell(height(item, 2)),
      cell(item.secuencia)
    );


    const detailRow =
      document.createElement("tr");

    detailRow.className =
      "detail-row";

    detailRow.hidden =
      true;


    const td =
      document.createElement("td");

    td.colSpan = 9;


    const box =
      document.createElement("div");

    box.className =
      "json-container";


    const pre =
      document.createElement("pre");

    pre.textContent =
      JSON.stringify(
        item,
        null,
        2
      );


    box.append(pre);

    td.append(box);

    detailRow.append(td);


    btn.addEventListener(
      "click",
      () => {
        detailRow.hidden =
          !detailRow.hidden;

        btn.textContent =
          detailRow.hidden
            ? "Ver JSON"
            : "Ocultar";
      }
    );


    frag.append(
      tr,
      detailRow
    );
  }


  tbody.replaceChildren(frag);
}


function updatePagination() {
  const pages =
    Math.max(
      1,
      Math.ceil(
        historyTotal /
        historyLimit
      )
    );


  historyPage =
    Math.min(
      Math.max(
        historyPage,
        1
      ),
      pages
    );


  $("pagina-info").textContent =
    historyTotal
      ? `Página ${historyPage} de ${pages}`
      : "Página 1 de 1";


  $("pagina-numero").value =
    historyPage;

  $("pagina-numero").max =
    pages;


  $("pagina-primera").disabled =
    historyLoading ||
    historyPage <= 1;

  $("pagina-anterior").disabled =
    historyLoading ||
    historyPage <= 1;

  $("pagina-siguiente").disabled =
    historyLoading ||
    historyPage >= pages;

  $("pagina-ultima").disabled =
    historyLoading ||
    historyPage >= pages;


  if (!historyTotal) {
    $("historial-rango").textContent =
      "0 registros.";

    return;
  }


  const first =
    (
      historyPage - 1
    ) * historyLimit + 1;


  const last =
    Math.min(
      historyPage *
      historyLimit,
      historyTotal
    );


  $("historial-rango").textContent =
    `Mostrando ${first}–${last} de ${historyTotal} registros.`;
}


async function loadHistory() {
  if (historyLoading) {
    return;
  }


  historyLoading = true;

  $("historial-actualizar").disabled =
    true;


  updatePagination();


  $("historial-estado").textContent =
    "Cargando registros…";


  try {
    const data =
      await fetchHistoryBatch(
        historyLimit,
        (
          historyPage - 1
        ) * historyLimit
      );


    historyTotal =
      Number(data.total) || 0;


    historyEvents =
      Array.isArray(data.eventos)
        ? data.eventos
        : [];


    const pages =
      Math.max(
        1,
        Math.ceil(
          historyTotal /
          historyLimit
        )
      );


    if (
      historyPage > pages &&
      historyTotal > 0
    ) {
      historyPage =
        pages;

      historyLoading =
        false;

      return loadHistory();
    }


    renderHistory(
      historyEvents
    );


    $("historial-total").textContent =
      historyTotal
        .toLocaleString("es-AR");


    $("historial-estado").textContent =
      `Consulta completada: ${
        new Date()
          .toLocaleTimeString("es-AR")
      }`;

  } catch (e) {
    console.error(e);

    $("historial-estado").textContent =
      "No se pudo cargar el historial.";

  } finally {
    historyLoading = false;

    $("historial-actualizar").disabled =
      false;

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
        "No hay registros para exportar.";

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
      `${rows.length.toLocaleString("es-AR")} registros exportados.`;

  } catch (e) {
    console.error(e);

    $("export-estado").textContent =
      "No se pudo completar la exportación.";

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

function filteredStats() {
  const ms =
    rangeMs(statsRange);


  if (ms === null) {
    return [...statsEvents];
  }


  const min =
    Date.now() - ms;


  return statsEvents.filter(
    e => {
      const d =
        eventDate(e);

      return (
        d &&
        d.getTime() >= min
      );
    }
  );
}


function calculateStats(events) {
  let normal = 0;
  let waterActive = 0;
  let valid1 = 0;
  let valid2 = 0;
  let missing = 0;
  let latest = null;


  const boots =
    new Set();

  const codes =
    new Map();

  const lane1 = [];
  const lane2 = [];
  const delays = [];
  const byBoot =
    new Map();


  for (const e of events) {
    if (e.arranque_id) {
      boots.add(
        e.arranque_id
      );
    }


    if (
      e.codigo === "OK-001"
    ) {
      normal++;
    }


    if (e.agua_activa) {
      waterActive++;
    }


    if (e.sensor1_valido) {
      valid1++;

      const v =
        Number(
          e.obstruccion_carril1_cm
        );

      if (Number.isFinite(v)) {
        lane1.push(v);
      }
    }


    if (e.sensor2_valido) {
      valid2++;

      const v =
        Number(
          e.obstruccion_carril2_cm
        );

      if (Number.isFinite(v)) {
        lane2.push(v);
      }
    }


    const code =
      e.codigo ||
      "SIN CÓDIGO";


    codes.set(
      code,
      (
        codes.get(code) ||
        0
      ) + 1
    );


    const m =
      validDate(e.medido_en);

    const r =
      validDate(e.recibido_en);


    if (!m) {
      missing++;
    }


    if (
      r &&
      (
        !latest ||
        r > latest
      )
    ) {
      latest = r;
    }


    if (
      m &&
      r
    ) {
      const d =
        (r - m) /
        1000;


      if (
        Number.isFinite(d) &&
        d >= 0
      ) {
        delays.push(d);
      }
    }


    const seq =
      Number(e.secuencia);


    if (
      e.arranque_id &&
      Number.isFinite(seq)
    ) {
      if (
        !byBoot.has(
          e.arranque_id
        )
      ) {
        byBoot.set(
          e.arranque_id,
          []
        );
      }


      byBoot
        .get(e.arranque_id)
        .push(seq);
    }
  }


  let gaps = 0;


  for (
    const seqs of
    byBoot.values()
  ) {
    seqs.sort(
      (a, b) => a - b
    );


    for (
      let i = 1;
      i < seqs.length;
      i++
    ) {
      if (
        seqs[i] -
        seqs[i - 1] >
        1
      ) {
        gaps +=
          seqs[i] -
          seqs[i - 1] -
          1;
      }
    }
  }


  const avg =
    a =>
      a.length
        ? a.reduce(
          (x, y) => x + y,
          0
        ) / a.length
        : null;


  const max =
    a =>
      a.length
        ? Math.max(...a)
        : null;


  return {
    total:
      events.length,

    normal,
    waterActive,
    valid1,
    valid2,

    boots:
      boots.size,

    missing,

    lane1Avg:
      avg(lane1),

    lane1Max:
      max(lane1),

    lane2Avg:
      avg(lane2),

    lane2Max:
      max(lane2),

    delayAvg:
      avg(delays),

    delayMax:
      max(delays),

    latest,
    gaps,
    codes
  };
}


/* Cada evento cuenta como máximo el intervalo de muestreo (15 s) o hasta el
   evento siguiente, lo que sea menor. Pasado ese lapso sin recibir nada no se
   suma tiempo a ningún estado. */
const MUESTRA_S = 15;

function calculateTimeStats(events) {
  const timed = events
    .map(e => ({ e, t: eventDate(e) }))
    .filter(x => x.t)
    .sort((a, b) => (a.t - b.t) || (Number(a.e.secuencia) - Number(b.e.secuencia)));
  const r = {
    codes: new Map(), normal: 0, water: 0,
    valid1: 0, valid2: 0, monitored: 0
  };
  for (let i = 0; i < timed.length; i++) {
    const { e, t } = timed[i];
    const gap = i + 1 < timed.length
      ? (timed[i + 1].t - t) / 1000
      : Infinity;
    const dur = Math.min(Math.max(gap, 0), MUESTRA_S);
    if (!dur) continue;
    r.monitored += dur;
    const code = e.codigo || "SIN CÓDIGO";
    r.codes.set(code, (r.codes.get(code) || 0) + dur);
    if (code === "OK-001") r.normal += dur;
    if (e.agua_activa) r.water += dur;
    if (e.sensor1_valido) r.valid1 += dur;
    if (e.sensor2_valido) r.valid2 += dur;
  }
  return r;
}


function renderCodeBars(
  codes,
  total
) {
  const c =
    $("stats-codigos");


  if (!total) {
    c.textContent = "";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Sin datos en este rango.";
    c.appendChild(p);

    return;
  }


  const frag =
    document.createDocumentFragment();


  [...codes.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1]
    )
    .filter(([, count]) => count > 0)
    .forEach(
      ([code, count]) => {
        const row =
          document.createElement("div");

        row.className =
          "bar-row";


        const label =
          document.createElement("div");

        label.className =
          "bar-label";


        const strong =
          document.createElement("strong");

        const span =
          document.createElement("span");


        strong.textContent =
          code;


        span.textContent =
          `${duration(count)} · ${pct(count, total)}`;


        label.append(
          strong,
          span
        );


        const track =
          document.createElement("div");

        const fill =
          document.createElement("div");


        track.className =
          "bar-track";

        fill.className =
          "bar-fill";


        fill.style.width =
          `${count / total * 100}%`;


        track.append(fill);

        row.append(
          label,
          track
        );

        frag.append(row);
      }
    );


  c.replaceChildren(frag);
}


function activityConfig(events) {
  if (statsRange === "1h") {
    return {
      ms: 300000,
      name: "Bloques de 5 minutos"
    };
  }

  if (statsRange === "6h") {
    return {
      ms: 1800000,
      name: "Bloques de 30 minutos"
    };
  }

  if (statsRange === "24h") {
    return {
      ms: 3600000,
      name: "Bloques de 1 hora"
    };
  }

  if (statsRange === "7d") {
    return {
      ms: 21600000,
      name: "Bloques de 6 horas"
    };
  }


  const times =
    events
      .map(eventDate)
      .filter(Boolean)
      .map(
        d => d.getTime()
      );


  if (!times.length) {
    return {
      ms: 3600000,
      name: "Bloques de 1 hora"
    };
  }


  const span =
    Math.max(...times) -
    Math.min(...times);


  if (span <= 21600000) {
    return {
      ms: 1800000,
      name: "Bloques de 30 minutos"
    };
  }


  if (span <= 172800000) {
    return {
      ms: 3600000,
      name: "Bloques de 1 hora"
    };
  }


  if (span <= 1209600000) {
    return {
      ms: 21600000,
      name: "Bloques de 6 horas"
    };
  }


  return {
    ms: 86400000,
    name: "Bloques de 1 día"
  };
}


function activityLabel(
  ts,
  ms
) {
  const d =
    new Date(ts);


  if (ms <= 3600000) {
    return d.toLocaleTimeString(
      "es-AR",
      {
        hour: "2-digit",
        minute: "2-digit"
      }
    );
  }


  if (ms < 86400000) {
    return d.toLocaleString(
      "es-AR",
      {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }
    );
  }


  return d.toLocaleDateString(
    "es-AR",
    {
      day: "2-digit",
      month: "2-digit"
    }
  );
}


function renderActivity(events) {
  const box =
    $("stats-actividad");


  const cfg =
    activityConfig(
      events.length
        ? events
        : statsEvents
    );


  const ms =
    cfg.ms;


  $("actividad-resolucion").textContent =
    cfg.name;


  let start;
  let end;


  const fixed =
    rangeMs(statsRange);


  const times =
    events
      .map(eventDate)
      .filter(Boolean)
      .map(
        d => d.getTime()
      );


  if (fixed !== null) {
    end =
      Date.now();

    start =
      end - fixed;

  } else if (
    times.length
  ) {
    start =
      Math.min(...times);

    end =
      Math.max(...times) +
      ms;

  } else {
    box.textContent = "";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No hay datos en este rango.";
    box.appendChild(p);

    return;
  }


  start =
    Math.floor(
      start / ms
    ) * ms;


  end =
    Math.ceil(
      end / ms
    ) * ms;


  const buckets =
    new Map();


  for (
    let t = start;
    t < end;
    t += ms
  ) {
    buckets.set(t, 0);
  }


  events.forEach(
    e => {
      const d =
        eventDate(e);

      if (!d) {
        return;
      }


      const b =
        Math.floor(
          d.getTime() /
          ms
        ) * ms;


      if (
        buckets.has(b)
      ) {
        buckets.set(
          b,
          buckets.get(b) + 1
        );
      }
    }
  );


  const pts =
    [...buckets.entries()];


  const W = 1000;
  const H = 340;

  const L = 55;
  const R = 20;
  const T = 24;
  const B = 76;

  const pw =
    W - L - R;

  const ph =
    H - T - B;


  const max =
    Math.max(
      1,
      ...pts.map(
        p => p[1]
      )
    );


  const bw =
    pw / pts.length;


  const barW =
    Math.max(
      3,
      bw - 4
    );


  const labelStep =
    pts.length <= 24
      ? 1
      : Math.ceil(
        pts.length / 16
      );


  const svg =
    document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    );


  svg.setAttribute(
    "viewBox",
    `0 0 ${W} ${H}`
  );


  svg.classList.add(
    "stats-svg"
  );


  let selected =
    null;


  const select =
    (
      rect,
      ts,
      v
    ) => {
      if (selected) {
        selected.classList.remove(
          "selected"
        );
      }


      selected =
        rect;


      rect.classList.add(
        "selected"
      );


      $("stats-actividad-detalle").textContent =
        `${new Date(ts).toLocaleString("es-AR")} → ${new Date(ts + ms).toLocaleString("es-AR")} · ${v.toLocaleString("es-AR")} eventos`;
    };


  pts.forEach(
    ([ts, v], i) => {
      const bh =
        v / max * ph;


      const x =
        L + i * bw;


      const r =
        document.createElementNS(
          "http://www.w3.org/2000/svg",
          "rect"
        );


      r.setAttribute(
        "x",
        x + 2
      );

      r.setAttribute(
        "y",
        T + ph - bh
      );

      r.setAttribute(
        "width",
        barW
      );

      r.setAttribute(
        "height",
        Math.max(
          v ? 2 : 0,
          bh
        )
      );

      r.setAttribute(
        "class",
        "activity-bar"
      );

      r.setAttribute(
        "tabindex",
        "0"
      );


      const title =
        document.createElementNS(
          "http://www.w3.org/2000/svg",
          "title"
        );


      title.textContent =
        `${new Date(ts).toLocaleString("es-AR")} · ${v} eventos`;


      r.append(title);


      [
        "mouseenter",
        "focus",
        "click"
      ].forEach(
        ev =>
          r.addEventListener(
            ev,
            () =>
              select(
                r,
                ts,
                v
              )
          )
      );


      svg.append(r);


      if (
        i % labelStep === 0
      ) {
        const lab =
          document.createElementNS(
            "http://www.w3.org/2000/svg",
            "text"
          );


        const lx =
          x + bw / 2;


        lab.setAttribute(
          "x",
          lx
        );

        lab.setAttribute(
          "y",
          H - 38
        );

        lab.setAttribute(
          "class",
          "activity-axis-label"
        );

        lab.setAttribute(
          "text-anchor",
          "end"
        );

        lab.setAttribute(
          "transform",
          `rotate(-40 ${lx} ${H - 38})`
        );


        lab.textContent =
          activityLabel(
            ts,
            ms
          );


        svg.append(lab);
      }
    }
  );


  box.replaceChildren(svg);


  $("stats-actividad-detalle").textContent =
    "Pasá el mouse o hacé click sobre una barra para ver el intervalo.";
}


function renderObstruction(events) {
  const box =
    $("stats-obstruccion");


  let pts =
    events
      .map(
        e => {
          const d =
            eventDate(e);


          if (!d) {
            return null;
          }


          const a =
            e.sensor1_valido
              ? Number(
                e.obstruccion_carril1_cm
              )
              : null;


          const b =
            e.sensor2_valido
              ? Number(
                e.obstruccion_carril2_cm
              )
              : null;


          return {
            t:
              d.getTime(),

            c1:
              Number.isFinite(a)
                ? a
                : null,

            c2:
              Number.isFinite(b)
                ? b
                : null
          };
        }
      )
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.t - b.t
      );


  if (pts.length > 400) {
    const step =
      Math.ceil(
        pts.length / 400
      );


    pts =
      pts.filter(
        (_, i) =>
          i % step === 0
      );
  }


  if (pts.length < 2) {
    box.textContent = "";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No hay suficientes mediciones en este rango para graficar.";
    box.appendChild(p);

    return;
  }


  const values =
    pts.flatMap(
      p =>
        [
          p.c1,
          p.c2
        ].filter(
          v => v !== null
        )
    );


  if (!values.length) {
    box.textContent = "";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No hay mediciones válidas en este rango.";
    box.appendChild(p);

    return;
  }


  const max =
    Math.max(
      1,
      ...values
    );


  const W = 1000;
  const H = 330;

  const L = 62;
  const R = 24;
  const T = 20;
  const B = 55;

  const pw =
    W - L - R;

  const ph =
    H - T - B;


  const minT =
    pts[0].t;


  const maxT =
    pts[
      pts.length - 1
    ].t;


  const span =
    Math.max(
      1,
      maxT - minT
    );


  const x =
    t =>
      L +
      (
        t - minT
      ) /
      span *
      pw;


  const y =
    v =>
      T +
      ph -
      v /
      max *
      ph;


  const svg =
    document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    );


  svg.setAttribute(
    "viewBox",
    `0 0 ${W} ${H}`
  );


  svg.classList.add(
    "stats-svg"
  );


  [
    0,
    .25,
    .5,
    .75,
    1
  ].forEach(
    r => {
      const line =
        document.createElementNS(
          "http://www.w3.org/2000/svg",
          "line"
        );


      const yy =
        T +
        ph -
        r *
        ph;


      line.setAttribute(
        "x1",
        L
      );

      line.setAttribute(
        "x2",
        W - R
      );

      line.setAttribute(
        "y1",
        yy
      );

      line.setAttribute(
        "y2",
        yy
      );

      line.setAttribute(
        "class",
        "chart-grid-line"
      );


      svg.append(line);
    }
  );


  const pathFor =
    (
      field,
      cls
    ) => {
      let d = "";
      let draw = false;


      for (
        const p of pts
      ) {
        const v =
          p[field];


        if (v === null) {
          draw = false;
          continue;
        }


        d +=
          `${draw ? " L" : " M"} ${x(p.t)} ${y(v)}`;


        draw = true;
      }


      const path =
        document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path"
        );


      path.setAttribute(
        "d",
        d.trim()
      );


      path.setAttribute(
        "class",
        cls
      );


      return path;
    };


  svg.append(
    pathFor(
      "c1",
      "line-c1"
    ),
    pathFor(
      "c2",
      "line-c2"
    )
  );


  [
    0,
    .5,
    1
  ].forEach(
    r => {
      const l =
        document.createElementNS(
          "http://www.w3.org/2000/svg",
          "text"
        );


      l.setAttribute(
        "x",
        "6"
      );

      l.setAttribute(
        "y",
        T +
        ph -
        r *
        ph +
        4
      );

      l.setAttribute(
        "class",
        "axis-text"
      );


      l.textContent =
        `${num1(max * r)} cm`;


      svg.append(l);
    }
  );


  [
    0,
    .25,
    .5,
    .75,
    1
  ].forEach(
    r => {
      const ts =
        minT +
        span *
        r;


      const l =
        document.createElementNS(
          "http://www.w3.org/2000/svg",
          "text"
        );


      l.setAttribute(
        "x",
        L +
        pw *
        r
      );

      l.setAttribute(
        "y",
        H - 18
      );

      l.setAttribute(
        "class",
        "axis-text"
      );


      l.setAttribute(
        "text-anchor",
        r === 0
          ? "start"
          : r === 1
            ? "end"
            : "middle"
      );


      l.textContent =
        new Date(ts)
          .toLocaleString(
            "es-AR",
            {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit"
            }
          );


      svg.append(l);
    }
  );


  box.replaceChildren(svg);
}


function renderStats() {
  if (!statsEvents) {
    return;
  }


  document
    .querySelectorAll(
      ".range-button"
    )
    .forEach(
      b =>
        b.classList.toggle(
          "active",
          b.dataset.range === statsRange
        )
    );


  $("stats-range-label").textContent =
    rangeText(statsRange);


  const events =
    filteredStats();


  const s =
    calculateStats(events);


  $("stat-total").textContent =
    s.total
      .toLocaleString("es-AR");


  $("stat-base").textContent =
    statsEvents.length
      .toLocaleString("es-AR");


  $("stat-arranques").textContent =
    s.boots
      .toLocaleString("es-AR");


  const t =
    calculateTimeStats(events);

  $("stat-normal").textContent =
    pct(
      t.normal,
      t.monitored
    );


  $("stat-agua").textContent =
    duration(t.water);


  $("stat-ultima").textContent =
    s.latest
      ? s.latest
        .toLocaleString("es-AR")
      : "—";


  $("stat-ultima-edad").textContent =
    s.latest
      ? ageText(s.latest)
      : "Sin datos en el rango";


  $("stat-sensor1").textContent =
    pct(
      t.valid1,
      t.monitored
    );


  $("stat-sensor2").textContent =
    pct(
      t.valid2,
      t.monitored
    );


  $("stat-c1-prom").textContent =
    s.lane1Avg === null
      ? "—"
      : `${num1(s.lane1Avg)} cm`;


  $("stat-c1-max").textContent =
    s.lane1Max === null
      ? "—"
      : `${num1(s.lane1Max)} cm`;


  $("stat-c2-prom").textContent =
    s.lane2Avg === null
      ? "—"
      : `${num1(s.lane2Avg)} cm`;


  $("stat-c2-max").textContent =
    s.lane2Max === null
      ? "—"
      : `${num1(s.lane2Max)} cm`;


  $("stat-delay-prom").textContent =
    duration(s.delayAvg);


  $("stat-delay-max").textContent =
    duration(s.delayMax);


  $("stat-gaps").textContent =
    s.gaps
      .toLocaleString("es-AR");


  $("stat-sin-fecha").textContent =
    s.missing
      .toLocaleString("es-AR");


  $("stat-monitoreado").textContent =
    duration(t.monitored);

  renderCodeBars(
    t.codes,
    t.monitored
  );


  renderActivity(events);

  renderObstruction(events);


  $("stats-estado").textContent =
    `${events.length.toLocaleString("es-AR")} registros en el rango · base total ${statsEvents.length.toLocaleString("es-AR")}`;
}


async function loadStats(
  force = false
) {
  if (statsLoading) {
    return;
  }


  if (
    statsEvents &&
    !force
  ) {
    renderStats();
    return;
  }


  statsLoading = true;

  $("stats-actualizar").disabled =
    true;


  $("stats-estado").textContent =
    "Cargando historial para análisis…";


  try {
    statsEvents =
      await fetchAllHistory(
        (n, t) =>
          $("stats-estado").textContent =
            `Cargando ${n.toLocaleString("es-AR")} de ${t.toLocaleString("es-AR")} registros…`
      );


    renderStats();

  } catch (e) {
    console.error(e);

    $("stats-estado").textContent =
      "No se pudieron calcular las estadísticas.";

  } finally {
    statsLoading = false;

    $("stats-actualizar").disabled =
      false;
  }
}


/* =========================================================
   NAVEGACIÓN
   ========================================================= */

function switchView(view) {
  if (
    ![
      "monitor",
      "historial",
      "estadisticas"
    ].includes(view)
  ) {
    return;
  }

  activeView =
    view;

  $("vista-monitor").hidden =
    view !== "monitor";

  $("vista-historial").hidden =
    view !== "historial";

  $("vista-estadisticas").hidden =
    view !== "estadisticas";


  document
    .querySelectorAll(".tab")
    .forEach(
      b => {
        const active =
          b.dataset.view === view;


        b.classList.toggle(
          "active",
          active
        );


        b.setAttribute(
          "aria-selected",
          active
            ? "true"
            : "false"
        );
      }
    );


  clearTimeout(timer);


  if (view === "monitor") {
    refresh();

  } else if (
    view === "historial"
  ) {
    loadHistory();

  } else {
    loadStats();
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


document.addEventListener(
  "visibilitychange",
  () => {
    clearTimeout(timer);


    if (
      !document.hidden &&
      activeView === "monitor"
    ) {
      if (
        Date.now() -
        lastSuccess >
        30000
      ) {
        $("estado").className =
          "card estado neutral";


        $("vigencia").textContent =
          "Verificando vigencia de los datos…";
      }


      refresh();
    }
  }
);


setInterval(
  () => {
    if (
      freshUntil &&
      Date.now() >= freshUntil
    ) {
      freshUntil = 0;


      $("estado").className =
        "card estado neutral";


      $("vigencia").textContent =
        "Medición desactualizada. Esperando información reciente.";
    }
  },
  1000
);


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

    renderTunelesPills();
    actualizarHeaderTunel();
  } catch (err) {
    console.error("Error al obtener túneles:", err);
  }
}

function actualizarHeaderTunel() {
  const tunel = tunnelsList.find(t => t.paso_id === currentTunnel);
  const headerSub = $("header-tunnel-subtitle");
  if (headerSub && tunel) {
    const lugar = tunel.ubicacion ? ` · ${tunel.ubicacion}` : "";
    headerSub.textContent = `${tunel.nombre} · ${tunel.dispositivo_id.toUpperCase()}${lugar} · Telemetría en vivo`;
  }
  const mapa = $("header-tunnel-map");
  if (mapa) {
    const conCoords = tunel && tunel.latitud !== null && tunel.longitud !== null;
    mapa.hidden = !conCoords;
    if (conCoords) {
      mapa.href = `https://www.openstreetmap.org/?mlat=${tunel.latitud}&mlon=${tunel.longitud}#map=17/${tunel.latitud}/${tunel.longitud}`;
    }
  }
}

function renderTunelesPills() {
  const container = $("tuneles-pills");
  if (!container) return;
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  tunnelsList.forEach(t => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tunel-pill" + (t.paso_id === currentTunnel ? " active" : "");
    btn.textContent = t.nombre;
    btn.addEventListener("click", () => {
      cambiarTunel(t.paso_id);
    });
    container.appendChild(btn);
  });
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
  statsEvents = null;

  renderTunelesPills();
  actualizarHeaderTunel();

  const tunel = tunnelsList.find(t => t.paso_id === currentTunnel);
  const nombreTunel = tunel ? tunel.nombre : pasoId;

  if (activeView === "monitor") {
    // Limpiar estado inmediatamente para evitar visualización previa
    $("diagnostico").textContent = `Consultando ${nombreTunel}…`;
    $("vigencia").textContent = "Cargando estado en vivo…";
    $("codigo").textContent = "…";
    $("estado").className = "card estado neutral";
    $("carril1").textContent = "—";
    $("valido1").textContent = "Consultando";
    $("carril2").textContent = "—";
    $("valido2").textContent = "Consultando";
    $("agua").textContent = "—";

    refresh();
  } else if (activeView === "historial") {
    loadHistory();
  } else if (activeView === "estadisticas") {
    loadStats();
  }
}

/* Modal y Creación de Túneles */
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
  const btnTop = $("btn-nuevo-tunel-top");
  if (btnTop) {
    btnTop.addEventListener("click", abrirModalNuevoTunel);
  }

  const btnCerrar = $("btn-cerrar-modal-tunel");
  if (btnCerrar) {
    btnCerrar.addEventListener("click", cerrarModalNuevoTunel);
  }

  const btnCancel = $("btn-cancelar-modal-tunel");
  if (btnCancel) {
    btnCancel.addEventListener("click", cerrarModalNuevoTunel);
  }

  const formTunel = $("form-crear-tunel");
  if (formTunel) {
    formTunel.addEventListener("submit", e => {
      e.preventDefault();
      const nombre = $("nuevo-tunel-nombre").value;
      const pasoId = $("nuevo-tunel-paso-id").value;
      const dispId = $("nuevo-tunel-dispositivo-id").value;
      crearNuevoTunel(nombre, pasoId, dispId,
        $("nuevo-tunel-ubicacion").value, $("nuevo-tunel-latitud").value, $("nuevo-tunel-longitud").value);
    });
  }

  // Sugerencia automática de slugs
  const inputNombre = $("nuevo-tunel-nombre");
  if (inputNombre) {
    inputNombre.addEventListener("input", () => {
      const slug = inputNombre.value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const num = slug.replace(/[^0-9]/g, "");
      $("nuevo-tunel-paso-id").placeholder = slug || "tunel-03";
      $("nuevo-tunel-dispositivo-id").placeholder = num ? `esp32-${num}` : "esp32-03";
    });
  }

  const btnCopiarKey = $("btn-copiar-nueva-key");
  if (btnCopiarKey) {
    btnCopiarKey.addEventListener("click", () => {
      const keyVal = $("nuevo-tunel-key-val").textContent;
      if (!keyVal) return;
      navigator.clipboard.writeText(keyVal).then(() => {
        btnCopiarKey.textContent = "¡Copiada!";
        setTimeout(() => { btnCopiarKey.textContent = "Copiar"; }, 2000);
      });
    });
  }
}

initMultiTunelListeners();
cargarTuneles().then(() => refresh());


