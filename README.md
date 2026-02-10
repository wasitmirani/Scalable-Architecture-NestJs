# Backoffice App (NestJS)

A robust and scalable backoffice application built with [NestJS](https://nestjs.com/), designed to handle core business operations including authentication, product management, and user administration.

## 🚀 Features

- **Authentication Module**: Secure JWT-based authentication with refresh token strategies.
- **Microservices Ready**: Modular architecture prepared for scaling.
- **Database Support**: Configured for both SQL (MySQL) and NoSQL (MongoDB) data persistence.
- **Standardized API**:
  - Global prefix: `/api`
  - Unified response format via `ResponseInterceptor`.
  - Automatic validation using `ValidationPipe`.
- **Security**: CORS enabled and configurable via environment variables.

## 🛠️ Tech Stack

- **Framework**: NestJS (Node.js)
- **Language**: TypeScript
- **Databases**: MySQL, MongoDB
- **Testing**: Jest

## 📂 Project Structure

The verified modules in this project include:

- **Auth**: Handles login, registration, and token management.
- **Products**: Manages product inventory and details.
- **Users**: User account management and profile handling.

## ⚙️ Configuration

The application requires environment variables for configuration. A sample configuration is provided in `.env.example`.

Copy the example file to `.env`:

```bash
cp .env.example .env
```

Ensure you update the following key variables in `.env`:
- `DB_HOST`, `DB_USER`, `DB_PASS`: Your database credentials.
- `MONGO_URI`: Your MongoDB connection string.
- `JWT_SECRET`: A strong secret key for token signing.
- `ALLOWED_ORIGINS`: Comma-separated list of allowed origins for CORS (default: `http://localhost:3000`).

## 📦 Installation

```bash
$ yarn install
```

## ▶️ Running the App

```bash
# development
$ yarn run start

# watch mode
$ yarn run start:dev

# production mode
$ yarn run start:prod
```

After starting the application, the API will be available at `http://localhost:3000/api`.
You can check the health status at `http://localhost:3000/api/health-check` or `http://localhost:3000/api/`.

## 🧪 Testing

```bash
# unit tests
$ yarn run test

# e2e tests
$ yarn run test:e2e

# test coverage
$ yarn run test:cov
```

## 📝 License

This project is [UNLICENSED](LICENSE).
