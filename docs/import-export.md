# Importar e exportar spaces

Migrar conteúdo de uma instância Docmost para outra passa por um zip de export de space.
Este documento cobre o caminho de volta — como recriar aqueles spaces neste instance — e
os pontos em que o formato escolhido custa conteúdo.

## Importar spaces (vários de uma vez)

**Settings → Spaces → `Import spaces`.** É um recurso deste fork; o upstream só sabe
importar páginas *dentro* de um space que já existe
(`apps/server/src/integrations/import/import.controller.ts:127`, `pages/import-zip`), o que
obrigava a criar cada space à mão antes.

Fluxo:

1. Selecione **um ou vários** zips de uma vez.
2. Cada zip vira uma linha. O nome do space é derivado do arquivo —
   `Província Marcas-space-export (1).zip` → `Província Marcas` — e o slug sai do mesmo
   `computeSpaceSlug` usado na criação manual (`Academia Viver Sports` → `AVS`). Ambos são
   editáveis antes de importar.
3. `Import` sobe um zip por vez, em série. Cada linha mostra `Enviando` → `Importando` →
   `Importado`/`Falhou`.
4. Uma linha que falha (slug repetido, por exemplo) continua editável: corrija e clique
   `Import` de novo — só as linhas pendentes são reenviadas.

Quem pode: **owner ou admin do workspace** — a mesma permissão de criar space
(`WorkspaceCaslAction.Manage` sobre `WorkspaceCaslSubject.Space`). Quem importa fica ADMIN
de cada space criado.

O endpoint é `POST /api/spaces/import-zip`, `multipart/form-data` com `name`, `slug`,
`description`, `source` **antes** do campo `file` (fastify-multipart só expõe os campos que
precedem o arquivo). Se o upload falhar, o space recém-criado é apagado — um zip rejeitado
não deixa space vazio para trás.

A importação em si é assíncrona (fila BullMQ). Fechar a aba **não** cancela nada: só para o
acompanhamento. O andamento fica em `file_tasks`.

## Prefira HTML a Markdown

O export Markdown deste build **perde estrutura**: os itens filhos de uma task list são
concatenados no texto do item pai, sem separador nenhum — oito subitens viram
`FAZER BACKUP DO PERFIL DO USUARIO COMPLETODOCUMENTOSE-MAILS - PSTSDRIVES INSTALADOS…`.
O checkbox do item de cima sobrevive; os níveis e o negrito não. Medido no mesmo page,
exportado nos dois formatos e importado neste instance:

| formato | arquivo de `Suporte e Manutenção/Padrão de formatação` | JSON da página depois do import | o que sobrevive |
|---|---|---|---|
| `.md` | 699 B | 1280 caracteres | 2 `taskItem`, com os filhos colados no texto |
| `.html` | 3626 B | 4334 caracteres | aninhamento completo, `<strong>`, `<br>` |

Então: **exporte e importe em HTML** sempre que a origem ainda estiver acessível. Só use o
zip Markdown quando for o único que existe.

Marque `includeAttachments` no export se as páginas tiverem imagem ou anexo — sem isso o
zip não traz a pasta `files/` e os anexos somem na volta.

## Limite de tamanho

`FILE_IMPORT_SIZE_LIMIT` vale `200mb` por padrão
(`apps/server/src/integrations/environment/environment.service.ts:153`), mas em produção o
caminho é **Cloudflare → Apache → container** e o plano Free da Cloudflare corta o corpo da
requisição em **100 MB**. O teto real é 100 MB, e o que estoura lá não aparece no log do
container. Ver `reverse-proxy.md`.

## Lacunas conhecidas

Uma linha cada, sem proposta:

- **Job que falha depois do HTTP 200 deixa space vazio.** O rollback do endpoint só cobre
  falha de upload; se o job da fila falhar, a linha aparece como `Falhou` e o space
  precisa ser apagado à mão antes de reimportar.
- **`pageId`, `slugId` e `parentPath` do `docmost-metadata.json` são ignorados** no import
  (`file-import-task.service.ts:159`): ids são novos, então link antigo apontando para o
  instance de origem morre. Só `icon` e `position` são aproveitados.
- **Export Markdown cola os filhos de uma task list no item pai** (acima). A perda acontece
  na exportação, não na importação — o `.md` já sai achatado.
- **O zip carrega só conteúdo.** Membros, permissões, comentários, histórico e favoritos
  não vão nem voltam — apenas páginas, hierarquia, ícone e ordem.
- **Zip de export de cliente não entra neste repositório.** Esses arquivos costumam conter
  credencial em texto puro; ficam fora do git e vão para a VM por `scp` ou sobem direto
  pelo navegador.
