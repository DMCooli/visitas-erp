const express = require('express'), pg = require('pg'), jwt = require('jsonwebtoken'), cookieParser = require('cookie-parser');
const fs = require('fs'), path = require('path'), crypto = require('crypto'), https = require('https'), http = require('http');

pg.types.setTypeParser(1082, v => v); // DATE como texto YYYY-MM-DD
const {
  DATABASE_URL, JWT_SECRET,
  FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID, FIREBASE_APP_ID,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
} = process.env;
const INITIAL_MASTER_EMAIL = (process.env.INITIAL_MASTER_EMAIL || process.env.MASTER_EMAIL || '').trim().toLowerCase();
const TZ = /^[\w\/+-]+$/.test(process.env.APP_TZ || '') ? process.env.APP_TZ : 'America/Caracas';
if (!JWT_SECRET) {
  console.error('Falta JWT_SECRET en las variables de entorno');
  process.exit(1);
}
if (!INITIAL_MASTER_EMAIL) {
  console.warn('Aviso: INITIAL_MASTER_EMAIL no está configurado en .env. Se recomienda definirlo para crear el usuario master inicial.');
}
if (!FIREBASE_API_KEY || !FIREBASE_PROJECT_ID) {
  console.warn('Aviso: faltan FIREBASE_API_KEY o FIREBASE_PROJECT_ID en .env');
}

const UPLOADS = '/data/uploads';
fs.mkdirSync(UPLOADS, { recursive: true });
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const q = (s, p) => pool.query(s, p);

// Campos del registro de visitas (mismos de la hoja "Visitas Medicas")
const F = ['tipo_visita', 'cedula', 'lugar_visita', 'estado', 'ciudad', 'zona', 'razon_social', 'cliente', 'fecha_nacimiento', 'nro_colegiado',
  'especialidad', 'operaciones_mensuales', 'encargado', 'responsable', 'contacto', 'mas_info_contacto', 'correo', 'horario_trabajo',
  'otra_institucion', 'horario_otra_institucion', 'muestras_entregadas', 'muestras_detalle', 'instagram', 'facebook', 'otras_redes', 'redes_sociales', 'secretaria_nombre',
  'secretaria_fecha_nacimiento', 'secretaria_telefono', 'direccion', 'secretaria_facebook', 'secretaria_instagram',
  'secretaria_otras_redes', 'pacientes_diarios', 'costo_consultas', 'usaria_producto', 'prescribe_suplementos',
  'prescribira_suplementos', 'comprometido', 'observaciones', 'ubicacion', 'productos_entregados', 'productos_detalle'];

const PRODUCTOS_INICIALES = ['Producto A', 'Producto B', 'Producto C'];
const INSTITUCIONES = ['Farmacia', 'Droguería', 'Hospital Público', 'Hospital Militar', 'Clínica Privada', 'Clínica Popular',
  'Centro Asistencial Privado', 'Ambulatorio', 'Particular', 'Centro Comercial', 'Espacio Abierto', 'Evento'];
const ESPECIALIDADES = ['Pediatría', 'Nutrición', 'Nefrología', 'Oncología', 'Medicina Interna', 'Gastroenterología', 'Cirugía General',
  'Cirugía Oncológica', 'Cirugía Pediátrica', 'Anestesiología', 'Coloproctología', 'Ginecología y Obstetricia', 'Hematología',
  'Endocrinología', 'Diabetología', 'Cardiología', 'Neurología', 'Neumonología', 'Urología', 'Traumatología', 'Geriatría',
  'Medicina General', 'Neonatología', 'Terapia Intensiva', 'Radiología', 'Fisiatría', 'Farmacia', 'Reumatología', 'Infectología', 'Residente'];

async function initDb() {
  for (let i = 0; i < 20; i++) { try { await q('SELECT 1'); break; } catch (e) { if (i === 19) throw e; await new Promise(r => setTimeout(r, 2000)); } }
  await q(`CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, nombre TEXT,
    rol TEXT NOT NULL CHECK (rol IN ('master','administrador','visitador')), activo BOOLEAN NOT NULL DEFAULT true,
    creado TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS catalogs(id SERIAL PRIMARY KEY, tipo TEXT NOT NULL, nombre TEXT NOT NULL, UNIQUE(tipo, nombre))`);
  const cols = F.map(f => `${f} ${f.includes('fecha') ? 'DATE' : 'TEXT'}`).join(',');
  await q(`CREATE TABLE IF NOT EXISTS visits(id SERIAL PRIMARY KEY, fecha_hora TIMESTAMPTZ NOT NULL DEFAULT now(),
    visitador_id INT NOT NULL REFERENCES users(id), ${cols}, foto TEXT, firma TEXT)`);
  await q('CREATE INDEX IF NOT EXISTS visits_fecha ON visits(fecha_hora)');
  await q('CREATE INDEX IF NOT EXISTS visits_vis ON visits(visitador_id)');

  // Verificación y provisión de usuario master inicial si no existe ninguno
  const masterCheck = await q("SELECT id, email FROM users WHERE rol='master' LIMIT 1");
  if (!masterCheck.rowCount && INITIAL_MASTER_EMAIL) {
    await q(`INSERT INTO users(email, nombre, rol, activo, can_view_logs)
             VALUES($1, 'Master Inicial', 'master', true, true)
             ON CONFLICT(email) DO UPDATE SET rol='master', activo=true, can_view_logs=true`, [INITIAL_MASTER_EMAIL]);
    console.log(`Usuario master inicial configurado: ${INITIAL_MASTER_EMAIL}`);
  }
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS can_view_logs BOOLEAN NOT NULL DEFAULT false');
  await q(`CREATE TABLE IF NOT EXISTS activity_logs(
    id SERIAL PRIMARY KEY,
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id INT REFERENCES users(id) ON DELETE SET NULL,
    user_nombre TEXT,
    user_email TEXT,
    accion TEXT NOT NULL,
    modulo TEXT,
    detalle TEXT,
    ip TEXT
  )`);
  await q('CREATE INDEX IF NOT EXISTS logs_fecha ON activity_logs(fecha_hora DESC)');
  await q('CREATE INDEX IF NOT EXISTS logs_user ON activity_logs(user_id)');
  await q('ALTER TABLE visits ADD COLUMN IF NOT EXISTS muestras_detalle TEXT');
  await q('ALTER TABLE visits ADD COLUMN IF NOT EXISTS cedula TEXT');
  await q('CREATE INDEX IF NOT EXISTS visits_cedula ON visits(lower(cedula))');
  await q('ALTER TABLE visits ADD COLUMN IF NOT EXISTS client_uuid TEXT');
  await q('CREATE UNIQUE INDEX IF NOT EXISTS visits_client_uuid ON visits(client_uuid) WHERE client_uuid IS NOT NULL');
  await q('ALTER TABLE visits ADD COLUMN IF NOT EXISTS fecha_offline TIMESTAMPTZ');
  await q('ALTER TABLE visits ADD COLUMN IF NOT EXISTS productos_entregados TEXT');
  await q('ALTER TABLE visits ADD COLUMN IF NOT EXISTS productos_detalle TEXT');
  await q('ALTER TABLE visits ADD COLUMN IF NOT EXISTS redes_sociales TEXT');

  if (!(await q('SELECT 1 FROM catalogs LIMIT 1')).rowCount) {
    for (const n of INSTITUCIONES) await q("INSERT INTO catalogs(tipo,nombre) VALUES('institucion',$1)", [n]);
    for (const n of ESPECIALIDADES) await q("INSERT INTO catalogs(tipo,nombre) VALUES('especialidad',$1)", [n]);
  }
  await q('ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS codigo TEXT');
  await q("UPDATE catalogs SET tipo='muestra' WHERE tipo='producto' AND codigo IS NULL");
  if (!(await q("SELECT 1 FROM catalogs WHERE tipo='muestra' LIMIT 1")).rowCount) {
    for (const n of PRODUCTOS_INICIALES) await q("INSERT INTO catalogs(tipo,nombre) VALUES('muestra',$1) ON CONFLICT DO NOTHING", [n]);
  }
  await q(`CREATE TABLE IF NOT EXISTS geography(id SERIAL PRIMARY KEY, estado TEXT NOT NULL, ciudad TEXT NOT NULL, UNIQUE(estado, ciudad))`);
  await q(`CREATE TABLE IF NOT EXISTS documentation(id SERIAL PRIMARY KEY, titulo TEXT NOT NULL, url TEXT NOT NULL, fecha DATE, descripcion TEXT)`);

  // Módulo Agendar
  await q(`CREATE TABLE IF NOT EXISTS events(
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    titulo TEXT NOT NULL,
    descripcion TEXT,
    ubicacion TEXT,
    inicio TIMESTAMPTZ NOT NULL,
    fin TIMESTAMPTZ NOT NULL,
    todo_el_dia BOOLEAN NOT NULL DEFAULT false,
    medico_ref TEXT,
    recordatorio_min INT NOT NULL DEFAULT 60,
    notif_enviada BOOLEAN NOT NULL DEFAULT false,
    categoria TEXT DEFAULT 'visita',
    color TEXT DEFAULT '#0f9d8a',
    alert_dismissed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  await q('CREATE INDEX IF NOT EXISTS events_user ON events(user_id)');
  await q('CREATE INDEX IF NOT EXISTS events_inicio ON events(inicio)');
  await q('ALTER TABLE events ADD COLUMN IF NOT EXISTS recordatorio_min INT NOT NULL DEFAULT 60');
  await q('ALTER TABLE events ADD COLUMN IF NOT EXISTS notif_enviada BOOLEAN NOT NULL DEFAULT false');
  await q("ALTER TABLE events ADD COLUMN IF NOT EXISTS categoria TEXT DEFAULT 'visita'");
  await q("ALTER TABLE events ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#0f9d8a'");
  await q('ALTER TABLE events ADD COLUMN IF NOT EXISTS alert_dismissed BOOLEAN NOT NULL DEFAULT false');
  // Web Push subscriptions
  await q(`CREATE TABLE IF NOT EXISTS push_subscriptions(
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, endpoint)
  )`);

  // Dispositivos vinculados para acceso offline y trazabilidad
  await q(`CREATE TABLE IF NOT EXISTS user_devices(
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    device_name TEXT,
    is_trusted BOOLEAN NOT NULL DEFAULT true,
    has_biometrics BOOLEAN NOT NULL DEFAULT false,
    has_pin BOOLEAN NOT NULL DEFAULT false,
    last_sync TIMESTAMPTZ DEFAULT now(),
    activo BOOLEAN NOT NULL DEFAULT true,
    creado TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, device_id)
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_user_devices_uid ON user_devices(user_id)');
  await q('CREATE INDEX IF NOT EXISTS idx_user_devices_did ON user_devices(device_id)');

  // ---------- Pedidos ----------
  await q(`CREATE TABLE IF NOT EXISTS orders(
    id SERIAL PRIMARY KEY,
    visitador_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    medico TEXT NOT NULL,
    fecha_solicitud DATE NOT NULL DEFAULT CURRENT_DATE,
    fecha_entrega DATE,
    status TEXT NOT NULL DEFAULT 'enviado'
      CHECK (status IN ('enviado','revision','aprobado','listo','rechazado')),
    notas TEXT,
    admin_notas TEXT,
    tomado_por INT REFERENCES users(id),
    pending_edit BOOLEAN NOT NULL DEFAULT false,
    creado TIMESTAMPTZ DEFAULT now(),
    actualizado TIMESTAMPTZ DEFAULT now()
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_orders_vis ON orders(visitador_id)');
  await q('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');

  await q(`CREATE TABLE IF NOT EXISTS order_items(
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    catalogo_id INT REFERENCES catalogs(id) ON DELETE SET NULL,
    nombre TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('muestra','producto')),
    cantidad_solicitada INT NOT NULL DEFAULT 1,
    cantidad_aprobada INT,
    rechazado BOOLEAN NOT NULL DEFAULT false,
    razon_rechazo TEXT
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_order_items_oid ON order_items(order_id)');

  // ---------- Asignaciones e Inventario ----------
  await q(`CREATE TABLE IF NOT EXISTS inventory_movements(
    id SERIAL PRIMARY KEY,
    visitador_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK (tipo IN ('muestra','producto')),
    catalogo_id INT REFERENCES catalogs(id) ON DELETE SET NULL,
    nombre TEXT NOT NULL,
    cantidad INT NOT NULL,
    origen TEXT NOT NULL CHECK (origen IN ('pedido','visita','ajuste')),
    referencia_id INT,
    medico TEXT,
    notas TEXT,
    fecha TIMESTAMPTZ DEFAULT now()
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_inv_vis ON inventory_movements(visitador_id)');
  await q('CREATE INDEX IF NOT EXISTS idx_inv_fecha ON inventory_movements(fecha)');
  await q('CREATE INDEX IF NOT EXISTS idx_inv_ref ON inventory_movements(origen, referencia_id)');

  if (!(await q('SELECT 1 FROM geography LIMIT 1')).rowCount) {
    try {
      const geoPath = path.join(__dirname, 'geografia.json');
      if (fs.existsSync(geoPath)) {
        const geoData = JSON.parse(fs.readFileSync(geoPath, 'utf8'));
        for (const [estado, ciudades] of Object.entries(geoData)) {
          for (const ciudad of ciudades) {
            await q('INSERT INTO geography(estado, ciudad) VALUES($1, $2) ON CONFLICT DO NOTHING', [estado, ciudad]);
          }
        }
        console.log('Catálogo de Geografía inicializado.');
      }
    } catch (e) { console.error('Error cargando geografia:', e); }
  }

  if (!(await q('SELECT 1 FROM documentation LIMIT 1')).rowCount) {
    const DOCS_INICIALES = [
      ['Ficha Técnica - Ejemplo', 'https://example.com/ficha-tecnica.pdf', '2026-01-01', 'Documento de ejemplo de literatura técnica médica'],
      ['Díptico Promocional - Ejemplo', 'https://example.com/diptico.pdf', '2026-01-01', 'Material promocional y dosificación médica de ejemplo']
    ];
    for (const [t, u, f, d] of DOCS_INICIALES) {
      await q('INSERT INTO documentation(titulo, url, fecha, descripcion) VALUES($1, $2, $3, $4)', [t, u, f, d]);
    }
    console.log('Catálogo de Documentación/Literatura inicializado.');
  }
}

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());
const wrap = f => (req, res, next) => f(req, res, next).catch(e => { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); });
const isAdm = u => u && (u.rol === 'master' || u.rol === 'administrador');
const canLogs = u => u && (u.rol === 'master' || (u.rol === 'administrador' && !!u.can_view_logs));
const admin = (req, res, next) => isAdm(req.user) ? next() : res.status(403).json({ error: 'Sin permisos' });
const requireLogs = (req, res, next) => canLogs(req.user) ? next() : res.status(403).json({ error: 'Sin permisos para ver logs' });

async function logActivity(req, accion, modulo, detalle) {
  try {
    const u = req && req.user;
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() : null;
    const userId = u ? u.id : null;
    const userNombre = u ? (u.nombre || u.email) : null;
    const userEmail = u ? u.email : null;
    await q('INSERT INTO activity_logs(user_id, user_nombre, user_email, accion, modulo, detalle, ip) VALUES($1, $2, $3, $4, $5, $6, $7)',
      [userId, userNombre, userEmail, accion, modulo, detalle, ip]);
  } catch (err) {
    console.error('Error logging activity:', err);
  }
}

async function auth(req, res, next) {
  let u;
  try {
    const { email } = jwt.verify(req.cookies.sid || '', JWT_SECRET);
    u = (await q('SELECT * FROM users WHERE email=$1 AND activo', [email])).rows[0];
  } catch (e) { /* sin sesión */ }
  if (!u) return res.status(401).json({ error: 'No autenticado' });

  // Validación de dispositivo si se envía x-device-id
  const did = req.headers['x-device-id'];
  if (did) {
    try {
      const dev = (await q('SELECT activo FROM user_devices WHERE user_id=$1 AND device_id=$2', [u.id, did])).rows[0];
      if (dev && !dev.activo) {
        return res.status(403).json({ error: 'Este dispositivo ha sido revocado o desvinculado por un administrador.', code: 'DEVICE_REVOKED' });
      }
      if (dev) {
        q('UPDATE user_devices SET last_sync=now() WHERE user_id=$1 AND device_id=$2', [u.id, did]).catch(() => {});
      }
    } catch (e) {}
  }

  req.user = u; next();
}

// ---------- Auth & Ping ----------
app.get('/api/ping', (req, res) => res.json({ ok: true, now: Date.now() }));
app.get('/api/config', (req, res) => res.json({
  firebaseConfig: {
    apiKey: FIREBASE_API_KEY || '',
    authDomain: FIREBASE_AUTH_DOMAIN || '',
    projectId: FIREBASE_PROJECT_ID || '',
    appId: FIREBASE_APP_ID || ''
  }
}));

app.post('/api/auth/firebase', wrap(async (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'Token faltante' });
  if (!FIREBASE_API_KEY) return res.status(500).json({ error: 'Falta configurar FIREBASE_API_KEY en .env' });

  let p;
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });
    const d = await r.json();
    if (!r.ok || !d.users || !d.users[0]) {
      return res.status(401).json({ error: 'Token de Google/Firebase inválido o expirado' });
    }
    p = d.users[0];
  } catch (err) {
    console.error('Error validando token con Firebase:', err);
    return res.status(500).json({ error: 'Error al verificar credenciales con Firebase' });
  }

  if (!p.email || !p.emailVerified) return res.status(401).json({ error: 'Correo de Google no verificado' });
  const email = p.email.toLowerCase();
  let u = (await q('SELECT * FROM users WHERE email=$1 AND activo', [email])).rows[0];

  // Si no existe pero coincide con INITIAL_MASTER_EMAIL, conceder acceso master automáticamente
  if (!u && INITIAL_MASTER_EMAIL && email === INITIAL_MASTER_EMAIL) {
    const r = await q(`INSERT INTO users(email, nombre, rol, activo, can_view_logs)
                       VALUES($1, $2, 'master', true, true)
                       ON CONFLICT(email) DO UPDATE SET rol='master', activo=true, can_view_logs=true
                       RETURNING *`, [email, p.displayName || 'Master']);
    u = r.rows[0];
    console.log(`Acceso master concedido automáticamente al usuario inicial: ${email}`);
  }

  if (!u) return res.status(403).json({ error: `El correo "${email}" no está autorizado. Solicita acceso a un administrador.` });
  if (!u.nombre && p.displayName) await q('UPDATE users SET nombre=$1 WHERE id=$2', [p.displayName, u.id]);
  res.cookie('sid', jwt.sign({ email }, JWT_SECRET, { expiresIn: '30d' }),
    { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 30 * 24 * 3600e3 });
  req.user = u;
  await logActivity(req, 'LOGIN', 'Autenticación', `Inicio de sesión exitoso de ${u.nombre || email} (${email})`);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  try {
    const { email } = jwt.verify(req.cookies.sid || '', JWT_SECRET);
    const u = (await q('SELECT * FROM users WHERE email=$1', [email])).rows[0];
    if (u) {
      req.user = u;
      await logActivity(req, 'LOGOUT', 'Autenticación', `Cierre de sesión de ${u.nombre || email} (${email})`);
    }
  } catch (e) {}
  res.clearCookie('sid');
  res.json({ ok: true });
}));

app.get('/api/me', auth, (req, res) => {
  const { id, email, nombre, rol, can_view_logs } = req.user;
  res.json({ id, email, nombre: nombre || email, rol, admin: isAdm(req.user), can_view_logs: canLogs(req.user) });
});

// ---------- Logs del Sistema ----------
app.post('/api/logs/track', auth, wrap(async (req, res) => {
  const { modulo, detalle } = req.body || {};
  if (modulo) {
    await logActivity(req, 'NAVEGACION', modulo, detalle || `Ingresó al módulo ${modulo}`);
  }
  res.json({ ok: true });
}));

app.get('/api/logs', auth, requireLogs, wrap(async (req, res) => {
  const qs = req.query;
  const w = [], p = [];
  const add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };

  if (/^\d{4}-\d{2}-\d{2}$/.test(qs.desde || '')) add("(l.fecha_hora AT TIME ZONE '" + TZ + "')::date >= ?", qs.desde);
  if (/^\d{4}-\d{2}-\d{2}$/.test(qs.hasta || '')) add("(l.fecha_hora AT TIME ZONE '" + TZ + "')::date <= ?", qs.hasta);
  if (qs.user_id) add('l.user_id = ?', +qs.user_id);
  if (qs.accion) add('l.accion = ?', qs.accion);
  if (qs.texto) add('(l.detalle ILIKE ? OR l.user_nombre ILIKE ? OR l.user_email ILIKE ? OR l.modulo ILIKE ?)', '%' + qs.texto + '%');

  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const total = +(await q(`SELECT count(*) FROM activity_logs l ${where}`, p)).rows[0].count;

  const limit = Math.min(+qs.limit || 50, 200), offset = +qs.offset || 0;
  const rows = (await q(`SELECT l.* FROM activity_logs l ${where} ORDER BY l.fecha_hora DESC LIMIT ${limit} OFFSET ${offset}`, p)).rows;

  res.json({ rows, total });
}));

// ---------- Catálogos ----------
app.get('/api/catalogs', auth, wrap(async (req, res) => {
  const r = (await q('SELECT id,tipo,nombre,codigo FROM catalogs ORDER BY codigo NULLS LAST, nombre')).rows;
  res.json({
    institucion: r.filter(x => x.tipo === 'institucion'),
    especialidad: r.filter(x => x.tipo === 'especialidad'),
    muestra: r.filter(x => x.tipo === 'muestra'),
    producto: r.filter(x => x.tipo === 'producto')
  });
}));
app.post('/api/catalogs', auth, admin, wrap(async (req, res) => {
  const { tipo, nombre, codigo } = req.body;
  const n = (nombre || '').trim();
  const cod = (codigo || '').trim() || null;
  if (!['institucion', 'especialidad', 'muestra', 'producto'].includes(tipo) || !n) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }
  if (cod) {
    const exist = (await q('SELECT id FROM catalogs WHERE tipo=$1 AND (lower(nombre)=lower($2) OR (codigo IS NOT NULL AND lower(codigo)=lower($3)))', [tipo, n, cod])).rows[0];
    if (exist) {
      await q('UPDATE catalogs SET nombre=$1, codigo=$2 WHERE id=$3', [n, cod, exist.id]);
    } else {
      await q('INSERT INTO catalogs(tipo,nombre,codigo) VALUES($1,$2,$3)', [tipo, n, cod]);
    }
  } else {
    await q('INSERT INTO catalogs(tipo,nombre,codigo) VALUES($1,$2,$3) ON CONFLICT (tipo, nombre) DO NOTHING', [tipo, n, null]);
  }
  await logActivity(req, 'CREAR_CATALOGO', 'Configuración / Catálogos', `Agregó ${tipo}: "${n}"${cod ? ` (Cod: ${cod})` : ''}`);
  res.json({ ok: true });
}));
app.post('/api/catalogs/bulk', auth, admin, wrap(async (req, res) => {
  const { tipo, items } = req.body || {};
  if (!['institucion', 'especialidad', 'muestra', 'producto'].includes(tipo) || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }
  let added = 0;
  for (const raw of items) {
    let n = '', cod = null;
    if (typeof raw === 'object' && raw !== null) {
      n = String(raw.nombre || '').trim();
      cod = raw.codigo ? String(raw.codigo).trim() : null;
    } else {
      n = String(raw || '').trim();
    }
    if (!n) continue;

    if (cod) {
      const exist = (await q('SELECT id FROM catalogs WHERE tipo=$1 AND (lower(nombre)=lower($2) OR (codigo IS NOT NULL AND lower(codigo)=lower($3)))', [tipo, n, cod])).rows[0];
      if (exist) {
        await q('UPDATE catalogs SET nombre=$1, codigo=$2 WHERE id=$3', [n, cod, exist.id]);
      } else {
        const r = await q('INSERT INTO catalogs(tipo,nombre,codigo) VALUES($1,$2,$3)', [tipo, n, cod]);
        if (r.rowCount > 0) added++;
      }
    } else {
      const r = await q('INSERT INTO catalogs(tipo,nombre,codigo) VALUES($1,$2,$3) ON CONFLICT (tipo, nombre) DO NOTHING', [tipo, n, null]);
      if (r.rowCount > 0) added++;
    }
  }
  await logActivity(req, 'IMPORTAR_CATALOGO', 'Configuración / Catálogos', `Importó ${added} elemento(s) en catálogo ${tipo}`);
  res.json({ ok: true, added, total: items.length });
}));
app.delete('/api/catalogs/:id', auth, admin, wrap(async (req, res) => {
  const id = +req.params.id;
  const c = (await q('SELECT tipo, nombre, codigo FROM catalogs WHERE id=$1', [id])).rows[0];
  await q('DELETE FROM catalogs WHERE id=$1', [id]);
  await logActivity(req, 'ELIMINAR_CATALOGO', 'Configuración / Catálogos', `Eliminó catálogo #${id}${c ? ` (${c.tipo}: "${c.nombre}"${c.codigo ? ` [Cod: ${c.codigo}]` : ''})` : ''}`);
  res.json({ ok: true });
}));

// ---------- Geografía ----------
app.get('/api/geography', auth, wrap(async (req, res) => {
  const rows = (await q('SELECT estado, ciudad FROM geography ORDER BY estado, ciudad')).rows;
  const map = {};
  for (const r of rows) {
    if (!map[r.estado]) map[r.estado] = [];
    map[r.estado].push(r.ciudad);
  }
  res.json(map);
}));

// ---------- Documentación / Literatura ----------
app.get('/api/documentation', auth, wrap(async (req, res) => {
  const rows = (await q('SELECT id, titulo, url, fecha, descripcion FROM documentation ORDER BY id')).rows;
  res.json(rows);
}));
app.post('/api/documentation', auth, admin, wrap(async (req, res) => {
  const { titulo, url, fecha, descripcion } = req.body || {};
  if (!titulo || !url) return res.status(400).json({ error: 'Título y URL requeridos' });
  await q('INSERT INTO documentation(titulo, url, fecha, descripcion) VALUES($1, $2, $3, $4)', [titulo.trim(), url.trim(), fecha || null, descripcion || null]);
  await logActivity(req, 'CREAR_DOCUMENTO', 'Documentación', `Agregó documento: "${titulo.trim()}"`);
  res.json({ ok: true });
}));
app.delete('/api/documentation/:id', auth, admin, wrap(async (req, res) => {
  const id = +req.params.id;
  const d = (await q('SELECT titulo FROM documentation WHERE id=$1', [id])).rows[0];
  await q('DELETE FROM documentation WHERE id=$1', [id]);
  await logActivity(req, 'ELIMINAR_DOCUMENTO', 'Documentación', `Eliminó documento #${id}${d ? ` ("${d.titulo}")` : ''}`);
  res.json({ ok: true });
}));

// ---------- Usuarios (master y administradores) ----------
app.get('/api/users', auth, admin, wrap(async (req, res) =>
  res.json((await q('SELECT id,email,nombre,rol,activo,can_view_logs FROM users ORDER BY rol, nombre NULLS LAST, email')).rows)));
app.post('/api/users', auth, admin, wrap(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase(), rol = req.body.rol;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !['administrador', 'visitador'].includes(rol)) return res.status(400).json({ error: 'Correo o rol inválido' });
  const canLogs = rol === 'administrador' ? !!req.body.can_view_logs : false;
  const r = await q('INSERT INTO users(email,nombre,rol,can_view_logs) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id', [email, (req.body.nombre || '').trim() || null, rol, canLogs]);
  if (!r.rowCount) return res.status(409).json({ error: 'Ese correo ya existe' });
  await logActivity(req, 'CREAR_USUARIO', 'Configuración / Usuarios', `Creó usuario ${email} con rol ${rol}${canLogs ? ' (con acceso a Logs)' : ''}`);
  res.json({ ok: true });
}));
app.patch('/api/users/:id', auth, admin, wrap(async (req, res) => {
  const id = +req.params.id, t = (await q('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  if (!t) return res.status(404).json({ error: 'No existe' });
  if (t.rol === 'master') return res.status(403).json({ error: 'El usuario master no se puede modificar' });
  const rol = req.body.rol ?? t.rol;
  const activo = req.body.activo !== undefined ? !!req.body.activo : t.activo;
  const nombre = req.body.nombre !== undefined ? (String(req.body.nombre).trim() || null) : t.nombre;
  let canLogs = t.can_view_logs;
  if (rol === 'administrador') {
    if (req.body.can_view_logs !== undefined) canLogs = !!req.body.can_view_logs;
  } else {
    canLogs = false;
  }
  let email = t.email;
  if (req.body.email) {
    email = req.body.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Correo inválido' });
    const exist = (await q('SELECT id FROM users WHERE email=$1 AND id<>$2', [email, id])).rows[0];
    if (exist) return res.status(409).json({ error: 'Ese correo ya está registrado por otro usuario' });
  }
  if (!['administrador', 'visitador'].includes(rol)) return res.status(400).json({ error: 'Rol inválido' });
  if (id === req.user.id && (!activo || rol !== t.rol)) return res.status(400).json({ error: 'No puedes cambiar tu propio rol o estado' });
  await q('UPDATE users SET email=$1, rol=$2, activo=$3, nombre=$4, can_view_logs=$5 WHERE id=$6', [email, rol, activo, nombre, canLogs, id]);
  await logActivity(req, 'MODIFICAR_USUARIO', 'Configuración / Usuarios', `Modificó usuario ${email} (ID: ${id}) [rol: ${rol}, activo: ${activo}, logs: ${canLogs}]`);
  res.json({ ok: true });
}));
app.delete('/api/users/:id', auth, admin, wrap(async (req, res) => {
  const id = +req.params.id, t = (await q('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  if (!t) return res.status(404).json({ error: 'No existe' });
  if (t.rol === 'master') return res.status(403).json({ error: 'El usuario master no se puede eliminar' });
  if (id === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
  const hasVisits = +(await q('SELECT count(*) FROM visits WHERE visitador_id=$1', [id])).rows[0].count;
  if (hasVisits > 0) {
    await q('UPDATE users SET activo=false WHERE id=$1', [id]);
    await logActivity(req, 'DESACTIVAR_USUARIO', 'Configuración / Usuarios', `Desactivó usuario ${t.email} (ID: ${id}) por tener visitas asociadas`);
    return res.json({ ok: true, deactivated: true, message: 'Usuario desactivado para preservar su historial de visitas' });
  }
  await q('DELETE FROM users WHERE id=$1', [id]);
  await logActivity(req, 'ELIMINAR_USUARIO', 'Configuración / Usuarios', `Eliminó usuario ${t.email} (ID: ${id})`);
  res.json({ ok: true });
}));

// ---------- Dispositivos Vinculados ----------
app.post('/api/devices/bind', auth, wrap(async (req, res) => {
  const { deviceId, deviceName, isTrusted, hasBiometrics, hasPin } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'Identificador de dispositivo requerido' });

  // Límite de dispositivos: Operadores (visitadores) máximo 2, Administradores/Master máximo 4
  const maxAllowed = isAdm(req.user) ? 4 : 2;
  const existingThisDevice = (await q('SELECT id, activo FROM user_devices WHERE user_id=$1 AND device_id=$2', [req.user.id, deviceId])).rows[0];

  if (!existingThisDevice || !existingThisDevice.activo) {
    const countRes = await q('SELECT count(*) FROM user_devices WHERE user_id=$1 AND activo=true AND device_id != $2', [req.user.id, deviceId]);
    const activeCount = parseInt(countRes.rows[0].count, 10);
    if (activeCount >= maxAllowed) {
      return res.status(400).json({
        error: `Has alcanzado el límite máximo de ${maxAllowed} dispositivo(s) vinculado(s) para tu rol (${req.user.rol}). Debes desvincular un equipo anterior en Configuración > Dispositivos antes de vincular este equipo.`,
        code: 'DEVICE_LIMIT_REACHED',
        maxAllowed,
        activeCount
      });
    }
  }

  const r = await q(`
    INSERT INTO user_devices(user_id, device_id, device_name, is_trusted, has_biometrics, has_pin, last_sync, activo)
    VALUES($1, $2, $3, $4, $5, $6, now(), true)
    ON CONFLICT(user_id, device_id)
    DO UPDATE SET device_name=EXCLUDED.device_name,
                  is_trusted=EXCLUDED.is_trusted,
                  has_biometrics=EXCLUDED.has_biometrics,
                  has_pin=EXCLUDED.has_pin,
                  last_sync=now(),
                  activo=true
    RETURNING *
  `, [req.user.id, deviceId, deviceName || 'Navegador Web', isTrusted !== false, !!hasBiometrics, !!hasPin]);

  await logActivity(req, 'VINCULAR_DISPOSITIVO', 'Dispositivos', `Dispositivo vinculado: "${deviceName || 'Dispositivo'}" (${deviceId.slice(0, 8)}...) para ${req.user.email}`);
  res.json({ ok: true, device: r.rows[0], maxAllowed });
}));

app.get('/api/devices/my', auth, wrap(async (req, res) => {
  const maxAllowed = isAdm(req.user) ? 4 : 2;
  const rows = (await q('SELECT id, device_id, device_name, is_trusted, has_biometrics, has_pin, last_sync, activo, creado FROM user_devices WHERE user_id=$1 ORDER BY last_sync DESC', [req.user.id])).rows;
  res.json({ devices: rows, maxAllowed, activeCount: rows.filter(d => d.activo).length });
}));

app.get('/api/devices/all', auth, admin, wrap(async (req, res) => {
  const rows = (await q(`
    SELECT d.id, d.device_id, d.device_name, d.is_trusted, d.has_biometrics, d.has_pin, d.last_sync, d.activo, d.creado,
           u.id as user_id, u.nombre as user_nombre, u.email as user_email, u.rol as user_rol
    FROM user_devices d
    JOIN users u ON u.id = d.user_id
    ORDER BY d.last_sync DESC
  `)).rows;
  res.json(rows);
}));

app.get('/api/users/:id/devices', auth, admin, wrap(async (req, res) => {
  const userId = +req.params.id;
  const rows = (await q('SELECT id, device_id, device_name, is_trusted, has_biometrics, has_pin, last_sync, activo, creado FROM user_devices WHERE user_id=$1 ORDER BY last_sync DESC', [userId])).rows;
  res.json(rows);
}));

app.patch('/api/devices/:id', auth, wrap(async (req, res) => {
  const id = +req.params.id;
  const dev = (await q('SELECT * FROM user_devices WHERE id=$1', [id])).rows[0];
  if (!dev) return res.status(404).json({ error: 'Dispositivo no encontrado' });
  if (dev.user_id !== req.user.id && !isAdm(req.user)) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const activo = req.body.activo !== false;
  await q('UPDATE user_devices SET activo=$1 WHERE id=$2', [activo, id]);
  await logActivity(req, 'ESTADO_DISPOSITIVO', 'Dispositivos', `Dispositivo #${id} ("${dev.device_name}") ${activo ? 'activado' : 'revocado/bloqueado'}`);
  res.json({ ok: true, activo });
}));

app.delete('/api/devices/:id', auth, wrap(async (req, res) => {
  const id = +req.params.id;
  const dev = (await q('SELECT * FROM user_devices WHERE id=$1', [id])).rows[0];
  if (!dev) return res.status(404).json({ error: 'Dispositivo no encontrado' });
  if (dev.user_id !== req.user.id && !isAdm(req.user)) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  await q('DELETE FROM user_devices WHERE id=$1', [id]);
  await logActivity(req, 'ELIMINAR_DISPOSITIVO', 'Dispositivos', `Dispositivo #${id} ("${dev.device_name}") desvinculado`);
  res.json({ ok: true });
}));

// ==================== PEDIDOS ====================

// Helper: obtener pedido completo con items y datos de visitador/admin
async function getOrderFull(id) {
  const ord = (await q(`
    SELECT o.*,
      u.nombre AS visitador_nombre, u.email AS visitador_email,
      a.nombre AS admin_nombre
    FROM orders o
    JOIN users u ON u.id = o.visitador_id
    LEFT JOIN users a ON a.id = o.tomado_por
    WHERE o.id = $1
  `, [id])).rows[0];
  if (!ord) return null;
  ord.items = (await q('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [id])).rows;
  return ord;
}

// GET /api/orders
app.get('/api/orders', auth, wrap(async (req, res) => {
  const { status, visitador_id } = req.query;
  let conds = [];
  let vals = [];
  let idx = 1;
  if (!isAdm(req.user)) {
    conds.push(`o.visitador_id = $${idx++}`);
    vals.push(req.user.id);
  } else if (visitador_id) {
    conds.push(`o.visitador_id = $${idx++}`);
    vals.push(+visitador_id);
  }
  if (status) {
    conds.push(`o.status = $${idx++}`);
    vals.push(status);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = (await q(`
    SELECT o.id, o.visitador_id, o.medico, o.fecha_solicitud, o.fecha_entrega,
           o.status, o.admin_notas, o.notas, o.tomado_por, o.pending_edit, o.creado, o.actualizado,
           u.nombre AS visitador_nombre, u.email AS visitador_email,
           a.nombre AS admin_nombre,
           COUNT(oi.id) AS total_items,
           COALESCE(
             json_agg(
               json_build_object(
                 'id', oi.id,
                 'nombre', oi.nombre,
                 'tipo', oi.tipo,
                 'cantidad_solicitada', oi.cantidad_solicitada,
                 'cantidad_aprobada', oi.cantidad_aprobada,
                 'rechazado', oi.rechazado,
                 'razon_rechazo', oi.razon_rechazo
               ) ORDER BY oi.id
             ) FILTER (WHERE oi.id IS NOT NULL), '[]'
           ) AS items
    FROM orders o
    JOIN users u ON u.id = o.visitador_id
    LEFT JOIN users a ON a.id = o.tomado_por
    LEFT JOIN order_items oi ON oi.order_id = o.id
    ${where}
    GROUP BY o.id, u.nombre, u.email, a.nombre
    ORDER BY o.creado DESC
  `, vals)).rows;
  res.json(rows);
}));

// GET /api/orders/visitadores — lista visitadores con pedidos activos (admin only)
// IMPORTANTE: debe estar ANTES de /api/orders/:id para que Express no confunda 'visitadores' con un id
app.get('/api/orders/visitadores', auth, admin, wrap(async (req, res) => {
  const rows = (await q(`
    SELECT u.id, u.nombre, u.email,
      COUNT(o.id) FILTER (WHERE o.status NOT IN ('listo','rechazado')) AS pedidos_activos,
      COUNT(o.id) AS total_pedidos
    FROM users u
    LEFT JOIN orders o ON o.visitador_id = u.id
    WHERE u.activo = true AND u.rol IN ('visitador','administrador','master')
    GROUP BY u.id, u.nombre, u.email
    ORDER BY pedidos_activos DESC, u.nombre
  `)).rows;
  res.json(rows);
}));

// GET /api/orders/medicos — lista de médicos registrados para pedidos
// Si es visitador: devuelve solo sus médicos; si es admin: devuelve todos los médicos con su visitador asignado
app.get('/api/orders/medicos', auth, wrap(async (req, res) => {
  const isA = isAdm(req.user);
  let where = '';
  let params = [];
  if (!isA) {
    where = 'WHERE visitador_id = $1';
    params.push(req.user.id);
  }
  const rows = (await q(`
    WITH medicos_raw AS (
      SELECT TRIM(v.cliente) AS medico,
             COALESCE(TRIM(v.razon_social), '') AS institucion,
             COALESCE(TRIM(v.especialidad), '') AS especialidad,
             v.visitador_id,
             u.nombre AS visitador_nombre,
             u.email AS visitador_email,
             v.fecha_hora AS fecha
      FROM visits v
      JOIN users u ON u.id = v.visitador_id
      WHERE v.cliente IS NOT NULL AND TRIM(v.cliente) != ''
      UNION ALL
      SELECT TRIM(o.medico) AS medico,
             '' AS institucion,
             '' AS especialidad,
             o.visitador_id,
             u.nombre AS visitador_nombre,
             u.email AS visitador_email,
             o.creado AS fecha
      FROM orders o
      JOIN users u ON u.id = o.visitador_id
      WHERE o.medico IS NOT NULL AND TRIM(o.medico) != ''
    )
    SELECT DISTINCT ON (LOWER(medico))
      medico, institucion, especialidad, visitador_id, visitador_nombre, visitador_email
    FROM medicos_raw
    ${where}
    ORDER BY LOWER(medico), fecha DESC
  `, params)).rows;
  res.json(rows);
}));

// GET /api/orders/:id
app.get('/api/orders/:id', auth, wrap(async (req, res) => {
  const ord = await getOrderFull(+req.params.id);
  if (!ord) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (!isAdm(req.user) && ord.visitador_id !== req.user.id)
    return res.status(403).json({ error: 'No autorizado' });
  res.json(ord);
}));

// POST /api/orders — crear pedido
app.post('/api/orders', auth, wrap(async (req, res) => {
  const { medico, fecha_solicitud, fecha_entrega, notas, items, visitador_id } = req.body;
  if (!medico) return res.status(400).json({ error: 'El médico es requerido' });
  if (!items || !items.length) return res.status(400).json({ error: 'Debe agregar al menos un producto o muestra' });

  // Determinar a qué visitador pertenece el pedido
  let targetVisitadorId = req.user.id;
  if (isAdm(req.user)) {
    if (visitador_id) {
      targetVisitadorId = +visitador_id;
    } else {
      // Buscar el visitador al que pertenece el médico seleccionado
      const foundOwner = (await q(`
        SELECT v.visitador_id FROM visits v
        WHERE LOWER(TRIM(v.cliente)) = LOWER(TRIM($1)) AND v.visitador_id IS NOT NULL
        ORDER BY v.fecha_hora DESC LIMIT 1
      `, [medico.trim()])).rows[0] || (await q(`
        SELECT o.visitador_id FROM orders o
        WHERE LOWER(TRIM(o.medico)) = LOWER(TRIM($1)) AND o.visitador_id IS NOT NULL
        ORDER BY o.creado DESC LIMIT 1
      `, [medico.trim()])).rows[0];
      if (foundOwner && foundOwner.visitador_id) {
        targetVisitadorId = foundOwner.visitador_id;
      }
    }
  }

  const ord = (await q(`
    INSERT INTO orders(visitador_id, medico, fecha_solicitud, fecha_entrega, notas)
    VALUES($1, $2, $3, $4, $5) RETURNING *
  `, [targetVisitadorId, medico, fecha_solicitud || new Date().toISOString().split('T')[0], fecha_entrega || null, notas || null])).rows[0];
  for (const it of items) {
    await q(`
      INSERT INTO order_items(order_id, catalogo_id, nombre, tipo, cantidad_solicitada)
      VALUES($1,$2,$3,$4,$5)
    `, [ord.id, it.catalogo_id || null, it.nombre, it.tipo, it.cantidad_solicitada || 1]);
  }
  await logActivity(req, 'CREAR_PEDIDO', 'Pedidos', `Pedido #${ord.id} creado para médico: ${medico} (asignado a visitador #${targetVisitadorId})`);
  res.json(await getOrderFull(ord.id));
}));

// ==================== SYNC INVENTARIO ====================
async function syncOrderInventory(orderId) {
  await q('DELETE FROM inventory_movements WHERE origen=$1 AND referencia_id=$2', ['pedido', orderId]);
  const ord = (await q('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
  if (!ord) return;
  const items = (await q('SELECT * FROM order_items WHERE order_id=$1 AND rechazado=false AND cantidad_aprobada > 0', [orderId])).rows;
  for (const it of items) {
    await q(`INSERT INTO inventory_movements(visitador_id, tipo, catalogo_id, nombre, cantidad, origen, referencia_id, notas)
             VALUES($1,$2,$3,$4,$5,'pedido',$6,$7)`,
      [ord.visitador_id, it.tipo, it.catalogo_id, it.nombre, it.cantidad_aprobada,
       orderId, `Pedido #${orderId} - ${ord.medico}`]);
  }
}

// PATCH /api/orders/:id — actualizar pedido
app.patch('/api/orders/:id', auth, wrap(async (req, res) => {
  const id = +req.params.id;
  const ord = await getOrderFull(id);
  if (!ord) return res.status(404).json({ error: 'Pedido no encontrado' });

  const isOwner = ord.visitador_id === req.user.id;
  const adm = isAdm(req.user);

  if (!isOwner && !adm) return res.status(403).json({ error: 'No autorizado' });

  const { medico, fecha_solicitud, fecha_entrega, notas, status, admin_notas, items } = req.body;

  if (!adm) {
    // Visitador: solo puede editar si status = 'enviado', sino queda como pendiente
    if (ord.status !== 'enviado') {
      await q('UPDATE orders SET pending_edit=true, actualizado=now() WHERE id=$1', [id]);
      await logActivity(req, 'EDITAR_PEDIDO_PENDIENTE', 'Pedidos', `Visitador solicitó editar pedido #${id} (pendiente aprobación admin)`);
      return res.json({ ok: true, pending: true, msg: 'Edición enviada. Pendiente de aprobación del administrador.' });
    }
    await q(`UPDATE orders SET medico=$1, fecha_solicitud=$2, fecha_entrega=$3, notas=$4, actualizado=now() WHERE id=$5`,
      [medico || ord.medico, fecha_solicitud || ord.fecha_solicitud, fecha_entrega !== undefined ? fecha_entrega : ord.fecha_entrega, notas !== undefined ? notas : ord.notas, id]);
    if (items && items.length) {
      await q('DELETE FROM order_items WHERE order_id=$1', [id]);
      for (const it of items) {
        await q(`INSERT INTO order_items(order_id, catalogo_id, nombre, tipo, cantidad_solicitada)
                 VALUES($1,$2,$3,$4,$5)`,
          [id, it.catalogo_id || null, it.nombre, it.tipo, it.cantidad_solicitada || 1]);
      }
    }
  } else {
    // Admin puede cambiar todo
    const newStatus = status || ord.status;
    const tomado = (newStatus === 'revision' && !ord.tomado_por) ? req.user.id : ord.tomado_por;
    await q(`UPDATE orders SET medico=$1, fecha_solicitud=$2, fecha_entrega=$3, notas=$4,
              status=$5, admin_notas=$6, tomado_por=$7, pending_edit=false, actualizado=now()
              WHERE id=$8`,
      [medico || ord.medico, fecha_solicitud || ord.fecha_solicitud,
       fecha_entrega !== undefined ? fecha_entrega : ord.fecha_entrega,
       notas !== undefined ? notas : ord.notas,
       newStatus, admin_notas !== undefined ? admin_notas : ord.admin_notas,
       tomado, id]);
    // Si admin edita items también
    if (items && items.length) {
      await q('DELETE FROM order_items WHERE order_id=$1', [id]);
      for (const it of items) {
        await q(`INSERT INTO order_items(order_id, catalogo_id, nombre, tipo, cantidad_solicitada)
                 VALUES($1,$2,$3,$4,$5)`,
          [id, it.catalogo_id || null, it.nombre, it.tipo, it.cantidad_solicitada || 1]);
      }
    }
  }
  if (adm && (status === 'listo' || status === 'aprobado')) {
    await syncOrderInventory(id);
  } else if (adm && status && status !== ord.status) {
    await q('DELETE FROM inventory_movements WHERE origen=$1 AND referencia_id=$2', ['pedido', id]);
  }
  await logActivity(req, 'EDITAR_PEDIDO', 'Pedidos', `Pedido #${id} actualizado`);
  res.json(await getOrderFull(id));
}));

// DELETE /api/orders/:id
app.delete('/api/orders/:id', auth, wrap(async (req, res) => {
  const id = +req.params.id;
  const ord = (await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
  if (!ord) return res.status(404).json({ error: 'Pedido no encontrado' });
  const isOwner = ord.visitador_id === req.user.id;
  const adm = isAdm(req.user);
  if (!adm) {
    if (!isOwner) return res.status(403).json({ error: 'No autorizado' });
    if (ord.status !== 'enviado') return res.status(403).json({ error: 'Solo puedes eliminar pedidos en estado "Enviado a Planta"' });
  }
  await q('DELETE FROM orders WHERE id=$1', [id]);
  await logActivity(req, 'ELIMINAR_PEDIDO', 'Pedidos', `Pedido #${id} eliminado`);
  res.json({ ok: true });
}));

// POST /api/orders/:id/items — agregar item a pedido existente
app.post('/api/orders/:id/items', auth, wrap(async (req, res) => {
  const id = +req.params.id;
  const ord = (await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
  if (!ord) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (!isAdm(req.user) && ord.visitador_id !== req.user.id)
    return res.status(403).json({ error: 'No autorizado' });
  if (!isAdm(req.user) && ord.status !== 'enviado')
    return res.status(403).json({ error: 'No se pueden modificar ítems de un pedido en proceso' });
  const { catalogo_id, nombre, tipo, cantidad_solicitada } = req.body;
  const item = (await q(`INSERT INTO order_items(order_id,catalogo_id,nombre,tipo,cantidad_solicitada)
                          VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [id, catalogo_id || null, nombre, tipo, cantidad_solicitada || 1])).rows[0];
  res.json(item);
}));

// PATCH /api/order-items/:id — actualizar item (admin: cantidad_aprobada, rechazo; todos: cantidad_solicitada)
app.patch('/api/order-items/:id', auth, wrap(async (req, res) => {
  const id = +req.params.id;
  const item = (await q('SELECT oi.*, o.visitador_id, o.status, o.tomado_por FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.id=$1', [id])).rows[0];
  if (!item) return res.status(404).json({ error: 'Ítem no encontrado' });
  const adm = isAdm(req.user);
  if (!adm && item.visitador_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

  const { cantidad_aprobada, rechazado, razon_rechazo, cantidad_solicitada } = req.body;
  if (adm) {
    await q(`UPDATE order_items SET
      cantidad_aprobada = COALESCE($1, cantidad_aprobada),
      rechazado = COALESCE($2, rechazado),
      razon_rechazo = COALESCE($3, razon_rechazo)
      WHERE id=$4`,
      [cantidad_aprobada !== undefined ? cantidad_aprobada : null,
       rechazado !== undefined ? rechazado : null,
       razon_rechazo !== undefined ? razon_rechazo : null, id]);
  } else {
    if (item.status !== 'enviado') return res.status(403).json({ error: 'No se puede editar ítem de un pedido en proceso' });
    await q('UPDATE order_items SET cantidad_solicitada=COALESCE($1, cantidad_solicitada) WHERE id=$2',
      [cantidad_solicitada !== undefined ? cantidad_solicitada : null, id]);
  }
  res.json({ ok: true });
}));

// DELETE /api/order-items/:id
app.delete('/api/order-items/:id', auth, wrap(async (req, res) => {
  const id = +req.params.id;
  const item = (await q('SELECT oi.*, o.visitador_id, o.status FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.id=$1', [id])).rows[0];
  if (!item) return res.status(404).json({ error: 'Ítem no encontrado' });
  if (!isAdm(req.user)) {
    if (item.visitador_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });
    if (item.status !== 'enviado') return res.status(403).json({ error: 'No se puede eliminar ítem de un pedido en proceso' });
  }
  await q('DELETE FROM order_items WHERE id=$1', [id]);
  res.json({ ok: true });
}));

// POST /api/orders/:id/process — acción admin: aprobar, rechazar, marcar listo, tomar
app.post('/api/orders/:id/process', auth, admin, wrap(async (req, res) => {
  const id = +req.params.id;
  const ord = (await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
  if (!ord) return res.status(404).json({ error: 'Pedido no encontrado' });
  const { action, admin_notas, items } = req.body;
  // action: 'tomar' | 'aprobar' | 'rechazar' | 'listo'

  if (action === 'tomar') {
    await q(`UPDATE orders SET status='revision', tomado_por=$1, actualizado=now() WHERE id=$2`, [req.user.id, id]);
    await logActivity(req, 'TOMAR_PEDIDO', 'Pedidos', `Pedido #${id} tomado en revisión`);
  } else if (action === 'aprobar') {
    if (items && items.length) {
      for (const it of items) {
        await q('UPDATE order_items SET cantidad_aprobada=$1, rechazado=$2, razon_rechazo=$3 WHERE id=$4',
          [it.cantidad_aprobada !== undefined ? it.cantidad_aprobada : null,
           it.rechazado || false, it.razon_rechazo || null, it.id]);
      }
    }
    await q(`UPDATE orders SET status='aprobado', admin_notas=$1, actualizado=now() WHERE id=$2`, [admin_notas || null, id]);
    await logActivity(req, 'APROBAR_PEDIDO', 'Pedidos', `Pedido #${id} aprobado`);
  } else if (action === 'rechazar') {
    await q(`UPDATE orders SET status='rechazado', admin_notas=$1, actualizado=now() WHERE id=$2`, [admin_notas || null, id]);
    await logActivity(req, 'RECHAZAR_PEDIDO', 'Pedidos', `Pedido #${id} rechazado`);
  } else if (action === 'listo') {
    if (items && items.length) {
      for (const it of items) {
        await q('UPDATE order_items SET cantidad_aprobada=$1, rechazado=$2, razon_rechazo=$3 WHERE id=$4',
          [it.cantidad_aprobada !== undefined ? it.cantidad_aprobada : null,
           it.rechazado || false, it.razon_rechazo || null, it.id]);
      }
    }
    await q(`UPDATE orders SET status='listo', admin_notas=$1, actualizado=now() WHERE id=$2`, [admin_notas || null, id]);
    await syncOrderInventory(id);
    await logActivity(req, 'LISTO_PEDIDO', 'Pedidos', `Pedido #${id} marcado como listo`);
  } else {
    return res.status(400).json({ error: 'Acción no válida' });
  }
  res.json(await getOrderFull(id));
}));

// ==================== FIN PEDIDOS ====================

// ==================== INVENTARIO / ASIGNACIONES ====================

// GET /api/inventory — stock actual del visitador (o filtrado por visitador_id si admin)
app.get('/api/inventory', auth, wrap(async (req, res) => {
  const isA = isAdm(req.user);
  const vid = isA && req.query.visitador_id ? +req.query.visitador_id : req.user.id;
  const rows = (await q(`
    SELECT tipo, nombre, catalogo_id,
           SUM(CASE WHEN cantidad > 0 THEN cantidad ELSE 0 END) AS total_asignado,
           ABS(SUM(CASE WHEN cantidad < 0 THEN cantidad ELSE 0 END)) AS total_entregado,
           SUM(cantidad) AS stock
    FROM inventory_movements
    WHERE visitador_id = $1
    GROUP BY tipo, nombre, catalogo_id
    ORDER BY tipo, nombre
  `, [vid])).rows;
  res.json(rows);
}));

// GET /api/inventory/visitadores — lista de visitadores con movimientos (admin)
app.get('/api/inventory/visitadores', auth, admin, wrap(async (req, res) => {
  const rows = (await q(`
    SELECT DISTINCT u.id, u.nombre, u.email
    FROM inventory_movements im
    JOIN users u ON u.id = im.visitador_id
    ORDER BY u.nombre
  `)).rows;
  res.json(rows);
}));

// GET /api/inventory/report — reporte admin: stock + entregado por visitador
app.get('/api/inventory/report', auth, admin, wrap(async (req, res) => {
  const { from, to, visitador_id } = req.query;
  let conds = []; let vals = []; let idx = 1;
  if (from)        { conds.push(`im.fecha >= $${idx++}`); vals.push(from); }
  if (to)          { conds.push(`im.fecha <= $${idx++}`); vals.push(to + ' 23:59:59'); }
  if (visitador_id){ conds.push(`im.visitador_id = $${idx++}`); vals.push(+visitador_id); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = (await q(`
    SELECT u.id AS visitador_id, u.nombre AS visitador_nombre, u.email AS visitador_email,
           im.tipo, im.nombre,
           SUM(CASE WHEN im.cantidad > 0 THEN im.cantidad ELSE 0 END) AS total_asignado,
           ABS(SUM(CASE WHEN im.cantidad < 0 THEN im.cantidad ELSE 0 END)) AS total_entregado,
           SUM(im.cantidad) AS stock_actual
    FROM inventory_movements im
    JOIN users u ON u.id = im.visitador_id
    ${where}
    GROUP BY u.id, u.nombre, u.email, im.tipo, im.nombre
    ORDER BY u.nombre, im.tipo, im.nombre
  `, vals)).rows;
  res.json(rows);
}));

// GET /api/inventory/deliveries/:visitador_id — entregas detalladas a médicos
app.get('/api/inventory/deliveries/:visitador_id', auth, wrap(async (req, res) => {
  const isA = isAdm(req.user);
  const vid = +req.params.visitador_id;
  if (!isA && vid !== req.user.id) return res.status(403).json({ error: 'No autorizado' });
  const { from, to } = req.query;
  let conds = ['im.visitador_id = $1', "im.origen = 'visita'", 'im.cantidad < 0'];
  let vals = [vid]; let idx = 2;
  if (from) { conds.push(`im.fecha >= $${idx++}`); vals.push(from); }
  if (to)   { conds.push(`im.fecha <= $${idx++}`); vals.push(to + ' 23:59:59'); }
  const rows = (await q(`
    SELECT im.*, v.razon_social, v.lugar_visita, v.fecha_hora AS visita_fecha
    FROM inventory_movements im
    LEFT JOIN visits v ON v.id = im.referencia_id
    WHERE ${conds.join(' AND ')}
    ORDER BY im.fecha DESC
    LIMIT 500
  `, vals)).rows;
  res.json(rows);
}));

// ==================== FIN INVENTARIO ====================


function saveImg(d, prefix) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(d || '');
  if (!m) return null;
  const name = `${prefix}-${crypto.randomUUID()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOADS, name), Buffer.from(m[2], 'base64'));
  return '/uploads/' + name;
}
function scope(req, useFilters = true) {
  const w = [], p = [], add = (c, v) => { p.push(v); w.push(c.replace('?', '$' + p.length)); };
  const qs = req.query;
  if (!isAdm(req.user)) add('v.visitador_id = ?', req.user.id);
  else if (useFilters && qs.visitador) add('v.visitador_id = ?', +qs.visitador);
  if (useFilters) {
    const d = `(v.fecha_hora AT TIME ZONE '${TZ}')::date`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(qs.desde || '')) add(d + ' >= ?', qs.desde);
    if (/^\d{4}-\d{2}-\d{2}$/.test(qs.hasta || '')) add(d + ' <= ?', qs.hasta);
    if (qs.institucion) add('v.lugar_visita = ?', qs.institucion);
    if (qs.especialidad) add('v.especialidad ILIKE ?', '%' + qs.especialidad + '%');
    if (['primera', 'recurrente'].includes(qs.tipo)) add('v.tipo_visita = ?', qs.tipo);
    if (qs.texto) add('(v.razon_social ILIKE ? )', '%' + qs.texto + '%');
  }
  return [w.length ? 'WHERE ' + w.join(' AND ') : '', p];
}
const SEL = 'SELECT v.*, u.nombre AS visitador_nombre, u.email AS visitador_email FROM visits v JOIN users u ON u.id=v.visitador_id';

app.post('/api/visits', auth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!['primera', 'recurrente'].includes(b.tipo_visita)) b.tipo_visita = 'primera';

  // Idempotencia: evitar duplicados si la red se corta y se reintenta el envío
  const clientUuid = (b.client_uuid || '').trim() || null;
  if (clientUuid) {
    const existing = (await q('SELECT id FROM visits WHERE client_uuid = $1', [clientUuid])).rows[0];
    if (existing) {
      return res.json({ ok: true, id: existing.id, duplicate: true });
    }
  }

  const vals = F.map(f => {
    let v = typeof b[f] === 'string' ? b[f].trim() : b[f];
    if (v === '' || v == null) return null;
    if (f.includes('fecha') && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    return String(v).slice(0, 2000);
  });

  const fechaOffline = b.fecha_offline ? new Date(b.fecha_offline) : null;
  const cols = ['visitador_id', ...F, 'foto', 'firma', 'client_uuid', 'fecha_offline'];
  const params = [req.user.id, ...vals, saveImg(b.foto, 'foto'), saveImg(b.firma, 'firma'), clientUuid, fechaOffline];
  const r = await q(`INSERT INTO visits(${cols.join(',')}) VALUES(${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, params);
  const newId = r.rows[0].id;

  // --- Descontar inventario si se entregaron muestras o productos ---
  const parseDetalleStr = str => {
    const res = [];
    if (!str) return res;
    for (const part of str.split(',')) {
      const m = /(.*?)\s*\((\d+)\)/.exec(part.trim());
      if (m && +m[2] > 0) res.push({ nombre: m[1].trim(), cantidad: +m[2] });
    }
    return res;
  };
  const medicoNombre = b.razon_social || null;
  for (const it of parseDetalleStr(b.muestras_detalle)) {
    const catRow = (await q("SELECT id FROM catalogs WHERE tipo='muestra' AND LOWER(nombre)=LOWER($1)", [it.nombre])).rows[0];
    await q('INSERT INTO inventory_movements(visitador_id,tipo,catalogo_id,nombre,cantidad,origen,referencia_id,medico,notas) VALUES($1,\'muestra\',$2,$3,$4,\'visita\',$5,$6,$7)',
      [req.user.id, catRow ? catRow.id : null, it.nombre, -it.cantidad, newId, medicoNombre, 'Visita #' + newId]);
  }
  for (const it of parseDetalleStr(b.productos_detalle)) {
    const catRow = (await q("SELECT id FROM catalogs WHERE tipo='producto' AND LOWER(nombre)=LOWER($1)", [it.nombre])).rows[0];
    await q('INSERT INTO inventory_movements(visitador_id,tipo,catalogo_id,nombre,cantidad,origen,referencia_id,medico,notas) VALUES($1,\'producto\',$2,$3,$4,\'visita\',$5,$6,$7)',
      [req.user.id, catRow ? catRow.id : null, it.nombre, -it.cantidad, newId, medicoNombre, 'Visita #' + newId]);
  }
  // --- fin descuento inventario ---

  const syncTag = b.is_offline ? ' [Sincronizada offline]' : '';
  await logActivity(req, 'CREAR_VISITA', 'Nueva Visita', `Registró visita #${newId}${syncTag} - ${b.tipo_visita === 'recurrente' ? 'Recurrente' : 'Primera'} a "${b.razon_social || ''}" (${b.lugar_visita || ''})`);
  res.json({ ok: true, id: newId });
}));

app.get('/api/visits/export.csv', auth, admin, wrap(async (req, res) => {
  const [w, p] = scope(req);
  const rows = (await q(`${SEL} ${w} ORDER BY v.fecha_hora DESC`, p)).rows;
  const keys = ['id', 'fecha_hora', 'visitador_nombre', 'visitador_email', ...F, 'foto', 'firma'];
  const cell = v => v == null ? '' : '"' + String(v instanceof Date ? v.toISOString() : v).replace(/"/g, '""') + '"';
  const out = [keys.map(k => cell(k.replace(/_/g, ' '))).join(',')].concat(rows.map(r => keys.map(k => cell(r[k])).join(',')));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="visitas.csv"' });
  res.send('\ufeff' + out.join('\r\n'));
}));

app.get('/api/visits/by-cedula/:cedula', auth, wrap(async (req, res) => {
  const ced = (req.params.cedula || '').trim();
  if (!ced) return res.json({ found: false });
  const [w, p] = scope(req, false);
  p.push(ced.toLowerCase());
  const cond = `lower(v.cedula) = $${p.length}`;
  const r = await q(`SELECT * FROM visits v ${w ? w + ' AND ' : 'WHERE '}${cond} ORDER BY v.fecha_hora DESC LIMIT 1`, p);
  if (!r.rowCount) return res.json({ found: false });
  res.json({ found: true, visit: r.rows[0] });
}));

app.get('/api/visits/lookup', auth, wrap(async (req, res) => {
  const [w, p] = scope(req, false); p.push('%' + (req.query.q || '') + '%');
  const cond = `(v.razon_social ILIKE $${p.length} OR v.cliente ILIKE $${p.length} OR coalesce(v.cedula,'') ILIKE $${p.length})`;
  const r = await q(`SELECT * FROM (SELECT DISTINCT ON (lower(v.razon_social), lower(coalesce(v.cliente,''))) v.* FROM visits v
    ${w ? w + ' AND ' : 'WHERE '}${cond} ORDER BY lower(v.razon_social), lower(coalesce(v.cliente,'')), v.fecha_hora DESC) x
    ORDER BY fecha_hora DESC LIMIT 8`, p);
  res.json(r.rows);
}));

app.get('/api/visits', auth, wrap(async (req, res) => {
  const [w, p] = scope(req);
  const limit = Math.min(+req.query.limit || 25, 200), offset = +req.query.offset || 0;
  const total = +(await q(`SELECT count(*) FROM visits v ${w}`, p)).rows[0].count;
  const rows = (await q(`${SEL} ${w} ORDER BY v.fecha_hora DESC LIMIT ${limit} OFFSET ${offset}`, p)).rows;
  res.json({ rows, total });
}));

app.delete('/api/visits/:id', auth, admin, wrap(async (req, res) => {
  const id = +req.params.id;
  const v = (await q('SELECT id, razon_social, lugar_visita FROM visits WHERE id=$1', [id])).rows[0];
  await q('DELETE FROM visits WHERE id=$1', [id]);
  await logActivity(req, 'ELIMINAR_VISITA', 'Visitas', `Eliminó visita #${id}${v ? ` ("${v.razon_social}" - ${v.lugar_visita})` : ''}`);
  res.json({ ok: true });
}));

app.get('/api/stats', auth, wrap(async (req, res) => {
  const [w, p] = scope(req, false), d = `(v.fecha_hora AT TIME ZONE '${TZ}')`, now = `(now() AT TIME ZONE '${TZ}')`;
  const t = (await q(`SELECT count(*) total, count(*) FILTER (WHERE ${d}::date = ${now}::date) hoy,
    count(*) FILTER (WHERE date_trunc('month',${d}) = date_trunc('month',${now})) mes FROM visits v ${w}`, p)).rows[0];
  const by = async col => (await q(`SELECT ${col} k, count(*)::int n FROM visits v JOIN users u ON u.id=v.visitador_id ${w}
    ${w ? 'AND' : 'WHERE'} ${col} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, p)).rows;
  res.json({ total: +t.total, hoy: +t.hoy, mes: +t.mes, porInstitucion: await by('v.lugar_visita'),
    porVisitador: isAdm(req.user) ? await by('COALESCE(u.nombre,u.email)') : [] });
}));

// ========== MÓDULO AGENDAR (sin dependencias externas) ==========

// Inicializar web-push VAPID
let webpush = null;
try {
  webpush = require('web-push');
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      VAPID_SUBJECT || 'mailto:admin@visitas-erp.local',
      VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
    );
    console.log('Web Push VAPID configurado correctamente.');
  } else {
    console.warn('Aviso: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY no configuradas. Push desactivado.');
    webpush = null;
  }
} catch (e) { console.warn('web-push no disponible:', e.message); }

// Enviar push a todos los dispositivos de un usuario
async function sendPushToUser(userId, payload) {
  if (!webpush) return;
  const subs = (await q('SELECT * FROM push_subscriptions WHERE user_id=$1', [userId])).rows;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
    } catch (err) {
      // Suscripción expirada o inválida → limpiar
      if (err.statusCode === 404 || err.statusCode === 410) {
        await q('DELETE FROM push_subscriptions WHERE id=$1', [s.id]);
      }
    }
  }
}

// Job de recordatorios avanzados
function startReminderJob() {
  const CHECK_INTERVAL = 60 * 1000; // Corre cada 1 minuto
  async function checkReminders() {
    try {
      // Buscar eventos con recordatorio activo que deben notificarse ahora
      const rows = (await q(`
        SELECT e.*, u.nombre AS user_nombre
        FROM events e
        JOIN users u ON u.id = e.user_id
        WHERE e.notif_enviada = false
          AND e.recordatorio_min >= 0
          AND e.inicio >= (now() - interval '2 hours')
          AND (e.inicio - (e.recordatorio_min * interval '1 minute')) <= now()
      `)).rows;

      for (const ev of rows) {
        const diff = Math.round((new Date(ev.inicio) - Date.now()) / 60000);
        let msg = '';
        if (ev.recordatorio_min >= 1200) {
          msg = `Recuerde que mañana tiene actividades agendadas: "${ev.titulo}". ¿Desea ir a actividades agendadas?`;
        } else if (diff <= 0) {
          msg = `⏰ La actividad "${ev.titulo}" está comenzando ahora.`;
        } else if (diff < 60) {
          msg = `⏰ Recordatorio: En ${diff} minutos tiene agendado "${ev.titulo}".`;
        } else {
          const h = Math.round(diff / 60);
          msg = `⏰ Recordatorio: En ${h} hora(s) tiene agendado "${ev.titulo}".`;
        }

        await sendPushToUser(ev.user_id, {
          title: 'Visitas Medicas ERP — Recordatorio',
          body: msg,
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
          data: { url: '/#agendar', eventId: ev.id }
        });
        await q('UPDATE events SET notif_enviada=true WHERE id=$1', [ev.id]);
      }
      if (rows.length) console.log(`[Recordatorios] ${rows.length} notificaciones enviadas.`);
    } catch (e) { console.error('Error en job de recordatorios:', e.message); }
  }
  setTimeout(checkReminders, 10000);
  setInterval(checkReminders, CHECK_INTERVAL);
  console.log('Job de recordatorios automáticos iniciado (cada 1 min).');
}

// GET /api/push/vapid-key — clave pública VAPID para el frontend
app.get('/api/push/vapid-key', auth, (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push no configurado' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe — guardar suscripción push del dispositivo
app.post('/api/push/subscribe', auth, wrap(async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Suscripción incompleta' });
  await q(
    `INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth)
     VALUES($1,$2,$3,$4) ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh=$3, auth=$4`,
    [req.user.id, endpoint, keys.p256dh, keys.auth]
  );
  res.json({ ok: true });
}));

// DELETE /api/push/subscribe — eliminar suscripción
app.delete('/api/push/subscribe', auth, wrap(async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) await q('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [req.user.id, endpoint]);
  else          await q('DELETE FROM push_subscriptions WHERE user_id=$1', [req.user.id]);
  res.json({ ok: true });
}));

// GET /api/events/alerts — alertas pendientes en pantalla para el usuario actual
app.get('/api/events/alerts', auth, wrap(async (req, res) => {
  const rows = (await q(`
    SELECT e.*
    FROM events e
    WHERE e.user_id = $1
      AND e.alert_dismissed = false
      AND e.recordatorio_min >= 0
      AND e.inicio >= (now() - interval '2 hours')
      AND (e.inicio - (e.recordatorio_min * interval '1 minute')) <= now()
    ORDER BY e.inicio ASC
    LIMIT 3
  `, [req.user.id])).rows;
  res.json({ alerts: rows });
}));

// POST /api/events/alerts/dismiss/:id — descartar alerta de la pantalla
app.post('/api/events/alerts/dismiss/:id', auth, wrap(async (req, res) => {
  const id = +req.params.id;
  await q('UPDATE events SET alert_dismissed = true WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  res.json({ ok: true });
}));

// GET /api/events/summary — resumen de actividades del usuario
app.get('/api/events/summary', auth, wrap(async (req, res) => {
  const isA = isAdm(req.user);
  const uid = req.user.id;
  const whereUser = isA ? '' : 'WHERE user_id = ' + uid;
  const rows = (await q(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE inicio::date = CURRENT_DATE)::int AS hoy,
      count(*) FILTER (WHERE inicio::date = CURRENT_DATE + interval '1 day')::int AS manana,
      count(*) FILTER (WHERE inicio >= now() AND inicio <= now() + interval '7 days')::int AS semana
    FROM events ${whereUser}
  `)).rows[0];
  res.json(rows);
}));

// GET /api/events — lista de eventos (propio para visitador, todos para admin con filtros)
app.get('/api/events', auth, wrap(async (req, res) => {
  const isA = isAdm(req.user);
  const { from, to, user_id } = req.query;
  const wheres = [], params = [];
  if (!isA) { params.push(req.user.id); wheres.push(`e.user_id = $${params.length}`); }
  else if (user_id) { params.push(+user_id); wheres.push(`e.user_id = $${params.length}`); }
  if (from) { params.push(from); wheres.push(`e.inicio >= $${params.length}`); }
  if (to)   { params.push(to);   wheres.push(`e.inicio <= $${params.length}`); }
  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
  const rows = (await q(
    `SELECT e.*, u.nombre AS user_nombre, u.email AS user_email
     FROM events e JOIN users u ON u.id = e.user_id
     ${where} ORDER BY e.inicio ASC`, params)).rows;
  res.json({ rows });
}));

// POST /api/events — crear evento
app.post('/api/events', auth, wrap(async (req, res) => {
  const { titulo, descripcion, ubicacion, inicio, fin, todo_el_dia, medico_ref, recordatorio_min, categoria, color } = req.body;
  if (!titulo || !inicio || !fin) return res.status(400).json({ error: 'titulo, inicio y fin son requeridos' });
  const remMin = recordatorio_min !== undefined ? parseInt(recordatorio_min) : 60;
  const r = await q(
    `INSERT INTO events(user_id, titulo, descripcion, ubicacion, inicio, fin, todo_el_dia, medico_ref, recordatorio_min, categoria, color)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [req.user.id, titulo, descripcion || null, ubicacion || null,
     inicio, fin, !!todo_el_dia, medico_ref || null, remMin,
     categoria || 'visita', color || '#0f9d8a']);
  await logActivity(req, 'CREAR_EVENTO', 'Agendar', `Creó evento "${titulo}" (${inicio})`);
  res.json({ ok: true, id: r.rows[0].id });
}));

// PUT /api/events/:id — editar evento
app.put('/api/events/:id', auth, wrap(async (req, res) => {
  const id = +req.params.id;
  const ev = (await q('SELECT * FROM events WHERE id=$1', [id])).rows[0];
  if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });
  if (ev.user_id !== req.user.id && !isAdm(req.user)) return res.status(403).json({ error: 'Sin permisos' });
  const { titulo, descripcion, ubicacion, inicio, fin, todo_el_dia, medico_ref, recordatorio_min, categoria, color } = req.body;
  const remMin = recordatorio_min !== undefined ? parseInt(recordatorio_min) : ev.recordatorio_min;
  await q(
    `UPDATE events SET titulo=$1,descripcion=$2,ubicacion=$3,inicio=$4,fin=$5,
      todo_el_dia=$6,medico_ref=$7,recordatorio_min=$8,categoria=$9,color=$10,notif_enviada=false,alert_dismissed=false,updated_at=now()
     WHERE id=$11`,
    [titulo||ev.titulo, descripcion??ev.descripcion, ubicacion??ev.ubicacion,
     inicio||ev.inicio, fin||ev.fin, todo_el_dia??ev.todo_el_dia,
     medico_ref??ev.medico_ref, remMin, categoria||ev.categoria||'visita', color||ev.color||'#0f9d8a', id]);
  await logActivity(req, 'EDITAR_EVENTO', 'Agendar', `Editó evento "${titulo||ev.titulo}" (#${id})`);
  res.json({ ok: true });
}));

// DELETE /api/events/:id — eliminar evento
app.delete('/api/events/:id', auth, wrap(async (req, res) => {
  const id = +req.params.id;
  const ev = (await q('SELECT * FROM events WHERE id=$1', [id])).rows[0];
  if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });
  if (ev.user_id !== req.user.id && !isAdm(req.user)) return res.status(403).json({ error: 'Sin permisos' });
  await q('DELETE FROM events WHERE id=$1', [id]);
  await logActivity(req, 'ELIMINAR_EVENTO', 'Agendar', `Eliminó evento "${ev.titulo}" (#${id})`);
  res.json({ ok: true });
}));

// GET /api/events/users — lista de usuarios para filtro admin
app.get('/api/events/users', auth, admin, wrap(async (req, res) => {
  const rows = (await q('SELECT id, nombre, email FROM users WHERE activo ORDER BY nombre')).rows;
  res.json(rows);
}));

app.use('/uploads', auth, express.static(UPLOADS));
app.use(express.static(path.join(__dirname, 'public')));

initDb().then(() => {
  // Iniciar job de recordatorios
  startReminderJob();

  // HTTP en :3000
  http.createServer(app).listen(3000, () => console.log('Visitas Medicas ERP HTTP  en :3000'));

  // HTTPS en :3443 (si hay certificados disponibles)
  const certPath = '/data/certs/cert.pem', keyPath = '/data/certs/key.pem';
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
      .listen(3443, () => console.log('Visitas Medicas ERP HTTPS en :3443'));
  } else {
    console.warn('Sin certificados SSL — solo HTTP disponible.');
  }
}).catch(e => { console.error('Error iniciando:', e); process.exit(1); });
