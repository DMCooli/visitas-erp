# Visitas ERP - Sistema de Gestión y Auditoría Médica (PWA)

Solución web empresarial y PWA (Progressive Web App) **Offline-First** diseñada para la gestión, auditoría y control en tiempo real de visitas médicas e institucionales. Permite registrar doctores, instituciones de salud, entregas de muestras de productos con cantidades, firmas digitales en pantalla táctil, fotografías y geolocalización GPS, con capacidad de operar al 100% tanto con conexión como en zonas sin cobertura o sin internet.

---

## 📜 Licencia y Copyright
Este proyecto es software libre distribuido bajo los términos de la licencia **GNU General Public License v3.0 (GPLv3)**.  
**Copyright (c) 2026 Damian Medina Cooli.**

Consulta el archivo [LICENSE](LICENSE) para obtener los términos y condiciones completos de la licencia.

---

## ✨ Características Principales

* 📱 **PWA Offline-First:** Funciona sin conexión a internet. Los formularios, firmas y fotos se guardan de forma segura en **IndexedDB** en el dispositivo y se sincronizan automáticamente con el servidor central al detectar cobertura.
* 🛡️ **Prevención de Duplicados (Idempotencia):** Cada registro fuera de línea genera un identificador único (UUID), garantizando que las conexiones inestables no generen visitas duplicadas.
* ✍️ **Firma Digital Táctil:** Lienzo interactivo (HTML5 Canvas) de alta fidelidad para la firma del médico o encargado en pantallas móviles o tablets.
* 📷 **Captura Fotográfica Optimizada:** Captura directa con la cámara o galería con compresión automática en el navegador (Canvas) para optimizar el almacenamiento y ancho de banda.
* 🪪 **Verificación de DNI / Cédula:** Detección automática de **Primera Visita** vs **Visita Recurrente**, con bloqueo de campos en modo protegido y edición selectiva campo por campo.
* 📦 **Muestras Médicas con Inventario:** Modal de selección múltiple de muestras entregadas con captura de cantidades numéricas exactas.
* 📊 **Panel de Estadísticas en Vivo:** Métricas totales, del mes y del día, con gráficos por tipo de institución y comparativo por visitador.
* 🔍 **Auditoría y Logs del Sistema:** Trazabilidad integral de eventos: inicios de sesión, cierres de sesión, navegación de módulos, altas, modificaciones y eliminaciones de registros con IP, fecha/hora y usuario.
* 👥 **Control de Acceso Basado en Roles (RBAC):**
  * **Master:** Administrador supremo con acceso nativo irrestricto y permanente a la auditoría.
  * **Administrador:** Gestión de visitas, usuarios, catálogos, literatura y exportación CSV, con permiso configurable para consultar logs.
  * **Visitador:** Registro de visitas, consulta de sus propios registros y acceso a literatura médica.
* 🌓 **Modos Claro, Oscuro y Sistema:** Interfaz con diseño moderno y adaptable.

---

## 🛠️ Stack Tecnológico

* **Backend:** Node.js, Express, PostgreSQL 16 (Alpine).
* **Frontend:** Single Page Application (SPA) ultraligera en JavaScript Vanilla, CSS3 modular y almacenamiento nativo en IndexedDB.
* **Autenticación:** Google Firebase Authentication (OAuth 2.0 con cuentas de Google).
* **Seguridad:** Cookies `HttpOnly`, sesiones con JWT (JSON Web Tokens), endpoints autenticados y sanitización de entradas.
* **Despliegue:** Docker & Docker Compose con volúmenes persistentes y puertos HTTP (`3000`) y HTTPS (`3443`).

---

## 🚀 Guía de Despliegue y Configuración Paso a Paso

### Prerrequisitos
* [Docker](https://docs.docker.com/get-docker/) y [Docker Compose](https://docs.docker.com/compose/) instalados en el servidor o equipo local.
* Un proyecto creado en [Google Firebase Console](https://console.firebase.google.com/) con el proveedor de autenticación **Google** habilitado.

---

### Paso 1: Clonar el Repositorio
```bash
git clone https://github.com/TU_USUARIO/visitas-erp.git
cd visitas-erp
```

---

### Paso 2: Configurar las Variables de Entorno (`.env`)
Copia la plantilla de ejemplo para crear tu archivo `.env`:
```bash
cp .env.example .env
```

Edita el archivo `.env` con tus parámetros:
```bash
nano .env
```

Configura los siguientes valores:
```ini
# 1. Contraseña de la base de datos PostgreSQL
DB_PASSWORD=una_contrasena_postgres_fuerte_aqui

# 2. Credenciales Web de Google Firebase Console
FIREBASE_API_KEY=tu_firebase_api_key
FIREBASE_AUTH_DOMAIN=tu_proyecto.firebaseapp.com
FIREBASE_PROJECT_ID=tu_proyecto_id
FIREBASE_APP_ID=tu_firebase_app_id

# 3. Secreto criptográfico para tokens JWT (al menos 32 caracteres)
# Puedes generar uno con: openssl rand -hex 32
JWT_SECRET=tu_jwt_secret_aleatorio_muy_largo

# 4. Correo de Google del Administrador Master Inicial
# El usuario con esta cuenta obtendrá rol 'master' y acceso total al iniciar sesión por primera vez.
INITIAL_MASTER_EMAIL=tu_correo_gmail@gmail.com

# 5. Parámetros de la Aplicación
COOKIE_SECURE=false
APP_TZ=America/Caracas
APP_PORT=3000
```

---

### Paso 3: Configurar Google Firebase Authentication
1. Ve a la consola de [Firebase](https://console.firebase.google.com/) y crea un nuevo proyecto (o usa uno existente).
2. En el menú lateral, dirígete a **Build > Authentication** y pulsa **Comenzar**.
3. En la pestaña **Sign-in method**, selecciona **Google**, habilítalo y guarda los cambios.
4. En **Configuración del proyecto > General**, en la sección **Tus apps**, pulsa el icono de Web (`</>`), registra una aplicación y copia las claves (`apiKey`, `authDomain`, `projectId`, `appId`) a tu archivo `.env`.
5. En la sección de **Dominios autorizados** de Authentication, asegúrate de que figure tu dominio o `localhost`.

---

### Paso 4: Certificados SSL (Opcional para HTTPS en puerto 3443)
Para habilitar HTTPS en el puerto `3443` (recomendado para acceso móvil y permisos de geolocalización):
1. Coloca tu certificado y clave privada en la carpeta `certs/`:
   * `certs/cert.pem`
   * `certs/key.pem`
2. Si estás probando en desarrollo local, puedes generar un certificado auto-firmado:
```bash
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes -subj "/CN=localhost"
```

---

### Paso 5: Construir y Levantar los Contenedores
Inicia los servicios en segundo plano con Docker Compose:
```bash
docker compose up -d --build
```

Verifica que los contenedores estén funcionando correctamente:
```bash
docker compose ps
docker compose logs -f app
```

---

### Paso 6: Primer Acceso al Sistema (Alta del Master)
1. Abre tu navegador web en `http://localhost:3000` (o la IP/dominio de tu servidor).
2. Haz clic en **Acceder con Google**.
3. Inicia sesión con la cuenta de Gmail configurada en `INITIAL_MASTER_EMAIL`.
4. El sistema reconocerá automáticamente la dirección, le asignará el rol **Master** con permisos totales y te redirigirá al Panel de Control.

---

### Paso 7: Gestión de Usuarios y PWA
1. Desde el menú **Configuración > Usuarios**, el Master puede dar de alta a nuevos Administradores y Visitadores Médicos ingresando sus cuentas de Gmail autorizadas.
2. Al seleccionar rol **Administrador**, se puede marcar si tendrá acceso a la sección de **Logs del Sistema**.
3. En dispositivos móviles (Android / iPhone), abre el enlace en Chrome o Safari y selecciona **"Agregar a la pantalla de inicio"** para instalar la PWA y disfrutar de la experiencia Offline-First completa.

---

## 🧰 Comandos Útiles de Mantenimiento

* **Ver registros en tiempo real:**
  ```bash
  docker compose logs -f
  ```
* **Reiniciar el backend tras cambios:**
  ```bash
  docker compose restart app
  ```
* **Crear respaldo de la base de datos:**
  ```bash
  docker compose exec -T db pg_dump -U visitas visitas > backup_visitas.sql
  ```
* **Restaurar respaldo:**
  ```bash
  docker compose exec -T db psql -U visitas -d visitas < backup_visitas.sql
  ```
* **Detener servicios:**
  ```bash
  docker compose down
  ```

---

## 👨‍💻 Autor y Contacto
* **Autor:** Damian Medina Cooli
* **Licencia:** GNU General Public License v3.0 (GPLv3)
