/**
 * ============================================================
 * server.js — Servidor Principal v2.1
 * ============================================================
 * Express + Socket.IO server con:
 * - Autenticación JWT (login/register)
 * - Gestión de Workspaces por usuario
 * - API REST para sesiones WhatsApp, chats y mensajes
 * - Solo lectura (sin envío de mensajes)
 * ============================================================
 */

require('dotenv').config(); // Carga variables de entorno desde .env

// =====================================================
// PROTECCIÓN: Errores globales no capturados
// Evita que Puppeteer/whatsapp-web.js tumbe el proceso
// completo cuando un celular se desconecta abruptamente
// =====================================================
process.on('uncaughtException', (err) => {
    console.error('🔥 [UncaughtException]', err.message);
    // NO hacer process.exit() — queremos que el servidor siga corriendo
});
process.on('unhandledRejection', (reason) => {
    console.error('🔥 [UnhandledRejection]', reason && reason.message ? reason.message : reason);
});
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const { register, login, authMiddleware } = require('./auth');
const SessionManager = require('./session-manager');
const WorkspaceManager = require('./workspace-manager');
const mediaRoutes = require('./src/routes/media.routes');
const { sendDisconnectAlert } = require('./notifier');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// Fuerza al navegador a no cachear los archivos de la app para asegurar la descarga de las correcciones (JS/CSS/HTML)
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false }));

const sessionManager = new SessionManager(io);
const workspaceManager = new WorkspaceManager();

// =====================================================
// RUTAS DE AUTENTICACIÓN (públicas)
// =====================================================

app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    const result = await register(username, password);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const result = await login(username, password);
    if (result.error) return res.status(401).json(result);
    res.json(result);
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
    res.json({ user: req.user });
});

// =====================================================
// RUTAS PROTEGIDAS
// =====================================================
app.use('/api/workspaces', authMiddleware);
app.use('/api/sessions', authMiddleware);
app.use('/api/media', authMiddleware, mediaRoutes);

// =====================================================
// WORKSPACES
// =====================================================

app.get('/api/workspaces', (req, res) => {
    res.json(workspaceManager.getAll(req.user.id));
});

app.post('/api/workspaces', (req, res) => {
    const { name, description } = req.body;
    const result = workspaceManager.create(req.user.id, name, description);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

app.put('/api/workspaces/:id', (req, res) => {
    const { name, description } = req.body;
    const result = workspaceManager.update(req.user.id, req.params.id, { name, description });
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

app.delete('/api/workspaces/:id', async (req, res) => {
    const result = workspaceManager.delete(req.user.id, req.params.id);
    if (result.error) return res.status(400).json(result);
    for (const sid of result.sessionIds) {
        await sessionManager.deleteSession(sid);
    }
    res.json({ success: true });
});

// =====================================================
// SESIONES
// =====================================================

/** Helper: obtiene todos los sessionIds del usuario actual */
function getUserSessionIds(userId) {
    const workspaces = workspaceManager.getAll(userId);
    const ids = [];
    for (const ws of workspaces) {
        ids.push(...ws.sessionIds);
    }
    return [...new Set(ids)]; // Unique
}

/** Obtener sesiones de un workspace específico */
app.get('/api/sessions', (req, res) => {
    const { workspaceId } = req.query;
    let sessionIds;

    if (workspaceId) {
        // Filtrar por workspace específico
        const workspaces = workspaceManager.getAll(req.user.id);
        const ws = workspaces.find(w => w.id === workspaceId);
        sessionIds = ws ? ws.sessionIds : [];
    } else {
        sessionIds = getUserSessionIds(req.user.id);
    }

    sessionManager.loadUserSessions(req.user.id, sessionIds);
    res.json(sessionManager.getUserSessions(sessionIds));
});

/** Crear nueva sesión en un workspace */
app.post('/api/sessions', async (req, res) => {
    const { name, workspaceId } = req.body;

    if (!workspaceId) {
        return res.status(400).json({ error: 'workspaceId es requerido' });
    }

    const workspaces = workspaceManager.getAll(req.user.id);
    const ws = workspaces.find(w => w.id === workspaceId);
    if (!ws) {
        return res.status(404).json({ error: 'Workspace no encontrado' });
    }

    const sessionId = 'session_' + Date.now();
    const result = await sessionManager.createSession(
        sessionId, req.user.id,
        name || `Cuenta ${ws.sessionIds.length + 1}`
    );

    if (!result.error) {
        workspaceManager.addSession(req.user.id, workspaceId, sessionId);
    }

    res.json(result);
});

/** Eliminar una sesión */
app.delete('/api/sessions/:id', async (req, res) => {
    const allIds = getUserSessionIds(req.user.id);
    if (!allIds.includes(req.params.id)) {
        return res.status(403).json({ error: 'No autorizado' });
    }

    // Primero eliminar de todos los workspaces
    const workspaces = workspaceManager.getAll(req.user.id);
    for (const ws of workspaces) {
        if (ws.sessionIds.includes(req.params.id)) {
            workspaceManager.removeSession(req.user.id, ws.id, req.params.id);
        }
    }

    // Luego eliminar la sesión del manager
    const result = await sessionManager.deleteSession(req.params.id);
    res.json(result);
});

/** Reconectar sesión */
app.post('/api/sessions/:id/reconnect', async (req, res) => {
    const allIds = getUserSessionIds(req.user.id);
    if (!allIds.includes(req.params.id)) {
        return res.status(403).json({ error: 'No autorizado' });
    }
    const result = await sessionManager.reconnectSession(req.params.id);
    res.json(result);
});

/** Obtener chats */
app.get('/api/sessions/:id/chats', async (req, res) => {
    const allIds = getUserSessionIds(req.user.id);
    if (!allIds.includes(req.params.id)) {
        return res.status(403).json({ error: 'No autorizado' });
    }
    const result = await sessionManager.getChats(req.params.id);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

/** Obtener mensajes */
app.get('/api/sessions/:id/chats/:chatId/messages', async (req, res) => {
    const allIds = getUserSessionIds(req.user.id);
    if (!allIds.includes(req.params.id)) {
        return res.status(403).json({ error: 'No autorizado' });
    }
    const limit = parseInt(req.query.limit) || 50;
    const result = await sessionManager.getMessages(req.params.id, req.params.chatId, limit);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

/** Eliminar un chat específico */
app.delete('/api/sessions/:id/chats/:chatId', async (req, res) => {
    const allIds = getUserSessionIds(req.user.id);
    if (!allIds.includes(req.params.id)) {
        return res.status(403).json({ error: 'No autorizado' });
    }
    const result = await sessionManager.deleteChat(req.params.id, decodeURIComponent(req.params.chatId));
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

/** Descargar media de un mensaje (lazy loading) */
app.get('/api/sessions/:id/chats/:chatId/messages/:msgId/media', async (req, res) => {
    const allIds = getUserSessionIds(req.user.id);
    if (!allIds.includes(req.params.id)) {
        return res.status(403).json({ error: 'No autorizado' });
    }

    const result = await sessionManager.getMediaFromChat(
        req.params.id,
        decodeURIComponent(req.params.chatId),
        decodeURIComponent(req.params.msgId)
    );

    if (result.error) {
        return res.status(400).json(result);
    }

    // Nueva Arquitectura -> Si tenemos stream directo a MinIO
    if (result.isMinioStream) {
        const storage = require('./src/services/storage');
        try {
            const stream = await storage.getFileStream(result.bucket, result.objectKey);
            res.set('Content-Type', result.mimetype);
            res.set('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year

            if (result.filename && result.filename !== 'null') {
                const encodedFilename = encodeURIComponent(result.filename);
                res.set('Content-Disposition', `inline; filename*=UTF-8''${encodedFilename}`);
            }

            return stream.pipe(res);
        } catch (e) {
            console.error(`[Server] Error MinIO Stream para ${result.objectKey}:`, e.message);
            return res.status(500).json({ error: 'Error procesando media desde MinIO', details: e.message });
        }
    }

    // Return binary data with correct content type (Backwards compatibility mode)
    const buffer = Buffer.from(result.data, 'base64');
    res.set('Content-Type', result.mimetype);
    res.set('Content-Length', buffer.length);
    if (result.filename) {
        // Use encodeURIComponent to handle non-ASCII characters in filename
        const encodedFilename = encodeURIComponent(result.filename);
        res.set('Content-Disposition', `inline; filename*=UTF-8''${encodedFilename}`);
    }
    res.set('Cache-Control', 'public, max-age=86400'); // Cache 24h
    res.send(buffer);
});

// =====================================================
// NOTIFICACIONES POR CORREO — Desconexión de sesiones
// =====================================================
sessionManager.on('session_disconnected', async ({ sessionId, phone, name, reason }) => {
    try {
        // Buscar en todos los usuarios el workspace que contiene esta sesión
        // WorkspaceManager usa archivos por userId, necesitamos buscar en todos
        const dataDir = require('path').join(__dirname, 'data');
        const fs = require('fs');
        let workspaceName = null;

        if (fs.existsSync(dataDir)) {
            const userDirs = fs.readdirSync(dataDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);

            for (const userId of userDirs) {
                const workspaces = workspaceManager.getAll(userId);
                const found = workspaces.find(ws => ws.sessionIds && ws.sessionIds.includes(sessionId));
                if (found) {
                    workspaceName = found.name;
                    break;
                }
            }
        }

        console.log(`📧 [Server] Desconexión detectada: ${name || sessionId} (+${phone}), workspace: ${workspaceName || 'N/A'}, razón: ${reason}`);
        await sendDisconnectAlert(sessionId, phone, name, workspaceName);
    } catch (err) {
        console.error('📧 [Server] Error al procesar notificación de desconexión:', err.message);
    }
});

// =====================================================
// SOCKET.IO
// =====================================================
io.on('connection', (socket) => {
    console.log('🌐 Client connected:', socket.id);
    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// =====================================================
// INICIAR SERVIDOR
// =====================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║   WhatsApp Multi-Session Manager v2.1        ║
║   http://localhost:${PORT}                       ║
╚══════════════════════════════════════════════╝
    `);
});

// =====================================================
// APAGADO ORDENADO (Graceful Shutdown)
// Evita enviar correos de alerta falsos al apagar
// el servidor con docker compose down/stop o Ctrl+C
// =====================================================
async function handleShutdown(signal) {
    console.log(`\n🛑 Señal ${signal} recibida. Apagando servidor de forma ordenada...`);

    // 1. Apagar sesiones de WhatsApp sin disparar correos
    await sessionManager.gracefulShutdown();

    // 2. Cerrar servidor HTTP
    server.close(() => {
        console.log('🛑 Servidor HTTP cerrado.');
        process.exit(0);
    });

    // Forzar salida después de 15 segundos si algo cuelga
    setTimeout(() => {
        console.error('⚠️ Apagado forzado después de 15s');
        process.exit(1);
    }, 15000);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM')); // Docker stop/down
process.on('SIGINT', () => handleShutdown('SIGINT'));   // Ctrl+C
