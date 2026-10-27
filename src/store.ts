// Armazenamento chave/valor em memória com TTL.
// Substitui o Redis da especificação (seção 4.5) para a demo: tudo se perde ao
// reiniciar o processo e não funciona com mais de uma instância.

interface Entry {
  value: string;
  expiresAt: number;
}

const entries = new Map<string, Entry>();

function live(key: string): Entry | undefined {
  const entry = entries.get(key);
  if (entry && entry.expiresAt <= Date.now()) {
    entries.delete(key);
    return undefined;
  }
  return entry;
}

export const store = {
  get(key: string): string | undefined {
    return live(key)?.value;
  },

  set(key: string, value: string, ttlSec: number): void {
    entries.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  },

  /** Equivalente a SET NX: grava só se a chave não existir. Retorna true se gravou. */
  setIfAbsent(key: string, value: string, ttlSec: number): boolean {
    if (live(key)) return false;
    this.set(key, value, ttlSec);
    return true;
  },

  delete(key: string): void {
    entries.delete(key);
  },
};

// Limpeza periódica para não acumular chaves vencidas.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key);
}, 60_000).unref();
