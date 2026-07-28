# Deploy

A VM **puxa**. O CI só publica imagem.

Até 2026-07-28 era o contrário: o workflow copiava o compose por `scp` e rodava
`docker compose up` por SSH. O SSH de entrada da VM passou a ser restrito a um allowlist
de IPs, e runner hospedado do GitHub tem IP dinâmico — todo run passou a morrer em
`dial tcp: i/o timeout`. Reabrir a porta era o conserto de uma linha; puxar de dentro é o
conserto que não exige porta de entrada nenhuma.

Consequência que vale internalizar: **o Actions verde só prova que a imagem existe.**
Quem diz se o deploy aconteceu é o commit status `deploy/vm-srv1402182` e o
`journalctl -u docmost-deploy` na VM.

## O que roda onde

| caminho na VM | o que é |
|---|---|
| `/opt/docmost-cwb-src/` | clone do repo, descartável (`git reset --hard` em todo tick) |
| `/opt/docmost-cwb/` | project dir do Compose — `.env`, `docker-compose.prod.yml`, `scripts/`, `backup/` |
| `/etc/docmost-cwb/` | `ghcr.token`, `ghcr.user`, `github.token`, `hold` — `0700`, tokens `0600` |
| `/var/lib/docmost-cwb/state` | o que está deployado, o que falhou, `0600` |
| `/etc/systemd/system/docmost-deploy.{service,timer}` | copiados de `scripts/systemd/`, não symlink |
| `/run/lock/docmost-cwb.lock` | lock compartilhado com `backup.sh` e `restore.sh` |

**O compose nunca roda de dentro do clone.** O nome do project do Compose vem do basename
do diretório, e `backup.sh`/`restore.sh` resolvem volume por esse label. Rodar em
`/opt/docmost-cwb-src` inventaria o project `docmost-cwb-src`, cria volumes **novos e
vazios** e o Docmost sobe com zero páginas. Daí `WorkingDirectory=/opt/docmost-cwb` na
unit, e o `deploy.sh` copiando os artefatos do clone pro project dir.

`deploy.sh` roda **do clone**, nunca de `/opt/docmost-cwb/scripts/`: bash lê script
incrementalmente e o `git reset --hard` trocaria o arquivo debaixo do shell em execução.
Efeito colateral: **mudança no `deploy.sh` só vale do tick seguinte.**

## Um tick, na ordem

`docmost-deploy.timer` dispara `docmost-deploy.service` a cada 5 min
(`OnUnitActiveSec=5min`, `RandomizedDelaySec=30`). O script:

1. Toma `flock -n` em `/run/lock/docmost-cwb.lock`. Ocupado ⇒ sai 0 (backup rodando).
2. Checa `/etc/docmost-cwb/hold`. Existe ⇒ loga uma vez e sai 0.
3. Pré-flight: docker respondendo, `git`, `.env` e compose presentes, **≥8 GB livres** em
   `/var/lib/docker`, `docker login ghcr.io` a partir do arquivo de token.
4. Avisa se alguma unit em `/etc/systemd/system` divergiu do repo.
5. `git fetch` + `reset --hard origin/main`; `TAG=sha-<12 primeiros do HEAD>`.
6. HEAD já deployado ⇒ sai 0 (linha `<7>` no journal). HEAD igual ao último que falhou ⇒
   avisa uma vez e sai 0 (ver [hold em falha](#quando-o-deploy-falha)).
7. Valida o compose **novo** como candidato antes de substituir o que está rodando
   (`config --quiet`), e avisa sobre `${VAR}` sem default que o `.env` não tem.
8. Instala `docker-compose.prod.yml` e `scripts/*.sh` no project dir.
9. `IMAGE_TAG=$TAG docker compose pull docmost`.
10. `up -d --wait --wait-timeout 300`.
11. Grava o state, posta commit status `success`, mantém as **2** imagens mais novas do
    Docmost e roda `docker image prune -f`.

### Por que o gatilho é o HEAD do git, e não o digest do registry

- **Git casa compose file com imagem por construção.** Este deploy é a prova: o commit
  `c49acbfd6ebb` muda o bind de porta *e* a imagem. Um gatilho por registry pode juntar
  "imagem nova + compose velho" dentro de um tick.
- **A imagem não diz de qual commit veio.** O `Dockerfile` só seta
  `org.opencontainers.image.source`, não `.revision`. Sem o commit não há commit status
  nem log legível.
- Comparar digest antes do pull não economiza round-trip (o `pull` já só baixa camada
  quando o digest mudou) e é a opção frágil: a tag é um **OCI index** com attestation de
  provenance, e `docker manifest inspect` não imprime o digest do próprio index.
- Puxar `sha-<12>` (imutável) faz o estado rodando ser função pura de um commit.

`pull docmost` e não `pull`: sem o serviço nomeado, o Compose também bate no Docker Hub
por `postgres:18` e `redis:8` em **todo tick** — rate limit anônimo por IP, e o IP é o
mesmo do stack do GLPI.

### A janela dos 404

A VM vê o commit antes do build publicar `sha-<12>`. O `pull` falha com
`manifest unknown`, o script loga info e **sai 0**; o próximo tick tenta de novo. Se o HEAD
ficar não-deployado por mais de 30 min, sai aviso `<4>` e commit status `error` — é assim
que se descobre que um **build** falhou, sem ficar olhando o Actions.

## Códigos de saída

| exit | significado | segura os deploys? |
|---|---|---|
| 0 | nada a fazer / imagem ainda não publicada / lock ocupado / `hold` | não |
| 1 | pré-flight falhou e **nada foi tocado** (docker fora, sem rede, 401, compose inválido, disco baixo) | não — tenta no próximo tick |
| 2 | o stack foi recriado e não ficou saudável | **sim**, até um humano |

Exit 1 deixa a unit em `failed` (aparece em `systemctl --failed`) e mesmo assim continua
tentando — o comportamento certo pra "token expirou".

## Quando o deploy falha

Se `up -d --wait` falha, o container **já foi recriado** e, se o commit trazia migration,
`migrateToLatest()` **já rodou** (`apps/server/src/database/database.module.ts:139-141`).
Não há rollback automático de propósito: voltar a imagem contra schema migrado costuma ser
pior que o bug original — [rollback.md](rollback.md).

O script então: joga `ps` e os últimos 200 logs no journal, grava `last_failed_sha`, posta
commit status `failure` e sai 2. **O tick seguinte não recria nada** enquanto o HEAD for
aquele commit. Sem esse hold, o timer recriaria o container e re-rodaria migration a cada
5 min pra sempre, num box de 1 vCPU.

Depois de consertar (ou de mergear um `git revert`):

```bash
/opt/docmost-cwb-src/scripts/deploy.sh --force
```

## Comandos do operador

```bash
# deploy agora (bloqueia até terminar e devolve o exit code)
systemctl start docmost-deploy.service; echo "exit=$?"
journalctl -u docmost-deploy -n 80 --no-pager
journalctl -fu docmost-deploy                      # acompanhar um deploy longo

# só o que importa: avisos e falhas, sem as linhas de "nada a fazer"
journalctl -u docmost-deploy -p warning --since -7d

# o que está deployado, o hold, o digest rodando e a saúde
/opt/docmost-cwb-src/scripts/deploy.sh --status

# estado do agendamento
systemctl list-timers 'docmost-deploy*' --all
```

### Pausar deploys (`hold`)

```bash
printf 'rollback pinado em sha-XXXX — kauan 2026-07-28\n' > /etc/docmost-cwb/hold
```

Enquanto o arquivo existir, todo tick sai 0. É o que faz um pin de `IMAGE_TAG` no `.env`
parar de rolar pra frente sozinho — ver [rollback.md](rollback.md). Apagar o arquivo
retoma, e o journal registra a retomada.

### Cirurgia manual

Antes de mexer no stack à mão, tome o lock ou ponha o `hold` — senão o timer pode
reiniciar a aplicação debaixo de você:

```bash
flock /run/lock/docmost-cwb.lock bash -c 'cd /opt/docmost-cwb && ...'
```

O cron do backup em [backup-restore.md](backup-restore.md) já usa esse mesmo lock.

## Credenciais na VM

Duas, arquivos separados pra revogar e rotacionar independente:

| arquivo | tipo | para quê |
|---|---|---|
| `/etc/docmost-cwb/ghcr.token` + `ghcr.user` | PAT clássico, **só** `read:packages` | `docker login ghcr.io` |
| `/etc/docmost-cwb/github.token` | PAT clássico, **só** `repo:status` | postar o commit status |
| `/etc/docmost-cwb/git.token` | PAT fine-grained, **Contents: read** | `git fetch` — **só necessário quando o repo virar privado** |

Os dois são **clássicos** porque os dois caminhos recusaram fine-grained na prática: o GHCR
faz `Login Succeeded` e depois responde `denied`, e o POST de status devolveu 404. Vale
tentar fine-grained de novo se a org habilitar — o escopo seria bem menor —, mas não fique
depurando: o sintoma é sempre 403/404/`denied`, nunca "token inválido".

`repo:status` é mais largo do que parece: vale para **todo** repo que a conta dona alcança.
É só escrita de status, não de conteúdo, e é o preço de não depender de aprovação de org.

Quando este repo virar privado, o `git fetch` precisa de credencial própria — e **não** a do
commit status. O `glpi-cwb` provou isso do jeito ruim: `repo:status` não dá leitura de
conteúdo, e o fetch morre com `could not read Username for 'https://github.com'`. Duas
opções, ambas suportadas pelo script sem mudança de código:

- **deploy key read-only** por SSH: um repo, leitura, sem expiry, nenhum arquivo de token —
  aponte a remote do clone pra `git@github.com:...` e pronto;
- **`/etc/docmost-cwb/git.token`**: PAT fine-grained com Contents: read-only, que o script
  injeta como credential helper.

Sem nenhum dos dois, o `git` cai no que a conta root tiver configurado (nesta VM, `gh auth`).
Funciona, e é a coisa errada pra depender: credencial de uma pessoa, que rotaciona sem avisar
o timer.

Regras que não são estilo, são consequência:

- **Nenhum dos dois no `.env`.** `backup.sh` faz `cp -a .env "$DEST/env"`, então o token
  entraria em **todo** arquivo de backup — que a gente manda copiar pra fora da VM. E
  `.env` é `env_file` do container, então o token apareceria em `docker inspect`.
- O `docker login` é persistido no bootstrap **e** refeito em cada tick. O persistido é o
  que faz um `docker pull ghcr.io/…:sha-<antiga>` de madrugada funcionar; o por-tick
  transforma "token expirado" em erro explícito na primeira linha do journal.
- **Expiry é como um deploy pull-based morre em silêncio.** O script lê o header
  `github-authentication-token-expiration` da API e avisa `<4>` faltando ≤14 dias. Isso
  não substitui anotar a existência dos tokens: segredo não se lê de volta do GitHub, este
  doc é o inventário.
- O PAT clássico `read:packages` lê **todo** package privado que o dono vê, inclusive a
  imagem do `glpi-cwb`. A versão apertada, se incomodar, é conta bot colaboradora
  read-only só deste repo.
- Se o package do GHCR virar público, `ghcr.token`/`ghcr.user` deixam de ser necessários e
  o script segue funcionando sem eles.

## Retenção de imagem e disco

`docker image prune -af` **saiu do deploy**. O `-a` apaga toda imagem sem container em
**todos** os stacks do host, e nesta VM as vítimas são concretas: `alpine:3` (que
`backup.sh` usa via `docker run --rm` e que nenhum container referencia entre backups →
o próximo backup re-puxaria anônimo do Docker Hub), as imagens de reserva do GLPI e do
MeshCentral, e a imagem anterior do próprio Docmost.

No lugar: ficam **a tag recém-deployada e a anterior** (mais `main-latest`, se existir
local), e só o dangling é podado. A seleção é por **tag, não por idade**: no Docker 29
desta VM todo build desta imagem reporta o **mesmo** `{{.CreatedAt}}` e o `{{.ID}}` é o
digest do índice — ordenar por data é sorteio que pode escolher a imagem em uso. E o
`docker rmi` roda **sem `-f`** de propósito: imagem ainda referenciada recusa, e isso é a
rede de segurança. Isso é o que faz o pin de `IMAGE_TAG` em [rollback.md](rollback.md)
ser caminho rápido em vez de 401.

Como agora se puxa tag imutável, imagem **não fica dangling sozinha**: sem essa retenção o
disco cresceria uma imagem (~1,8 GB) por merge, e "o deploy encheu o disco e levou o GLPI"
é outage mais provável nesta VM que o deploy falhar. Daí também a guarda de pré-flight de
8 GB livres.

## Lacunas conhecidas

- **Commit status é descoberta, não alerta.** Ninguém é acordado. Um deploy que falhou às
  3h da manhã fica vermelho no commit e esperando alguém olhar. O canal mais barato seria
  um dead-man switch (ping em serviço externo, e-mail quando o ping não chega) — decidido
  como fora de escopo por ora.
- **Token que expira mata os deploys.** Mitigado pelo aviso de 14 dias, não resolvido.
- **`deploy.sh` quebrado em `main` desabilita todos os deploys futuros** em silêncio (a VM
  segue tiquetaqueando e falhando pré-flight). Mitigado pelo `.github/workflows/checks.yml`
  (shellcheck + `compose config` + `systemd-analyze verify`) em PR.
- **Não há portão `DEPLOY_ENABLED`** como no `glpi-cwb`: todo push em `main` chega em
  produção em ≤5 min. O que existe é o `hold`, que é manual e mora na VM.
- **`glpi-cwb` ainda tem o deploy por scp+ssh**, atrás de `vars.DEPLOY_ENABLED`. Não está
  falhando só porque está desligado; no minuto que ligar, falha igual. Portar este padrão
  para lá é trabalho pendente.
