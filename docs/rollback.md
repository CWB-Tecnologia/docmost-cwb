# Rollback

Leia a tabela antes de digitar qualquer coisa. Os caminhos são diferentes e escolher o
errado custa dado.

| sintoma | ação |
|---|---|
| regressão de código, **sem** migration no range | `git revert` + merge |
| regressão de código, **com** migration no range | backup → `git revert` + merge → avaliar restore |
| dado corrompido ou apagado por usuário | **só** restore — [backup-restore.md](backup-restore.md) |
| container não sobe, banco intacto | investigar logs; rollback de imagem não conserta config |
| proxy, TLS ou DNS quebrado | não é este repo — `infra-cwb`, `./scripts/apply-vhosts.sh` (backups em `/var/backups/infra-cwb-<stamp>`) |

## Passo 0 — o range inclui migration?

Isso decide tudo o que vem depois. **Windows (PowerShell):**

```powershell
git fetch origin
git diff --name-only <sha-bom>..<sha-ruim> -- apps/server/src/database/migrations/
```

Saída vazia ⇒ só código. Voltar a imagem resolve.

Saída não-vazia ⇒ o schema já mudou. Voltar só a imagem faz código velho rodar contra
schema novo, o que costuma ser pior que o bug original. **Tire um backup antes de
qualquer coisa** e leia a seção abaixo.

### ⚠️ Rollback de imagem não desfaz migration

A imagem de produção não tem caminho de `down`-migration. `migration:down` roda via
`tsx src/database/migrate.ts`, e o estágio de runtime do `Dockerfile` copia só `dist` —
sem `src/`, sem `tsx`. Não é configuração, é o que foi construído.

Consequências:

- descer o schema exige **restore de banco**, não rollback de imagem
- restaurar um dump antigo numa imagem nova sobe o schema de volta sozinho, porque
  `migrateToLatest()` roda em todo boot de produção
  (`apps/server/src/database/database.module.ts:139-141`)
- para descer de verdade: restaure o dump **e** pine a imagem da mesma época, na mesma
  janela

## Caminho principal: `git revert` + merge

É o rollback recomendado. Não precisa de credencial nova, não mexe em `main-latest`,
e o estado final é reproduzível a partir do git.

```powershell
git switch main
git pull
git revert --no-edit <sha-ruim>          # ou <sha-a>..<sha-b> para um range
git push
```

O deploy roda sozinho e leva um ciclo de CI. Enquanto isso a produção segue com o
código ruim — se isso for inaceitável, veja as alternativas abaixo e volte pra cá
depois.

### Por que não é só `pull` da tag antiga

Duas coisas conspiram:

1. `deploy.yml` termina com `docker image prune -af`. A imagem anterior foi apagada da
   VM.
2. O `docker login` na VM usou o `GITHUB_TOKEN` efêmero do job, revogado quando o job
   terminou (comentário em `deploy.yml:76-79`). Um `pull` de `ghcr.io/…:sha-<antiga>`
   responde **401**.

O pacote continua no GHCR. O que falta na VM é credencial pra buscá-lo.

## Alternativas quando o ciclo de CI é longo demais

### A. Re-rodar o run *Deploy* bom antigo

Na UI do Actions, achar o run do commit bom e usar *Re-run all jobs*. Funciona hoje,
sem credencial nova.

> **Pegadinha:** ele reconstrói e re-tagueia, então **`main-latest` volta a apontar pro
> código antigo**. Enquanto estiver assim, congele merges em `main` — o próximo merge
> vai por cima sem aviso. Faça o `git revert` mesmo assim, para o estado durável bater
> com o que está rodando.

### B. Pin de `IMAGE_TAG` no `.env`

Só funciona se a imagem alvo **ainda estiver na VM** (`docker images | grep docmost`).
Depois de um deploy que rodou `prune -af`, normalmente não está.

```bash
cd /opt/docmost-cwb
cp -a .env ".env.bak.$(date +%Y%m%d-%H%M%S)" && chmod 600 .env.bak.*   # contém segredos vivos

grep -q '^IMAGE_TAG=' .env \
  && sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=sha-<12>|" .env \
  || printf 'IMAGE_TAG=sha-<12>\n' >> .env
grep '^IMAGE_TAG=' .env

docker compose -f docker-compose.prod.yml up -d --wait docmost
```

Pine no `.env`, não inline. `IMAGE_TAG=… docker compose up` pina só aquela invocação;
o próximo `up -d` sem a variável resolve `main-latest` e rola *pra frente* em silêncio.

> **⚠️ O pin não sobrevive ao próximo merge.** `deploy.yml:96` faz `export IMAGE_TAG` no
> shell do SSH, e env de shell vence `.env` na interpolação do Compose. O pin compra
> disponibilidade; `git revert` é o que resolve.

## Achar o sha bom

Qual imagem está rodando agora, na VM:

```bash
docker inspect --format '{{.Config.Image}}' "$(docker compose -f /opt/docmost-cwb/docker-compose.prod.yml ps -q docmost)"
```

Candidatos, no git — **Windows (PowerShell):**

```powershell
git log --first-parent --oneline main | Select-Object -First 20
git rev-parse --short=12 <commit>        # a tag é sha-<esses 12 caracteres>
```

Confirmar que a tag existe no GHCR antes de contar com ela:

```powershell
gh api "/orgs/CWB-Tecnologia/packages/container/docmost-cwb/versions" --jq '.[].metadata.container.tags[]' | Select-Object -First 40
```

## Verificar depois do rollback

```bash
cd /opt/docmost-cwb
DC="docker compose -f docker-compose.prod.yml"

docker inspect --format '{{.Config.Image}}' "$($DC ps -q docmost)"   # a tag esperada
curl -fsS http://127.0.0.1:3000/api/health
$DC logs --tail=50 docmost | grep -i 'migrat\|error' || echo "sem erro de migration"
```

Depois, no navegador: abrir uma página real, digitar uma frase, esperar passar dos 45s
de `maxDebounce`, recarregar e confirmar que o texto sobreviveu. DevTools → Network →
WS deve mostrar **uma** linha `collab` em 101 que permanece. Diagnóstico detalhado em
[reverse-proxy.md](reverse-proxy.md).

O rollback só está pronto quando alguém salvou uma página de verdade. Health verde só
prova que o processo subiu.
