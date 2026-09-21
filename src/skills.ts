import { cp, lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { PostoirError } from "./errors.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function skillSource(): string {
  return join(root, "skills", "postoir");
}

export function skillDestination(target?: string, directory?: string): string {
  if (directory) return join(resolve(directory), "postoir");
  if (target === "claude") return join(homedir(), ".claude", "skills", "postoir");
  if (target === "cursor") return join(homedir(), ".cursor", "skills", "postoir");
  throw new PostoirError("INVALID_ARGUMENT", "Specify claude, cursor, or --dir PATH");
}

export async function installSkill(
  target?: string,
  directory?: string,
): Promise<{ ok: true; source: string; destination: string }> {
  if (target && target !== "claude" && target !== "cursor")
    throw new PostoirError("INVALID_ARGUMENT", "Skill target must be claude or cursor");
  const source = skillSource(),
    destination = skillDestination(target, directory);
  try {
    await lstat(destination);
    throw new PostoirError(
      "SKILL_EXISTS",
      `Refusing to overwrite existing skill at ${destination}`,
    );
  } catch (error) {
    if (error instanceof PostoirError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  return { ok: true, source, destination };
}
