/**
 * Calculadora de Aforos · AURPA
 * Recibe los aforos que envía la calculadora y los guarda en Google Drive:
 *
 *   Aforos AURPA/
 *     <Método>/                              (Molinete, Volumétrico, Flotador, Vertedero, Parshall)
 *       Resumen de aforos – <Método>         (todos los sitios de ese método; no se mezclan métodos)
 *       <Sitio>/
 *         Resumen de aforos – <Sitio>        (una fila por aforo, con enlace)
 *         <Sitio> – 2026-10-26/
 *           Aforo 08h15 · Molinete · 180,51 L/s
 *         <Sitio> – 2026-11-03/
 *           Aforo 09h40 · Molinete · 172,30 L/s
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
      var carpetaDelMetodo = carpetaMetodo(nombreMetodo(a.metodo));
      var carpeta = carpetaPredio(predio, carpetaDelMetodo);
      var resumen = hojaResumen(carpeta, predio);

      // Si este aforo ya se había guardado (reintento sin señal), no se duplica.
      var id = limpiar(a.id, 60);
      var previo = buscarPorId(resumen, id);
      if (previo) return responder({ ok: true, repetido: true, carpeta: carpeta.getUrl(), archivo: previo });

      var dia = carpetaFecha(carpeta, a.fecha);
      var archivo = crearHojaAforo(dia, a, predio);
      var valores = {
        'Sitio': carpeta.getName(), 'Fecha': limpiar(a.fecha, 20), 'Hora': limpiar(a.hora, 10), 'Método': limpiar(a.metodo, 40),
        'Caudal (L/s)': numero(a.q_ls), 'Caudal (m³/s)': numero(a.q_m3s),
        'Mira inicial (cm)': numero(a.mira_ini != null ? a.mira_ini : dato(a, /mira inicial/i)),
        'Mira final (cm)': numero(a.mira_fin != null ? a.mira_fin : dato(a, /mira final/i)),
        'Sitio de medición': limpiar(a.sitio, 80), 'Responsable': limpiar(a.responsable, 80),
        'Archivo': archivo.getUrl(), 'ID': id, 'Guardado': new Date(), 'Carpeta': dia.getUrl()
      };
      agregarFila(resumen, valores);
      numerar(resumen);
      var delMetodo = hojaResumenMetodo(carpetaDelMetodo);
      agregarFila(delMetodo, valores);
      numerar(delMetodo);
      return responder({ ok: true, carpeta: dia.getUrl(), nombre: dia.getName(), archivo: archivo.getUrl() });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return responder({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet(e) {
  if (e && e.parameter && e.parameter.accion === 'sitios') return responder({ ok: true, sitios: listarSitios() });
  return responder({ ok: true, servicio: 'Calculadora de Aforos AURPA' });
}

// Nombres de las carpetas de sitio (dentro de cada método, o sueltas si aún no se organizaron).
function listarSitios() {
  var raiz = carpetaRaiz();
  var metodos = METODOS.map(normalizar);
  var vistos = {}, lista = [];
  var agregar = function (nombre) { var k = normalizar(nombre); if (!vistos[k]) { vistos[k] = 1; lista.push(nombre); } };
  var it = raiz.getFolders();
  while (it.hasNext()) {
    var f = it.next();
    if (metodos.indexOf(normalizar(f.getName())) >= 0) {
      var it2 = f.getFolders();
      while (it2.hasNext()) agregar(it2.next().getName());
    } else {
      agregar(f.getName());
    }
  }
  return lista.sort(function (a, b) { return a.localeCompare(b, 'es'); });
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
  if (it.hasNext()) return conMira(conNumero(SpreadsheetApp.open(it.next()).getSheets()[0]));
  var ss = SpreadsheetApp.create(nombre);
  DriveApp.getFileById(ss.getId()).moveTo(carpeta);
  var sh = ss.getSheets()[0];
  sh.setName('Aforos');
  var enc = ['No.', 'Fecha', 'Hora', 'Método', 'Caudal (L/s)', 'Caudal (m³/s)', 'Mira inicial (cm)', 'Mira final (cm)', 'Sitio de medición', 'Responsable', 'Archivo', 'ID', 'Guardado'];
  sh.appendRow(enc);
  sh.getRange(1, 1, 1, enc.length).setFontWeight('bold').setBackground('#e6f3e2');
  sh.setFrozenRows(1);
  sh.hideColumns(columna(sh, 'ID'));  // ID interno
  return sh;
}

// Resumen de cada método, dentro de su carpeta: todos los sitios de ESE método, sin mezclar métodos.
function hojaResumenMetodo(carpetaDelMetodo) {
  var nombre = 'Resumen de aforos – ' + carpetaDelMetodo.getName();
  var it = carpetaDelMetodo.getFilesByName(nombre);
  if (it.hasNext()) return conMira(conNumero(SpreadsheetApp.open(it.next()).getSheets()[0]));
  var ss = SpreadsheetApp.create(nombre);
  DriveApp.getFileById(ss.getId()).moveTo(carpetaDelMetodo);
  var sh = ss.getSheets()[0];
  sh.setName('Aforos');
  var enc = ['No.', 'Sitio', 'Fecha', 'Hora', 'Método', 'Caudal (L/s)', 'Caudal (m³/s)', 'Mira inicial (cm)', 'Mira final (cm)', 'Sitio de medición', 'Responsable', 'Archivo', 'ID', 'Guardado', 'Carpeta'];
  sh.appendRow(enc);
  sh.getRange(1, 1, 1, enc.length).setFontWeight('bold').setBackground('#e6f3e2');
  sh.setFrozenRows(1);
  sh.hideColumns(columna(sh, 'Sitio de medición'));  // repite el sitio
  sh.hideColumns(columna(sh, 'ID'));                 // ID interno
  return sh;
}

// ---------- columnas de mira ----------
// Resúmenes creados antes: se agregan "Mira inicial (cm)" y "Mira final (cm)" junto al caudal.
function conMira(sh) {
  if (columna(sh, 'Mira inicial (cm)')) return sh;
  var c = columna(sh, 'Caudal (m³/s)') || columna(sh, 'Caudal (L/s)') || sh.getLastColumn();
  sh.insertColumnsAfter(c, 2);
  sh.getRange(1, c + 1, 1, 2).setValues([['Mira inicial (cm)', 'Mira final (cm)']]).setFontWeight('bold').setBackground('#e6f3e2');
  return sh;
}

// Agrega una fila poniendo cada valor bajo la columna de su mismo nombre.
function agregarFila(sh, valores) {
  var enc = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(enc.map(function (h) { h = String(h).trim(); return Object.prototype.hasOwnProperty.call(valores, h) ? valores[h] : ''; }));
}

// Busca un dato en la lista "info" del aforo (p. ej. "Lectura de mira inicial (cm)").
function dato(a, patron) {
  var info = a.info || [];
  for (var i = 0; i < info.length; i++) if (info[i] && patron.test(String(info[i][0]))) return info[i][1];
  return '';
}

// Ejecutar UNA vez desde el editor (▷ Ejecutar → completarMiras):
// llena las columnas de mira de los resúmenes leyendo la hoja de cada aforo ya guardado.
function completarMiras() {
  var metodos = METODOS.map(normalizar), cache = {}, llenos = 0;
  var leerMiras = function (url) {
    if (cache[url]) return cache[url];
    var r = { ini: '', fin: '' };
    try {
      var vals = SpreadsheetApp.openByUrl(url).getSheets()[0].getRange('A1:B40').getValues();
      vals.forEach(function (f) {
        var k = String(f[0]);
        if (/mira inicial/i.test(k)) r.ini = numero(f[1]);
        if (/mira final/i.test(k)) r.fin = numero(f[1]);
      });
    } catch (e) {}
    return (cache[url] = r);
  };
  var completar = function (sh) {
    conMira(sh);
    var n = sh.getLastRow() - 1; if (n < 1) return;
    var ca = columna(sh, 'Archivo'), ci = columna(sh, 'Mira inicial (cm)'), cf = columna(sh, 'Mira final (cm)');
    var arch = sh.getRange(2, ca, n, 1).getValues(), mi = sh.getRange(2, ci, n, 1).getValues(), mf = sh.getRange(2, cf, n, 1).getValues();
    for (var i = 0; i < n; i++) {
      if (mi[i][0] !== '' || mf[i][0] !== '' || !arch[i][0]) continue;
      var m = leerMiras(String(arch[i][0]));
      mi[i][0] = m.ini; mf[i][0] = m.fin;
      if (m.ini !== '' || m.fin !== '') llenos++;
    }
    sh.getRange(2, ci, n, 1).setValues(mi); sh.getRange(2, cf, n, 1).setValues(mf);
  };
  var it = carpetaRaiz().getFolders();
  while (it.hasNext()) {
    var metodo = it.next();
    if (metodos.indexOf(normalizar(metodo.getName())) < 0) continue;
    completar(hojaResumenMetodo(metodo));
    var sitios = metodo.getFolders();
    while (sitios.hasNext()) {
      var s = sitios.next();
      var f = s.getFilesByName('Resumen de aforos – ' + s.getName());
      if (f.hasNext()) completar(conMira(conNumero(SpreadsheetApp.open(f.next()).getSheets()[0])));
    }
  }
  Logger.log('Filas con mira completada: ' + llenos);
}

// Ejecutar desde el editor (▷ Ejecutar → reconstruirResumenMetodo) si el resumen de un método
// quedó con filas corridas o repetidas: lo vuelve a armar a partir de los resúmenes de cada sitio.
function reconstruirResumenMetodo() {
  var metodos = METODOS.map(normalizar);
  var it = carpetaRaiz().getFolders();
  while (it.hasNext()) {
    var metodo = it.next();
    if (metodos.indexOf(normalizar(metodo.getName())) < 0) continue;
    var destino = hojaResumenMetodo(metodo);
    var encD = destino.getRange(1, 1, 1, destino.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    var filas = [], vistos = {};
    var sitios = metodo.getFolders();
    while (sitios.hasNext()) {
      var s = sitios.next();
      var f = s.getFilesByName('Resumen de aforos – ' + s.getName());
      if (!f.hasNext()) continue;
      var sh = conMira(conNumero(SpreadsheetApp.open(f.next()).getSheets()[0]));
      var n = sh.getLastRow() - 1; if (n < 1) continue;
      var encS = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
      var borrar = [];   // filas del resumen del sitio cuyo aforo se mandó a la papelera
      sh.getRange(2, 1, n, encS.length).getValues().forEach(function (r, i) {
        var id = r[encS.indexOf('ID')];
        var carpeta = '';
        var url = String(r[encS.indexOf('Archivo')] || '');
        var m = url.match(/\/d\/([A-Za-z0-9_-]+)/);
        if (m) {
          try {
            var file = DriveApp.getFileById(m[1]);
            if (file.isTrashed()) { borrar.push(i + 2); return; }
            var p = file.getParents(); if (p.hasNext()) carpeta = p.next().getUrl();
          } catch (e) { borrar.push(i + 2); return; }   // el archivo ya no existe
        }
        if (id && vistos[id]) return;
        if (id) vistos[id] = 1;
        filas.push(encD.map(function (h) {
          if (h === 'Sitio') return s.getName();
          if (h === 'Carpeta') return carpeta;
          var k = encS.indexOf(h); return k >= 0 ? r[k] : '';
        }));
      });
      borrar.reverse().forEach(function (fila) { sh.deleteRow(fila); });
      if (borrar.length) { numerar(sh); Logger.log(s.getName() + ': se quitaron ' + borrar.length + ' aforo(s) borrados'); }
    }
    if (destino.getLastRow() > 1) destino.getRange(2, 1, destino.getLastRow() - 1, destino.getLastColumn()).clearContent();
    if (filas.length) destino.getRange(2, 1, filas.length, encD.length).setValues(filas);
    numerar(destino);
    Logger.log(metodo.getName() + ': ' + filas.length + ' aforos');
  }
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
  // Formato fijo por columna (evita que un número o una hora se vean como fecha).
  var formatos = { 'No.': '0', 'Fecha': 'dd/MM/yyyy', 'Hora': 'HH:mm', 'Caudal (L/s)': '#,##0.0', 'Caudal (m³/s)': '0.0000',
    'Mira inicial (cm)': '0.0', 'Mira final (cm)': '0.0', 'Guardado': 'dd/MM/yyyy HH:mm' };
  Object.keys(formatos).forEach(function (t) { var c = columna(sh, t); if (c) sh.getRange(2, c, n, 1).setNumberFormat(formatos[t]); });
}

// Ejecutar UNA vez desde el editor (▷ Ejecutar → numerarTodo) para numerar los resúmenes que ya existen.
function numerarTodo() {
  var metodos = METODOS.map(normalizar);
  var recorrer = function (padre) {
    var it = padre.getFolders();
    while (it.hasNext()) {
      var carpeta = it.next();
      var f = carpeta.getFilesByName('Resumen de aforos – ' + carpeta.getName());
      if (f.hasNext()) numerar(conNumero(SpreadsheetApp.open(f.next()).getSheets()[0]));
      if (metodos.indexOf(normalizar(carpeta.getName())) >= 0) recorrer(carpeta);
    }
  };
  recorrer(carpetaRaiz());
}

// Ejecutar UNA vez desde el editor (▷ Ejecutar → separarResumenPorMetodo):
// reparte el antiguo "Resumen general de aforos – AURPA" en un resumen por método
// y lo saca de la carpeta principal. Las filas se copian; el archivo viejo se deja
// renombrado como "(antiguo)" para que lo borres tú cuando confirmes que todo está bien.
function separarResumenPorMetodo() {
  var raiz = carpetaRaiz();
  var it = raiz.getFilesByName('Resumen general de aforos – AURPA');
  if (!it.hasNext()) { Logger.log('No hay resumen general.'); return; }
  var archivo = it.next();
  var sh = conNumero(SpreadsheetApp.open(archivo).getSheets()[0]);
  var n = sh.getLastRow() - 1;
  if (n > 0) {
    var datos = sh.getRange(2, 1, n, sh.getLastColumn()).getValues();
    var cm = columna(sh, 'Método');
    var porMetodo = {};
    datos.forEach(function (fila) {
      var m = nombreMetodo(cm ? fila[cm - 1] : '');
      (porMetodo[m] = porMetodo[m] || []).push(fila);
    });
    var encOrigen = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    var idCol = columna(sh, 'ID');
    Object.keys(porMetodo).forEach(function (m) {
      var destino = hojaResumenMetodo(carpetaMetodo(m));
      var ya = {}, ci = columna(destino, 'ID');
      if (ci && destino.getLastRow() > 1) destino.getRange(2, ci, destino.getLastRow() - 1, 1).getValues().forEach(function (r) { ya[r[0]] = 1; });
      var nuevas = porMetodo[m].filter(function (f) { return !idCol || !ya[f[idCol - 1]]; });
      // Copia columna por nombre (el destino puede tener columnas nuevas, como la mira).
      var encDestino = destino.getRange(1, 1, 1, destino.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
      var filas = nuevas.map(function (f) {
        return encDestino.map(function (h) { var k = encOrigen.indexOf(h); return k >= 0 ? f[k] : ''; });
      });
      if (filas.length) destino.getRange(destino.getLastRow() + 1, 1, filas.length, encDestino.length).setValues(filas);
      numerar(destino);
      Logger.log(m + ': ' + filas.length + ' filas');
    });
  }
  archivo.setName('Resumen general de aforos – AURPA (antiguo)');
  Logger.log('Listo. El resumen general quedó como "(antiguo)".');
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
