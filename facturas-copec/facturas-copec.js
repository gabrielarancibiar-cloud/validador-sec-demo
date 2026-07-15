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
    pageSize: 50,
    maxRows: 5000,
    allowDemoMode: true
  }, window.FACTURAS_COPEC_CONFIG || {});

  const REQUIRED_HEADERS = {
    fecha_movimiento: ["fecha movimiento", "fecha"],
    dias_vencidos: ["dias vencidos", "día vencidos", "días vencidos"],
    eds: ["n eds", "nº eds", "n° eds", "numero eds", "eds"],
    linea_producto: ["linea producto", "línea producto", "linea de producto"],
    tipo_movimiento: ["tipo movimiento", "tipo de movimiento"],
    numero_documento: ["n documento", "nº documento", "n° documento", "numero documento"],
    cargos: ["cargos", "cargo"],
    abonos: ["abonos", "abono"],
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
    previewMeta: null,
    currentEditId: null,
    page: 1,
    loading: false
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
      const order = encodeURIComponent("fecha_movimiento.desc,numero_documento.desc");
      return await this.request(`/rest/v1/${CONFIG.tableName}?select=*&order=${order}&limit=${CONFIG.maxRows}`);
    }

    async import(rows, fileName, userName) {
      return await this.request(`/rest/v1/rpc/${CONFIG.importRpc}`, {
        method: "POST",
        body: JSON.stringify({ p_facturas: rows, p_nombre_archivo: fileName, p_usuario_nombre: userName || null })
      });
    }

    async update(id, values, userName) {
      return await this.request(`/rest/v1/rpc/${CONFIG.updateRpc}`, {
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
  }

  class SupabaseBackend {
    constructor(client) { this.client = client; }

    async list() {
      const { data, error } = await this.client
        .from(CONFIG.tableName)
        .select("*")
        .order("fecha_movimiento", { ascending: false })
        .order("numero_documento", { ascending: false })
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
  }

  class DemoBackend {
    constructor() { this.key = "valepac_facturas_copec_demo_v1"; }
    read() {
      try { return JSON.parse(localStorage.getItem(this.key) || "[]"); }
      catch (_) { return []; }
    }
    write(rows) { localStorage.setItem(this.key, JSON.stringify(rows)); }
    async list() { return this.read().sort(sortInvoices); }
    async import(rows, fileName, userName) {
      const current = this.read();
      const map = new Map(current.map(row => [invoiceKey(row), row]));
      let nuevas = 0;
      let actualizadas = 0;
      rows.forEach(row => {
        const key = invoiceKey(row);
        const existing = map.get(key);
        if (existing) {
          map.set(key, Object.assign({}, existing, row, {
            id: existing.id,
            corresponde_incluir: existing.corresponde_incluir || "pendiente",
            fecha_pago: existing.fecha_pago || null,
            numero_pago: existing.numero_pago || null,
            metodo_pago: existing.metodo_pago || null,
            grupo_costo: existing.grupo_costo || null,
            observaciones: existing.observaciones || null,
            actualizado_en: new Date().toISOString()
          }));
          actualizadas += 1;
        } else {
          map.set(key, Object.assign({}, row, {
            id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
            corresponde_incluir: "pendiente",
            fecha_pago: null,
            numero_pago: null,
            metodo_pago: null,
            grupo_costo: null,
            observaciones: null,
            creado_en: new Date().toISOString(),
            actualizado_en: new Date().toISOString()
          }));
          nuevas += 1;
        }
      });
      this.write(Array.from(map.values()));
      return { recibidas: rows.length, nuevas, actualizadas, ignoradas: 0, archivo: fileName, usuario: userName };
    }
    async update(id, values) {
      const rows = this.read();
      const index = rows.findIndex(row => String(row.id) === String(id));
      if (index < 0) throw new Error("No se encontró la factura.");
      rows[index] = Object.assign({}, rows[index], values, { actualizado_en: new Date().toISOString() });
      this.write(rows);
      return rows[index];
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
      "filterIncluir", "filterLinea", "filterDesde", "filterHasta", "btnLimpiarFiltros", "invoiceRows", "btnPrev", "btnNext",
      "pageInfo", "previewDialog", "previewSummary", "previewRows", "btnConfirmarImportacion", "editDialog", "editForm", "editTitle",
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
    dom.excelInput.addEventListener("change", () => handleFile(dom.excelInput.files?.[0]));
    ["dragenter", "dragover"].forEach(type => dom.dropZone.addEventListener(type, event => {
      event.preventDefault(); dom.dropZone.classList.add("is-dragging");
    }));
    ["dragleave", "drop"].forEach(type => dom.dropZone.addEventListener(type, event => {
      event.preventDefault(); dom.dropZone.classList.remove("is-dragging");
    }));
    dom.dropZone.addEventListener("drop", event => handleFile(event.dataTransfer.files?.[0]));

    dom.btnConfirmarImportacion.addEventListener("click", confirmImport);
    dom.btnRecargar.addEventListener("click", loadRecords);
    dom.btnExportar.addEventListener("click", exportRecords);
    dom.btnLimpiarFiltros.addEventListener("click", clearFilters);
    [dom.filterSearch, dom.filterEstado, dom.filterIncluir, dom.filterLinea, dom.filterDesde, dom.filterHasta]
      .forEach(input => input.addEventListener(input.tagName === "INPUT" && input.type === "search" ? "input" : "change", applyFilters));
    dom.btnPrev.addEventListener("click", () => changePage(-1));
    dom.btnNext.addEventListener("click", () => changePage(1));
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
      state.page = 1;
      rebuildSelectOptions();
      applyFilters();
    } catch (error) {
      showToast(`No se pudieron cargar las facturas: ${error.message}`, "error");
      state.records = [];
      renderAll();
    } finally {
      setLoading(false);
      // Vuelve a pintar la tabla cuando termina la consulta inicial.
      // Sin esta línea quedaba visible "Cargando registros…" hasta cambiar de página.
      renderAll();
    }
  }

  async function handleFile(file) {
    if (!file) return;
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      showToast("Seleccione un archivo Excel .xlsx o .xls.", "error");
      return;
    }
    if (typeof XLSX === "undefined") {
      showToast("No se cargó la librería para leer Excel. Revise la conexión a Internet o guarde SheetJS localmente.", "error");
      return;
    }

    setFileStatus(`Leyendo ${file.name}…`);
    try {
      const parsed = await parseExcel(file);
      state.previewRows = parsed.rows;
      state.previewMeta = Object.assign(parsed.meta, { fileName: file.name });
      renderPreview();
      dom.previewDialog.showModal();
      setFileStatus(`${parsed.rows.length} facturas válidas encontradas en ${file.name}.`);
    } catch (error) {
      state.previewRows = [];
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
    if (!workbook.SheetNames?.length) throw new Error("El archivo no contiene hojas.");
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });
    if (!rawRows.length) throw new Error("La primera hoja está vacía.");

    const headerMap = createHeaderMap(Object.keys(rawRows[0]));
    const missing = Object.keys(REQUIRED_HEADERS).filter(key => !headerMap[key]);
    if (missing.length) {
      throw new Error(`El Excel no tiene la estructura esperada. Faltan columnas: ${missing.map(prettyField).join(", ")}.`);
    }

    const existingKeys = new Set(state.records.map(invoiceKey));
    const seen = new Set();
    const rows = [];
    let ignored = 0;
    let duplicatesInFile = 0;
    let newCount = 0;
    let updateCount = 0;

    rawRows.forEach((source, index) => {
      const type = stringValue(source[headerMap.tipo_movimiento]);
      if (normalizeText(type) !== "factura") { ignored += 1; return; }

      const numeroDocumento = stringValue(source[headerMap.numero_documento]);
      if (!numeroDocumento) { ignored += 1; return; }

      const row = {
        fecha_movimiento: toIsoDate(source[headerMap.fecha_movimiento]),
        dias_vencidos: integerValue(source[headerMap.dias_vencidos]),
        eds: stringValue(source[headerMap.eds]) || CONFIG.defaultEds,
        linea_producto: stringValue(source[headerMap.linea_producto]),
        tipo_movimiento: "Factura",
        numero_documento: numeroDocumento,
        cargos: numberValue(source[headerMap.cargos]),
        abonos: numberValue(source[headerMap.abonos]),
        saldo_portal: numberValue(source[headerMap.saldo_portal]),
        fila_origen: index + 2
      };

      const key = invoiceKey(row);
      if (seen.has(key)) { duplicatesInFile += 1; return; }
      seen.add(key);
      if (existingKeys.has(key)) updateCount += 1; else newCount += 1;
      rows.push(row);
    });

    if (!rows.length) throw new Error("No se encontraron filas con Tipo Movimiento = Factura.");
    rows.sort(sortInvoices);
    return {
      rows,
      meta: {
        totalSource: rawRows.length,
        valid: rows.length,
        ignored,
        duplicatesInFile,
        newCount,
        updateCount,
        sheetName: workbook.SheetNames[0]
      }
    };
  }

  function createHeaderMap(headers) {
    const normalizedHeaders = new Map(headers.map(header => [normalizeText(header), header]));
    const result = {};
    Object.entries(REQUIRED_HEADERS).forEach(([field, aliases]) => {
      const found = aliases.map(normalizeText).find(alias => normalizedHeaders.has(alias));
      if (found) result[field] = normalizedHeaders.get(found);
    });
    return result;
  }

  function renderPreview() {
    const meta = state.previewMeta;
    dom.previewSummary.innerHTML = [
      ["Facturas válidas", meta.valid],
      ["Nuevas", meta.newCount],
      ["A actualizar", meta.updateCount],
      ["Ignoradas", meta.ignored],
      ["Duplicadas archivo", meta.duplicatesInFile]
    ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${formatNumber(value)}</strong></div>`).join("");

    dom.previewRows.innerHTML = state.previewRows.slice(0, 100).map(row => `
      <tr>
        <td>${formatDate(row.fecha_movimiento)}</td>
        <td>${escapeHtml(row.eds)}</td>
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
    if (!state.previewRows.length) return;

    const button = dom.btnConfirmarImportacion;
    button.disabled = true;
    button.textContent = "Importando…";
    try {
      const result = await state.backend.import(state.previewRows, state.previewMeta.fileName, getCurrentUserName());
      dom.previewDialog.close();
      const summary = normalizeImportResult(result);
      showToast(`Importación terminada: ${summary.nuevas} nuevas y ${summary.actualizadas} actualizadas.`, "success");
      setFileStatus(`Importación completada · ${summary.nuevas} nuevas · ${summary.actualizadas} actualizadas.`);
      state.previewRows = [];
      state.previewMeta = null;
      await loadRecords();
    } catch (error) {
      showToast(`No se pudo importar: ${error.message}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Importar facturas";
    }
  }

  function normalizeImportResult(result) {
    const value = Array.isArray(result) ? (result[0] || {}) : (result || {});
    return {
      nuevas: Number(value.nuevas ?? value.insertadas ?? 0),
      actualizadas: Number(value.actualizadas ?? 0),
      ignoradas: Number(value.ignoradas ?? 0)
    };
  }

  function applyFilters() {
    const search = normalizeText(dom.filterSearch.value);
    const estado = dom.filterEstado.value;
    const incluir = dom.filterIncluir.value;
    const linea = dom.filterLinea.value;
    const desde = dom.filterDesde.value;
    const hasta = dom.filterHasta.value;

    state.filtered = state.records.filter(row => {
      const rowStatus = calculateStatus(row);
      const haystack = normalizeText([
        row.numero_documento, row.linea_producto, row.numero_pago, row.metodo_pago,
        row.grupo_costo, row.observaciones, row.eds, row.estado_conciliacion
      ].filter(Boolean).join(" "));
      if (search && !haystack.includes(search)) return false;
      if (estado && rowStatus !== estado) return false;
      if (incluir && (row.corresponde_incluir || "pendiente") !== incluir) return false;
      if (linea && row.linea_producto !== linea) return false;
      if (desde && row.fecha_movimiento && row.fecha_movimiento < desde) return false;
      if (hasta && row.fecha_movimiento && row.fecha_movimiento > hasta) return false;
      return true;
    });
    state.page = 1;
    renderAll();
  }

  function clearFilters() {
    [dom.filterSearch, dom.filterEstado, dom.filterIncluir, dom.filterLinea, dom.filterDesde, dom.filterHasta]
      .forEach(input => { input.value = ""; });
    applyFilters();
  }

  function renderAll() {
    renderKpis();
    renderTable();
    renderPagination();
    dom.resultCount.textContent = `${formatNumber(state.filtered.length)} resultado${state.filtered.length === 1 ? "" : "s"}`;
    dom.btnExportar.disabled = state.records.length === 0;
  }

  function renderKpis() {
    const total = state.records.length;
    const counts = { pending: 0, pay: 0, paid: 0 };
    let amount = 0;
    state.records.forEach(row => {
      const status = calculateStatus(row);
      if (status === "Pendiente de revisión") counts.pending += 1;
      if (status === "Pendiente de pago" || status === "Pago incompleto") counts.pay += 1;
      if (status === "Pagada") counts.paid += 1;
      amount += numberValue(row.cargos);
    });
    dom.kpiTotal.textContent = formatNumber(total);
    dom.kpiPendientes.textContent = formatNumber(counts.pending);
    dom.kpiPago.textContent = formatNumber(counts.pay);
    dom.kpiPagadas.textContent = formatNumber(counts.paid);
    dom.kpiMonto.textContent = formatCurrency(amount);
  }

  function renderTable() {
    if (state.loading) {
      dom.invoiceRows.innerHTML = `<tr><td colspan="14" class="fc-empty">Cargando registros…</td></tr>`;
      return;
    }
    if (!state.filtered.length) {
      const message = state.backend ? "No hay facturas para mostrar." : "Conecte Supabase para cargar los registros.";
      dom.invoiceRows.innerHTML = `<tr><td colspan="14" class="fc-empty">${message}</td></tr>`;
      return;
    }

    const start = (state.page - 1) * CONFIG.pageSize;
    const pageRows = state.filtered.slice(start, start + CONFIG.pageSize);
    dom.invoiceRows.innerHTML = pageRows.map(row => {
      const status = calculateStatus(row);
      const includeValue = row.corresponde_incluir || "pendiente";
      const includeLabel = includeValue === "si" ? "Sí" : includeValue === "no" ? "No" : "Pendiente";
      const includeClass = includeValue === "si" ? "fc-status--yes" : includeValue === "no" ? "fc-status--no" : "fc-status--pending";
      return `
        <tr>
          <td>${formatDate(row.fecha_movimiento)}</td>
          <td class="${Number(row.dias_vencidos) > 0 ? "fc-days--late" : ""}">${formatNumber(row.dias_vencidos || 0)}</td>
          <td>${escapeHtml(row.eds || "—")}</td>
          <td>${escapeHtml(row.linea_producto || "—")}</td>
          <td class="fc-document">${escapeHtml(row.numero_documento)}</td>
          <td class="fc-money">${formatCurrency(row.cargos)}</td>
          <td><span class="fc-status ${includeClass}">${includeLabel}</span></td>
          <td>${formatDate(row.fecha_pago)}</td>
          <td>${escapeHtml(row.numero_pago || "—")}</td>
          <td>${escapeHtml(row.metodo_pago || "—")}</td>
          <td>${escapeHtml(row.grupo_costo || "—")}</td>
          <td>${reconciliationBadge(row.estado_conciliacion)}</td>
          <td><span class="fc-status ${STATUS_CLASS[status] || "fc-status--pending"}">${escapeHtml(status)}</span></td>
          <td><button class="fc-row-action" type="button" data-edit-id="${escapeHtml(row.id)}">Editar</button></td>
        </tr>`;
    }).join("");
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
  }

  function openEdit(id) {
    const row = state.records.find(item => String(item.id) === String(id));
    if (!row) return;
    state.currentEditId = row.id;
    dom.editTitle.textContent = `Factura ${row.numero_documento}`;
    dom.editInvoiceInfo.innerHTML = [
      ["Fecha", formatDate(row.fecha_movimiento)],
      ["Línea", row.linea_producto || "—"],
      ["EDS", row.eds || "—"],
      ["Monto", formatCurrency(row.cargos)],
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
      "Días Vencidos": row.dias_vencidos ?? 0,
      "N.º EDS": row.eds || "",
      "Línea Producto": row.linea_producto || "",
      "Tipo Movimiento": row.tipo_movimiento || "Factura",
      "N.º Documento": row.numero_documento || "",
      "Cargos": numberValue(row.cargos),
      "Abonos": numberValue(row.abonos),
      "Saldo Portal": numberValue(row.saldo_portal),
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
      { wch: 14 }, { wch: 13 }, { wch: 10 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 15 }, { wch: 15 }, { wch: 16 },
      { wch: 20 }, { wch: 15 }, { wch: 18 }, { wch: 20 }, { wch: 22 }, { wch: 40 }, { wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 20 }, { wch: 22 }
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Facturas Copec");
    XLSX.writeFile(workbook, `Facturas_Copec_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function reconciliationBadge(status) {
    const value = String(status || "Pendiente");
    const classes = {
      "Conciliada": "fc-status--paid",
      "Pago parcial": "fc-status--partial",
      "Con diferencia": "fc-status--no",
      "Pendiente": "fc-status--pending"
    };
    return `<span class="fc-status ${classes[value] || "fc-status--pending"}">${escapeHtml(value)}</span>`;
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
      fecha_pago: toIsoDate(row.fecha_pago),
      dias_vencidos: integerValue(row.dias_vencidos),
      eds: stringValue(row.eds),
      linea_producto: stringValue(row.linea_producto),
      tipo_movimiento: stringValue(row.tipo_movimiento) || "Factura",
      numero_documento: stringValue(row.numero_documento),
      cargos: numberValue(row.cargos),
      abonos: numberValue(row.abonos),
      saldo_portal: numberValue(row.saldo_portal),
      monto_conciliado: numberValue(row.monto_conciliado),
      diferencia_conciliacion: row.diferencia_conciliacion === null || row.diferencia_conciliacion === undefined ? null : numberValue(row.diferencia_conciliacion),
      estado_conciliacion: stringValue(row.estado_conciliacion) || "Pendiente",
      corresponde_incluir: ["si", "no", "pendiente"].includes(row.corresponde_incluir) ? row.corresponde_incluir : "pendiente"
    });
  }

  function invoiceKey(row) {
    return [stringValue(row.eds), stringValue(row.numero_documento), normalizeText(row.tipo_movimiento || "Factura")].join("|");
  }

  function sortInvoices(a, b) {
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
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return String(value).trim();
  }

  function integerValue(value) {
    const number = numberValue(value);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
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

  function toIsoDate(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return localIsoDate(value);
    if (typeof value === "number" && typeof XLSX !== "undefined" && XLSX.SSF?.parse_date_code) {
      const parsed = XLSX.SSF.parse_date_code(value);
      if (parsed) return `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}`;
    }
    const text = String(value).trim();
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
    if (loading && text) dom.invoiceRows.innerHTML = `<tr><td colspan="14" class="fc-empty">${escapeHtml(text)}</td></tr>`;
  }

  let toastTimer = null;
  function showToast(message, type = "") {
    clearTimeout(toastTimer);
    dom.toast.hidden = false;
    dom.toast.textContent = message;
    dom.toast.className = `fc-toast${type ? ` is-${type}` : ""}`;
    toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 4800);
  }
})();
