# ghcp

Download a file or folder from a GitHub link.

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

## Private repositories

Private repositories require authentication. By default, `ghcp` uses the token from your
authenticated [GitHub CLI](https://cli.github.com/) session (`gh auth login`).

To use a different token, set one of these environment variables:

- `GHCP_GITHUB_TOKEN`
- `GITHUB_TOKEN`
- `GH_TOKEN`

```sh
GHCP_GITHUB_TOKEN=github_pat_... ghcp https://github.com/owner/private-repo/tree/main/src
```

For a fine-grained personal access token, grant `Contents` repository permission: `Read-only`
for the target repository. For a classic personal access token, use the `repo` scope.
