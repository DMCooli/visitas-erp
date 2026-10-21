/**
 * Script de importación desde Google Sheets a PostgreSQL (visitas-erp)
 * Ejecutar con: docker compose exec app node import_sheet.js
 * O directamente en local si hay conexión a la base de datos.
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const SHEET_ID = process.env.SHEET_ID || '';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://visitas:password@localhost:5432/visitas';

const pool = new Pool({ connectionString: DATABASE_URL });
const q = (s, p) => pool.query(s, p);

// Normalización de instituciones
const NORM_INST = {
  'clinica privada': 'Clínica Privada',
  'clinica popular': 'Clínica Popular',
  'hospital publico': 'Hospital Público',
  'hospital militar': 'Hospital Militar',
  'centro asistencial privado': 'Centro Asistencial Privado',
  'farmacia': 'Farmacia',
  'drogueria': 'Droguería',
  'ambulatorio': 'Ambulatorio',
  'particular': 'Particular',
  'centro comercial': 'Centro Comercial',
  'espacio abierto': 'Espacio Abierto',
  'evento': 'Evento'
};

function normalizeInst(v) {
  if (!v) return null;
  const k = v.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return NORM_INST[k] || v.trim();
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let inQuotes = false;
  let current = '';
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      row.push(current);
      if (row.some(c => c.trim())) rows.push(row);
      row = [];
      current = '';
    } else {
      current += char;
    }
  }
  if (current || row.length > 0) {
    row.push(current);
    if (row.some(c => c.trim())) rows.push(row);
  }
  return rows;
}

async function fetchSheetCSV(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Google Sheets rechazó el acceso (Error ${resp.status}). Asegúrate de que la hoja esté compartida como "Cualquier persona con el enlace" con rol "Lector".`);
    }
    throw new Error(`Error ${resp.status} al descargar pestaña "${sheetName}"`);
  }
  const text = await resp.text();
  const parsed = parseCSV(text);
  if (!parsed.length) return [];
  const headers = parsed[0].map(h => h.trim());
  return parsed.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (r[idx] || '').trim();
    });
    return obj;
  });
}

function parseDate(s) {
  if (!s || !s.trim()) return null;
  s = s.trim();
  // Formatos DD/MM/YYYY o YYYY-MM-DD
  const m1 = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m1) {
    const [, d, m, y, h, min, sec] = m1;
    const dt = new Date(+y, +m - 1, +d, +(h || 0), +(min || 0), +(sec || 0));
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt.toISOString();
}

function parseDateOnly(s) {
  if (!s || !s.trim()) return null;
  const dt = parseDate(s);
  return dt ? dt.slice(0, 10) : null;
}

async function run() {
  console.log('Iniciando importación desde Google Sheets...');
  
  // 1. Obtener usuarios para mapear el visitador
  const users = (await q('SELECT id, email, nombre FROM users')).rows;
  console.log(`Usuarios registrados en el sistema: ${users.length}`);
  
  // Buscar a Hector Giron por defecto si la hoja no especifica visitador
  const hector = users.find(u => u.email.includes('gammanutricionista')) || users.find(u => u.rol === 'visitador') || users[0];

  // 2. Descargar "Visitas Medicas"
  console.log('Descargando pestaña "Visitas Medicas"...');
  let rows;
  try {
    rows = await fetchSheetCSV('Visitas Medicas');
  } catch (err) {
    // Si falla descarga remota, verificar si existe un archivo local visitas.csv
    const localCsv = path.join(__dirname, 'visitas.csv');
    if (fs.existsSync(localCsv)) {
      console.log('Usando archivo local visitas.csv...');
      const text = fs.readFileSync(localCsv, 'utf-8');
      const parsed = parseCSV(text);
      const headers = parsed[0].map(h => h.trim());
      rows = parsed.slice(1).map(r => {
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = (r[idx] || '').trim(); });
        return obj;
      });
    } else {
      throw err;
    }
  }

  console.log(`Se encontraron ${rows.length} registros en la hoja.`);
  if (!rows.length) {
    console.log('No hay registros para importar.');
    return;
  }

  // Columnas esperadas en la tabla visits
  const F = ['tipo_visita', 'lugar_visita', 'estado', 'ciudad', 'zona', 'razon_social', 'cliente', 'fecha_nacimiento', 'nro_colegiado',
    'especialidad', 'operaciones_mensuales', 'encargado', 'responsable', 'contacto', 'mas_info_contacto', 'correo', 'horario_trabajo',
    'otra_institucion', 'horario_otra_institucion', 'muestras_entregadas', 'instagram', 'facebook', 'otras_redes', 'secretaria_nombre',
    'secretaria_fecha_nacimiento', 'secretaria_telefono', 'direccion', 'secretaria_facebook', 'secretaria_instagram',
    'secretaria_otras_redes', 'pacientes_diarios', 'costo_consultas', 'usaria_producto', 'prescribe_suplementos',
    'prescribira_suplementos', 'comprometido', 'observaciones', 'ubicacion'];

  let count = 0;
  for (const r of rows) {
    const razon_social = r['Razón Social'] || r['Razon Social'] || r['razon_social'] || r['Cliente'] || '';
    if (!razon_social) continue;

    const lugar_visita = normalizeInst(r['Lugar de Visita'] || r['lugar_visita'] || 'Particular');
    const fechaHora = parseDate(r['Fecha y Hora'] || r['Fecha'] || r['Timestamp']) || new Date().toISOString();
    
    // Mapear visitador si viene en la columna
    const emailVisitador = (r['Email'] || r['Correo'] || r['Visitador'] || '').trim().toLowerCase();
    const vis = users.find(u => u.email === emailVisitador) || hector;

    const body = {
      tipo_visita: (r['Tipo de Visita'] || '').toLowerCase().includes('recurrente') ? 'recurrente' : 'primera',
      lugar_visita,
      estado: r['Estado'] || null,
      ciudad: r['Ciudad'] || null,
      zona: r['Zona'] || null,
      razon_social,
      cliente: r['Cliente'] || null,
      fecha_nacimiento: parseDateOnly(r['Fecha de Nacimiento']),
      nro_colegiado: r['Nro. de Colegiado'] || null,
      especialidad: r['Especialidad del Medico'] || r['Especialidad'] || null,
      operaciones_mensuales: r['Operaciones Mensuales'] || null,
      encargado: r['Encargado'] || null,
      responsable: r['Responsable'] || null,
      contacto: r['Contacto'] || null,
      mas_info_contacto: r['Más Información de Contacto'] || r['Mas Informacion de Contacto'] || null,
      correo: r['Correo Electronico'] || r['Correo Electrónico'] || null,
      horario_trabajo: r['Horario de Trabajo'] || null,
      otra_institucion: r['Otra Institución Donde Labora'] || null,
      horario_otra_institucion: r['Horario Otra Institución'] || null,
      muestras_entregadas: r['Muestras Médicas Entregadas'] || r['Muestras Medicas Entregadas'] || null,
      instagram: r['Instagram'] || null,
      facebook: r['Facebook'] || null,
      otras_redes: r['Otras Redes Sociales'] || null,
      secretaria_nombre: r['Nombre de Secretaria'] || null,
      secretaria_fecha_nacimiento: parseDateOnly(r['Fecha de Nacimiento Secretaria']),
      secretaria_telefono: r['Nro. de Teléfono Secretaria'] || null,
      direccion: r['Dirección'] || r['Direccion'] || null,
      secretaria_facebook: r['Facebook Secretaria'] || null,
      secretaria_instagram: r['Instagram Secretaria'] || null,
      secretaria_otras_redes: r['Otras Redes Sociales Secretaria'] || null,
      pacientes_diarios: r['Pacientes Diarios'] || null,
      costo_consultas: r['Costo de Consultas'] || null,
      usaria_producto: r['Usaría el Producto'] || r['Usaria el Producto'] || null,
      prescribe_suplementos: r['Prescribe Suplementos'] || null,
      prescribira_suplementos: r['Prescribirá Suplementos'] || r['Prescribira Suplementos'] || null,
      comprometido: r['Comprometido'] || null,
      observaciones: r['Observaciones o Sugerencias'] || null,
      ubicacion: r['Ubicacion'] || r['Ubicación'] || null
    };

    const vals = F.map(f => body[f]);
    const cols = ['visitador_id', 'fecha_hora', ...F, 'foto', 'firma'];
    const params = [vis.id, fechaHora, ...vals, r['Foto'] || null, r['Firma'] || null];

    await q(`INSERT INTO visits(${cols.join(',')}) VALUES(${cols.map((_, i) => '$' + (i + 1)).join(',')})`, params);
    count++;
    if (count % 100 === 0) console.log(`  Importadas ${count} visitas...`);
  }

  console.log(`\n¡Importación completada con éxito! Total de visitas insertadas: ${count}`);
}

run()
  .then(() => pool.end())
  .catch(err => {
    console.error('\nError en importación:', err.message);
    pool.end();
    process.exit(1);
  });
