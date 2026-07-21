(function () {
  "use strict";

  const CFG = Object.assign({
    apiEndpoint: "/api/conciliacion-bancaria",
    estacion: "40098",
    defaultWindowMinutes: 180,
    maxFileBytes: 8 * 1024 * 1024,
    maxRows: 10000
  }, window.CONCILIACION_BANCARIA_CONFIG || {});
  const CORE = window.ReconciliationCore;

  const ids = [
    "serverBadge", "setupAlert", "setupAlertText", "maeFile", "bciFile", "maeDropZone", "bciDropZone",
    "maeFileName", "bciFileName", "maeFileSummary", "bciFileSummary", "windowMinutes", "btnLimpiar",
    "btnConciliar", "btnExportar", "btnGuardar", "uploadMessage", "kpiMae", "kpiMaeAmount", "kpiMatched",
    "kpiMatchedAmount", "kpiRate", "kpiPendingMae", "kpiPendingMaeAmount", "kpiPendingBci",
    "kpiPendingBciAmount", "kpiExcluded", "kpiExcludedAmount", "analysisNotes", "resultCount", "filterSearch",
    "filterStatus", "filterFrom", "filterTo", "btnLimpiarFiltros", "resultRows", "exceptionSummary",
    "btnRecargarHistorial", "historyList", "toast"
  ];
  const dom = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));

  const state = {
    mae: null,
    bci: null,
    result: null,
    serverReady: false,
    history: [],
    saving: false
  };

  init();

  function init() {
    if (!CORE) {
      showNotice("No fue posible iniciar el motor de conciliación.", "error");
      return;
    }
    dom.windowMinutes.value = String(CFG.defaultWindowMinutes);
    bindFileInput("mae");
    bindFileInput("bci");
    dom.btnLimpiar.addEventListener("click", resetAll);
    dom.btnConciliar.addEventListener("click", runReconciliation);
    dom.btnExportar.addEventListener("click", exportResult);
    dom.btnGuardar.addEventListener("click", saveResult);
    dom.btnRecargarHistorial.addEventListener("click", loadHistory);
    dom.btnLimpiarFiltros.addEventListener("click", clearFilters);
    [dom.filterSearch, dom.filterStatus, dom.filterFrom, dom.filterTo].forEach(control => {
      control.addEventListener(control.tagName === "INPUT" ? "input" : "change", renderRows);
    });
    dom.windowMinutes.addEventListener("change", () => {
      if (state.mae && state.bci && state.result) runReconciliation();
    });
    resetKpis();
    loadHistory();
  }

  function bindFileInput(kind) {
    const input = kind === "mae" ? dom.maeFile : dom.bciFile;
    const zone = kind === "mae" ? dom.maeDropZone : dom.bciDropZone;
    input.addEventListener("change", () => handleFile(kind, input.files?.[0]));
    zone.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });
    ["dragenter", "dragover"].forEach(name => zone.addEventListener(name, event => {
      event.preventDefault();
      zone.classList.add("is-dragging");
    }));
    ["dragleave", "drop"].forEach(name => zone.addEventListener(name, event => {
      event.preventDefault();
      zone.classList.remove("is-dragging");
    }));
    zone.addEventListener("drop", event => {
      const file = event.dataTransfer?.files?.[0];
      if (file) handleFile(kind, file);
    });
  }

  async function handleFile(kind, file) {
    if (!file) return;
    if (!/\.xlsx?$/i.test(file.name)) {
      showNotice("Selecciona un archivo Excel .xlsx o .xls.", "error");
      return;
    }
    if (file.size > CFG.maxFileBytes) {
      showNotice(`El archivo supera ${Math.round(CFG.maxFileBytes / 1048576)} MB.`, "error");
      return;
    }
    if (!window.XLSX) {
      showNotice("No se pudo cargar el lector de Excel. Actualiza la página e inténtalo nuevamente.", "error");
      return;
    }

    const fileNameEl = kind === "mae" ? dom.maeFileName : dom.bciFileName;
    const summaryEl = kind === "mae" ? dom.maeFileSummary : dom.bciFileSummary;
    fileNameEl.textContent = file.name;
    summaryEl.textContent = "Leyendo y validando...";
    clearNotice();

    try {
      const arrayBuffer = await file.arrayBuffer();
      const parsed = parseWorkbook(arrayBuffer, kind);
      const hash = await sha256(arrayBuffer);
      state[kind] = { file, arrayBuffer, parsed, hash };
      renderSourceSummary(kind);
      const zone = kind === "mae" ? dom.maeDropZone : dom.bciDropZone;
      zone.classList.add("has-file");
      if (state.result) clearResultOnly();
      updateReadyState();
    } catch (error) {
      state[kind] = null;
      summaryEl.textContent = "Archivo no válido.";
      showNotice(error.message || "No se pudo leer el archivo.", "error");
      updateReadyState();
    }
  }

  function parseWorkbook(arrayBuffer, kind) {
    const workbook = XLSX.read(arrayBuffer, { type: "array", raw: true, cellDates: false });
    const errors = [];
    for (const sheetName of workbook.SheetNames) {
      const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: "" });
      try {
        const parsed = kind === "mae"
          ? CORE.parseMaeMatrix(matrix, { maxRows: CFG.maxRows })
          : CORE.parseBciMatrix(matrix, { maxRows: CFG.maxRows });
        parsed.sheetName = sheetName;
        return parsed;
      } catch (error) {
        errors.push(error.message);
      }
    }
    throw new Error(errors[0] || "Ninguna hoja contiene el formato esperado.");
  }

  function renderSourceSummary(kind) {
    const source = state[kind]?.parsed;
    if (!source) return;
    const element = kind === "mae" ? dom.maeFileSummary : dom.bciFileSummary;
    if (kind === "mae") {
      element.textContent = `${source.deposits.length.toLocaleString("es-CL")} depósitos · ${money(CORE.sumAmount(source.deposits))} · ${source.pickups.length} recogidas excluidas`;
    } else {
      element.textContent = `${source.deposits.length.toLocaleString("es-CL")} depósitos BCI · ${source.inScope.length} de Caja Depositaria · ${source.excluded.length} fuera de alcance`;
    }
    element.classList.add("is-valid");
  }

  function updateReadyState() {
    dom.btnConciliar.disabled = !(state.mae && state.bci);
    dom.btnExportar.disabled = !state.result;
    dom.btnGuardar.disabled = !(state.result && state.serverReady && !state.saving);
  }

  function runReconciliation() {
    if (!state.mae || !state.bci) {
      showNotice("Carga ambos archivos antes de conciliar.", "warning");
      return;
    }
    try {
      state.result = CORE.reconcile(state.mae.parsed, state.bci.parsed, {
        windowMinutes: Number(dom.windowMinutes.value || CFG.defaultWindowMinutes)
      });
      clearFilters(false);
      renderAll();
      showNotice(`Conciliación lista: ${state.result.summary.matchedCount} coincidencias por ${money(state.result.summary.matchedAmount)}.`, "success");
    } catch (error) {
      showNotice(error.message || "No fue posible ejecutar la conciliación.", "error");
    }
  }

  function renderAll() {
    renderKpis();
    renderAnalysisNotes();
    renderRows();
    renderExceptions();
    updateReadyState();
  }

  function renderKpis() {
    const summary = state.result?.summary;
    if (!summary) return resetKpis();
    dom.kpiMae.textContent = summary.maeCount.toLocaleString("es-CL");
    dom.kpiMaeAmount.textContent = money(summary.maeAmount);
    dom.kpiMatched.textContent = summary.matchedCount.toLocaleString("es-CL");
    dom.kpiMatchedAmount.textContent = money(summary.matchedAmount);
    dom.kpiRate.textContent = `${Math.round(summary.matchRate * 100)}%`;
    dom.kpiPendingMae.textContent = summary.pendingMaeCount.toLocaleString("es-CL");
    dom.kpiPendingMaeAmount.textContent = money(summary.pendingMaeAmount);
    dom.kpiPendingBci.textContent = summary.pendingBciCount.toLocaleString("es-CL");
    dom.kpiPendingBciAmount.textContent = money(summary.pendingBciAmount);
    dom.kpiExcluded.textContent = summary.excludedBciCount.toLocaleString("es-CL");
    dom.kpiExcludedAmount.textContent = `${money(summary.excludedBciAmount)} fuera de alcance`;
  }

  function resetKpis() {
    [dom.kpiMae, dom.kpiMatched, dom.kpiPendingMae, dom.kpiPendingBci, dom.kpiExcluded].forEach(el => { el.textContent = "0"; });
    [dom.kpiMaeAmount, dom.kpiMatchedAmount, dom.kpiPendingMaeAmount, dom.kpiPendingBciAmount].forEach(el => { el.textContent = "$0"; });
    dom.kpiExcludedAmount.textContent = "$0 fuera de alcance";
    dom.kpiRate.textContent = "0%";
  }

  function renderAnalysisNotes() {
    const summary = state.result?.summary;
    if (!summary) {
      dom.analysisNotes.hidden = true;
      return;
    }
    const chips = [
      `${summary.within15MinutesCount} coincidencias dentro de 15 minutos`,
      `${summary.within60MinutesCount} coincidencias dentro de 1 hora`,
      `${summary.delayedCount} conciliadas con demora`,
      `${summary.crossesDayCount} cruce${summary.crossesDayCount === 1 ? "" : "s"} de medianoche`
    ];
    dom.analysisNotes.innerHTML = chips.map((text, index) => `<span class="cb-analysis-chip ${index >= 2 && Number(text.split(" ")[0]) ? "is-warning" : ""}">${escapeHtml(text)}</span>`).join("");
    dom.analysisNotes.hidden = false;
  }

  function filteredRows() {
    if (!state.result) return [];
    const search = CORE.normalizeText(dom.filterSearch.value);
    const status = dom.filterStatus.value;
    const from = dom.filterFrom.value;
    const to = dom.filterTo.value;
    return state.result.rows.filter(row => {
      if (status && row.statusKey !== status) return false;
      const dateKey = row.mae?.dateKey || row.bci?.dateKey || "";
      if (from && dateKey < from) return false;
      if (to && dateKey > to) return false;
      if (search) {
        const haystack = CORE.normalizeText([
          row.amount, row.statusLabel, row.mae?.user, row.mae?.machine, row.bci?.detail, row.bci?.transactionCode
        ].join(" "));
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }

  function renderRows() {
    if (!state.result) {
      dom.resultCount.textContent = "Sin conciliación";
      dom.resultRows.innerHTML = '<tr><td colspan="8" class="cb-empty">Carga ambos archivos para iniciar.</td></tr>';
      return;
    }
    const rows = filteredRows();
    dom.resultCount.textContent = `${rows.length.toLocaleString("es-CL")} de ${state.result.rows.length.toLocaleString("es-CL")} movimientos`;
    if (!rows.length) {
      dom.resultRows.innerHTML = '<tr><td colspan="8" class="cb-empty">No hay movimientos para los filtros seleccionados.</td></tr>';
      return;
    }
    dom.resultRows.innerHTML = rows.map(row => {
      const code = row.bci?.transactionCode || "—";
      const shortCode = code.length > 24 ? `…${code.slice(-23)}` : code;
      return `<tr>
        <td>${statusBadge(row)}</td>
        <td class="cb-money">${money(row.amount)}</td>
        <td>${formatDateTime(row.mae?.dateTime)}</td>
        <td>${formatDateTime(row.bci?.dateTime)}</td>
        <td>${formatDelta(row.deltaSeconds)}</td>
        <td>${escapeHtml(row.mae?.user || "—")}</td>
        <td>${escapeHtml(row.bci?.detail || "—")}</td>
        <td title="${escapeHtml(code)}">${escapeHtml(shortCode)}</td>
      </tr>`;
    }).join("");
  }

  function statusBadge(row) {
    const css = row.statusKey === "conciliado" ? "matched"
      : row.statusKey === "demora" ? "delay"
        : row.statusKey === "fuera_alcance" ? "excluded" : "pending";
    return `<span class="cb-status cb-status--${css}">${escapeHtml(row.statusLabel)}</span>`;
  }

  function renderExceptions() {
    const result = state.result;
    if (!result) {
      dom.exceptionSummary.className = "cb-empty-panel";
      dom.exceptionSummary.textContent = "Todavía no hay resultados.";
      return;
    }
    const summary = result.summary;
    const items = [
      { title: "Depósitos MAE sin abono", note: "Requieren revisar el corte o el ingreso en BCI.", count: summary.pendingMaeCount, amount: summary.pendingMaeAmount },
      { title: "Abonos BCI sin depósito MAE", note: "Caja Depositaria dentro del período sin pareja.", count: summary.pendingBciCount, amount: summary.pendingBciAmount },
      { title: "Coincidencias con demora", note: `Mismo importe dentro de ${result.windowMinutes} minutos.`, count: summary.delayedCount, amount: CORE.sumAmount(result.matches.filter(row => row.delayed)) },
      { title: "Otros depósitos BCI", note: "Caja manual o cheque; se informan, pero no se concilian con MAE.", count: summary.excludedBciCount, amount: summary.excludedBciAmount }
    ];
    dom.exceptionSummary.className = "cb-exception-list";
    dom.exceptionSummary.innerHTML = items.map(item => `<div class="cb-exception-item"><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.note)}</small></div><div class="cb-exception-value">${item.count.toLocaleString("es-CL")}<small>${money(item.amount)}</small></div></div>`).join("");
  }

  function clearFilters(render = true) {
    dom.filterSearch.value = "";
    dom.filterStatus.value = "";
    dom.filterFrom.value = "";
    dom.filterTo.value = "";
    if (render) renderRows();
  }

  function resetAll() {
    state.mae = null;
    state.bci = null;
    dom.maeFile.value = "";
    dom.bciFile.value = "";
    dom.maeFileName.textContent = "Ningún archivo seleccionado";
    dom.bciFileName.textContent = "Ningún archivo seleccionado";
    dom.maeFileSummary.textContent = "Esperando archivo.";
    dom.bciFileSummary.textContent = "Esperando archivo.";
    dom.maeFileSummary.classList.remove("is-valid");
    dom.bciFileSummary.classList.remove("is-valid");
    dom.maeDropZone.classList.remove("has-file");
    dom.bciDropZone.classList.remove("has-file");
    clearResultOnly();
    clearNotice();
    updateReadyState();
  }

  function clearResultOnly() {
    state.result = null;
    resetKpis();
    dom.analysisNotes.hidden = true;
    dom.resultCount.textContent = "Sin conciliación";
    dom.resultRows.innerHTML = '<tr><td colspan="8" class="cb-empty">Carga ambos archivos para iniciar.</td></tr>';
    dom.exceptionSummary.className = "cb-empty-panel";
    dom.exceptionSummary.textContent = "Todavía no hay resultados.";
    updateReadyState();
  }

  async function loadHistory() {
    setServerBadge("neutral", "Verificando servidor");
    try {
      const response = await fetch(CFG.apiEndpoint, { headers: { "Accept": "application/json" }, cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Servidor no disponible.");
      state.serverReady = true;
      state.history = Array.isArray(payload.items) ? payload.items : [];
      setServerBadge("success", "Supabase conectado");
      dom.setupAlert.hidden = true;
      renderHistory();
    } catch (error) {
      state.serverReady = false;
      state.history = [];
      setServerBadge("warning", "Guardado pendiente");
      dom.setupAlertText.textContent = error.message || "Revisa la configuración del servidor y la migración de Supabase.";
      dom.setupAlert.hidden = false;
      dom.historyList.innerHTML = '<div class="cb-empty-panel">El historial estará disponible después de configurar Supabase.</div>';
    }
    updateReadyState();
  }

  function renderHistory() {
    if (!state.history.length) {
      dom.historyList.innerHTML = '<div class="cb-empty-panel">No hay conciliaciones guardadas.</div>';
      return;
    }
    dom.historyList.innerHTML = state.history.map(item => `<div class="cb-history-item"><div><strong>${escapeHtml(formatPeriod(item.periodo_desde, item.periodo_hasta))}</strong><small>${escapeHtml(item.mae_archivo_nombre || "MAE")} · ${escapeHtml(item.bci_archivo_nombre || "BCI")}<br>${escapeHtml(formatCreatedAt(item.created_at))}${item.creado_por ? ` · ${escapeHtml(item.creado_por)}` : ""}</small></div><div class="cb-exception-value">${Number(item.conciliados_cantidad || 0).toLocaleString("es-CL")} conciliados<small>${money(item.conciliados_monto || 0)}</small></div></div>`).join("");
  }

  async function saveResult() {
    if (!state.result || !state.mae || !state.bci) return;
    if (!state.serverReady) {
      showToast("Supabase aún no está configurado para este módulo.", true);
      return;
    }
    state.saving = true;
    updateReadyState();
    dom.btnGuardar.textContent = "Guardando...";
    try {
      const payload = await buildPersistencePayload();
      const response = await fetch(CFG.apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "No fue posible guardar la conciliación.");
      showToast("Conciliación y archivos originales guardados en Supabase.");
      await loadHistory();
    } catch (error) {
      showToast(error.message || "No fue posible guardar la conciliación.", true);
    } finally {
      state.saving = false;
      dom.btnGuardar.textContent = "Guardar conciliación";
      updateReadyState();
    }
  }

  async function buildPersistencePayload() {
    const result = state.result;
    const user = getPortalUser();
    return {
      lote: {
        estacion: CFG.estacion,
        creado_por: user,
        periodo_desde: result.periodStart,
        periodo_hasta: result.periodEnd,
        ventana_minutos: result.windowMinutes,
        mae_archivo_nombre: state.mae.file.name,
        mae_archivo_sha256: state.mae.hash,
        bci_archivo_nombre: state.bci.file.name,
        bci_archivo_sha256: state.bci.hash,
        mae_cantidad: result.summary.maeCount,
        mae_monto: result.summary.maeAmount,
        bci_caja_cantidad: result.summary.bciScopeCount,
        bci_caja_monto: result.summary.bciScopeAmount,
        conciliados_cantidad: result.summary.matchedCount,
        conciliados_monto: result.summary.matchedAmount,
        pendiente_mae_cantidad: result.summary.pendingMaeCount,
        pendiente_mae_monto: result.summary.pendingMaeAmount,
        pendiente_bci_cantidad: result.summary.pendingBciCount,
        pendiente_bci_monto: result.summary.pendingBciAmount,
        fuera_alcance_cantidad: result.summary.excludedBciCount,
        fuera_alcance_monto: result.summary.excludedBciAmount,
        resumen: result.summary
      },
      mae: state.mae.parsed.deposits.map(row => ({
        source_key: row.sourceKey, source_row: row.sourceRow, occurred_at: row.dateTime,
        maquina: row.machine, cliente: row.client, usuario: row.user, tipo: row.type,
        moneda: row.currency, monto: row.amount
      })),
      bci: state.bci.parsed.deposits.map(row => ({
        source_key: row.sourceKey, source_row: row.sourceRow, occurred_at: row.dateTime,
        fecha_contable: row.accountingDate || null, codigo_transaccion: row.transactionCode,
        tipo: row.type, glosa: row.detail, monto: row.amount, en_alcance: row.inScope,
        motivo_exclusion: row.excludedReason || null
      })),
      matches: result.matches.map(row => ({
        mae_source_key: row.mae.sourceKey, bci_source_key: row.bci.sourceKey,
        estado: row.statusKey, monto: row.amount, diferencia_segundos: row.deltaSeconds,
        cruza_dia: row.crossesDay
      })),
      files: {
        mae: { name: state.mae.file.name, mimeType: excelMime(state.mae.file.name), base64: arrayBufferToBase64(state.mae.arrayBuffer) },
        bci: { name: state.bci.file.name, mimeType: excelMime(state.bci.file.name), base64: arrayBufferToBase64(state.bci.arrayBuffer) }
      }
    };
  }

  function exportResult() {
    if (!state.result || !window.XLSX) return;
    const result = state.result;
    const workbook = XLSX.utils.book_new();
    const summaryRows = [
      ["Conciliación MAE · BCI", ""],
      ["Estación", CFG.estacion],
      ["Período", formatPeriod(result.periodStart, result.periodEnd)],
      ["Ventana máxima (minutos)", result.windowMinutes],
      ["Depósitos MAE", result.summary.maeCount],
      ["Monto MAE", result.summary.maeAmount],
      ["Conciliados", result.summary.matchedCount],
      ["Monto conciliado", result.summary.matchedAmount],
      ["Avance", result.summary.matchRate],
      ["MAE sin abono", result.summary.pendingMaeCount],
      ["BCI sin MAE", result.summary.pendingBciCount],
      ["Otros depósitos BCI", result.summary.excludedBciCount]
    ];
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
    summarySheet.B9 = Object.assign(summarySheet.B9 || {}, { t: "n", v: result.summary.matchRate, z: "0%" });
    XLSX.utils.book_append_sheet(workbook, summarySheet, "Resumen");

    const detail = result.rows.map(row => ({
      Estado: row.statusLabel,
      Importe: row.amount,
      "Fecha MAE": row.mae?.dateTime || "",
      "Fecha BCI": row.bci?.dateTime || "",
      "Diferencia minutos": row.deltaSeconds === null ? "" : row.deltaSeconds / 60,
      "Usuario MAE": row.mae?.user || "",
      "Máquina": row.mae?.machine || "",
      "Glosa BCI": row.bci?.detail || "",
      "Código BCI": row.bci?.transactionCode || ""
    }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(detail), "Detalle");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(result.unmatchedMae.map(row => ({ Fila: row.sourceRow, Fecha: row.dateTime, Importe: row.amount, Usuario: row.user, Máquina: row.machine }))), "MAE sin abono");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(result.unmatchedBci.map(row => ({ Fila: row.sourceRow, Fecha: row.dateTime, Importe: row.amount, Glosa: row.detail, Código: row.transactionCode }))), "BCI sin MAE");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(result.excludedBci.map(row => ({ Fila: row.sourceRow, Fecha: row.dateTime, Importe: row.amount, Glosa: row.detail, Motivo: row.excludedReason }))), "Otros depósitos BCI");
    XLSX.writeFile(workbook, `conciliacion_mae_bci_${result.periodStart}_${result.periodEnd}.xlsx`, { compression: true });
  }

  function setServerBadge(type, text) {
    dom.serverBadge.className = `cb-badge cb-badge--${type}`;
    dom.serverBadge.textContent = text;
  }

  function showNotice(message, type) {
    dom.uploadMessage.innerHTML = `<div class="cb-notice cb-notice--${type}">${escapeHtml(message)}</div>`;
  }

  function clearNotice() {
    dom.uploadMessage.innerHTML = "";
  }

  let toastTimer;
  function showToast(message, isError = false) {
    clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.className = `cb-toast${isError ? " is-error" : " is-success"}`;
    dom.toast.hidden = false;
    toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 4800);
  }

  function money(value) {
    return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(Number(value || 0));
  }

  function formatDateTime(value) {
    if (!value) return "—";
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
    return match ? `${match[3]}-${match[2]}-${match[1]} ${match[4]}:${match[5]}` : String(value);
  }

  function formatDelta(seconds) {
    if (seconds === null || seconds === undefined) return "—";
    const minutes = seconds / 60;
    const prefix = minutes > 0 ? "+" : "";
    const rounded = Math.abs(minutes) < 10 ? minutes.toFixed(1) : Math.round(minutes);
    return `${prefix}${rounded} min`;
  }

  function formatPeriod(from, to) {
    if (!from && !to) return "Sin período";
    return from === to ? from : `${from || "—"} a ${to || "—"}`;
  }

  function formatCreatedAt(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  async function sha256(buffer) {
    if (!window.crypto?.subtle) return `sin-hash-${buffer.byteLength}`;
    const hash = await window.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
    return btoa(binary);
  }

  function excelMime(fileName) {
    return /\.xls$/i.test(fileName) ? "application/vnd.ms-excel" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }

  function getPortalUser() {
    try {
      const stored = JSON.parse(localStorage.getItem("valepac_web_session") || "null");
      return String(stored?.nombre || stored?.usuario || "Usuario portal").slice(0, 150);
    } catch (_) {
      return "Usuario portal";
    }
  }
})();
