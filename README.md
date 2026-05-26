# ghcp

Download a file or folder from a public GitHub link.

```sh
pnpm install
pnpm build
pnpm link --global

ghcp https://github.com/shamilkotta/ghcp/tree/main/src
ghcp https://github.com/shamilkotta/ghcp/tree/main/src ./downloaded-src
ghcp https://github.com/shamilkotta/ghcp/tree/main/src .
ghcp https://github.com/shamilkotta/ghcp/blob/main/package.json ./downloads
```

By default, folder downloads keep the GitHub folder name, so the first example writes to `./src`.
Pass a destination path to write the folder contents there. Pass `.` to write the folder contents
directly into the current directory.

For file downloads, the destination path is always treated as a folder. The original GitHub file name
is kept.

Supported public links:

- `https://github.com/:owner/:repo/tree/:ref/:path`
- `https://github.com/:owner/:repo/blob/:ref/:path`
- `https://raw.githubusercontent.com/:owner/:repo/:ref/:path`

Private repository support is intentionally not implemented yet.
