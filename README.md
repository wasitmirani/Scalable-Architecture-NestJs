# Backoffice App (NestJS)

A robust and scalable backoffice application built with [NestJS](https://nestjs.com/), designed to handle core business operations including authentication, product management, and user administration.

## 🚀 Features

- **Authentication Module**: Secure JWT-based authentication with refresh token strategies.
- **Microservices Ready**: Modular architecture prepared for scaling.
- **Database Support**: Configured for both SQL (MySQL) and NoSQL (MongoDB) data persistence.
- **RESTful API**: Standardized API structure for seamless frontend integration.

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
- `DB_HOST`, `DB_USER`, `DB_PASS`: Creative your database credentials.
- `MONGO_URI`: Your MongoDB connection string.
- `JWT_SECRET`: A strong secret key for token signing.

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
