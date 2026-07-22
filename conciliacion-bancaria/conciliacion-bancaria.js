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
    "btnConciliar", "btnExportar", "uploadMessage", "kpiMae", "kpiMaeAmount", "kpiMatched",
    "kpiMatchedAmount", "kpiRate", "kpiPendingMae", "kpiPendingMaeAmount", "kpiPendingBci",
    "kpiPendingBciAmount", "kpiReversals", "kpiReversalsAmount", "kpiExcluded", "kpiExcludedAmount", "analysisNotes", "resultCount", "resultOrigin",
    "filterSearch", "filterYear", "filterMonth", "filterStatus", "btnLimpiarFiltros", "resultRows",
    "exceptionSummary", "btnRecargarHistorial", "historyList", "toast"
  ];
  const dom = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));

  const state = {
    mae: null,
    bci: null,
    result: null,
    uploads: [],
    updatedAt: null,
    serverReady: false,
    saving: false,
    reviewingId: null
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
    dom.btnLimpiar.addEventListener("click", () => resetFiles());
    dom.btnConciliar.addEventListener("click", submitFiles);
    dom.btnExportar.addEventListener("click", exportResult);
    dom.btnRecargarHistorial.addEventListener("click", () => loadFlow({ preserveFilters: true }));
    dom.btnLimpiarFiltros.addEventListener("click", clearFilters);
    dom.filterSearch.addEventListener("input", renderRows);
    dom.filterStatus.addEventListener("change", renderRows);
    dom.resultRows.addEventListener("click", event => {
      const button = event.target.closest("[data-reversal-id]");
      if (button) updateReversalReview(button.dataset.reversalId, button.dataset.reviewed !== "true");
    });
    dom.filterYear.addEventListener("change", renderAll);
    dom.filterMonth.addEventListener("change", renderAll);
    dom.windowMinutes.addEventListener("change", () => loadFlow({ preserveFilters: true }));
    resetKpis();
    loadFlow();
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
      state[kind] = { file, arrayBuffer, parsed };
      renderSourceSummary(kind);
      (kind === "mae" ? dom.maeDropZone : dom.bciDropZone).classList.add("has-file");
    } catch (error) {
      state[kind] = null;
      summaryEl.textContent = "Archivo no válido.";
      showNotice(error.message || "No se pudo leer el archivo.", "error");
    }
    updateReadyState();
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
      element.textContent = `${source.deposits.length.toLocaleString("es-CL")} depósitos válidos · ${money(CORE.sumAmount(source.deposits))}`;
    } else {
      const scope = source.inScope || source.deposits.filter(row => row.inScope);
      const excluded = source.excluded || source.deposits.filter(row => !row.inScope);
      const reversals = source.reversals || [];
      element.textContent = `${scope.length.toLocaleString("es-CL")} Caja Depositaria · ${reversals.length.toLocaleString("es-CL")} reversas · ${excluded.length.toLocaleString("es-CL")} otros depósitos`;
    }
    element.classList.add("is-valid");
  }

  function updateReadyState() {
    dom.btnConciliar.disabled = (!(state.mae || state.bci) || !state.serverReady || state.saving);
    dom.btnExportar.disabled = !state.result;
  }

  async function loadFlow(options = {}) {
    setServerBadge("neutral", "Actualizando historial");
    dom.btnRecargarHistorial.disabled = true;
    try {
      const separator = CFG.apiEndpoint.includes("?") ? "&" : "?";
      const response = await fetch(`${CFG.apiEndpoint}${separator}window=${encodeURIComponent(dom.windowMinutes.value || CFG.defaultWindowMinutes)}`, {
        headers: { "Accept": "application/json" }, cache: "no-store"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Servidor no disponible.");
      state.serverReady = true;
      state.result = payload.result || null;
      state.uploads = Array.isArray(payload.uploads) ? payload.uploads : [];
      state.updatedAt = payload.updatedAt || null;
      setServerBadge("success", "Supabase conectado");
      dom.setupAlert.hidden = true;
      populateYearFilter(options.preserveFilters === true);
      renderAll();
      renderHistory();
    } catch (error) {
      state.serverReady = false;
      setServerBadge("warning", "Actualización pendiente");
      dom.setupAlertText.textContent = error.message || "Revisa la configuración del servidor y la migración de Supabase.";
      dom.setupAlert.hidden = false;
      dom.historyList.innerHTML = '<div class="cb-empty-panel">Las cargas aparecerán después de activar el flujo histórico.</div>';
    } finally {
      dom.btnRecargarHistorial.disabled = false;
      updateReadyState();
    }
  }

  async function submitFiles() {
    if (!(state.mae || state.bci) || state.saving) return;
    state.saving = true;
    dom.btnConciliar.textContent = "Incorporando...";
    updateReadyState();
    try {
      const payload = buildPersistencePayload();
      const response = await fetch(CFG.apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "No fue posible incorporar los movimientos.");
      const counts = result.counts || {};
      const parts = [];
      if (state.mae) parts.push(`MAE: ${Number(counts.mae_nuevos || 0).toLocaleString("es-CL")} nuevos de ${Number(counts.mae_recibidos || 0).toLocaleString("es-CL")}`);
      if (state.bci) parts.push(`BCI: ${Number(counts.bci_nuevos || 0).toLocaleString("es-CL")} nuevos de ${Number(counts.bci_recibidos || 0).toLocaleString("es-CL")}`);
      resetFiles({ keepNotice: true });
      showNotice(`Historial actualizado. ${parts.join(" · ")}.`, "success");
      await loadFlow({ preserveFilters: true });
      showToast("La conciliación histórica fue actualizada.");
    } catch (error) {
      showNotice(error.message || "No fue posible actualizar la conciliación histórica.", "error");
      showToast(error.message || "No fue posible actualizar la conciliación histórica.", true);
    } finally {
      state.saving = false;
      dom.btnConciliar.textContent = "Incorporar al historial";
      updateReadyState();
    }
  }

  async function updateReversalReview(reversalId, reviewed) {
    if (!reversalId || state.reviewingId) return;
    state.reviewingId = reversalId;
    renderRows();
    try {
      const response = await fetch(CFG.apiEndpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ reversal_id: reversalId, reviewed, reviewed_by: getPortalUser() })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "No fue posible guardar la revisión.");
      await loadFlow({ preserveFilters: true });
      showToast(reviewed ? "Reversa marcada como revisada." : "Revisión de reversa reabierta.");
    } catch (error) {
      showToast(error.message || "No fue posible guardar la revisión.", true);
    } finally {
      state.reviewingId = null;
      renderRows();
    }
  }

  function buildPersistencePayload() {
    return {
      carga: { creado_por: getPortalUser() },
      mae: state.mae ? state.mae.parsed.deposits.map(row => ({
        source_key: row.sourceKey, source_row: row.sourceRow, occurred_at: row.dateTime,
        maquina: row.machine, cliente: row.client, usuario: row.user, tipo: row.type,
        moneda: row.currency, monto: row.amount
      })) : [],
      bci: state.bci ? (state.bci.parsed.movements || state.bci.parsed.deposits).map(row => ({
        source_key: row.sourceKey, source_row: row.sourceRow, occurred_at: row.dateTime,
        fecha_contable: row.accountingDate || null, codigo_transaccion: row.transactionCode,
        tipo: row.type, glosa: row.detail, monto: row.amount, en_alcance: row.inScope,
        motivo_exclusion: row.excludedReason || null, es_reversa: row.isReversal === true
      })) : [],
      files: {
        mae: state.mae ? { name: state.mae.file.name, base64: arrayBufferToBase64(state.mae.arrayBuffer) } : null,
        bci: state.bci ? { name: state.bci.file.name, base64: arrayBufferToBase64(state.bci.arrayBuffer) } : null
      }
    };
  }

  function renderAll() {
    renderKpis();
    renderAnalysisNotes();
    renderRows();
    renderExceptions();
    const updated = state.updatedAt ? ` · última carga ${formatCreatedAt(state.updatedAt)}` : "";
    dom.resultOrigin.textContent = `Conciliación histórica acumulada${updated}.`;
    updateReadyState();
  }

  function periodRows() {
    if (!state.result) return [];
    const year = dom.filterYear.value;
    const month = dom.filterMonth.value;
    return state.result.rows.filter(row => {
      const dateKey = rowDateKey(row);
      if (year && dateKey.slice(0, 4) !== year) return false;
      if (month && dateKey.slice(5, 7) !== month) return false;
      return true;
    });
  }

  function filteredRows() {
    const search = CORE.normalizeText(dom.filterSearch.value);
    const status = dom.filterStatus.value;
    return periodRows().filter(row => {
      if (status && row.statusKey !== status) return false;
      if (search) {
        const haystack = CORE.normalizeText([
          row.amount, row.statusLabel, row.mae?.user, row.mae?.machine,
          row.bci?.detail, row.bci?.transactionCode, row.reversal?.detail,
          row.reversal?.transactionCode, row.reversal?.reviewedBy
        ].join(" "));
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }

  function summarizeRows(rows) {
    const matched = rows.filter(row => row.statusKey === "conciliado" || row.statusKey === "demora");
    const pendingMae = rows.filter(row => row.statusKey === "pendiente_mae");
    const pendingBci = rows.filter(row => row.statusKey === "pendiente_bci");
    const reversals = rows.filter(row => row.statusKey === "reversa_bci");
    const excluded = rows.filter(row => row.statusKey === "fuera_alcance");
    const maeRows = rows.filter(row => row.mae);
    const bciScopeRows = rows.filter(row => row.bci && !["fuera_alcance", "reversa_bci"].includes(row.statusKey));
    return {
      maeCount: maeRows.length,
      maeAmount: maeRows.reduce((sum, row) => sum + Number(row.mae?.amount || 0), 0),
      bciScopeCount: bciScopeRows.length,
      bciScopeAmount: bciScopeRows.reduce((sum, row) => sum + Number(row.bci?.amount || 0), 0),
      matchedCount: matched.length,
      matchedAmount: matched.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      pendingMaeCount: pendingMae.length,
      pendingMaeAmount: CORE.sumAmount(pendingMae),
      pendingBciCount: pendingBci.length,
      pendingBciAmount: CORE.sumAmount(pendingBci),
      reversalCount: reversals.length,
      reversalAmount: CORE.sumAmount(reversals),
      reversalPendingReviewCount: reversals.filter(row => !row.reversal?.reviewed).length,
      excludedBciCount: excluded.length,
      excludedBciAmount: CORE.sumAmount(excluded),
      delayedCount: matched.filter(row => row.statusKey === "demora").length,
      crossesDayCount: matched.filter(row => row.crossesDay).length,
      within15MinutesCount: matched.filter(row => Math.abs(Number(row.deltaSeconds || 0)) <= 900).length,
      within60MinutesCount: matched.filter(row => Math.abs(Number(row.deltaSeconds || 0)) <= 3600).length,
      matchRate: maeRows.length ? matched.length / maeRows.length : 0
    };
  }

  function renderKpis() {
    if (!state.result) return resetKpis();
    const summary = summarizeRows(periodRows());
    dom.kpiMae.textContent = summary.maeCount.toLocaleString("es-CL");
    dom.kpiMaeAmount.textContent = money(summary.maeAmount);
    dom.kpiMatched.textContent = summary.matchedCount.toLocaleString("es-CL");
    dom.kpiMatchedAmount.textContent = money(summary.matchedAmount);
    dom.kpiRate.textContent = `${Math.round(summary.matchRate * 100)}%`;
    dom.kpiPendingMae.textContent = summary.pendingMaeCount.toLocaleString("es-CL");
    dom.kpiPendingMaeAmount.textContent = money(summary.pendingMaeAmount);
    dom.kpiPendingBci.textContent = summary.pendingBciCount.toLocaleString("es-CL");
    dom.kpiPendingBciAmount.textContent = money(summary.pendingBciAmount);
    dom.kpiReversals.textContent = summary.reversalCount.toLocaleString("es-CL");
    dom.kpiReversalsAmount.textContent = `${money(summary.reversalAmount)} · ${summary.reversalPendingReviewCount} por revisar`;
    dom.kpiExcluded.textContent = summary.excludedBciCount.toLocaleString("es-CL");
    dom.kpiExcludedAmount.textContent = `${money(summary.excludedBciAmount)} fuera de alcance`;
  }

  function resetKpis() {
    [dom.kpiMae, dom.kpiMatched, dom.kpiPendingMae, dom.kpiPendingBci, dom.kpiReversals, dom.kpiExcluded].forEach(el => { el.textContent = "0"; });
    [dom.kpiMaeAmount, dom.kpiMatchedAmount, dom.kpiPendingMaeAmount, dom.kpiPendingBciAmount].forEach(el => { el.textContent = "$0"; });
    dom.kpiReversalsAmount.textContent = "$0 · 0 por revisar";
    dom.kpiExcludedAmount.textContent = "$0 fuera de alcance";
    dom.kpiRate.textContent = "0%";
  }

  function renderAnalysisNotes() {
    if (!state.result) {
      dom.analysisNotes.hidden = true;
      return;
    }
    const summary = summarizeRows(periodRows());
    const chips = [
      `${summary.within15MinutesCount} coincidencias dentro de 15 minutos`,
      `${summary.within60MinutesCount} coincidencias dentro de 1 hora`,
      `${summary.delayedCount} conciliadas con demora`,
      `${summary.crossesDayCount} cruce${summary.crossesDayCount === 1 ? "" : "s"} de medianoche`,
      `${summary.reversalPendingReviewCount} reversas pendientes de revisión`
    ];
    dom.analysisNotes.innerHTML = chips.map((text, index) => `<span class="cb-analysis-chip ${index >= 2 && Number(text.split(" ")[0]) ? "is-warning" : ""}">${escapeHtml(text)}</span>`).join("");
    dom.analysisNotes.hidden = false;
  }

  function renderRows() {
    if (!state.result) {
      dom.resultCount.textContent = "Sin información";
      dom.resultRows.innerHTML = '<tr><td colspan="9" class="cb-empty">Aún no hay movimientos históricos.</td></tr>';
      return;
    }
    const rows = filteredRows();
    const periodTotal = periodRows().length;
    dom.resultCount.textContent = `${rows.length.toLocaleString("es-CL")} de ${periodTotal.toLocaleString("es-CL")} movimientos`;
    if (!rows.length) {
      dom.resultRows.innerHTML = '<tr><td colspan="9" class="cb-empty">No hay movimientos para los filtros seleccionados.</td></tr>';
      return;
    }
    dom.resultRows.innerHTML = rows.map(row => {
      const isReversal = row.statusKey === "reversa_bci";
      const code = isReversal
        ? [row.bci?.transactionCode, row.reversal?.transactionCode].filter(Boolean).join(" → ") || "—"
        : row.bci?.transactionCode || "—";
      const shortCode = code.length > 24 ? `…${code.slice(-23)}` : code;
      const bciDate = isReversal
        ? row.reversal?.matched
          ? `${formatDateTime(row.bci?.dateTime)} → ${formatDateTime(row.reversal?.dateTime)}`
          : formatDateTime(row.reversal?.dateTime)
        : formatDateTime(row.bci?.dateTime);
      const detail = isReversal
        ? row.reversal?.matched ? `${row.bci?.detail || "Abono BCI"} → ${row.reversal?.detail || "Reversa de Abono"}` : row.reversal?.detail || "Reversa de Abono"
        : row.bci?.detail || "—";
      return `<tr>
        <td>${statusBadge(row)}</td>
        <td class="cb-money">${money(row.amount)}</td>
        <td>${formatDateTime(row.mae?.dateTime)}</td>
        <td>${bciDate}</td>
        <td>${formatDelta(row.deltaSeconds)}</td>
        <td>${escapeHtml(row.mae?.user || "—")}</td>
        <td>${escapeHtml(detail)}</td>
        <td title="${escapeHtml(code)}">${escapeHtml(shortCode)}</td>
        <td>${reviewControl(row)}</td>
      </tr>`;
    }).join("");
  }

  function statusBadge(row) {
    const css = row.statusKey === "conciliado" ? "matched"
      : row.statusKey === "demora" ? "delay"
        : row.statusKey === "reversa_bci" ? "reversal"
        : row.statusKey === "fuera_alcance" ? "excluded" : "pending";
    return `<span class="cb-status cb-status--${css}">${escapeHtml(row.statusLabel)}</span>`;
  }

  function reviewControl(row) {
    if (row.statusKey !== "reversa_bci" || !row.reversal?.id) return "—";
    const reviewed = row.reversal.reviewed === true;
    const loading = state.reviewingId === row.reversal.id;
    const title = reviewed
      ? `Revisado${row.reversal.reviewedBy ? ` por ${row.reversal.reviewedBy}` : ""}${row.reversal.reviewedAt ? ` el ${formatCreatedAt(row.reversal.reviewedAt)}` : ""}`
      : "Marcar este evento como revisado";
    return `<button class="cb-review-btn${reviewed ? " is-reviewed" : ""}" type="button" data-reversal-id="${escapeHtml(row.reversal.id)}" data-reviewed="${reviewed}" title="${escapeHtml(title)}" ${loading ? "disabled" : ""}>${loading ? "Guardando..." : reviewed ? "✓ Revisado" : "Marcar revisado"}</button>`;
  }

  function renderExceptions() {
    if (!state.result) {
      dom.exceptionSummary.className = "cb-empty-panel";
      dom.exceptionSummary.textContent = "Todavía no hay resultados.";
      return;
    }
    const summary = summarizeRows(periodRows());
    const items = [
      { title: "Depósitos MAE sin abono", note: "Requieren revisar el corte o el ingreso en BCI.", count: summary.pendingMaeCount, amount: summary.pendingMaeAmount },
      { title: "Abonos BCI sin depósito MAE", note: "Caja Depositaria sin pareja dentro del flujo histórico.", count: summary.pendingBciCount, amount: summary.pendingBciAmount },
      { title: "Reversas BCI por revisar", note: "Abonos anulados por el banco; quedan fuera de la conciliación normal.", count: summary.reversalPendingReviewCount, amount: periodRows().filter(row => row.statusKey === "reversa_bci" && !row.reversal?.reviewed).reduce((sum, row) => sum + Number(row.amount || 0), 0) },
      { title: "Coincidencias con demora", note: `Mismo importe dentro de ${state.result.windowMinutes} minutos.`, count: summary.delayedCount, amount: periodRows().filter(row => row.statusKey === "demora").reduce((sum, row) => sum + Number(row.amount || 0), 0) },
      { title: "Otros depósitos BCI", note: "Caja manual o cheque; se informan, pero no se concilian con MAE.", count: summary.excludedBciCount, amount: summary.excludedBciAmount }
    ];
    dom.exceptionSummary.className = "cb-exception-list";
    dom.exceptionSummary.innerHTML = items.map(item => `<div class="cb-exception-item"><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.note)}</small></div><div class="cb-exception-value">${item.count.toLocaleString("es-CL")}<small>${money(item.amount)}</small></div></div>`).join("");
  }

  function renderHistory() {
    if (!state.uploads.length) {
      dom.historyList.innerHTML = '<div class="cb-empty-panel">Todavía no hay archivos incorporados.</div>';
      return;
    }
    dom.historyList.innerHTML = state.uploads.map(item => {
      const files = [item.mae_archivo_nombre, item.bci_archivo_nombre].filter(Boolean).join(" · ") || "Carga histórica";
      const counts = [];
      if (Number(item.mae_recibidos || 0)) counts.push(`MAE ${Number(item.mae_nuevos || 0).toLocaleString("es-CL")} nuevos de ${Number(item.mae_recibidos || 0).toLocaleString("es-CL")}`);
      if (Number(item.bci_recibidos || 0)) counts.push(`BCI ${Number(item.bci_nuevos || 0).toLocaleString("es-CL")} nuevos de ${Number(item.bci_recibidos || 0).toLocaleString("es-CL")}`);
      const source = item.fuente === "ambas" ? "MAE + BCI" : String(item.fuente || "").toUpperCase();
      return `<div class="cb-history-item">
        <div class="cb-history-info"><strong>${escapeHtml(files)}</strong><small>${escapeHtml(formatCreatedAt(item.created_at))}${item.creado_por ? ` · ${escapeHtml(item.creado_por)}` : ""}<br>${escapeHtml(counts.join(" · ") || "Datos migrados al flujo")}</small></div>
        <span class="cb-source-badge">${escapeHtml(source)}</span>
      </div>`;
    }).join("");
  }

  function populateYearFilter(preserve) {
    const previous = preserve ? dom.filterYear.value : "";
    const years = [...new Set((state.result?.rows || []).map(row => rowDateKey(row).slice(0, 4)).filter(year => /^\d{4}$/.test(year)))].sort().reverse();
    dom.filterYear.innerHTML = '<option value="">Todos los años</option>' + years.map(year => `<option value="${year}">${year}</option>`).join("");
    dom.filterYear.value = years.includes(previous) ? previous : "";
  }

  function clearFilters() {
    dom.filterSearch.value = "";
    dom.filterYear.value = "";
    dom.filterMonth.value = "";
    dom.filterStatus.value = "";
    renderAll();
  }

  function resetFiles(options = {}) {
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
    if (!options.keepNotice) clearNotice();
    updateReadyState();
  }

  function exportResult() {
    if (!state.result || !window.XLSX) return;
    const rows = filteredRows();
    const summary = summarizeRows(periodRows());
    const workbook = XLSX.utils.book_new();
    const scope = [dom.filterYear.value || "Todos los años", dom.filterMonth.options[dom.filterMonth.selectedIndex]?.text || "Todos los meses"].join(" · ");
    const summaryRows = [
      ["Conciliación histórica MAE · BCI", ""], ["Estación", CFG.estacion], ["Filtro", scope],
      ["Ventana máxima (minutos)", state.result.windowMinutes], ["Depósitos MAE", summary.maeCount],
      ["Monto MAE", summary.maeAmount], ["Conciliados", summary.matchedCount], ["Monto conciliado", summary.matchedAmount],
      ["Avance", summary.matchRate], ["MAE sin abono", summary.pendingMaeCount], ["BCI sin MAE", summary.pendingBciCount],
      ["Reversas BCI", summary.reversalCount], ["Reversas pendientes de revisión", summary.reversalPendingReviewCount],
      ["Otros depósitos BCI", summary.excludedBciCount]
    ];
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
    summarySheet.B9 = Object.assign(summarySheet.B9 || {}, { t: "n", v: summary.matchRate, z: "0%" });
    XLSX.utils.book_append_sheet(workbook, summarySheet, "Resumen");
    const detail = rows.map(row => ({
      Estado: row.statusLabel, Importe: row.amount, "Fecha MAE": row.mae?.dateTime || "",
      "Fecha BCI": row.bci?.dateTime || "", "Diferencia minutos": row.deltaSeconds == null ? "" : row.deltaSeconds / 60,
      "Usuario MAE": row.mae?.user || "", Máquina: row.mae?.machine || "",
      "Glosa BCI": row.bci?.detail || "", "Código BCI": row.bci?.transactionCode || "",
      "Fecha reversa": row.reversal?.dateTime || "", "Código reversa": row.reversal?.transactionCode || "",
      Revisado: row.reversal ? (row.reversal.reviewed ? "Sí" : "No") : "",
      "Revisado por": row.reversal?.reviewedBy || "", "Fecha revisión": row.reversal?.reviewedAt || ""
    }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(detail), "Detalle");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(state.uploads.map(item => ({
      Fecha: formatCreatedAt(item.created_at), Usuario: item.creado_por || "", Fuente: item.fuente,
      "Archivo MAE": item.mae_archivo_nombre || "", "MAE recibidos": item.mae_recibidos, "MAE nuevos": item.mae_nuevos,
      "Archivo BCI": item.bci_archivo_nombre || "", "BCI recibidos": item.bci_recibidos, "BCI nuevos": item.bci_nuevos
    }))), "Cargas");
    XLSX.writeFile(workbook, `conciliacion_historica_mae_bci_${dom.filterYear.value || "total"}_${dom.filterMonth.value || "todos"}.xlsx`, { compression: true });
  }

  function rowDateKey(row) {
    return String(row.reversal?.dateKey || row.mae?.dateKey || row.bci?.dateKey || "").slice(0, 10);
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
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return match ? `${match[3]}-${match[2]}-${match[1]} ${match[4]}:${match[5]}` : String(value);
  }

  function formatDelta(seconds) {
    if (seconds === null || seconds === undefined) return "—";
    const minutes = seconds / 60;
    const prefix = minutes > 0 ? "+" : "";
    const rounded = Math.abs(minutes) < 10 ? minutes.toFixed(1) : Math.round(minutes);
    return `${prefix}${rounded} min`;
  }

  function formatCreatedAt(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
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

  function getPortalUser() {
    try {
      const stored = JSON.parse(localStorage.getItem("valepac_web_session") || "null");
      return String(stored?.nombre || stored?.usuario || "Usuario portal").slice(0, 150);
    } catch (_) {
      return "Usuario portal";
    }
  }
})();
