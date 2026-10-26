/**
 * Calculadora de Aforos · AURPA
 * Recibe los aforos que envía la calculadora y los guarda en Google Drive:
 *
 *   Aforos AURPA/
 *     Resumen general de aforos – AURPA   (todos los aforos de todos los sitios)
 *     <Método>/                            (Molinete, Volumétrico, Flotador, Vertedero, Parshall)
 *     <Sitio>/
 *       Resumen de aforos – <Sitio>       (una fila por aforo, con enlace)
 *       <Sitio> – 2026-10-26/
 *         Aforo 08h15 · Molinete · 180,51 L/s
 *       <Sitio> – 2026-11-03/
 *         Aforo 09h40 · Molinete · 172,30 L/s
 *
 * Se instala UNA vez desde la cuenta aurparecursohidrico@gmail.com
 * (Implementar → Nueva implementación → Aplicación web).
 */

var CARPETA_RAIZ = 'Aforos AURPA';
var MAX_BYTES = 200000; // tamaño máximo de un aforo recibido

function doPost(e) {
  try {
    var raw = e && e.postData ? e.postData.contents : '';
    if (!raw || raw.length > MAX_BYTES) return responder({ ok: false, error: 'Datos vacíos o demasiado grandes.' });
    var a = JSON.parse(raw);
    var predio = limpiarNombre(a.predio, 80);
    if (!predio) return responder({ ok: false, error: 'Falta el nombre del predio.' });

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var carpeta = carpetaPredio(predio, carpetaMetodo(nombreMetodo(a.metodo)));
      var resumen = hojaResumen(carpeta, predio);

      // Si este aforo ya se había guardado (reintento sin señal), no se duplica.
      var id = limpiar(a.id, 60);
      var previo = buscarPorId(resumen, id);
      if (previo) return responder({ ok: true, repetido: true, carpeta: carpeta.getUrl(), archivo: previo });

      var dia = carpetaFecha(carpeta, a.fecha);
      var archivo = crearHojaAforo(dia, a, predio);
      var fila = [
        limpiar(a.fecha, 20), limpiar(a.hora, 10), limpiar(a.metodo, 40),
        numero(a.q_ls), numero(a.q_m3s), limpiar(a.sitio, 80), limpiar(a.responsable, 80),
        archivo.getUrl(), id, new Date()
      ];
      resumen.appendRow([''].concat(fila));
      numerar(resumen);
      var general = hojaResumenGeneral();
      general.appendRow(['', carpeta.getName()].concat(fila).concat([dia.getUrl()]));
      numerar(general);
      return responder({ ok: true, carpeta: dia.getUrl(), nombre: dia.getName(), archivo: archivo.getUrl() });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return responder({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return responder({ ok: true, servicio: 'Calculadora de Aforos AURPA' });
}

// ---------- carpetas ----------
function carpetaRaiz() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('RAIZ_ID');
  if (id) {
    try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {}
  }
  var it = DriveApp.getRootFolder().getFoldersByName(CARPETA_RAIZ);
  var raiz = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(CARPETA_RAIZ);
  props.setProperty('RAIZ_ID', raiz.getId());
  return raiz;
}

// Una carpeta por método de aforo dentro de "Aforos AURPA".
var METODOS = ['Molinete', 'Volumétrico', 'Flotador', 'Vertedero', 'Parshall'];
function nombreMetodo(m) {
  var t = normalizar(m || '');
  for (var i = 0; i < METODOS.length; i++) if (t.indexOf(normalizar(METODOS[i])) === 0) return METODOS[i];
  return 'Molinete';
}
function buscarOCrear(padre, nombre) {
  var clave = normalizar(nombre);
  var it = padre.getFolders();
  while (it.hasNext()) {
    var f = it.next();
    if (normalizar(f.getName()) === clave) return f;   // "La Esperanza" = "la esperanza "
  }
  return padre.createFolder(nombre);
}
function carpetaMetodo(metodo) { return buscarOCrear(carpetaRaiz(), metodo); }
function carpetaPredio(predio, carpetaDelMetodo) { return buscarOCrear(carpetaDelMetodo, predio); }

// Ejecutar UNA vez desde el editor (▷ Ejecutar → organizarPorMetodo):
// mueve las carpetas de sitio que están sueltas en "Aforos AURPA" a la carpeta de su método.
function organizarPorMetodo() {
  var raiz = carpetaRaiz();
  var metodos = METODOS.map(normalizar);
  var sueltas = [];
  var it = raiz.getFolders();
  while (it.hasNext()) { var f = it.next(); if (metodos.indexOf(normalizar(f.getName())) < 0) sueltas.push(f); }
  sueltas.forEach(function (sitio) {
    var metodo = 'Molinete';
    var res = sitio.getFilesByName('Resumen de aforos – ' + sitio.getName());
    if (res.hasNext()) {
      var sh = SpreadsheetApp.open(res.next()).getSheets()[0];
      var cm = columna(sh, 'Método');
      if (cm && sh.getLastRow() > 1) metodo = nombreMetodo(sh.getRange(2, cm).getValue());
    }
    var destino = carpetaMetodo(metodo);
    var existente = null, it2 = destino.getFolders();
    while (it2.hasNext()) { var g = it2.next(); if (normalizar(g.getName()) === normalizar(sitio.getName())) existente = g; }
    if (!existente) sitio.moveTo(destino);
    else Logger.log('Ya existe ' + metodo + '/' + sitio.getName() + ': revisar a mano.');
  });
  Logger.log('Carpetas movidas: ' + sueltas.length);
}

// Subcarpeta "<Sitio> – <fecha>" dentro de la carpeta del sitio.
function carpetaFecha(carpetaSitio, fecha) {
  var f = limpiarNombre(fecha, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) f = Utilities.formatDate(new Date(), 'America/Bogota', 'yyyy-MM-dd');
  var nombre = carpetaSitio.getName() + ' – ' + f;
  var it = carpetaSitio.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : carpetaSitio.createFolder(nombre);
}

// ---------- resumen por predio ----------
function hojaResumen(carpeta, predio) {
  var nombre = 'Resumen de aforos – ' + carpeta.getName();
  var it = carpeta.getFilesByName(nombre);
  if (it.hasNext()) return conNumero(SpreadsheetApp.open(it.next()).getSheets()[0]);
  var ss = SpreadsheetApp.create(nombre);
  DriveApp.getFileById(ss.getId()).moveTo(carpeta);
  var sh = ss.getSheets()[0];
  sh.setName('Aforos');
  sh.appendRow(['No.', 'Fecha', 'Hora', 'Método', 'Caudal (L/s)', 'Caudal (m³/s)', 'Sitio de medición', 'Responsable', 'Archivo', 'ID', 'Guardado']);
  sh.getRange(1, 1, 1, 11).setFontWeight('bold').setBackground('#e6f3e2');
  sh.setFrozenRows(1);
  sh.hideColumns(10);  // ID interno
  return sh;
}

// Resumen general en "Aforos AURPA": todos los aforos de todos los sitios.
function hojaResumenGeneral() {
  var raiz = carpetaRaiz();
  var nombre = 'Resumen general de aforos – AURPA';
  var it = raiz.getFilesByName(nombre);
  if (it.hasNext()) return conNumero(SpreadsheetApp.open(it.next()).getSheets()[0]);
  var ss = SpreadsheetApp.create(nombre);
  DriveApp.getFileById(ss.getId()).moveTo(raiz);
  var sh = ss.getSheets()[0];
  sh.setName('Aforos');
  sh.appendRow(['No.', 'Sitio', 'Fecha', 'Hora', 'Método', 'Caudal (L/s)', 'Caudal (m³/s)', 'Sitio de medición', 'Responsable', 'Archivo', 'ID', 'Guardado', 'Carpeta']);
  sh.getRange(1, 1, 1, 13).setFontWeight('bold').setBackground('#e6f3e2');
  sh.setFrozenRows(1);
  sh.hideColumns(8);   // repite el sitio
  sh.hideColumns(11);  // ID interno
  return sh;
}

// ---------- columna "No." ----------
// Resúmenes creados antes de existir la columna: se le agrega al inicio.
function conNumero(sh) {
  if (String(sh.getRange(1, 1).getValue()).trim() !== 'No.') {
    sh.insertColumnBefore(1);
    sh.getRange(1, 1).setValue('No.').setFontWeight('bold').setBackground('#e6f3e2');
    sh.setColumnWidth(1, 50);
  }
  return sh;
}

function columna(sh, titulo) {
  var enc = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  for (var i = 0; i < enc.length; i++) if (String(enc[i]).trim() === titulo) return i + 1;
  return 0;
}

// Ordena por fecha y hora (del más antiguo al más reciente) y numera 1, 2, 3…
function numerar(sh) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return;
  var cf = columna(sh, 'Fecha'), ch = columna(sh, 'Hora');
  var orden = [];
  if (cf) orden.push({ column: cf, ascending: true });
  if (ch) orden.push({ column: ch, ascending: true });
  if (orden.length) sh.getRange(2, 1, n, sh.getLastColumn()).sort(orden);
  var nums = [];
  for (var i = 1; i <= n; i++) nums.push([i]);
  sh.getRange(2, 1, n, 1).setValues(nums).setHorizontalAlignment('center');
}

// Ejecutar UNA vez desde el editor (▷ Ejecutar → numerarTodo) para numerar los resúmenes que ya existen.
function numerarTodo() {
  numerar(hojaResumenGeneral());
  var recorrer = function (padre) {
    var it = padre.getFolders();
    while (it.hasNext()) {
      var carpeta = it.next();
      var f = carpeta.getFilesByName('Resumen de aforos – ' + carpeta.getName());
      if (f.hasNext()) numerar(conNumero(SpreadsheetApp.open(f.next()).getSheets()[0]));
      else if (METODOS.map(normalizar).indexOf(normalizar(carpeta.getName())) >= 0) recorrer(carpeta);
    }
  };
  recorrer(carpetaRaiz());
}

function buscarPorId(sh, id) {
  if (!id || sh.getLastRow() < 2) return null;
  var ca = columna(sh, 'Archivo'), ci = columna(sh, 'ID');
  if (!ca || !ci) return null;
  var n = sh.getLastRow() - 1;
  var archivos = sh.getRange(2, ca, n, 1).getValues(), ids = sh.getRange(2, ci, n, 1).getValues();
  for (var i = 0; i < n; i++) if (ids[i][0] === id) return archivos[i][0];
  return null;
}

// ---------- hoja de cada aforo ----------
function crearHojaAforo(carpeta, a, predio) {
  var q = numero(a.q_ls);
  var titulo = 'Aforo ' + limpiarNombre(a.hora, 10).replace('-', 'h') +
    ' · ' + limpiarNombre(a.metodo, 40) + ' · ' + (isFinite(q) ? String(Math.round(q * 100) / 100).replace('.', ',') : '—') + ' L/s';
  var ss = SpreadsheetApp.create(titulo);
  DriveApp.getFileById(ss.getId()).moveTo(carpeta);
  var sh = ss.getSheets()[0];
  sh.setName('Aforo');

  var filas = [['Predio', predio]];
  (a.info || []).forEach(function (p) { if (p && p.length >= 2) filas.push([limpiar(p[0], 80), valor(p[1])]); });
  filas.push(['Caudal Q (L/s)', numero(a.q_ls)]);
  filas.push(['Caudal Q (m³/s)', numero(a.q_m3s)]);
  sh.getRange(1, 1, filas.length, 2).setValues(filas);
  sh.getRange(1, 1, filas.length, 1).setFontWeight('bold');
  var fila = filas.length + 2;

  if (a.tabla && a.tabla.encabezados && a.tabla.filas && a.tabla.filas.length) {
    var enc = a.tabla.encabezados.map(function (h) { return limpiar(h, 60); });
    var cuerpo = a.tabla.filas.map(function (r) {
      var out = [];
      for (var i = 0; i < enc.length; i++) out.push(valor(r[i]));
      return out;
    });
    sh.getRange(fila, 1, 1, enc.length).setValues([enc]).setFontWeight('bold').setBackground('#e6f3e2').setWrap(true);
    sh.getRange(fila + 1, 1, cuerpo.length, enc.length).setValues(cuerpo);
    fila += cuerpo.length + 2;
  }

  if (a.pasos && a.pasos.length) {
    sh.getRange(fila, 1).setValue('Cálculo paso a paso').setFontWeight('bold');
    sh.getRange(fila + 1, 1, a.pasos.length, 1).setValues(a.pasos.map(function (p) { return [limpiar(p, 300)]; }));
  }
  sh.autoResizeColumns(1, 2);
  return DriveApp.getFileById(ss.getId());
}

// ---------- utilidades ----------
function responder(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function limpiar(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || 200);
}
function limpiarNombre(s, max) { // para nombres de carpeta
  return limpiar(s, max).replace(/[\\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ');
}
function normalizar(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}
function numero(v) {
  var n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return isFinite(n) ? n : '';
}
function valor(v) {
  if (typeof v === 'number') return isFinite(v) ? v : '';
  var s = limpiar(v, 200);
  if (/^[-+]?\d+([.,]\d+)?$/.test(s)) return parseFloat(s.replace(',', '.'));
  return s.charAt(0) === '=' ? "'" + s : s; // evita que un texto se tome como fórmula
}
