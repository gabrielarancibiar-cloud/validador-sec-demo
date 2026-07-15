(() => {
  "use strict";

  const CONFIG = Object.assign({
    supabaseUrl: "",
    supabaseAnonKey: "",
    supabaseClientGlobal: "supabaseClient",
    defaultEds: "40098",
    tableName: "facturas_copec",
    importRpc: "importar_facturas_copec",
    updateRpc: "actualizar_factura_copec",
    bulkUpdateRpc: "actualizar_facturas_copec_masivo",
    pageSize: 50,
    maxRows: 10000,
    allowDemoMode: true
  }, window.FACTURAS_COPEC_CONFIG || {});

  const COMMON_HEADERS = {
    fecha_movimiento: ["fecha movimiento", "fecha"],
    dias_vencidos: ["dias vencidos", "día vencidos", "días vencidos"],
    eds: ["n eds", "nº eds", "n° eds", "numero eds", "eds"],
    linea_producto: ["linea producto", "línea producto", "linea de producto"],
    tipo_movimiento: ["tipo movimiento", "tipo de movimiento"],
    numero_documento: ["n documento", "nº documento", "n° documento", "numero documento"],
    cargos: ["cargos", "cargo"],
    abonos: ["abonos", "abono"]
  };

  const OPTIONAL_HEADERS = {
    fecha_vencimiento: ["fecha vencimiento", "fecha de vencimiento", "vencimiento"],
    saldo_portal: ["saldo", "saldo portal"]
  };

  const STATUS_CLASS = {
    "Pendiente de revisión": "fc-status--pending",
    "No corresponde": "fc-status--no",
    "Pendiente de pago": "fc-status--pay",
    "Pago incompleto": "fc-status--partial",
    "Pagada": "fc-status--paid"
  };

  const dom = {};
  const state = {
    backend: null,
    backendMode: "unavailable",
    records: [],
    filtered: [],
    previewRows: [],
    previewBatches: [],
    previewMeta: null,
    currentEditId: null,
    page: 1,
    loading: false,
    selectedIds: new Set()
  };

  class RestBackend {
    constructor(url, anonKey) {
      this.url = String(url || "").replace(/\/$/, "");
      this.key = anonKey;
    }

    async request(path, options = {}) {
      const headers = Object.assign({
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json"
      }, options.headers || {});
      const response = await fetch(`${this.url}${path}`, Object.assign({}, options, { headers }));
      const text = await response.text();
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); } catch (_) { payload = text; }
      }
      if (!response.ok) {
        const message = payload?.message || payload?.hint || payload?.details || String(payload || response.statusText);
        throw new Error(message);
      }
      return payload;
    }

    async list() {
      const order = encodeURIComponent("fecha_vencimiento.asc.nullslast,fecha_movimiento.desc,numero_documento.desc");
      return this.request(`/rest/v1/${CONFIG.tableName}?select=*&order=${order}&limit=${CONFIG.maxRows}`);
    }

    async import(rows, fileName, userName) {
      return this.request(`/rest/v1/rpc/${CONFIG.importRpc}`, {
        method: "POST",
        body: JSON.stringify({ p_facturas: rows, p_nombre_archivo: fileName, p_usuario_nombre: userName || null })
      });
    }

    async update(id, values, userName) {
      return this.request(`/rest/v1/rpc/${CONFIG.updateRpc}`, {
        method: "POST",
        body: JSON.stringify({
          p_id: id,
          p_corresponde_incluir: values.corresponde_incluir,
          p_fecha_pago: values.fecha_pago || null,
          p_numero_pago: values.numero_pago || null,
          p_metodo_pago: values.metodo_pago || null,
          p_grupo_costo: values.grupo_costo || null,
          p_observaciones: values.observaciones || null,
          p_usuario_nombre: userName || null
        })
      });
    }

    async bulkUpdate(ids, values, userName) {
      return this.request(`/rest/v1/rpc/${CONFIG.bulkUpdateRpc}`, {
        method: "POST",
        body: JSON.stringify({
          p_ids: ids,
          p_actualizar_corresponde: !!values.updateCorresponde,
          p_corresponde_incluir: values.corresponde_incluir || null,
          p_actualizar_grupo_costo: !!values.updateGrupoCosto,
          p_grupo_costo: values.grupo_costo,
          p_usuario_nombre: userName || null
        })
      });
    }
  }

  class SupabaseBackend {
    constructor(client) { this.client = client; }

    async list() {
      const { data, error } = await this.client
        .from(CONFIG.tableName)
        .select("*")
        .limit(CONFIG.maxRows);
      if (error) throw error;
      return data || [];
    }

    async import(rows, fileName, userName) {
      const { data, error } = await this.client.rpc(CONFIG.importRpc, {
        p_facturas: rows,
        p_nombre_archivo: fileName,
        p_usuario_nombre: userName || null
      });
      if (error) throw error;
      return data;
    }

    async update(id, values, userName) {
      const { data, error } = await this.client.rpc(CONFIG.updateRpc, {
        p_id: id,
        p_corresponde_incluir: values.corresponde_incluir,
        p_fecha_pago: values.fecha_pago || null,
        p_numero_pago: values.numero_pago || null,
        p_metodo_pago: values.metodo_pago || null,
        p_grupo_costo: values.grupo_costo || null,
        p_observaciones: values.observaciones || null,
        p_usuario_nombre: userName || null
      });
      if (error) throw error;
      return data;
    }

    async bulkUpdate(ids, values, userName) {
      const { data, error } = await this.client.rpc(CONFIG.bulkUpdateRpc, {
        p_ids: ids,
        p_actualizar_corresponde: !!values.updateCorresponde,
        p_corresponde_incluir: values.corresponde_incluir || null,
        p_actualizar_grupo_costo: !!values.updateGrupoCosto,
        p_grupo_costo: values.grupo_costo,
        p_usuario_nombre: userName || null
      });
      if (error) throw error;
      return data;
    }
  }

  class DemoBackend {
    constructor() { this.key = "valepac_facturas_copec_demo_v3"; }
    read() {
      try { return JSON.parse(localStorage.getItem(this.key) || "[]"); }
      catch (_) { return []; }
    }
    write(rows) { localStorage.setItem(this.key, JSON.stringify(rows)); }
    async list() { return this.read().sort(sortInvoices); }
    async import(rows, fileName, userName) {
      const current = this.read();
      let nuevas = 0;
      let actualizadas = 0;
      let fusionadas = 0;
      rows.forEach(row => {
        let index = current.findIndex(item => sourceKey(item) === sourceKey(row));
        if (index < 0) {
          index = current.findIndex(item => canMergeRecords(item, row));
          if (index >= 0) fusionadas += 1;
        }
        if (index >= 0) {
          current[index] = mergeDemoRecord(current[index], row, fileName, userName);
          actualizadas += 1;
        } else {
          current.push(Object.assign({}, row, {
            id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
            corresponde_incluir: "pendiente",
            fecha_pago: null,
            numero_pago: null,
            metodo_pago: null,
            grupo_costo: null,
            observaciones: null,
            estado_conciliacion: "Pendiente",
            monto_conciliado: 0,
            creado_en: new Date().toISOString(),
            actualizado_en: new Date().toISOString(),
            archivo_ultima_carga: fileName,
            usuario_ultima_importacion: userName
          }));
          nuevas += 1;
        }
      });
      this.write(current);
      return { recibidas: rows.length, nuevas, actualizadas, fusionadas, ignoradas: 0 };
    }
    async update(id, values) {
      const rows = this.read();
      const index = rows.findIndex(row => String(row.id) === String(id));
      if (index < 0) throw new Error("No se encontró la factura.");
      rows[index] = Object.assign({}, rows[index], values, { actualizado_en: new Date().toISOString() });
      this.write(rows);
      return rows[index];
    }

    async bulkUpdate(ids, values, userName) {
      const selected = new Set(ids.map(String));
      const rows = this.read();
      let updated = 0;
      rows.forEach((row, index) => {
        if (!selected.has(String(row.id))) return;
        const patch = {
          actualizado_en: new Date().toISOString(),
          usuario_ultima_actualizacion: userName || null
        };
        if (values.updateCorresponde) patch.corresponde_incluir = values.corresponde_incluir;
        if (values.updateGrupoCosto) patch.grupo_costo = values.grupo_costo || null;
        rows[index] = Object.assign({}, row, patch);
        updated += 1;
      });
      this.write(rows);
      return { actualizadas: updated };
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheDom();
    bindEvents();
    configureBackend();
    await loadRecords();
  }

  function cacheDom() {
    [
      "backendBadge", "setupAlert", "btnExportar", "btnRecargar", "dropZone", "excelInput", "btnSeleccionar", "fileStatus",
      "kpiTotal", "kpiPendientes", "kpiPago", "kpiPagadas", "kpiMonto", "resultCount", "filterSearch", "filterEstado",
      "filterIncluir", "filterVigencia", "filterLinea", "filterDesde", "filterHasta", "btnLimpiarFiltros", "invoiceRows", "btnPrev", "btnNext",
      "selectPageCheckbox", "selectionBar", "selectionCount", "btnSelectFiltered", "btnClearSelection", "bulkUpdateIncluir", "bulkIncluir",
      "bulkUpdateGrupo", "bulkGrupoCosto", "btnApplyBulk", "pageInfo", "previewDialog", "previewSummary", "previewRows", "btnConfirmarImportacion", "editDialog", "editForm", "editTitle",
      "editInvoiceInfo", "editIncluir", "editFechaPago", "editNumeroPago", "editMetodoPago", "editGrupoCosto", "gruposCostoList",
      "editObservaciones", "btnCerrarEdicion", "btnCancelarEdicion", "btnGuardarEdicion", "toast"
    ].forEach(id => { dom[id] = document.getElementById(id); });
  }

  function bindEvents() {
    dom.btnSeleccionar.addEventListener("click", event => { event.stopPropagation(); dom.excelInput.click(); });
    dom.dropZone.addEventListener("click", () => dom.excelInput.click());
    dom.dropZone.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); dom.excelInput.click(); }
    });
    dom.excelInput.addEventListener("change", () => handleFiles(Array.from(dom.excelInput.files || [])));
    ["dragenter", "dragover"].forEach(type => dom.dropZone.addEventListener(type, event => {
      event.preventDefault(); dom.dropZone.classList.add("is-dragging");
    }));
    ["dragleave", "drop"].forEach(type => dom.dropZone.addEventListener(type, event => {
      event.preventDefault(); dom.dropZone.classList.remove("is-dragging");
    }));
    dom.dropZone.addEventListener("drop", event => handleFiles(Array.from(event.dataTransfer.files || [])));

    dom.btnConfirmarImportacion.addEventListener("click", confirmImport);
    dom.btnRecargar.addEventListener("click", loadRecords);
    dom.btnExportar.addEventListener("click", exportRecords);
    dom.btnLimpiarFiltros.addEventListener("click", clearFilters);
    [dom.filterSearch, dom.filterEstado, dom.filterIncluir, dom.filterVigencia, dom.filterLinea, dom.filterDesde, dom.filterHasta]
      .filter(Boolean)
      .forEach(input => input.addEventListener(input.tagName === "INPUT" && input.type === "search" ? "input" : "change", applyFilters));
    dom.btnPrev.addEventListener("click", () => changePage(-1));
    dom.btnNext.addEventListener("click", () => changePage(1));
    dom.selectPageCheckbox.addEventListener("change", () => selectCurrentPage(dom.selectPageCheckbox.checked));
    dom.btnSelectFiltered.addEventListener("click", selectAllFiltered);
    dom.btnClearSelection.addEventListener("click", clearSelection);
    dom.bulkUpdateIncluir.addEventListener("change", syncBulkControls);
    dom.bulkUpdateGrupo.addEventListener("change", syncBulkControls);
    dom.bulkIncluir.addEventListener("change", () => { dom.bulkUpdateIncluir.checked = true; syncBulkControls(); });
    dom.bulkGrupoCosto.addEventListener("input", syncBulkControls);
    dom.btnApplyBulk.addEventListener("click", applyBulkUpdate);
    dom.invoiceRows.addEventListener("change", event => {
      const checkbox = event.target.closest("[data-select-id]");
      if (checkbox) toggleSelection(checkbox.dataset.selectId, checkbox.checked);
    });
    dom.invoiceRows.addEventListener("click", event => {
      const button = event.target.closest("[data-edit-id]");
      if (button) openEdit(button.dataset.editId);
    });
    dom.editForm.addEventListener("submit", saveEdit);
    dom.btnCerrarEdicion.addEventListener("click", closeEdit);
    dom.btnCancelarEdicion.addEventListener("click", closeEdit);
    window.addEventListener("facturasCopec:reload", loadRecords);
  }

  function configureBackend() {
    const params = new URLSearchParams(location.search);
    const demoRequested = params.get("demo") === "1";
    const client = window[CONFIG.supabaseClientGlobal] || window.supabaseClient || window.valepacSupabase;

    if (client && typeof client.from === "function" && typeof client.rpc === "function") {
      state.backend = new SupabaseBackend(client);
      state.backendMode = "supabase";
      setBackendBadge("Conectado a Supabase", "success");
      dom.setupAlert.hidden = true;
      return;
    }

    if (CONFIG.supabaseUrl && CONFIG.supabaseAnonKey) {
      state.backend = new RestBackend(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
      state.backendMode = "rest";
      setBackendBadge("Conectado a Supabase", "success");
      dom.setupAlert.hidden = true;
      return;
    }

    if (demoRequested && CONFIG.allowDemoMode) {
      state.backend = new DemoBackend();
      state.backendMode = "demo";
      setBackendBadge("Modo de prueba local", "warning");
      dom.setupAlert.hidden = true;
      return;
    }

    state.backend = null;
    state.backendMode = "unavailable";
    setBackendBadge("Sin conexión", "danger");
    dom.setupAlert.hidden = false;
  }

  async function loadRecords() {
    if (!state.backend || state.loading) {
      renderAll();
      return;
    }
    setLoading(true, "Cargando facturas…");
    try {
      const rows = await state.backend.list();
      state.records = (Array.isArray(rows) ? rows : []).map(normalizeDbRecord).sort(sortInvoices);
      state.selectedIds.clear();
      state.page = 1;
      rebuildSelectOptions();
      applyFilters();
    } catch (error) {
      showToast(`No se pudieron cargar las facturas: ${error.message}`, "error");
      state.records = [];
      renderAll();
    } finally {
      setLoading(false);
      renderAll();
    }
  }

  async function handleFiles(files) {
    if (!files.length) return;
    const invalid = files.find(file => !/\.(xlsx|xls)$/i.test(file.name));
    if (invalid) {
      showToast(`${invalid.name} no es un archivo Excel válido.`, "error");
      return;
    }
    if (typeof XLSX === "undefined") {
      showToast("No se cargó la librería para leer Excel.", "error");
      return;
    }

    state.previewRows = [];
    state.previewBatches = [];
    const totals = {
      valid: 0, newCount: 0, updateCount: 0, mergeCount: 0,
      ignored: 0, repeatedRows: 0, historicalFiles: 0, currentFiles: 0
    };

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setFileStatus(`Leyendo ${index + 1} de ${files.length}: ${file.name}…`);
        const parsed = await parseExcel(file);
        state.previewBatches.push({ fileName: file.name, rows: parsed.rows, meta: parsed.meta });
        state.previewRows.push(...parsed.rows);
        Object.keys(totals).forEach(key => { totals[key] += Number(parsed.meta[key] || 0); });
      }

      state.previewMeta = Object.assign(totals, {
        fileCount: files.length,
        fileNames: files.map(file => file.name)
      });
      renderPreview();
      dom.previewDialog.showModal();
      setFileStatus(`${totals.valid} facturas encontradas en ${files.length} archivo${files.length === 1 ? "" : "s"}.`);
    } catch (error) {
      state.previewRows = [];
      state.previewBatches = [];
      state.previewMeta = null;
      setFileStatus(`Error: ${error.message}`, true);
      showToast(error.message, "error");
    } finally {
      dom.excelInput.value = "";
    }
  }

  async function parseExcel(file) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { cellDates: true });
    if (!workbook.SheetNames?.length) throw new Error(`${file.name}: el archivo no contiene hojas.`);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });
    if (!rawRows.length) throw new Error(`${file.name}: la primera hoja está vacía.`);

    const definitions = Object.assign({}, COMMON_HEADERS, OPTIONAL_HEADERS);
    const headerMap = createHeaderMap(Object.keys(rawRows[0]), definitions);
    const missing = Object.keys(COMMON_HEADERS).filter(key => !headerMap[key]);
    if (missing.length) {
      throw new Error(`${file.name}: faltan columnas: ${missing.map(prettyField).join(", ")}.`);
    }

    const hasDueDate = Boolean(headerMap.fecha_vencimiento);
    const hasBalance = Boolean(headerMap.saldo_portal);
    if (!hasDueDate && !hasBalance) {
      throw new Error(`${file.name}: no se reconoce como cartola histórica ni como cartola vigente.`);
    }
    const format = hasDueDate ? "vigente" : "historico";

    const occurrenceMap = new Map();
    const rows = [];
    let ignored = 0;
    let repeatedRows = 0;
    let newCount = 0;
    let updateCount = 0;
    let mergeCount = 0;

    rawRows.forEach((source, index) => {
      const type = stringValue(source[headerMap.tipo_movimiento]);
      if (normalizeText(type) !== "factura") { ignored += 1; return; }

      const numeroDocumento = documentValue(source[headerMap.numero_documento]);
      if (!numeroDocumento) { ignored += 1; return; }

      const fechaMovimiento = toIsoDate(source[headerMap.fecha_movimiento]);
      const fechaVencimiento = hasDueDate ? toIsoDate(source[headerMap.fecha_vencimiento]) : null;
      const cargos = numberValue(source[headerMap.cargos]);
      const eds = documentValue(source[headerMap.eds]) || CONFIG.defaultEds;
      const occurrenceBase = [format, eds, numeroDocumento, fechaMovimiento || "", fechaVencimiento || "", roundMoney(cargos)].join("|");
      const occurrence = (occurrenceMap.get(occurrenceBase) || 0) + 1;
      occurrenceMap.set(occurrenceBase, occurrence);
      if (occurrence > 1) repeatedRows += 1;

      const row = {
        fecha_movimiento: fechaMovimiento,
        fecha_vencimiento: fechaVencimiento,
        plazo_dias: dateDifference(fechaMovimiento, fechaVencimiento),
        dias_vencidos: integerValue(source[headerMap.dias_vencidos]),
        eds,
        linea_producto: stringValue(source[headerMap.linea_producto]),
        tipo_movimiento: "Factura",
        numero_documento: numeroDocumento,
        cargos,
        abonos: numberValue(source[headerMap.abonos]),
        saldo_portal: hasBalance ? numberValue(source[headerMap.saldo_portal]) : 0,
        formato_origen: format,
        ocurrencia_origen: occurrence,
        fila_origen: index + 2
      };

      const match = classifyPreviewMatch(row);
      if (match === "exact") updateCount += 1;
      else if (match === "merge") mergeCount += 1;
      else newCount += 1;
      rows.push(row);
    });

    if (!rows.length) throw new Error(`${file.name}: no se encontraron filas con Tipo Movimiento = Factura.`);
    rows.sort((a, b) => {
      if (format === "vigente") {
        const due = String(a.fecha_vencimiento || "").localeCompare(String(b.fecha_vencimiento || ""));
        if (due !== 0) return due;
      }
      return String(a.fila_origen || 0).localeCompare(String(b.fila_origen || 0), "es", { numeric: true });
    });

    return {
      rows,
      meta: {
        totalSource: rawRows.length,
        valid: rows.length,
        ignored,
        repeatedRows,
        newCount,
        updateCount,
        mergeCount,
        historicalFiles: format === "historico" ? 1 : 0,
        currentFiles: format === "vigente" ? 1 : 0,
        format,
        sheetName: workbook.SheetNames[0]
      }
    };
  }

  function classifyPreviewMatch(row) {
    if (state.records.some(item => sourceKey(item) === sourceKey(row))) return "exact";
    if (state.records.some(item => canMergeRecords(item, row))) return "merge";
    return "new";
  }

  function createHeaderMap(headers, definitions) {
    const normalizedHeaders = new Map(headers.map(header => [normalizeText(header), header]));
    const result = {};
    Object.entries(definitions).forEach(([field, aliases]) => {
      const found = aliases.map(normalizeText).find(alias => normalizedHeaders.has(alias));
      if (found) result[field] = normalizedHeaders.get(found);
    });
    return result;
  }

  function renderPreview() {
    const meta = state.previewMeta;
    dom.previewSummary.innerHTML = [
      ["Archivos", meta.fileCount],
      ["Cartolas históricas", meta.historicalFiles],
      ["Cartolas vigentes", meta.currentFiles],
      ["Facturas válidas", meta.valid],
      ["Nuevas", meta.newCount],
      ["A actualizar", meta.updateCount],
      ["A fusionar", meta.mergeCount],
      ["Otras filas ignoradas", meta.ignored],
      ["Cuotas/repeticiones conservadas", meta.repeatedRows]
    ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${formatNumber(value)}</strong></div>`).join("");

    dom.previewRows.innerHTML = state.previewRows.slice(0, 120).map(row => `
      <tr>
        <td>${formatDate(row.fecha_movimiento)}</td>
        <td>${formatDate(row.fecha_vencimiento)}</td>
        <td>${originLabel(row)}</td>
        <td>${escapeHtml(row.linea_producto || "—")}</td>
        <td class="fc-document">${escapeHtml(row.numero_documento)}</td>
        <td class="fc-money">${formatCurrency(row.cargos)}</td>
      </tr>`).join("");
  }

  async function confirmImport() {
    if (!state.backend) {
      dom.previewDialog.close();
      showToast("Primero debe conectar el módulo con Supabase.", "error");
      return;
    }
    if (!state.previewBatches.length) return;

    const button = dom.btnConfirmarImportacion;
    button.disabled = true;
    button.textContent = "Importando…";
    const totals = { nuevas: 0, actualizadas: 0, fusionadas: 0, ignoradas: 0 };
    try {
      for (let index = 0; index < state.previewBatches.length; index += 1) {
        const batch = state.previewBatches[index];
        button.textContent = `Importando ${index + 1}/${state.previewBatches.length}…`;
        const result = await state.backend.import(batch.rows, batch.fileName, getCurrentUserName());
        const summary = normalizeImportResult(result);
        Object.keys(totals).forEach(key => { totals[key] += Number(summary[key] || 0); });
      }
      dom.previewDialog.close();
      showToast(`Carga terminada: ${totals.nuevas} nuevas, ${totals.actualizadas} actualizadas y ${totals.fusionadas} fusionadas.`, "success");
      setFileStatus(`Carga completada · ${totals.nuevas} nuevas · ${totals.actualizadas} actualizadas · ${totals.fusionadas} fusionadas.`);
      state.previewRows = [];
      state.previewBatches = [];
      state.previewMeta = null;
      await loadRecords();
    } catch (error) {
      showToast(`No se pudo importar: ${error.message}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Importar archivos";
    }
  }

  function normalizeImportResult(result) {
    const value = Array.isArray(result) ? (result[0] || {}) : (result || {});
    return {
      nuevas: Number(value.nuevas ?? value.insertadas ?? 0),
      actualizadas: Number(value.actualizadas ?? 0),
      fusionadas: Number(value.fusionadas ?? 0),
      ignoradas: Number(value.ignoradas ?? 0)
    };
  }

  function applyFilters() {
    state.selectedIds.clear();
    const search = normalizeText(dom.filterSearch.value);
    const estado = dom.filterEstado.value;
    const incluir = dom.filterIncluir.value;
    const vigencia = dom.filterVigencia?.value || "";
    const linea = dom.filterLinea.value;
    const desde = dom.filterDesde.value;
    const hasta = dom.filterHasta.value;

    state.filtered = state.records.filter(row => {
      const rowStatus = calculateStatus(row);
      const haystack = normalizeText([
        row.numero_documento, row.linea_producto, row.numero_pago, row.metodo_pago,
        row.grupo_costo, row.observaciones, row.eds, row.estado_conciliacion,
        portalStatus(row), originLabel(row)
      ].filter(Boolean).join(" "));
      if (search && !haystack.includes(search)) return false;
      if (estado && rowStatus !== estado) return false;
      if (incluir && (row.corresponde_incluir || "pendiente") !== incluir) return false;
      if (vigencia && portalStatus(row) !== vigencia) return false;
      if (linea && row.linea_producto !== linea) return false;
      if (desde && (!row.fecha_vencimiento || row.fecha_vencimiento < desde)) return false;
      if (hasta && (!row.fecha_vencimiento || row.fecha_vencimiento > hasta)) return false;
      return true;
    }).sort(sortInvoices);
    state.page = 1;
    renderAll();
  }

  function clearFilters() {
    [dom.filterSearch, dom.filterEstado, dom.filterIncluir, dom.filterVigencia, dom.filterLinea, dom.filterDesde, dom.filterHasta]
      .filter(Boolean)
      .forEach(input => { input.value = ""; });
    applyFilters();
  }

  function renderAll() {
    renderKpis();
    renderTable();
    renderPagination();
    renderSelectionControls();
    dom.resultCount.textContent = `${formatNumber(state.filtered.length)} resultado${state.filtered.length === 1 ? "" : "s"}`;
    dom.btnExportar.disabled = state.records.length === 0;
  }

  function renderKpis() {
    const total = state.records.length;
    const current = state.records.filter(row => row.vigente_portal === true).length;
    const next30 = state.records.filter(row => {
      if (row.vigente_portal !== true || !row.fecha_vencimiento) return false;
      const days = daysFromToday(row.fecha_vencimiento);
      return days >= 0 && days <= 30;
    }).length;
    const paid = state.records.filter(row => row.estado_conciliacion === "Conciliada" || calculateStatus(row) === "Pagada").length;
    const currentAmount = state.records
      .filter(row => row.vigente_portal === true)
      .reduce((sum, row) => sum + numberValue(row.cargos), 0);

    dom.kpiTotal.textContent = formatNumber(total);
    dom.kpiPendientes.textContent = formatNumber(current);
    dom.kpiPago.textContent = formatNumber(next30);
    dom.kpiPagadas.textContent = formatNumber(paid);
    dom.kpiMonto.textContent = formatCurrency(currentAmount);
  }

  function renderTable() {
    if (state.loading) {
      dom.invoiceRows.innerHTML = `<tr><td colspan="17" class="fc-empty">Cargando registros…</td></tr>`;
      return;
    }
    if (!state.filtered.length) {
      const message = state.backend ? "No hay facturas para mostrar." : "Conecte Supabase para cargar los registros.";
      dom.invoiceRows.innerHTML = `<tr><td colspan="17" class="fc-empty">${message}</td></tr>`;
      return;
    }

    const pages = Math.max(1, Math.ceil(state.filtered.length / CONFIG.pageSize));
    state.page = Math.min(pages, Math.max(1, state.page));
    const pageRows = getCurrentPageRows();
    dom.invoiceRows.innerHTML = pageRows.map(row => {
      const status = calculateStatus(row);
      const includeValue = row.corresponde_incluir || "pendiente";
      const includeLabel = includeValue === "si" ? "Sí" : includeValue === "no" ? "No" : "Pendiente";
      const includeClass = includeValue === "si" ? "fc-status--yes" : includeValue === "no" ? "fc-status--no" : "fc-status--pending";
      const selected = state.selectedIds.has(String(row.id));
      return `
        <tr class="${selected ? "is-selected" : ""}">
          <td class="fc-select-cell"><input class="fc-row-check" type="checkbox" data-select-id="${escapeHtml(row.id)}" aria-label="Seleccionar factura ${escapeHtml(row.numero_documento)}" ${selected ? "checked" : ""} /></td>
          <td>${formatDate(row.fecha_movimiento)}</td>
          <td>${dueDateCell(row)}</td>
          <td>${formatTerm(row)}</td>
          <td>${escapeHtml(row.eds || "—")}</td>
          <td>${escapeHtml(row.linea_producto || "—")}</td>
          <td class="fc-document">${escapeHtml(row.numero_documento)}</td>
          <td class="fc-money">${formatCurrency(row.cargos)}</td>
          <td>${portalBadge(row)}</td>
          <td><span class="fc-status ${includeClass}">${includeLabel}</span></td>
          <td>${formatDate(row.fecha_pago)}</td>
          <td>${escapeHtml(row.numero_pago || "—")}</td>
          <td>${escapeHtml(row.metodo_pago || "—")}</td>
          <td>${escapeHtml(row.grupo_costo || "—")}</td>
          <td>${reconciliationBadge(row.estado_conciliacion)}</td>
          <td><span class="fc-status ${STATUS_CLASS[status] || "fc-status--pending"}">${escapeHtml(status)}</span><small class="fc-origin-note">${escapeHtml(originLabel(row))}</small></td>
          <td><button class="fc-row-action" type="button" data-edit-id="${escapeHtml(row.id)}">Editar</button></td>
        </tr>`;
    }).join("");
  }

  function getCurrentPageRows() {
    const start = (state.page - 1) * CONFIG.pageSize;
    return state.filtered.slice(start, start + CONFIG.pageSize);
  }

  function renderPagination() {
    const pages = Math.max(1, Math.ceil(state.filtered.length / CONFIG.pageSize));
    if (state.page > pages) state.page = pages;
    dom.pageInfo.textContent = `Página ${state.page} de ${pages}`;
    dom.btnPrev.disabled = state.page <= 1;
    dom.btnNext.disabled = state.page >= pages;
  }

  function changePage(delta) {
    const pages = Math.max(1, Math.ceil(state.filtered.length / CONFIG.pageSize));
    state.page = Math.min(pages, Math.max(1, state.page + delta));
    renderTable();
    renderPagination();
    renderSelectionControls();
  }

  function toggleSelection(id, checked) {
    const key = String(id);
    if (checked) state.selectedIds.add(key);
    else state.selectedIds.delete(key);
    renderTable();
    renderSelectionControls();
  }

  function selectCurrentPage(checked) {
    getCurrentPageRows().forEach(row => {
      const key = String(row.id);
      if (checked) state.selectedIds.add(key);
      else state.selectedIds.delete(key);
    });
    renderTable();
    renderSelectionControls();
  }

  function selectAllFiltered() {
    state.filtered.forEach(row => state.selectedIds.add(String(row.id)));
    renderTable();
    renderSelectionControls();
  }

  function clearSelection() {
    state.selectedIds.clear();
    dom.bulkUpdateIncluir.checked = false;
    dom.bulkUpdateGrupo.checked = false;
    dom.bulkGrupoCosto.value = "";
    renderTable();
    renderSelectionControls();
  }

  function renderSelectionControls() {
    const validIds = new Set(state.records.map(row => String(row.id)));
    [...state.selectedIds].forEach(id => { if (!validIds.has(id)) state.selectedIds.delete(id); });
    const count = state.selectedIds.size;
    dom.selectionBar.hidden = count === 0;
    dom.selectionCount.textContent = `${formatNumber(count)} factura${count === 1 ? "" : "s"} seleccionada${count === 1 ? "" : "s"}`;

    const pageRows = getCurrentPageRows();
    const pageSelected = pageRows.filter(row => state.selectedIds.has(String(row.id))).length;
    dom.selectPageCheckbox.checked = pageRows.length > 0 && pageSelected === pageRows.length;
    dom.selectPageCheckbox.indeterminate = pageSelected > 0 && pageSelected < pageRows.length;
    dom.selectPageCheckbox.disabled = pageRows.length === 0;

    const filteredSelected = state.filtered.filter(row => state.selectedIds.has(String(row.id))).length;
    const allFiltered = state.filtered.length > 0 && filteredSelected === state.filtered.length;
    dom.btnSelectFiltered.disabled = state.filtered.length === 0 || allFiltered;
    dom.btnSelectFiltered.textContent = allFiltered
      ? `Todos los ${formatNumber(state.filtered.length)} filtrados seleccionados`
      : `Seleccionar los ${formatNumber(state.filtered.length)} filtrados`;
    syncBulkControls();
  }

  function syncBulkControls() {
    dom.bulkIncluir.disabled = !dom.bulkUpdateIncluir.checked;
    dom.bulkGrupoCosto.disabled = !dom.bulkUpdateGrupo.checked;
    dom.btnApplyBulk.disabled = state.selectedIds.size === 0 || (!dom.bulkUpdateIncluir.checked && !dom.bulkUpdateGrupo.checked);
  }

  async function applyBulkUpdate() {
    if (!state.backend || !state.selectedIds.size) return;
    const updateCorresponde = dom.bulkUpdateIncluir.checked;
    const updateGrupoCosto = dom.bulkUpdateGrupo.checked;
    if (!updateCorresponde && !updateGrupoCosto) {
      showToast("Selecciona al menos un campo para modificar.", "error");
      return;
    }

    const ids = [...state.selectedIds];
    const grupo = cleanNullable(dom.bulkGrupoCosto.value);
    const lines = [
      `Actualizarás ${formatNumber(ids.length)} factura${ids.length === 1 ? "" : "s"}.`,
      "",
      `Corresponde incluir: ${updateCorresponde ? includeLabel(dom.bulkIncluir.value) : "Sin cambios"}`,
      `Grupo de costo: ${updateGrupoCosto ? (grupo || "Limpiar campo") : "Sin cambios"}`,
      "",
      "¿Confirmar cambios masivos?"
    ];
    if (!window.confirm(lines.join("\n"))) return;

    const originalText = dom.btnApplyBulk.textContent;
    dom.btnApplyBulk.disabled = true;
    dom.btnApplyBulk.textContent = "Aplicando…";
    try {
      const result = await state.backend.bulkUpdate(ids, {
        updateCorresponde,
        corresponde_incluir: dom.bulkIncluir.value,
        updateGrupoCosto,
        grupo_costo: grupo
      }, getCurrentUserName());
      const value = Array.isArray(result) ? (result[0] || {}) : (result || {});
      const updated = Number(value.actualizadas ?? value.updated ?? ids.length);
      showToast(`${formatNumber(updated)} factura${updated === 1 ? "" : "s"} actualizada${updated === 1 ? "" : "s"}.`, "success");
      state.selectedIds.clear();
      dom.bulkUpdateIncluir.checked = false;
      dom.bulkUpdateGrupo.checked = false;
      dom.bulkGrupoCosto.value = "";
      await loadRecords();
    } catch (error) {
      showToast(`No se pudieron aplicar los cambios masivos: ${error.message}`, "error");
    } finally {
      dom.btnApplyBulk.textContent = originalText;
      syncBulkControls();
    }
  }

  function openEdit(id) {
    const row = state.records.find(item => String(item.id) === String(id));
    if (!row) return;
    state.currentEditId = row.id;
    dom.editTitle.textContent = `Factura ${row.numero_documento}`;
    dom.editInvoiceInfo.innerHTML = [
      ["Fecha emisión", formatDate(row.fecha_movimiento)],
      ["Fecha vencimiento", formatDate(row.fecha_vencimiento)],
      ["Plazo", formatTerm(row)],
      ["Línea", row.linea_producto || "—"],
      ["EDS", row.eds || "—"],
      ["Monto", formatCurrency(row.cargos)],
      ["Vigencia portal", portalStatus(row)],
      ["Origen", originLabel(row)],
      ["Conciliación", row.estado_conciliacion || "Pendiente"],
      ["Monto conciliado", formatCurrency(row.monto_conciliado || 0)]
    ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
    dom.editIncluir.value = row.corresponde_incluir || "pendiente";
    dom.editFechaPago.value = row.fecha_pago || "";
    dom.editNumeroPago.value = row.numero_pago || "";
    ensureSelectOption(dom.editMetodoPago, row.metodo_pago);
    dom.editMetodoPago.value = row.metodo_pago || "";
    dom.editGrupoCosto.value = row.grupo_costo || "";
    dom.editObservaciones.value = row.observaciones || "";
    dom.editDialog.showModal();
  }

  function closeEdit() {
    state.currentEditId = null;
    dom.editDialog.close();
  }

  async function saveEdit(event) {
    event.preventDefault();
    if (!state.backend || !state.currentEditId) return;
    const values = {
      corresponde_incluir: dom.editIncluir.value,
      fecha_pago: dom.editFechaPago.value || null,
      numero_pago: cleanNullable(dom.editNumeroPago.value),
      metodo_pago: cleanNullable(dom.editMetodoPago.value),
      grupo_costo: cleanNullable(dom.editGrupoCosto.value),
      observaciones: cleanNullable(dom.editObservaciones.value)
    };

    dom.btnGuardarEdicion.disabled = true;
    dom.btnGuardarEdicion.textContent = "Guardando…";
    try {
      await state.backend.update(state.currentEditId, values, getCurrentUserName());
      closeEdit();
      showToast("Factura actualizada correctamente.", "success");
      await loadRecords();
    } catch (error) {
      showToast(`No se pudo guardar: ${error.message}`, "error");
    } finally {
      dom.btnGuardarEdicion.disabled = false;
      dom.btnGuardarEdicion.textContent = "Guardar cambios";
    }
  }

  function rebuildSelectOptions() {
    const lines = uniqueSorted(state.records.map(row => row.linea_producto).filter(Boolean));
    const currentLine = dom.filterLinea.value;
    dom.filterLinea.innerHTML = `<option value="">Todas</option>${lines.map(value => `<option>${escapeHtml(value)}</option>`).join("")}`;
    if (lines.includes(currentLine)) dom.filterLinea.value = currentLine;

    const groups = uniqueSorted(state.records.map(row => row.grupo_costo).filter(Boolean));
    dom.gruposCostoList.innerHTML = groups.map(value => `<option value="${escapeHtml(value)}"></option>`).join("");
  }

  function exportRecords() {
    if (!state.records.length) return;
    if (typeof XLSX === "undefined") {
      showToast("No se cargó la librería para exportar Excel.", "error");
      return;
    }
    const data = state.records.map(row => ({
      "Fecha Movimiento": row.fecha_movimiento || "",
      "Fecha Vencimiento": row.fecha_vencimiento || "",
      "Plazo días": calculateTerm(row),
      "Vigente en portal": portalStatus(row),
      "Última visualización portal": row.ultima_vista_portal || "",
      "Origen": originLabel(row),
      "Días vencidos portal": row.dias_vencidos ?? 0,
      "N.º EDS": row.eds || "",
      "Línea Producto": row.linea_producto || "",
      "Tipo Movimiento": row.tipo_movimiento || "Factura",
      "N.º Documento": row.numero_documento || "",
      "Cargos": numberValue(row.cargos),
      "Abonos": numberValue(row.abonos),
      "Corresponde incluir": includeLabel(row.corresponde_incluir),
      "Fecha de pago": row.fecha_pago || "",
      "N.º de pago": row.numero_pago || "",
      "Método de pago": row.metodo_pago || "",
      "Grupo de costo": row.grupo_costo || "",
      "Observaciones": row.observaciones || "",
      "Estado conciliación": row.estado_conciliacion || "Pendiente",
      "Monto conciliado": numberValue(row.monto_conciliado),
      "Diferencia conciliación": numberValue(row.diferencia_conciliacion),
      "Estado administrativo": calculateStatus(row),
      "Última actualización": row.actualizado_en || ""
    }));
    const worksheet = XLSX.utils.json_to_sheet(data);
    worksheet["!cols"] = [
      { wch: 15 }, { wch: 18 }, { wch: 12 }, { wch: 18 }, { wch: 24 }, { wch: 24 }, { wch: 18 }, { wch: 10 },
      { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 15 }, { wch: 15 }, { wch: 20 }, { wch: 15 }, { wch: 18 },
      { wch: 20 }, { wch: 22 }, { wch: 40 }, { wch: 22 }, { wch: 18 }, { wch: 20 }, { wch: 22 }, { wch: 22 }
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Facturas unificadas");
    XLSX.writeFile(workbook, `Facturas_Copec_Unificadas_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function reconciliationBadge(status) {
    const value = String(status || "Pendiente");
    const classes = {
      "Conciliada": "fc-status--paid",
      "Pago parcial": "fc-status--partial",
      "Con diferencia": "fc-status--no",
      "Coincidencia ambigua": "fc-status--no",
      "Pendiente": "fc-status--pending"
    };
    return `<span class="fc-status ${classes[value] || "fc-status--pending"}">${escapeHtml(value)}</span>`;
  }

  function portalBadge(row) {
    const status = portalStatus(row);
    const className = status === "Vigente" ? "fc-status--yes" : status === "Ya no vigente" ? "fc-status--partial" : "fc-status--neutral";
    const lastSeen = row.ultima_vista_portal ? `<small class="fc-origin-note">Visto: ${formatDateTime(row.ultima_vista_portal)}</small>` : "";
    return `<span class="fc-status ${className}">${escapeHtml(status)}</span>${lastSeen}`;
  }

  function portalStatus(row) {
    if (row.origen_vigente && row.vigente_portal === true) return "Vigente";
    if (row.origen_vigente && row.vigente_portal === false) return "Ya no vigente";
    return "Sin referencia";
  }

  function originLabel(row) {
    const values = [];
    if (row.formato_origen === "historico" || row.origen_historico) values.push("Histórico");
    if (row.formato_origen === "vigente" || row.origen_vigente) values.push("Vigente");
    if (row.origen_pdf) values.push("PDF");
    return values.length ? values.join(" + ") : "Sin origen";
  }

  function dueDateCell(row) {
    if (!row.fecha_vencimiento) return "—";
    const days = daysFromToday(row.fecha_vencimiento);
    let note = "";
    if (days < 0) note = `<small class="fc-due-note is-late">${formatNumber(Math.abs(days))} días vencida</small>`;
    else if (days === 0) note = `<small class="fc-due-note is-today">Vence hoy</small>`;
    else if (days <= 30) note = `<small class="fc-due-note is-soon">Vence en ${formatNumber(days)} días</small>`;
    return `${formatDate(row.fecha_vencimiento)}${note}`;
  }

  function calculateStatus(row) {
    const include = row.corresponde_incluir || "pendiente";
    if (include === "no") return "No corresponde";
    if (include !== "si") return "Pendiente de revisión";
    const paymentValues = [row.fecha_pago, row.numero_pago, row.metodo_pago];
    const completed = paymentValues.filter(value => String(value || "").trim()).length;
    if (completed === 0) return "Pendiente de pago";
    if (completed < paymentValues.length) return "Pago incompleto";
    return "Pagada";
  }

  function normalizeDbRecord(row) {
    return Object.assign({}, row, {
      id: row.id,
      fecha_movimiento: toIsoDate(row.fecha_movimiento),
      fecha_vencimiento: toIsoDate(row.fecha_vencimiento),
      fecha_pago: toIsoDate(row.fecha_pago),
      plazo_dias: nullableInteger(row.plazo_dias),
      dias_vencidos: integerValue(row.dias_vencidos),
      eds: documentValue(row.eds),
      linea_producto: stringValue(row.linea_producto),
      tipo_movimiento: stringValue(row.tipo_movimiento) || "Factura",
      numero_documento: documentValue(row.numero_documento),
      cargos: numberValue(row.cargos),
      abonos: numberValue(row.abonos),
      saldo_portal: numberValue(row.saldo_portal),
      monto_conciliado: numberValue(row.monto_conciliado),
      diferencia_conciliacion: row.diferencia_conciliacion === null || row.diferencia_conciliacion === undefined ? null : numberValue(row.diferencia_conciliacion),
      estado_conciliacion: stringValue(row.estado_conciliacion) || "Pendiente",
      corresponde_incluir: ["si", "no", "pendiente"].includes(row.corresponde_incluir) ? row.corresponde_incluir : "pendiente",
      origen_historico: booleanValue(row.origen_historico),
      origen_vigente: booleanValue(row.origen_vigente),
      origen_pdf: booleanValue(row.origen_pdf),
      vigente_portal: row.vigente_portal === null || row.vigente_portal === undefined ? null : booleanValue(row.vigente_portal),
      ocurrencia_origen: integerValue(row.ocurrencia_origen || 1)
    });
  }

  function sourceKey(row) {
    const format = row.formato_origen || (row.fecha_vencimiento ? "vigente" : "historico");
    return [
      format,
      documentValue(row.eds),
      documentValue(row.numero_documento),
      toIsoDate(row.fecha_movimiento) || "",
      format === "vigente" ? (toIsoDate(row.fecha_vencimiento) || "") : "",
      roundMoney(row.cargos),
      integerValue(row.ocurrencia_origen || 1)
    ].join("|");
  }

  function canMergeRecords(existing, incoming) {
    if (documentValue(existing.eds) !== documentValue(incoming.eds)) return false;
    if (documentValue(existing.numero_documento) !== documentValue(incoming.numero_documento)) return false;
    if (Math.abs(Math.abs(numberValue(existing.cargos)) - Math.abs(numberValue(incoming.cargos))) > 1) return false;
    const incomingCurrent = incoming.formato_origen === "vigente";
    if (incomingCurrent) {
      return !existing.origen_vigente && !existing.fecha_pago && numberValue(existing.monto_conciliado) === 0;
    }
    return !existing.origen_historico;
  }

  function mergeDemoRecord(existing, incoming, fileName, userName) {
    const current = incoming.formato_origen === "vigente";
    const historical = incoming.formato_origen === "historico";
    return Object.assign({}, existing, incoming, {
      id: existing.id,
      fecha_vencimiento: current ? (incoming.fecha_vencimiento || existing.fecha_vencimiento) : existing.fecha_vencimiento,
      saldo_portal: historical ? incoming.saldo_portal : existing.saldo_portal,
      origen_historico: booleanValue(existing.origen_historico) || historical,
      origen_vigente: booleanValue(existing.origen_vigente) || current,
      vigente_portal: current ? true : existing.vigente_portal,
      ultima_vista_portal: current ? new Date().toISOString() : existing.ultima_vista_portal,
      corresponde_incluir: existing.corresponde_incluir || "pendiente",
      fecha_pago: existing.fecha_pago || null,
      numero_pago: existing.numero_pago || null,
      metodo_pago: existing.metodo_pago || null,
      grupo_costo: existing.grupo_costo || null,
      observaciones: existing.observaciones || null,
      archivo_ultima_carga: fileName,
      usuario_ultima_importacion: userName,
      actualizado_en: new Date().toISOString()
    });
  }

  function sortInvoices(a, b) {
    const rank = row => {
      const paid = row.estado_conciliacion === "Conciliada" || calculateStatus(row) === "Pagada";
      if (paid) return 4;
      if (row.vigente_portal === true) {
        return row.fecha_vencimiento && daysFromToday(row.fecha_vencimiento) < 0 ? 0 : 1;
      }
      if (row.origen_vigente && row.vigente_portal === false) return 2;
      return 3;
    };
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    const dueA = a.fecha_vencimiento || "9999-12-31";
    const dueB = b.fecha_vencimiento || "9999-12-31";
    const dueCompare = String(dueA).localeCompare(String(dueB));
    if (dueCompare !== 0) return dueCompare;
    const dateCompare = String(b.fecha_movimiento || "").localeCompare(String(a.fecha_movimiento || ""));
    if (dateCompare !== 0) return dateCompare;
    return String(b.numero_documento || "").localeCompare(String(a.numero_documento || ""), "es", { numeric: true });
  }

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[º°]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .toLowerCase();
  }

  function stringValue(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  function documentValue(value) {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
    return String(value).trim().replace(/\.0+$/, "");
  }

  function booleanValue(value) {
    if (typeof value === "boolean") return value;
    return ["true", "1", "si", "sí", "yes"].includes(String(value || "").trim().toLowerCase());
  }

  function integerValue(value) {
    const number = numberValue(value);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
  }

  function nullableInteger(value) {
    if (value === null || value === undefined || value === "") return null;
    return integerValue(value);
  }

  function numberValue(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (value === null || value === undefined || value === "") return 0;
    let text = String(value).trim().replace(/\s/g, "").replace(/\$/g, "");
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) text = text.replace(/\./g, "").replace(",", ".");
    else if (/^-?\d+(,\d+)$/.test(text)) text = text.replace(",", ".");
    else text = text.replace(/,/g, "");
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function roundMoney(value) { return Math.round(numberValue(value) * 100) / 100; }

  function toIsoDate(value) {
    if (!value || value === "0000-00-00") return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return localIsoDate(value);
    if (typeof value === "number" && typeof XLSX !== "undefined" && XLSX.SSF?.parse_date_code) {
      const parsed = XLSX.SSF.parse_date_code(value);
      if (parsed) return `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}`;
    }
    const text = String(value).trim();
    if (text === "0000-00-00") return null;
    const iso = text.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (iso) return `${iso[1]}-${pad2(iso[2])}-${pad2(iso[3])}`;
    const latam = text.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/);
    if (latam) return `${latam[3]}-${pad2(latam[2])}-${pad2(latam[1])}`;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : localIsoDate(date);
  }

  function localIsoDate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function dateDifference(start, end) {
    if (!start || !end) return null;
    const a = new Date(`${start}T00:00:00`);
    const b = new Date(`${end}T00:00:00`);
    return Math.round((b - a) / 86400000);
  }

  function calculateTerm(row) {
    if (row.plazo_dias !== null && row.plazo_dias !== undefined) return integerValue(row.plazo_dias);
    return dateDifference(row.fecha_movimiento, row.fecha_vencimiento);
  }

  function formatTerm(row) {
    const term = calculateTerm(row);
    return term === null ? "—" : `${formatNumber(term)} días`;
  }

  function daysFromToday(value) {
    const iso = toIsoDate(value);
    if (!iso) return 999999;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(`${iso}T00:00:00`);
    return Math.round((due - today) / 86400000);
  }

  function pad2(value) { return String(value).padStart(2, "0"); }
  function cleanNullable(value) { const cleaned = String(value || "").trim(); return cleaned || null; }
  function includeLabel(value) { return value === "si" ? "Sí" : value === "no" ? "No" : "Pendiente"; }
  function uniqueSorted(values) { return [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b), "es")); }
  function prettyField(field) { return field.replaceAll("_", " "); }

  function formatCurrency(value) {
    return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(numberValue(value));
  }
  function formatNumber(value) { return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(Number(value) || 0); }
  function formatDate(value) {
    if (!value) return "—";
    const iso = toIsoDate(value);
    if (!iso) return escapeHtml(String(value));
    const [year, month, day] = iso.split("-");
    return `${day}-${month}-${year}`;
  }
  function formatDateTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return formatDate(value);
    return date.toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[char]);
  }

  function ensureSelectOption(select, value) {
    if (!value) return;
    if (![...select.options].some(option => option.value === value)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }
  }

  function getCurrentUserName() {
    return stringValue(
      window.currentUser?.nombre ||
      window.currentUser?.name ||
      window.usuarioActual?.nombre ||
      window.usuarioActual?.name ||
      localStorage.getItem("valepac_usuario_nombre") ||
      localStorage.getItem("usuario_nombre") ||
      "Usuario VALEPAC"
    );
  }

  function setBackendBadge(text, type) {
    dom.backendBadge.textContent = text;
    dom.backendBadge.className = `fc-badge fc-badge--${type}`;
  }

  function setFileStatus(text, isError = false) {
    dom.fileStatus.hidden = false;
    dom.fileStatus.textContent = text;
    dom.fileStatus.style.background = isError ? "#fee2e2" : "#eef6ff";
    dom.fileStatus.style.color = isError ? "#991b1b" : "#194b84";
  }

  function setLoading(loading, text = "") {
    state.loading = loading;
    dom.btnRecargar.disabled = loading;
    if (loading && text) dom.invoiceRows.innerHTML = `<tr><td colspan="16" class="fc-empty">${escapeHtml(text)}</td></tr>`;
  }

  let toastTimer = null;
  function showToast(message, type = "") {
    clearTimeout(toastTimer);
    dom.toast.hidden = false;
    dom.toast.textContent = message;
    dom.toast.className = `fc-toast${type ? ` is-${type}` : ""}`;
    toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 5200);
  }
})();
