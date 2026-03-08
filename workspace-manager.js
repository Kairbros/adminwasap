/**
 * ============================================================
 * workspace-manager.js — Gestión de Workspaces
 * ============================================================
 * Cada usuario puede crear workspaces (ej: "Oficina 1") que
 * agrupan múltiples sesiones de WhatsApp. Los datos se guardan
 * en data/{userId}/workspaces.json
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

class WorkspaceManager {
    /**
     * Obtiene la ruta del archivo de workspaces del usuario
     * @param {string} userId - ID del usuario
     * @returns {string} Ruta al archivo workspaces.json
     */
    _getFilePath(userId) {
        const userDir = path.join(DATA_DIR, userId);
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }
        return path.join(userDir, 'workspaces.json');
    }

    /**
     * Lee los workspaces de un usuario
     * @param {string} userId - ID del usuario
     * @returns {Array} Lista de workspaces
     */
    getAll(userId) {
        const filePath = this._getFilePath(userId);
        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
        } catch { }
        return [];
    }

    /**
     * Guarda los workspaces de un usuario
     * @param {string} userId - ID del usuario
     * @param {Array} workspaces - Lista de workspaces
     */
    _save(userId, workspaces) {
        const filePath = this._getFilePath(userId);
        fs.writeFileSync(filePath, JSON.stringify(workspaces, null, 2));
    }

    /**
     * Crea un nuevo workspace
     * @param {string} userId - ID del usuario
     * @param {string} name - Nombre del workspace
     * @param {string} description - Descripción opcional
     * @returns {Object} Workspace creado
     */
    create(userId, name, description = '') {
        if (!name || name.trim().length === 0) {
            return { error: 'El nombre del workspace es requerido' };
        }

        const workspaces = this.getAll(userId);
        const workspace = {
            id: 'ws_' + Date.now(),
            name: name.trim(),
            description: description.trim(),
            sessionIds: [],
            createdAt: new Date().toISOString()
        };

        workspaces.push(workspace);
        this._save(userId, workspaces);
        return workspace;
    }

    /**
     * Actualiza un workspace existente
     * @param {string} userId - ID del usuario
     * @param {string} workspaceId - ID del workspace
     * @param {Object} updates - Campos a actualizar {name, description}
     * @returns {Object} Workspace actualizado o error
     */
    update(userId, workspaceId, updates) {
        const workspaces = this.getAll(userId);
        const idx = workspaces.findIndex(w => w.id === workspaceId);
        if (idx === -1) return { error: 'Workspace no encontrado' };

        if (updates.name) workspaces[idx].name = updates.name.trim();
        if (updates.description !== undefined) workspaces[idx].description = updates.description.trim();

        this._save(userId, workspaces);
        return workspaces[idx];
    }

    /**
     * Elimina un workspace
     * @param {string} userId - ID del usuario
     * @param {string} workspaceId - ID del workspace
     * @returns {Object} Resultado
     */
    delete(userId, workspaceId) {
        const workspaces = this.getAll(userId);
        const idx = workspaces.findIndex(w => w.id === workspaceId);
        if (idx === -1) return { error: 'Workspace no encontrado' };

        const removed = workspaces.splice(idx, 1)[0];
        this._save(userId, workspaces);
        return { success: true, sessionIds: removed.sessionIds };
    }

    /**
     * Agrega una sesión de WhatsApp a un workspace
     * @param {string} userId - ID del usuario
     * @param {string} workspaceId - ID del workspace
     * @param {string} sessionId - ID de la sesión
     * @returns {Object} Workspace actualizado
     */
    addSession(userId, workspaceId, sessionId) {
        const workspaces = this.getAll(userId);
        const ws = workspaces.find(w => w.id === workspaceId);
        if (!ws) return { error: 'Workspace no encontrado' };

        if (!ws.sessionIds.includes(sessionId)) {
            ws.sessionIds.push(sessionId);
            this._save(userId, workspaces);
        }
        return ws;
    }

    /**
     * Elimina una sesión de un workspace
     * @param {string} userId - ID del usuario
     * @param {string} workspaceId - ID del workspace
     * @param {string} sessionId - ID de la sesión
     * @returns {Object} Workspace actualizado
     */
    removeSession(userId, workspaceId, sessionId) {
        const workspaces = this.getAll(userId);
        const ws = workspaces.find(w => w.id === workspaceId);
        if (!ws) return { error: 'Workspace no encontrado' };

        ws.sessionIds = ws.sessionIds.filter(id => id !== sessionId);
        this._save(userId, workspaces);
        return ws;
    }

    /**
     * Busca el workspace que contiene una sesión
     * @param {string} userId - ID del usuario
     * @param {string} sessionId - ID de la sesión
     * @returns {Object|null} Workspace encontrado
     */
    findBySession(userId, sessionId) {
        const workspaces = this.getAll(userId);
        return workspaces.find(w => w.sessionIds.includes(sessionId)) || null;
    }
}

module.exports = WorkspaceManager;
