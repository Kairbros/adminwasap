/**
 * ============================================================
 * app.js — Frontend principal del Dashboard v2.1
 * ============================================================
 * Maneja:
 * - Autenticación (JWT token en localStorage)
 * - Workspaces (crear, seleccionar, eliminar) con aislamiento
 * - Sesiones WhatsApp (agregar, reconectar, eliminar)
 * - Chats (listar, buscar, mostrar nombres de contactos)
 * - Mensajes (solo lectura, sin envío)
 * - Socket.IO para actualizaciones en tiempo real
 * ============================================================
 */

// ===== AUTH =====
const TOKEN = localStorage.getItem('wa_token');
const USER = JSON.parse(localStorage.getItem('wa_user') || 'null');

if (!TOKEN || !USER) {
    window.location.href = '/login.html';
}

function authHeaders() {
    return { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
}

async function apiFetch(url, options = {}) {
    options.headers = { ...authHeaders(), ...(options.headers || {}) };
    const res = await fetch(url, options);
    if (res.status === 401) {
        localStorage.removeItem('wa_token');
        localStorage.removeItem('wa_user');
        window.location.href = '/login.html';
        return;
    }
    return res.json();
}

function logout() {
    localStorage.removeItem('wa_token');
    localStorage.removeItem('wa_user');
    window.location.href = '/login.html';
}

// ===== STATE =====
let workspaces = [];
let currentWorkspaceId = null;
let sessions = [];
let currentSessionId = null;
let currentChatId = null;
let currentChatName = '';
let currentChatIsGroup = false;
let allChats = [];

// ===== SOCKET.IO =====
const socket = io();

socket.on('connect', () => console.log('🌐 Connected'));

socket.on('session_update', (info) => {
    if (!info) return;
    const idx = sessions.findIndex(s => s.id === info.id);
    if (idx >= 0) {
        // Stop any trailing 'connected' or 'initializing' updates if the local session is in a manual logout lock
        if (sessions[idx].isManualLogout && (info.status === 'connected' || info.status === 'initializing')) {
            return;
        }

        // Keep the old disconnect reason if it's already logged out, just in case
        if (info.status === 'disconnected' && !info.reason && sessions[idx].reason) {
            info.reason = sessions[idx].reason;
        }

        // Preserve local manual logout lock
        info.isManualLogout = sessions[idx].isManualLogout;

        sessions[idx] = info;
    } else {
        // Only add if this session belongs to current workspace
        const ws = workspaces.find(w => w.id === currentWorkspaceId);
        if (ws && ws.sessionIds.includes(info.id)) {
            sessions.push(info);
        }
    }
    renderSessions();
});

socket.on('qr', ({ sessionId, qr }) => {
    const s = sessions.find(x => x.id === sessionId);
    if (s) s.isManualLogout = false; // Reset lock on new QR
    if (currentSessionId === sessionId) showQR(qr);
});

socket.on('ready', ({ sessionId }) => {
    // Evitar falsos positivos si la cuenta fue eliminada o marcada como desconectada localmente
    const s = sessions.find(x => x.id === sessionId);
    if (!s || s.status === 'disconnected' || s.status === 'auth_failed' || s.status === 'error' || s.isManualLogout) return;

    // Si la sesión YA estaba marcada como conectada, evitamos lanzar de nuevo el toast verde erróneo
    // que a veces WhatsApp Web dispara justo al momento de desvincular el teléfono en modo fantasma
    const wasAlreadyConnected = (s.status === 'connected');

    // Actulizamos estado
    s.status = 'connected';

    if (!wasAlreadyConnected) {
        showToast('✅ Cuenta conectada exitosamente');
        // Reload sessions to get updated phone/name info
        loadSessions();
        if (currentSessionId === sessionId) {
            showChatsView(sessionId);
        }
    }
});

socket.on('disconnected', ({ sessionId, reason }) => {
    // Marcar local temporalmente
    const s = sessions.find(x => x.id === sessionId);
    if (s) {
        s.status = 'disconnected';
        s.reason = reason;
        if (reason === 'LOGOUT') {
            s.isManualLogout = true;
        }
    }

    if (reason === 'LOGOUT') {
        showToast(`🔌 Sesión desconectada manualmente.`, 'error');
    } else {
        showToast(`⚠️ Sesión desconectada automáticamente (Motivo: ${reason})`, 'warning');
    }

    renderSessions();
});

socket.on('new_message', ({ sessionId, chatId, message }) => {
    // Auto-update message in chat panel (Handle possible missing suffixes gracefully)
    // If the base id matches, it's the same chat
    const currentBaseId = currentChatId ? currentChatId.split('@')[0] : null;
    const incomingBaseId = chatId ? chatId.split('@')[0] : null;

    if (currentSessionId === sessionId && currentBaseId === incomingBaseId &&
        document.getElementById('conversationView').classList.contains('active')) {
        appendMessage(message);
    }

    // Always Refresh chat list if viewing the same session
    if (currentSessionId === sessionId) {
        loadChats(sessionId);
    }
});

// Mensaje eliminado en tiempo real
socket.on('message_revoked', ({ sessionId, chatId, messageId, originalBody, revokeType }) => {
    // Si estamos viendo este chat, marcar el mensaje como eliminado en el DOM
    if (currentSessionId === sessionId && currentChatId === chatId) {
        const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
        if (msgEl) {
            msgEl.classList.add('revoked');
            // Agregar badge si no existe
            if (!msgEl.querySelector('.revoked-badge')) {
                const isFromMe = msgEl.classList.contains('outgoing');
                msgEl.insertAdjacentHTML('afterbegin', getRevokedBadgeHtml(revokeType, isFromMe));
            }
            // Restaurar contenido original si el body se borró
            if (originalBody) {
                const bodyDiv = msgEl.querySelector('div:not(.msg-time):not(.revoked-badge)');
                if (bodyDiv && (!bodyDiv.textContent || bodyDiv.textContent.trim() === '')) {
                    bodyDiv.innerHTML = formatMessageText(originalBody || '');
                }
            }
        }
    }
    // Refresh chat list para actualizar último mensaje
    if (currentSessionId === sessionId) {
        loadChats(sessionId);
    }
});

// ===== VIEWS =====
function switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
}

// ===== WORKSPACES =====
async function loadWorkspaces() {
    workspaces = await apiFetch('/api/workspaces') || [];
    renderWorkspaceList();

    if (workspaces.length > 0 && !currentWorkspaceId) {
        selectWorkspace(workspaces[0].id);
    } else if (currentWorkspaceId) {
        // Refresh current workspace (it might have been deleted)
        const exists = workspaces.find(w => w.id === currentWorkspaceId);
        if (!exists) {
            currentWorkspaceId = null;
            if (workspaces.length > 0) {
                selectWorkspace(workspaces[0].id);
            } else {
                document.getElementById('currentWorkspaceName').textContent = 'Sin workspaces';
                sessions = [];
                renderSessions();
                switchView('welcomeView');
            }
        } else {
            // Just refresh the name display
            document.getElementById('currentWorkspaceName').textContent = exists.name;
            renderWorkspaceList();
        }
    } else {
        document.getElementById('currentWorkspaceName').textContent = 'Sin workspaces';
        sessions = [];
        renderSessions();
    }
}

function renderWorkspaceList() {
    const container = document.getElementById('workspaceList');
    if (workspaces.length === 0) {
        container.innerHTML = '<div class="ws-empty">No hay workspaces</div>';
        return;
    }
    container.innerHTML = workspaces.map(ws => `
        <div class="ws-item ${ws.id === currentWorkspaceId ? 'active' : ''}" onclick="selectWorkspace('${ws.id}')">
            <div class="ws-item-info">
                <span class="ws-item-name">${escapeHtml(ws.name)}</span>
                <span class="ws-item-count">${ws.sessionIds.length} cuenta(s)</span>
            </div>
            <button class="ws-delete-btn" onclick="event.stopPropagation(); confirmDeleteWorkspace('${ws.id}', '${escapeAttr(ws.name)}')" title="Eliminar workspace">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
        </div>
    `).join('');
}

function selectWorkspace(wsId) {
    // Reset state completely when switching workspaces
    currentWorkspaceId = wsId;
    currentSessionId = null;
    currentChatId = null;
    allChats = [];

    const ws = workspaces.find(w => w.id === wsId);
    document.getElementById('currentWorkspaceName').textContent = ws ? ws.name : 'Workspace';
    closeWorkspaceDropdown();
    renderWorkspaceList();

    // Reset main view to welcome
    switchView('welcomeView');

    // Load only sessions for this workspace
    loadSessions();
}

function toggleWorkspaceDropdown() {
    document.getElementById('workspaceDropdown').classList.toggle('show');
}
function closeWorkspaceDropdown() {
    document.getElementById('workspaceDropdown').classList.remove('show');
}

function showWorkspaceModal() {
    document.getElementById('workspaceModal').classList.add('show');
    document.getElementById('wsName').value = '';
    document.getElementById('wsDesc').value = '';
    document.getElementById('wsName').focus();
    closeWorkspaceDropdown();
}
function hideWorkspaceModal() {
    document.getElementById('workspaceModal').classList.remove('show');
}

async function createWorkspace() {
    const name = document.getElementById('wsName').value.trim();
    const description = document.getElementById('wsDesc').value.trim();
    if (!name) { showToast('Nombre del workspace requerido', 'error'); return; }

    hideWorkspaceModal();
    const result = await apiFetch('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name, description })
    });
    if (result && result.error) { showToast(result.error, 'error'); return; }

    showToast('✅ Workspace creado');
    await loadWorkspaces();
    if (result && result.id) selectWorkspace(result.id);
}

function confirmDeleteWorkspace(wsId, wsName) {
    document.getElementById('deleteMessage').textContent = `¿Eliminar workspace "${wsName}" y todas sus cuentas?`;
    document.getElementById('deleteModal').classList.add('show');
    document.getElementById('btnConfirmDelete').onclick = async () => {
        hideDeleteModal();
        showToast('🗑️ Eliminando workspace...');
        const result = await apiFetch(`/api/workspaces/${wsId}`, { method: 'DELETE' });
        if (result && result.error) {
            showToast('❌ Error al eliminar: ' + result.error, 'error');
            return;
        }
        if (currentWorkspaceId === wsId) {
            currentWorkspaceId = null;
            currentSessionId = null;
            currentChatId = null;
            sessions = [];
            switchView('welcomeView');
        }
        await loadWorkspaces();
        showToast('✅ Workspace eliminado correctamente');
    };
}

// ===== SESSIONS =====
async function loadSessions() {
    if (!currentWorkspaceId) {
        sessions = [];
        renderSessions();
        return;
    }

    // Fetch sessions filtered by current workspace
    sessions = await apiFetch(`/api/sessions?workspaceId=${currentWorkspaceId}`) || [];
    renderSessions();
}

function renderSessions() {
    const container = document.getElementById('sessionsList');
    if (sessions.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="height:160px">
                <span style="font-size:2rem;opacity:0.3">📱</span>
                <span>No hay cuentas en este workspace</span>
            </div>`;
        return;
    }

    const statusLabels = {
        'connected': 'Conectado', 'disconnected': 'Desconectado', 'waiting_qr': 'Esperando QR',
        'initializing': 'Iniciando...', 'authenticated': 'Autenticado', 'error': 'Error', 'auth_failed': 'Fallo auth'
    };

    container.innerHTML = sessions.map(s => `
        <div class="session-item ${currentSessionId === s.id ? 'active' : ''}" onclick="selectSession('${s.id}')">
            <div class="avatar ${s.status}">${s.phone ? getInitials(s.name) : '📵'}</div>
            <div class="info">
                <div class="name">${escapeHtml(s.name)}</div>
                <div class="phone">${s.phone ? '+' + s.phone : (statusLabels[s.status] || s.status)}</div>
            </div>
            <div class="status-dot ${s.status === 'disconnected' && s.reason !== 'LOGOUT' ? 'disconnected_auto' : s.status}" title="${statusLabels[s.status] || s.status}"></div>
            <button class="btn-delete" onclick="event.stopPropagation(); confirmDeleteSession('${s.id}', '${escapeAttr(s.name)}')" title="Eliminar">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
        </div>
    `).join('');
}

function selectSession(sessionId) {
    currentSessionId = sessionId;
    currentChatId = null;
    allChats = [];
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    if (session.status === 'connected') {
        showChatsView(sessionId);
    } else if (session.status === 'waiting_qr' && session.hasQR) {
        switchView('qrView');
    } else if (session.status === 'disconnected' || session.status === 'error') {
        reconnectSession(sessionId);
    } else {
        switchView('qrView');
        document.getElementById('qrDisplay').innerHTML = `
            <div class="qr-loading"><div class="spinner"></div><p>Inicializando sesión...</p></div>`;
    }
    renderSessions();
}

// ===== ADD ACCOUNT =====
function showAddModal() {
    if (!currentWorkspaceId) {
        showToast('Primero selecciona o crea un workspace', 'error');
        return;
    }
    document.getElementById('addModal').classList.add('show');
    document.getElementById('accountName').value = '';
    document.getElementById('accountName').focus();
}
function hideAddModal() { document.getElementById('addModal').classList.remove('show'); }

async function addAccount() {
    const name = document.getElementById('accountName').value.trim();
    hideAddModal();

    const data = await apiFetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: name || undefined, workspaceId: currentWorkspaceId })
    });

    if (!data || data.error) { showToast(data ? data.error : 'Error', 'error'); return; }

    currentSessionId = data.id;
    switchView('qrView');
    document.getElementById('qrDisplay').innerHTML = `
        <div class="qr-loading"><div class="spinner"></div><p>Generando código QR...</p></div>`;
    showToast('⏳ Generando QR, espera un momento...');

    // Refresh workspace data so sessionIds are updated
    await loadWorkspaces();
    await loadSessions();
}

// ===== QR =====
function showQR(qrDataUrl) {
    document.getElementById('qrDisplay').innerHTML = `<img src="${qrDataUrl}" alt="QR Code">`;
}

// ===== CHATS =====
async function showChatsView(sessionId) {
    currentSessionId = sessionId;
    currentChatId = null;
    const session = sessions.find(s => s.id === sessionId);
    document.getElementById('chatsTitle').textContent = session ? session.name : 'Conversaciones';
    document.getElementById('chatsPhone').textContent = session && session.phone ? `+${session.phone}` : '';
    switchView('conversationView');

    // Reset messages panel to empty state
    document.getElementById('messagesEmpty').style.display = 'flex';
    document.getElementById('messagesActive').style.display = 'none';

    // Reset mobile state
    const split = document.querySelector('.conversation-split');
    if (split) split.classList.remove('chat-open');
    closeSidebar();

    renderSessions();
    await loadChats(sessionId);
}

async function loadChats(sessionId) {
    const container = document.getElementById('chatsList');
    container.innerHTML = `<div class="loading-chats"><div class="spinner"></div><p>Cargando conversaciones...</p><p style="font-size:12px;color:#888;margin-top:8px">La primera carga puede tomar 1-2 minutos</p></div>`;

    const chats = await apiFetch(`/api/sessions/${sessionId}/chats`);
    if (!chats || chats.error) {
        container.innerHTML = `<div class="empty-state">
            <span>⚠️ ${chats ? chats.error : 'Error al cargar'}</span>
            <button onclick="loadChats('${sessionId}')" style="margin-top:12px;padding:10px 24px;background:#25D366;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px">🔄 Reintentar</button>
        </div>`;
        return;
    }
    allChats = chats;
    renderChats(chats);
}

function renderChats(chats) {
    const container = document.getElementById('chatsList');
    if (chats.length === 0) {
        container.innerHTML = `<div class="empty-state"><span>📭 No hay conversaciones</span></div>`;
        return;
    }

    chats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    container.innerHTML = chats.map(chat => {
        const displayName = chat.name || chat.id.split('@')[0];
        const lastMsg = chat.lastMessage ? formatLastMsg(chat.lastMessage) : '';
        const time = chat.timestamp ? formatTime(chat.timestamp) : '';
        const initials = getInitials(displayName);
        const isActive = chat.id === currentChatId;

        return `
        <div class="chat-item ${isActive ? 'active' : ''}" onclick="openChat('${currentSessionId}', '${chat.id}', '${escapeAttr(displayName)}')">
            <div class="chat-avatar-pic">
                <span>${chat.isGroup ? '👥' : initials}</span>
            </div>
            <div class="chat-info">
                <div class="chat-name">${chat.isGroup ? '👥 ' : ''}${escapeHtml(displayName)}</div>
                <div class="chat-last-msg">${lastMsg || '<i>Sin mensajes</i>'}</div>
            </div>
            <div class="chat-meta">
                <div class="chat-time">${time}</div>
                ${chat.unreadCount > 0 ? `<span class="chat-unread">${chat.unreadCount}</span>` : ''}
            </div>
        </div>`;
    }).join('');
}

function formatLastMsg(msg) {
    if (msg.revoked) return msg.fromMe ? '🚫 Eliminaste este mensaje' : '🚫 Este mensaje fue eliminado';
    if (msg.isViewOnce) return msg.body ? `esto es una imagen temporal: ${escapeHtml(msg.body.substring(0, 30))}` : 'esto es una imagen temporal';
    if (msg.type === 'image') return msg.body ? `📷 Imagen: ${escapeHtml(msg.body.substring(0, 30))}` : '📷 Imagen';
    if (msg.type === 'video') return msg.body ? `🎥 Video: ${escapeHtml(msg.body.substring(0, 30))}` : '🎥 Video';
    if (msg.type === 'audio' || msg.type === 'ptt') return '🎵 Audio';
    if (msg.type === 'document') return msg.body ? `📄 Documento: ${escapeHtml(msg.body.substring(0, 30))}` : '📄 Documento';
    if (msg.type === 'sticker') return '🎭 Sticker';
    if (msg.type === 'location') return 'Ubicación';
    if (msg.type === 'vcard') return msg.body ? `Contacto: ${formatVCard(msg.body).preview}` : 'Contacto';
    if (msg.type === 'call_log') return '📞 esto es una llamada';
    if (msg.type === 'e2e_notification' || msg.type === 'protocol' || msg.type === 'gp2') return '🔒 Mensaje del sistema';
    if (msg.type === 'event' || msg.type === 'group_event' || msg.type === 'scheduled_event_creation' || msg.type === 'native_flow') return `Esto es un evento: ${escapeHtml((msg.body || '').substring(0, 30))}`;
    if (msg.type && msg.type.startsWith('poll_creation')) return `📊 Encuesta: ${escapeHtml((msg.body || '').substring(0, 30))}`;
    return escapeHtml((msg.body || '').substring(0, 60));
}

function formatVCard(vcardStr) {
    if (!vcardStr) return { preview: 'Contacto', name: 'Contacto', phone: '' };
    const fnMatch = vcardStr.match(/FN:(.*?)(\r\n|\n)/);
    const waidMatch = vcardStr.match(/waid=([^:]+)/);

    let name = fnMatch && fnMatch[1] ? fnMatch[1].trim() : 'Contacto';
    let phone = waidMatch && waidMatch[1] ? waidMatch[1].trim() : '';

    // Fallback if waid is missing but a generic TEL exists
    if (!phone) {
        const telMatch = vcardStr.match(/TEL.*?:(.*?)(\r\n|\n)/);
        if (telMatch && telMatch[1]) {
            phone = telMatch[1].trim();
        }
    }

    // Remove unwanted characters from the name if any semicolon slipped in
    name = name.replace(/;/g, ' ').trim();

    let preview = name;
    if (phone) preview += ` / ${phone}`;

    return { preview, name, phone };
}

function filterChats() {
    const query = document.getElementById('chatSearch').value.toLowerCase().trim();
    if (!query) { renderChats(allChats); return; }
    renderChats(allChats.filter(c =>
        (c.name && c.name.toLowerCase().includes(query)) ||
        (c.id && c.id.toLowerCase().includes(query))
    ));
}

function refreshChats() {
    if (currentSessionId) {
        showToast('🔄 Refrescando...', 'success');
        loadChats(currentSessionId);
        // Si hay un chat abierto, refrescar también sus mensajes silenciosamente
        const msgActive = document.getElementById('messagesActive');
        if (currentChatId && msgActive && msgActive.style.display !== 'none') {
            silentRefreshChat(currentSessionId, currentChatId);
        }
    } else {
        showToast('Por favor, selecciona una cuenta primero', 'warning');
    }
}

// ===== MESSAGES (solo lectura) =====
async function silentRefreshChat(sessionId, chatId) {
    const messages = await apiFetch(`/api/sessions/${sessionId}/chats/${encodeURIComponent(chatId)}/messages?limit=50`);
    if (messages && !messages.error) {
        // Obtenemos el contenedor real
        const container = document.getElementById('messagesList');
        // Identificamos el scroll actual
        const isScrolledToBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 100;

        // Re-render
        renderMessages(messages);

        // Mantener posición
        if (isScrolledToBottom) {
            container.scrollTop = container.scrollHeight;
        }
    }
}

async function openChat(sessionId, chatId, chatName) {
    currentSessionId = sessionId;
    currentChatId = chatId;
    currentChatName = chatName;
    currentChatIsGroup = chatId.includes('@g.us');

    const displayName = chatName || chatId.split('@')[0];
    document.getElementById('messagesTitle').textContent = displayName;
    document.getElementById('messagesSubtitle').textContent = chatId.includes('@g.us') ? 'Grupo' : chatId.split('@')[0];

    const avatarEl = document.getElementById('msgAvatar');
    avatarEl.style.backgroundImage = '';
    avatarEl.innerHTML = `<span>${getInitials(displayName)}</span>`;

    // Show messages panel (hide empty state)
    document.getElementById('messagesEmpty').style.display = 'none';
    document.getElementById('messagesActive').style.display = 'flex';

    // On mobile: slide chat panel out to show messages full-screen
    const split = document.querySelector('.conversation-split');
    if (split) split.classList.add('chat-open');

    // Close sidebar if open (mobile)
    closeSidebar();

    // Highlight active chat in list
    renderChats(allChats);

    const container = document.getElementById('messagesList');
    container.innerHTML = `<div class="loading-chats"><div class="spinner"></div><p>Cargando mensajes...</p></div>`;

    const messages = await apiFetch(`/api/sessions/${sessionId}/chats/${encodeURIComponent(chatId)}/messages?limit=50`);
    if (!messages || messages.error) {
        container.innerHTML = `<div class="empty-state"><span>❌ ${messages ? messages.error : 'Error'}</span></div>`;
        return;
    }
    renderMessages(messages);

    // Al abrir el chat recién, tiramos el scroll al fondo obligatoriamente
    setTimeout(() => { container.scrollTop = container.scrollHeight; }, 50);
}

/** Construye la URL de media para un mensaje */
function mediaUrl(sessionId, chatId, msgId) {
    return `/api/sessions/${sessionId}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(msgId)}/media?token=${TOKEN}`;
}

function renderMediaBody(msg, sessionId, chatId) {
    if (msg.isViewOnce) {
        let voBody = `<div class="msg-file" style="font-weight:bold; color:#00a884; font-style:italic;">esto es una imagen temporal</div>`;
        if (msg.body) voBody += `<div class="msg-caption">${escapeHtml(msg.body)}</div>`;
        return voBody;
    }

    const url = mediaUrl(sessionId, chatId, msg.id);
    let body = '';
    const viewOnceBadge = msg.isViewOnce ? '<div class="view-once-badge">🔒 Vista única</div>' : '';

    if (msg.type === 'image' || msg.type === 'sticker') {
        body = `${viewOnceBadge}<div class="media-container"><img src="${url}" class="msg-image" loading="lazy" onclick="openImageFull(this.src)" alt="${msg.type === 'sticker' ? 'Sticker' : 'Imagen'}" onerror="handleMediaError(this, '${getMediaLabel(msg.type)}')"></div>`;
    } else if (msg.type === 'video') {
        body = `${viewOnceBadge}<div class="media-container"><video src="${url}" class="msg-video" controls preload="none" poster="" onerror="handleMediaError(this, '${getMediaLabel(msg.type)}')"></video></div>`;
    } else if (msg.type === 'audio' || msg.type === 'ptt') {
        body = `${viewOnceBadge}<div class="media-container"><audio src="${url}" class="msg-audio" controls preload="none" onerror="handleMediaError(this, '${getMediaLabel(msg.type)}')"></audio></div>`;
    } else if (msg.type === 'document') {
        body = `${viewOnceBadge}<a href="${url}" target="_blank" class="msg-doc-link"><div class="msg-file">📄 ${msg.body || 'Documento'} <span class="download-icon">⬇️</span></div></a>`;
    } else {
        body = `${viewOnceBadge}<div class="msg-file">${getMediaLabel(msg.type)}</div>`;
    }

    if (msg.body && msg.type !== 'document') {
        body += `<div class="msg-caption">${escapeHtml(msg.body)}</div>`;
    }
    return body;
}

function renderMessages(messages) {
    const container = document.getElementById('messagesList');
    if (messages.length === 0) {
        container.innerHTML = `<div class="empty-state"><span>📭 Sin mensajes</span></div>`;
        return;
    }

    let html = '';
    let lastDate = '';

    messages.forEach(msg => {
        try {
            const date = msg.timestamp ? new Date(msg.timestamp * 1000).toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '';
            if (date !== lastDate) {
                html += `<div class="date-divider"><span>${date}</span></div>`;
                lastDate = date;
            }

            const time = msg.timestamp ? new Date(msg.timestamp * 1000).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) : '';
            const className = msg.fromMe ? 'outgoing' : 'incoming';
            const revokedClass = msg.revoked ? ' revoked' : '';

            // Mostrar remitente en grupos
            let senderHtml = '';
            if (currentChatIsGroup && !msg.fromMe) {
                const senderName = msg.authorName || formatSenderName(msg.author || msg.from);
                const senderColor = getSenderColor(senderName);
                senderHtml = `<div class="msg-sender" style="color:${senderColor}">${escapeHtml(senderName)}</div>`;
            }

            let body = '';
            const isViewOnceMsg = msg.isViewOnce || msg.type === 'view_once' || (msg.body === 'esto es una imagen temporal');
            if (isViewOnceMsg) {
                if (msg.revoked === true) {
                    body = msg.originalBody ? `<div class="msg-caption" style="text-decoration:line-through;opacity:0.6">${escapeHtml(msg.originalBody || '')}</div>` : `<div class="view-once" style="font-weight:bold; color:#00a884; font-style:italic; text-decoration:line-through; opacity:0.6;">esto es una imagen temporal</div>`;
                } else {
                    body = `<div class="view-once" style="font-weight:bold; color:#00a884; font-style:italic;">esto es una imagen temporal</div>`;
                }
            } else if (msg.type && msg.type.startsWith('poll_creation')) {
                let pollHtml = `<div style="font-weight:600; margin-bottom:8px;">📊 ${escapeHtml(msg.body || 'Encuesta')}</div>`;
                if (msg.pollOptions && Array.isArray(msg.pollOptions)) {

                    // Agrupar votos
                    const optionVotes = {};
                    let totalVotes = 0;
                    if (msg.pollVotes && Array.isArray(msg.pollVotes)) {
                        msg.pollVotes.forEach(v => {
                            if (v.options && Array.isArray(v.options)) {
                                v.options.forEach(opt => {
                                    optionVotes[opt] = (optionVotes[opt] || 0) + 1;
                                    totalVotes++;
                                });
                            }
                        });
                    }

                    pollHtml += `<div style="display:flex; flex-direction:column; gap:6px;">`;
                    msg.pollOptions.forEach(opt => {
                        const optName = typeof opt === 'object' ? opt.name : opt;
                        const votes = optionVotes[optName] || 0;
                        const pct = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
                        pollHtml += `<div style="background:rgba(0,168,132,0.1); position:relative; overflow:hidden; padding:6px 10px; border-radius:6px; border:1px solid rgba(0,168,132,0.2); font-size:0.85rem;">
                            <div style="position:absolute; left:0; top:0; bottom:0; width:${pct}%; background:rgba(0,168,132,0.2); z-index:0;"></div>
                            <div style="position:relative; z-index:1; display:flex; justify-content:space-between;">
                                <span>⚪ ${escapeHtml(optName || '')}</span>
                                <span style="font-weight:bold; color:#00a884;">${votes > 0 ? votes : ''}</span>
                            </div>
                        </div>`;
                    });
                    pollHtml += `</div>
                    <div style="font-size:0.75rem; color:#667781; margin-top:5px; text-align:right;">${totalVotes} votos</div>`;
                }
                body = `<div class="msg-file" style="display:block;">${pollHtml}</div>`;
            } else if (msg.type === 'location') {
                body = `<div class="msg-file">Ubicación</div>`;
            } else if (msg.type === 'event' || msg.type === 'group_event' || msg.type === 'scheduled_event_creation' || msg.type === 'native_flow') {
                const title = escapeHtml(msg.body || 'Sin título');
                body = `<div class="msg-file" style="background-color:rgba(0,168,132,0.1); border:1px solid rgba(0,168,132,0.2); border-radius:8px; padding:10px; font-weight:bold; color:#00a884; text-align:center; display:flex; flex-direction:column; gap:5px;">
                    <span>Esto es un evento</span>
                    <span style="font-size:0.9em; font-weight:normal; color:#333;">${title}</span>
                </div>`;
            } else if (msg.type === 'vcard') {
                const vcard = formatVCard(msg.body || '');
                body = `<div class="msg-file">Contacto: ${escapeHtml(vcard.name)} ${vcard.phone ? escapeHtml(vcard.phone) : ''}</div>`;
            } else if (msg.type === 'call_log') {
                body = `<div class="msg-file" style="text-align:center; font-style:italic; color:#667781;">📞 esto es una llamada</div>`;
            } else if (msg.type === 'e2e_notification' || msg.type === 'protocol' || msg.type === 'gp2') {
                body = `<div class="msg-file" style="text-align:center; font-style:italic; color:#667781;">🔒 Mensaje del sistema</div>`;
            } else if (msg.hasMedia) {
                body = renderMediaBody(msg, currentSessionId, currentChatId);
                // Append original caption if it was lost and we had it
                if (msg.revoked && msg.originalBody && msg.type !== 'document') {
                    body += `<div class="msg-caption">${escapeHtml(msg.originalBody || '')}</div>`;
                }
            } else {
                if (!msg.body || msg.body.trim() === '') {
                    if (msg.revoked === true) {
                        body = msg.originalBody
                            ? `<div class="msg-caption" style="text-decoration:line-through;opacity:0.6">${escapeHtml(msg.originalBody || '')}</div>`
                            : `<div class="view-once" style="font-weight:normal; color:#667781; font-style:italic; text-decoration:line-through; opacity:0.6;">🚫 Este mensaje fue eliminado</div>`;
                    } else {
                        // Mensaje con body vacío y sin media
                        if (msg.isViewOnce || msg.type === 'view_once') {
                            // Es un mensaje temporal (view once) expirado
                            body = `<div class="view-once" style="font-weight:bold; color:#00a884; font-style:italic;">🔒 Mensaje temporal</div>`;
                        } else {
                            // Tipos que por diseño no tienen body de texto (reacciones, sync, cifrado, etc.)
                            const silentTypes = ['reaction','ephemeral_sync','ciphertext','notification_template','broadcast_notification'];
                            if (silentTypes.includes(msg.type)) {
                                body = `<div class="msg-file" style="text-align:center; font-style:italic; color:#667781;">🔔 Notificación del sistema</div>`;
                            } else {
                                // Body vacío sin razón conocida: puede ser un mensaje en sincronización o formato no soportado
                                body = `<div class="view-once" style="font-weight:normal; color:#667781; font-style:italic;">⌛ Contenido no disponible (tipo: ${msg.type || 'desconocido'})</div>`;
                            }
                        }
                    }
                } else {
                    body = `<div>${formatMessageText(msg.body || '', msg.mentionedIds)}</div>`;
                }
            }

            const revokedBadge = msg.revoked ? getRevokedBadgeHtml(msg.revokeType, msg.fromMe) : '';
            const viewOnceBadge = (msg.isViewOnce && !msg.revoked) ? `<div class="view-once-tag">esto es una imagen temporal</div>` : '';

            html += `
            <div class="message-bubble ${className}${revokedClass}" data-msg-id="${msg.id}">
                ${revokedBadge}
                ${viewOnceBadge}
                ${senderHtml}
                ${body}
                <div class="msg-time">${time}${msg.fromMe ? ' ✓✓' : ''}</div>
            </div>`;
        } catch (e) {
            console.error('Error rendering message:', msg, e);
            html += `<div class="message-bubble" style="background:#ffe6e6; color:#d32f2f; border:1px solid #d32f2f;">❌ Error UI: ${escapeHtml(e.message)}</div>`;
        }
    });

    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;
}

function appendMessage(message) {
    const container = document.getElementById('messagesList');
    if (!container) return;

    try {
        const emptyState = container.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        const msgId = message.id && message.id._serialized ? message.id._serialized : message.id;

        // Verificar si ya existe en el DOM
        if (container.querySelector(`[data-msg-id="${msgId}"]`)) {
            return;
        }

        const className = message.fromMe ? 'outgoing' : 'incoming';
        const revokedClass = message.revoked ? ' revoked' : '';
        const time = message.timestamp ? new Date(message.timestamp * 1000).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) : '';

        let senderHtml = '';
        if (currentChatIsGroup && !message.fromMe) {
            const senderName = message.authorName || formatSenderName(message.author || message.from);
            const senderColor = getSenderColor(senderName);
            senderHtml = `<div class="msg-sender" style="color:${senderColor}">${escapeHtml(senderName)}</div>`;
        }

        let body = '';
        const isViewOnceMsg = message.isViewOnce || message.type === 'view_once' || (message.body === 'esto es una imagen temporal');
        if (isViewOnceMsg) {
            if (message.revoked === true) {
                body = message.originalBody ? `<div class="msg-caption" style="text-decoration:line-through;opacity:0.6">${escapeHtml(message.originalBody || '')}</div>` : `<div class="view-once" style="font-weight:bold; color:#00a884; font-style:italic; text-decoration:line-through; opacity:0.6;">esto es una imagen temporal</div>`;
            } else {
                body = `<div class="view-once" style="font-weight:bold; color:#00a884; font-style:italic;">esto es una imagen temporal</div>`;
            }
        } else if (message.type === 'location') {
            body = `<div class="msg-file">Ubicación</div>`;
        } else if (message.type === 'vcard') {
            const vcard = formatVCard(message.body || '');
            body = `<div class="msg-file">Contacto: ${escapeHtml(vcard.name)} ${vcard.phone ? escapeHtml(vcard.phone) : ''}</div>`;
        } else if (message.type === 'call_log') {
            body = `<div class="msg-file" style="text-align:center; font-style:italic; color:#667781;">📞 esto es una llamada</div>`;
        } else if (message.type === 'e2e_notification' || message.type === 'protocol' || message.type === 'gp2') {
            body = `<div class="msg-file" style="text-align:center; font-style:italic; color:#667781;">🔒 Mensaje del sistema</div>`;
        } else if (message.type && message.type.startsWith('poll_creation')) {
            let pollHtml = `<div style="font-weight:600; margin-bottom:8px;">📊 ${escapeHtml(message.body || 'Encuesta')}</div>`;
            if (message.pollOptions && Array.isArray(message.pollOptions)) {
                const optionVotes = {};
                let totalVotes = 0;
                if (message.pollVotes && Array.isArray(message.pollVotes)) {
                    message.pollVotes.forEach(v => {
                        if (v.options && Array.isArray(v.options)) {
                            v.options.forEach(opt => {
                                optionVotes[opt] = (optionVotes[opt] || 0) + 1;
                                totalVotes++;
                            });
                        }
                    });
                }
                pollHtml += `<div style="display:flex; flex-direction:column; gap:6px;">`;
                message.pollOptions.forEach(opt => {
                    const optName = typeof opt === 'object' ? opt.name : opt;
                    const votes = optionVotes[optName] || 0;
                    const pct = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
                    pollHtml += `<div style="background:rgba(0,168,132,0.1); position:relative; overflow:hidden; padding:6px 10px; border-radius:6px; border:1px solid rgba(0,168,132,0.2); font-size:0.85rem;">
                        <div style="position:absolute; left:0; top:0; bottom:0; width:${pct}%; background:rgba(0,168,132,0.2); z-index:0;"></div>
                        <div style="position:relative; z-index:1; display:flex; justify-content:space-between;">
                            <span>⚪ ${escapeHtml(optName || '')}</span>
                            <span style="font-weight:bold; color:#00a884;">${votes > 0 ? votes : ''}</span>
                        </div>
                    </div>`;
                });
                pollHtml += `</div>
                <div style="font-size:0.75rem; color:#667781; margin-top:5px; text-align:right;">${totalVotes} votos</div>`;
            }
            body = `<div class="msg-file" style="display:block;">${pollHtml}</div>`;
        } else if (message.hasMedia) {
            body = renderMediaBody(message, currentSessionId, currentChatId);
            if (message.revoked && message.originalBody && message.type !== 'document') {
                body += `<div class="msg-caption">${escapeHtml(message.originalBody || '')}</div>`;
            }
        } else {
            if (!message.body || message.body.trim() === '') {
                if (message.revoked === true) {
                    body = message.originalBody
                        ? `<div class="msg-caption" style="text-decoration:line-through;opacity:0.6">${escapeHtml(message.originalBody || '')}</div>`
                        : `<div class="view-once" style="font-weight:normal; color:#667781; font-style:italic; text-decoration:line-through; opacity:0.6;">🚫 Este mensaje fue eliminado</div>`;
                } else {
                    // Mensaje con body vacío y sin media
                    if (message.isViewOnce || message.type === 'view_once') {
                        // Es un mensaje temporal (view once) expirado
                        body = `<div class="view-once" style="font-weight:bold; color:#00a884; font-style:italic;">🔒 Mensaje temporal</div>`;
                    } else {
                        // Tipos que por diseño no tienen body de texto (reacciones, sync, cifrado, etc.)
                        const silentTypes = ['reaction','ephemeral_sync','ciphertext','notification_template','broadcast_notification'];
                        if (silentTypes.includes(message.type)) {
                            body = `<div class="msg-file" style="text-align:center; font-style:italic; color:#667781;">🔔 Notificación del sistema</div>`;
                        } else {
                            // Body vacío sin razón conocida: puede ser un mensaje en sincronización o formato no soportado
                            body = `<div class="view-once" style="font-weight:normal; color:#667781; font-style:italic;">⌛ Contenido no disponible (tipo: ${message.type || 'desconocido'})</div>`;
                        }
                    }
                }
            } else {
                body = `<div>${formatMessageText(message.body || '', message.mentionedIds)}</div>`;
            }
        }

        const revokedBadge = message.revoked ? getRevokedBadgeHtml(message.revokeType, message.fromMe) : '';
        const viewOnceBadge = (message.isViewOnce && !message.revoked) ? `<div class="view-once-tag">esto es una imagen temporal</div>` : '';

        const div = document.createElement('div');
        div.className = `message-bubble ${className}${revokedClass}`;
        div.setAttribute('data-msg-id', msgId);
        div.innerHTML = `
            ${revokedBadge}
            ${viewOnceBadge}
            ${senderHtml}
            ${body}
            <div class="msg-time">${time}${message.fromMe ? ' ✓✓' : ''}</div>
        `;
        container.appendChild(div);
    } catch (e) {
        console.error('Error appending message:', message, e);
        const div = document.createElement('div');
        div.className = 'message-bubble';
        div.style.cssText = 'background:#ffe6e6; color:#d32f2f; border:1px solid #d32f2f; padding:10px; border-radius:8px; margin-bottom:5px;';
        div.innerHTML = `❌ Error UI en este mensaje (nuevo): ${escapeHtml(e.message)}`;
        container.appendChild(div);
    }
    container.scrollTop = container.scrollHeight;
}

/** Manejador de errores para media. Si falla, muestra botón para reintentar. */
window.handleMediaError = function (element, labelText) {
    const parent = element.parentElement;
    if (!parent || !element.src) return;

    // Evitar bucles infinitos
    if (element.dataset.retries > 3) {
        element.outerHTML = `<div class="msg-file">❌ Error cargando: ${labelText}</div>`;
        return;
    }

    const retries = parseInt(element.dataset.retries || 0) + 1;
    const currentSrc = element.src;

    // Crear botón de reintento
    const fallbackHTML = `
        <div class="msg-file media-retry">
            <div style="margin-bottom: 5px;">⚠️ ${labelText}</div>
            <button onclick="retryMediaLoad(this, '${currentSrc}', '${element.tagName}', ${retries})" style="padding:4px 8px;font-size:11px;background:#25D366;color:white;border:none;border-radius:4px;cursor:pointer;">
                🔄 Cargar de nuevo
            </button>
        </div>
    `;

    element.style.display = 'none';
    if (!parent.querySelector('.media-retry')) {
        parent.insertAdjacentHTML('beforeend', fallbackHTML);
    }
}

/** Re-intenta cargar media agregando un timestamp para evitar caché del navegador */
window.retryMediaLoad = function (btn, originalSrc, tagName, retries) {
    const container = btn.closest('.media-container');
    const mediaEl = container.querySelector(tagName);
    if (!mediaEl) return;

    // Limpiar botón
    const retryDiv = container.querySelector('.media-retry');
    if (retryDiv) retryDiv.remove();

    // Agregar parametro t para forzar recarga
    const url = new URL(originalSrc, window.location.origin);
    url.searchParams.set('t', Date.now());

    mediaEl.dataset.retries = retries;
    mediaEl.src = url.toString();
    mediaEl.style.display = 'block';
}

/** Visor de imagen a pantalla completa */
function openImageFull(src) {
    const overlay = document.createElement('div');
    overlay.className = 'image-overlay';
    overlay.onclick = () => overlay.remove();
    overlay.innerHTML = `<img src="${src}" alt="full"> <button class="img-close" onclick="this.parentElement.remove()">✕</button>`;
    document.body.appendChild(overlay);
}

// ===== DELETE HELPERS =====
function confirmDeleteSession(sessionId, sessionName) {
    document.getElementById('deleteMessage').textContent = `¿Eliminar la cuenta "${sessionName}" ? Tendrás que escanear el QR de nuevo.`;
    document.getElementById('deleteModal').classList.add('show');
    document.getElementById('btnConfirmDelete').onclick = async () => {
        hideDeleteModal();
        showToast('🗑️ Eliminando cuenta...');
        await apiFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });

        if (currentSessionId === sessionId) {
            currentSessionId = null;
            currentChatId = null;
            switchView('welcomeView');
        }

        // Reload everything fresh
        await loadWorkspaces();
        await loadSessions();
        showToast('✅ Cuenta eliminada');
    };
}

function hideDeleteModal() { document.getElementById('deleteModal').classList.remove('show'); }

// ===== RECONNECT =====
async function reconnectSession(sessionId) {
    showToast('🔄 Reconectando...');
    const data = await apiFetch(`/api/sessions/${sessionId}/reconnect`, { method: 'POST' });
    if (!data || data.error) { showToast(data ? data.error : 'Error', 'error'); return; }
    switchView('qrView');
    document.getElementById('qrDisplay').innerHTML = `
        <div class="qr-loading"><div class="spinner"></div><p>Reconectando...</p></div>`;
}

// ===== SIDEBAR =====
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }
document.getElementById('mainContent').addEventListener('click', () => {
    if (window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('open');
    closeWorkspaceDropdown();
});

// ===== UTILITIES =====
function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function escapeAttr(text) {
    return (text || '').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.substring(0, 2).toUpperCase();
}

function formatTime(timestamp) {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diff = now - date;
    const dayMs = 86400000;
    if (diff < dayMs) return date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    if (diff < 2 * dayMs) return 'Ayer';
    if (diff < 7 * dayMs) return date.toLocaleDateString('es-CO', { weekday: 'short' });
    return date.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function getMediaLabel(type) {
    const labels = { image: '📷 Imagen', video: '🎥 Video', audio: '🎵 Audio', ptt: '🎤 Nota de voz', document: '📄 Documento', sticker: '🎭 Sticker' };
    return labels[type] || '📎 Archivo';
}

function formatMessageText(text, mentionedIds) {
    let html = escapeHtml(text);
    html = html.replace(/\*(.*?)\*/g, '<strong>$1</strong>');
    html = html.replace(/_(.*?)_/g, '<em>$1</em>');
    html = html.replace(/~(.*?)~/g, '<s>$1</s>');
    html = html.replace(/```(.*?)```/g, '<code>$1</code>');
    html = html.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

    // Procesar @menciones
    if (mentionedIds && mentionedIds.length > 0) {
        for (const mid of mentionedIds) {
            const num = (typeof mid === 'string' ? mid : (mid._serialized || mid.user || '')).split('@')[0];
            if (num) {
                // Reemplazar @numero en el texto
                const regex = new RegExp(`@${num}`, 'g');
                html = html.replace(regex, `<span class="mention-tag">@${num}</span>`);
            }
        }
    }
    // Capturar menciones genéricas con @ seguido de números
    html = html.replace(/@(\d{7,15})/g, '<span class="mention-tag">@$1</span>');

    html = html.replace(/\n/g, '<br>');
    return html;
}

/** Extrae el número y formatea o usa el nombre si existe */
function formatSenderName(whatsappId) {
    if (!whatsappId) return 'Desconocido';

    // Si ya viene formateado de backend como nombre
    if (!whatsappId.includes('@')) {
        return whatsappId;
    }

    // Quitar @c.us o @s.whatsapp.net
    const num = whatsappId.split('@')[0];

    // Formatear: +XX XXXX XXXX
    if (num.length > 6 && !num.startsWith('+')) {
        return '+' + num;
    }
    return num;
}

/** Genera un color consistente para cada remitente */
function getSenderColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 60%)`;
}

function getRevokedBadgeHtml(revokeType, fromMe) {
    if (revokeType === 'me') return '<div class="revoked-badge">🗑️ Mensaje eliminado para mí</div>';
    if (revokeType === 'everyone') {
        return fromMe ? '<div class="revoked-badge">🗑️ Mensaje eliminado para todos</div>' : '<div class="revoked-badge">🗑️ Mensaje eliminado</div>';
    }
    return '<div class="revoked-badge">🗑️ Mensaje eliminado</div>';
}

function showToast(message, type = 'success') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// ===== MOBILE NAVIGATION =====
function isMobile() {
    return window.innerWidth <= 768;
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('open');
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.remove('open');
}

function mobileBackToChats() {
    // Slide chat panel back into view
    const split = document.querySelector('.conversation-split');
    if (split) split.classList.remove('chat-open');

    // Reset messages panel
    document.getElementById('messagesEmpty').style.display = 'flex';
    document.getElementById('messagesActive').style.display = 'none';
    currentChatId = null;
    renderChats(allChats);
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('userLabel').textContent = `👤 ${USER.username}`;
    loadWorkspaces();
});
