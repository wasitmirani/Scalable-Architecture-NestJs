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

After starting the application, the API will be available at `http://localhost:3000/api`.
You can check the health status at `http://localhost:3000/api/health-check` or `http://localhost:3000/api/`.

Login with the seeded admin:
```http
POST /api/auth/login
{ "email": "admin@example.com", "password": "Password123!" }
```

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
