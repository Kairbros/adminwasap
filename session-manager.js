/**
 * ============================================================
 * session-manager.js — Gestor de Sesiones WhatsApp
 * ============================================================
 * Maneja múltiples instancias de whatsapp-web.js, cada una con
 * su propia autenticación QR. Solo lectura (visualización).
 * 
 * OPTIMIZACIÓN: No descarga fotos de perfil ni media al listar
 * chats/mensajes para máxima velocidad de carga.
 * ============================================================
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { mediaQueue } = require('./src/services/queue');

class SessionManager extends EventEmitter {
    /**
     * @param {Object} io - Instancia de Socket.IO para emit de eventos
     */
    constructor(io) {
        super(); // EventEmitter
        this.io = io;
        this.sessions = new Map();

        this.baseDir = path.join(__dirname, 'data');
        this.sessionsDir = path.join(this.baseDir, 'sessions');
        this.mediaCacheDir = path.join(this.baseDir, 'media_cache');
        this.revokedDir = path.join(this.baseDir, 'revoked');
        this.messageStoreDir = path.join(this.baseDir, 'message_store'); // Nuevo directorio para todos los mensajes
        this._initDirs();

        // In-memory cache for message stores (avoids reading/writing full JSON on every message)
        this._messageStoreCache = new Map();
        this._storeDirtyFlags = new Set();
        // Flush dirty stores to disk every 5 seconds
        this._storeFlushInterval = setInterval(() => this._flushMessageStores(), 5000);

        // 🚀 In-Memory Media Queue
        this.mediaQueue = [];
        this.isProcessingMedia = false;

        // 🛑 Graceful Shutdown — evita correos falsos al apagar el servidor
        this.isShuttingDown = false;
    }

    /**
     * Apagado ordenado: marca el servidor como "apagándose" para
     * que las desconexiones NO disparen correos de alerta.
     * Guarda stores pendientes y destruye clientes de WhatsApp.
     */
    async gracefulShutdown() {
        console.log('🛑 [SessionManager] Graceful shutdown iniciado...');
        this.isShuttingDown = true;

        // Guardar message stores pendientes a disco
        this._flushMessageStores();

        // Destruir todos los clientes de WhatsApp sin disparar alertas
        const destroyPromises = [];
        for (const [sid, session] of this.sessions) {
            if (session.client) {
                destroyPromises.push(
                    session.client.destroy()
                        .then(() => console.log(`   ✅ Cliente ${sid} cerrado`))
                        .catch(e => console.log(`   ⚠️ Error cerrando ${sid}: ${e.message}`))
                );
            }
        }
        await Promise.allSettled(destroyPromises);

        clearInterval(this._storeFlushInterval);
        console.log('🛑 [SessionManager] Graceful shutdown completado.');
    }

    // ==================== SESSION METADATA (name, phone) ====================

    _getSessionMetaPath(sessionId) {
        return path.join(this.sessionsDir, `${sessionId}_meta.json`);
    }

    _saveSessionMeta(sessionId, name, phone) {
        try {
            fs.writeFileSync(this._getSessionMetaPath(sessionId), JSON.stringify({ name, phone }), 'utf8');
        } catch (e) {
            console.error(`Error saving meta for ${sessionId}:`, e.message);
        }
    }

    _loadSessionMeta(sessionId, defaultName) {
        try {
            const fp = this._getSessionMetaPath(sessionId);
            if (fs.existsSync(fp)) {
                const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
                if (data.name) return data;
            }
        } catch (e) { }
        return { name: defaultName, phone: '' };
    }

    /**
     * Helper to reliably extract message data, catching viewOnceMessageV2 
     * missing properties from whatsapp-web.js
     */
    _extractMessageData(msg, stored = null, revoked = null) {
        let isViewOnce = msg.isViewOnce || false;
        let body = msg.body || '';
        let hasMedia = msg.hasMedia || false;
        let type = msg.type || 'chat';
        let pollOptions = msg.pollOptions || null;
        let location = msg.location || null;
        let vcard = msg.vcard || null;

        if (stored) {
            isViewOnce = isViewOnce || stored.isViewOnce;
            body = body || stored.body || '';
            hasMedia = hasMedia || stored.hasMedia;
            if (stored.type && stored.type !== 'chat' && stored.type !== 'unknown') type = stored.type;
            pollOptions = pollOptions || stored.pollOptions;
            location = location || stored.location;
            vcard = vcard || stored.vcard;
        }

        if (revoked) {
            isViewOnce = isViewOnce || revoked.isViewOnce;
            body = body || revoked.body || '';
            hasMedia = hasMedia || revoked.hasMedia;
            if (revoked.type && revoked.type !== 'chat' && revoked.type !== 'unknown') type = revoked.type;
            pollOptions = pollOptions || revoked.pollOptions;
            location = location || revoked.location;
            vcard = vcard || revoked.vcard;
        }

        if (msg._data) {
            if (msg._data.isViewOnce || msg._data.viewOnce) isViewOnce = true;

            if (msg._data.message) {
                const dm = msg._data.message;

                // Caso 1: wrapper viewOnceMessage / viewOnceMessageV2
                const voBase = dm.viewOnceMessage || dm.viewOnceMessageV2 || dm.viewOnceMessageV2Extension;
                if (voBase) {
                    isViewOnce = true;
                    if (voBase.message) {
                        if (voBase.message.imageMessage) {
                            type = 'image';
                            if (!body) body = voBase.message.imageMessage.caption || '';
                        } else if (voBase.message.videoMessage) {
                            type = 'video';
                            if (!body) body = voBase.message.videoMessage.caption || '';
                        } else if (voBase.message.audioMessage) {
                            type = 'audio';
                        } else if (voBase.message.videoWithCaptionMessage) {
                            type = 'video';
                        }
                    }
                }

                // Caso 2: viewOnce=true directamente en el tipo de mensaje interno
                // (WhatsApp moderno envía así los audios/imágenes/videos temporales)
                const innerTypes = [
                    { key: 'imageMessage', t: 'image' },
                    { key: 'videoMessage', t: 'video' },
                    { key: 'audioMessage', t: 'audio' },
                    { key: 'documentMessage', t: 'document' },
                ];
                for (const { key, t } of innerTypes) {
                    if (dm[key] && (dm[key].viewOnce === true || dm[key].viewOnce === 1)) {
                        isViewOnce = true;
                        if (!body && dm[key].caption) body = dm[key].caption;
                        break;
                    }
                }
            }

            // Caso 3: media_data con flag viewOnce
            if (msg._data.media_data && (msg._data.media_data.isViewOnce || msg._data.media_data.viewOnce)) {
                isViewOnce = true;
            }
        }

        // Caso 4: el tipo ya viene marcado en el store como 'view_once'
        if (type === 'view_once') isViewOnce = true;

        // Forzar hasMedia para documentos o audios que a veces WWeb.js no etiqueta bien
        if (type === 'document' || type === 'audio' || type === 'ptt' || type === 'sticker' || type === 'image' || type === 'video') {
            hasMedia = true;
        }

        // Intercept view once explicitly on the backend
        if (isViewOnce || type === 'view_once') {
            type = 'view_once';
            body = 'esto es una imagen temporal';
            hasMedia = false;
        }

        return { isViewOnce, body, hasMedia, type, pollOptions, location, vcard };
    }

    _initDirs() {
        for (const dir of [this.sessionsDir, this.revokedDir, this.messageStoreDir, this.mediaCacheDir]) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
    }
    // ==================== MENSAJE STORE (guarda TODO mensaje al llegar) ====================

    _messageStorePath(sessionId) {
        return path.join(this.messageStoreDir, `${sessionId}.json`);
    }

    _loadMessageStore(sessionId) {
        // Use in-memory cache to avoid reading from disk on every call
        if (this._messageStoreCache.has(sessionId)) {
            return this._messageStoreCache.get(sessionId);
        }
        try {
            const fp = this._messageStorePath(sessionId);
            if (fs.existsSync(fp)) {
                const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
                this._messageStoreCache.set(sessionId, data);
                return data;
            }
        } catch (e) { }
        const empty = {};
        this._messageStoreCache.set(sessionId, empty);
        return empty;
    }

    _saveToMessageStore(sessionId, msgId, msgData) {
        // Write to in-memory cache only — disk flush happens via interval
        const store = this._loadMessageStore(sessionId);
        store[msgId] = msgData;
        this._storeDirtyFlags.add(sessionId);
    }

    /** Flush dirty message stores to disk (called by interval) */
    _flushMessageStores() {
        for (const sessionId of this._storeDirtyFlags) {
            try {
                const store = this._messageStoreCache.get(sessionId);
                if (store) {
                    fs.writeFileSync(this._messageStorePath(sessionId), JSON.stringify(store, null, 2), 'utf8');
                }
            } catch (e) {
                console.error(`Error flushing message store for ${sessionId}:`, e.message);
            }
        }
        this._storeDirtyFlags.clear();
    }

    // ==================== MEDIA CACHE (guarda media al llegar) ====================

    /** Sanitiza el msgId para que sea un nombre de archivo válido en Windows */
    _safeMsgId(msgId) {
        return msgId.replace(/[<>:"\/\\|?*]/g, '_');
    }

    _mediaCachePath(sessionId) {
        const dir = path.join(this.mediaCacheDir, sessionId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    // ==================== MEDIA ID INDEX (maps revoked IDs to original cached IDs) ====================

    _mediaIndexPath(sessionId) {
        return require('path').join(this._mediaCachePath(sessionId), '_id_index.json');
    }

    _loadMediaIndex(sessionId) {
        const indexFile = this._mediaIndexPath(sessionId);
        try {
            if (fs.existsSync(indexFile)) {
                return JSON.parse(fs.readFileSync(indexFile, 'utf8'));
            }
        } catch (e) { }
        return {};
    }

    _saveMediaIndex(sessionId, index) {
        try {
            fs.writeFileSync(this._mediaIndexPath(sessionId), JSON.stringify(index), 'utf8');
        } catch (e) {
            console.error('Error saving media index:', e.message);
        }
    }

    /** Register a message ID in the media index so it can be found even if the ID changes after revocation */
    _registerMediaId(sessionId, msgId) {
        const index = this._loadMediaIndex(sessionId);
        const safe = this._safeMsgId(msgId);
        index[safe] = safe; // self-mapping (canonical entry)
        this._saveMediaIndex(sessionId, index);
    }

    /** Create an alias: when someone requests aliasId, serve the media cached under originalId */
    _aliasMediaId(sessionId, aliasId, originalId) {
        const index = this._loadMediaIndex(sessionId);
        const safeAlias = this._safeMsgId(aliasId);
        const safeOriginal = this._safeMsgId(originalId);
        index[safeAlias] = safeOriginal;
        console.log(`🔗 [MediaIndex] Alias created: ${safeAlias.substring(0, 40)} → ${safeOriginal.substring(0, 40)}`);
        this._saveMediaIndex(sessionId, index);
    }

    /** Resolve an ID through the index, returning the canonical cached ID */
    _resolveMediaId(sessionId, msgId) {
        const index = this._loadMediaIndex(sessionId);
        const safe = this._safeMsgId(msgId);
        return index[safe] || safe; // return alias target or original
    }

    _saveMediaToCache(sessionId, msgId, mimetype, data, filename) {
        try {
            const resolvedSafe = this._resolveMediaId(sessionId, msgId);
            const safe = resolvedSafe; // Use resolved ID (may be an alias to the original cached ID)
            const dir = this._mediaCachePath(sessionId);
            const metaFile = path.join(dir, `${safe}.meta.json`);
            const dataFile = path.join(dir, `${safe}.bin`);
            fs.writeFileSync(metaFile, JSON.stringify({ mimetype, filename: filename || null }), 'utf8');
            fs.writeFileSync(dataFile, Buffer.from(data, 'base64'));
            this._registerMediaId(sessionId, msgId);
            console.log(`📦 Media cached: ${safe} (${mimetype})`);
        } catch (e) {
            console.error(`Error caching media ${msgId}:`, e.message);
        }
    }

    _loadMediaFromCache(sessionId, msgId) {
        try {
            const safe = this._resolveMediaId(sessionId, msgId);
            const rawSafe = this._safeMsgId(msgId); // Keep for old format fallback if necessary
            const dir = this._mediaCachePath(sessionId);
            const metaFile = path.join(dir, `${safe}.meta.json`);
            // Buscar tanto .bin (nuevo) como .data (viejo)
            let dataFile = path.join(dir, `${safe}.bin`);
            if (!fs.existsSync(dataFile)) {
                dataFile = path.join(dir, `${safe}.data`);
            }
            // También buscar con el msgId sin sanitizar (archivos viejos)
            if (!fs.existsSync(metaFile)) {
                const oldMeta = path.join(dir, `${msgId}.meta.json`);
                const oldData1 = path.join(dir, `${msgId}.data`);
                const oldData2 = path.join(dir, `${msgId}.bin`);
                if (fs.existsSync(oldMeta)) {
                    const oldDataFile = fs.existsSync(oldData1) ? oldData1 : (fs.existsSync(oldData2) ? oldData2 : null);
                    if (oldDataFile) {
                        const meta = JSON.parse(fs.readFileSync(oldMeta, 'utf8'));
                        const data = fs.readFileSync(oldDataFile).toString('base64');
                        console.log(`📂 Cache hit (old format): ${msgId}, size=${data.length}`);
                        return { mimetype: meta.mimetype, data, filename: meta.filename };
                    }
                }
                // The filename might have been truncated OR the msgId differs slightly in cache (e.g. missing author LID).
                // Extract the unique message hash which is typically the 3rd part: fromMe_chatId_HASH_authorLid
                const files = fs.readdirSync(dir);
                const parts = safe.split('_');
                const hash = parts.length >= 3 ? parts[2] : safe;

                let metaMatch = null;
                if (hash && hash.length > 15) {
                    metaMatch = files.find(f => f.endsWith('.meta.json') && f.includes(hash));
                } else {
                    metaMatch = files.find(f => f.endsWith('.meta.json') && f.includes(safe.substring(0, 35)));
                }

                if (!metaMatch) {
                    console.log(`📂 Cache: No meta file found. hash=${hash}, safe=${safe}`);
                    return null;
                }

                // If found via fallback match, use that file base
                const baseName = metaMatch.replace('.meta.json', '');
                const fallbackMeta = path.join(dir, metaMatch);
                let fallbackData = path.join(dir, `${baseName}.bin`);
                if (!fs.existsSync(fallbackData)) fallbackData = path.join(dir, `${baseName}.data`);

                if (fs.existsSync(fallbackMeta) && fs.existsSync(fallbackData)) {
                    const meta = JSON.parse(fs.readFileSync(fallbackMeta, 'utf8'));
                    const data = fs.readFileSync(fallbackData).toString('base64');
                    console.log(`📂 Cache hit (fuzzy fallback): ${msgId}, size=${data.length}`);
                    return { mimetype: meta.mimetype, data, filename: meta.filename };
                }
            }
            if (fs.existsSync(metaFile) && fs.existsSync(dataFile)) {
                const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
                const data = fs.readFileSync(dataFile).toString('base64');
                console.log(`📂 Cache hit: ${msgId}, size=${data.length}, mime=${meta.mimetype}`);
                return { mimetype: meta.mimetype, data, filename: meta.filename };
            }
            console.log(`📂 Cache miss: meta=${fs.existsSync(metaFile)}, data=${fs.existsSync(dataFile)}, safe=${safe}`);
        } catch (e) {
            console.error(`Error loading cached media ${msgId}:`, e.message);
        }
        return null;
    }

    /**
     * Encola un archivo multimedia para ser descargado y cacheado.
     * Si falla, se vuelve a encolar con retraso exponencial asegurando que jamás se pierda
     * si el usuario lo borra demasiado rápido.
     */
    enqueueMediaDownload(sessionId, msgId, msg, attempt = 1) {
        this.mediaQueue.push({ sessionId, msgId, msg, attempt, addedAt: Date.now() });
        this.processMediaQueue(); // Activar el worker si estaba inactivo
    }

    async processMediaQueue() {
        if (this.isProcessingMedia || this.mediaQueue.length === 0) return;
        this.isProcessingMedia = true;

        while (this.mediaQueue.length > 0) {
            // Sacar el primer elemento de la cola (FIFO)
            const task = this.mediaQueue.shift();
            const { sessionId, msgId, msg, attempt } = task;

            try {
                // Cálculo de retardo (Backoff Exponencial)
                let delay = 0;
                if (msg.fromMe && attempt === 1) {
                    delay = 1500; // Dar tiempo a un audio saliente recién grabado
                } else if (attempt > 1) {
                    // Esperas: Intento 2 = 2s, Intento 3 = 4s, Intento 4 = 8s, Intento 5 = 16s
                    delay = Math.pow(2, attempt - 1) * 1000;
                }

                if (delay > 0) {
                    await new Promise(r => setTimeout(r, delay));
                }

                console.log(`⏳ [MediaQueue] Procesando descarga: ${msgId} (Intento ${attempt})`);
                const media = await msg.downloadMedia();

                if (media && media.data) {
                    // Escribir temp file y encolar a Redis
                    const tempFilePath = path.join(__dirname, `data/tmp_dl_${msgId.replace(/[^a-zA-Z0-9]/g, '_')}`);
                    fs.writeFileSync(tempFilePath, Buffer.from(media.data, 'base64'));

                    await mediaQueue.add('processMedia', {
                        sessionId,
                        msgId,
                        mimetype: media.mimetype || 'application/octet-stream',
                        filename: media.filename || null,
                        tempFilePath
                    });

                    console.log(`✅ [MediaQueue] Descarga completa. Encolado a Redis para MinIO: ${msgId}`);
                } else {
                    throw new Error("La carga útil (data) de la multimedia vino vacía de WhatsApp.");
                }
            } catch (e) {
                console.error(`⚠️ [MediaQueue] Fallo al descargar ${msgId}: ${e.message}`);

                if (attempt < 5) {
                    console.log(`🔄 [MediaQueue] Re-encolando ${msgId} para un futuro intento ${attempt + 1}...`);
                    this.enqueueMediaDownload(sessionId, msgId, msg, attempt + 1);
                } else {
                    console.error(`❌ [MediaQueue] Abortado permanentemente. Se excedieron los 5 intentos para ${msgId}`);
                }
            }
        }

        this.isProcessingMedia = false;
    }

    // ==================== REVOKED MESSAGES ====================

    _revokedFilePath(sessionId) {
        return path.join(this.revokedDir, `${sessionId}.json`);
    }

    _loadRevokedMessages(sessionId) {
        try {
            const fp = this._revokedFilePath(sessionId);
            if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
        } catch (e) { }
        return {};
    }

    _saveRevokedMessage(sessionId, messageId, messageData) {
        const revoked = this._loadRevokedMessages(sessionId);
        const existing = revoked[messageId];

        let finalData = { ...messageData };

        if (existing) {
            finalData = { ...existing }; // Keep existing as base

            // Intelligent overwrite
            Object.keys(messageData).forEach(key => {
                const newVal = messageData[key];
                const oldVal = existing[key];

                // Ignore completely empty/null values
                if (newVal === undefined || newVal === null || newVal === '') return;

                // Prevent arrays wipeout
                if (Array.isArray(newVal) && newVal.length === 0 && Array.isArray(oldVal) && oldVal.length > 0) return;

                // SPECIAL RULE: Never let a 'false' overwrite a 'true'
                if (typeof newVal === 'boolean' && newVal === false && oldVal === true) return;

                // SPECIAL RULE: Never let 'chat' or 'unknown' overwrite a rich media type
                if (key === 'type' && (newVal === 'chat' || newVal === 'unknown') && oldVal !== 'chat' && oldVal !== 'unknown' && oldVal !== undefined) return;

                // Safely apply the new value
                finalData[key] = newVal;
            });

            // Preservar el badge 'everyone' porque 'me' es un downgrade
            if (existing.revokeType === 'everyone') {
                finalData.revokeType = 'everyone';
            }
        }

        revoked[messageId] = { ...finalData, revokedAt: Date.now() };
        try {
            fs.writeFileSync(this._revokedFilePath(sessionId), JSON.stringify(revoked, null, 2), 'utf8');
        } catch (e) {
            console.error(`Error saving revoked message for ${sessionId}:`, e.message);
        }
    }

    /**
     * Registra sesiones del usuario en el Map (sin inicializar cliente)
     * @param {string} userId - ID del usuario
     * @param {string[]} sessionIds - IDs de las sesiones
     */
    loadUserSessions(userId, sessionIds) {
        for (const sid of sessionIds) {
            if (!this.sessions.has(sid)) {
                // Recuperar metadatos (name, phone) guardados para no perderlos tras reinicio
                const meta = this._loadSessionMeta(sid, sid);
                this.sessions.set(sid, {
                    id: sid,
                    userId: userId,
                    name: meta.name || sid,
                    phone: meta.phone || '',
                    status: 'disconnected',
                    reason: null, // Track the precise reason of disconnect
                    client: null,
                    qr: null
                });
            }
        }
    }

    /**
     * Obtiene las sesiones que coinciden con los IDs dados
     * @param {string[]} sessionIds - IDs a buscar
     * @returns {Array} Lista de info de sesiones
     */
    getUserSessions(sessionIds) {
        const result = [];
        for (const sid of sessionIds) {
            const session = this.sessions.get(sid);
            if (session) {
                result.push({
                    id: session.id,
                    name: session.name,
                    phone: session.phone,
                    status: session.status,
                    hasQR: !!session.qr
                });
            }
        }
        return result;
    }

    /**
     * Fuerza la desconexión simulando el evento desde el cliente.
     * Útil cuando detectamos un cliente bloqueado/muerto pero
     * whatsapp-web.js no disparó el evento `disconnected` naturalmente.
     */
    _forceDisconnect(sessionId, reason = 'LOGOUT') {
        const session = this.sessions.get(sessionId);
        if (session && session.client) {
            console.log(`⚡ [_forceDisconnect] Forzando evento disconnect interno para ${sessionId}...`);
            session.client.emit('disconnected', reason);
        }
    }

    /**
     * Crea una nueva sesión de WhatsApp
     * @param {string} sessionId - ID único
     * @param {string} userId - ID del usuario propietario
     * @param {string} name - Nombre amigable
     * @returns {Object} Info de la sesión creada
     */
    async createSession(sessionId, userId, name) {
        if (this.sessions.has(sessionId)) {
            const existing = this.sessions.get(sessionId);
            if (existing.status === 'connected') {
                return { error: 'Sesión ya conectada' };
            }
            if (existing.client) {
                try { await existing.client.destroy(); } catch (e) { }
            }
        }

        const session = {
            id: sessionId,
            userId: userId,
            name: name || sessionId,
            phone: '',
            status: 'initializing',
            reason: null,
            client: null,
            qr: null
        };

        this.sessions.set(sessionId, session);
        this._saveSessionMeta(sessionId, session.name, session.phone);
        this._initClient(sessionId);
        return { id: sessionId, status: 'initializing' };
    }

    /**
     * Inicializa el cliente de WhatsApp Web para una sesión
     * @param {string} sessionId - ID de la sesión
     * @private
     */
    _initClient(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: sessionId,
                dataPath: this.sessionsDir
            }),
            puppeteer: {
                headless: true,
                protocolTimeout: 180000, // 3 minutes — prevents 'Runtime.callFunctionOn timed out'
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-default-apps',
                    '--disable-translate',
                    '--disable-sync',
                    '--metrics-recording-only',
                    '--no-default-browser-check',
                    '--disable-background-timer-throttling'
                ]
            }
        });

        // QR generado
        client.on('qr', async (qr) => {
            try {
                const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                session.qr = qrDataUrl;
                session.status = 'waiting_qr';
                this.io.emit('qr', { sessionId, qr: qrDataUrl });
                this.io.emit('session_update', this._getSessionInfo(sessionId));
            } catch (err) {
                console.error(`QR error ${sessionId}:`, err);
            }
        });

        // Cliente listo
        client.on('ready', async () => {
            // BUGFIX: Prevent ghost "ready" events from firing up if the session was explicitly disconnected
            if (session.status === 'disconnected' || session.status === 'auth_failed') {
                console.log(`⚠️ Ghost 'ready' event ignored for ${sessionId} because status is ${session.status}`);
                return;
            }

            // BUGFIX: Debounce rapid-fire ghost ready events (whatsapp-web.js bug)
            const now = Date.now();
            if (session._lastReadyAt && (now - session._lastReadyAt) < 10000) {
                console.log(`⚠️ Ghost 'ready' event debounced for ${sessionId} (fired ${now - session._lastReadyAt}ms after last)`);
                return;
            }
            session._lastReadyAt = now;

            session.status = 'connected';
            session.qr = null;
            try {
                const info = client.info;
                session.phone = info.wid.user;
                if (session.name === sessionId) {
                    session.name = info.pushname || session.name;
                }
                this._saveSessionMeta(sessionId, session.name, session.phone);
            } catch (e) { }
            this.io.emit('ready', { sessionId });
            this.io.emit('session_update', this._getSessionInfo(sessionId));
            console.log(`✅ Session ${sessionId} connected (${session.phone})`);

            // Pre-cache chats in background so they load instantly when user clicks
            setImmediate(async () => {
                try {
                    if (session.status !== 'connected') return; // Guard
                    console.log(`📦 Pre-caching chats for ${sessionId}...`);
                    session._cachedChats = await this._fastFetchChats(session.client);
                    session._chatsCachedAt = Date.now();
                    console.log(`✅ Cached ${session._cachedChats.length} chats for ${sessionId}`);
                    this.io.emit('chats_ready', { sessionId, count: session._cachedChats.length });
                } catch (e) {
                    console.error(`⚠️ Could not pre-cache chats for ${sessionId}:`, e.message);

                    // BUGFIX: Si el error es 'Execution context destroyed' o 'Cannot read properties',
                    // el cliente está muerto. Forzar desconexión para disparar correo de alerta.
                    if (e.message && (e.message.includes('Execution context') || e.message.includes('Cannot read properties'))) {
                        console.log(`🔌 [AutoDetect] Cliente muerto detectado para ${sessionId}. Forzando desconexión...`);
                        this._forceDisconnect(sessionId, 'LOGOUT');
                        return; // No reintentar
                    }

                    // Retry once after 10 seconds (solo si no es un cliente muerto)
                    setTimeout(async () => {
                        try {
                            if (session.status !== 'connected') return; // Guard
                            console.log(`🔁 Retrying pre-cache for ${sessionId}...`);
                            session._cachedChats = await this._fastFetchChats(session.client);
                            session._chatsCachedAt = Date.now();
                            console.log(`✅ Retry cached ${session._cachedChats.length} chats for ${sessionId}`);
                            this.io.emit('chats_ready', { sessionId, count: session._cachedChats.length });
                        } catch (e2) {
                            console.error(`❌ Retry pre-cache also failed for ${sessionId}:`, e2.message);
                            // Si el retry también falla con error de contexto, forzar desconexión
                            if (e2.message && (e2.message.includes('Execution context') || e2.message.includes('Cannot read properties'))) {
                                console.log(`🔌 [AutoDetect] Cliente muerto en retry para ${sessionId}. Forzando desconexión...`);
                                this._forceDisconnect(sessionId, 'LOGOUT');
                            }
                        }
                    }, 10000);
                }
            });
        });

        // Autenticado
        client.on('authenticated', () => {
            session.status = 'authenticated';
            session.qr = null;
            this.io.emit('session_update', this._getSessionInfo(sessionId));
        });

        // Fallo de auth (sucede a veces cuando se cierra sesión desde el teléfono y se rechaza un token viejo)
        client.on('auth_failure', async (msg) => {
            session.status = 'auth_failed';
            session.qr = null;
            this.io.emit('session_update', this._getSessionInfo(sessionId));
            this.io.emit('disconnected', { sessionId, reason: 'LOGOUT' }); // Treat as explicit logout for UI purposes
            console.error(`❌ Auth failure ${sessionId}:`, msg);

            // Emitir evento para enviar email de alerta
            if ((session.phone || session.name) && !this.isShuttingDown) {
                this.emit('session_disconnected', {
                    sessionId,
                    phone: session.phone || 'Desconocido',
                    name: session.name || sessionId,
                    reason: 'auth_failure'
                });
            } else if (this.isShuttingDown) {
                console.log(`📧 [Notifier] Correo omitido para ${sessionId}: servidor apagándose (no es desconexión real)`);
            }

            try { await client.destroy(); } catch (e) { }
        });

        // Desconectado
        client.on('disconnected', async (reason) => {
            console.log(`🔔 [DEBUG] Evento 'disconnected' recibido para ${sessionId}, reason: ${reason}`);
            if (session.status === 'disconnected') return; // Prevent duplicate

            session.status = 'disconnected';
            session.qr = null;

            // Cuando se cierra desde el teléfono (desvincular), a veces tira NAVIGATION u otros.
            // Para asegurar la bolita roja de "Desconexión Manual", forzaremos LOGOUT 
            // artificialmente si detectamos que fue expulsado por auth o unpaired
            const finalReason = (reason === 'LOGOUT' || reason === 'NAVIGATION' || reason === 'UNPAIRED' || reason === 'UNPAIRED_IDLE') ? 'LOGOUT' : reason;
            session.reason = finalReason;

            this.io.emit('disconnected', { sessionId, reason: finalReason });
            this.io.emit('session_update', this._getSessionInfo(sessionId));
            console.log(`🔌 Session ${sessionId} disconnected:`, finalReason);

            // Emitir evento local para que server.js pueda enviar notificaciones
            // Solo notificar si la sesión tenía un número vinculado O un nombre (estaba realmente conectada)
            // Y NO estamos en proceso de apagado del servidor (evita correos falsos)
            if ((session.phone || session.name) && !this.isShuttingDown) {
                this.emit('session_disconnected', {
                    sessionId,
                    phone: session.phone || 'Desconocido',
                    name: session.name || sessionId,
                    reason: finalReason
                });
            } else if (this.isShuttingDown) {
                console.log(`📧 [Notifier] Correo omitido para ${sessionId}: servidor apagándose (no es desconexión real)`);
            }

            // If the user manually logged out from their phone, forcefully kill the client
            // to prevent whatsapp-web.js from ghost-reconnecting and triggering 'ready'
            if (finalReason === 'LOGOUT') {
                try {
                    await client.destroy();
                } catch (e) {
                    console.log(`🔌 Client destroy error for ${sessionId}:`, e.message);
                }
            }
        });

        // Estado de cambio (Interceptar UNPAIRED cuando lo desvinculan desde el celular directamente)
        client.on('change_state', async (state) => {
            console.log(`🔄 Session ${sessionId} state changed:`, state);
            if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE' || state === 'UNLAUNCHED' || state === 'TIMEOUT') {
                // El dispositivo fue desvinculado manualmente o mató la sesión agresivamente
                client.emit('disconnected', 'LOGOUT');
            }
        });

        // Nuevo mensaje — guardar contenido + cachear media proactivamente
        client.on('message', async (msg) => {
            const msgId = msg.id._serialized;
            const chatId = msg.fromMe ? msg.to : msg.from;

            // Resolver autor real para grupos (LID -> número de teléfono)
            let authorName = null;
            if (msg.author) {
                try {
                    const contact = await client.getContactById(msg.author);
                    authorName = contact.pushname || contact.name || contact.number || msg.author.split('@')[0];
                } catch (e) {
                    authorName = msg.author.split('@')[0];
                }
            }

            const extracted = this._extractMessageData(msg);

            // LOG DIAGNÓSTICO: ver estructura de mensajes view_once
            if (extracted.isViewOnce || msg.isViewOnce || msg.type === 'view_once' ||
                (msg._data && (msg._data.isViewOnce || msg._data.viewOnce))) {
                console.log(`🔍 [ViewOnce] Mensaje temporal detectado: ${msgId}`);
                console.log(`   type: ${msg.type} → extracted.type: ${extracted.type}`);
                console.log(`   isViewOnce: ${msg.isViewOnce} → extracted.isViewOnce: ${extracted.isViewOnce}`);
                if (msg._data && msg._data.message) {
                    const keys = Object.keys(msg._data.message);
                    console.log(`   _data.message keys: ${keys.join(', ')}`);
                }
            } else if (msg.type === 'ptt' || msg.type === 'audio' || msg.type === 'image' || msg.type === 'video') {
                // Log para medias normales — útil para ver si alguna es view_once no detectada
                const dm = msg._data && msg._data.message;
                const innerViewOnce = dm && (
                    (dm.audioMessage && dm.audioMessage.viewOnce) ||
                    (dm.imageMessage && dm.imageMessage.viewOnce) ||
                    (dm.videoMessage && dm.videoMessage.viewOnce)
                );
                if (innerViewOnce) {
                    console.log(`⚠️ [ViewOnce] Media temporal NO detectada como viewOnce: ${msgId}, tipo: ${msg.type}`);
                }
            }

            const msgData = {
                id: msgId,
                body: extracted.body,
                from: msg.from,
                to: msg.to,
                timestamp: msg.timestamp,
                fromMe: msg.fromMe,
                type: extracted.type,
                hasMedia: extracted.hasMedia,
                isViewOnce: extracted.isViewOnce,
                pollOptions: extracted.pollOptions,
                author: msg.author || null,
                authorName: authorName,
                mentionedIds: msg.mentionedIds || [],
                chatId: chatId
            };

            // LOG DE DIAGNÓSTICO PARA EVENTOS (por si el tipo es diferente al esperado)
            if (msg.type !== 'chat' && msg.type !== 'image' && msg.type !== 'video' && msg.type !== 'audio' && msg.type !== 'ptt' && msg.type !== 'sticker' && msg.type !== 'vcard' && msg.type !== 'location') {
                console.log(`[DEBUG EVENTO] Recibido mensaje tipo: ${msg.type}, Body: ${msg.body}`);
            }

            // Guardar en message store para tener contenido original siempre
            this._saveToMessageStore(sessionId, msgId, msgData);

            // Cachear media en background de forma robusta a través de la Cola de Tareas
            if (extracted.hasMedia) {
                // Bugfix: Para evitar que si se elimina súper rápido no se alcance a procesar
                // hacemos "downloadMedia" inline primero y guardamos en caché temporal
                try {
                    const media = await msg.downloadMedia();
                    if (media && media.data) {
                        this._saveMediaToCache(sessionId, msgId, media.mimetype, media.data, media.filename);
                        console.log(`🚀 [FastUpload] Incoming media cached instantly to prevent Race Condition: ${msgId}`);
                    }
                } catch (e) {
                    console.error(`⚠️ [FastUpload] Error buffering incoming media for ${msgId}:`, e.message);
                }

                this.enqueueMediaDownload(sessionId, msgId, msg);
            }

            this.io.emit('new_message', { sessionId, chatId, message: msgData });
        });

        // También cachear mensajes salientes
        client.on('message_create', async (msg) => {
            if (!msg.fromMe) return;
            const msgId = msg.id._serialized;
            const chatId = msg.to;
            const extracted = this._extractMessageData(msg);
            const msgData = {
                id: msgId,
                body: extracted.body,
                from: msg.from,
                to: msg.to,
                timestamp: msg.timestamp,
                fromMe: msg.fromMe,
                type: extracted.type,
                hasMedia: extracted.hasMedia,
                isViewOnce: extracted.isViewOnce,
                pollOptions: extracted.pollOptions,
                author: msg.author || null,
                authorName: null,
                mentionedIds: msg.mentionedIds || [],
                chatId: chatId
            };
            this._saveToMessageStore(sessionId, msgId, msgData);

            if (extracted.hasMedia) {
                // Bugfix: Para mensajes salientes, si se revoca muy rápido (antes de que la cola procese),
                // el archivo se pierde porque no dio tiempo a descargar. Hacemos "downloadMedia" inline
                // primero y guardamos en caché temporal.
                try {
                    const media = await msg.downloadMedia();
                    if (media && media.data) {
                        this._saveMediaToCache(sessionId, msgId, media.mimetype, media.data, media.filename);
                        console.log(`🚀 [FastUpload] Outgoing media cached instantly to prevent Race Condition: ${msgId}`);
                    }
                } catch (e) {
                    console.error(`⚠️ [FastUpload] Error buffering outgoing media for ${msgId}:`, e.message);
                }

                this.enqueueMediaDownload(sessionId, msgId, msg);
            }
        });

        // Mensaje eliminado para todos
        client.on('message_revoke_everyone', async (after, before) => {
            try {
                const msgId = after.id._serialized;
                const stored = this._loadMessageStore(sessionId)[msgId];
                // Determinar chatId correctamente (grupo o individual)
                const chatId = stored ? stored.chatId : (after.fromMe ? after.to : after.from) || after.from;

                // Fallback combinando data disponible antes y después de revocación
                const srcMsg = after || before || {};
                const extracted = this._extractMessageData(srcMsg, stored);
                const originalBody = (before && before.body) ? before.body : extracted.body;

                // Verificamos si en BD o Cache sabíamos que esto tenía Media
                let hasMediaFlag = before ? before.hasMedia : extracted.hasMedia;
                if (!hasMediaFlag && stored && stored.hasMedia) hasMediaFlag = true;

                const originalData = {
                    body: originalBody,
                    from: before ? before.from : (stored ? stored.from : after.from),
                    to: before ? before.to : (stored ? stored.to : after.to),
                    timestamp: before ? before.timestamp : (stored ? stored.timestamp : after.timestamp),
                    fromMe: before ? before.fromMe : (stored ? stored.fromMe : after.fromMe),
                    type: before ? before.type : extracted.type,
                    hasMedia: hasMediaFlag,
                    isViewOnce: stored ? stored.isViewOnce : (after.isViewOnce || !!(after._data && (after._data.isViewOnce || after._data.viewOnce))),
                    pollOptions: before ? before.pollOptions : extracted.pollOptions,
                    location: before ? before.location : extracted.location,
                    vcard: before ? before.vcard : extracted.vcard,
                    author: before ? (before.author || null) : (stored ? stored.author : (after.author || null)),
                    mentionedIds: stored ? stored.mentionedIds : [],
                    chatId: chatId,
                    revokeType: 'everyone'
                };

                // Create media ID alias FIRST: the revoked message ID may differ from the original cached ID
                if (originalData.hasMedia) {
                    if (stored && stored.id && stored.id !== msgId) {
                        this._aliasMediaId(sessionId, msgId, stored.id);
                        // Save Alias to DB
                        try {
                            const db = require('./src/services/db');
                            await db.query('INSERT INTO messages (device_id, remote_jid, message_type, wa_message_id, file_hash, original_file_name, timestamp) SELECT device_id, remote_jid, message_type, $1, file_hash, original_file_name, timestamp FROM messages WHERE wa_message_id = $2 ON CONFLICT DO NOTHING', [msgId, stored.id]);
                        } catch (e) { }
                    }
                    if (before && before.id && before.id._serialized && before.id._serialized !== msgId) {
                        this._aliasMediaId(sessionId, msgId, before.id._serialized);
                        // Save Alias to DB
                        try {
                            const db = require('./src/services/db');
                            await db.query('INSERT INTO messages (device_id, remote_jid, message_type, wa_message_id, file_hash, original_file_name, timestamp) SELECT device_id, remote_jid, message_type, $1, file_hash, original_file_name, timestamp FROM messages WHERE wa_message_id = $2 ON CONFLICT DO NOTHING', [msgId, before.id._serialized]);
                        } catch (e) { }
                    }
                }

                this._saveRevokedMessage(sessionId, msgId, originalData);

                this.io.emit('message_revoked', {
                    sessionId, chatId, messageId: msgId,
                    originalBody, revokeType: 'everyone',
                    hasMedia: hasMediaFlag
                });

                console.log(`🗑️ Message revoked (everyone) in ${sessionId}: ${msgId}`);
            } catch (err) {
                console.error(`Error handling message_revoke_everyone:`, err.message);
            }
        });

        // Mensaje eliminado solo para mí
        client.on('message_revoke_me', async (msg) => {
            try {
                const msgId = msg.id._serialized;
                const stored = this._loadMessageStore(sessionId)[msgId];
                const revoked = this._loadRevokedMessages(sessionId)[msgId];
                const chatId = stored ? stored.chatId : (revoked ? revoked.chatId : ((msg.fromMe ? msg.to : msg.from) || msg.from));

                const extracted = this._extractMessageData(msg, stored, revoked);
                const originalData = {
                    body: extracted.body,
                    from: stored ? stored.from : (revoked ? revoked.from : msg.from),
                    to: stored ? stored.to : (revoked ? revoked.to : msg.to),
                    timestamp: stored ? stored.timestamp : (revoked ? revoked.timestamp : msg.timestamp),
                    fromMe: stored ? stored.fromMe : (revoked ? revoked.fromMe : msg.fromMe),
                    type: extracted.type,
                    hasMedia: extracted.hasMedia,
                    isViewOnce: extracted.isViewOnce,
                    pollOptions: extracted.pollOptions,
                    location: extracted.location,
                    vcard: extracted.vcard,
                    pollVotes: stored ? (stored.pollVotes || []) : (revoked ? (revoked.pollVotes || []) : []),
                    author: stored ? stored.author : (revoked ? revoked.author : (msg.author || null)),
                    mentionedIds: stored ? stored.mentionedIds : (revoked ? revoked.mentionedIds : []),
                    chatId: chatId,
                    revokeType: 'me'
                };

                this._saveRevokedMessage(sessionId, msgId, originalData);

                this.io.emit('message_revoked', {
                    sessionId, chatId, messageId: msgId,
                    originalBody: originalData.body,
                    revokeType: 'me'
                });

                console.log(`🗑️ Message revoked (for me) in ${sessionId}: ${msgId}`);
            } catch (err) {
                console.error(`Error handling message_revoke_me:`, err.message);
            }
        });

        client.on('vote_update', async (vote) => {
            try {
                if (!vote.parentMessage || !vote.parentMessage.id) return;
                const parentId = vote.parentMessage.id._serialized;
                const store = this._loadMessageStore(sessionId);
                if (store[parentId]) {
                    if (!store[parentId].pollVotes) store[parentId].pollVotes = [];
                    // Remove previous votes from this voter
                    store[parentId].pollVotes = store[parentId].pollVotes.filter(v => v.voter !== vote.voter);
                    // Add new vote if they selected options
                    if (vote.selectedOptions && vote.selectedOptions.length > 0) {
                        store[parentId].pollVotes.push({
                            voter: vote.voter,
                            options: vote.selectedOptions.map(opt => opt.name || opt.localName || ''),
                            timestamp: vote.interactedAt
                        });
                    }
                    this._saveToMessageStore(sessionId, parentId, store[parentId]);
                    this.io.emit('poll_vote_update', {
                        sessionId,
                        chatId: store[parentId].chatId,
                        messageId: parentId,
                        pollVotes: store[parentId].pollVotes
                    });
                }
            } catch (err) {
                console.error(`Error handling vote_update:`, err.message);
            }
        });

        session.client = client;

        client.initialize().catch(err => {
            session.status = 'error';
            session.qr = null;
            this.io.emit('session_update', this._getSessionInfo(sessionId));
            console.error(`Error initializing ${sessionId}:`, err.message);
        });
    }

    /**
     * Info serializable de una sesión
     * @private
     */
    _getSessionInfo(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        return {
            id: session.id,
            name: session.name,
            phone: session.phone,
            status: session.status,
            reason: session.reason || null,
            hasQR: !!session.qr
        };
    }

    /**
     * Elimina una sesión completamente
     * @param {string} sessionId - ID de la sesión
     * @returns {Object} Resultado
     */
    async deleteSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return { success: true }; // Already gone

        if (session.client) {
            try { await session.client.logout(); } catch (e) { }
            try { await session.client.destroy(); } catch (e) { }
        }

        this.sessions.delete(sessionId);

        const sessionDir = path.join(this.sessionsDir, `session-${sessionId}`);
        try {
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }
        } catch (e) { }

        return { success: true };
    }

    /** Optimized chat fetching: tries Puppeteer direct access first, then falls back to standard getChats */
    async _fastFetchChats(client) {
        // ====== STRATEGY 1: Direct Puppeteer extraction (ultra-fast, ~1-3 seconds) ======
        try {
            console.log('⚡ [FastFetch] Attempting direct Puppeteer Store extraction...');
            const rawChats = await Promise.race([
                client.pupPage.evaluate(() => {
                    try {
                        const chatStore = (window.Store && window.Store.Chat) || null;
                        if (!chatStore) return { error: 'Store.Chat not found', storeKeys: window.Store ? Object.keys(window.Store).slice(0, 20).join(',') : 'NO_STORE' };

                        const models = typeof chatStore.getModelsArray === 'function'
                            ? chatStore.getModelsArray()
                            : (chatStore._models || Array.from(chatStore.values ? chatStore.values() : []));

                        if (!models || models.length === 0) return { error: 'No chat models found', modelType: typeof chatStore.getModelsArray };

                        return {
                            data: models.map(c => {
                                let lastMsg = null;
                                try {
                                    const msgCollection = c.msgs || c.Msgs;
                                    if (msgCollection) {
                                        const allMsgs = typeof msgCollection.getModelsArray === 'function'
                                            ? msgCollection.getModelsArray()
                                            : (msgCollection._models || []);
                                        if (allMsgs.length > 0) {
                                            const m = allMsgs[allMsgs.length - 1];
                                            lastMsg = {
                                                body: m.body || '',
                                                timestamp: m.t || 0,
                                                fromMe: m.id ? !!m.id.fromMe : false,
                                                type: m.type || 'chat'
                                            };
                                        }
                                    }
                                } catch (e) { /* ignore individual msg errors */ }

                                return {
                                    id: c.id ? c.id._serialized : '',
                                    name: c.formattedTitle || c.name || (c.contact && (c.contact.name || c.contact.pushname)) || (c.id && c.id.user ? (c.id.user.length > 6 && !c.id.user.startsWith('+') ? '+' + c.id.user : c.id.user) : ''),
                                    isGroup: !!c.isGroup,
                                    timestamp: c.t || 0,
                                    unreadCount: c.unreadCount || 0,
                                    lastMessage: lastMsg
                                };
                            }).filter(c => c.id)
                        };
                    } catch (err) {
                        return { error: err.message };
                    }
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Puppeteer evaluate timeout (15s)')), 15000))
            ]);

            if (rawChats && rawChats.data && rawChats.data.length > 0) {
                console.log(`⚡ [FastFetch] SUCCESS: ${rawChats.data.length} chats extracted directly from browser memory`);
                return rawChats.data.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            }

            if (rawChats && rawChats.error) {
                console.error(`⚡ [FastFetch] Puppeteer returned error: ${rawChats.error}`, rawChats.storeKeys || '', rawChats.modelType || '');
            }
        } catch (e) {
            console.error(`⚡ [FastFetch] Puppeteer strategy failed: ${e.message}`);
        }

        // ====== STRATEGY 2: Standard getChats with generous timeout (180s) ======
        console.log('🔄 [FastFetch] Falling back to standard client.getChats() (up to 180s)...');
        const standardChats = await Promise.race([
            client.getChats(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout: standard getChats exceeded 180s')), 180000))
        ]);

        console.log(`🔄 [FastFetch] Standard fallback returned ${standardChats.length} chats`);
        return standardChats.map(chat => ({
            id: chat.id._serialized,
            name: chat.name,
            isGroup: chat.isGroup,
            timestamp: chat.timestamp,
            unreadCount: chat.unreadCount,
            lastMessage: chat.lastMessage ? {
                body: chat.lastMessage.body,
                timestamp: chat.lastMessage.timestamp,
                fromMe: chat.lastMessage.fromMe,
                type: chat.lastMessage.type
            } : null
        }));
    }

    /**
     * Obtiene chats de una sesión — OPTIMIZADO con cache + reintentos
     */
    async getChats(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.client) return { error: 'Sesión no encontrada' };
        if (session.status !== 'connected') return { error: 'Sesión no conectada' };

        // If we have cached chats, return them immediately
        if (session._cachedChats && session._cachedChats.length > 0) {
            console.log(`⚡ Serving ${session._cachedChats.length} cached chats for ${sessionId}`);
            // Refresh cache in background for next time
            setImmediate(async () => {
                try {
                    if (session.status !== 'connected') return; // Guard: no refrescar si ya se desconectó
                    session._cachedChats = await this._fastFetchChats(session.client);
                    session._chatsCachedAt = Date.now();
                } catch (e) {
                    console.error(`⚠️ Background chat refresh failed:`, e.message);
                    // Si el cliente está muerto, forzar desconexión
                    if (e.message && (e.message.includes('Execution context') || e.message.includes('Cannot read properties'))) {
                        console.log(`🔌 [AutoDetect] Cliente muerto detectado en refresh para ${sessionId}. Forzando desconexión...`);
                        this._forceDisconnect(sessionId, 'LOGOUT');
                    }
                }
            });
            return session._cachedChats;
        }

        // No cache — fetch with fast-fetch + auto-retry
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                console.log(`🔄 Loading chats for ${sessionId} (attempt ${attempt}/2)...`);
                session._cachedChats = await this._fastFetchChats(session.client);
                session._chatsCachedAt = Date.now();
                console.log(`✅ Loaded ${session._cachedChats.length} chats for ${sessionId}`);
                return session._cachedChats;
            } catch (err) {
                console.error(`❌ getChats attempt ${attempt} failed for ${sessionId}:`, err.message);

                // Detectar desconexión silenciosa (whatsapp-web.js no emitió evento 'disconnected')
                const isDisconnectError = err.message.includes('Cannot read properties of undefined') ||
                                          err.message.includes('Execution context was destroyed') ||
                                          err.message.includes('Protocol error');

                if (isDisconnectError && session.status === 'connected' && attempt === 2) {
                    console.log(`🔔 [AUTO-DETECT] Desconexión silenciosa detectada para ${sessionId}`);
                    session.status = 'disconnected';
                    session.reason = 'LOGOUT';
                    this.io.emit('disconnected', { sessionId, reason: 'LOGOUT' });
                    this.io.emit('session_update', this._getSessionInfo(sessionId));

                    // Emitir evento para enviar correo
                    if ((session.phone || session.name) && !this.isShuttingDown) {
                        this.emit('session_disconnected', {
                            sessionId,
                            phone: session.phone || 'Desconocido',
                            name: session.name || sessionId,
                            reason: 'LOGOUT'
                        });
                    }
                }

                if (attempt < 2) {
                    console.log(`🔁 Retrying in 3 seconds...`);
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
        }
        return { error: 'Las conversaciones tardaron demasiado. Haz clic en 🔄 para reintentar.' };
    }

    /**
     * Obtiene mensajes de un chat - RÁPIDO (sin descargar media)
     * @param {string} sessionId - ID de la sesión
     * @param {string} chatId - ID del chat
     * @param {number} limit - Máximo de mensajes
     * @returns {Array} Lista de mensajes
     */
    async getMessages(sessionId, chatId, limit = 50) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.client) return { error: 'Sesión no encontrada' };
        if (session.status !== 'connected') return { error: 'Sesión no conectada' };

        try {
            const chat = await session.client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit });

            // Cargar mensajes revocados y message store
            const revokedMap = this._loadRevokedMessages(sessionId);
            const messageStore = this._loadMessageStore(sessionId);

            // Mapear mensajes existentes
            const fetchedIds = new Set();
            const isGroup = chatId.includes('@g.us');
            const authorCache = {}; // Cache de nombres resueltos

            // First pass: collect data and unique author IDs
            const result = [];
            const unknownAuthors = new Set();
            for (const msg of messages) {
                const msgId = msg.id._serialized;
                fetchedIds.add(msgId);
                const revoked = revokedMap[msgId];
                const stored = messageStore[msgId];
                const authorId = msg.author || (stored ? stored.author : null) || (revoked ? revoked.author : null);
                const extracted = this._extractMessageData(msg, stored, revoked);
                const storedName = stored ? stored.authorName : null;

                // Track authors that need resolution
                if (isGroup && !msg.fromMe && authorId && !storedName) {
                    unknownAuthors.add(authorId);
                }

                result.push({
                    id: msgId,
                    body: extracted.body,
                    from: msg.from,
                    to: msg.to,
                    timestamp: msg.timestamp,
                    fromMe: msg.fromMe,
                    type: extracted.type,
                    hasMedia: extracted.hasMedia,
                    isViewOnce: extracted.isViewOnce || msg.isViewOnce || !!(msg._data && (msg._data.isViewOnce || msg._data.viewOnce)) || (stored ? stored.isViewOnce : false) || (revoked ? revoked.isViewOnce : false),
                    pollOptions: extracted.pollOptions,
                    pollVotes: stored ? (stored.pollVotes || []) : [],
                    revoked: !!revoked,
                    revokeType: revoked ? revoked.revokeType : undefined,
                    originalBody: revoked ? revoked.body : undefined,
                    author: authorId,
                    authorName: storedName || null,
                    mentionedIds: msg.mentionedIds || (stored ? stored.mentionedIds : []) || []
                });
            }

            // Resolve all unknown authors in PARALLEL (instead of one-by-one)
            if (unknownAuthors.size > 0) {
                await Promise.allSettled([...unknownAuthors].map(async (authorId) => {
                    try {
                        const contact = await session.client.getContactById(authorId);

                        let fallbackNum = authorId.split('@')[0];
                        if (fallbackNum.length > 6 && !fallbackNum.startsWith('+')) {
                            fallbackNum = '+' + fallbackNum;
                        }

                        authorCache[authorId] = contact.name || contact.pushname || fallbackNum;
                    } catch (e) {
                        let fallbackNum = authorId.split('@')[0];
                        if (fallbackNum.length > 6 && !fallbackNum.startsWith('+')) {
                            fallbackNum = '+' + fallbackNum;
                        }
                        authorCache[authorId] = fallbackNum;
                    }
                }));
                // Apply resolved names to results
                for (const item of result) {
                    if (!item.authorName && item.author && authorCache[item.author]) {
                        item.authorName = authorCache[item.author];
                    }
                }
            }

            // Inyectar mensajes revocados que ya no aparecen en el chat (eliminados para mí)
            for (const [msgId, revokedData] of Object.entries(revokedMap)) {
                if (fetchedIds.has(msgId)) continue;
                // Solo inyectar si pertenece a este chat
                const belongsToChat = (revokedData.chatId === chatId || revokedData.from === chatId || revokedData.to === chatId);
                if (!belongsToChat) continue;

                result.push({
                    id: msgId,
                    body: revokedData.body,
                    from: revokedData.from,
                    to: revokedData.to,
                    timestamp: revokedData.timestamp,
                    fromMe: revokedData.fromMe,
                    type: revokedData.type,
                    hasMedia: revokedData.hasMedia,
                    isViewOnce: !!revokedData.isViewOnce,
                    revoked: true,
                    revokeType: revokedData.revokeType,
                    originalBody: revokedData.body,
                    author: revokedData.author || null,
                    authorName: revokedData.authorName || null,
                    mentionedIds: revokedData.mentionedIds || []
                });
            }

            // Ordenar por timestamp
            result.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

            return result;
        } catch (err) {
            return { error: err.message };
        }
    }

    /**
     * Descarga media de un mensaje específico (lazy loading)
     * @param {string} sessionId - ID de la sesión
     * @param {string} messageId - ID serializado del mensaje
     * @returns {Object} { mimetype, data } o { error }
     */
    async getMessageMedia(sessionId, messageId) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.client) return { error: 'Sesión no encontrada' };
        if (session.status !== 'connected') return { error: 'Sesión no conectada' };

        try {
            // Get all chats and search for the message
            const chats = await session.client.getChats();
            for (const chat of chats) {
                try {
                    const messages = await chat.fetchMessages({ limit: 100 });
                    const msg = messages.find(m => m.id._serialized === messageId);
                    if (msg && msg.hasMedia) {
                        const media = await msg.downloadMedia();
                        if (media) {
                            return {
                                mimetype: media.mimetype,
                                data: media.data,
                                filename: media.filename || null
                            };
                        }
                    }
                } catch (e) { continue; }
            }
            return { error: 'Mensaje no encontrado' };
        } catch (err) {
            return { error: err.message };
        }
    }

    /**
     * Descarga media de un mensaje en un chat específico (más rápido)
     * @param {string} sessionId - ID de la sesión
     * @param {string} chatId - ID del chat
     * @param {string} messageId - ID serializado del mensaje
     * @returns {Object} { mimetype, data, filename } o { error }
     */
    async getMediaFromChat(sessionId, chatId, messageId) {
        console.log(`🔍 Media request: session=${sessionId}, msg=${messageId}`);

        // *** PRIMERO: Intentar servir desde LA NUEVA BD Y MINIO ***
        try {
            const db = require('./src/services/db');
            const storage = require('./src/services/storage');

            // Buscar la llave S3 usando el ID del mensaje O su ID reportado si cambió post-borrado
            const resolvedMessageId = this._resolveMediaId(sessionId, messageId);
            const fallbackMessageId = messageId; // Consultar ambos por si acaso

            const { rows } = await db.query(
                `SELECT s3_object_key, stored_files.mime_type, messages.original_file_name 
                FROM stored_files 
                JOIN messages ON stored_files.file_hash = messages.file_hash 
                WHERE messages.wa_message_id = $1 OR messages.wa_message_id = $2 LIMIT 1`,
                [resolvedMessageId, fallbackMessageId]
            );

            if (rows.length > 0) {
                const s3ObjectKey = rows[0].s3_object_key;
                console.log(`✅ Media served directly from MinIO S3 Stream: ${resolvedMessageId}`);

                return {
                    isMinioStream: true,
                    bucket: storage.DEFAULT_BUCKET,
                    objectKey: s3ObjectKey,
                    mimetype: rows[0].mime_type,
                    filename: rows[0].original_file_name || null
                };
            }
        } catch (e) {
            console.error('⚠️ DB/Minio Lookup Error (Falling back to old local cache):', e);
        }

        // *** SEGUNDO: Backwards compatibility (intentar servir de cache viejo) ***
        const cached = this._loadMediaFromCache(sessionId, messageId);
        if (cached) {
            console.log(`✅ Media served from CACHE: ${messageId} (${cached.mimetype})`);
            return cached;
        }
        console.log(`⚠️ Cache MISS for: ${messageId}`);

        // *** TERCERO: Intentar descargar LIVE de WhatsApp ***
        const session = this.sessions.get(sessionId);
        if (!session || !session.client) {
            console.log(`❌ Session not found: ${sessionId}`);
            return { error: 'Sesión no encontrada' };
        }
        if (session.status !== 'connected') {
            console.log(`❌ Session not connected: ${sessionId}`);
            return { error: 'Sesión no conectada' };
        }

        try {
            const chat = await session.client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit: 100 });
            const msg = messages.find(m => m.id._serialized === messageId);

            if (msg && msg.hasMedia) {
                // Si el mensaje es temporal/viewOnce y está revocado, NO intentar descarga en vivo
                // porque fallará (400 Bad Request) y solo retrasará la respuesta y arrojará excepciones.
                const isDeletedViewOnce = (msg.isViewOnce || !!(msg._data && (msg._data.isViewOnce || msg._data.viewOnce))) &&
                    this._loadRevokedMessages(sessionId)[messageId];

                if (!isDeletedViewOnce) {
                    try {
                        const media = await msg.downloadMedia();
                        if (media && media.data) {
                            // Cachear para futuro uso
                            this._saveMediaToCache(sessionId, messageId, media.mimetype, media.data, media.filename);
                            console.log(`✅ Media served LIVE and cached: ${messageId}`);
                            return {
                                mimetype: media.mimetype,
                                data: media.data,
                                filename: media.filename || null
                            };
                        }
                    } catch (e) {
                        console.error(`❌ Download failed: ${messageId}:`, e.message);
                    }
                } else {
                    console.log(`⚠️ Live fetch skipped. Message ${messageId} is deleted ViewOnce.`);
                }
            } else {
                console.log(`⚠️ Message ${messageId} found=${!!msg}, hasMedia=${msg ? msg.hasMedia : 'N/A'}, type=${msg ? msg.type : 'N/A'}`);
            }

            return { error: 'Media no disponible' };
        } catch (err) {
            console.error(`❌ getMediaFromChat error: ${err.message}`);
            return { error: err.message };
        }
    }

    /**
     * Elimina un chat y sus mensajes de WhatsApp
     * @param {string} sessionId
     * @param {string} chatId
     */
    async deleteChat(sessionId, chatId) {
        try {
            const session = this.sessions.get(sessionId);
            if (!session || !session.client) return { error: 'Sesión no conectada' };

            const chat = await session.client.getChatById(chatId);
            if (!chat) return { error: 'Chat no encontrado' };

            await chat.delete();
            return { success: true };
        } catch (e) {
            console.error(`❌ Error deleteChat: ${e.message}`);
            return { error: e.message };
        }
    }

    /**
     * Reconecta una sesión existente
     * @param {string} sessionId - ID de la sesión
     * @returns {Object} Resultado
     */
    async reconnectSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return { error: 'Sesión no encontrada' };

        if (session.client) {
            try { await session.client.destroy(); } catch (e) { }
        }

        session.status = 'initializing';
        this.io.emit('session_update', this._getSessionInfo(sessionId));
        this._initClient(sessionId);
        return { success: true };
    }
}

module.exports = SessionManager;
