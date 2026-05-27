#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Data, Effect, Option, pipe } from "effect";

type GitHubLink = {
  owner: string;
  repo: string;
  kind: "tree" | "blob" | "raw";
  refAndPathSegments: ReadonlyArray<string>;
};

type ResolvedLink = {
  owner: string;
  repo: string;
  kind: "tree" | "blob" | "raw";
  ref: string;
  path: string;
};

type GitHubContent =
  | {
      type: "file";
      name: string;
      path: string;
      download_url: string | null;
    }
  | {
      type: "dir";
      name: string;
      path: string;
      download_url?: null;
    };

class GhcpError extends Data.TaggedError("GhcpError")<{ message: string }> {
  name = "GhcpError";
}

type FileDownload = {
  file: GitHubContent & { type: "file" };
  targetPath: string;
};

type FetchHeaders = Record<string, string>;

const defaultConcurrency = 8;
const githubApiVersion = "2022-11-28";
const execFileAsync = promisify(execFile);

const usage = `Usage:
  ghcp <github-url> [path]

Examples:
  ghcp https://github.com/shamilkotta/ghcp/tree/main/src
  ghcp https://github.com/shamilkotta/ghcp/tree/main/src .
  ghcp https://github.com/shamilkotta/ghcp/blob/main/package.json ./downloads`;

function errorMessage(error: unknown): string {
  if (error instanceof GhcpError) {
    return error.message;
  }

  if (error instanceof Error && "error" in error) {
    return errorMessage(error.error);
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const url = args[0];
    const destination = args[1];

    if (!url || args.includes("--help") || args.includes("-h")) {
      console.log(usage);
      return yield* Effect.fail(new GhcpError({ message: "expected a GitHub URL" }));
    }

    if (args.length > 2) {
      return yield* Effect.fail(
        new GhcpError({ message: "expected at most a GitHub URL and destination path" }),
      );
    }

    const link = yield* parseGitHubUrl(url);
    const resolved = yield* resolveRef(link);

    if (resolved.kind === "blob" || resolved.kind === "raw") {
      const targetPath = resolveFileTargetPath(resolved, destination);
      yield* downloadFile(resolved, targetPath);
      console.log(`Downloaded ${resolved.path} -> ${targetPath}`);
      return;
    }

    const targetPath = resolveDirectoryTargetPath(resolved, destination);
    const concurrency = yield* getConcurrency();
    yield* downloadDirectory(resolved, targetPath, resolved.path, concurrency);
    console.log(`Downloaded ${resolved.path} -> ${targetPath}`);
  });

function resolveDirectoryTargetPath(link: ResolvedLink, destination?: string): string {
  if (destination) {
    return resolve(process.cwd(), destination);
  }

  return join(process.cwd(), basename(link.path) || link.repo);
}

function resolveFileTargetPath(link: ResolvedLink, destination?: string): string {
  const fileName = basename(link.path);

  if (!destination) {
    return join(process.cwd(), fileName);
  }

  return join(resolve(process.cwd(), destination), fileName);
}

const parseGitHubUrl = (input: string) =>
  Effect.gen(function* () {
    let url: URL;

    try {
      url = new URL(input);
    } catch {
      return yield* Effect.fail(new GhcpError({ message: "expected a GitHub URL" }));
    }

    const segments = url.pathname.split("/").filter(Boolean);

    if (url.hostname === "github.com") {
      const [owner, repo, kind, ...refAndPathSegments] = segments;

      if (
        !owner ||
        !repo ||
        (kind !== "tree" && kind !== "blob") ||
        refAndPathSegments.length === 0
      ) {
        return yield* Effect.fail(
          new GhcpError({ message: "expected a github.com tree or blob link" }),
        );
      }

      return {
        owner,
        repo: repo.replace(/\.git$/, ""),
        kind,
        refAndPathSegments,
      } as GitHubLink;
    }

    if (url.hostname === "raw.githubusercontent.com") {
      const [owner, repo, ...refAndPathSegments] = segments;

      if (!owner || !repo || refAndPathSegments.length === 0) {
        return yield* Effect.fail(
          new GhcpError({ message: "expected a raw.githubusercontent.com file link" }),
        );
      }

      return {
        owner,
        repo,
        kind: "raw",
        refAndPathSegments,
      } as GitHubLink;
    }

    return yield* Effect.fail(
      new GhcpError({
        message: "only github.com and raw.githubusercontent.com links are supported",
      }),
    );
  });

const resolveRef = (link: GitHubLink) =>
  Effect.gen(function* () {
    const [ref, ...pathSegments] = link.refAndPathSegments;
    if (!ref || pathSegments.length === 0) {
      return yield* Effect.fail(
        new GhcpError({ message: "expected a file or folder path after the branch or tag" }),
      );
    }
    return {
      owner: link.owner,
      repo: link.repo,
      kind: link.kind,
      ref,
      path: pathSegments.join("/"),
    } as ResolvedLink;
  });

const downloadDirectory = (
  link: ResolvedLink,
  targetRoot: string,
  currentPath: string,
  concurrency: number,
) =>
  Effect.gen(function* () {
    const files = yield* collectFiles(link, targetRoot, currentPath);

    yield* Effect.tryPromise(() => mkdir(targetRoot, { recursive: true })).pipe(
      Effect.catchAll(() =>
        Effect.fail(new GhcpError({ message: `failed to create directory for ${targetRoot}` })),
      ),
    );
    yield* Effect.tryPromise(() =>
      mapConcurrent(files, concurrency, ({ file, targetPath }) =>
        Effect.runPromise(downloadContentFile(link, file, targetPath)),
      ),
    ).pipe(
      Effect.catchAll(() =>
        Effect.fail(new GhcpError({ message: `failed to download directory for ${currentPath}` })),
      ),
    );
  });

const collectFiles = (
  link: ResolvedLink,
  targetRoot: string,
  currentPath: string,
): Effect.Effect<Array<FileDownload>, GhcpError> =>
  Effect.gen(function* () {
    const contents = yield* fetchContents(link, currentPath);

    if (!Array.isArray(contents)) {
      return yield* Effect.fail(new GhcpError({ message: `${currentPath} is not a folder` }));
    }

    const files: Array<FileDownload> = [];
    for (const item of contents) {
      const relativePath = item.path.slice(link.path.length).replace(/^\/+/, "");
      const targetPath = join(targetRoot, relativePath);

      if (item.type === "dir") {
        files.push(...(yield* collectFiles(link, targetRoot, item.path)));
        continue;
      }

      files.push({ file: item, targetPath });
    }

    return files;
  });

const downloadFile = (link: ResolvedLink, targetPath: string) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => mkdir(dirname(targetPath), { recursive: true })).pipe(
      Effect.catchAll(() =>
        Effect.fail(new GhcpError({ message: `failed to create directory for ${targetPath}` })),
      ),
    );
    console.log(`Downloading ${link.path}`);
    const content = yield* fetchContentBytes(link, link.path);
    yield* Effect.tryPromise(() => writeFile(targetPath, content)).pipe(
      Effect.catchAll(() =>
        Effect.fail(new GhcpError({ message: `failed to write file for ${targetPath}` })),
      ),
    );
  });

const downloadContentFile = (
  link: ResolvedLink,
  file: GitHubContent & { type: "file" },
  targetPath: string,
) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => mkdir(dirname(targetPath), { recursive: true })).pipe(
      Effect.catchAll(() =>
        Effect.fail(new GhcpError({ message: `failed to create directory for ${targetPath}` })),
      ),
    );
    console.log(`Downloading ${file.path}`);

    const token = yield* resolveGithubToken;
    if (!token && file.download_url) {
      const buffer = yield* fetchBuffer(file.download_url);
      yield* Effect.tryPromise(() => writeFile(targetPath, buffer)).pipe(
        Effect.catchAll(() =>
          Effect.fail(new GhcpError({ message: `failed to write file for ${targetPath}` })),
        ),
      );
      return;
    }

    const content = yield* fetchContentBytes(link, file.path);
    yield* Effect.tryPromise(() => writeFile(targetPath, content)).pipe(
      Effect.catchAll(() =>
        Effect.fail(new GhcpError({ message: `failed to write file for ${targetPath}` })),
      ),
    );
  });

async function mapConcurrent<T>(
  items: ReadonlyArray<T>,
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;

      if (item) {
        await task(item);
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

function getConcurrency() {
  const rawValue = process.env.GHCP_CONCURRENCY;

  if (!rawValue) {
    return Effect.succeed(defaultConcurrency);
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value < 1) {
    return Effect.fail(new GhcpError({ message: "GHCP_CONCURRENCY must be a positive integer" }));
  }

  return Effect.succeed(value);
}

function fetchContents(link: ResolvedLink, path: string) {
  const url = contentApiUrl(link, path);
  return fetchJson<GitHubContent | Array<GitHubContent>>(url, {
    Accept: "application/vnd.github+json",
  });
}

const fetchContentBytes = (link: ResolvedLink, path: string) => {
  const url = contentApiUrl(link, path);
  return fetchBuffer(url, {
    Accept: "application/vnd.github.raw+json",
  });
};

function contentApiUrl(link: ResolvedLink, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${link.owner}/${link.repo}/contents/${encodedPath}?ref=${encodeURIComponent(
    link.ref,
  )}`;
}

const fetchJson = <T>(url: string, headers: FetchHeaders = {}) =>
  Effect.gen(function* () {
    const reqHeaders = yield* requestHeaders(headers);
    const response = yield* Effect.tryPromise(() => fetch(url, { headers: reqHeaders })).pipe(
      Effect.catchAll(() =>
        Effect.fail(new GhcpError({ message: `GitHub request failed for ${url}` })),
      ),
    );

    if (!response.ok) {
      return yield* Effect.fail(
        new GhcpError({ message: `GitHub request failed (${response.status}) for ${url}` }),
      );
    }

    return yield* Effect.tryPromise(() => response.json()).pipe(
      Effect.map((json) => json as T),
      Effect.catchAll(() =>
        Effect.fail(new GhcpError({ message: `failed to parse response for ${url}` })),
      ),
    );
  });

const fetchBuffer = (url: string, headers: FetchHeaders = {}) =>
  Effect.gen(function* () {
    const reqHeaders = yield* requestHeaders(headers);
    const response = yield* Effect.tryPromise(() => fetch(url, { headers: reqHeaders })).pipe(
      Effect.catchAll(() => Effect.fail(new GhcpError({ message: `download failed for ${url}` }))),
    );

    if (!response.ok) {
      return yield* Effect.fail(
        new GhcpError({ message: `download failed (${response.status}) for ${url}` }),
      );
    }

    return yield* Effect.tryPromise(() => response.arrayBuffer()).pipe(
      Effect.map((arrayBuffer) => Buffer.from(arrayBuffer)),
      Effect.catchAll(() =>
        Effect.fail(new GhcpError({ message: `failed to read response for ${url}` })),
      ),
    );
  });

const requestHeaders = (headers: FetchHeaders = {}) =>
  Effect.gen(function* () {
    const token = yield* resolveGithubToken;

    return {
      "User-Agent": "ghcp",
      "X-GitHub-Api-Version": githubApiVersion,
      ...headers,
      ...(Option.isSome(token) ? { Authorization: `Bearer ${token.value}` } : {}),
    };
  });

const resolveGithubToken = Effect.gen(function* () {
  const envToken =
    process.env.GHCP_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  if (envToken) {
    return yield* Effect.succeed(Option.some(envToken));
  }

  return yield* Effect.tryPromise(() =>
    execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
      timeout: 3_000,
    }),
  ).pipe(
    Effect.map((result) => Option.fromNullable(result?.stdout.trim())),
    Effect.catchAll(() => Effect.succeed(Option.none())),
  );
});

const main = pipe(
  run(process.argv.slice(2)),
  Effect.catchTag("GhcpError", (error) =>
    Effect.sync(() => {
      console.error(`ghcp: ${error.message}`);
      process.exitCode = 1;
    }),
  ),
  Effect.catchAll((error) =>
    Effect.sync(() => {
      console.error(`ghcp: ${errorMessage(error)}`);
      process.exitCode = 1;
    }),
  ),
);

Effect.runPromise(main);
