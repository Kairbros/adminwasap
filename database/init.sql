-- Tabla de Usuarios
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de Dispositivos / Sesiones de WhatsApp
CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    session_name VARCHAR(100) NOT NULL,
    session_data TEXT, -- Estado de la sesión encriptado
    status VARCHAR(50) DEFAULT 'disconnected',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ALMACENAMIENTO ÚNICO (Metadatos de Archivos)
-- Aquí se calcula el SHA-256. Si un archivo con este hash ya existe, NO se vuelve a guardar.
CREATE TABLE IF NOT EXISTS stored_files (
    file_hash VARCHAR(64) PRIMARY KEY, -- Hash SHA-256 es la clave primaria
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL,
    s3_object_key VARCHAR(255) NOT NULL, -- Ruta en MinIO
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Referencias a Archivos por Mensaje
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    remote_jid VARCHAR(100) NOT NULL, -- Número de destino/origen
    message_type VARCHAR(50) NOT NULL, -- text, image, video, document
    content TEXT, -- Texto del mensaje
    file_hash VARCHAR(64) REFERENCES stored_files(file_hash), -- Null si es solo texto
    original_file_name VARCHAR(255), -- El nombre de archivo que vio el usuario
    timestamp TIMESTAMP NOT NULL,
    deleted_by_sender BOOLEAN DEFAULT FALSE
);
