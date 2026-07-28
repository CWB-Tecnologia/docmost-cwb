# Backup e restore

O Docmost guarda o dado menos substituível da VM: páginas escritas à mão. Não há de
onde reimportar. Este documento é o procedimento; os scripts que o executam são
`scripts/backup.sh` e `scripts/restore.sh`.

> **Não existe backup off-host.** `scripts/backup.sh` escreve em
> `/opt/docmost-cwb/backup`, no **mesmo disco** que protege. Perda do disco leva os
> dois. Já rastreado como dívida em `infra-cwb/docs/vm-srv1402182.md`; até resolver,
> copie os arquivos para fora da máquina.

## O que é estado

| o quê | onde | vai pro backup? |
|---|---|---|
| banco | volume `…_db_data` → `/var/lib/postgresql` | **sim**, como dump lógico |
| anexos e imagens | volume `…_docmost` → `/app/data/storage` | **sim**, como tar |
| `.env` | `/opt/docmost-cwb/.env` | **sim**, modo 600 |
| filas e locks de collab | volume `…_redis_data` → `/data` | **não**, é derivado |
| a imagem | GHCR | **não**, reconstruível do git |
| tokens do deploy | `/etc/docmost-cwb/*.token` | **não, de propósito** — credencial de máquina |

Os tokens ficam de fora porque este arquivo mesmo manda copiar o backup pra fora da VM:
credencial de leitura do GHCR e de escrita de commit status não têm o que fazer viajando
junto. VM reconstruída re-emite os dois — [deploy.md](deploy.md).

O `.env` entra porque sem ele o stack restaurado **não sobe**: `DATABASE_URL` precisa
casar com `POSTGRES_*`, e um `APP_SECRET` diferente invalida toda sessão e todo token
já emitido. Backup do qual não se consegue dar boot não é backup.

`redis_data` fica de fora de propósito. São filas BullMQ e locks por documento —
perder custa no máximo um e-mail de notificação não enviado. Não vale o tamanho nem o
risco de restaurar fila velha.

Os nomes reais dos volumes carregam o prefixo do projeto. Resolva, não adivinhe:

```bash
docker volume ls --filter label=com.docker.compose.project=docmost-cwb
```

## Por que dump lógico e não cópia de volume

`docker-compose.prod.yml` monta `db_data:/var/lib/postgresql`, **não**
`.../postgresql/data`. Isso está correto para `postgres:18`: a imagem declara o volume
um nível acima e coloca o cluster num subdiretório versionado pelo major. Confirme na
caixa em vez de confiar neste parágrafo:

```bash
docker compose -f docker-compose.prod.yml exec -T db sh -c 'echo "PGDATA=$PGDATA"; ls -la /var/lib/postgresql'
docker compose -f docker-compose.prod.yml exec -T db sh -c \
  'exec psql -U "$POSTGRES_USER" -Atc "show data_directory; show server_version;"'
```

Copiar o volume tem dois problemas: só é consistente com o servidor **parado**, e o
resultado fica preso ao major do Postgres que o gerou — um upgrade de `18` para `19`
transforma o backup em lixo. O dump lógico é portável entre majors, restaura num
volume vazio, e é pequeno. É a mesma escolha que o `mariadb-dump` no `glpi-cwb`.

Cópia de volume tem um uso legítimo: clonar a frio para o ensaio de restore.

## Ordem importa: banco primeiro, volume depois

`backup.sh` faz nessa ordem, e não é arbitrário.

- Anexo subido **entre** os dois snapshots: existe o arquivo no tar, não existe a
  linha em `attachments`. Um arquivo órfão que ninguém referencia — inofensivo.
- Ordem inversa: existe a linha em `attachments`, não existe o arquivo. Download
  quebrado depois do restore, e o usuário só descobre quando clica.

Errar pro lado do arquivo órfão é de graça. Errar pro outro lado não.

## ⚠️ Edição em voo não está no dump

O collab persiste com debounce de 10s e teto de 45s
(`apps/server/src/collaboration/collaboration.gateway.ts:52-53`). Até 45 segundos de
digitação vivem **só em memória** do container.

Pro cron noturno isso é irrelevante. Para uma captura que precisa ser exata — antes de
um upgrade, antes de um restore — pare a aplicação primeiro:

```bash
cd /opt/docmost-cwb
flock /run/lock/docmost-cwb.lock bash -c '
  docker compose -f docker-compose.prod.yml stop docmost   # os 30s de grace fazem o flush
  bash scripts/backup.sh
  docker compose -f docker-compose.prod.yml up -d --wait'
```

O `stop_grace_period: 30s` do compose existe exatamente pra esse flush terminar. Os
10s default do Docker dariam SIGKILL no meio dele.

**O `flock` não é enfeite.** O timer `docmost-deploy` roda a cada 5 min e faz `up -d`, que
**sobe serviço parado** — sem o lock, ele reinicia o Docmost no meio do seu `pg_dump` e a
captura exata deixa de ser exata. O `deploy.sh` toma o mesmo lock e sai limpo quando está
ocupado.

## Backup

```bash
cd /opt/docmost-cwb
bash scripts/backup.sh
```

Produz `/opt/docmost-cwb/backup/<AAAAMMDD-HHMMSS>/` com:

| arquivo | o quê |
|---|---|
| `MANIFEST.txt` | timestamp, versão do servidor, contagem exata de linhas por tabela, bytes de `ydoc` |
| `docmost.dump` | `pg_dump -Fc` (auto-comprimido) |
| `storage.tar.gz` | volume de anexos |
| `env` | cópia do `.env` |
| `SHA256SUMS` | checksums — **escrito por último** |

**`SHA256SUMS` é o marcador de completude.** Diretório sem ele é backup que não
terminou, e `restore.sh` se recusa a ler. Não remova essa checagem.

As primitivas que o script embrulha, se precisar rodar à mão:

```bash
cd /opt/docmost-cwb
DEST=/opt/docmost-cwb/backup/manual-$(date +%Y%m%d-%H%M%S)
mkdir -p "$DEST" && chmod 700 "$DEST"

docker compose -f docker-compose.prod.yml exec -T db sh -c '
    exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -Fc --no-owner --no-privileges --compress=6' > "$DEST/docmost.dump"

VOL=$(docker volume ls -q \
  --filter label=com.docker.compose.project=docmost-cwb \
  --filter label=com.docker.compose.volume=docmost)
docker run --rm -v "$VOL":/src:ro -v "$DEST":/dst alpine:3 \
    tar -czf /dst/storage.tar.gz -C /src .

cp -a .env "$DEST/env" && chmod 600 "$DEST"/*
```

### Cron

```
30 2 * * * root flock -w 3600 /run/lock/docmost-cwb.lock sh -c 'cd /opt/docmost-cwb && bash scripts/backup.sh' >> /var/log/docmost-backup.log 2>&1
```

**02:30, não 02:15** — o `glpi-cwb` roda às 02:15 e a VM tem 1 vCPU. Dois dumps
concorrentes na mesma CPU fazem os dois demorarem e degradam os dois serviços.

O `flock -w 3600` é o mesmo lock do deploy: se um deploy estiver no meio de um
`up -d --wait`, o backup espera em vez de tirar dump de um stack sendo recriado. Uma hora
de espera é folgada de propósito — melhor backup atrasado que backup inconsistente.

O script vem de `/opt/docmost-cwb/scripts/` e **é** atualizado a cada deploy, instalado do
clone pelo `deploy.sh`. Mudança em `backup.sh` chega sozinha na VM no tick seguinte ao
merge; não há mais ritual de `scp` + comparar `sha256sum`.

## Restore

**Destrutivo.** Dropa o banco e apaga o volume de anexos.

```bash
cd /opt/docmost-cwb
bash scripts/restore.sh /opt/docmost-cwb/backup/<stamp> --yes
```

O script verifica os checksums, para a aplicação, recria o banco, roda `pg_restore`
numa única transação, repovoa o volume de anexos com `chown 1000:1000` e sobe tudo de
volta com `--wait`.

Três coisas que ele faz por motivo específico:

- **Para o `docmost` antes de tocar no banco.** A aplicação roda `migrateToLatest()`
  no boot (`apps/server/src/database/database.module.ts:139-141`). Restaurar embaixo de
  uma instância viva corre contra o migrador.
- **`dropdb --force`** em vez de `pg_terminate_backend` na mão: é a primitiva
  documentada desde o PG 13 e evita SQL aninhado em aspas.
- **`chown 1000:1000`**, não `33:33` como no `glpi-cwb`: a imagem do Docmost roda
  `USER node` (uid 1000). Arquivo de outro dono é ilegível pra aplicação.

### ⚠️ Restaurar exige superusuário

O dump recria `unaccent`, `pg_trgm`, a função `f_unaccent` e o trigger
`pages_tsvector_trigger`
(`apps/server/src/database/migrations/20250729T213756-*.ts`). `CREATE EXTENSION` exige
superusuário. Use `$POSTGRES_USER` — é o superusuário que a imagem cria no bootstrap.
Um papel menor falha no meio do restore.

### ⚠️ Restore não é rollback de schema no sentido inverso

Se o dump é **mais antigo** que a imagem rodando, o boot migra o schema restaurado
**pra frente** automaticamente, porque `migrateToLatest()` roda em todo boot de
produção. Isso é esperado e não tem volta: a imagem não carrega caminho de
`down`-migration. Para descer de versão de schema é preciso descer a imagem também —
ver [rollback.md](rollback.md).

### Conferir

```bash
cat /opt/docmost-cwb/backup/<stamp>/MANIFEST.txt

docker compose -f docker-compose.prod.yml exec -T db sh -c 'exec psql -q -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  select (select count(*) from pages) pages, (select count(*) from users) users,
         (select count(*) from spaces) spaces, (select count(*) from attachments) attachments"'
```

As contagens têm que bater com o `MANIFEST.txt`. Depois abra uma página real no
navegador e baixe um anexo — o banco pode estar íntegro com o volume vazio.

## Ensaio de restore

Restore que nunca foi ensaiado é um palpite. Rode num projeto descartável, em segunda
porta de loopback — é **por isso** que `DOCMOST_HTTP_PORT` é variável:

```bash
cd /opt/docmost-cwb
export COMPOSE_PROJECT_NAME=docmost-rehearsal DOCMOST_HTTP_PORT=127.0.0.1:3001

# o stack inteiro, não só o db: é o boot do serviço `docmost` que CRIA o volume de
# anexos do projeto de ensaio. Sem ele, restore.sh aborta em "expected exactly 1
# volume". Nesta primeira subida o Docmost migra um banco vazio — esperado, o
# restore passa por cima logo em seguida.
docker compose -f docker-compose.prod.yml up -d --wait

bash scripts/restore.sh /opt/docmost-cwb/backup/<stamp> --yes
curl -fsS http://127.0.0.1:3001/api/health
# abra http://127.0.0.1:3001 por um túnel SSH e confira uma página de verdade
```

Limpar depois:

```bash
COMPOSE_PROJECT_NAME=docmost-rehearsal DOCMOST_HTTP_PORT=127.0.0.1:3001 \
  docker compose -f docker-compose.prod.yml down -v
```

> ### ⚠️ `down -v` com `COMPOSE_PROJECT_NAME` errado destrói produção
>
> `-v` apaga os volumes do projeto. Se a variável não estiver setada — nova sessão de
> shell, `sudo` sem `-E`, um `exit` no meio — o projeto vira `docmost-cwb` e o comando
> apaga o banco e os anexos de produção.
>
> Confira **antes** de teclar enter:
> ```bash
> echo "$COMPOSE_PROJECT_NAME"    # tem que imprimir docmost-rehearsal
> docker compose -f docker-compose.prod.yml config --volumes
> docker volume ls | grep rehearsal
> ```
> A VM tem 1 vCPU e 3.8 GB dividida com GLPI, Postgres, Redis e MeshCentral: rode o
> ensaio fora do horário comercial.

## Retenção e disco

Padrão 14 dias (`RETENTION_DAYS`). O disco é de 48 GB com ~38 GB livres, dividido com
os 14 dias de dumps do `glpi-cwb`, que são da ordem de 1,6 GB cada. O script imprime
`du -sh` e o `df` do destino no fim — se a margem apertar, reduza a retenção aqui antes
de mexer na do GLPI, porque este dataset é menor.

## ⚠️ Os arquivos são segredo

Um diretório de backup contém toda página, todo anexo, hashes de senha e o `.env`
vivo com `APP_SECRET`, senha do Postgres e credencial de SMTP. Vale mais que qualquer
credencial isolada da VM.

- modo 700 no diretório, 600 nos arquivos — o script faz, não desfaça
- nunca em caminho world-readable, e **nunca em `/home`**: é exatamente a dívida do
  `/home/glpi.sql` já registrada em `infra-cwb/docs/vm-srv1402182.md`
- ao copiar pra fora da máquina, criptografe em trânsito e em repouso
