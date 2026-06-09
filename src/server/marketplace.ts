import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AppConfig,
  AvatarCommandManifest,
  DiscoveredPlugin,
  MarketplaceCatalog,
  MarketplacePluginEntry,
  MarketplaceSourceObject,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface MarketplaceRegistry {
  name: string;
  rootPath: string;
  plugins: DiscoveredPlugin[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function marketplaceCloneUrl(source: string, token?: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    if (token) {
      return `https://x-access-token:${encodeURIComponent(token)}@github.com/${source}.git`;
    }
    return `https://github.com/${source}.git`;
  }
  if (token && source.startsWith("https://github.com/")) {
    return source.replace("https://github.com/", `https://x-access-token:${encodeURIComponent(token)}@github.com/`);
  }
  return source;
}

async function syncGitRepo(url: string, destination: string, ref?: string): Promise<void> {
  if (await pathExists(path.join(destination, ".git"))) {
    await execFileAsync("git", ["-C", destination, "fetch", "--all", "--prune"], {
      timeout: 120_000,
    });
  } else {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await execFileAsync("git", ["clone", "--depth", "1", url, destination], {
      timeout: 120_000,
    });
  }
  if (ref) {
    await execFileAsync("git", ["-C", destination, "checkout", ref], { timeout: 60_000 });
  }
}

async function resolveMarketplaceRoot(config: AppConfig): Promise<string> {
  const source = config.marketplaceSource;
  const absoluteCandidate = path.isAbsolute(source)
    ? source
    : path.resolve(process.cwd(), source);
  if (await pathExists(path.join(absoluteCandidate, ".claude-plugin", "marketplace.json"))) {
    return absoluteCandidate;
  }

  const destination = path.join(config.dataDir, "marketplaces", sanitizeName(source));
  await syncGitRepo(marketplaceCloneUrl(source, config.githubToken), destination, config.marketplaceRef);
  return destination;
}

async function resolvePluginRoot(
  marketplaceRoot: string,
  plugin: MarketplacePluginEntry,
  config: AppConfig,
  warnings: string[],
): Promise<string | null> {
  if (typeof plugin.source === "string") {
    if (!plugin.source.startsWith("./")) {
      warnings.push(`${plugin.name}: unsupported non-relative string source ${plugin.source}`);
      return null;
    }
    return path.resolve(marketplaceRoot, plugin.source);
  }

  const source = plugin.source;
  if (source.source === "github" && source.repo) {
    const destination = path.join(config.dataDir, "plugins", sanitizeName(plugin.name));
    await syncGitRepo(marketplaceCloneUrl(source.repo, config.githubToken), destination, source.ref || source.sha);
    return destination;
  }

  if (source.source === "url" && source.url) {
    const destination = path.join(config.dataDir, "plugins", sanitizeName(plugin.name));
    await syncGitRepo(marketplaceCloneUrl(source.url, config.githubToken), destination, source.ref || source.sha);
    return destination;
  }

  if (source.source === "git-subdir" && source.url && source.path) {
    const destination = path.join(config.dataDir, "plugins", sanitizeName(plugin.name));
    await syncGitRepo(marketplaceCloneUrl(source.url, config.githubToken), destination, source.ref || source.sha);
    return path.join(destination, source.path);
  }

  warnings.push(`${plugin.name}: unsupported source object ${(source as MarketplaceSourceObject).source}`);
  return null;
}

function validCatalog(value: unknown): value is MarketplaceCatalog {
  return isRecord(value) && typeof value.name === "string" && Array.isArray(value.plugins);
}

export async function loadMarketplaceRegistry(config: AppConfig): Promise<MarketplaceRegistry> {
  const warnings: string[] = [];
  const rootPath = await resolveMarketplaceRoot(config);
  const catalogPath = path.join(rootPath, ".claude-plugin", "marketplace.json");
  const catalog = await readJson<MarketplaceCatalog>(catalogPath);
  if (!validCatalog(catalog)) {
    throw new Error(`Invalid marketplace catalog at ${catalogPath}`);
  }

  const plugins: DiscoveredPlugin[] = [];
  for (const pluginEntry of catalog.plugins) {
    const root = await resolvePluginRoot(rootPath, pluginEntry, config, warnings);
    if (!root || !(await pathExists(root))) {
      warnings.push(`${pluginEntry.name}: plugin root not found`);
      continue;
    }

    const pluginManifest = await readJson<Record<string, unknown>>(
      path.join(root, ".claude-plugin", "plugin.json"),
    );
    const avatarManifest = await readJson<AvatarCommandManifest>(
      path.join(root, "avatar-chat.json"),
    );
    const commands = Array.isArray(avatarManifest?.commands) ? avatarManifest.commands : [];
    plugins.push({
      name: pluginEntry.name,
      description:
        pluginEntry.description ||
        (typeof pluginManifest?.description === "string" ? pluginManifest.description : undefined),
      version:
        pluginEntry.version ||
        (typeof pluginManifest?.version === "string" ? pluginManifest.version : undefined),
      rootPath: root,
      source: pluginEntry.source,
      commands,
      tags: pluginEntry.tags ?? [],
    });
  }

  return {
    name: catalog.name,
    rootPath,
    plugins,
    warnings,
  };
}
