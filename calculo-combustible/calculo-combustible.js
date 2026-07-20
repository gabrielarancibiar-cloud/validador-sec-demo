(() => {
  'use strict';

  const CFG = window.CALCULO_COMBUSTIBLE_CONFIG;
  const $ = id => document.getElementById(id);
  const client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
  const TABLES = CFG.tablas;

  const state = {
    sales: [],
    telemetry: [],
    scenarios: [],
    availableDates: [],
    chart: null,
    lastResult: null,
    lastDetail: [],
    initializedDates: false,
    user: null
  };

  const PRODUCT_CAPACITY = {
    'Diesel': 117000,
    'Gasolina 93': 49000,
    'Gasolina 97': 20000,
    'Bluemax': 33000
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    readSession();
    bindEvents();
    setConnection('neutral', 'Conectando...');
    await testConnection();
    await loadAllData();
  }

  function readSession() {
    try {
      state.user = JSON.parse(localStorage.getItem('valepac_web_session') || 'null');
    } catch (_) {
      state.user = null;
    }
  }

  function bindEvents() {
    $('salesFile').addEventListener('change', e => {
      const file = e.target.files?.[0];
      $('salesFileName').textContent = file?.name || 'Ningún archivo seleccionado';
      if (file) importSalesCsv(file);
    });
    $('telemetryFile').addEventListener('change', e => {
      const file = e.target.files?.[0];
      $('telemetryFileName').textContent = file?.name || 'Ningún archivo seleccionado';
      if (file) importTelemetry(file);
    });
    $('reloadBtn').addEventListener('click', loadAllData);
    $('calculateBtn').addEventListener('click', calculateScenario);
    $('saveScenarioBtn').addEventListener('click', saveScenario);
    $('selectSuggestedBtn').addEventListener('click', selectSuggestedComparables);
    $('clearComparablesBtn').addEventListener('click', () => setComparableChecks([]));
    $('exportDetailBtn').addEventListener('click', exportDetailCsv);
    $('shareSummaryBtn')?.addEventListener('click', shareResultCard);
    ['realStart', 'cutoffDateTime'].forEach(id => $(id).addEventListener('change', renderComparableDates));
    $('productSelect').addEventListener('change', () => {
      const is95 = $('productSelect').value === 'Gasolina 95';
      $('plannedFuel').disabled = is95;
      $('pendingTae').disabled = is95;
      if (is95) {
        $('plannedFuel').value = 0;
        $('pendingTae').value = 0;
      }
      renderFuelLogo($('productSelect').value);
    });
    renderFuelLogo($('productSelect').value);
  }

  async function testConnection() {
    const { error } = await client.from(TABLES.ventas).select('id').limit(1);
    if (error) {
      setConnection('danger', 'Falta ejecutar SQL');
      showMessage('uploadMessage', `No fue posible leer Supabase: ${escapeHtml(error.message)}. Ejecuta el SQL del módulo.`, 'error');
    } else {
      setConnection('success', 'Conectado a Supabase');
    }
  }

  function setConnection(type, text) {
    const el = $('connectionBadge');
    el.className = `badge ${type}`;
    el.textContent = text;
  }

  async function loadAllData() {
    setProgress(8, 'Cargando ventas resumidas...');
    try {
      const [sales, telemetry, scenarios] = await Promise.all([
        fetchAll(TABLES.ventas, 'inicio', true),
        fetchAll(TABLES.telemediciones, 'snapshot_at', true),
        fetchAll(TABLES.escenarios, 'created_at', false, 100)
      ]);
      state.sales = sales.map(r => ({ ...r, inicioDate: parseDate(r.inicio) })).filter(r => isValidDate(r.inicioDate));
      state.telemetry = telemetry.map(r => ({
        ...r,
        snapshotDate: parseDate(r.snapshot_at),
        readingDate: parseDate(r.ultima_lectura)
      })).filter(r => isValidDate(r.snapshotDate));
      state.scenarios = scenarios;
      state.availableDates = [...new Set(state.sales.map(r => dateKey(r.inicioDate)))].sort().reverse();
      initializeDateControls();
      renderComparableDates();
      renderScenarios();
      setProgress(100, `Datos cargados: ${state.sales.length.toLocaleString('es-CL')} intervalos y ${state.telemetry.length.toLocaleString('es-CL')} lecturas.`);
      setTimeout(hideProgress, 700);
      if (state.sales.length) showMessage('uploadMessage', `Base disponible: ${state.availableDates.length} días con ventas resumidas.`, 'ok');
    } catch (err) {
      console.error(err);
      hideProgress();
      showMessage('uploadMessage', `Error cargando datos: ${escapeHtml(err.message || String(err))}`, 'error');
    }
  }

  async function fetchAll(table, orderColumn, ascending = true, hardLimit = null) {
    const pageSize = CFG.pageSize || 1000;
    const rows = [];
    let from = 0;
    while (true) {
      let query = client.from(table).select('*').order(orderColumn, { ascending }).range(from, from + pageSize - 1);
      const { data, error } = await query;
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize || (hardLimit && rows.length >= hardLimit)) break;
      from += pageSize;
    }
    return hardLimit ? rows.slice(0, hardLimit) : rows;
  }

  function initializeDateControls() {
    if (!state.sales.length || state.initializedDates) return;
    const maxDate = new Date(Math.max(...state.sales.map(r => r.inicioDate.getTime())));
    const cut = floorToInterval(maxDate, 30);
    const start = startOfDay(cut);
    let end = startOfDay(addDays(start, 1));
    end.setHours(5, 0, 0, 0);
    if (end <= cut) end = addDays(end, 1);
    $('realStart').value = toInputDateTime(start);
    $('cutoffDateTime').value = toInputDateTime(cut);
    $('projectionEnd').value = toInputDateTime(end);
    state.initializedDates = true;
  }

  function renderComparableDates() {
    const box = $('comparableDates');
    if (!state.availableDates.length) {
      box.innerHTML = '<div class="empty">Carga el CSV para ver fechas disponibles.</div>';
      return;
    }
    const selectedNow = getSelectedComparableDates();
    const start = parseDate($('realStart').value);
    const evalKey = isValidDate(start) ? dateKey(start) : null;
    const weekday = isValidDate(start) ? start.getDay() : null;
    const suggestions = state.availableDates
      .filter(d => d < evalKey)
      .filter(d => parseDate(`${d}T00:00:00`).getDay() === weekday)
      .slice(0, 6);

    const candidates = state.availableDates.filter(d => !evalKey || d < evalKey).slice(0, 35);
    box.innerHTML = candidates.map(d => {
      const suggested = suggestions.includes(d);
      const checked = selectedNow.includes(d) || (!selectedNow.length && suggestions.slice(0, 3).includes(d));
      const label = formatDate(parseDate(`${d}T00:00:00`));
      return `<label class="date-check ${suggested ? 'suggested' : ''}">
        <input type="checkbox" value="${d}" ${checked ? 'checked' : ''}>
        <span>${label}</span>${suggested ? '<small>Mismo día</small>' : ''}
      </label>`;
    }).join('') || '<div class="empty">No hay fechas anteriores disponibles.</div>';
  }

  function selectSuggestedComparables() {
    const start = parseDate($('realStart').value);
    if (!isValidDate(start)) return;
    const evalKey = dateKey(start);
    const weekday = start.getDay();
    const dates = state.availableDates
      .filter(d => d < evalKey && parseDate(`${d}T00:00:00`).getDay() === weekday)
      .slice(0, 3);
    setComparableChecks(dates);
  }

  function setComparableChecks(dates) {
    document.querySelectorAll('#comparableDates input[type="checkbox"]').forEach(el => {
      el.checked = dates.includes(el.value);
    });
  }

  function getSelectedComparableDates() {
    return [...document.querySelectorAll('#comparableDates input[type="checkbox"]:checked')].map(el => el.value).sort();
  }

  async function importSalesCsv(file) {
    setProgress(2, 'Leyendo CSV...');
    showMessage('uploadMessage', '', '');
    const buckets = new Map();
    let parsedRows = 0;
    let validRows = 0;
    let ignoredRows = 0;
    let minDate = null;
    let maxDate = null;

    Papa.parse(file, {
      header: true,
      delimiter: ';',
      skipEmptyLines: 'greedy',
      worker: true,
      step: result => {
        parsedRows++;
        const row = result.data || {};
        const when = parseSalesDate(row);
        const product = normalizeProduct(getField(row, ['PRODUCTO']));
        const liters = parseLocaleNumber(getField(row, ['CANTIDAD']));
        if (!isValidDate(when) || !product || !Number.isFinite(liters)) {
          ignoredRows++;
          return;
        }
        validRows++;
        minDate = !minDate || when < minDate ? when : minDate;
        maxDate = !maxDate || when > maxDate ? when : maxDate;
        const bucketDate = floorToInterval(when, 30);
        const key = `${toSqlDateTime(bucketDate)}|${product}`;
        if (!buckets.has(key)) {
          buckets.set(key, {
            estacion: CFG.estacion,
            inicio: toSqlDateTime(bucketDate),
            producto: product,
            litros_venta: 0,
            litros_bodega: 0,
            litros_surtidor9: 0,
            transacciones: 0,
            archivo_origen: file.name,
            updated_at: new Date().toISOString()
          });
        }
        const target = buckets.get(key);
        const payment = normalizeText(getField(row, ['FORMA PAGO']));
        const pump = String(getField(row, ['SURTIDOR ID']) || '').trim();
        if (payment.includes('MOVIMIENTO BODEGA')) target.litros_bodega += liters;
        else if (pump === '9') target.litros_surtidor9 += liters;
        else target.litros_venta += liters;
        target.transacciones += 1;
        if (parsedRows % 2500 === 0) setProgress(Math.min(45, 5 + parsedRows / 1800), `Procesando ventas: ${parsedRows.toLocaleString('es-CL')} filas...`);
      },
      complete: async () => {
        try {
          const rows = [...buckets.values()].map(r => ({
            ...r,
            litros_venta: round3(r.litros_venta),
            litros_bodega: round3(r.litros_bodega),
            litros_surtidor9: round3(r.litros_surtidor9)
          }));
          setProgress(50, `Guardando ${rows.length.toLocaleString('es-CL')} intervalos en Supabase...`);
          await upsertBatches(TABLES.ventas, rows, 'estacion,inicio,producto', 50, 91);
          await client.from(TABLES.importaciones).insert({
            estacion: CFG.estacion,
            tipo: 'ventas_csv',
            archivo_nombre: file.name,
            filas_leidas: parsedRows,
            filas_validas: validRows,
            registros_generados: rows.length,
            fecha_desde: minDate ? toSqlDateTime(minDate) : null,
            fecha_hasta: maxDate ? toSqlDateTime(maxDate) : null,
            usuario: getUserName(),
            detalle: { ignoradas: ignoredRows }
          });
          setProgress(95, 'Recargando base resumida...');
          await loadAllData();
          showMessage('uploadMessage', `CSV importado: ${validRows.toLocaleString('es-CL')} movimientos válidos, ${rows.length.toLocaleString('es-CL')} intervalos de 30 minutos y ${ignoredRows.toLocaleString('es-CL')} filas ignoradas.`, 'ok');
          $('salesFile').value = '';
        } catch (err) {
          console.error(err);
          hideProgress();
          showMessage('uploadMessage', `Error guardando el CSV: ${escapeHtml(err.message || String(err))}`, 'error');
        }
      },
      error: err => {
        hideProgress();
        showMessage('uploadMessage', `No se pudo leer el CSV: ${escapeHtml(err.message || String(err))}`, 'error');
      }
    });
  }

  async function importTelemetry(file) {
    setProgress(5, 'Leyendo telemedición...');
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
      const rows = [];
      for (const raw of rawRows) {
        const tank = String(getField(raw, ['Producto / Estanque', 'PRODUCTO / ESTANQUE']) || '').trim();
        if (!tank) continue;
        const capacity = parseLocaleNumber(getField(raw, ['Capacidad (Lts.)', 'CAPACIDAD (LTS.)']));
        const volume = parseLocaleNumber(getField(raw, ['Volumen Producto (Lts.)', 'VOLUMEN PRODUCTO (LTS.)']));
        const water = parseLocaleNumber(getField(raw, ['Volumen Agua (Lts.)', 'VOLUMEN AGUA (LTS.)'])) || 0;
        const reading = parseExcelDate(getField(raw, ['Última Lectura', 'ULTIMA LECTURA']));
        const update = parseExcelDate(getField(raw, ['Última Actualización', 'ULTIMA ACTUALIZACION'])) || reading;
        if (!isValidDate(update)) continue;
        const product = normalizeTankProduct(tank);
        if (!product) continue;
        const ageHours = isValidDate(reading) ? Math.abs(update - reading) / 3600000 : null;
        rows.push({
          estacion: CFG.estacion,
          snapshot_at: toSqlDateTime(update),
          estanque: tank,
          producto: product,
          capacidad_litros: round3(capacity || 0),
          volumen_litros: round3(volume || 0),
          volumen_agua_litros: round3(water),
          estado: String(getField(raw, ['Estado Estanque', 'ESTADO ESTANQUE']) || ''),
          ultima_lectura: isValidDate(reading) ? toSqlDateTime(reading) : null,
          turno_id: String(getField(raw, ['Turno ID', 'TURNO ID']) || ''),
          lectura_desactualizada: ageHours !== null ? ageHours > 6 : false,
          archivo_origen: file.name,
          updated_at: new Date().toISOString()
        });
      }
      if (!rows.length) throw new Error('El archivo no contiene filas de telemedición reconocibles.');
      setProgress(45, `Guardando ${rows.length} lecturas...`);
      await upsertBatches(TABLES.telemediciones, rows, 'estacion,snapshot_at,estanque', 45, 91);
      const times = rows.map(r => parseDate(r.snapshot_at)).filter(isValidDate);
      await client.from(TABLES.importaciones).insert({
        estacion: CFG.estacion,
        tipo: 'telemedicion_xlsx',
        archivo_nombre: file.name,
        filas_leidas: rawRows.length,
        filas_validas: rows.length,
        registros_generados: rows.length,
        fecha_desde: times.length ? toSqlDateTime(new Date(Math.min(...times))) : null,
        fecha_hasta: times.length ? toSqlDateTime(new Date(Math.max(...times))) : null,
        usuario: getUserName(),
        detalle: {}
      });
      await loadAllData();
      showMessage('uploadMessage', `Telemedición importada: ${rows.length} lecturas de estanques.`, 'ok');
      $('telemetryFile').value = '';
    } catch (err) {
      console.error(err);
      hideProgress();
      showMessage('uploadMessage', `Error en telemedición: ${escapeHtml(err.message || String(err))}`, 'error');
    }
  }

  async function upsertBatches(table, rows, onConflict, progressStart, progressEnd) {
    const size = CFG.batchSize || 400;
    for (let i = 0; i < rows.length; i += size) {
      const batch = rows.slice(i, i + size);
      const { error } = await client.from(table).upsert(batch, { onConflict });
      if (error) throw error;
      const pct = progressStart + ((Math.min(i + size, rows.length) / rows.length) * (progressEnd - progressStart));
      setProgress(pct, `Guardando ${Math.min(i + size, rows.length).toLocaleString('es-CL')} de ${rows.length.toLocaleString('es-CL')}...`);
    }
  }

  function calculateScenario() {
    try {
      const settings = readSettings();
      validateSettings(settings);
      const comparableRanges = buildComparableRanges(settings);
      const actual = sumCommercial(settings.product, settings.realStart, settings.cutoff, settings);
      const comparableActualValues = comparableRanges.map(r => sumCommercial(settings.product, r.realStart, r.cutoff, settings));
      const comparableFutureValues = comparableRanges.map(r => sumCommercial(settings.product, r.cutoff, r.end, settings));
      const avgActual = average(comparableActualValues);
      const futureBase = average(comparableFutureValues);
      const trend = avgActual > 0 ? (actual / avgActual) - 1 : 0;
      const futureAdjusted = Math.max(0, futureBase * (1 + trend));
      const futureManual = Math.max(0, futureBase * (1 + settings.manualAdjustment / 100));
      const selectedFuture = settings.model === 'base' ? futureBase : settings.model === 'manual' ? futureManual : futureAdjusted;
      const bodegaActual = sumBodega(settings.product, settings.realStart, settings.cutoff, settings);
      const telemetry = calculateTelemetry(settings);
      const stockBase = telemetry.syncedStock === null ? null : telemetry.syncedStock + settings.plannedFuel - futureBase - settings.pendingTae;
      const stockAdjusted = telemetry.syncedStock === null ? null : telemetry.syncedStock + settings.plannedFuel - futureAdjusted - settings.pendingTae;
      const projectedStock = telemetry.syncedStock === null ? null : telemetry.syncedStock + settings.plannedFuel - selectedFuture - settings.pendingTae;
      const capacityFree = projectedStock === null || telemetry.capacity === null ? null : telemetry.capacity - projectedStock;
      const detail = buildIntervalDetail(settings, comparableRanges, trend);
      const comparableVariations = settings.comparableDates.map((date, index) => {
        const comparableValue = Number(comparableActualValues[index] || 0);
        return {
          date,
          comparableValue,
          variation: comparableValue > 0 ? (actual / comparableValue) - 1 : null
        };
      });

      state.lastResult = {
        settings: serializeSettings(settings),
        actual,
        comparableActualValues,
        comparableVariations,
        comparableFutureValues,
        avgActual,
        futureBase,
        futureAdjusted,
        futureManual,
        selectedFuture,
        trend,
        bodegaActual,
        telemetry,
        stockBase,
        stockAdjusted,
        projectedStock,
        capacityFree,
        calculatedAt: new Date().toISOString()
      };
      state.lastDetail = detail;
      renderResult(state.lastResult, detail);
      showMessage('calculationMessage', 'Escenario calculado correctamente.', 'ok');
    } catch (err) {
      console.error(err);
      showMessage('calculationMessage', escapeHtml(err.message || String(err)), 'error');
    }
  }

  function readSettings() {
    return {
      product: $('productSelect').value,
      realStart: parseDate($('realStart').value),
      cutoff: parseDate($('cutoffDateTime').value),
      projectionEnd: parseDate($('projectionEnd').value),
      model: $('projectionModel').value,
      manualAdjustment: Number($('manualAdjustment').value || 0),
      plannedFuel: Number($('plannedFuel').value || 0),
      pendingTae: Number($('pendingTae').value || 0),
      excludePump9: $('excludePump9').checked,
      use95Split: $('use95Split').checked,
      includeBodegaInStock: $('includeBodegaInStock').checked,
      comparableDates: getSelectedComparableDates(),
      intervalMinutes: 30
    };
  }

  function validateSettings(s) {
    if (!state.sales.length) throw new Error('Primero carga el reporte de ventas CSV.');
    if (!isValidDate(s.realStart) || !isValidDate(s.cutoff) || !isValidDate(s.projectionEnd)) throw new Error('Completa las tres fechas y horas del escenario.');
    if (s.cutoff <= s.realStart) throw new Error('La hora de corte debe ser posterior al inicio de venta real.');
    if (s.projectionEnd <= s.cutoff) throw new Error('El fin de proyección debe ser posterior a la hora de corte.');
    if (!s.comparableDates.length) throw new Error('Selecciona al menos una fecha comparable.');
    if (s.plannedFuel < 0 || s.pendingTae < 0) throw new Error('Los valores manuales no pueden ser negativos.');
  }

  function buildComparableRanges(settings) {
    const anchor = startOfDay(settings.realStart);
    const startOffset = settings.realStart - anchor;
    const cutoffOffset = settings.cutoff - anchor;
    const endOffset = settings.projectionEnd - anchor;
    return settings.comparableDates.map(date => {
      const base = parseDate(`${date}T00:00:00`);
      return {
        date,
        realStart: new Date(base.getTime() + startOffset),
        cutoff: new Date(base.getTime() + cutoffOffset),
        end: new Date(base.getTime() + endOffset)
      };
    });
  }

  function calculateTelemetry(settings) {
    const physicalProduct = settings.product === 'Gasolina 95' ? null : settings.product;
    if (!physicalProduct) return emptyTelemetry('Gasolina 95 no tiene estanque propio; el módulo muestra solo venta comercial.');
    const groups = groupTelemetrySnapshots(physicalProduct);
    if (!groups.length) return emptyTelemetry('No existen telemediciones para el producto seleccionado.');

    let selected = [...groups].filter(g => g.date <= settings.cutoff).sort((a, b) => b.date - a.date)[0];
    let afterCutoff = false;
    if (!selected) {
      selected = [...groups].sort((a, b) => a.date - b.date)[0];
      afterCutoff = true;
    }
    const telemetryStock = sum(selected.rows.map(r => Number(r.volumen_litros) || 0));
    const capacityFromFile = sum(selected.rows.map(r => Number(r.capacidad_litros) || 0));
    const capacity = capacityFromFile || PRODUCT_CAPACITY[physicalProduct] || null;
    let commercialOutflow = 0;
    let bodegaOutflow = 0;
    let syncedStock = telemetryStock;
    if (selected.date <= settings.cutoff) {
      commercialOutflow = sumCommercial(physicalProduct, selected.date, settings.cutoff, settings);
      bodegaOutflow = settings.includeBodegaInStock ? sumBodega(physicalProduct, selected.date, settings.cutoff, settings) : 0;
      syncedStock = telemetryStock - commercialOutflow - bodegaOutflow;
    } else {
      commercialOutflow = sumCommercial(physicalProduct, settings.cutoff, selected.date, settings);
      bodegaOutflow = settings.includeBodegaInStock ? sumBodega(physicalProduct, settings.cutoff, selected.date, settings) : 0;
      syncedStock = telemetryStock + commercialOutflow + bodegaOutflow;
    }

    const warnings = [];
    const ageToCutoff = Math.abs(settings.cutoff - selected.date) / 3600000;
    if (ageToCutoff > 2) warnings.push(`La fotografía de telemedición está a ${ageToCutoff.toFixed(1)} horas de la hora de corte.`);
    if (afterCutoff) warnings.push('No había telemedición anterior al corte; se utilizó la primera posterior y se reconstruyó el stock hacia atrás.');
    selected.rows.forEach(r => {
      if (r.lectura_desactualizada) warnings.push(`${r.estanque}: última lectura desactualizada.`);
      if ((Number(r.volumen_litros) || 0) === 0 && r.readingDate && Math.abs(selected.date - r.readingDate) / 3600000 > 6) warnings.push(`${r.estanque}: volumen cero con lectura antigua; revisar sensor.`);
    });

    return {
      available: true,
      snapshot: selected.date,
      rows: selected.rows,
      telemetryStock,
      commercialOutflow,
      bodegaOutflow,
      totalOutflow: commercialOutflow + bodegaOutflow,
      syncedStock,
      capacity,
      warnings,
      afterCutoff
    };
  }

  function emptyTelemetry(message) {
    return { available: false, snapshot: null, rows: [], telemetryStock: null, commercialOutflow: 0, bodegaOutflow: 0, totalOutflow: 0, syncedStock: null, capacity: null, warnings: [message], afterCutoff: false };
  }

  function groupTelemetrySnapshots(product) {
    const groups = new Map();
    state.telemetry.filter(r => r.producto === product).forEach(r => {
      const key = toSqlDateTime(r.snapshotDate);
      if (!groups.has(key)) groups.set(key, { date: r.snapshotDate, rows: [] });
      groups.get(key).rows.push(r);
    });
    return [...groups.values()];
  }

  function sumCommercial(targetProduct, start, end, settings) {
    if (end <= start) return 0;
    let total = 0;
    for (const row of state.sales) {
      if (row.inicioDate < start || row.inicioDate >= end) continue;
      const factor = productFactor(row.producto, targetProduct, settings.use95Split);
      if (!factor) continue;
      const normal = Number(row.litros_venta) || 0;
      const pump9 = settings.excludePump9 ? 0 : (Number(row.litros_surtidor9) || 0);
      total += factor * (normal + pump9);
    }
    return total;
  }

  function sumBodega(targetProduct, start, end, settings) {
    if (end <= start) return 0;
    let total = 0;
    for (const row of state.sales) {
      if (row.inicioDate < start || row.inicioDate >= end) continue;
      const factor = productFactor(row.producto, targetProduct, settings.use95Split);
      if (!factor) continue;
      total += factor * (Number(row.litros_bodega) || 0);
    }
    return total;
  }

  function productFactor(source, target, use95Split) {
    if (source === target) return 1;
    if (use95Split && source === 'Gasolina 95' && target === 'Gasolina 93') return 0.5;
    if (use95Split && source === 'Gasolina 95' && target === 'Gasolina 97') return 0.5;
    return 0;
  }

  function buildIntervalDetail(settings, ranges, trend) {
    const rows = [];
    const factor = settings.model === 'base' ? 1 : settings.model === 'manual' ? (1 + settings.manualAdjustment / 100) : (1 + trend);
    const anchor = startOfDay(settings.realStart);
    for (let slot = new Date(settings.realStart); slot < settings.projectionEnd; slot = addMinutes(slot, 30)) {
      const slotEnd = addMinutes(slot, 30);
      const actual = slot < settings.cutoff ? sumCommercial(settings.product, slot, minDate(slotEnd, settings.cutoff), settings) : null;
      const offset = slot - anchor;
      const comps = ranges.map(r => {
        const compAnchor = startOfDay(r.realStart);
        const compStart = new Date(compAnchor.getTime() + offset);
        return sumCommercial(settings.product, compStart, addMinutes(compStart, 30), settings);
      });
      const avg = average(comps);
      const projection = slot >= settings.cutoff ? Math.max(0, avg * factor) : null;
      rows.push({ slot, slotEnd, actual, comps, avg, projection });
    }
    return rows;
  }

  function renderResult(result, detail) {
    const s = deserializeSettings(result.settings);
    setLiters('kpiActual', result.actual);
    $('kpiActualRange').textContent = `${formatDateTime(s.realStart)} → ${formatDateTime(s.cutoff)}`;
    setLiters('kpiComparable', result.avgActual);
    $('kpiTrend').textContent = formatPercent(result.trend);
    $('kpiTrend').className = result.trend >= 0 ? 'text-positive' : 'text-negative';
    setLiters('kpiFutureBase', result.futureBase);
    setLiters('kpiFutureAdjusted', result.futureAdjusted);
    setLiters('kpiProjectedStock', result.projectedStock);
    $('kpiStockDate').textContent = `Al ${formatDateTime(s.projectionEnd)}`;

    const t = result.telemetry;
    $('telemetryStatusBadge').className = `badge ${t.available ? (t.warnings.length ? 'warning' : 'success') : 'neutral'}`;
    $('telemetryStatusBadge').textContent = t.available ? (t.warnings.length ? 'Revisar lecturas' : 'Telemedición válida') : 'Sin stock físico';
    $('stockSnapshot').textContent = t.snapshot ? formatDateTime(t.snapshot) : '—';
    setLiters('stockTelemetry', t.telemetryStock);
    setLiters('stockOutflow', t.totalOutflow);
    setLiters('stockSynced', t.syncedStock);
    setLiters('stockBodega', result.bodegaActual);
    setLiters('stockCapacity', t.capacity);
    renderTelemetryRows(t.rows);
    renderTelemetryWarnings(t.warnings, t, s, result);

    setLiters('eqStock', t.syncedStock);
    setLiters('eqPlanned', s.plannedFuel);
    setLiters('eqFuture', result.selectedFuture);
    setLiters('eqTae', s.pendingTae);
    setLiters('eqFinal', result.projectedStock);
    setLiters('stockBaseResult', result.stockBase);
    setLiters('stockAdjustedResult', result.stockAdjusted);
    setLiters('capacityFreeResult', result.capacityFree);

    renderComparableVariations(result, s);
    renderFuelLogo(s.product);
    renderDetailTable(detail, s.comparableDates);
    renderChart(detail, s.comparableDates);
  }

  function renderComparableVariations(result, settings) {
    const panel = $('comparableVariations');
    const items = $('comparableVariationItems');
    if (!panel || !items) return;

    const dates = settings.comparableDates || [];
    if (!dates.length) {
      panel.classList.add('hidden');
      items.innerHTML = '';
      return;
    }

    const variations = Array.isArray(result.comparableVariations) && result.comparableVariations.length
      ? result.comparableVariations
      : dates.map((date, index) => {
          const comparableValue = Number(result.comparableActualValues?.[index] || 0);
          return {
            date,
            comparableValue,
            variation: comparableValue > 0 ? (Number(result.actual || 0) / comparableValue) - 1 : null
          };
        });

    items.innerHTML = variations.map(item => {
      const variation = item.variation;
      const tone = variation === null ? 'neutral' : variation >= 0 ? 'positive' : 'negative';
      const dateLabel = formatDate(parseDate(`${item.date}T00:00:00`));
      const variationLabel = variation === null ? 'Sin base' : formatPercent(variation);
      return `<article class="comparable-variation-item ${tone}">
        <div class="comparable-variation-data">
          <span>${dateLabel}</span>
          <strong>${variationLabel}</strong>
          <small>${formatLiters(item.comparableValue)} en el mismo tramo</small>
        </div>
        <button type="button" class="variation-remove" data-remove-comparable="${escapeHtml(item.date)}" title="Excluir esta fecha del cálculo">Descartar</button>
      </article>`;
    }).join('');

    panel.classList.remove('hidden');
    items.querySelectorAll('[data-remove-comparable]').forEach(button => {
      button.addEventListener('click', () => {
        const date = button.dataset.removeComparable;
        const checkbox = [...document.querySelectorAll('#comparableDates input[type="checkbox"]')].find(el => el.value === date);
        if (checkbox) checkbox.checked = false;
        calculateScenario();
      });
    });
  }

  async function shareResultCard() {
    const button = $('shareSummaryBtn');
    if (!state.lastResult) {
      showMessage('calculationMessage', 'Primero calcula un escenario para generar la captura.', 'warn');
      return;
    }
    if (!window.html2canvas) {
      showMessage('calculationMessage', 'No se pudo cargar el generador de capturas. Actualiza la página e inténtalo nuevamente.', 'error');
      return;
    }

    const card = $('resultCard');
    if (!card) return;

    const originalText = button?.textContent || 'Compartir';
    if (button) {
      button.disabled = true;
      button.textContent = 'Generando captura...';
    }

    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const canvas = await window.html2canvas(card, {
        backgroundColor: '#ffffff',
        scale: Math.min(2, window.devicePixelRatio || 1.5),
        useCORS: true,
        logging: false,
        removeContainer: true,
        ignoreElements: element => element?.hasAttribute?.('data-html2canvas-ignore')
      });
      const blob = await canvasToBlob(canvas, 'image/png', 1);
      if (!blob) throw new Error('No se pudo crear la imagen de la captura.');

      const summary = buildShareSummary(state.lastResult);
      const fileName = buildShareFileName(state.lastResult);
      const file = new File([blob], fileName, { type: 'image/png' });

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({
            title: 'Cálculo de combustible VALEPAC',
            text: summary,
            files: [file]
          });
          showMessage('calculationMessage', 'Captura compartida correctamente.', 'ok');
          return;
        } catch (error) {
          if (error?.name === 'AbortError') return;
          console.warn('El uso compartido nativo falló; se usará WhatsApp Web.', error);
        }
      }

      const copied = await copyImageToClipboard(blob);
      if (!copied) downloadBlob(blob, fileName);

      const instruction = copied
        ? 'La captura quedó copiada. Elige un contacto y pégala con Ctrl+V.'
        : 'La captura quedó descargada. Elige un contacto y adjunta la imagen.';
      const whatsappText = `${summary}\n\n${instruction}`;
      const whatsappUrl = `https://web.whatsapp.com/send?text=${encodeURIComponent(whatsappText)}`;
      const popup = window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
      if (!popup) window.location.href = whatsappUrl;
      showMessage('calculationMessage', instruction, 'ok');
    } catch (error) {
      console.error(error);
      showMessage('calculationMessage', escapeHtml(error.message || 'No se pudo generar la captura.'), 'error');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }

  function buildShareSummary(result) {
    const s = deserializeSettings(result.settings);
    return [
      'VALEPAC · Cálculo de combustible',
      `Producto: ${s.product}`,
      `Rango proyectado: ${formatDateTime(s.cutoff)} → ${formatDateTime(s.projectionEnd)}`,
      `Stock sincronizado: ${formatLiters(result.telemetry?.syncedStock)}`,
      `Programado: ${formatLiters(s.plannedFuel)}`,
      `Venta futura: ${formatLiters(result.selectedFuture)}`,
      `TAE pendiente: ${formatLiters(s.pendingTae)}`,
      `Stock final: ${formatLiters(result.projectedStock)}`
    ].join('\n');
  }

  function buildShareFileName(result) {
    const s = deserializeSettings(result.settings);
    const product = String(s.product || 'combustible')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const end = s.projectionEnd instanceof Date && !Number.isNaN(s.projectionEnd.getTime())
      ? s.projectionEnd.toISOString().slice(0, 16).replace(/[:T]/g, '-')
      : new Date().toISOString().slice(0, 10);
    return `valepac-${product}-${end}.png`;
  }

  function canvasToBlob(canvas, type = 'image/png', quality = 1) {
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
  }

  async function copyImageToClipboard(blob) {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch (error) {
      console.warn('No se pudo copiar la imagen al portapapeles.', error);
      return false;
    }
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function renderFuelLogo(product) {
    const el = $('fuelLogo');
    if (!el) return;
    const logos = {
      'Diesel': { mark: 'DSL', name: 'Diesel', css: 'fuel-diesel' },
      'Gasolina 93': { mark: '93', name: 'Gasolina', css: 'fuel-93' },
      'Gasolina 95': { mark: '95', name: 'Gasolina', css: 'fuel-95' },
      'Gasolina 97': { mark: '97', name: 'Gasolina', css: 'fuel-97' },
      'Bluemax': { mark: 'BM', name: 'Bluemax', css: 'fuel-bluemax' }
    };
    const logo = logos[product] || { mark: '⛽', name: product || 'Combustible', css: 'fuel-generic' };
    el.className = `fuel-logo ${logo.css}`;
    el.setAttribute('aria-label', `Combustible evaluado: ${logo.name} ${logo.mark}`.trim());
    el.innerHTML = `<span class="fuel-logo-mark">${escapeHtml(logo.mark)}</span><small class="fuel-logo-name">${escapeHtml(logo.name)}</small>`;
  }

  function renderTelemetryRows(rows) {
    $('telemetryRows').innerHTML = rows.length ? rows.map(r => {
      const stale = r.lectura_desactualizada;
      return `<tr>
        <td><b>${escapeHtml(r.estanque)}</b></td>
        <td>${formatLiters(r.capacidad_litros)}</td>
        <td>${formatLiters(r.volumen_litros)}</td>
        <td>${r.readingDate ? formatDateTime(r.readingDate) : '—'}</td>
        <td><span class="badge ${stale ? 'danger' : 'success'}">${stale ? 'Desactualizada' : escapeHtml(r.estado || 'OK')}</span></td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="empty-cell">Sin datos para este producto.</td></tr>';
  }

  function renderTelemetryWarnings(warnings, telemetry, settings, result) {
    const extra = [];
    if (telemetry.available && result.projectedStock < 0) extra.push('ALERTA: el stock proyectado queda bajo cero dentro del rango seleccionado.');
    if (telemetry.available && result.projectedStock > telemetry.capacity) extra.push('ALERTA: el stock proyectado supera la capacidad física informada.');
    const all = [...warnings, ...extra];
    $('telemetryWarnings').innerHTML = all.length ? `<div class="notice ${extra.length ? 'error' : 'warn'}">${all.map(x => `• ${escapeHtml(x)}`).join('<br>')}</div>` : '<div class="notice ok">Sin alertas de telemedición para el escenario.</div>';
  }

  function renderDetailTable(detail, comparableDates) {
    $('detailHead').innerHTML = `<tr><th>Rango</th><th>Día evaluado</th>${comparableDates.map(d => `<th>${formatDate(parseDate(`${d}T00:00:00`))}</th>`).join('')}<th>Promedio</th><th>Proyección</th></tr>`;
    $('detailRows').innerHTML = detail.map(r => `<tr>
      <td>${formatTime(r.slot)}–${formatTime(r.slotEnd)}<br><small>${formatDate(r.slot)}</small></td>
      <td>${r.actual === null ? '—' : formatLiters(r.actual)}</td>
      ${r.comps.map(v => `<td>${formatLiters(v)}</td>`).join('')}
      <td><b>${formatLiters(r.avg)}</b></td>
      <td>${r.projection === null ? '—' : `<b>${formatLiters(r.projection)}</b>`}</td>
    </tr>`).join('');
  }

  function renderChart(detail, comparableDates) {
    const ctx = $('salesChart');
    if (state.chart) state.chart.destroy();
    const labels = detail.map(r => `${formatDateShort(r.slot)} ${formatTime(r.slot)}`);
    const datasets = [
      { label: 'Día evaluado', data: detail.map(r => r.actual), borderColor: '#e30613', backgroundColor: 'rgba(227,6,19,.12)', borderWidth: 3, tension: .22, pointRadius: 1.5, spanGaps: false },
      { label: 'Promedio comparable', data: detail.map(r => r.avg), borderColor: '#0a477b', borderWidth: 2, borderDash: [6, 4], tension: .22, pointRadius: 0 },
      { label: 'Proyección seleccionada', data: detail.map(r => r.projection), borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,.12)', borderWidth: 3, tension: .22, pointRadius: 1.5, spanGaps: false }
    ];
    const palette = ['#8b5cf6', '#f59e0b', '#06b6d4', '#64748b', '#ec4899', '#84cc16'];
    comparableDates.forEach((d, i) => datasets.push({
      label: formatDate(parseDate(`${d}T00:00:00`)),
      data: detail.map(r => r.comps[i]),
      borderColor: palette[i % palette.length],
      borderWidth: 1.2,
      tension: .18,
      pointRadius: 0,
      hidden: i >= 3
    }));
    state.chart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${formatLiters(c.parsed.y)}` } } },
        scales: { y: { beginAtZero: true, ticks: { callback: v => Number(v).toLocaleString('es-CL') + ' L' } }, x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 18 } } }
      }
    });
  }

  async function saveScenario() {
    if (!state.lastResult) {
      showMessage('calculationMessage', 'Primero calcula el escenario.', 'warn');
      return;
    }
    const result = state.lastResult;
    const s = result.settings;
    const defaultName = `${s.product} · ${formatDateTime(parseDate(s.cutoff))} → ${formatDateTime(parseDate(s.projectionEnd))}`;
    const name = prompt('Nombre del escenario:', defaultName);
    if (name === null) return;
    const payload = {
      estacion: CFG.estacion,
      nombre: name.trim() || defaultName,
      producto: s.product,
      inicio_real: s.realStart,
      hora_corte: s.cutoff,
      fin_proyeccion: s.projectionEnd,
      fechas_comparables: s.comparableDates,
      modelo: s.model,
      ajuste_manual: s.manualAdjustment,
      combustible_programado: s.plannedFuel,
      tae_pendiente: s.pendingTae,
      excluir_surtidor_9: s.excludePump9,
      distribuir_95: s.use95Split,
      descontar_bodega_stock: s.includeBodegaInStock,
      resultados: result,
      usuario: getUserName()
    };
    const { error } = await client.from(TABLES.escenarios).insert(payload);
    if (error) {
      showMessage('calculationMessage', `No se pudo guardar: ${escapeHtml(error.message)}`, 'error');
      return;
    }
    showMessage('calculationMessage', 'Escenario guardado en Supabase.', 'ok');
    state.scenarios = await fetchAll(TABLES.escenarios, 'created_at', false, 100);
    renderScenarios();
  }

  function renderScenarios() {
    const box = $('scenarioList');
    if (!state.scenarios.length) {
      box.innerHTML = '<div class="empty">No hay escenarios guardados.</div>';
      return;
    }
    box.innerHTML = state.scenarios.slice(0, 30).map(s => `<article class="scenario-item">
      <h3>${escapeHtml(s.nombre || s.producto)}</h3>
      <p>${escapeHtml(s.producto)} · ${formatDateTime(parseDate(s.hora_corte))} → ${formatDateTime(parseDate(s.fin_proyeccion))}</p>
      <p>Comparables: ${(s.fechas_comparables || []).length} · Modelo: ${escapeHtml(s.modelo || 'base')}</p>
      <p>Guardado por ${escapeHtml(s.usuario || 'Usuario')} · ${formatDateTime(parseDate(s.created_at))}</p>
      <div class="actions"><button class="btn secondary small" data-load-scenario="${s.id}">Cargar</button><button class="btn ghost small" data-delete-scenario="${s.id}">Eliminar</button></div>
    </article>`).join('');
    box.querySelectorAll('[data-load-scenario]').forEach(btn => btn.addEventListener('click', () => loadScenario(Number(btn.dataset.loadScenario))));
    box.querySelectorAll('[data-delete-scenario]').forEach(btn => btn.addEventListener('click', () => deleteScenario(Number(btn.dataset.deleteScenario))));
  }

  function loadScenario(id) {
    const s = state.scenarios.find(x => Number(x.id) === Number(id));
    if (!s) return;
    $('productSelect').value = s.producto;
    $('realStart').value = toInputDateTime(parseDate(s.inicio_real));
    $('cutoffDateTime').value = toInputDateTime(parseDate(s.hora_corte));
    $('projectionEnd').value = toInputDateTime(parseDate(s.fin_proyeccion));
    $('projectionModel').value = s.modelo || 'adjusted';
    $('manualAdjustment').value = s.ajuste_manual || 0;
    $('plannedFuel').value = s.combustible_programado || 0;
    $('pendingTae').value = s.tae_pendiente || 0;
    $('excludePump9').checked = s.excluir_surtidor_9 !== false;
    $('use95Split').checked = s.distribuir_95 !== false;
    $('includeBodegaInStock').checked = s.descontar_bodega_stock !== false;
    renderComparableDates();
    setComparableChecks(s.fechas_comparables || []);
    calculateScenario();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function deleteScenario(id) {
    if (!confirm('¿Eliminar este escenario guardado?')) return;
    const { error } = await client.from(TABLES.escenarios).delete().eq('id', id);
    if (error) return alert(error.message);
    state.scenarios = state.scenarios.filter(x => Number(x.id) !== Number(id));
    renderScenarios();
  }

  function exportDetailCsv() {
    if (!state.lastDetail.length || !state.lastResult) {
      alert('Primero calcula un escenario.');
      return;
    }
    const dates = state.lastResult.settings.comparableDates;
    const headers = ['Rango inicio', 'Rango fin', 'Día evaluado', ...dates, 'Promedio', 'Proyección'];
    const lines = [headers.join(';')];
    state.lastDetail.forEach(r => {
      lines.push([
        toSqlDateTime(r.slot),
        toSqlDateTime(r.slotEnd),
        r.actual ?? '',
        ...r.comps,
        r.avg,
        r.projection ?? ''
      ].map(csvCell).join(';'));
    });
    downloadBlob(`detalle_calculo_combustible_${dateKey(new Date())}.csv`, '\ufeff' + lines.join('\n'), 'text/csv;charset=utf-8');
  }

  function serializeSettings(s) {
    return {
      ...s,
      realStart: toSqlDateTime(s.realStart),
      cutoff: toSqlDateTime(s.cutoff),
      projectionEnd: toSqlDateTime(s.projectionEnd)
    };
  }

  function deserializeSettings(s) {
    return { ...s, realStart: parseDate(s.realStart), cutoff: parseDate(s.cutoff), projectionEnd: parseDate(s.projectionEnd) };
  }

  function parseSalesDate(row) {
    const close = getField(row, ['FECHA CIERRE TRANSACCIÓN', 'FECHA CIERRE TRANSACCION']);
    if (close) return parseDate(String(close).replace(' ', 'T'));
    const date = getField(row, ['FECHA TRANSACCIÓN', 'FECHA TRANSACCION']);
    const time = getField(row, ['HORA TRANSACCIÓN', 'HORA TRANSACCION']);
    return date ? parseDate(`${date}T${time || '00:00:00'}`) : null;
  }

  function getField(row, aliases) {
    const normalized = {};
    Object.keys(row || {}).forEach(k => normalized[normalizeText(k)] = row[k]);
    for (const alias of aliases) {
      const key = normalizeText(alias);
      if (Object.prototype.hasOwnProperty.call(normalized, key)) return normalized[key];
    }
    return undefined;
  }

  function normalizeProduct(value) {
    const v = normalizeText(value);
    if (!v) return '';
    if (v.includes('DIESEL')) return 'Diesel';
    if (v.includes('GASOLINA 93') || v === '93') return 'Gasolina 93';
    if (v.includes('GASOLINA 95') || v === '95') return 'Gasolina 95';
    if (v.includes('GASOLINA 97') || v === '97') return 'Gasolina 97';
    if (v.includes('BLUEMAX') || v.startsWith('BM')) return 'Bluemax';
    return '';
  }

  function normalizeTankProduct(tank) {
    const v = normalizeText(tank);
    if (v.startsWith('DSL') || v.includes('DIESEL')) return 'Diesel';
    if (v.startsWith('93')) return 'Gasolina 93';
    if (v.startsWith('97')) return 'Gasolina 97';
    if (v.startsWith('BM') || v.includes('BLUEMAX')) return 'Bluemax';
    return '';
  }

  function parseExcelDate(value) {
    if (value instanceof Date) return value;
    if (typeof value === 'number' && window.XLSX?.SSF?.parse_date_code) {
      const p = XLSX.SSF.parse_date_code(value);
      if (p) return new Date(p.y, p.m - 1, p.d, p.H || 0, p.M || 0, Math.floor(p.S || 0));
    }
    if (typeof value === 'number') return new Date((value - 25569) * 86400000);
    return parseDate(value);
  }

  function parseLocaleNumber(value) {
    if (typeof value === 'number') return value;
    if (value === null || value === undefined || value === '') return NaN;
    let s = String(value).trim().replace(/\s/g, '').replace(/\$/g, '');
    if (s.includes(',') && s.includes('.')) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (s.includes(',')) s = s.replace(',', '.');
    return Number(s);
  }

  function normalizeText(v) {
    return String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
  }

  function parseDate(v) {
    if (v instanceof Date) return new Date(v.getTime());
    if (!v) return null;
    const s = String(v).trim();
    const d = new Date(s);
    if (isValidDate(d)) return d;
    const m = s.match(/^(\d{2})[-\/]?(\d{2})[-\/]?(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
    return null;
  }

  function isValidDate(d) { return d instanceof Date && !Number.isNaN(d.getTime()); }
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, days) { const x = new Date(d); x.setDate(x.getDate() + days); return x; }
  function addMinutes(d, minutes) { return new Date(d.getTime() + minutes * 60000); }
  function minDate(a, b) { return a < b ? a : b; }
  function floorToInterval(d, minutes) { const x = new Date(d); x.setSeconds(0, 0); x.setMinutes(Math.floor(x.getMinutes() / minutes) * minutes); return x; }
  function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function toSqlDateTime(d) { return `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
  function toInputDateTime(d) { return isValidDate(d) ? `${dateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function formatDate(d) { return isValidDate(d) ? d.toLocaleDateString('es-CL', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'; }
  function formatDateShort(d) { return isValidDate(d) ? d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' }) : '—'; }
  function formatTime(d) { return isValidDate(d) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '—'; }
  function formatDateTime(d) { return isValidDate(d) ? `${d.toLocaleDateString('es-CL')} ${formatTime(d)}` : '—'; }
  function formatLiters(v) { return v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : `${Number(v).toLocaleString('es-CL', { maximumFractionDigits: 0 })} L`; }
  function setLiters(id, v) { $(id).textContent = formatLiters(v); }
  function formatPercent(v) { return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toLocaleString('es-CL', { maximumFractionDigits: 1 })}%` : '—'; }
  function average(arr) { return arr.length ? sum(arr) / arr.length : 0; }
  function sum(arr) { return arr.reduce((a, b) => a + (Number(b) || 0), 0); }
  function round3(v) { return Math.round((Number(v) || 0) * 1000) / 1000; }
  function getUserName() { return state.user?.nombre || state.user?.usuario || 'Usuario VALEPAC'; }
  function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m])); }
  function csvCell(v) { const s = String(v ?? '').replace(/"/g, '""'); return `"${s}"`; }

  function showMessage(id, text, type) {
    const el = $(id);
    if (!text) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="notice ${type}">${text}</div>`;
  }

  function setProgress(percent, text) {
    $('progressWrap').classList.remove('hidden');
    $('progressBar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
    $('progressText').textContent = text;
  }
  function hideProgress() { $('progressWrap').classList.add('hidden'); }

  function downloadBlob(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
})();
