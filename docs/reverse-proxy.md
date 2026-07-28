# Reverse proxy: requisitos do WebSocket

O editor em tempo real do Docmost não usa HTTP. Ele mantém um WebSocket aberto em
**`/collab`** (e um segundo em `/socket.io` para notificações). Se o proxy à frente do
container não repassar o *upgrade* corretamente, o resultado **não** é um erro claro:
o usuário vê um ícone de wifi cortado, o conteúdo digitado não é salvo e, ao recarregar,
a página aparece com o texto antigo.

O config do proxy vive fora deste repositório. Este documento é o contrato que ele
precisa cumprir.

Em produção esse contrato é cumprido pelo **Apache 2.4 no host**, e a fonte da verdade
é o vhost versionado em
`infra-cwb/apache/sites-available/docs.cwbti.com.br.conf` — que não é duplicado aqui,
justamente pra não divergir. As camadas reais são **Cloudflare → Apache → container**.

## Contrato

O que o vhost de produção faz, com o motivo de cada linha:

```apache
ProxyRequests    Off
ProxyPreserveHost On
ProxyAddHeaders  On
ProxyTimeout     3600                       # default de 60s é curto demais

RequestHeader set X-Forwarded-Proto "https"
RequestHeader set X-Forwarded-Port  "443"

# o desafio ACME precisa ganhar do catch-all, senão o certbot recebe a
# resposta do Docmost em vez do token
ProxyPass /.well-known/acme-challenge !

ProxyPass        "/" "http://127.0.0.1:3000/" upgrade=websocket timeout=3600 retry=0
ProxyPassReverse "/" "http://127.0.0.1:3000/"
```

### Equivalência com nginx

Quem chegar aqui vindo de um config nginx (ou for montar um em outro host):

| nginx | Apache 2.4 | nota |
|---|---|---|
| `proxy_pass http://127.0.0.1:3000` | `ProxyPass "/" "http://127.0.0.1:3000/" upgrade=websocket` | o catch-all cobre `/collab` e `/socket.io` |
| `proxy_http_version 1.1` | default do `mod_proxy_http` | **nunca** setar `force-proxy-request-1.0` nem `proxy-nokeepalive`: os dois derrubam o header `Upgrade` |
| `Connection` via `map` | o parâmetro `upgrade=websocket` (2.4.47+) | já condiciona ao request. **Nunca** `RequestHeader set Connection upgrade` — quebra o HTTP normal do mesmo prefixo, exatamente como o literal quebra no nginx. `mod_proxy_wstunnel` não é necessário |
| `proxy_read_timeout 3600s` | `ProxyTimeout 3600` **e** `timeout=3600` no `ProxyPass` | os dois; o do `ProxyPass` é o que vale para o worker |
| `proxy_buffering off` | nada a fazer por default | Apache não bufferiza corpo. Os assassinos aqui são `mod_deflate`/`AddOutputFilterByType`, `mod_cache` e `mod_security2` |
| `client_max_body_size 200m` | `LimitRequestBody` (default `0`, ilimitado) | o teto real é o **Cloudflare**, 100 MB no plano Free |
| — | `retry=0` | sem isso o worker fica marcado em erro por 60s depois de uma falha, e **todo** o site responde 503 |

### Limites de tamanho

Os dois env que importam, com os defaults de
`apps/server/src/integrations/environment/environment.service.ts:149-155`:

| env | default | o quê |
|---|---|---|
| `FILE_UPLOAD_SIZE_LIMIT` | `50mb` | anexo individual |
| `FILE_IMPORT_SIZE_LIMIT` | `200mb` | import de workspace |

O Cloudflare Free corta o request em 100 MB, **abaixo** do default de import. Um import
grande falha no edge e o log do container fica em silêncio — não é bug da aplicação.

### Regras, cada uma ligada a um sintoma observável

1. **Nunca faça proxy para o upstream em HTTP/2 / h2c.** WebSocket sobre HTTP/2 exige
   Extended CONNECT (RFC 8441), que `mod_proxy_http2`, o `proxy_pass` do nginx e o
   `cloudflared --http2Origin` não implementam. HTTP/2 voltado ao **cliente** é OK; o
   salto para `127.0.0.1:3000` tem que ser HTTP/1.1. *Sintoma: 502 no handshake.*
2. **O `Connection: upgrade` tem que ser condicional ao request, nunca fixo.** No
   Apache isso vem do parâmetro `upgrade=websocket`; no nginx, do `map`. Um valor
   literal quebra as requisições HTTP normais que compartilham o mesmo prefixo.
3. **Timeout ≥ 3600s.** O único keepalive é o re-anúncio de *awareness* do
   y-protocols (~15s), que normalmente sobrevive ao default de 60s — mas uma aba oculta,
   uma pausa de GC ou um `onAuthenticate` lento estouram. *Sintoma: close 1006 em
   intervalos suspeitosamente regulares.* No Apache: `ProxyTimeout` **e** `timeout=` no
   `ProxyPass`.
4. **Nada pode bufferizar nem reescrever o corpo.** *Sintoma: close 4408* — o cliente
   ficou 30s sem receber frame com o socket ainda aberto. No Apache, verifique que
   `mod_deflate`, `mod_cache` e `mod_security2` não estão ligados neste vhost; no
   nginx, `proxy_buffering off`.
5. **`/socket.io` precisa do mesmo tratamento.** É um segundo WebSocket (notificações).
   O `ProxyPass "/"` catch-all cobre os dois.
6. **Toda camada precisa disso.** Em produção são duas antes do container:
   **Cloudflare** (WebSockets habilitado; o limite de ~100s de idle é coberto pelo
   heartbeat de 15s; Rocket Loader e Auto Minify não podem tocar o app) e o **Apache do
   host** (as regras acima). Uma camada certa e outra errada dá o mesmo sintoma que
   nenhuma das duas configurada.
7. **`COLLAB_URL` fica vazio** em deploy same-origin: o cliente deriva
   `wss://<origin>/collab` sozinho. Só preencha ao rodar o servidor de collab separado
   (`collab-main.ts`, `COLLAB_PORT`) — e aí o proxy daquele host precisa de tudo acima.

> **Outros proxies (referência).** Não é o que roda aqui, mas se um dia entrar no
> caminho: no **Traefik** WS funciona por padrão — os assassinos são um middleware
> `compress` ou `buffering` no router e um `respondingTimeouts.writeTimeout` diferente
> de zero no entrypoint. No **cloudflared**, não use `--http2Origin` (regra 1).

## Diagnóstico

### O proxy está entregando o upgrade?

São três testes, do fora pra dentro. O primeiro que falhar aponta a camada culpada.

**1. Pela internet (Cloudflare → Apache → container):**

```bash
KEY=$(openssl rand -base64 16)
curl -isS -o /dev/null -D - -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: $KEY" -H "Sec-WebSocket-Version: 13" \
  -H "Origin: https://docs.cwbti.com.br" \
  https://docs.cwbti.com.br/collab
```

**2. Só o Apache, pulando o Cloudflare** — rodar **na VM**. O `--resolve` força o
destino para o próprio host e o `-k` existe porque o origin pode servir um certificado
com nome diferente:

```bash
curl -isS -o /dev/null -D - -N -k --resolve docs.cwbti.com.br:443:127.0.0.1 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: $KEY" -H "Sec-WebSocket-Version: 13" \
  -H "Origin: https://docs.cwbti.com.br" \
  https://docs.cwbti.com.br/collab
```

**3. Só o container:**

```bash
docker compose -f docker-compose.prod.yml exec docmost \
  curl -isS -o /dev/null -D - -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: $KEY" -H "Sec-WebSocket-Version: 13" \
  http://localhost:3000/collab
```

Esperado nos três: `HTTP/1.1 101 Switching Protocols`.

| 1 | 2 | 3 | conclusão |
|---|---|---|---|
| ✗ | ✓ | ✓ | Cloudflare |
| ✗ | ✗ | ✓ | Apache do host (`infra-cwb`) |
| ✗ | ✗ | ✗ | aplicação |

> **Atenção:** o servidor registra um catch-all `GET *` para servir a SPA. Um **`200` com
> HTML** significa que o proxy **removeu** os headers `Upgrade`/`Connection` — não que a
> rota sumiu. `502`/`504` = o proxy chegou no app mas não conseguiu fazer upgrade.

### Evidência no navegador

DevTools → Network → filtro **WS**. Ao abrir uma página deve aparecer **uma** linha
`collab` em 101, e ela deve permanecer. *Cada linha nova é uma reconexão.*

O console loga `[collab] socket closed` com o código:

| Code | Significado |
|---|---|
| **1006** | close anormal sem frame de close — proxy/LB matou o TCP (timeout de leitura, limite de idle). Se o intervalo for suspeitosamente fixo, cheque o `mod_reqtimeout` do Apache (`apachectl -M \| grep reqtimeout`, `/etc/apache2/conf-enabled/reqtimeout.conf`) antes de culpar a aplicação |
| **4408** | `checkConnection` do cliente: 30s sem frame de entrada com socket aberto — proxy **bufferizando** |
| **1011** | falha no servidor: frame não aplicado, forçando resync. Ver os logs do container (geralmente Redis) |
| **1000 / 1001** | normal, iniciado pelo app (aba oculta/idle, release do refcount) |

### Evidência no servidor

Com `DEBUG_MODE=true`, `docker compose -f docker-compose.prod.yml logs -f docmost`
enquanto edita. `CollabWsAdapter` loga cada upgrade aceito (debug) e cada upgrade
rejeitado (warn, com o pathname). **Silêncio aqui com o cliente mostrando wifi cortado
significa que a requisição nunca chegou.**

### O conteúdo persistiu mesmo?

```bash
docker compose -f docker-compose.prod.yml exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
"select slug_id, title, updated_at, octet_length(ydoc) ydoc_bytes, left(text_content,120) preview
 from pages where slug_id = 'SLUGID';"
```

`slug_id` é o token final da URL `/s/<space>/p/<titulo>-<slugId>`. Digite uma frase,
espere o `maxDebounce` (padrão 45s) e rode de novo. Se `updated_at` não avançar, nada
chegou ao Postgres.
