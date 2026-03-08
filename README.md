# 🌟 WhatsApp Sync & Storage Platform - Guía de Despliegue en VPS

Este documento explica paso a paso cómo desplegar este sistema (Backend Node.js, Base de Datos PostgreSQL, Sistema de Colas BullMQ/Redis, y Almacenamiento MinIO) en un entorno de Producción (Servidor VPS, ej: Hostinger, DigitalOcean, AWS).

El diseño está 100% basado en **Docker y Docker Compose**, lo cual facilita que su ejecución en cualquier servidor Linux sea estandarizada, aislada y lista para escalar.

---

## 🏗️ Requisitos del Servidor VPS

Antes de comenzar, asegúrate de que tu servidor cuenta con:

- **Sistema Operativo:** Ubuntu 22.04 LTS (Recomendado) o Debian.
- **Software:** 
  - `docker` (Motor de contenedores)
  - `docker-compose` (Orquestador).
- **Puertos Abiertos (Firewall):**
  - `80` (HTTP)
  - `443` (HTTPS - si configuras Nginx/Traefik Proxy)
  - `3000` (API de nuestro Backend Node.js)
  - `9001` (Consola Web de Administración de MinIO)

---

## 🚀 Guía de Instalación Paso a Paso

### 1. Clonar el Repositorio en el Servidor
Ingresa a tu VPS por SSH e instala el código fuente:

```bash
# Entrar al servidor VPS
ssh root@tu_ip_del_servidor

# Clonar el proyecto (Ajusta la URL de tu repositorio real)
git clone https://github.com/tu_usuario/whatsapp-sync-platform.git
cd whatsapp-sync-platform/TEST_PRD/TEST
```

### 2. Configurar Variables de Entorno
El sistema depende de contraseñas y claves seguras. Revisa o edita tu archivo `docker-compose.yml` para asegurarte de cambiar las claves inseguras por defecto:

Edita usando nano:
```bash
nano docker-compose.yml
```

Asegúrate de cambiar claves como:
- `POSTGRES_PASSWORD` (Contraseña de Base de datos)
- `MINIO_ROOT_PASSWORD` (Clave de almacenamiento de archivos AWS S3 Local)

### 3. Levantar la Infraestructura (Docker Compose)
Una vez en la carpeta donde está tu archivo `docker-compose.yml`, ejecuta el comando mágico que descargará las bases de datos y compilará Node.js instalando sus dependencias en una sola orden:

```bash
# Compilar y arrancar en segundo plano (-d)
sudo docker compose up -d --build
```

> **Aviso de Rendimiento:** La primera vez que se ejecute tomará unos minutos descargar Ubuntu/Node.js e instalar Chromium para Puppeteer.

### 4. Verificar que todo está Funcionando
Si el paso 3 terminó con la palabra "Started" en color verde, revisa el estado de todos tus contenedores:

```bash
sudo docker ps
```

Deberás ver estos 4 servicios mágicos corriendo y listos:
1. `wa_postgres` (Base de Datos Relacional)
2. `wa_redis` (Broker de Tareas/Colas de BullMQ)
3. `wa_minio` (Almacenamiento Objeto S3)
4. `wa_backend` (Tu código principal en Express/Node.js)

Para asegurarnos de que la API de WhatsApp está viva leyendo los logs en vivo:
```bash
sudo docker logs -f wa_backend
```

---

## 🌐 Pruebas y Acceso al Sistema

### Acceso a la API Principal
Tu aplicación estará respondiendo peticiones API en el puerto `3000` del servidor principal:
- **Ping / Estado:** `http://tu_ip_del_servidor:3000/`

### Acceso a la Consola de Discos S3 (MinIO)
MinIO tiene una consola gráfica parecida a Google Drive para administrar todos los audios y videos físicos descargados de WhatsApp súper protegidos.
- **URL Admin:** `http://tu_ip_del_servidor:9001/`
- **User:** El que definiste en Docker (ej. `minioadmin`)
- **Password:** La que definiste en Docker (ej. `minioadmin123`)

---

## 🛡️ Mejores Prácticas (Siguientes Pasos de Seguridad)

Al publicarlo en un Hostinger real sin entorno de pruebas (TEST), debes añadir una capa extra de seguridad para no exponer el puerto 3000 o el 9001 "desnudos" a internet:

1. **Proxy Inverso:** Instala **Nginx** o **Traefik** como Gateway delantero.
2. **Dominio SSL:** Configurar los de Nginx para redirigir `api.tudominio.com` hacia el puerto `3000` mediante un certificado Let's Encrypt gratuito (HTTPS). 
3. **Firewall (UFW):** Oculta los puertos internos de Docker hacia fuera. Todo el mundo debe pasar por el proxy Nginx en el puerto 443 antes de hablar con MinIO o Node.js.

---

## 🛠️ Comandos de Supervivencia Administrativa

Si en el futuro alteras el código o necesitas reiniciar cosas, estos serán los comandos más usados en el VPS:

**Apagar toda la Arquitectura:**
```bash
sudo docker compose down
```

**Reiniciar SOLO el Servidor NodeJS (Si hay lag del bot WA):**
```bash
sudo docker restart wa_backend
```

**Re-compilar el Backend (Si subes código nuevo sin apagar bases de datos):**
```bash
sudo docker compose up -d --build backend
```

**Ver si algún componente explotó (Crash logs):**
```bash
sudo docker logs --tail 200 wa_backend
```
