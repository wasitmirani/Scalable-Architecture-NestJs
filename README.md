# Backoffice App (NestJS)

A robust and scalable backoffice application built with [NestJS](https://nestjs.com/), designed to handle core business operations including authentication, product management, and user administration.

## 🚀 Features

- **Authentication Module**: Secure JWT-based authentication with refresh token strategies.
- **Microservices Ready**: Modular architecture prepared for scaling.
- **Database Support**: MySQL, MariaDB, or PostgreSQL (via `DB_DRIVER`), plus optional MongoDB.
- **Standardized API**:
  - Global prefix: `/api`
  - Unified response format via `ResponseInterceptor`.
  - Automatic validation using `ValidationPipe`.
- **Security**: CORS enabled and configurable via environment variables.
- **Logging**: Advanced file logging with daily rotation, level segregation (error, warn, info, debug), and configurable timezone support.

## 🛠️ Tech Stack

- **Framework**: NestJS (Node.js)
- **Language**: TypeScript
- **Databases**: MySQL / MariaDB / PostgreSQL, MongoDB
- **Testing**: Jest

## 📂 Project Structure

The verified modules in this project include:

- **Auth**: Handles login, registration, and token management.
- **Products**: Manages product inventory and details.
- **Users**: User account management and profile handling.

## ⚙️ Configuration

The application requires environment variables for configuration. A sample configuration is provided in `.example.env`.

Copy the example file to `.env`:

```bash
cp .example.env .env
```

Ensure you update the following key variables in `.env`:
- `DB_DRIVER`: `mysql` | `mariadb` | `postgres` (aliases: `postgresql`, `pgsql`)
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`: Database connection
- `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME`: Default admin for seeding
- `MONGO_URI`: Your MongoDB connection string
- `JWT_SECRET`: A strong secret key for token signing
- `ALLOWED_ORIGINS`: Comma-separated list of allowed origins for CORS (default: `http://localhost:3000`)
- `APP_TIMEZONE`: Timezone for log timestamps (e.g., `Asia/Karachi`)
- `LOG_DIR`: Directory for storing log files (default: `storage/logs`)

### Database driver examples

**MySQL**
```env
DB_DRIVER=mysql
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASS=root
DB_NAME=nest_db
```

**PostgreSQL**
```env
DB_DRIVER=postgres
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASS=postgres
DB_NAME=nest_db
```

## 📦 Installation

```bash
$ npm install
```

## 🌱 Database seeding

Creates a default admin user (skips if the email already exists). Password is bcrypt-hashed automatically.

```bash
$ npm run seed
```

Defaults (override in `.env`):

| Variable | Default |
|----------|---------|
| `SEED_ADMIN_EMAIL` | `admin@example.com` |
| `SEED_ADMIN_PASSWORD` | `Password123!` |
| `SEED_ADMIN_NAME` | `Admin` |

## ▶️ Running the App

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

After starting the application, the API will be available at `http://localhost:{PORT}/api` (default `3000`; this project often uses `8888` via `.env`).
You can check the health status at `/api/health-check` or `/api/`.

## 📡 API calls

Base URL: `http://localhost:8888/api` (or your `PORT`).

### Auth header (required for protected routes)

Protected routes (for example `GET /api/users`) expect:

```http
Authorization: Bearer <access_token>
```

| Header value | Error |
|---|---|
| Missing | `Authorization header missing` (401) |
| Token without `Bearer ` prefix, or empty after `Bearer` | `Token missing` (401) |
| Invalid / expired JWT | `Invalid or expired token` (401) |

### 1. Login (public)

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "admin@example.com",
  "password": "Password123!"
}
```

Response includes `access_token` and `refresh_token`. Copy `access_token` for later requests.

### 2. Register (public)

```http
POST /api/auth/register
Content-Type: application/json

{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "password": "Password123!"
}
```

### 3. Users (protected — Bearer required)

```http
GET /api/users?page=1&limit=10
Authorization: Bearer <access_token>
```

```http
GET /api/users/:id
Authorization: Bearer <access_token>
```

### 4. Other auth endpoints

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/api/auth/refresh-token` | Body: `{ "refresh_token": "..." }` |
| `GET` | `/api/auth/profile` | Bearer |
| `POST` | `/api/auth/logout` | Bearer |

### curl examples

```bash
# Login
curl -s -X POST http://localhost:8888/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@example.com\",\"password\":\"Password123!\"}"

# Users list (replace TOKEN)
curl -s http://localhost:8888/api/users \
  -H "Authorization: Bearer TOKEN"
```

### Postman / Insomnia

1. Call `POST /api/auth/login` and copy `access_token` from the response.
2. For protected requests: **Authorization → Bearer Token** and paste the token  
   (or set header `Authorization` to `Bearer <access_token>` manually).
3. Do **not** paste only the raw JWT without the `Bearer ` prefix.

## 🧪 Testing

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## 📝 License

This project is [UNLICENSED](LICENSE).
