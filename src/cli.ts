#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Effect, pipe } from "effect";

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

class GhcpError extends Error {
  override name = "GhcpError";
}

type FileDownload = {
  file: GitHubContent & { type: "file" };
  targetPath: string;
};

const defaultConcurrency = 8;
const githubApiVersion = "2022-11-28";
const execFileAsync = promisify(execFile);
let githubTokenPromise: Promise<string | undefined> | undefined;

const usage = `Usage:
  ghcp <github-url> [path]

Examples:
  ghcp https://github.com/shamilkotta/ghcp/tree/main/src
  ghcp https://github.com/shamilkotta/ghcp/tree/main/src .
  ghcp https://github.com/shamilkotta/ghcp/blob/main/package.json ./downloads`;

const main = pipe(
  Effect.tryPromise(() => run(process.argv.slice(2))),
  Effect.catchAll((error) =>
    Effect.sync(() => {
      console.error(`ghcp: ${errorMessage(error)}`);
      process.exitCode = 1;
    }),
  ),
);

Effect.runPromise(main);

function errorMessage(error: unknown): string {
  if (error instanceof Error && "error" in error) {
    return errorMessage(error.error);
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function run(args: ReadonlyArray<string>): Promise<void> {
  const url = args[0];
  const destination = args[1];

  if (!url || args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }

  if (args.length > 2) {
    throw new GhcpError("expected at most a GitHub URL and destination path");
  }

  const link = parseGitHubUrl(url);
  const resolved = await resolveRef(link);

  if (resolved.kind === "blob" || resolved.kind === "raw") {
    const targetPath = resolveFileTargetPath(resolved, destination);
    await downloadFile(resolved, targetPath);
    console.log(`Downloaded ${resolved.path} -> ${targetPath}`);
    return;
  }

  const targetPath = resolveDirectoryTargetPath(resolved, destination);
  await downloadDirectory(resolved, targetPath, resolved.path, getConcurrency());
  console.log(`Downloaded ${resolved.path} -> ${targetPath}`);
}

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

function parseGitHubUrl(input: string): GitHubLink {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw new GhcpError("expected a GitHub URL");
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
      throw new GhcpError("expected a github.com tree or blob link");
    }

    return {
      owner,
      repo: repo.replace(/\.git$/, ""),
      kind,
      refAndPathSegments,
    };
  }

  if (url.hostname === "raw.githubusercontent.com") {
    const [owner, repo, ...refAndPathSegments] = segments;

    if (!owner || !repo || refAndPathSegments.length === 0) {
      throw new GhcpError("expected a raw.githubusercontent.com file link");
    }

    return {
      owner,
      repo,
      kind: "raw",
      refAndPathSegments,
    };
  }

  throw new GhcpError("only github.com and raw.githubusercontent.com links are supported");
}

async function resolveRef(link: GitHubLink): Promise<ResolvedLink> {
  const [ref, ...pathSegments] = link.refAndPathSegments;

  if (!ref || pathSegments.length === 0) {
    throw new GhcpError("expected a file or folder path after the branch or tag");
  }

  return {
    owner: link.owner,
    repo: link.repo,
    kind: link.kind,
    ref,
    path: pathSegments.join("/"),
  };
}

async function downloadDirectory(
  link: ResolvedLink,
  targetRoot: string,
  currentPath: string,
  concurrency: number,
): Promise<void> {
  const files = await collectFiles(link, targetRoot, currentPath);

  await mkdir(targetRoot, { recursive: true });
  await mapConcurrent(files, concurrency, ({ file, targetPath }) =>
    downloadContentFile(link, file, targetPath),
  );
}

async function collectFiles(
  link: ResolvedLink,
  targetRoot: string,
  currentPath: string,
): Promise<Array<FileDownload>> {
  const contents = await fetchContents(link, currentPath);

  if (!Array.isArray(contents)) {
    throw new GhcpError(`${currentPath} is not a folder`);
  }

  const files: Array<FileDownload> = [];
  for (const item of contents) {
    const relativePath = item.path.slice(link.path.length).replace(/^\/+/, "");
    const targetPath = join(targetRoot, relativePath);

    if (item.type === "dir") {
      files.push(...(await collectFiles(link, targetRoot, item.path)));
      continue;
    }

    files.push({ file: item, targetPath });
  }

  return files;
}

async function downloadFile(link: ResolvedLink, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  console.log(`Downloading ${link.path}`);
  await writeFile(targetPath, await fetchContentBytes(link, link.path));
}

async function downloadContentFile(
  link: ResolvedLink,
  file: GitHubContent & { type: "file" },
  targetPath: string,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  console.log(`Downloading ${file.path}`);

  const token = await resolveGithubToken();
  if (!token && file.download_url) {
    await writeFile(targetPath, await fetchBuffer(file.download_url));
    return;
  }

  await writeFile(targetPath, await fetchContentBytes(link, file.path));
}

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

function getConcurrency(): number {
  const rawValue = process.env.GHCP_CONCURRENCY;

  if (!rawValue) {
    return defaultConcurrency;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value < 1) {
    throw new GhcpError("GHCP_CONCURRENCY must be a positive integer");
  }

  return value;
}

async function fetchContents(
  link: ResolvedLink,
  path: string,
): Promise<GitHubContent | Array<GitHubContent>> {
  return fetchJson<GitHubContent | Array<GitHubContent>>(contentApiUrl(link, path), {
    Accept: "application/vnd.github+json",
  });
}

async function fetchContentBytes(link: ResolvedLink, path: string): Promise<Buffer> {
  return fetchBuffer(contentApiUrl(link, path), {
    Accept: "application/vnd.github.raw+json",
  });
}

function contentApiUrl(link: ResolvedLink, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${link.owner}/${link.repo}/contents/${encodedPath}?ref=${encodeURIComponent(
    link.ref,
  )}`;
}

async function fetchJson<T>(url: string, headers: HeadersInit = {}): Promise<T> {
  const response = await fetch(url, {
    headers: await requestHeaders(headers),
  });

  if (!response.ok) {
    throw new GhcpError(`GitHub request failed (${response.status}) for ${url}`);
  }

  return (await response.json()) as T;
}

async function fetchBuffer(url: string, headers: HeadersInit = {}): Promise<Buffer> {
  const response = await fetch(url, {
    headers: await requestHeaders(headers),
  });

  if (!response.ok) {
    throw new GhcpError(`download failed (${response.status}) for ${url}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function requestHeaders(headers: HeadersInit = {}): Promise<HeadersInit> {
  const token = await resolveGithubToken();

  return {
    "User-Agent": "ghcp",
    "X-GitHub-Api-Version": githubApiVersion,
    ...headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function resolveGithubToken(): Promise<string | undefined> {
  const envToken =
    process.env.GHCP_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  if (envToken) {
    return envToken;
  }

  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
      timeout: 3_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
