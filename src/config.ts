import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PostoirError } from "./errors.js";

export const DEFAULT_URL = "https://postoir.com";
export type Profile = { apiUrl: string; apiKey: string };
type Stored = { current?: string; profiles: Record<string, Profile> };

function validateName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))
    throw new PostoirError(
      "INVALID_PROFILE",
      "Profile names use letters, digits, hyphens, and underscores only",
    );
}

export function configPath(): string {
  return (
    process.env.POSTOIR_CONFIG_PATH ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "postoir", "config.json")
  );
}

async function load(): Promise<Stored> {
  try {
    const value: unknown = JSON.parse(await readFile(configPath(), "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new Error();
    const stored = value as Stored;
    if (!stored.profiles || typeof stored.profiles !== "object" || Array.isArray(stored.profiles))
      throw new Error();
    return stored;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {} };
    throw new PostoirError("CONFIG_INVALID", "Cannot read local profile configuration");
  }
}

async function save(data: Stored): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const file = await open(tmp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(data, null, 2) + "\n");
  } finally {
    await file.close();
  }
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

export async function credentials(
  profileName?: string,
): Promise<{ profile: string; value: Profile }> {
  if (process.env.POSTOIR_API_KEY)
    return {
      profile: "environment",
      value: {
        apiKey: process.env.POSTOIR_API_KEY,
        apiUrl: process.env.POSTOIR_API_URL || DEFAULT_URL,
      },
    };
  const all = await load();
  const profile = profileName || all.current || "default";
  const value = all.profiles[profile];
  if (!value?.apiKey)
    throw new PostoirError(
      "AUTH_REQUIRED",
      "No API key configured. Run `postoir auth login` or set POSTOIR_API_KEY.",
    );
  return { profile, value };
}

export async function setProfile(name: string, value: Profile): Promise<void> {
  validateName(name);
  const url = new URL(value.apiUrl);
  if (url.username || url.password || url.search || url.hash || !/^https?:$/.test(url.protocol))
    throw new PostoirError("INVALID_API_URL", "API URL must be an http(s) origin");
  const all = await load();
  all.profiles[name] = value;
  all.current = name;
  await save(all);
}

export async function removeProfile(name?: string): Promise<void> {
  const all = await load();
  const target = name || all.current || "default";
  delete all.profiles[target];
  if (all.current === target) delete all.current;
  await save(all);
}

export async function listProfiles(): Promise<{ current?: string; profiles: string[] }> {
  const all = await load();
  return { current: all.current, profiles: Object.keys(all.profiles).sort() };
}

export async function useProfile(name: string): Promise<void> {
  validateName(name);
  const all = await load();
  if (!all.profiles[name]) throw new PostoirError("PROFILE_NOT_FOUND", "Profile does not exist");
  all.current = name;
  await save(all);
}
