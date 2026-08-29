<div align="center">

# 🧹 codesaga-bulk-master — Redis Stream Cron Sweeper

**Automated recovery & reconciliation of stale Redis Stream jobs**  
*xAutoClaim · Dead-letter handling · Retry logic · Memory hygiene*

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh/)
[![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://docker.com/)
[![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=for-the-badge&logo=kubernetes&logoColor=white)](https://kubernetes.io/)

</div>

---

## 🗺️ Ecosystem Navigation — You Are Here

> This repository is **Module 5 of 5** in the **CodeSaga Distributed System**. Every module is an independent, deployable service. Navigate between them easily:

| Module | Repo | Role | Docker Image |
|--------|------|------|--------------|
| ① Client | [`codesaga`](https://github.com/jamesnagar11/codesaga) | Next.js Client — UI, Auth, Problem Pages | `jamesnagar/codesaga-client` |
| ② Socket Gateway | [`codesaga-websocket-server`](https://github.com/jamesnagar11/codesaga-websocket-server) | WebSocket server, Redis Streams producer, Pub/Sub subscriber | `jamesnagar/codesaga-ws` |
| ③ Execution Engine | [`codesaga-execution-engine`](https://github.com/jamesnagar11/codesaga-execution-engine) | Sandboxed code runner (Java, C++, Python) | `jamesnagar/codesaga-engine` |
| ④ Bulk DB Executor | [`codesaga-bulk-executor`](https://github.com/jamesnagar11/codesaga-bulk-executor) | Batches up to 100 DB writes in a single SQL statement | `jamesnagar/codesaga-bulk` |
| **⑤ You are here** | [`codesaga-bulk-master`](https://github.com/jamesnagar11/codesaga-bulk-master) | Auto-claims stale jobs, reconciles Redis memory | `jamesnagar/codesaga-cron` |
| ⚙️ GitOps Config | [`staging-ops`](https://github.com/jamesnagar11/staging-ops) | Kubernetes manifests managed by ArgoCD | — |

---

## 🏗️ Full System Architecture — Interactive Diagram

> **👉 [Open Rendered Interactive Diagram (GitHub Pages) →](https://jamesnagar11.github.io/codesaga/diagram/index.html)**  
>
> *Pan, zoom, shift arrows, hover nodes for details — switch to "⑤ Cron Sweeper" tab for this module's specific flow*

<div align="center">

[![Architecture Diagram](https://img.shields.io/badge/🔍_View_Interactive_Diagram-fbbf24?style=for-the-badge&logoColor=white)](https://jamesnagar11.github.io/codesaga/diagram/index.html)

</div>

---

### 📐 Full System Overview

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                     ☸  Kubernetes Cluster (k8s)                             ║
║                                                                              ║
║  Redis Stream: codesaga:events:db                                           ║
║  ┌──────────────────────────────────────────────────────────┐              ║
║  │  [job1][job2][job3][PENDING:job4 — worker crashed!][j5]  │              ║
║  └──────────────────────────────────┬─────────────────────┘               ║
║                                     │                                        ║
║                          ┌──────────┴──────────────────────────────────┐   ║
║                          │  XAUTOCLAIM (every 15 seconds)               │   ║
║                          └──────────┬────────────────────────┬──────────┘   ║
║                                     │                         │              ║
║                         ┌───────────▼─────────┐   ┌──────────▼──────────┐  ║
║                         │  ★ ⑤ Janitor (THIS)  │   │  ④ Bulk Executor   │  ║
║                         │  Cron sweep pod      │   │  Active processing  │  ║
║                         │                      │   └────────────────────┘  ║
║                         │  retry_count < 3?    │                            ║
║                         │    → re-enqueue      │                            ║
║                         │  retry_count ≥ 3?    │                            ║
║                         │    → ack + del        │                            ║
║                         │    (dead-letter)      │                            ║
║                         └──────────────────────┘                            ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

### 🔍 This Module — Recovery Flow

```
Every SLEEP_INTERVAL_MS (default: 15 seconds):

┌──────────────────────────────────────────────────────────────────┐
│                   ⑤ Janitor Sweep Iteration                       │
│                                                                    │
│  XAUTOCLAIM stream consumer_group janitor-{uuid}                  │
│    MIN_IDLE_TIME: 60,000ms  (jobs stuck > 60s)                    │
│    BATCH_SIZE: 50 messages                                         │
│                                                                    │
│  For each claimed message:                                         │
│    ├── Check retry_count field                                     │
│    │                                                               │
│    ├── retry_count < MAX_RETRIES (3)?                              │
│    │     → xAdd message back to stream with retry_count + 1       │
│    │     → xAck + xDel original                                    │
│    │     (bulk-executor will pick it up again)                     │
│    │                                                               │
│    └── retry_count >= MAX_RETRIES?                                 │
│          → xAck + xDel (drop — dead-letter)                        │
│          → Log for monitoring/alerting                             │
│                                                                    │
│  For already-deleted messages in PEL (deletedMessages[]):          │
│    → xAck them immediately (clean up stale PEL entries)           │
│                                                                    │
│  If more pages remain (cursor != '0-0'):                           │
│    → Sleep only 100ms and continue sweep (fast drain mode)         │
│  Else:                                                             │
│    → Reset cursor to '0-0', sleep SLEEP_INTERVAL_MS               │
└──────────────────────────────────────────────────────────────────┘
```

---

## 📋 What This Module Does

`codesaga-bulk-master` is the **reliability guardian** of the DB write pipeline. In any distributed message-processing system, workers can crash mid-job — leaving messages stuck in the **Pending Entries List (PEL)** of a Redis Consumer Group forever, causing memory leaks and guaranteed message loss.

This service runs as a **periodic cron sweeper** that uses Redis's `XAUTOCLAIM` command to:
1. Find messages that have been `PENDING` for longer than a configurable idle time (default: 60 seconds)
2. Attempt to retry them (with a retry counter) by re-enqueuing into the stream
3. After `MAX_RETRIES` attempts, acknowledge and delete the job (dead-letter behavior)
4. Clean up already-deleted message IDs from the PEL to prevent memory bloat

---

## 🛡️ Why This Service Is Critical

| Problem Without Janitor | Solution With Janitor |
|------------------------|----------------------|
| Worker pod crashes → jobs stuck in PEL forever | Jobs auto-claimed and re-enqueued after 60s |
| Redis PEL grows unboundedly → memory leak | Stale PEL entries cleaned up every cycle |
| No visibility into failed jobs | Retry counter tracks failure history |
| Guaranteed message loss on worker failure | At-least-once delivery guaranteed |
| Manual ops needed to recover stuck jobs | **Fully automated, zero-touch recovery** |

---

## 📊 Configuration & Tunability

The janitor is fully configurable via environment variables — tune it to your SLA:

| Config | Conservative (high-volume) | Aggressive (low-latency) |
|--------|---------------------------|-------------------------|
| `MIN_IDLE_TIME_MS` | 120,000 (2 min) | 30,000 (30s) |
| `SLEEP_INTERVAL_MS` | 30,000 (30s) | 5,000 (5s) |
| `BATCH_SIZE` | 100 | 25 |
| `MAX_RETRIES` | 5 | 2 |

---

## 🛠️ Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (Bun runtime) |
| Redis Command | `XAUTOCLAIM` (Redis 6.2+) |
| Stream Pattern | Consumer Group PEL recovery |
| Container | Docker (oven/bun:1, multi-stage) |
| Deployment | Kubernetes Deployment (single replica) |

---

## 📁 Project Structure

```
bulk-executor-janitor/
├── src/
│   ├── index.ts         # Main loop: xAutoClaim → retry/discard → sleep
│   └── config/
│       └── redis.ts     # Redis client setup
├── Dockerfile
└── .env
```

---

## ⚙️ Local Setup

### Prerequisites
- [Bun](https://bun.sh/) runtime
- Redis running locally (with the `codesaga:events:db` consumer group created)

---

### Method 1 — Manual Installation

```bash
# 1. Clone the repository
git clone https://github.com/jamesnagar11/codesaga-bulk-master.git
cd codesaga-bulk-master

# 2. Install dependencies
bun install

# 3. Create your .env file
cp .env.example .env   # fill in the values below

# 4. Build and run
bun run build
bun run start
```

---

### Method 2 — Docker (Build Locally)

```bash
docker build -t codesaga-cron .

docker run -d \
  -e REDIS_URL=redis://localhost:6379 \
  -e BULK_STREAM_KEY=codesaga:events:db \
  -e BULK_CONSUMER_GROUP=india-1 \
  -e MIN_IDLE_TIME_MS=60000 \
  -e BATCH_SIZE=50 \
  -e MAX_RETRIES=3 \
  -e SLEEP_INTERVAL_MS=15000 \
  codesaga-cron
```

---

### Method 3 — Docker (Pre-built Image from DockerHub) ⚡ Fastest

```bash
docker run -d \
  -e REDIS_URL=redis://localhost:6379 \
  -e BULK_STREAM_KEY=codesaga:events:db \
  -e BULK_CONSUMER_GROUP=india-1 \
  -e MIN_IDLE_TIME_MS=60000 \
  -e BATCH_SIZE=50 \
  -e MAX_RETRIES=3 \
  -e SLEEP_INTERVAL_MS=15000 \
  jamesnagar/codesaga-cron:latest
```

> ⚠️ **Note:** Run **exactly one** instance of this service per consumer group. Running multiple janitor pods against the same consumer group is safe (they will claim different batches via cursor) but a single pod is sufficient for most workloads.

---

### Method 4 — Run Full Platform (All 5 Services)

> See the [full Docker Compose setup in the main client repo →](https://github.com/jamesnagar11/codesaga#method-4--run-full-platform-all-5-services-with-docker-compose)

---

## 🌍 Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_URL` | ✅ | `redis://localhost:6379` | Redis connection URL (supports `rediss://` for TLS) |
| `BULK_STREAM_KEY` | ✅ | `codesaga:events:db` | Redis Stream key to sweep |
| `BULK_CONSUMER_GROUP` | ✅ | `india-1` | Consumer group to scan for pending messages |
| `MIN_IDLE_TIME_MS` | ✅ | `60000` | Min idle time (ms) before a pending message is auto-claimed |
| `BATCH_SIZE` | ✅ | `50` | Number of pending messages to claim per sweep iteration |
| `MAX_RETRIES` | ✅ | `3` | Max retry attempts before a message is dropped (dead-lettered) |
| `SLEEP_INTERVAL_MS` | ✅ | `15000` | Sleep duration (ms) between full sweep cycles |

---

## 🔗 Related: The Worker It Recovers

The janitor serves [`codesaga-bulk-executor`](https://github.com/jamesnagar11/codesaga-bulk-executor) — the worker that processes DB update batches. These two services form a **reliable at-least-once delivery pipeline** over Redis Streams.

---

## 🚀 Kubernetes / GitOps Deployment

This project uses a **fully declarative GitOps workflow**:

1. Push to `main` → GitHub Actions builds & pushes Docker image to DockerHub
2. GitHub Actions patches the image tag in `staging-ops` manifest
3. ArgoCD detects the diff and auto-syncs — **zero manual steps**

To explore Kubernetes manifests and ArgoCD Applications:

> 👉 **[staging-ops repo →](https://github.com/jamesnagar11/staging-ops)**

---

## 🧠 Design Patterns Used

| Pattern | Implementation |
|---------|---------------|
| **Consumer Group PEL Recovery** | `XAUTOCLAIM` command with cursor pagination |
| **Dead-letter Queue** | Jobs exceeding `MAX_RETRIES` are ack'd+del'd with a log |
| **Exponential-like fast sweep** | 100ms between pages when cursor ≠ `0-0` |
| **Graceful shutdown** | `SIGTERM`/`SIGINT` handlers set `isRunning = false` before quitting Redis |
| **Idempotent retry** | Re-enqueued messages carry `retry_count` to prevent infinite retries |

---

<div align="center">

**Built with ❤️ by [James Nagar](https://github.com/jamesnagar11)**  
*Part of the CodeSaga distributed platform — 5 microservices, 1 mission*

</div>
