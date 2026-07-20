(() => {
  "use strict";

  const CONFIG = Object.assign({
    supabaseUrl: "",
    supabaseAnonKey: "",
    paymentsTableName: "pagos_copec",
    paymentsDetailTableName: "pagos_copec_detalle",
    importPaymentsRpc: "importar_pagos_copec",
    savePaymentPdfRpc: "guardar_comprobante_pago_copec",
    reconcileAllPaymentsRpc: "reconciliar_todos_pagos_copec",
    analyzePaymentPdfEndpoint: "/api/analizar-comprobante-pago",
    paymentsPageSize: 30,
    consolidatedPageSize: 50,
    maxPdfBytes: 4 * 1024 * 1024,
    maxPaymentRows: 5000,
    maxConsolidatedRows: 20000
  }, window.FACTURAS_COPEC_CONFIG || {});

  const PAYMENT_HEADERS = {
    fecha_emision: ["fecha emision", "fecha emisión", "fecha"],
    tipo_operacion: ["tipo operacion", "tipo operación"],
    banco: ["banco"],
    numero_propuesta: ["n propuesta de pago", "nº propuesta de pago", "n° propuesta de pago", "numero propuesta de pago", "propuesta de pago"],
    monto: ["monto"],
    estado_portal: ["estado"]
  };

  const dom = {};
  const state = {
    backend: null,
    payments: [],
    filtered: [],
    previewRows: [],
    previewMeta: null,
    page: 1,
    loading: false,
    processingPdf: false,
    detailPayment: null,
    detailRows: [],
    allDetails: [],
    filteredDetails: [],
    detailPage: 1,
    detailLoading: false,
    detailLoaded: false
  };

  class PaymentBackend {
    constructor(url, key) {
      this.url = String(url || "").replace(/\/$/, "");
      this.key = key;
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

    async listPayments() {
      const order = encodeURIComponent("fecha_emision.desc,numero_propuesta.desc");
      return this.request(`/rest/v1/${CONFIG.paymentsTableName}?select=*&order=${order}&limit=${CONFIG.maxPaymentRows}`);
    }

    async importPayments(rows, fileName, userName) {
      return this.request(`/rest/v1/rpc/${CONFIG.importPaymentsRpc}`, {
        method: "POST",
        body: JSON.stringify({ p_pagos: rows, p_nombre_archivo: fileName, p_usuario_nombre: userName || null })
      });
    }

    async savePdf(data, fileName, userName) {
      return this.request(`/rest/v1/rpc/${CONFIG.savePaymentPdfRpc}`, {
        method: "POST",
        body: JSON.stringify({ p_comprobante: data, p_nombre_archivo: fileName, p_usuario_nombre: userName || null })
      });
    }

    async reconcileAll() {
      return this.request(`/rest/v1/rpc/${CONFIG.reconcileAllPaymentsRpc}`, {
        method: "POST",
        body: "{}"
      });
    }

    async details(paymentId) {
      const select = encodeURIComponent("*,facturas_copec(numero_documento,cargos,linea_producto,estado_conciliacion,fecha_vencimiento,vigente_portal,origen_historico,origen_vigente,corresponde_incluir,grupo_costo)");
      const order = encodeURIComponent("fila_orden.asc");
      return this.request(`/rest/v1/${CONFIG.paymentsDetailTableName}?select=${select}&pago_id=eq.${encodeURIComponent(paymentId)}&order=${order}`);
    }

    async listAllDetails() {
      const select = encodeURIComponent("id,pago_id,fila_orden,fecha_documento,tipo_documento,numero_documento,valor,factura_id,monto_factura,diferencia,estado_conciliacion,pagos_copec(id,fecha_emision,fecha_ejecucion,tipo_operacion,banco,numero_propuesta,monto,estado_conciliacion,comprobante_nombre),facturas_copec(id,numero_documento,cargos,linea_producto,estado_conciliacion,fecha_vencimiento,corresponde_incluir,grupo_costo)");
      const order = encodeURIComponent("fecha_documento.desc,pago_id.asc,fila_orden.asc");
      const batchSize = 1000;
      const result = [];
      for (let offset = 0; offset < CONFIG.maxConsolidatedRows; offset += batchSize) {
        const rows = await this.request(`/rest/v1/${CONFIG.paymentsDetailTableName}?select=${select}&order=${order}&limit=${batchSize}&offset=${offset}`);
        const batch = Array.isArray(rows) ? rows : [];
        result.push(...batch);
        if (batch.length < batchSize) break;
      }
      return result.slice(0, CONFIG.maxConsolidatedRows);
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheDom();
    if (!dom.pagosView) return;
    bindEvents();
    configureBackend();
    loadPayments();
  }

  function cacheDom() {
    [
      "tabFacturas", "tabPagos", "tabDetalleConsolidado", "facturasView", "pagosView", "detalleConsolidadoView",
      "paymentExcelInput", "btnPaymentExcel", "paymentExcelStatus",
      "paymentPdfInput", "btnPaymentPdf", "paymentPdfStatus", "btnReconcileAll",
      "payKpiTotal", "payKpiPendientes", "payKpiCuadradas", "payKpiObservadas", "payKpiFacturas",
      "paymentSearch", "paymentStatusFilter", "paymentTypeFilter", "btnClearPaymentFilters",
      "paymentRows", "paymentResultCount", "paymentPrev", "paymentNext", "paymentPageInfo",
      "paymentPreviewDialog", "paymentPreviewSummary", "paymentPreviewRows", "btnConfirmPaymentImport",
      "paymentDetailDialog", "paymentDetailTitle", "paymentDetailSummary", "paymentDetailRows", "btnClosePaymentDetail",
      "btnExportConsolidated", "btnReloadConsolidated", "detailKpiTotal", "detailKpiFacturas", "detailKpiAbonos", "detailKpiOtros", "detailKpiNeto",
      "consolidatedSearch", "consolidatedProposalFilter", "consolidatedTypeFilter", "consolidatedStatusFilter", "consolidatedFrom", "consolidatedTo", "btnClearConsolidatedFilters",
      "consolidatedRows", "consolidatedResultCount", "consolidatedPrev", "consolidatedNext", "consolidatedPageInfo",
      "toast"
    ].forEach(id => { dom[id] = document.getElementById(id); });
  }

  function bindEvents() {
    dom.tabFacturas?.addEventListener("click", () => showTab("facturas"));
    dom.tabPagos?.addEventListener("click", () => showTab("pagos"));
    dom.tabDetalleConsolidado?.addEventListener("click", () => showTab("detalle"));

    dom.btnPaymentExcel?.addEventListener("click", () => dom.paymentExcelInput.click());
    dom.paymentExcelInput?.addEventListener("change", () => handlePaymentExcel(dom.paymentExcelInput.files?.[0]));
    dom.btnConfirmPaymentImport?.addEventListener("click", confirmPaymentImport);

    dom.btnPaymentPdf?.addEventListener("click", () => dom.paymentPdfInput.click());
    dom.paymentPdfInput?.addEventListener("change", () => processPaymentPdfs(Array.from(dom.paymentPdfInput.files || [])));
    dom.btnReconcileAll?.addEventListener("click", reconcileAllPayments);

    dom.paymentSearch?.addEventListener("input", applyPaymentFilters);
    dom.paymentStatusFilter?.addEventListener("change", applyPaymentFilters);
    dom.paymentTypeFilter?.addEventListener("change", applyPaymentFilters);
    dom.btnClearPaymentFilters?.addEventListener("click", clearPaymentFilters);
    dom.paymentPrev?.addEventListener("click", () => changePaymentPage(-1));
    dom.paymentNext?.addEventListener("click", () => changePaymentPage(1));
    dom.paymentRows?.addEventListener("click", event => {
      const button = event.target.closest("[data-payment-id]");
      if (button) openPaymentDetail(button.dataset.paymentId);
    });
    dom.btnClosePaymentDetail?.addEventListener("click", () => dom.paymentDetailDialog.close());

    dom.btnReloadConsolidated?.addEventListener("click", () => loadConsolidatedDetails(true));
    dom.btnExportConsolidated?.addEventListener("click", exportConsolidatedDetails);
    [dom.consolidatedSearch, dom.consolidatedProposalFilter, dom.consolidatedTypeFilter, dom.consolidatedStatusFilter, dom.consolidatedFrom, dom.consolidatedTo].forEach(element => {
      element?.addEventListener(element.tagName === "INPUT" && element.type === "search" ? "input" : "change", applyConsolidatedFilters);
    });
    dom.btnClearConsolidatedFilters?.addEventListener("click", clearConsolidatedFilters);
    dom.consolidatedPrev?.addEventListener("click", () => changeConsolidatedPage(-1));
    dom.consolidatedNext?.addEventListener("click", () => changeConsolidatedPage(1));
    dom.consolidatedRows?.addEventListener("click", event => {
      const paymentButton = event.target.closest("[data-open-payment]");
      if (paymentButton) { openPaymentDetail(paymentButton.dataset.openPayment); return; }
      const invoiceButton = event.target.closest("[data-open-invoice]");
      if (invoiceButton) openInvoiceFromConsolidated(invoiceButton.dataset.openInvoice);
    });
  }

  function configureBackend() {
    if (CONFIG.supabaseUrl && CONFIG.supabaseAnonKey) {
      state.backend = new PaymentBackend(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
      return;
    }
    setPaymentStatus(dom.paymentExcelStatus, "Falta configurar Supabase en config.js.", true);
  }

  function showTab(tab) {
    const invoices = tab === "facturas";
    const payments = tab === "pagos";
    const details = tab === "detalle";
    dom.facturasView.hidden = !invoices;
    dom.pagosView.hidden = !payments;
    dom.detalleConsolidadoView.hidden = !details;
    dom.tabFacturas.classList.toggle("active", invoices);
    dom.tabPagos.classList.toggle("active", payments);
    dom.tabDetalleConsolidado.classList.toggle("active", details);
    if (payments) loadPayments();
    if (details) loadConsolidatedDetails();
  }

  async function loadPayments() {
    if (!state.backend || state.loading) return;
    state.loading = true;
    renderPaymentTable();
    try {
      const rows = await state.backend.listPayments();
      state.payments = (Array.isArray(rows) ? rows : []).map(normalizePayment).sort(sortPayments);
      rebuildPaymentTypes();
      applyPaymentFilters();
    } catch (error) {
      state.payments = [];
      state.filtered = [];
      renderPayments();
      showToast(`No se pudieron cargar las propuestas: ${error.message}`, "error");
    } finally {
      state.loading = false;
      renderPayments();
    }
  }

  async function handlePaymentExcel(file) {
    if (!file) return;
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      showToast("Seleccione el Excel de propuestas de pago.", "error");
      return;
    }
    if (typeof XLSX === "undefined") {
      showToast("No se cargó la librería para leer Excel.", "error");
      return;
    }

    setPaymentStatus(dom.paymentExcelStatus, `Leyendo ${file.name}…`);
    try {
      const parsed = await parsePaymentExcel(file);
      state.previewRows = parsed.rows;
      state.previewMeta = Object.assign(parsed.meta, { fileName: file.name });
      renderPaymentPreview();
      dom.paymentPreviewDialog.showModal();
      setPaymentStatus(dom.paymentExcelStatus, `${parsed.rows.length} propuestas válidas encontradas.`);
    } catch (error) {
      setPaymentStatus(dom.paymentExcelStatus, error.message, true);
      showToast(error.message, "error");
    } finally {
      dom.paymentExcelInput.value = "";
    }
  }

  async function parsePaymentExcel(file) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { cellDates: true });
    if (!workbook.SheetNames?.length) throw new Error("El Excel no contiene hojas.");
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });
    if (!rawRows.length) throw new Error("La primera hoja del Excel está vacía.");

    const map = createHeaderMap(Object.keys(rawRows[0]), PAYMENT_HEADERS);
    const missing = Object.keys(PAYMENT_HEADERS).filter(key => !map[key]);
    if (missing.length) throw new Error(`Faltan columnas en el Excel: ${missing.map(prettyField).join(", ")}.`);

    const existing = new Set(state.payments.map(row => row.numero_propuesta));
    const seen = new Set();
    const rows = [];
    let ignored = 0;
    let duplicates = 0;
    let newCount = 0;
    let updateCount = 0;

    rawRows.forEach((source, index) => {
      const number = documentValue(source[map.numero_propuesta]);
      if (!number) { ignored += 1; return; }
      if (seen.has(number)) { duplicates += 1; return; }
      seen.add(number);
      if (existing.has(number)) updateCount += 1; else newCount += 1;
      rows.push({
        fecha_emision: toIsoDate(source[map.fecha_emision]),
        tipo_operacion: stringValue(source[map.tipo_operacion]),
        banco: stringValue(source[map.banco]),
        numero_propuesta: number,
        monto: numberValue(source[map.monto]),
        estado_portal: stringValue(source[map.estado_portal]),
        fila_origen: index + 2
      });
    });

    if (!rows.length) throw new Error("No se encontraron propuestas de pago válidas.");
    rows.sort(sortPayments);
    return {
      rows,
      meta: {
        valid: rows.length,
        newCount,
        updateCount,
        ignored,
        duplicates,
        sheetName: workbook.SheetNames[0]
      }
    };
  }

  function renderPaymentPreview() {
    const meta = state.previewMeta;
    dom.paymentPreviewSummary.innerHTML = [
      ["Propuestas válidas", meta.valid],
      ["Nuevas", meta.newCount],
      ["A actualizar", meta.updateCount],
      ["Ignoradas", meta.ignored],
      ["Duplicadas", meta.duplicates]
    ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${formatNumber(value)}</strong></div>`).join("");

    dom.paymentPreviewRows.innerHTML = state.previewRows.slice(0, 100).map(row => `
      <tr>
        <td>${formatDate(row.fecha_emision)}</td>
        <td>${escapeHtml(row.tipo_operacion || "—")}</td>
        <td class="fc-document">${escapeHtml(row.numero_propuesta)}</td>
        <td class="fc-money">${formatCurrency(row.monto)}</td>
        <td>${escapeHtml(row.estado_portal || "—")}</td>
      </tr>`).join("");
  }

  async function confirmPaymentImport() {
    if (!state.backend || !state.previewRows.length) return;
    const button = dom.btnConfirmPaymentImport;
    button.disabled = true;
    button.textContent = "Importando…";
    try {
      const result = await state.backend.importPayments(state.previewRows, state.previewMeta.fileName, getCurrentUserName());
      const value = Array.isArray(result) ? (result[0] || {}) : (result || {});
      dom.paymentPreviewDialog.close();
      showToast(`Propuestas importadas: ${Number(value.nuevas || 0)} nuevas y ${Number(value.actualizadas || 0)} actualizadas.`, "success");
      setPaymentStatus(dom.paymentExcelStatus, `Importación completa · ${Number(value.nuevas || 0)} nuevas · ${Number(value.actualizadas || 0)} actualizadas.`);
      state.previewRows = [];
      state.previewMeta = null;
      state.detailLoaded = false;
      await loadPayments();
    } catch (error) {
      showToast(`No se pudo importar: ${error.message}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = "Importar propuestas";
    }
  }

  async function processPaymentPdfs(files) {
    if (!files.length || state.processingPdf) return;
    if (!state.backend) {
      showToast("Falta conexión con Supabase.", "error");
      return;
    }

    const invalid = files.find(file => file.type !== "application/pdf" && !/\.pdf$/i.test(file.name));
    if (invalid) {
      showToast(`${invalid.name} no es un PDF.`, "error");
      dom.paymentPdfInput.value = "";
      return;
    }
    const tooLarge = files.find(file => file.size > CONFIG.maxPdfBytes);
    if (tooLarge) {
      showToast(`${tooLarge.name} supera 4 MB. Use una versión más liviana.`, "error");
      dom.paymentPdfInput.value = "";
      return;
    }

    state.processingPdf = true;
    dom.btnPaymentPdf.disabled = true;
    dom.btnPaymentPdf.textContent = "Procesando…";
    let completed = 0;
    const errors = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      setPaymentStatus(dom.paymentPdfStatus, `Procesando ${index + 1} de ${files.length}: ${file.name}…`);
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const response = await fetch(CONFIG.analyzePaymentPdfEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, dataUrl })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || response.statusText || "Error analizando PDF.");
        await state.backend.savePdf(payload.data, file.name, getCurrentUserName());
        completed += 1;
      } catch (error) {
        errors.push(`${file.name}: ${error.message}`);
      }
    }

    state.processingPdf = false;
    dom.btnPaymentPdf.disabled = false;
    dom.btnPaymentPdf.textContent = "Seleccionar PDF";
    dom.paymentPdfInput.value = "";

    if (completed) {
      setPaymentStatus(dom.paymentPdfStatus, `${completed} comprobante${completed === 1 ? "" : "s"} procesado${completed === 1 ? "" : "s"} y conciliado${completed === 1 ? "" : "s"}.`);
      showToast(`Conciliación completada para ${completed} comprobante${completed === 1 ? "" : "s"}.`, "success");
      state.detailLoaded = false;
      await loadPayments();
      window.dispatchEvent(new CustomEvent("facturasCopec:reload"));
    }
    if (errors.length) {
      setPaymentStatus(dom.paymentPdfStatus, `Se produjeron errores: ${errors.join(" | ")}`, true);
      showToast(`${errors.length} PDF no pudo procesarse.`, "error");
    }
  }

  async function reconcileAllPayments() {
    if (!state.backend || state.processingPdf) return;
    dom.btnReconcileAll.disabled = true;
    dom.btnReconcileAll.textContent = "Conciliando…";
    try {
      const result = await state.backend.reconcileAll();
      const value = Array.isArray(result) ? (result[0] || {}) : (result || {});
      showToast(`${Number(value.propuestas_reconciliadas || 0)} propuestas recalculadas.`, "success");
      state.detailLoaded = false;
      await loadPayments();
      window.dispatchEvent(new CustomEvent("facturasCopec:reload"));
    } catch (error) {
      showToast(`No se pudo conciliar: ${error.message}`, "error");
    } finally {
      dom.btnReconcileAll.disabled = false;
      dom.btnReconcileAll.textContent = "Reconciliar nuevamente";
    }
  }

  function applyPaymentFilters() {
    const search = normalizeText(dom.paymentSearch.value);
    const status = dom.paymentStatusFilter.value;
    const type = dom.paymentTypeFilter.value;
    state.filtered = state.payments.filter(row => {
      const text = normalizeText([row.numero_propuesta, row.tipo_operacion, row.banco, row.estado_portal, row.comprobante_nombre].join(" "));
      if (search && !text.includes(search)) return false;
      if (status && row.estado_conciliacion !== status) return false;
      if (type && row.tipo_operacion !== type) return false;
      return true;
    });
    state.page = 1;
    renderPayments();
  }

  function clearPaymentFilters() {
    dom.paymentSearch.value = "";
    dom.paymentStatusFilter.value = "";
    dom.paymentTypeFilter.value = "";
    applyPaymentFilters();
  }

  function rebuildPaymentTypes() {
    const current = dom.paymentTypeFilter.value;
    const types = uniqueSorted(state.payments.map(row => row.tipo_operacion).filter(Boolean));
    dom.paymentTypeFilter.innerHTML = `<option value="">Todas</option>${types.map(value => `<option>${escapeHtml(value)}</option>`).join("")}`;
    if (types.includes(current)) dom.paymentTypeFilter.value = current;
  }

  function renderPayments() {
    renderPaymentKpis();
    renderPaymentTable();
    renderPaymentPagination();
    dom.paymentResultCount.textContent = `${formatNumber(state.filtered.length)} resultado${state.filtered.length === 1 ? "" : "s"}`;
  }

  function renderPaymentKpis() {
    const total = state.payments.length;
    const pending = state.payments.filter(row => row.estado_conciliacion === "Pendiente de comprobante").length;
    const squared = state.payments.filter(row => row.estado_conciliacion === "Cuadrada").length;
    const observed = state.payments.filter(row => ["Descuadrada", "Cuadrada con observaciones"].includes(row.estado_conciliacion)).length;
    const invoices = state.payments.reduce((sum, row) => sum + Number(row.facturas_conciliadas || 0), 0);
    dom.payKpiTotal.textContent = formatNumber(total);
    dom.payKpiPendientes.textContent = formatNumber(pending);
    dom.payKpiCuadradas.textContent = formatNumber(squared);
    dom.payKpiObservadas.textContent = formatNumber(observed);
    dom.payKpiFacturas.textContent = formatNumber(invoices);
  }

  function renderPaymentTable() {
    if (state.loading) {
      dom.paymentRows.innerHTML = `<tr><td colspan="9" class="fc-empty">Cargando propuestas…</td></tr>`;
      return;
    }
    if (!state.filtered.length) {
      dom.paymentRows.innerHTML = `<tr><td colspan="9" class="fc-empty">No hay propuestas para mostrar.</td></tr>`;
      return;
    }
    const start = (state.page - 1) * CONFIG.paymentsPageSize;
    const rows = state.filtered.slice(start, start + CONFIG.paymentsPageSize);
    dom.paymentRows.innerHTML = rows.map(row => `
      <tr>
        <td>${formatDate(row.fecha_emision)}</td>
        <td>${escapeHtml(row.tipo_operacion || "—")}</td>
        <td>${escapeHtml(normalizeBank(row.banco))}</td>
        <td class="fc-document">${escapeHtml(row.numero_propuesta)}</td>
        <td class="fc-money ${Number(row.monto) < 0 ? "fc-money--negative" : ""}">${formatCurrency(row.monto)}</td>
        <td>${escapeHtml(row.estado_portal || "—")}</td>
        <td>${row.comprobante_procesado_en ? `<span class="fc-status fc-status--yes">PDF cargado</span>` : `<span class="fc-status fc-status--pending">Pendiente</span>`}</td>
        <td>${paymentStatusBadge(row.estado_conciliacion)}</td>
        <td><button class="fc-row-action" type="button" data-payment-id="${escapeHtml(row.id)}">Ver detalle</button></td>
      </tr>`).join("");
  }

  function renderPaymentPagination() {
    const pages = Math.max(1, Math.ceil(state.filtered.length / CONFIG.paymentsPageSize));
    if (state.page > pages) state.page = pages;
    dom.paymentPageInfo.textContent = `Página ${state.page} de ${pages}`;
    dom.paymentPrev.disabled = state.page <= 1;
    dom.paymentNext.disabled = state.page >= pages;
  }

  function changePaymentPage(delta) {
    const pages = Math.max(1, Math.ceil(state.filtered.length / CONFIG.paymentsPageSize));
    state.page = Math.min(pages, Math.max(1, state.page + delta));
    renderPaymentTable();
    renderPaymentPagination();
  }

  async function openPaymentDetail(id) {
    let payment = state.payments.find(row => String(row.id) === String(id));
    if (!payment) {
      const detail = state.allDetails.find(row => String(row.payment?.id) === String(id));
      if (detail?.payment) payment = normalizePayment(detail.payment);
    }
    if (!payment || !state.backend) return;
    dom.paymentDetailTitle.textContent = `Propuesta ${payment.numero_propuesta}`;
    dom.paymentDetailSummary.innerHTML = paymentSummary(payment);
    dom.paymentDetailRows.innerHTML = `<tr><td colspan="7" class="fc-empty">Cargando detalle…</td></tr>`;
    dom.paymentDetailDialog.showModal();
    try {
      const rows = await state.backend.details(payment.id);
      state.detailPayment = payment;
      state.detailRows = Array.isArray(rows) ? rows : [];
      renderPaymentDetailRows();
    } catch (error) {
      dom.paymentDetailRows.innerHTML = `<tr><td colspan="7" class="fc-empty">No se pudo cargar el detalle: ${escapeHtml(error.message)}</td></tr>`;
    }
  }

  function paymentSummary(row) {
    const values = [
      ["Fecha", formatDate(row.fecha_emision)],
      ["Método", row.tipo_operacion || "—"],
      ["Monto Excel", formatCurrency(row.monto)],
      ["Saldo PDF", row.saldo_pdf === null || row.saldo_pdf === undefined ? "—" : formatCurrency(row.saldo_pdf)],
      ["Suma detalle", row.suma_detalle === null || row.suma_detalle === undefined ? "—" : formatCurrency(row.suma_detalle)],
      ["Estado", row.estado_conciliacion || "Pendiente"],
      ["Facturas", `${formatNumber(row.facturas_conciliadas || 0)} conciliadas · ${formatNumber(row.facturas_no_encontradas || 0)} no encontradas · ${formatNumber(row.facturas_ambiguas || 0)} ambiguas`],
      ["Comprobante", row.comprobante_nombre || "Pendiente"]
    ];
    return values.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  }

  function renderPaymentDetailRows() {
    if (!state.detailRows.length) {
      dom.paymentDetailRows.innerHTML = `<tr><td colspan="7" class="fc-empty">La propuesta todavía no tiene comprobante PDF procesado.</td></tr>`;
      return;
    }
    dom.paymentDetailRows.innerHTML = state.detailRows.map(row => {
      const invoice = row.facturas_copec || null;
      return `
        <tr>
          <td>${formatNumber(row.fila_orden)}</td>
          <td>${formatDate(row.fecha_documento)}</td>
          <td>${escapeHtml(row.tipo_documento || "—")}</td>
          <td class="fc-document">${escapeHtml(row.numero_documento || "—")}</td>
          <td class="fc-money ${Number(row.valor) < 0 ? "fc-money--negative" : ""}">${formatCurrency(row.valor)}</td>
          <td>${invoice ? `${escapeHtml(invoice.linea_producto || "Factura encontrada")}<br><small>${formatCurrency(invoice.cargos)} · vence ${formatDate(invoice.fecha_vencimiento)}</small>` : "—"}</td>
          <td>${paymentDetailStatusBadge(row.estado_conciliacion)}</td>
        </tr>`;
    }).join("");
  }


  async function loadConsolidatedDetails(force = false) {
    if (!state.backend || state.detailLoading) return;
    if (state.detailLoaded && !force) {
      applyConsolidatedFilters();
      return;
    }
    state.detailLoading = true;
    renderConsolidatedTable();
    try {
      const rows = await state.backend.listAllDetails();
      state.allDetails = (Array.isArray(rows) ? rows : []).map(normalizeConsolidatedDetail).sort(sortConsolidatedDetails);
      state.detailLoaded = true;
      rebuildConsolidatedFilters();
      applyConsolidatedFilters();
    } catch (error) {
      state.allDetails = [];
      state.filteredDetails = [];
      renderConsolidated();
      showToast(`No se pudo cargar el detalle consolidado: ${error.message}`, "error");
    } finally {
      state.detailLoading = false;
      renderConsolidated();
    }
  }

  function normalizeConsolidatedDetail(row) {
    const paymentRaw = row.pagos_copec || {};
    const invoice = row.facturas_copec || null;
    const payment = Object.assign({}, paymentRaw, {
      fecha_emision: toIsoDate(paymentRaw.fecha_emision),
      fecha_ejecucion: paymentRaw.fecha_ejecucion || null,
      numero_propuesta: documentValue(paymentRaw.numero_propuesta),
      monto: numberValue(paymentRaw.monto)
    });
    return Object.assign({}, row, {
      fila_orden: Number(row.fila_orden || 0),
      fecha_documento: toIsoDate(row.fecha_documento),
      numero_documento: documentValue(row.numero_documento),
      valor: numberValue(row.valor),
      diferencia: nullableNumber(row.diferencia),
      payment,
      invoice,
      fecha_propuesta: toIsoDate(payment.fecha_ejecucion || payment.fecha_emision)
    });
  }

  function sortConsolidatedDetails(a, b) {
    const paymentDate = String(b.fecha_propuesta || "").localeCompare(String(a.fecha_propuesta || ""));
    if (paymentDate !== 0) return paymentDate;
    const proposal = String(b.payment?.numero_propuesta || "").localeCompare(String(a.payment?.numero_propuesta || ""), "es", { numeric: true });
    if (proposal !== 0) return proposal;
    return Number(a.fila_orden || 0) - Number(b.fila_orden || 0);
  }

  function rebuildConsolidatedFilters() {
    const currentProposal = dom.consolidatedProposalFilter.value;
    const currentType = dom.consolidatedTypeFilter.value;
    const currentStatus = dom.consolidatedStatusFilter.value;
    const proposals = uniqueSorted(state.allDetails.map(row => row.payment?.numero_propuesta).filter(Boolean)).reverse();
    const types = uniqueSorted(state.allDetails.map(row => row.tipo_documento).filter(Boolean));
    const statuses = uniqueSorted(state.allDetails.map(row => row.estado_conciliacion).filter(Boolean));
    dom.consolidatedProposalFilter.innerHTML = `<option value="">Todas</option>${proposals.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
    dom.consolidatedTypeFilter.innerHTML = `<option value="">Todos</option>${types.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
    dom.consolidatedStatusFilter.innerHTML = `<option value="">Todas</option>${statuses.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
    if (proposals.includes(currentProposal)) dom.consolidatedProposalFilter.value = currentProposal;
    if (types.includes(currentType)) dom.consolidatedTypeFilter.value = currentType;
    if (statuses.includes(currentStatus)) dom.consolidatedStatusFilter.value = currentStatus;
  }

  function applyConsolidatedFilters() {
    const search = normalizeText(dom.consolidatedSearch.value);
    const proposal = dom.consolidatedProposalFilter.value;
    const type = dom.consolidatedTypeFilter.value;
    const status = dom.consolidatedStatusFilter.value;
    const from = dom.consolidatedFrom.value;
    const to = dom.consolidatedTo.value;
    state.filteredDetails = state.allDetails.filter(row => {
      const invoice = row.invoice || {};
      const payment = row.payment || {};
      const text = normalizeText([
        payment.numero_propuesta, payment.tipo_operacion, payment.banco, payment.comprobante_nombre,
        row.tipo_documento, row.numero_documento, row.estado_conciliacion,
        invoice.numero_documento, invoice.linea_producto, invoice.grupo_costo, invoice.corresponde_incluir
      ].join(" "));
      if (search && !text.includes(search)) return false;
      if (proposal && payment.numero_propuesta !== proposal) return false;
      if (type && row.tipo_documento !== type) return false;
      if (status && row.estado_conciliacion !== status) return false;
      if (from && (!row.fecha_documento || row.fecha_documento < from)) return false;
      if (to && (!row.fecha_documento || row.fecha_documento > to)) return false;
      return true;
    });
    state.detailPage = 1;
    renderConsolidated();
  }

  function clearConsolidatedFilters() {
    dom.consolidatedSearch.value = "";
    dom.consolidatedProposalFilter.value = "";
    dom.consolidatedTypeFilter.value = "";
    dom.consolidatedStatusFilter.value = "";
    dom.consolidatedFrom.value = "";
    dom.consolidatedTo.value = "";
    applyConsolidatedFilters();
  }

  function movementCategory(type) {
    const normalized = normalizeText(type);
    if (normalized === "factura") return "factura";
    if (normalized.includes("abono") || normalized.includes("nota de credito")) return "abono";
    return "otro";
  }

  function renderConsolidated() {
    renderConsolidatedKpis();
    renderConsolidatedTable();
    renderConsolidatedPagination();
    dom.consolidatedResultCount.textContent = `${formatNumber(state.filteredDetails.length)} resultado${state.filteredDetails.length === 1 ? "" : "s"}`;
  }

  function renderConsolidatedKpis() {
    const rows = state.filteredDetails;
    const invoices = rows.filter(row => movementCategory(row.tipo_documento) === "factura").length;
    const credits = rows.filter(row => movementCategory(row.tipo_documento) === "abono").length;
    const others = rows.length - invoices - credits;
    const net = rows.reduce((sum, row) => sum + numberValue(row.valor), 0);
    dom.detailKpiTotal.textContent = formatNumber(rows.length);
    dom.detailKpiFacturas.textContent = formatNumber(invoices);
    dom.detailKpiAbonos.textContent = formatNumber(credits);
    dom.detailKpiOtros.textContent = formatNumber(others);
    dom.detailKpiNeto.textContent = formatCurrency(net);
  }

  function renderConsolidatedTable() {
    if (state.detailLoading) {
      dom.consolidatedRows.innerHTML = `<tr><td colspan="11" class="fc-empty">Cargando todos los movimientos…</td></tr>`;
      return;
    }
    if (!state.filteredDetails.length) {
      dom.consolidatedRows.innerHTML = `<tr><td colspan="11" class="fc-empty">No hay movimientos para mostrar con estos filtros.</td></tr>`;
      return;
    }
    const start = (state.detailPage - 1) * CONFIG.consolidatedPageSize;
    const rows = state.filteredDetails.slice(start, start + CONFIG.consolidatedPageSize);
    dom.consolidatedRows.innerHTML = rows.map(row => {
      const payment = row.payment || {};
      const invoice = row.invoice || null;
      const invoiceText = invoice
        ? `<strong>${escapeHtml(invoice.numero_documento || row.numero_documento || "Factura")}</strong><small>${escapeHtml(invoice.linea_producto || "")} · ${formatCurrency(invoice.cargos)}${invoice.grupo_costo ? ` · ${escapeHtml(invoice.grupo_costo)}` : ""}</small>`
        : "—";
      const invoiceButton = invoice ? `<button class="fc-mini-action" type="button" data-open-invoice="${escapeHtml(invoice.numero_documento || row.numero_documento)}">Ver factura</button>` : "";
      return `<tr>
        <td>${formatDate(row.fecha_propuesta)}</td>
        <td class="fc-document">${escapeHtml(payment.numero_propuesta || "—")}</td>
        <td>${escapeHtml(payment.tipo_operacion || "—")}<small>${escapeHtml(normalizeBank(payment.banco))}</small></td>
        <td>${formatDate(row.fecha_documento)}</td>
        <td>${escapeHtml(row.tipo_documento || "—")}</td>
        <td class="fc-document">${escapeHtml(row.numero_documento || "—")}</td>
        <td class="fc-money ${Number(row.valor) < 0 ? "fc-money--negative" : ""}">${formatCurrency(row.valor)}</td>
        <td><div class="fc-related-invoice">${invoiceText}${invoiceButton}</div></td>
        <td>${paymentDetailStatusBadge(row.estado_conciliacion)}</td>
        <td>${escapeHtml(payment.comprobante_nombre || "—")}</td>
        <td><button class="fc-row-action" type="button" data-open-payment="${escapeHtml(payment.id || row.pago_id)}">Ver propuesta</button></td>
      </tr>`;
    }).join("");
  }

  function renderConsolidatedPagination() {
    const pages = Math.max(1, Math.ceil(state.filteredDetails.length / CONFIG.consolidatedPageSize));
    if (state.detailPage > pages) state.detailPage = pages;
    dom.consolidatedPageInfo.textContent = `Página ${state.detailPage} de ${pages}`;
    dom.consolidatedPrev.disabled = state.detailPage <= 1;
    dom.consolidatedNext.disabled = state.detailPage >= pages;
  }

  function changeConsolidatedPage(delta) {
    const pages = Math.max(1, Math.ceil(state.filteredDetails.length / CONFIG.consolidatedPageSize));
    state.detailPage = Math.min(pages, Math.max(1, state.detailPage + delta));
    renderConsolidatedTable();
    renderConsolidatedPagination();
  }

  function openInvoiceFromConsolidated(documentNumber) {
    showTab("facturas");
    const search = document.getElementById("filterSearch");
    if (search) {
      search.value = documentNumber || "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      search.scrollIntoView({ behavior: "smooth", block: "center" });
      search.focus();
    }
  }

  function exportConsolidatedDetails() {
    if (typeof XLSX === "undefined") {
      showToast("No se cargó la librería para exportar Excel.", "error");
      return;
    }
    if (!state.filteredDetails.length) {
      showToast("No hay movimientos filtrados para exportar.", "error");
      return;
    }
    const rows = state.filteredDetails.map(row => {
      const payment = row.payment || {};
      const invoice = row.invoice || {};
      return {
        "Fecha propuesta": formatDate(row.fecha_propuesta),
        "N° propuesta": payment.numero_propuesta || "",
        "Método": payment.tipo_operacion || "",
        "Banco": normalizeBank(payment.banco),
        "Fecha movimiento": formatDate(row.fecha_documento),
        "Tipo movimiento": row.tipo_documento || "",
        "N° documento": row.numero_documento || "",
        "Valor": numberValue(row.valor),
        "Estado conciliación": row.estado_conciliacion || "",
        "Factura relacionada": invoice.numero_documento || "",
        "Monto factura": invoice.cargos === null || invoice.cargos === undefined ? "" : numberValue(invoice.cargos),
        "Línea producto": invoice.linea_producto || "",
        "Corresponde incluir": invoice.corresponde_incluir || "",
        "Grupo de costo": invoice.grupo_costo || "",
        "Comprobante PDF": payment.comprobante_nombre || ""
      };
    });
    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet["!cols"] = [14,16,24,14,16,24,18,16,22,18,16,20,20,22,28].map(width => ({ wch: width }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Detalle consolidado");
    const date = localIsoDate(new Date()).replaceAll("-", "");
    XLSX.writeFile(workbook, `detalle_consolidado_propuestas_${date}.xlsx`);
    showToast(`${rows.length} movimientos exportados.`, "success");
  }

  function normalizePayment(row) {
    return Object.assign({}, row, {
      fecha_emision: toIsoDate(row.fecha_emision),
      numero_propuesta: documentValue(row.numero_propuesta),
      monto: numberValue(row.monto),
      saldo_pdf: nullableNumber(row.saldo_pdf),
      suma_detalle: nullableNumber(row.suma_detalle),
      diferencia_pdf_excel: nullableNumber(row.diferencia_pdf_excel),
      diferencia_detalle_pdf: nullableNumber(row.diferencia_detalle_pdf),
      total_movimientos: Number(row.total_movimientos || 0),
      total_facturas: Number(row.total_facturas || 0),
      facturas_conciliadas: Number(row.facturas_conciliadas || 0),
      facturas_no_encontradas: Number(row.facturas_no_encontradas || 0),
      facturas_con_diferencia: Number(row.facturas_con_diferencia || 0),
      facturas_ambiguas: Number(row.facturas_ambiguas || 0),
      estado_conciliacion: row.estado_conciliacion || "Pendiente de comprobante"
    });
  }

  function sortPayments(a, b) {
    const date = String(b.fecha_emision || "").localeCompare(String(a.fecha_emision || ""));
    if (date !== 0) return date;
    return String(b.numero_propuesta || "").localeCompare(String(a.numero_propuesta || ""), "es", { numeric: true });
  }

  function paymentStatusBadge(status) {
    const map = {
      "Cuadrada": "fc-status--paid",
      "Cuadrada con observaciones": "fc-status--partial",
      "Descuadrada": "fc-status--no",
      "Pendiente de comprobante": "fc-status--pending"
    };
    return `<span class="fc-status ${map[status] || "fc-status--pending"}">${escapeHtml(status || "Pendiente")}</span>`;
  }

  function paymentDetailStatusBadge(status) {
    const map = {
      "Conciliada": "fc-status--paid",
      "Pago parcial": "fc-status--partial",
      "Con diferencia": "fc-status--no",
      "No encontrada": "fc-status--no",
      "Movimiento compensatorio": "fc-status--neutral",
      "Coincidencia ambigua": "fc-status--no"
    };
    return `<span class="fc-status ${map[status] || "fc-status--pending"}">${escapeHtml(status || "Sin conciliar")}</span>`;
  }

  function createHeaderMap(headers, definitions) {
    const normalized = new Map(headers.map(header => [normalizeText(header), header]));
    const result = {};
    Object.entries(definitions).forEach(([field, aliases]) => {
      const found = aliases.map(normalizeText).find(alias => normalized.has(alias));
      if (found) result[field] = normalized.get(found);
    });
    return result;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("No se pudo leer el PDF."));
      reader.readAsDataURL(file);
    });
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

  function nullableNumber(value) {
    return value === null || value === undefined || value === "" ? null : numberValue(value);
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
    let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (match) return `${match[1]}-${pad2(match[2])}-${pad2(match[3])}`;
    match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (match) return `${match[3]}-${pad2(match[2])}-${pad2(match[1])}`;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : localIsoDate(date);
  }

  function localIsoDate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function pad2(value) { return String(value).padStart(2, "0"); }
  function uniqueSorted(values) { return [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b), "es")); }
  function prettyField(field) { return field.replaceAll("_", " "); }
  function normalizeBank(value) { return String(value || "").trim() === "8" ? "—" : (String(value || "").trim() || "—"); }

  function formatCurrency(value) {
    return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(numberValue(value));
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(Number(value) || 0);
  }

  function formatDate(value) {
    const iso = toIsoDate(value);
    if (!iso) return "—";
    const [year, month, day] = iso.split("-");
    return `${day}-${month}-${year}`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[char]);
  }

  function getCurrentUserName() {
    return stringValue(
      window.currentUser?.nombre ||
      window.currentUser?.name ||
      window.usuarioActual?.nombre ||
      localStorage.getItem("valepac_usuario_nombre") ||
      localStorage.getItem("usuario_nombre") ||
      "Usuario VALEPAC"
    );
  }

  function setPaymentStatus(element, text, error = false) {
    if (!element) return;
    element.hidden = false;
    element.textContent = text;
    element.classList.toggle("is-error", error);
  }

  let toastTimer = null;
  function showToast(message, type = "") {
    if (!dom.toast) return;
    clearTimeout(toastTimer);
    dom.toast.hidden = false;
    dom.toast.textContent = message;
    dom.toast.className = `fc-toast${type ? ` is-${type}` : ""}`;
    toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 5200);
  }
})();
