import { spawn } from "node:child_process";

const dictionaryPath = "/usr/share/dict/words";
const proseWord = /[\p{L}\p{M}']{2,}$/u;
const nonProse = /[\\/@_=:{}<>\d]|\[|\]/u;

export type WordLookup = (prefix: string) => Promise<string | undefined>;

export function wordPrefix(text: string): string | undefined {
  const token = text.match(/\S+$/u)?.[0];
  if (!token || nonProse.test(token)) return undefined;
  return token.match(proseWord)?.[0];
}

export function systemDictionaryLookup(prefix: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  return new Promise(resolve => {
    const child = spawn("/usr/bin/look", ["-df", prefix, dictionaryPath], { stdio: ["ignore", "pipe", "ignore"] });
    let buffered = "";
    let settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(value);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      while (buffered.includes("\n")) {
        const newline = buffered.indexOf("\n");
        const candidate = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        if (candidate.length > prefix.length && candidate.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) {
          finish(candidate);
          return;
        }
      }
    });
    child.once("error", () => finish());
    child.once("close", () => {
      const candidate = buffered.trimEnd().split("\n", 1)[0];
      finish(candidate && candidate.length > prefix.length && candidate.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()) ? candidate : undefined);
    });
  });
}

export class WordCompletion {
  private readonly cache = new Map<string, string | undefined>();
  private readonly pending = new Set<string>();
  private readonly lookup: WordLookup;
  onUpdate?: () => void;

  constructor(lookup: WordLookup = systemDictionaryLookup) {
    this.lookup = lookup;
  }

  suffix(text: string): string | undefined {
    const prefix = wordPrefix(text);
    if (!prefix) return undefined;
    if (this.cache.has(prefix)) return this.cache.get(prefix);
    if (!this.pending.has(prefix)) {
      this.pending.add(prefix);
      void this.lookup(prefix).then(candidate => {
        this.pending.delete(prefix);
        const suffix = candidate?.slice(prefix.length);
        if (this.cache.size >= 256) this.cache.clear();
        this.cache.set(prefix, suffix || undefined);
        this.onUpdate?.();
      }, () => {
        this.pending.delete(prefix);
        this.cache.set(prefix, undefined);
      });
    }
    return undefined;
  }
}
