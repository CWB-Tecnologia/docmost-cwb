# docs

Documentação deste fork. O README na raiz é o do upstream.

| doc | quando ler |
|---|---|
| [operations.md](operations.md) | onde as coisas moram na VM, comandos do dia a dia, o que vai morder, lacunas conhecidas |
| [deploy.md](deploy.md) | como o deploy funciona (a VM puxa), disparar deploy à mão, pausar, credenciais, por que o Actions verde não prova nada |
| [rollback.md](rollback.md) | um deploy quebrou produção |
| [backup-restore.md](backup-restore.md) | backup noturno, restore, ensaio de restore |
| [reverse-proxy.md](reverse-proxy.md) | o editor colaborativo parou de salvar, ícone de wifi cortado, close 1006/4408 |
| [import-export.md](import-export.md) | trazer spaces de outra instância por zip, qual formato de export usar |
| [ee-feature-status.md](ee-feature-status.md) | quais features EE estão realmente implementadas neste build |

## O que **não** está aqui

Configuração de host — vhost do Apache, TLS/certbot, ufw, swap, o mapa de portas da VM
`srv1402182` — vive no repo **`infra-cwb`** e não é duplicada aqui. Comece por
`infra-cwb/docs/vm-srv1402182.md`.

O GLPI roda na mesma VM, governado pelo repo `glpi-cwb`. Os três repos são
independentes; nenhum sabe fazer deploy dos outros.
