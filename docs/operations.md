# Operação

Docmost roda em container na VM `srv1402182`, servido em `docs.cwbti.com.br`. Este
documento cobre o deploy e o dia a dia. Recuperação está em
[backup-restore.md](backup-restore.md) e [rollback.md](rollback.md).

Configuração de host — vhost do Apache, TLS/certbot, ufw, swap — vive no repo
**`infra-cwb`** e não é duplicada aqui.

## Onde as coisas moram

| caminho | o quê |
|---|---|
| `/opt/docmost-cwb/docker-compose.prod.yml` | **sobrescrito por todo deploy**; editar à mão na VM é revertido no próximo push |
| `/opt/docmost-cwb/.env` | modo 600, **única cópia**, nunca no git. Comece do `.env.example` |
| `/opt/docmost-cwb/scripts/` | `backup.sh` e `restore.sh`, entregues à mão (ver abaixo) |
| `/opt/docmost-cwb/backup/` | saída do `backup.sh`, modo 700 |
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

`.github/workflows/deploy.yml`, em todo push para `main`:

1. build e push pro GHCR com duas tags: `sha-<12>` e `main-latest`
2. `scp` do `docker-compose.prod.yml` para `/opt/docmost-cwb`
3. via SSH: `docker login` → `compose pull` → `compose up -d --wait` →
   `docker image prune -af`

O `--wait` é portão de healthcheck: o job só passa quando os três serviços ficam
saudáveis.

`stop_grace_period: 30s` no serviço `docmost` existe porque o shutdown descarrega os
documentos de collab pendentes no Postgres. Os 10s default do Docker dariam SIGKILL no
meio do flush e perderiam edição não salva **em todo deploy**.

Três fatos que valem saber antes de mergear:

- **Não há portão `DEPLOY_ENABLED`.** O `glpi-cwb` tem; este repo não. Todo push em
  `main` chega em produção.
- **`migrateToLatest()` roda no boot** quando `NODE_ENV=production`
  (`apps/server/src/database/database.module.ts:139-141`). Todo deploy é também uma
  migration de schema. Consequências em [rollback.md](rollback.md).
- **`docker image prune -af` apaga a imagem anterior** da VM. Rollback não é pegar a
  imagem de volta do disco.

### Segredos do repositório

`VM_HOST`, `VM_PORT`, `VM_USER`, `VM_SSH_KEY` — setados **neste repositório**, não na
organização. O motivo (plano Free do GitHub, secrets de organização não alcançam repo
privado, o modo silencioso como isso falha) está documentado em `glpi-cwb/README.md`;
não vale repetir aqui.

### Entregar os scripts na VM

O deploy copia **só** o `docker-compose.prod.yml` (`deploy.yml:73`). `scripts/` vai à
mão. **Windows (PowerShell):**

```powershell
scp -r scripts <user>@<vm>:/opt/docmost-cwb/
```

Na VM:

```bash
chmod 700 /opt/docmost-cwb/scripts/*.sh
```

> **Lacuna conhecida:** script alterado neste repo **não** chega sozinho na VM. Depois
> de qualquer mudança em `scripts/`, re-copie e confirme que os dois lados batem antes
> de confiar num backup:
> ```bash
> sha256sum /opt/docmost-cwb/scripts/*.sh     # na VM
> ```
> ```powershell
> Get-FileHash scripts\*.sh -Algorithm SHA256 # no Windows
> ```

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

Qual imagem está rodando agora:

```bash
docker inspect --format '{{.Config.Image}}' "$(docker compose -f docker-compose.prod.yml ps -q docmost)"
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

- **1 vCPU e 3.8 GB, sem swap por default,** divididos com GLPI, MariaDB, Postgres,
  Redis e MeshCentral. Antes de qualquer coisa pesada, confira `swapon --show` e a
  receita em `infra-cwb/host/swap.md`.
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
- **Sem monitoramento.** Os healthchecks existem e ninguém os observa; não há alerta.
- **Entrega manual de `scripts/`**, com o risco de divergência descrito acima.
- **O allowlist de rede que restringe o acesso ao origin não está documentado em
  nenhum repo.** `infra-cwb/host/ufw.md` cobre só o ufw, que não pega tráfego
  publicado por container. A regra pertence ao `infra-cwb`, não a este repo — mas
  quem reconstruir a VM a partir da documentação atual não vai saber que ela existe.
- **Sem limite de log de container** (acima).
