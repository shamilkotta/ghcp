# ghcp

Download a file or folder from a public GitHub link into the current directory.

```sh
pnpm install
pnpm build
pnpm link --global

ghcp https://github.com/shamilkotta/ghcp/tree/main/src
```

Folder downloads run with up to 8 parallel file downloads by default. Set `GHCP_CONCURRENCY` to tune it:

```sh
GHCP_CONCURRENCY=16 ghcp https://github.com/shamilkotta/ghcp/tree/main/src
```

Supported public links:

- `https://github.com/:owner/:repo/tree/:ref/:path`
- `https://github.com/:owner/:repo/blob/:ref/:path`
- `https://raw.githubusercontent.com/:owner/:repo/:ref/:path`

Private repository support is intentionally not implemented yet.
