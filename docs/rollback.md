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

O deploy roda sozinho: um ciclo de CI mais até 5 min do timer da VM. Enquanto isso a
produção segue com o código ruim — se isso for inaceitável, veja a alternativa abaixo e
volte pra cá depois.

### `pull` da tag antiga agora funciona

Isso mudou em 2026-07-28, e melhorou:

1. O deploy **não roda mais `docker image prune -af`**. O `deploy.sh` mantém a tag atual e
   a anterior, então a imagem de antes normalmente **está** no disco.
2. O `docker login` na VM não é mais o `GITHUB_TOKEN` efêmero de um job: existe um PAT
   `read:packages` em `/etc/docmost-cwb/ghcr.token`, e o login persiste. `pull` de
   `ghcr.io/…:sha-<antiga>` responde 200.

Ou seja, o caminho rápido é real. Ele ainda **não desfaz migration** — a seção acima
continua valendo.

## Alternativa quando o ciclo de CI é longo demais

### Pin de `IMAGE_TAG` no `.env` **mais** o `hold`

Duas coisas, e as duas são necessárias: o pin escolhe a imagem, o `hold` impede o timer
de rolar pra frente no tick seguinte.

```bash
cd /opt/docmost-cwb

# 1. congela o deploy automático ANTES de mexer
printf 'rollback pinado em sha-<12> — <quem> <data>\n' > /etc/docmost-cwb/hold

# 2. pina a imagem
cp -a .env ".env.bak.$(date +%Y%m%d-%H%M%S)" && chmod 600 .env.bak.*   # contém segredos vivos
grep -q '^IMAGE_TAG=' .env \
  && sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=sha-<12>|" .env \
  || printf 'IMAGE_TAG=sha-<12>\n' >> .env
grep '^IMAGE_TAG=' .env

# 3. sobe (tomando o lock, senão o timer pode recriar por baixo)
flock /run/lock/docmost-cwb.lock \
  docker compose -f docker-compose.prod.yml up -d --wait --wait-timeout 300 docmost
```

Pine no `.env`, não inline. `IMAGE_TAG=… docker compose up` pina só aquela invocação.

> **O `hold` é o que faz o pin durar.** O `deploy.sh` exporta `IMAGE_TAG` derivado do HEAD
> do git, e env de shell vence `.env` na interpolação do Compose — sem o `hold`, o próximo
> tick rola *pra frente* em silêncio. O pin compra disponibilidade; `git revert` é o que
> resolve. Quando o revert estiver em produção, apague `/etc/docmost-cwb/hold` **e** o
> `IMAGE_TAG` do `.env`.

> **Re-rodar um run antigo do Actions não é mais rollback.** A VM deploya a tag derivada
> do HEAD do git, então re-buildar um commit velho só mexe em `main-latest` — a VM não
> olha pra essa tag e nada muda em produção.

## Achar o sha bom

O que a VM acha que deployou, e o que está de fato rodando:

```bash
/opt/docmost-cwb-src/scripts/deploy.sh --status
```

Candidatos, no git — **Windows (PowerShell):**

```powershell
git log --first-parent --oneline main | Select-Object -First 20
git rev-parse <commit>                   # a tag é sha-<os 12 primeiros caracteres>
```

Use os 12 primeiros do sha completo, não `git rev-parse --short=12`: o `--short` devolve
**pelo menos** 12 caracteres e mais quando o prefixo é ambíguo, enquanto a tag publicada é
exatamente `${GITHUB_SHA::12}`.

Confirmar que a tag existe no GHCR antes de contar com ela:

```powershell
gh api "/orgs/CWB-Tecnologia/packages/container/docmost-cwb/versions" --jq '.[].metadata.container.tags[]' | Select-Object -First 40
```

## Verificar depois do rollback

```bash
cd /opt/docmost-cwb
DC="docker compose -f docker-compose.prod.yml"

/opt/docmost-cwb-src/scripts/deploy.sh --status                      # tag, digest, saúde
curl -fsS http://127.0.0.1:3000/api/health
$DC logs --tail=50 docmost | grep -i 'migrat\|error' || echo "sem erro de migration"
```

Depois, no navegador: abrir uma página real, digitar uma frase, esperar passar dos 45s
de `maxDebounce`, recarregar e confirmar que o texto sobreviveu. DevTools → Network →
WS deve mostrar **uma** linha `collab` em 101 que permanece. Diagnóstico detalhado em
[reverse-proxy.md](reverse-proxy.md).

O rollback só está pronto quando alguém salvou uma página de verdade. Health verde só
prova que o processo subiu.
