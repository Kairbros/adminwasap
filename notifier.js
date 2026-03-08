/**
 * ============================================================
 * notifier.js — Módulo de Notificaciones por Correo
 * ============================================================
 * Envía alertas por correo electrónico cuando una sesión
 * de WhatsApp se desconecta inesperadamente.
 *
 * CONFIGURACIÓN:
 *   - NOTIFY_EMAIL_USER : correo Gmail del remitente (ej: tuapp@gmail.com)
 *   - NOTIFY_EMAIL_PASS : contraseña de aplicación Gmail (16 caracteres)
 *   - NOTIFY_EMAIL_TO   : correo destinatario (por defecto freddyvegawamanger@gmail.com)
 *
 * Cómo obtener una contraseña de aplicación Gmail:
 *   1. Ve a myaccount.google.com → Seguridad
 *   2. Activa "Verificación en dos pasos"
 *   3. Ve a "Contraseñas de aplicación" y genera una para "Correo"
 * ============================================================
 */

const nodemailer = require('nodemailer');

// ── Configuración ────────────────────────────────────────────
const EMAIL_FROM = process.env.NOTIFY_EMAIL_USER || '';
const EMAIL_PASS = process.env.NOTIFY_EMAIL_PASS || '';
const EMAIL_TO = process.env.NOTIFY_EMAIL_TO || 'freddyvegawamanger@gmail.com';

// Control anti-spam: no enviar más de 1 correo por sesión cada 5 segundos
const _lastSent = new Map(); // sessionId → timestamp
const COOLDOWN_MS = 5 * 1000; // 5 segundos

/**
 * Crea el transporter de nodemailer (Gmail SMTP)
 */
function _createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_FROM,
      pass: EMAIL_PASS
    }
  });
}

/**
 * Envía un correo de alerta cuando una sesión se desconecta.
 *
 * @param {string} sessionId    - ID interno de la sesión
 * @param {string} phone        - Número de teléfono vinculado (ej: 573001234567)
 * @param {string} sessionName  - Nombre amigable de la sesión
 * @param {string} workspaceName - Nombre del workspace donde está la sesión
 */
async function sendDisconnectAlert(sessionId, phone, sessionName, workspaceName) {
  // Verificar que el correo está configurado
  if (!EMAIL_FROM || !EMAIL_PASS) {
    console.warn('⚠️ [Notifier] No se envió correo: configura NOTIFY_EMAIL_USER y NOTIFY_EMAIL_PASS en las variables de entorno.');
    return;
  }

  // Anti-spam: no enviar si ya se envió hace menos de 5 minutos
  const last = _lastSent.get(sessionId);
  if (last && (Date.now() - last) < COOLDOWN_MS) {
    console.log(`📧 [Notifier] Correo omitido (cooldown) para sesión ${sessionId}`);
    return;
  }

  // Formatear número de teléfono
  const displayPhone = (phone && phone !== 'Desconocido') ? `+${phone}` : sessionName || sessionId;
  const displayWorkspace = workspaceName || 'Workspace desconocido';

  // Fecha/hora en formato legible
  const now = new Date();
  const timestamp = now.toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const subject = '🚨 NOTIFICACIÓN WA MANAGER URGENTE - Dispositivo Desconectado';

  const textBody = `
NOTIFICACIÓN WA MANAGER URGENTE

HOLA BUENAS TARDES, EL DISPOSITIVO ( ${displayPhone} ) SE HA DESCONECTADO.
POR FAVOR RECONECTAR URGENTEMENTE EN EL WORKSPACE ( ${displayWorkspace} ).

──────────────────────────────
Detalles del evento:
  • Número / Cuenta : ${displayPhone}
  • Workspace       : ${displayWorkspace}
  • Fecha y hora    : ${timestamp} (hora Colombia)
──────────────────────────────

Por favor ingresa al sistema WA Manager y reconecta el dispositivo
escaneando el código QR lo antes posible.

Este es un mensaje automático generado por WA Manager.
`.trim();

  const htmlBody = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; margin:0; padding: 20px;">
  <div style="max-width: 520px; margin: auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.12);">

    <!-- Header rojo urgente -->
    <div style="background: #d32f2f; padding: 24px 28px; text-align: center;">
      <div style="font-size: 2.4rem; margin-bottom: 6px;">🚨</div>
      <h1 style="color: #fff; margin: 0; font-size: 1.2rem; font-weight: 700; letter-spacing: 0.5px;">
        NOTIFICACIÓN WA MANAGER URGENTE
      </h1>
    </div>

    <!-- Cuerpo -->
    <div style="padding: 28px;">
      <p style="font-size: 1rem; color: #333; margin-top: 0;">
        Hola, buenas tardes.
      </p>
      <p style="font-size: 1rem; color: #333;">
        El dispositivo vinculado al número:
      </p>

      <!-- Número destacado -->
      <div style="background: #fff3e0; border-left: 5px solid #ff6f00; border-radius: 6px; padding: 14px 18px; margin: 16px 0;">
        <span style="font-size: 1.5rem; font-weight: 700; color: #e65100; letter-spacing: 1px;">
          📱 ${displayPhone}
        </span>
      </div>

      <p style="font-size: 1rem; color: #333;">
        Se ha <strong style="color: #d32f2f;">desconectado</strong>.<br>
        Por favor <strong>reconéctalo urgentemente</strong> en el workspace:
      </p>

      <!-- Workspace destacado -->
      <div style="background: #e8f5e9; border-left: 5px solid #2e7d32; border-radius: 6px; padding: 14px 18px; margin: 16px 0;">
        <span style="font-size: 1.2rem; font-weight: 700; color: #1b5e20;">
          🗂️ ${displayWorkspace}
        </span>
      </div>

      <!-- Detalles técnicos -->
      <table style="width:100%; border-collapse: collapse; margin-top: 20px; font-size: 0.88rem; color: #555;">
        <tr style="background: #fafafa;">
          <td style="padding: 8px 12px; border: 1px solid #eee; font-weight: 600;">Número / Cuenta</td>
          <td style="padding: 8px 12px; border: 1px solid #eee;">${displayPhone}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px; border: 1px solid #eee; font-weight: 600;">Workspace</td>
          <td style="padding: 8px 12px; border: 1px solid #eee;">${displayWorkspace}</td>
        </tr>
        <tr style="background: #fafafa;">
          <td style="padding: 8px 12px; border: 1px solid #eee; font-weight: 600;">Fecha y hora</td>
          <td style="padding: 8px 12px; border: 1px solid #eee;">${timestamp} (hora Colombia)</td>
        </tr>
      </table>

      <div style="margin-top: 24px; padding: 14px; background: #fff8e1; border-radius: 8px; border: 1px solid #ffe082; font-size: 0.9rem; color: #5d4037;">
        ⚠️ Ingresa al sistema <strong>WA Manager</strong>, selecciona el workspace
        <strong>${displayWorkspace}</strong> y escanea el código QR para reconectar el dispositivo.
      </div>
    </div>

    <!-- Footer -->
    <div style="background: #263238; padding: 14px 28px; text-align: center;">
      <p style="color: #90a4ae; font-size: 0.8rem; margin: 0;">
        Mensaje automático generado por <strong style="color: #fff;">WA Manager</strong> — ${timestamp}
      </p>
    </div>
  </div>
</body>
</html>
    `.trim();

  try {
    const transporter = _createTransporter();
    await transporter.sendMail({
      from: `"WA Manager 🚨" <${EMAIL_FROM}>`,
      to: EMAIL_TO,
      subject,
      text: textBody,
      html: htmlBody
    });
    _lastSent.set(sessionId, Date.now());
    console.log(`📧 [Notifier] ✅ Correo enviado para sesión ${sessionId} (${displayPhone}) → ${EMAIL_TO}`);
  } catch (err) {
    console.error(`📧 [Notifier] ❌ Error al enviar correo para ${sessionId}:`, err.message);
  }
}

module.exports = { sendDisconnectAlert };
