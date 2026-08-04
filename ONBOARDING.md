# ONBOARDING — docmost-cwb

Fork CWB do [Docmost](https://docmost.com) (wiki/docs colaborativo, AGPL-3.0).
Este arquivo cobre **rodar localmente**; operação/deploy/rollback/backup em
produção estão em [`docs/`](docs/README.md).

## Rodando local (dev)

Pré-requisitos: Node compatível com `pnpm@11.15.1` (definido em
`packageManager`), Postgres e Redis (locais ou via `docker-compose.yml`, que
sobe `docmost` + `db` (Postgres) + `redis` no formato self-host simples do
upstream — diferente do `docker-compose.prod.yml`, que é o fork rodando na VM).

```bash
git clone <repo> && cd docmost-cwb
pnpm install

cp .env.example .env
# preencher no mínimo:
#   APP_URL=http://localhost:3000
#   APP_SECRET=$(openssl rand -hex 32)   # min. 32 chars
#   DATABASE_URL=postgresql://postgres:password@localhost:5432/docmost?schema=public
#   REDIS_URL=redis://127.0.0.1:6379

docker compose up -d db redis   # só Postgres+Redis, se não tiver local
pnpm dev                        # client (Vite) + server (Nest) juntos, concurrently
```

Notas:

- `packages/ee` é um **submodule** licenciado à parte (Enterprise License) —
  pode estar ausente/privado num clone novo. Sem ele, as rotas de
  `apps/server/src/ee` não existem: `SELF_HOSTED_UNLOCK_FEATURES` mesmo com
  `*` não liga o que não está presente (ver `docs/ee-feature-status.md`).
  Dev do core funciona normalmente sem o submodule.
- `COLLAB_URL` fica **vazio** em same-origin — o cliente deriva
  `wss://<origin>/collab` sozinho. Só preencher rodando o servidor de collab
  separado (`pnpm collab:dev`).

## Comandos úteis

Raiz (`package.json`):

```bash
pnpm dev              # client+server em paralelo (concurrently)
pnpm build            # nx run-many -t build (todos os projetos)
pnpm start            # server em modo produção
pnpm collab:dev       # servidor de collab (Hocuspocus) separado, dev
pnpm email:dev        # preview de templates de e-mail
pnpm clean            # limpa dist/ + cache do Vite
```

`apps/server` (Nest + Kysely):

```bash
pnpm --filter ./apps/server test        # unit
pnpm --filter ./apps/server test:e2e
pnpm --filter ./apps/server test:cov
pnpm --filter ./apps/server lint

pnpm --filter ./apps/server migration:create <nome>
pnpm --filter ./apps/server migration:up
pnpm --filter ./apps/server migration:down
pnpm --filter ./apps/server migration:latest
pnpm --filter ./apps/server migration:codegen
```

`apps/client` (Vite + React):

```bash
pnpm --filter ./apps/client dev
pnpm --filter ./apps/client build
pnpm --filter ./apps/client lint
pnpm --filter ./apps/client test        # vitest
```

## Arquitetura

- **Server**: NestJS, acesso a dados via Kysely sobre Postgres.
- **Client**: React + Vite, editor rich-text Tiptap.
- **Colaboração em tempo real**: Hocuspocus (Yjs CRDT) via websocket
  `/collab`, com Redis como backplane entre réplicas (contrato completo de
  proxy reverso/upgrade de websocket em `docs/reverse-proxy.md`).
- **Monorepo Nx** (`apps/*`, `packages/*`): `packages/base-formula`,
  `packages/editor-ext` (extensões Tiptap, `@docmost/editor-ext`),
  `packages/ee` (Enterprise, submodule separado — ver acima).
- **Armazenamento de arquivo**: driver plugável (`local` | `s3` | `azure`,
  `STORAGE_DRIVER`).

## Topologia (produção)

Roda na VM `srv1402182` (dona do host: repo **`infra-cwb`**) como
`docs.cwbti.com.br`. Apache do host termina TLS (certbot) e faz proxy pra
`127.0.0.1:3000` (`DOCMOST_HTTP_PORT`, sempre loopback — `ufw` não filtra
portas publicadas pelo Docker). Deploy é **puxado pela VM**, não empurrado
pelo CI: timer `docmost-deploy` faz `git fetch` + `compose pull` + `up -d
--wait` a cada 5 min, usando a tag `IMAGE_TAG` derivada do commit
(`docs/deploy.md`). Runbooks completos — deploy, rollback, backup/restore,
contrato de proxy reverso, import/export, status de features EE — em
[`docs/README.md`](docs/README.md).
