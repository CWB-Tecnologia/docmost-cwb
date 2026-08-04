<div align="center">
    <h1><b>Docmost</b></h1>
    <p>
        Open-source collaborative wiki and documentation software.
        <br />
        <a href="https://docmost.com"><strong>Website</strong></a> | 
        <a href="https://docmost.com/docs"><strong>Documentation</strong></a> |
        <a href="https://twitter.com/DocmostHQ"><strong>Twitter / X</strong></a>
    </p>
</div>
<br />

> **Fork CWB.** Este repositório é implantado na VM `srv1402182` como
> `docs.cwbti.com.br`. O deploy é **puxado pela VM** (timer `docmost-deploy`), não
> empurrado pelo CI — [`docs/deploy.md`](docs/deploy.md). Operação, rollback e backup
> estão em [`docs/`](docs/README.md); a configuração de host (Apache, TLS, ufw) vive no
> repo **`infra-cwb`**. Pra rodar local, ver [`ONBOARDING.md`](ONBOARDING.md).
>
> **AGPL-3.0.** O §13 obriga a oferecer o Corresponding Source a quem usa a instância pela
> rede. Quem usa `docs.cwbti.com.br` é pessoal interno da CWB, e o acesso a este
> repositório é como esse oferecimento é cumprido — inclusive se ele deixar de ser
> público. Quem restringir a visibilidade precisa garantir que os usuários da instância
> continuem com acesso de leitura.

## Getting started

To get started with Docmost, please refer to our [documentation](https://docmost.com/docs) or try our [cloud version](https://docmost.com/pricing) .

## Features

- Real-time collaboration
- Diagrams (Draw.io, Excalidraw and Mermaid)
- Spaces
- Permissions management
- Groups
- Comments
- Page history
- Search
- File attachments
- Embeds (Airtable, Loom, Miro and more)
- Translations (10+ languages)

### Screenshots

<p align="center">
<img alt="home" src="https://docmost.com/screenshots/home.png" width="70%">
<img alt="editor" src="https://docmost.com/screenshots/editor.png" width="70%">
</p>

### License
Docmost core is licensed under the open-source AGPL 3.0 license.  
Enterprise features are available under an enterprise license (Enterprise Edition).  

All files in the following directories are licensed under the Docmost Enterprise license defined in `packages/ee/License`.
  - apps/server/src/ee
  - apps/client/src/ee
  - packages/ee

### Contributing

See the [development documentation](https://docmost.com/docs/self-hosting/development)

## Thanks
Special thanks to;

<img width="100" alt="Crowdin" src="https://github.com/user-attachments/assets/a6c3d352-e41b-448d-b6cd-3fbca3109f07" />

[Crowdin](https://crowdin.com/) for providing access to their localization platform.


<img width="48" alt="Algolia-mark-square-white" src="https://github.com/user-attachments/assets/6ccad04a-9589-4965-b6a1-d5cb1f4f9e94" />

[Algolia](https://www.algolia.com/) for providing full-text search to the docs.

