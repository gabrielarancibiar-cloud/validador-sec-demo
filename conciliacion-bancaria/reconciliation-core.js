(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ReconciliationCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DAY_MS = 86400000;

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function normalizeHeader(value) {
    return normalizeText(value).replace(/\s+/g, " ");
  }

  function parseAmount(value) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
    let text = String(value ?? "").trim();
    if (!text) return 0;
    const negative = /^\s*-/.test(text) || /^\(.*\)$/.test(text);
    text = text.replace(/[^0-9.,]/g, "");
    if (!text) return 0;

    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    const lastSeparator = Math.max(lastComma, lastDot);
    let normalized;

    if (lastSeparator >= 0 && text.length - lastSeparator - 1 === 2) {
      const integerPart = text.slice(0, lastSeparator).replace(/[.,]/g, "");
      const decimalPart = text.slice(lastSeparator + 1);
      normalized = `${integerPart}.${decimalPart}`;
    } else {
      normalized = text.replace(/[.,]/g, "");
    }

    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return 0;
    return Math.round((negative ? -1 : 1) * parsed);
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function validParts(parts) {
    return parts && parts.year >= 1900 && parts.year <= 2200 && parts.month >= 1 && parts.month <= 12 && parts.day >= 1 && parts.day <= 31;
  }

  function datePartsFromValue(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return {
        year: value.getUTCFullYear(),
        month: value.getUTCMonth() + 1,
        day: value.getUTCDate(),
        hour: value.getUTCHours(),
        minute: value.getUTCMinutes(),
        second: value.getUTCSeconds()
      };
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      const daySerial = Math.floor(value);
      const fraction = Math.max(0, value - daySerial);
      const date = new Date(Date.UTC(1899, 11, 30) + daySerial * DAY_MS);
      const seconds = Math.round(fraction * 86400) % 86400;
      return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: Math.floor(seconds / 3600),
        minute: Math.floor((seconds % 3600) / 60),
        second: seconds % 60
      };
    }

    const text = String(value ?? "").trim();
    if (!text) return null;

    let match = text.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (match) {
      return {
        year: Number(match[3]), month: Number(match[2]), day: Number(match[1]),
        hour: Number(match[4] || 0), minute: Number(match[5] || 0), second: Number(match[6] || 0)
      };
    }

    match = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (match) {
      return {
        year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
        hour: Number(match[4] || 0), minute: Number(match[5] || 0), second: Number(match[6] || 0)
      };
    }

    return null;
  }

  function timePartsFromValue(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return { hour: value.getUTCHours(), minute: value.getUTCMinutes(), second: value.getUTCSeconds() };
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const seconds = Math.round((value % 1) * 86400) % 86400;
      return { hour: Math.floor(seconds / 3600), minute: Math.floor((seconds % 3600) / 60), second: seconds % 60 };
    }
    const match = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return { hour: 0, minute: 0, second: 0 };
    return { hour: Number(match[1]), minute: Number(match[2]), second: Number(match[3] || 0) };
  }

  function timestampFromParts(parts) {
    if (!validParts(parts)) return null;
    const hour = Number(parts.hour || 0);
    const minute = Number(parts.minute || 0);
    const second = Number(parts.second || 0);
    const dateKey = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
    const dateTime = `${dateKey} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
    return { dateKey, dateTime, epoch: Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, second) };
  }

  function parseDateTime(dateValue, timeValue) {
    const dateParts = datePartsFromValue(dateValue);
    if (!dateParts) return null;
    if (timeValue !== undefined && timeValue !== null && String(timeValue).trim() !== "") {
      const time = timePartsFromValue(timeValue);
      dateParts.hour = time.hour;
      dateParts.minute = time.minute;
      dateParts.second = time.second;
    }
    return timestampFromParts(dateParts);
  }

  function headerIndex(headers, aliases) {
    const normalized = headers.map(normalizeHeader);
    for (const alias of aliases) {
      const index = normalized.indexOf(normalizeHeader(alias));
      if (index >= 0) return index;
    }
    return -1;
  }

  function findHeader(matrix, requiredAliasGroups) {
    const max = Math.min(matrix.length, 20);
    for (let rowIndex = 0; rowIndex < max; rowIndex += 1) {
      const headers = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
      const indexes = requiredAliasGroups.map(group => headerIndex(headers, group));
      if (indexes.every(index => index >= 0)) return { rowIndex, headers };
    }
    return null;
  }

  function valueAt(row, index) {
    return index >= 0 ? row[index] : "";
  }

  function parseMaeMatrix(matrix, options = {}) {
    if (!Array.isArray(matrix)) throw new Error("El archivo MAE no contiene una hoja válida.");
    const required = [
      ["Fecha transacción", "Fecha de transacción"],
      ["Nombre CashToday"],
      ["Tipo transacción", "Tipo de transacción"],
      ["Divisa", "Moneda"],
      ["Importe", "Monto"]
    ];
    const found = findHeader(matrix, required);
    if (!found) throw new Error("No se reconoció el formato MAE. Faltan columnas como Fecha transacción, Nombre CashToday, Tipo transacción, Divisa o Importe.");

    const { rowIndex, headers } = found;
    const columns = {
      date: headerIndex(headers, required[0]),
      machine: headerIndex(headers, required[1]),
      client: headerIndex(headers, ["Nombre cliente", "Cliente"]),
      user: headerIndex(headers, ["Nombre usuario", "Usuario"]),
      type: headerIndex(headers, required[2]),
      currency: headerIndex(headers, required[3]),
      amount: headerIndex(headers, required[4])
    };

    const deposits = [];
    const pickups = [];
    let invalidRows = 0;
    const maxRows = Number(options.maxRows || 10000);
    const dataRows = matrix.slice(rowIndex + 1, rowIndex + 1 + maxRows);

    dataRows.forEach((row, offset) => {
      if (!Array.isArray(row) || row.every(cell => String(cell ?? "").trim() === "")) return;
      const sourceRow = rowIndex + offset + 2;
      const type = String(valueAt(row, columns.type) ?? "").trim();
      const normalizedType = normalizeText(type);
      const timestamp = parseDateTime(valueAt(row, columns.date));
      const amount = parseAmount(valueAt(row, columns.amount));
      const base = {
        sourceKey: `MAE-${sourceRow}`,
        sourceRow,
        dateTime: timestamp?.dateTime || "",
        dateKey: timestamp?.dateKey || "",
        epoch: timestamp?.epoch ?? null,
        machine: String(valueAt(row, columns.machine) ?? "").trim(),
        client: String(valueAt(row, columns.client) ?? "").trim(),
        user: String(valueAt(row, columns.user) ?? "").trim(),
        type,
        currency: String(valueAt(row, columns.currency) ?? "").trim(),
        amount
      };

      if (!timestamp || amount <= 0) {
        invalidRows += 1;
        return;
      }
      if (normalizedType === "deposito") deposits.push(base);
      else if (normalizedType === "recogida") pickups.push(base);
    });

    if (!deposits.length) throw new Error("El archivo MAE no contiene filas de tipo Depósito con fecha e importe válidos.");
    return {
      kind: "mae",
      headerRow: rowIndex + 1,
      sourceRows: dataRows.length,
      deposits: deposits.sort((a, b) => a.epoch - b.epoch),
      pickups,
      invalidRows
    };
  }

  function parseBciMatrix(matrix, options = {}) {
    if (!Array.isArray(matrix)) throw new Error("El archivo BCI no contiene una hoja válida.");
    const required = [
      ["Fecha de transacción", "Fecha transacción"],
      ["Hora transacción", "Hora de transacción"],
      ["Código de transacción", "Codigo de transaccion"],
      ["Tipo de transacción", "Tipo transacción"],
      ["Glosa detalle", "Detalle"],
      ["Ingreso (+)", "Ingreso", "Abono"]
    ];
    const found = findHeader(matrix, required);
    if (!found) throw new Error("No se reconoció la cartola BCI. Faltan columnas como Fecha, Hora, Código, Tipo de transacción, Glosa detalle o Ingreso (+).");

    const { rowIndex, headers } = found;
    const columns = {
      date: headerIndex(headers, required[0]),
      time: headerIndex(headers, required[1]),
      accountingDate: headerIndex(headers, ["Fecha contable"]),
      code: headerIndex(headers, required[2]),
      type: headerIndex(headers, required[3]),
      detail: headerIndex(headers, required[4]),
      amount: headerIndex(headers, required[5])
    };

    const deposits = [];
    let invalidRows = 0;
    const maxRows = Number(options.maxRows || 10000);
    const dataRows = matrix.slice(rowIndex + 1, rowIndex + 1 + maxRows);

    dataRows.forEach((row, offset) => {
      if (!Array.isArray(row) || row.every(cell => String(cell ?? "").trim() === "")) return;
      const sourceRow = rowIndex + offset + 2;
      const type = String(valueAt(row, columns.type) ?? "").trim();
      if (normalizeText(type) !== "depositos") return;
      const timestamp = parseDateTime(valueAt(row, columns.date), valueAt(row, columns.time));
      const accountingTimestamp = parseDateTime(valueAt(row, columns.accountingDate));
      const amount = parseAmount(valueAt(row, columns.amount));
      if (!timestamp || amount <= 0) {
        invalidRows += 1;
        return;
      }
      const detail = String(valueAt(row, columns.detail) ?? "").trim();
      const normalizedDetail = normalizeText(detail);
      const inScope = normalizedDetail.includes("caja depositaria");
      const transactionCode = String(valueAt(row, columns.code) ?? "").trim();
      deposits.push({
        sourceKey: transactionCode || `BCI-${sourceRow}`,
        sourceRow,
        dateTime: timestamp.dateTime,
        dateKey: timestamp.dateKey,
        epoch: timestamp.epoch,
        accountingDate: accountingTimestamp?.dateKey || "",
        transactionCode,
        type,
        detail,
        amount,
        inScope,
        excludedReason: inScope ? "" : (normalizedDetail.includes("cheque") ? "Cheque u otro documento" : "Depósito manual por caja")
      });
    });

    if (!deposits.length) throw new Error("La cartola BCI no contiene abonos de tipo DEPOSITOS con fecha e importe válidos.");
    return {
      kind: "bci",
      headerRow: rowIndex + 1,
      sourceRows: dataRows.length,
      deposits: deposits.sort((a, b) => a.epoch - b.epoch),
      inScope: deposits.filter(row => row.inScope),
      excluded: deposits.filter(row => !row.inScope),
      invalidRows
    };
  }

  function sumAmount(rows) {
    return rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  }

  function groupByAmount(rows) {
    const groups = new Map();
    rows.forEach(row => {
      const list = groups.get(row.amount) || [];
      list.push(row);
      groups.set(row.amount, list);
    });
    groups.forEach(list => list.sort((a, b) => a.epoch - b.epoch));
    return groups;
  }

  function chooseBetter(current, candidate) {
    if (!current) return candidate;
    if (candidate.matches !== current.matches) return candidate.matches > current.matches ? candidate : current;
    if (candidate.cost !== current.cost) return candidate.cost < current.cost ? candidate : current;
    return candidate.priority > current.priority ? candidate : current;
  }

  function pairAmountGroup(maeRows, bciRows, windowMs) {
    const m = maeRows.length;
    const n = bciRows.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(null));
    dp[0][0] = { matches: 0, cost: 0, action: "start", priority: 0 };

    for (let i = 0; i <= m; i += 1) {
      for (let j = 0; j <= n; j += 1) {
        if (i === 0 && j === 0) continue;
        let best = null;
        if (i > 0 && dp[i - 1][j]) {
          const prev = dp[i - 1][j];
          best = chooseBetter(best, { matches: prev.matches, cost: prev.cost, action: "skipMae", priority: 0 });
        }
        if (j > 0 && dp[i][j - 1]) {
          const prev = dp[i][j - 1];
          best = chooseBetter(best, { matches: prev.matches, cost: prev.cost, action: "skipBci", priority: 1 });
        }
        if (i > 0 && j > 0 && dp[i - 1][j - 1]) {
          const diff = Math.abs(bciRows[j - 1].epoch - maeRows[i - 1].epoch);
          if (diff <= windowMs) {
            const prev = dp[i - 1][j - 1];
            best = chooseBetter(best, { matches: prev.matches + 1, cost: prev.cost + diff, action: "match", priority: 2 });
          }
        }
        dp[i][j] = best;
      }
    }

    const pairs = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
      const cell = dp[i][j];
      if (!cell) break;
      if (cell.action === "match") {
        pairs.push({ mae: maeRows[i - 1], bci: bciRows[j - 1] });
        i -= 1;
        j -= 1;
      } else if (cell.action === "skipMae") i -= 1;
      else if (cell.action === "skipBci") j -= 1;
      else break;
    }
    return pairs.reverse();
  }

  function reconcile(maeSource, bciSource, options = {}) {
    const windowMinutes = Math.max(1, Number(options.windowMinutes || 180));
    const windowMs = windowMinutes * 60000;
    const maeRows = [...maeSource.deposits].sort((a, b) => a.epoch - b.epoch);
    const bciRows = [...bciSource.inScope].sort((a, b) => a.epoch - b.epoch);
    const excludedBci = [...bciSource.excluded].sort((a, b) => a.epoch - b.epoch);
    const maeGroups = groupByAmount(maeRows);
    const bciGroups = groupByAmount(bciRows);
    const amounts = new Set([...maeGroups.keys(), ...bciGroups.keys()]);
    const rawPairs = [];

    amounts.forEach(amount => {
      rawPairs.push(...pairAmountGroup(maeGroups.get(amount) || [], bciGroups.get(amount) || [], windowMs));
    });

    const usedMae = new Set(rawPairs.map(pair => pair.mae.sourceKey));
    const usedBci = new Set(rawPairs.map(pair => pair.bci.sourceKey));
    const matches = rawPairs.map(pair => {
      const deltaSeconds = Math.round((pair.bci.epoch - pair.mae.epoch) / 1000);
      const absMinutes = Math.abs(deltaSeconds) / 60;
      const crossesDay = pair.mae.dateKey !== pair.bci.dateKey;
      const delayed = absMinutes > 60;
      return {
        sourceKey: `MATCH-${pair.mae.sourceKey}-${pair.bci.sourceRow}`,
        statusKey: delayed ? "demora" : "conciliado",
        statusLabel: delayed ? "Conciliado con demora" : "Conciliado",
        amount: pair.mae.amount,
        mae: pair.mae,
        bci: pair.bci,
        deltaSeconds,
        absMinutes,
        crossesDay,
        delayed
      };
    }).sort((a, b) => b.mae.epoch - a.mae.epoch);

    const unmatchedMae = maeRows.filter(row => !usedMae.has(row.sourceKey));
    const unmatchedBci = bciRows.filter(row => !usedBci.has(row.sourceKey));
    const rows = [
      ...matches,
      ...unmatchedMae.map(mae => ({ statusKey: "pendiente_mae", statusLabel: "MAE sin abono", amount: mae.amount, mae, bci: null, deltaSeconds: null, absMinutes: null, crossesDay: false, delayed: false })),
      ...unmatchedBci.map(bci => ({ statusKey: "pendiente_bci", statusLabel: "BCI sin MAE", amount: bci.amount, mae: null, bci, deltaSeconds: null, absMinutes: null, crossesDay: false, delayed: false })),
      ...excludedBci.map(bci => ({ statusKey: "fuera_alcance", statusLabel: "Fuera de alcance", amount: bci.amount, mae: null, bci, deltaSeconds: null, absMinutes: null, crossesDay: false, delayed: false }))
    ].sort((a, b) => Math.max(b.mae?.epoch || 0, b.bci?.epoch || 0) - Math.max(a.mae?.epoch || 0, a.bci?.epoch || 0));

    const matchedAmount = sumAmount(matches);
    const maeTotal = sumAmount(maeRows);
    const periodEpochs = maeRows.map(row => row.epoch).filter(Number.isFinite);
    const periodStart = periodEpochs.length ? new Date(Math.min(...periodEpochs)).toISOString().slice(0, 10) : "";
    const periodEnd = periodEpochs.length ? new Date(Math.max(...periodEpochs)).toISOString().slice(0, 10) : "";

    return {
      windowMinutes,
      periodStart,
      periodEnd,
      matches,
      unmatchedMae,
      unmatchedBci,
      excludedBci,
      rows,
      summary: {
        maeCount: maeRows.length,
        maeAmount: maeTotal,
        bciScopeCount: bciRows.length,
        bciScopeAmount: sumAmount(bciRows),
        matchedCount: matches.length,
        matchedAmount,
        matchRate: maeRows.length ? matches.length / maeRows.length : 0,
        pendingMaeCount: unmatchedMae.length,
        pendingMaeAmount: sumAmount(unmatchedMae),
        pendingBciCount: unmatchedBci.length,
        pendingBciAmount: sumAmount(unmatchedBci),
        excludedBciCount: excludedBci.length,
        excludedBciAmount: sumAmount(excludedBci),
        delayedCount: matches.filter(row => row.delayed).length,
        crossesDayCount: matches.filter(row => row.crossesDay).length,
        within15MinutesCount: matches.filter(row => row.absMinutes <= 15).length,
        within60MinutesCount: matches.filter(row => row.absMinutes <= 60).length
      }
    };
  }

  return {
    normalizeText,
    normalizeHeader,
    parseAmount,
    parseDateTime,
    parseMaeMatrix,
    parseBciMatrix,
    reconcile,
    sumAmount
  };
});
