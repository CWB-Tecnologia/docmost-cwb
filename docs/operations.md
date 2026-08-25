# Operação

Docmost roda em container na VM `srv1402182`, servido em `docs.cwbti.com.br`. Este
documento cobre o deploy e o dia a dia. Recuperação está em
[backup-restore.md](backup-restore.md) e [rollback.md](rollback.md).

Configuração de host — vhost do Apache, TLS/certbot, ufw, swap — vive no repo
**`infra-cwb`** e não é duplicada aqui.

## Onde as coisas moram

| caminho | o quê |
|---|---|
| `/opt/docmost-cwb/docker-compose.prod.yml` | **reinstalado do clone a cada deploy**; editar à mão na VM é revertido no tick seguinte |
| `/opt/docmost-cwb/.env` | modo 600, **única cópia**, nunca no git. Comece do `.env.example` |
| `/opt/docmost-cwb/scripts/` | `backup.sh`, `restore.sh`, `deploy.sh` — instalados pelo deploy a partir do clone |
| `/opt/docmost-cwb/backup/` | saída do `backup.sh`, modo 700 |
| `/opt/docmost-cwb-src/` | clone do repo, descartável; é daqui que o `deploy.sh` roda |
| `/etc/docmost-cwb/` | tokens (`ghcr.token`, `ghcr.user`, `github.token`) e o flag `hold` — 700 |
| `/var/lib/docmost-cwb/state` | o que está deployado e o que falhou, 600 |
| `/etc/systemd/system/docmost-deploy.{service,timer}` | o agendador do deploy, copiado de `scripts/systemd/` |
| `infra-cwb/apache/sites-available/docs.cwbti.com.br.conf` | o proxy reverso de verdade |

## Serviços

| serviço | imagem | porta publicada | volume | healthcheck |
|---|---|---|---|---|
| `docmost` | `ghcr.io/cwb-tecnologia/docmost-cwb:<tag>` | `127.0.0.1:3000` | `docmost` → `/app/data/storage` | `GET /api/health` |
| `db` | `postgres:18` | **nenhuma** | `db_data` → `/var/lib/postgresql` | `pg_isready` |
| `redis` | `redis:8` | **nenhuma** | `redis_data` → `/data` | `redis-cli ping` |

`db` e `redis` só são alcançáveis pela rede do compose. É assim que tem que ser.

## Volumes

Os nomes carregam o prefixo do projeto (`docmost-cwb_db_data`, …). Resolva, não
adivinhe:

```bash
docker volume ls --filter label=com.docker.compose.project=docmost-cwb
```

| volume | conteúdo | no backup? |
|---|---|---|
| `…_db_data` | o banco — autoritativo | sim, como dump lógico |
| `…_docmost` | anexos e imagens; **única cópia** enquanto `STORAGE_DRIVER=local` | sim, como tar |
| `…_redis_data` | filas BullMQ e locks de collab — derivado | não |

`docker-compose.prod.yml` **não** fixa `name:` nos volumes, diferente do `glpi-cwb`.
Isso é deliberado: renomear volume num stack vivo faz o Compose criar volumes novos
vazios, e o Docmost sobe sem nenhuma página. Os scripts resolvem por label
justamente pra não depender do prefixo.

## Deploy

**A VM puxa; o CI só publica imagem.** Runbook completo em [deploy.md](deploy.md) — aqui
fica só o que muda a forma de trabalhar:

1. push em `main` → `.github/workflows/publish.yml` builda e empurra `sha-<12>` e
   `main-latest` pro GHCR, e marca o commit como `pending`.
2. na VM, o timer `docmost-deploy` (5 em 5 min) faz `git fetch`, deriva a tag do HEAD,
   `compose pull docmost` e `up -d --wait`.
3. o resultado real aparece no commit status `deploy/vm-srv1402182` e em
   `journalctl -u docmost-deploy`.

**Actions verde não prova deploy.** Era `scp` + SSH até 2026-07-28; o SSH de entrada
passou a ter allowlist de IP e runner do GitHub tem IP dinâmico.

Deploy imediato à mão: `systemctl start docmost-deploy.service`. Pausar deploys:
`printf 'motivo\n' > /etc/docmost-cwb/hold`.

`stop_grace_period: 30s` no serviço `docmost` existe porque o shutdown descarrega os
documentos de collab pendentes no Postgres. Os 10s default do Docker dariam SIGKILL no
meio do flush e perderiam edição não salva **em todo deploy**.

Três fatos que valem saber antes de mergear:

- **Não há portão `DEPLOY_ENABLED`.** O `glpi-cwb` tem; este repo não. Todo push em
  `main` chega em produção em ≤5 min. O que existe é o `hold`, manual e na VM.
- **`migrateToLatest()` roda no boot** quando `NODE_ENV=production`
  (`apps/server/src/database/database.module.ts:139-141`). Todo deploy é também uma
  migration de schema. Consequências em [rollback.md](rollback.md).
- **A imagem anterior fica na VM** (retenção de duas tags no `deploy.sh`), então um pin
  de `IMAGE_TAG` é caminho rápido de verdade. Não era assim enquanto o deploy terminava
  em `docker image prune -af`.

### Credenciais na VM

Duas, `0600 root:root` em `/etc/docmost-cwb/` (`0700`), fora de qualquer backup:

| arquivo | tipo | para quê |
|---|---|---|
| `ghcr.token` + `ghcr.user` | PAT **clássico**, só `read:packages` | `docker login ghcr.io` |
| `github.token` | PAT **clássico**, só `repo:status` | postar o commit status do deploy |

**Os dois são clássicos porque fine-grained não funcionou em nenhum dos dois caminhos**: o
GHCR responde `Login Succeeded` e depois `denied`, e o POST de commit status devolve 404.
Nenhum dos dois entra no `.env` — `backup.sh` copia o `.env` pra dentro de todo arquivo de
backup, e o `.env` é `env_file` do container. Escopo, expiry e o que fazer quando o repo
virar privado (deploy key, não PAT) estão em [deploy.md](deploy.md).

Os secrets `VM_HOST`/`VM_PORT`/`VM_USER`/`VM_SSH_KEY` deste repo pertenciam ao deploy
por SSH e foram removidos; nenhum workflow usa segredo de VM hoje.

## Comandos do dia a dia

```bash
cd /opt/docmost-cwb
DC="docker compose -f docker-compose.prod.yml"

$DC ps
$DC logs -f docmost
$DC logs --tail=100 db

curl -fsS http://127.0.0.1:3000/api/health          # banco + redis
curl -fsS http://127.0.0.1:3000/api/health/live     # só liveness

# conexões e documentos de collab abertos (precisa COLLAB_SHOW_STATS=true no .env)
curl -fsS http://127.0.0.1:3000/api/collab/stats

$DC exec -T db sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

free -h ; docker stats --no-stream ; df -h /
```

Qual imagem está rodando agora — a tag, e o digest (que é o que distingue dois builds da
mesma tag). `RepoDigests` mora na **imagem**, não no container, daí o salto:

```bash
CID=$(docker compose -f docker-compose.prod.yml ps -q docmost)
docker inspect --format '{{.Config.Image}}' "$CID"
docker image inspect --format '{{index .RepoDigests 0}}' "$(docker inspect --format '{{.Image}}' "$CID")"
```

Ou de uma vez, junto com o que o deploy acha que deployou:

```bash
/opt/docmost-cwb-src/scripts/deploy.sh --status
```

## Regra do bind em loopback

Todo container nesta VM publica só em loopback. O Apache do host é a única coisa
escutando publicamente; ele termina TLS e faz proxy pra cá.

Isso **não** é garantido pelo firewall. O Docker escreve as próprias chains iptables
(`DOCKER`, `DOCKER-USER`), que o ufw não filtra — um container que publica em
`0.0.0.0:<porta>` fica alcançável mesmo com o ufw negando. A regra está em
`infra-cwb/host/ufw.md`; a única aplicação dela é o que está escrito no compose.

Auditoria depois de qualquer mudança no compose:

```bash
docker ps --format '{{.Names}}\t{{.Ports}}'
ss -tulpn | grep -v '127.0.0.1\|\[::1\]'
```

Esperado: `docmost -> 127.0.0.1:3000->3000/tcp`, `db` e `redis` sem portas, e nada
fora de loopback além de 22, 80 e 443.

`DOCMOST_HTTP_PORT` permite mudar isso, mas o default é loopback e é assim que
produção fica. `docker-compose.yml` (o de dev, herdado do upstream) mantém
`3000:3000` de propósito — é `localhost` na máquina de quem desenvolve, não a VM.

## Coisas que vão morder

- **2 vCPU e 8 GB** (upgrade de 2026-08-19; era 1 vCPU/3.8 GB), divididos com muito
  mais gente do que esta lista dizia: GLPI + MariaDB, Affine + Postgres/pgvector +
  Redis, RustDesk (`hbbs`/`hbbr`), MeshCentral, GlitchTip + Postgres + Valkey, a stack
  inteira do `support-platform` (5 serviços + Postgres + Redis próprios) e
  `listmonk_sindipar`. Medido em 2026-08-25: 3,5 GB em uso, 4,2 GB disponível, swap
  praticamente parada — RAM não é mais o aperto. Ver `infra-cwb/docs/vm-srv1402182.md`
  pro inventário completo e `infra-cwb/host/swap.md` pra receita do swap.
- **O Apache do host é ponto único de contenção pra todo mundo atrás dele** (GLPI,
  Docmost, GlitchTip, Affine, MeshCentral) — em 2026-08-25 ~144 túneis websocket do
  MeshCentral esgotaram `MaxRequestWorkers` do `mpm_prefork` e deixaram Docmost/GLPI
  respondendo em dezenas de segundos com `docker stats`/`vmstat` limpos o tempo todo.
  Causa e fix (MPM `event`, `MaxRequestWorkers 400`) em `infra-cwb/host/apache-mpm.md`.
  Se "recursos livres mas tudo lento" voltar a acontecer, comece por lá, não pelo
  container do Docmost.
- **O deploy pode encher o disco.** Cada imagem do Docmost ocupa ~1,8 GB e a tag puxada é
  imutável, então imagem velha não fica dangling sozinha. O `deploy.sh` mantém duas e
  recusa deploy com menos de 8 GB livres em `/var/lib/docker` — sem isso, encher o disco
  levaria Postgres e MariaDB junto.
- **`docs` é o vhost *default* em :80 e :443.** Qualquer `Host` desconhecido que chegue
  na VM cai no Docmost. Dívida rastreada em `infra-cwb/docs/vm-srv1402182.md`, não é
  deste repo.
- **Cloudflare Free corta request em 100 MB**, abaixo dos 200 MB de
  `FILE_IMPORT_SIZE_LIMIT`. Um import grande falha no edge, não na aplicação, e o log
  do container fica em silêncio.
- **Redis roda com `--maxmemory-policy noeviction`.** Redis cheio **para** a fila em
  vez de descartar job em silêncio. Falha barulhenta é a escolha certa aqui, mas
  significa que pressão de memória vira erro de aplicação.
- **Até 45s de digitação vivem só em memória** (`debounce: 10000`,
  `maxDebounce: 45000` em `collaboration.gateway.ts:52-53`). Importa para captura
  exata e para `docker kill`.
- **Logs de container sem limite.** `docker-compose.prod.yml` não define
  `max-size`/`max-file`, e o disco é de 48 GB. Ainda não é problema; vira um se
  `DEBUG_MODE=true` ficar ligado.

## Lacunas conhecidas

Uma linha cada, sem proposta — abrir issue antes de resolver:

- **Sem backup off-host.** `backup.sh` escreve no mesmo disco que protege. Já
  rastreado em `infra-cwb/docs/vm-srv1402182.md`.
- **Sem portão de deploy.** Todo push em `main` vai pra produção.
- **Sem monitoramento e sem alerta.** O commit status diz se o deploy pegou, mas é
  descoberta passiva: ninguém é acordado por um deploy que falhou de madrugada.
- **Token expirado mata o deploy em silêncio.** O `deploy.sh` avisa faltando ≤14 dias no
  journal; se ninguém ler o journal, o aviso não serve de nada.
- **`deploy.sh` quebrado em `main` desabilita todos os deploys futuros.** Mitigado por
  `.github/workflows/checks.yml` em PR, não eliminado.
- **O allowlist de rede não está documentado em nenhum repo** — e desde 2026-07-28 ele
  restringe também o **SSH de entrada**, que é o que matou o deploy antigo.
  `infra-cwb/host/ufw.md` ainda afirma `22/tcp ALLOW IN Anywhere`. A regra pertence ao
  `infra-cwb`; quem reconstruir a VM pela documentação atual não vai saber que existe.
- **Serviços na VM que nenhum repo versiona:** Affine (`affine_server` em
  `127.0.0.1:13010`, com Postgres/pgvector e Redis próprios), RustDesk (`hbbs`/`hbbr`
  escutando em `*:21115-21119` e `*:52838/udp`, **fora** de loopback) e
  `meshcentral-quicktest`. Inventário e regra de bind são do `infra-cwb`.
- **Sem limite de log de container** (acima).
