# Sentryk Backend README

````md
<div align="center">

# Sentryk Backend
### Secure SaaS Backend Infrastructure For Educational Centers

<p align="center">
  <strong>Scalable • Secure • Multi-Tenant • Production Ready</strong>
</p>

<p align="center">
  Enterprise-grade backend architecture powering the Sentryk ecosystem.
</p>

<p align="center">
  <a href="https://github.com/Youssef-Mossallem">GitHub</a>
  ·
  <a href="https://mosalem.vercel.app/">Portfolio</a>
</p>

---

![NodeJS](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-2D3748?style=for-the-badge&logo=prisma&logoColor=white)
![JWT](https://img.shields.io/badge/JWT-black?style=for-the-badge&logo=JSON%20web%20tokens)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Status](https://img.shields.io/badge/Status-Production-success?style=for-the-badge)

</div>

---

# Overview

Sentryk Backend is a secure and scalable REST API infrastructure built for managing educational centers and tutoring systems.

Designed with a modern SaaS architecture and multi-tenant isolation to ensure every center operates independently and securely.

---

# Core Features

## Authentication & Authorization

- JWT Authentication
- Secure Access Control
- Role-Based Permissions
- Protected Routes
- Multi-Tenant Architecture

---

# Student Management System

- Student registration
- Subscription management
- Subject assignment
- Group management
- Renewal automation
- Expiration tracking

---

# Subscription System

Supports:

- Monthly subscriptions
- Half-month subscriptions
- Course subscriptions
- Automatic expiration calculations
- Smart renewals

---

# SMS System

- SMS wallet system
- Automated reminders
- Renewal notifications
- Expiration alerts
- Student registration notifications

---

# Analytics & Reports

- Revenue analytics
- Subscription insights
- Student statistics
- Financial tracking
- Activity monitoring

---

# Security

Sentryk Backend includes multiple security layers:

- Helmet Security
- CORS Protection
- Rate Limiting
- SQL Injection Protection
- XSS Protection
- Request Validation
- JWT Verification
- Audit Logging

---

# Tech Stack

## Backend

- Node.js
- Express.js
- PostgreSQL
- Prisma ORM
- JWT Authentication
- Docker

---

# Architecture

```bash
backend
├── controllers
├── routes
├── middlewares
├── prisma
├── services
├── utils
├── validators
└── logs
````

---

# Multi-Tenant System

Sentryk is designed using a multi-tenant architecture.

Each educational center has isolated:

* Students
* Groups
* Financial data
* Subscriptions
* SMS balance
* Activity logs

This ensures maximum security and scalability.

---

# API Features

* RESTful API Design
* Structured Error Handling
* Clean Architecture
* Scalable Services
* Modular Codebase
* Optimized Database Queries

---

# Database

## PostgreSQL + Prisma ORM

Features:

* Relational architecture
* Optimized queries
* Fast performance
* Scalable schema design
* Seed support

---

# Docker Support

## Run Using Docker

```bash
docker-compose up --build
```

---

# Installation

## Clone Repository

```bash
git clone https://github.com/Youssef-Mossallem/Sentrykbackend.git
```

## Navigate To Project

```bash
cd Sentrykbackend
```

## Install Dependencies

```bash
npm install
```

## Setup Database

```bash
npx prisma migrate dev
```

## Seed Database

```bash
npx prisma db seed
```

## Start Development Server

```bash
npm run dev
```

---

# Production Ready

Sentryk Backend is built with production scalability in mind.

Includes:

* Secure architecture
* Modular backend system
* Optimized performance
* Enterprise-ready structure
* SaaS-ready infrastructure

---

# CI/CD & Deployment

Supports modern deployment workflows:

* Docker Deployment
* CI/CD Pipelines
* Cloud Hosting
* VPS Deployment
* Scalable Infrastructure

---

# Author

## Youssef Mossallem

* GitHub: [https://github.com/Youssef-Mossallem](https://github.com/Youssef-Mossallem)
* Portfolio: [https://mosalem.vercel.app/](https://mosalem.vercel.app/)
* Email: [ymslm120@gmail.com](mailto:ymslm120@gmail.com)

---

# License

All Rights Reserved © Sentryk

This project and its source code are protected.
Unauthorized copying, modification, distribution, or commercial use is prohibited.

---

<div align="center">

### Engineered By Youssef Mossallem

</div>
```
