/**
 * ============================================================
 * auth.js — Módulo de Autenticación
 * ============================================================
 * Maneja registro, login y validación de JWT tokens usando PostgreSQL.
 * ============================================================
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./src/services/db');

// Clave secreta para JWT (en producción usar variable de entorno)
const JWT_SECRET = process.env.JWT_SECRET || 'wa-manager-secret-key-2024';
const JWT_EXPIRES = '7d';

/**
 * Registra un nuevo usuario
 * @param {string} username - Nombre de usuario
 * @param {string} password - Contraseña en texto plano
 * @returns {Object} Token JWT o error
 */
async function register(username, password) {
    if (!username || !password) {
        return { error: 'Usuario y contraseña son requeridos' };
    }
    if (username.length < 3) {
        return { error: 'El usuario debe tener al menos 3 caracteres' };
    }
    if (password.length < 4) {
        return { error: 'La contraseña debe tener al menos 4 caracteres' };
    }

    try {
        const { rows: existingUsers } = await db.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (existingUsers.length > 0) {
            return { error: 'El usuario ya existe' };
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const { rows } = await db.query(
            'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
            [username, hashedPassword]
        );

        const newUser = rows[0];
        const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

        return { token, user: { id: newUser.id, username: newUser.username } };
    } catch (err) {
        console.error('Error registrando usuario en BD:', err);
        return { error: 'Error interno del servidor al registrar' };
    }
}

/**
 * Inicia sesión de un usuario existente
 * @param {string} username - Nombre de usuario
 * @param {string} password - Contraseña en texto plano
 * @returns {Object} Token JWT o error
 */
async function login(username, password) {
    if (!username || !password) {
        return { error: 'Usuario y contraseña son requeridos' };
    }

    try {
        const { rows } = await db.query('SELECT id, username, password_hash FROM users WHERE LOWER(username) = LOWER($1)', [username]);

        if (rows.length === 0) {
            return { error: 'Usuario o contraseña incorrectos' };
        }

        const user = rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);

        if (!valid) {
            return { error: 'Usuario o contraseña incorrectos' };
        }

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
        return { token, user: { id: user.id, username: user.username } };
    } catch (err) {
        console.error('Error iniciando sesión desde BD:', err);
        return { error: 'Error interno del servidor al iniciar sesión' };
    }
}

/**
 * Middleware Express para verificar JWT en cada request protegido
 * Agrega req.user con { id, username } si el token es válido
 */
function authMiddleware(req, res, next) {
    // Accept token from Authorization header OR query param (for img/video/audio src)
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ error: 'Token no proporcionado' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = { id: decoded.id, username: decoded.username };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
}

module.exports = { register, login, authMiddleware };
